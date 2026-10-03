import json
from pathlib import Path
from getpass import getpass

from database import get_db_connection


# --------------------------------
# 1. 找到 stations.json
# --------------------------------
file_path = (
    Path(__file__).resolve().parent.parent
    / "public"
    / "geojson"
    / "stations.json"
)


# --------------------------------
# 2. 读取 GeoJSON
# --------------------------------
with open(file_path, "r", encoding="utf-8") as file:
    geojson = json.load(file)


# --------------------------------
# 3. 连接 PostgreSQL
# --------------------------------
password = getpass("请输入 postgres 密码：")

conn = get_db_connection(password)

cursor = conn.cursor()


# --------------------------------
# 4. 遍历每一个充电站
# --------------------------------
count = 0

for feature in geojson["features"]:

    properties = feature.get("properties", {})
    geometry = feature.get("geometry", {})

    # GeoJSON Point 坐标顺序：
    # [经度, 纬度]
    coordinates = geometry.get("coordinates")

    if not coordinates:
        continue

    lng = coordinates[0]
    lat = coordinates[1]

    # 读取充电站属性
    station_id = (
        properties.get("id")
        or feature.get("id")
    )

    name = properties.get(
        "name",
        "未命名充电站"
    )

    address = properties.get(
        "address",
        ""
    )

    # 没有唯一 id 的数据暂时跳过
    if not station_id:
        print("跳过没有 id 的站点：", name)
        continue

    # --------------------------------
    # 5. 写入 PostgreSQL
    # --------------------------------
    cursor.execute(
        """
        INSERT INTO stations (
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
        )
        ON CONFLICT (id)
        DO UPDATE SET
            name = EXCLUDED.name,
            address = EXCLUDED.address,
            lng = EXCLUDED.lng,
            lat = EXCLUDED.lat,
            geom = EXCLUDED.geom;
        """,
        (
            station_id,
            name,
            address,
            lng,
            lat,
            lng,
            lat
        )
    )

    count += 1


# --------------------------------
# 6. 保存并关闭数据库
# --------------------------------
conn.commit()

cursor.close()
conn.close()

print(f"导入完成，共处理 {count} 个充电站")