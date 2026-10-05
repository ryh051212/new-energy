"""将项目原始 GCJ-02 点数据导入当前数据库；迁移后同步保存两种坐标。"""

import json
from contextlib import closing
from pathlib import Path

from psycopg2 import sql

if __package__:
    from .database import get_db_connection
    from .geometry_import import update_geometry
    from .spatial_migration import source_srid, recalculate_indicators
else:
    from database import get_db_connection
    from geometry_import import update_geometry
    from spatial_migration import source_srid, recalculate_indicators

FILES = {"stations": "stations.json", "residential_pois": "residential-pois.json",
         "commercial_pois": "commercial-pois.json"}
ROOT = Path(__file__).resolve().parent.parent


def import_points(table, connection, path=None):
    if table not in FILES:
        raise ValueError("不支持的点数据表")
    data = json.loads(Path(path or ROOT / "public/geojson" / FILES[table]).read_text(encoding="utf-8-sig"))
    if data.get("type") != "FeatureCollection" or not data.get("features"):
        raise ValueError("点数据必须是非空 FeatureCollection")
    ids = set()
    with connection.cursor() as cursor:
        for feature in data["features"]:
            properties = feature.get("properties") or {}
            row_id = properties.get("id") or feature.get("id")
            geometry = feature.get("geometry") or {}
            if not row_id or row_id in ids or geometry.get("type") != "Point":
                raise ValueError(f"点数据缺少唯一 ID 或 Point 几何：{row_id}")
            if properties.get("coordSystem", "GCJ-02") != "GCJ-02":
                raise ValueError("本导入入口只接受原始 GCJ-02 数据，避免二次转换")
            ids.add(row_id)
            cursor.execute(sql.SQL("""INSERT INTO {} (id,name,address) VALUES (%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address
            """).format(sql.Identifier(table)), (row_id, properties.get("name", ""), properties.get("address", "")))
            update_geometry(cursor, table, row_id, geometry)
        if source_srid(cursor, table) == 4326:
            recalculate_indicators(cursor)
    return len(ids)


def main(table):
    with closing(get_db_connection()) as connection:
        with connection:
            count = import_points(table, connection)
    print(f"{table}: {count} records updated")
