import json
from pathlib import Path

from database import get_db_connection


# 找到商业 POI GeoJSON
file_path = (
    Path(__file__).resolve().parent.parent
    / "public"
    / "geojson"
    / "commercial-pois.json"
)


# 读取 GeoJSON
with open(file_path, "r", encoding="utf-8-sig") as file:
    geojson = json.load(file)


# 使用 database.py 中统一的数据库连接
conn = get_db_connection()
cursor = conn.cursor()


# 防止重复运行后出现重复数据
cursor.execute("""
    TRUNCATE TABLE commercial_pois;
""")


count = 0


# 一个 Feature 就代表一个商业 POI
for feature in geojson["features"]:

    properties = feature.get("properties", {})
    geometry = feature.get("geometry", {})

    coordinates = geometry.get("coordinates")

    # 没有坐标就跳过
    if not coordinates:
        continue

    # GeoJSON Point 格式：
    # [经度, 纬度]
    lng = coordinates[0]
    lat = coordinates[1]

    poi_id = (
        properties.get("id")
        or feature.get("id")
    )

    name = properties.get(
        "name",
        "未命名商业设施"
    )

    address = properties.get(
        "address",
        ""
    )

    # 数据库主键不能为空
    if not poi_id:
        print("跳过没有 id 的商业 POI：", name)
        continue

    # 写入数据库
    cursor.execute(
        """
        INSERT INTO commercial_pois (
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


# 保存修改
conn.commit()

cursor.close()
conn.close()


print(f"商业 POI 导入完成，共导入 {count} 个")