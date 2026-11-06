from database import get_db_connection

from coordinate_transform import (
    gcj02_to_wgs84,
    wgs84_to_gcj02
)


conn = get_db_connection()
cur = conn.cursor()


# 只读取一个充电站
cur.execute("""
    SELECT
        id,
        name,
        ST_X(geom),
        ST_Y(geom)
    FROM stations
    WHERE geom IS NOT NULL
    LIMIT 1;
""")


station = cur.fetchone()

cur.close()
conn.close()

if station is None:
    raise RuntimeError("未查询到 stations 表中的有效充电站数据，请检查数据库是否已导入数据。")


station_id = station[0]
name = station[1]

gcj_lng = station[2]
gcj_lat = station[3]


# GCJ-02 → WGS84
wgs_lng, wgs_lat = gcj02_to_wgs84(
    gcj_lng,
    gcj_lat
)


# 再转回来，用于检查算法是否稳定
check_lng, check_lat = wgs84_to_gcj02(
    wgs_lng,
    wgs_lat
)


print("充电站：", name)

print(
    "原始 GCJ-02：",
    gcj_lng,
    gcj_lat
)

print(
    "转换 WGS84：",
    wgs_lng,
    wgs_lat
)

print(
    "重新转换 GCJ-02：",
    check_lng,
    check_lat
)

print(
    "经度误差：",
    abs(check_lng - gcj_lng)
)

print(
    "纬度误差：",
    abs(check_lat - gcj_lat)
)