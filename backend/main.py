import json
import os
from contextlib import closing
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

if __package__:
    from .database import get_db_connection
else:
    from database import get_db_connection

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


@app.get("/api/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/stations")
def get_stations(name: str | None = None):
    """
    从 PostgreSQL/PostGIS 查询充电站，
    然后转换成 GeoJSON 返回给前端。
    """

    password = os.getenv("DB_PASSWORD")
    if not password:
        raise HTTPException(
            status_code=503,
            detail="数据库密码未配置，请在 backend/.env.local 或项目根目录 .env.local 中设置 DB_PASSWORD。",
        )

    # 无论查询是否成功，都要释放数据库连接。
    with closing(get_db_connection()) as conn:
        with conn.cursor() as cursor:
            sql = "SELECT id, name, address, ST_X(geom), ST_Y(geom) FROM stations"
            if name:
                cursor.execute(sql + " WHERE name ILIKE %s", (f"%{name}%",))
            else:
                cursor.execute(sql)
            rows = cursor.fetchall()

    features = []

    # 把数据库中的每一行重新组装成 GeoJSON Feature
    for row in rows:
        station_id, name, address, lng, lat = row

        features.append({
            "type": "Feature",

            "properties": {
                "id": station_id,
                "name": name,
                "address": address
            },

            "geometry": {
                "type": "Point",
                "coordinates": [lng, lat]
            }
        })

    # 返回完整 GeoJSON
    return {
        "type": "FeatureCollection",
        "features": features
    }
#六边形网络
@app.get("/api/hex-grid")
def get_hex_grid():
    """
    从 PostgreSQL / PostGIS 查询六边形分析结果，
    并返回 GeoJSON。
    """

    conn = get_db_connection()

    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            id,
            station_count,
            residential_count,
            commercial_count,
            demand_index,
            supply_index,
            mismatch_index,
            supply_demand_type,

            -- 把 PostGIS Polygon 转回 GeoJSON
            ST_AsGeoJSON(geom)
        FROM hex_grid;
    """)

    rows = cursor.fetchall()

    features = []

    for row in rows:
        (
            hex_id,
            station_count,
            residential_count,
            commercial_count,
            demand_index,
            supply_index,
            mismatch_index,
            supply_demand_type,
            geometry_json
        ) = row

        features.append({
            "type": "Feature",

            "properties": {
                "id": hex_id,

                # 属性名继续保持前端原来使用的写法
                "stationCount": station_count,
                "residentialCount": residential_count,
                "commercialCount": commercial_count,

                "demandIndex": demand_index,
                "supplyIndex": supply_index,
                "mismatchIndex": mismatch_index,

                "supplyDemandType": supply_demand_type
            },

            # ST_AsGeoJSON 返回的是字符串，
            # 所以转换成真正的 Python 对象
            "geometry": json.loads(geometry_json)
        })

    cursor.close()
    conn.close()

    return {
        "type": "FeatureCollection",
        "features": features
    }