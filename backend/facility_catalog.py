"""高德设施目录：分类、坐标转换、事务导入、真实站点配套分析。"""

import hashlib
import json
import math
from datetime import datetime
from pathlib import Path

from psycopg2.extras import Json, execute_values

if __package__:
    from .coordinate_transform import gcj02_to_wgs84
else:
    from coordinate_transform import gcj02_to_wgs84

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "data/managed/facility-categories.json"
CATEGORIES = {item["id"]: item for item in json.loads(CONFIG_PATH.read_text(encoding="utf-8"))["categories"]}
ENDPOINT = "https://restapi.amap.com/v3/place/text"


def text_value(value):
    return value.strip() if isinstance(value, str) else ""


def matching_type(typecode, types):
    """0000 是大类、00 是中类；不使用名称猜测设施类别。"""
    codes = text_value(typecode).split("|")
    return any(len(code) == 6 and code.isdigit() and code.startswith(expected.rstrip("0"))
               for code in codes for expected in types.split("|"))


def read_facilities(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if (payload.get("source"), payload.get("endpoint"), payload.get("region"), payload.get("coordSystem")) != (
            "AMap", ENDPOINT, "411002", "GCJ-02"):
        raise ValueError("只接受已标明来源、魏都区范围和 GCJ-02 坐标系的高德原始采集文件")
    records, rejected, queries = {}, [], {}
    for category, query in payload.get("queries", {}).items():
        if category not in CATEGORIES or query.get("types") != CATEGORIES[category]["types"]:
            raise ValueError(f"不匹配的设施分类：{category}")
        if query.get("status") not in ("complete", "page_limit", "repeated_page"):
            raise ValueError(f"{category} 尚未结束采集，不能作为完整批次导入")
        pages = query.get("pages", [])
        if not pages:
            raise ValueError("缺少逐页采集时间")
        fetched_at = datetime.fromisoformat(pages[-1]["fetchedAt"])
        if fetched_at.tzinfo is None:
            raise ValueError("采集时间须包含时区")
        queries[category] = {"status": query["status"], "fetchedAt": fetched_at.isoformat(),
                             "fetched": len(query["pois"]), "pages": len(pages),
                             "reportedCount": pages[0].get("reportedCount"),
                             "exhaustive": False}
        for poi in query["pois"]:
            poi_id, name = text_value(poi.get("id")), text_value(poi.get("name"))
            reason = None
            if not poi_id or not name:
                reason = "missing_id_or_name"
            elif not matching_type(poi.get("typecode"), query["types"]):
                reason = "typecode_mismatch"
            try:
                coordinates = [float(value) for value in text_value(poi.get("location")).split(",")]
                if (len(coordinates) != 2 or any(not math.isfinite(value) for value in coordinates)
                        or not -180 <= coordinates[0] <= 180 or not -90 <= coordinates[1] <= 90):
                    raise ValueError()
            except (ValueError, TypeError):
                reason = "invalid_coordinates"
            if reason:
                rejected.append({"id": poi_id, "category": category, "reason": reason})
                continue
            if poi_id in records:
                if category not in records[poi_id]["categories"]:
                    records[poi_id]["categories"].append(category)
                continue
            lng, lat = gcj02_to_wgs84(*coordinates)
            records[poi_id] = {"id": poi_id, "name": name, "address": text_value(poi.get("address")),
                "categories": [category], "type": text_value(poi.get("type")),
                "typecode": text_value(poi.get("typecode")), "adcode": text_value(poi.get("adcode")),
                "district": text_value(poi.get("adname")), "lng": lng, "lat": lat,
                "raw_lng": coordinates[0], "raw_lat": coordinates[1], "fetched_at": fetched_at.isoformat(),
                "source_url": f"https://www.amap.com/place/{poi_id}", "raw": poi}
    if set(queries) != set(CATEGORIES):
        raise ValueError("采集文件缺少设施类别")
    return list(records.values()), {"queries": queries, "rejected": rejected,
        "input_unique": len(records), "source": "AMap", "coordSystem": "WGS84",
        "snapshot_sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}


def ensure_schema(cursor):
    cursor.execute("""CREATE TABLE IF NOT EXISTS facility_pois (
        id text PRIMARY KEY, name text NOT NULL, address text NOT NULL DEFAULT '',
        categories text[] NOT NULL CHECK (cardinality(categories)>0),
        poi_type text NOT NULL, typecode text NOT NULL,
        adcode text NOT NULL DEFAULT '', district text NOT NULL DEFAULT '',
        data_source text NOT NULL DEFAULT 'amap-poi' CHECK (data_source='amap-poi'),
        source_url text NOT NULL, fetched_at timestamptz NOT NULL,
        verification_status text NOT NULL DEFAULT 'map_record_only'
            CHECK (verification_status='map_record_only'),
        lng double precision NOT NULL, lat double precision NOT NULL,
        geom geometry(Point,4326) NOT NULL,
        geom_gcj02 geometry(Point,0) NOT NULL,
        geom_wgs84 geometry(Point,4326) NOT NULL,
        raw jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
        CHECK (lng BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90),
        CHECK (ST_Equals(geom,geom_wgs84) AND lng=ST_X(geom) AND lat=ST_Y(geom))
    )""")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_facility_pois_geom_gist ON facility_pois USING gist(geom)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_facility_pois_geography ON facility_pois USING gist((geom::geography))")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_facility_pois_categories ON facility_pois USING gin(categories)")
    cursor.execute("""CREATE TABLE IF NOT EXISTS facility_imports (
        snapshot_sha256 text PRIMARY KEY, imported_at timestamptz NOT NULL DEFAULT now(),
        source_file text NOT NULL, report jsonb NOT NULL)""")
    cursor.execute("""CREATE OR REPLACE VIEW facility_grid_counts AS
        WITH assigned AS (
            SELECT p.id,p.categories,h.id AS hex_id FROM facility_pois p
            CROSS JOIN LATERAL (
                SELECT g.id FROM hex_grid g
                WHERE ST_Covers(g.geom,p.geom) OR ST_DWithin(g.geom::geography,p.geom::geography,5)
                ORDER BY ST_Covers(g.geom,p.geom) DESC,
                    CASE WHEN ST_Covers(g.geom,p.geom) THEN 0
                        ELSE ST_Distance(g.geom::geography,p.geom::geography) END,g.id LIMIT 1
            ) h
        ) SELECT g.id,
            count(a.id) FILTER (WHERE 'parking'=ANY(a.categories))::integer AS parking_count,
            count(a.id) FILTER (WHERE a.categories && ARRAY['office','company','industrial_park','hospital','school'])::integer AS office_count,
            count(a.id) FILTER (WHERE a.categories && ARRAY['office','company','industrial_park'])::integer AS workplace_count,
            count(a.id) FILTER (WHERE 'hospital'=ANY(a.categories))::integer AS hospital_count,
            count(a.id) FILTER (WHERE 'school'=ANY(a.categories))::integer AS school_count,
            count(a.id) FILTER (WHERE a.categories && ARRAY['restaurant','park','leisure'])::integer AS activity_count,
            count(a.id)::integer AS facility_count
        FROM hex_grid g LEFT JOIN assigned a ON a.hex_id=g.id GROUP BY g.id""")


def import_facilities(connection, path):
    records, report = read_facilities(path)
    report.update(inserted=0, updated=0, outside_boundary=0)
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout='10s'")
        cursor.execute("SELECT pg_advisory_xact_lock(4326002)")
        ensure_schema(cursor)
        cursor.execute("CREATE TEMP TABLE IF NOT EXISTS incoming_facilities (LIKE facility_pois INCLUDING DEFAULTS) ON COMMIT DROP")
        cursor.execute("TRUNCATE pg_temp.incoming_facilities")
        values = [(p["id"], p["name"], p["address"], p["categories"], p["type"], p["typecode"],
                   p["adcode"], p["district"], p["source_url"], p["fetched_at"], p["lng"], p["lat"],
                   p["lng"], p["lat"], p["raw_lng"], p["raw_lat"], p["lng"], p["lat"], Json(p["raw"])) for p in records]
        if values:
            execute_values(cursor, """INSERT INTO incoming_facilities
                (id,name,address,categories,poi_type,typecode,adcode,district,source_url,fetched_at,
                 lng,lat,geom,geom_gcj02,geom_wgs84,raw) VALUES %s""", values,
                template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),0),ST_SetSRID(ST_MakePoint(%s,%s),4326),%s)")
        cursor.execute("""SELECT id FROM incoming_facilities p WHERE NOT EXISTS
            (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom)) ORDER BY id""")
        report["outside_boundary_ids"] = [row[0] for row in cursor.fetchall()]
        report["outside_boundary"] = len(report["outside_boundary_ids"])
        cursor.execute("""INSERT INTO facility_pois AS target
            SELECT p.* FROM incoming_facilities p WHERE EXISTS
                (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))
            ON CONFLICT (id) DO UPDATE SET
                name=EXCLUDED.name,address=EXCLUDED.address,categories=EXCLUDED.categories,
                poi_type=EXCLUDED.poi_type,typecode=EXCLUDED.typecode,
                adcode=EXCLUDED.adcode,district=EXCLUDED.district,source_url=EXCLUDED.source_url,
                fetched_at=EXCLUDED.fetched_at,lng=EXCLUDED.lng,lat=EXCLUDED.lat,
                geom=EXCLUDED.geom,geom_gcj02=EXCLUDED.geom_gcj02,geom_wgs84=EXCLUDED.geom_wgs84,
                raw=EXCLUDED.raw,updated_at=now()
            RETURNING (xmax=0)""")
        for (inserted,) in cursor.fetchall():
            report["inserted" if inserted else "updated"] += 1
        cursor.execute("""SELECT category,count(*) FROM facility_pois p,
            unnest(p.categories) AS category GROUP BY category ORDER BY category""")
        report["category_counts"] = dict(cursor.fetchall())
        cursor.execute("""SELECT count(*) FILTER (WHERE
            NOT EXISTS (SELECT 1 FROM residential_pois r WHERE r.id=p.id)
            AND NOT EXISTS (SELECT 1 FROM commercial_pois m WHERE m.id=p.id)
            AND NOT EXISTS (SELECT 1 FROM stations s WHERE s.id=p.id)),count(*)
            FROM facility_pois p""")
        new_ids, all_ids = cursor.fetchone()
        report["new_ids_vs_original_tables"] = new_ids
        report["existing_ids_vs_original_tables"] = all_ids - new_ids
        report["missing_categories"] = sorted(set(CATEGORIES) - set(report["category_counts"]))
        if report["missing_categories"]:
            raise ValueError(f"以下类别未取得区内有效 POI：{report['missing_categories']}")
        cursor.execute("""SELECT count(*),count(*) FILTER (WHERE NOT ST_IsValid(p.geom)),
            count(*) FILTER (WHERE NOT ST_Equals(p.geom,p.geom_wgs84)),
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))),
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM hex_grid h
                WHERE ST_Covers(h.geom,p.geom) OR ST_DWithin(h.geom::geography,p.geom::geography,5)))
            FROM facility_pois p""")
        total, invalid, mismatch, outside, unassigned = cursor.fetchone()
        report["quality"] = dict(total=total, invalid_geometry=invalid, geometry_mismatch=mismatch,
                                  outside_boundary=outside, without_grid_within_5m=unassigned)
        cursor.execute("""SELECT p.id,p.name,p.categories,round(ST_Distance(p.geom::geography,
            (SELECT h.geom FROM hex_grid h ORDER BY ST_Distance(h.geom::geography,p.geom::geography) LIMIT 1)::geography)::numeric,2)
            FROM facility_pois p WHERE NOT EXISTS (SELECT 1 FROM hex_grid h
                WHERE ST_Covers(h.geom,p.geom) OR ST_DWithin(h.geom::geography,p.geom::geography,5)) ORDER BY p.id""")
        report["unassigned_grid"] = [{"id": row[0], "name": row[1], "categories": row[2],
            "nearestGridMeters": float(row[3]) if row[3] is not None else None} for row in cursor.fetchall()]
        if invalid or mismatch or outside:
            raise ValueError("设施几何/研究区核查失败")
        report["notes"] = ["高德地图记录，未现场核查；采集结果不保证穷尽所有设施。",
            "停车场为待核查候选位置；公共开放、泊位数、产权、电力接入条件均未知。",
            "距离为 WGS84 地理距离，不能替代实际步行可达路线。",
            "原站点、小区、商业表和供需模型保留；新设施独立分类，避免改变旧指标含义。",
            "距既有网格超过 5 米的区内设施保留在目录，不强行归入网格；详见 unassigned_grid。"]
        cursor.execute("""INSERT INTO facility_imports(snapshot_sha256,source_file,report) VALUES(%s,%s,%s)
            ON CONFLICT(snapshot_sha256) DO UPDATE SET report=EXCLUDED.report,imported_at=now()""",
            (report["snapshot_sha256"], Path(path).name, Json(report)))
    return report


def grid_factors(cursor):
    """未初始化目录时不把缺失数据误报为零。"""
    cursor.execute("SELECT to_regclass('public.facility_grid_counts')")
    if cursor.fetchone()[0] is None:
        return {}
    cursor.execute("""SELECT id,parking_count,office_count,workplace_count,hospital_count,
        school_count,activity_count,facility_count FROM facility_grid_counts ORDER BY id""")
    fields = ("parkingCount", "officeCount", "workplaceCount", "hospitalCount", "schoolCount", "activityCount", "facilityCount")
    return {row[0]: dict(zip(fields, row[1:]), facilityDataSource="amap-poi",
                          facilityCountsAreMinimum=True) for row in cursor.fetchall()}


def facilities_geojson(connection, category=None, name="", limit=10000, offset=0, center=None, radius=500):
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('public.facility_pois')")
        if cursor.fetchone()[0] is None:
            return {"type": "FeatureCollection", "features": [], "metadata": {"initialized": False}}
        condition = "(%s::text IS NULL OR %s=ANY(categories)) AND (%s='' OR name ILIKE %s)"
        params = (category, category, name, f"%{name}%")
        if center is not None:
            condition += " AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography,%s)"
            params += (*center, radius)
        cursor.execute("SELECT count(*) FROM facility_pois WHERE " + condition, params)
        total = cursor.fetchone()[0]
        distance_sql = ("ST_Distance(geom::geography,ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography)"
                        if center is not None else "NULL::double precision")
        cursor.execute("""SELECT id,name,address,categories,poi_type,typecode,source_url,fetched_at,
            ST_AsGeoJSON(geom),""" + distance_sql + " AS meters FROM facility_pois WHERE " + condition
            + " ORDER BY meters NULLS LAST,id LIMIT %s OFFSET %s",
            (*(center or ()), *params, limit, offset))
        features = [{"type": "Feature", "properties": {"id": row[0], "name": row[1], "address": row[2],
            "category": row[3][0], "categories": row[3], "type": row[4], "typecode": row[5],
            "sourceUrl": row[6], "fetchedAt": row[7].isoformat(), "dataSource": "amap-poi",
            "coordSystem": "WGS84", "verificationStatus": "map_record_only",
            "straightDistanceMeters": round(row[9], 1) if row[9] is not None else None,
            "candidateStatus": "requires_field_check" if "parking" in row[3] else None},
            "geometry": json.loads(row[8])} for row in cursor.fetchall()]
    return {"type": "FeatureCollection", "features": features, "metadata": {
        "initialized": True, "source": "AMap", "coordSystem": "WGS84", "total": total,
        "limit": limit, "offset": offset, "hasMore": offset + len(features) < total,
        "scope": "weidu", "exhaustive": False, "fieldVerified": False,
        "distanceMethod": "postgis_geography_straight" if center else None}}


def coverage_summary(connection, radius=500):
    """按真实站点计算设施的直线配套范围；演示站点不参与。"""
    with connection.cursor() as cursor:
        cursor.execute("""WITH real_stations AS (
            SELECT id,geom FROM stations WHERE NOT is_synthetic AND status<>'retired'
                AND EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,stations.geom))
        ), measured AS (
            SELECT p.id,p.categories,nearest.meters,
                (SELECT count(*) FROM real_stations s
                    WHERE ST_DWithin(s.geom::geography,p.geom::geography,%s)) AS station_count
            FROM facility_pois p LEFT JOIN LATERAL (
                SELECT ST_Distance(p.geom::geography,s.geom::geography) AS meters
                FROM real_stations s ORDER BY ST_Distance(p.geom::geography,s.geom::geography) LIMIT 1
            ) nearest ON true
        ) SELECT category,count(*),count(*) FILTER(WHERE station_count>0),
            count(*) FILTER(WHERE station_count=0),count(*) FILTER(WHERE station_count>1),
            round(avg(meters)::numeric,1),round(max(meters)::numeric,1)
        FROM measured,unnest(categories) category GROUP BY category ORDER BY category""", (radius,))
        fields = ("count", "covered", "uncovered", "multipleStations", "meanNearestMeters", "maxNearestMeters")
        categories = {row[0]: {key: float(value) if key.endswith("Meters") and value is not None else value
                              for key, value in zip(fields, row[1:])} for row in cursor.fetchall()}
        cursor.execute("""SELECT count(*),count(*) FILTER(WHERE NOT is_synthetic),
            count(*) FILTER(WHERE is_synthetic) FROM stations s WHERE status<>'retired'
            AND EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,s.geom))""")
        total, real, synthetic = cursor.fetchone()
        cursor.execute("""WITH real AS (
            SELECT id,name,geom FROM stations s WHERE NOT is_synthetic AND status<>'retired'
                AND EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,s.geom))
        ) SELECT s.id,s.name,n.id,n.name,n.meters FROM real s LEFT JOIN LATERAL (
            SELECT t.id,t.name,ST_Distance(s.geom::geography,t.geom::geography) AS meters
            FROM real t WHERE t.id<>s.id ORDER BY ST_Distance(s.geom::geography,t.geom::geography),t.id LIMIT 1
        ) n ON true ORDER BY s.id""")
        neighbors = [{"id": row[0], "name": row[1], "nearestStationId": row[2], "nearestStationName": row[3],
            "nearestMeters": round(row[4], 1) if row[4] is not None else None} for row in cursor.fetchall()]
    return {"radiusMeters": radius, "distanceMethod": "postgis_geography_straight",
        "realStations": real, "excludedSyntheticStations": synthetic, "allStations": total,
        "stationNeighbors": neighbors, "categories": categories,
        "notice": "半径为可调分析假设；直线范围不表示已验证步行可达，停车场仍须现场核查。"}
