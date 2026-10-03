import json
from pathlib import Path
from getpass import getpass

from database import get_db_connection
import psycopg2


# 找到居民小区 GeoJSON
file_path = (
    Path(__file__).resolve().parent.parent
    / "public"
    / "geojson"
    / "residential-pois.json"
)


# 读取 GeoJSON
with open(file_path, "r", encoding="utf-8") as file:
    geojson = json.load(file)


# 输入 PostgreSQL 密码
password = getpass("请输入 postgres 密码：")


# 连接数据库
conn = get_db_connection(password)

cursor = conn.cursor()


# 防止重复执行后产生重复数据
cursor.execute("""
    TRUNCATE TABLE residential_pois;
""")


count = 0


# 一个 Feature 就是一个居民小区 POI
for feature in geojson["features"]:

    properties = feature.get("properties", {})
    geometry = feature.get("geometry", {})

    coordinates = geometry.get("coordinates")

    # 没有坐标的数据跳过
    if not coordinates:
        continue

    lng = coordinates[0]
    lat = coordinates[1]

    # 读取 POI 属性
    poi_id = (
        properties.get("id")
        or feature.get("id")
    )

    name = properties.get(
        "name",
        "未命名小区"
    )

    address = properties.get(
        "address",
        ""
    )

    # 没有唯一 ID 的记录暂时跳过
    if not poi_id:
        print("跳过没有 id 的小区：", name)
        continue

    # 写入 residential_pois
    cursor.execute(
        """
        INSERT INTO residential_pois (
            id,
            name,
            address,
            lng,
            lat,
            geom
        )
        VALUES (
            %s,
            %s,
            %s,
            %s,
            %s,
            ST_MakePoint(%s, %s)
        );
        """,
        (
            poi_id,
            name,
            address,
            lng,
            lat,
            lng,
            lat
        )
    )

    count += 1


# 保存
conn.commit()

cursor.close()
conn.close()


print(f"居民小区导入完成，共导入 {count} 个")