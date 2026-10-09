import json
import math
import os
import requests
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Literal
from fastapi import FastAPI, HTTPException,Query
from fastapi.middleware.cors import CORSMiddleware

if __package__:
    from .coordinate_transform import wgs84_to_gcj02
    from .database import get_db_connection
    from .station_catalog import station_properties
    from .recommendations import rank_recommendations
    from .route_planning import get_amap_routes
    from .trip_charging import DEFAULT_TRIP, normalize_trip_context, rank_trip_stations
else:
    from coordinate_transform import wgs84_to_gcj02
    from database import get_db_connection
    from station_catalog import station_properties
    from recommendations import rank_recommendations
    from route_planning import get_amap_routes
    from trip_charging import DEFAULT_TRIP, normalize_trip_context, rank_trip_stations

app = FastAPI(title="新能源汽车充电 WebGIS API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/stations")
def get_stations(name: str = "", include_synthetic: bool = True, scope: Literal["all", "weidu"] = "all"):

    if not os.getenv("DB_PASSWORD"):
        raise HTTPException(status_code=503, detail="数据库密码未配置")
    conn = get_db_connection()
    cur = conn.cursor()

    try:

        # -------------------------------------------------
        # 所有坐标统一从 PostGIS 的正式 geom 获取。
        #
        # 当前 geom 已经是：
        # WGS84 / EPSG:4326
        #
        # 不再依赖旧 GeoJSON，也不单独相信 lng / lat。
        # geom 才是数据库中的正式空间数据。
        # -------------------------------------------------

        conditions = ["geom IS NOT NULL", "(to_jsonb(s)->>'status') IS DISTINCT FROM 'retired'"]
        params = []
        if name.strip():
            conditions.append("name ILIKE %s")
            params.append(f"%{name.strip()}%")
        if not include_synthetic:
            conditions.append("COALESCE((to_jsonb(s)->>'is_synthetic')::boolean,false)=false")
        if scope == "weidu":
            conditions.append("EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,s.geom))")
        cur.execute("""SELECT id,name,address,ST_AsGeoJSON(geom),
            to_jsonb(s) - ARRAY['geom','geom_wgs84','geom_gcj02','lng','lat']
            FROM stations s WHERE """ + " AND ".join(conditions) + " ORDER BY name,id", params)


        rows = cur.fetchall()


        # -------------------------------------------------
        # 转换成标准 GeoJSON FeatureCollection
        #
        # MapLibre 可以直接使用这个结构。
        # -------------------------------------------------

        features = []

        for (
            station_id,
            station_name,
            address,
            geometry_json,
            record
        ) in rows:

            if geometry_json is None:
                continue

            feature = {
                "type": "Feature",

                "properties": station_properties(station_id, station_name, address, record),

                "geometry": json.loads(
                    geometry_json
                )
            }

            features.append(feature)


        return {
            "type": "FeatureCollection",
            "features": features,
            "metadata": {
                "coordSystem": "WGS84", "scope": scope,
                "syntheticCount": sum(feature['properties']['isSynthetic'] for feature in features),
                "supplementedCount": sum(not feature['properties']['isSynthetic'] and feature['properties']['hasSimulatedAttributes'] for feature in features),
                "notice": "虚拟站点及真实地点的演示补全属性均非实时运营数据；simulatedFields 标记待实测替换的字段",
            },
        }


    finally:

        cur.close()
        conn.close()
AMAP_DRIVING_URL = "https://restapi.amap.com/v5/direction/driving"


def get_amap_driving_info(
    origin_lng,
    origin_lat,
    destination_lng,
    destination_lat,
):
    """
    调用高德驾车路径规划。

    传进来的坐标必须已经是 GCJ-02。

    返回：
    {
        "distance": 驾车距离（米）,
        "duration": 驾车时间（秒）
    }

    失败返回 None。
    """

    def is_valid_coordinate(value, bound):
        return (isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value) and -bound <= value <= bound)

    try:
        if not all(
            is_valid_coordinate(value, bound)
            for value, bound in zip(
                (origin_lng, origin_lat, destination_lng, destination_lat), (180, 90, 180, 90)
            )
        ):
            raise ValueError("输入坐标无效")

        amap_key = os.getenv("AMAP_WEB_KEY")
        if not amap_key:
            raise RuntimeError("没有配置 AMAP_WEB_KEY")

        params = {
            "key": amap_key,
            "origin": f"{float(origin_lng):.6f},{float(origin_lat):.6f}",
            "destination": f"{float(destination_lng):.6f},{float(destination_lat):.6f}",
            "strategy": 32,
            "show_fields": "cost",
        }

        response = requests.get(
            AMAP_DRIVING_URL,
            params=params,
            timeout=5,
        )
        response.raise_for_status()

        data = response.json()
        if data.get("status") != "1":
            print("高德路线规划失败：", data.get("info"))
            return None

        paths = data.get("route", {}).get("paths", [])
        if not paths:
            return None

        path = paths[0]
        distance_text = path.get("distance")
        duration_text = path.get("cost", {}).get("duration")

        try:
            if isinstance(distance_text, bool) or isinstance(duration_text, bool):
                return None
            distance = float(distance_text)
            duration = float(duration_text)
        except (TypeError, ValueError):
            print("高德路线规划返回值缺失或格式异常")
            return None

        if not all(math.isfinite(value) and value >= 0 for value in (distance, duration)):
            print("高德路线规划返回值无效")
            return None

        result = {
            "distance": int(distance),
            "duration": int(duration),
        }
        try:
            raw_tolls = path.get('cost', {}).get('tolls')
            if isinstance(raw_tolls, bool):
                raise ValueError('无效收费')
            tolls = float(raw_tolls)
            if math.isfinite(tolls) and tolls >= 0:
                result['tolls'] = tolls
        except (TypeError, ValueError):
            pass
        return result

    except Exception as error:
        # 请求异常可能含有带 Key 的 URL，只记录异常类型。
        print("请求高德路线规划失败：", type(error).__name__)
        return None
@app.get("/api/stations/recommended")
def get_recommended_stations(
    lng: float = Query(
        ...,
        ge=-180,
        le=180
    ),

    lat: float = Query(
        ...,
        ge=-90,
        le=90
    ),

    limit: int = Query(
        5,
        ge=1,
        le=10
    ),
    mode: Literal['distance', 'economy', 'balanced'] = 'distance',
    distance_weight: Annotated[float, Query(ge=0, le=1)] = 0.5,
    radius_km: Annotated[float, Query(ge=0, le=50)] = 0,
    charge_type: Literal['', 'fast', 'regular'] = '',
    available_only: bool = False,
    name: str = '',
    intent: Literal['', 'urgent', 'destination', 'shopping', 'economy'] = '',
    trip_context: Annotated[str, Query(max_length=3000)] = '',
):
    amap_available = bool(os.getenv("AMAP_WEB_KEY"))
    # 部分参数可留空，未知保持 null；非法输入在读取数据库前拒绝。
    try:
        raw_trip = json.loads(trip_context) if trip_context else {}
        if not isinstance(raw_trip, dict):
            raise ValueError('出行参数须为对象')
        trip = normalize_trip_context(raw_trip)
        for key in DEFAULT_TRIP:
            if raw_trip.get(key) not in (None, '') and trip[key] is None:
                raise ValueError('出行参数超出有效范围')
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail='出行参数格式或范围无效') from None
    trip['origin'] = [lng, lat]

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        # 先读取范围内所有合格站点，按所选模式取约 10 个候选。
        # 经济/综合模式不能只在最近的 10 个站中选，以免遗漏低价站。
        candidate_limit = min(
            max(limit * 2, 10),
            20
        )

        conditions = ["s.geom IS NOT NULL", "(to_jsonb(s)->>'status') IS DISTINCT FROM 'retired'"]
        params = [lng, lat]
        if radius_km > 0:
            conditions.append('ST_DWithin(s.geom::geography, u.geog, %s)')
            params.append(radius_km * 1000)
        if charge_type:
            conditions.append("CASE WHEN to_jsonb(s)->>'charge_type'='fast' THEN 'fast' ELSE 'regular' END = %s")
            params.append(charge_type)
        if available_only:
            conditions.append("(to_jsonb(s)->>'available_count')::integer > 0")
        if name.strip():
            conditions.append("(s.name ILIKE %s OR s.address ILIKE %s)")
            params.extend([f'%{name.strip()}%'] * 2)
        cur.execute(
            """
            WITH user_location AS (
                SELECT
                    ST_SetSRID(
                        ST_MakePoint(%s, %s),
                        4326
                    )::geography AS geog
            )

            SELECT
                s.id,
                s.name,
                s.address,
                ST_X(s.geom) AS lng,
                ST_Y(s.geom) AS lat,
                ST_Distance(s.geom::geography, u.geog) AS straight_distance_meters,
                to_jsonb(s) - ARRAY['geom','geom_wgs84','geom_gcj02','lng','lat'] AS record

            FROM stations s
            CROSS JOIN user_location u

            WHERE """ + ' AND '.join(conditions) + ' ORDER BY straight_distance_meters, s.id',
            tuple(params)
        )

        rows = cur.fetchall()

    finally:
        cur.close()
        conn.close()

    pool = [{
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [station_lng, station_lat]},
        'properties': {**station_properties(station_id, station_name, address, record),
                       'straightDistanceMeters': float(straight_distance_meters),
                       'distanceMeters': float(straight_distance_meters)},
    } for station_id, station_name, address, station_lng, station_lat, straight_distance_meters, record in rows]
    candidates = (rank_trip_stations(pool, intent, trip) if intent else
                  rank_recommendations(pool, mode, distance_weight))[:candidate_limit]

    user_gcj_lng, user_gcj_lat = (
        wgs84_to_gcj02(
            lng,
            lat
        )
    )

    destination_gcj = wgs84_to_gcj02(*trip['destination']) if trip['destination'] else None
    direct = get_amap_driving_info(user_gcj_lng, user_gcj_lat, *destination_gcj) if (
        intent == 'economy' and destination_gcj and candidates and amap_available) else None

    def enrich_candidate(candidate):
        station_lng, station_lat = candidate['geometry']['coordinates']
        straight_distance_meters = candidate['properties']['straightDistanceMeters']

        # 数据库中的站点是 WGS84，
        # 调高德前转换成 GCJ-02。
        station_gcj_lng, station_gcj_lat = (
            wgs84_to_gcj02(
                station_lng,
                station_lat
            )
        )

        route = get_amap_driving_info(
            user_gcj_lng,
            user_gcj_lat,
            station_gcj_lng,
            station_gcj_lat,
        ) if amap_available else None

        # 单个站点算路失败时保留候选，用 PostGIS 的米制直线距离降级。
        # 驾车字段保持为空，避免把直线距离或猜测的时间当作路线结果。
        is_fallback = route is None
        straight_distance_meters = float(straight_distance_meters)

        onward = get_amap_driving_info(station_gcj_lng, station_gcj_lat, *destination_gcj) if (
            intent == 'economy' and destination_gcj and amap_available) else None
        trip_route = {'onwardDistanceMeters': onward.get('distance') if onward else None,
                      'directDistanceMeters': direct.get('distance') if direct else None,
                      'onwardTollsYuan': onward.get('tolls') if onward else None,
                      'directTollsYuan': direct.get('tolls') if direct else None}
        return {
            "type": "Feature",

            "properties": {
                **candidate['properties'],
                "straightDistanceMeters": straight_distance_meters,
                "distanceMeters": straight_distance_meters if is_fallback else route["distance"],
                "distanceType": "straight" if is_fallback else "driving",
                "distanceLabel": "直线距离（降级估算）" if is_fallback else "驾车距离",
                "distanceSource": "postgis_straight" if is_fallback else "amap_driving",
                "isFallback": is_fallback,
                "drivingDistanceMeters": None if is_fallback else route["distance"],
                "drivingDurationSeconds": None if is_fallback else route["duration"],
                **({'drivingTollsYuan': route.get('tolls') if route else None,
                    'tripRoute': trip_route} if intent else {}),
            },

            # 地图仍然是 WGS84，
            # 所以这里不能返回 GCJ-02。
            "geometry": {
                "type": "Point",
                "coordinates": [
                    station_lng,
                    station_lat,
                ]
            }
        }

    # 新出行模式至多 4 个并发请求，避免逐站算两段路线导致长时间等待。
    if intent and amap_available and candidates:
        with ThreadPoolExecutor(max_workers=4) as executor:
            stations = list(executor.map(enrich_candidate, candidates))
    else:
        stations = [enrich_candidate(candidate) for candidate in candidates]

    # ----------------------------------
    # 路线完成后按所选模式重排；distanceSource 区分驾车和直线估算。
    # ----------------------------------

    fitted = rank_trip_stations(stations, intent, trip) if intent else rank_recommendations(stations, mode, distance_weight)
    excluded_count = len(pool) - len(rank_trip_stations(pool, intent, trip)) + len(stations) - len(fitted) if intent else 0
    stations = fitted[:limit]
    fallback_count = sum(station["properties"]["isFallback"] for station in stations)

    return {
        "type": "FeatureCollection",
        "features": stations,
        "metadata": {
            "coordSystem": "WGS84",
            "distanceUnit": "meters",
            "candidateCount": len(candidates),
            "eligibleCount": len(pool),
            "mode": mode,
            **({'intent': intent, 'excludedCount': excluded_count, 'estimated': True,
                'assessmentNotice': '按填写的车辆参数估算；直线距离不能确认可达。排队、充电曲线和费用需现场核实。'} if intent else {}),
            "weights": {"distance": distance_weight, "price": 1 - distance_weight},
            "fallbackCount": fallback_count,
            "notice": "部分结果使用直线距离估算，驾车时间暂无" if fallback_count else "距离和时间来自驾车路径规划",
        },
    }
@app.get('/api/stations/{station_id}/routes')
def get_station_routes(
    station_id: str,
    lng: Annotated[float, Query(ge=-180, le=180)],
    lat: Annotated[float, Query(ge=-90, le=90)],
):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            SELECT s.name, ST_X(s.geom), ST_Y(s.geom),
                ST_Distance(s.geom::geography, ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography)
            FROM stations s WHERE s.id=%s AND s.geom IS NOT NULL
                AND (to_jsonb(s)->>'status') IS DISTINCT FROM 'retired'
        """, (lng, lat, station_id))
        row = cur.fetchone()
    finally:
        cur.close()
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail='站点不存在或已停用')
    name, station_lng, station_lat, straight_distance = row
    routes = get_amap_routes(*wgs84_to_gcj02(lng, lat), *wgs84_to_gcj02(station_lng, station_lat))
    for route in routes:
        route['properties'].update(stationId=station_id, straightDistanceMeters=float(straight_distance))
    return {'type': 'FeatureCollection', 'features': routes, 'metadata': {
        'coordSystem': 'WGS84', 'distanceUnit': 'meters', 'stationId': station_id, 'stationName': name,
        'origin': [lng, lat], 'destination': [station_lng, station_lat], 'routeCount': len(routes),
        'straightDistanceMeters': float(straight_distance), 'isFallback': not routes,
        'distanceType': 'straight' if not routes else 'driving',
        'distanceSource': 'postgis_straight' if not routes else 'amap_driving',
        'notice': '驾车路线暂不可用，仅提供直线距离估算，不绘制道路路线' if not routes else '最多展示三条高德驾车方案',
    }}


# 六边形网格
@app.get("/api/hex-grid")
def get_hex_grid():

    conn = get_db_connection()
    cur = conn.cursor()

    try:

        # -------------------------------------------------
        # 所有分析结果直接读取 PostGIS。
        #
        # 前端不再重新计算 demand / supply / mismatch。
        # geom 已统一为 WGS84 / EPSG:4326。
        # -------------------------------------------------

        cur.execute("""
            SELECT
                id,

                station_count,
                residential_count,
                commercial_count,

                residential_norm,
                commercial_norm,

                demand_index,
                supply_index,
                mismatch_index,

                supply_demand_type,

                ST_AsGeoJSON(geom)

            FROM hex_grid

            ORDER BY id;
        """)

        rows = cur.fetchall()


        # -------------------------------------------------
        # 转成标准 GeoJSON FeatureCollection。
        #
        # properties 保存分析指标，
        # geometry 保存六边形空间位置。
        # -------------------------------------------------

        features = []

        for (
            grid_id,

            station_count,
            residential_count,
            commercial_count,

            residential_norm,
            commercial_norm,

            demand_index,
            supply_index,
            mismatch_index,

            supply_demand_type,

            geometry_json

        ) in rows:

            if geometry_json is None:
                continue


            feature = {
                "type": "Feature",

                "properties": {

                    "id": grid_id,

                    # 保持和你现有 Vue 前端字段命名一致
                    "stationCount": station_count,

                    "residentialCount": residential_count,

                    "commercialCount": commercial_count,

                    "residentialNorm": residential_norm,

                    "commercialNorm": commercial_norm,

                    "demandIndex": demand_index,

                    "supplyIndex": supply_index,

                    "mismatchIndex": mismatch_index,

                    "supplyDemandType": supply_demand_type,
                },

                "geometry": json.loads(
                    geometry_json
                )
            }

            features.append(feature)


        return {
            "type": "FeatureCollection",
            "features": features
        }


    finally:

        cur.close()
        conn.close()
        
        
@app.get("/api/boundary")
def get_boundary():

    conn = get_db_connection()
    cur = conn.cursor()

    try:

        # 魏都区边界已经统一为
        # WGS84 / EPSG:4326。
        #
        # 直接从正式 geom 输出 GeoJSON，
        # 前端不再读取 weidu.json。
        cur.execute("""
            SELECT
                id,
                name,
                ST_AsGeoJSON(geom)
            FROM weidu_boundary
            ORDER BY id;
        """)

        rows = cur.fetchall()

        features = []

        for (
            boundary_id,
            boundary_name,
            geometry_json
        ) in rows:

            if geometry_json is None:
                continue

            features.append({
                "type": "Feature",

                "properties": {
                    "id": boundary_id,
                    "name": boundary_name
                },

                "geometry": json.loads(
                    geometry_json
                )
            })

        return {
            "type": "FeatureCollection",
            "features": features
        }

    finally:

        cur.close()
        conn.close()
@app.get("/api/residential-pois")
def get_residential_pois():

    conn = get_db_connection()
    cur = conn.cursor()

    try:

        # 居民 POI 的正式空间数据已经统一为
        # WGS84 / EPSG:4326。
        #
        # geom 是唯一正式空间数据源，
        # 不再通过 lng / lat 重新拼 Point。
        cur.execute("""
            SELECT
                id,
                name,
                address,
                ST_AsGeoJSON(geom)
            FROM residential_pois
            WHERE geom IS NOT NULL
            ORDER BY id;
        """)

        rows = cur.fetchall()

        features = []

        for (
            poi_id,
            poi_name,
            address,
            geometry_json
        ) in rows:

            features.append({
                "type": "Feature",

                "properties": {
                    "id": poi_id,
                    "name": poi_name,
                    "address": address
                },

                "geometry": json.loads(
                    geometry_json
                )
            })

        return {
            "type": "FeatureCollection",
            "features": features
        }

    finally:

        cur.close()
        conn.close()
        
@app.get("/api/commercial-pois")
def get_commercial_pois():

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        # 商业 POI 的正式空间数据已经统一为
        # WGS84 / EPSG:4326。
        # 前端只读取数据库中的正式 geom。
        cur.execute("""
            SELECT
                id,
                name,
                address,
                ST_AsGeoJSON(geom)
            FROM commercial_pois
            WHERE geom IS NOT NULL
            ORDER BY id;
        """)

        rows = cur.fetchall()

        features = []

        for (
            poi_id,
            poi_name,
            address,
            geometry_json
        ) in rows:

            features.append({
                "type": "Feature",

                "properties": {
                    "id": poi_id,
                    "name": poi_name,
                    "address": address
                },

                "geometry": json.loads(
                    geometry_json
                )
            })

        return {
            "type": "FeatureCollection",
            "features": features
        }

    finally:
        cur.close()
        conn.close()
