import json
import os
from contextlib import closing
from typing import Literal
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


@app.get("/api/stations")
def get_stations(name: str = ""):

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

        if name.strip():

            cur.execute(
                """
                SELECT
                    id,
                    name,
                    address,
                    ST_AsGeoJSON(geom)
                FROM stations
                WHERE name ILIKE %s
                ORDER BY name;
                """,
                (
                    f"%{name.strip()}%",
                )
            )

        else:

            cur.execute(
                """
                SELECT
                    id,
                    name,
                    address,
                    ST_AsGeoJSON(geom)
                FROM stations
                ORDER BY name;
                """
            )


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
            geometry_json
        ) in rows:

            if geometry_json is None:
                continue

            feature = {
                "type": "Feature",

                "properties": {
                    "id": station_id,
                    "name": station_name,
                    "address": address,
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