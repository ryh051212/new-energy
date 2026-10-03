import json
from pathlib import Path
from getpass import getpass

from database import get_db_connection


# 找到项目中的六边形 GeoJSON
file_path = (
    Path(__file__).resolve().parent.parent
    / "public"
    / "geojson"
    / "hex-grid.json"
)


# 读取 GeoJSON
with open(file_path, "r", encoding="utf-8") as file:
    geojson = json.load(file)


# 输入 PostgreSQL 密码
password = getpass("请输入 postgres 密码：")


# 连接数据库
conn = get_db_connection(password)

cursor = conn.cursor()


# 为了防止重复运行脚本后出现重复六边形，
# 每次导入前先清空 hex_grid
cursor.execute("""
    TRUNCATE TABLE hex_grid
    RESTART IDENTITY;
""")


count = 0


# 一个 Feature 就是一个六边形
for feature in geojson["features"]:

    properties = feature.get("properties", {})
    geometry = feature.get("geometry")

    if not geometry:
        continue

    # 读取之前已经计算好的分析结果
    station_count = properties.get("stationCount", 0)
    residential_count = properties.get("residentialCount", 0)
    commercial_count = properties.get("commercialCount", 0)

    demand_index = properties.get("demandIndex", 0)
    supply_index = properties.get("supplyIndex", 0)
    mismatch_index = properties.get("mismatchIndex", 0)

    supply_demand_type = properties.get(
        "supplyDemandType",
        ""
    )

    # PostGIS 可以直接把 GeoJSON geometry
    # 转换成真正的 Polygon 空间对象
    geometry_json = json.dumps(geometry)

    cursor.execute(
        """
        INSERT INTO hex_grid (
            station_count,
            residential_count,
            commercial_count,
            demand_index,
            supply_index,
            mismatch_index,
            supply_demand_type,
            geom
        )
        VALUES (
            %s,
            %s,
            %s,
            %s,
            %s,
            %s,
            %s,
            ST_GeomFromGeoJSON(%s)
        );
        """,
        (
            station_count,
            residential_count,
            commercial_count,
            demand_index,
            supply_index,
            mismatch_index,
            supply_demand_type,
            geometry_json
        )
    )

    count += 1


# 保存修改
conn.commit()

cursor.close()
conn.close()


print(f"六边形导入完成，共导入 {count} 个")