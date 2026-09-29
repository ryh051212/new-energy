import json
from pathlib import Path
import os
from contextlib import closing
import psycopg2
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

backend_dir = Path(__file__).resolve().parent
load_dotenv(backend_dir / ".env.local")
load_dotenv(backend_dir.parent / ".env.local")

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
    with closing(psycopg2.connect(
        dbname="nev_webgis",
        user="postgres",
        password=password,
        host="localhost",
        port=5433,
    )) as conn:
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
    返回六边形分析结果 GeoJSON。
    """

    file_path = (
        Path(__file__).resolve().parent.parent
        / "public"
        / "geojson"
        / "hex-grid.json"
    )

    with open(
        file_path,
        "r",
        encoding="utf-8"
    ) as file:
        hex_grid = json.load(file)

    return hex_grid
