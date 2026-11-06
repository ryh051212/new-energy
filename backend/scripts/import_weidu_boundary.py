"""按名称更新原始研究区边界，并自动适配 EPSG:4326 数据库。"""
import json
from contextlib import closing
from pathlib import Path

if __package__:
    from .database import get_db_connection
    from .geometry_import import update_geometry
    from .spatial_migration import source_srid, recalculate_indicators
else:
    from database import get_db_connection
    from geometry_import import update_geometry
    from spatial_migration import source_srid, recalculate_indicators

GEOJSON_PATH = Path(__file__).resolve().parent.parent / "public/geojson/weidu.json"


def import_weidu_boundary():
    data = json.loads(GEOJSON_PATH.read_text(encoding="utf-8-sig"))
    features = data.get("features") if data.get("type") == "FeatureCollection" else [data]
    if not features:
        raise ValueError("研究区边界不能为空")
    with closing(get_db_connection()) as connection:
        with connection:
            with connection.cursor() as cursor:
                for feature in features:
                    geometry = feature.get("geometry") or {}
                    if geometry.get("type") not in ("Polygon", "MultiPolygon"):
                        raise ValueError("研究区边界必须是面要素")
                    name = (feature.get("properties") or {}).get("name", "魏都区")
                    cursor.execute("SELECT id FROM weidu_boundary WHERE name=%s ORDER BY id", (name,))
                    rows = cursor.fetchall()
                    if len(rows) > 1:
                        raise ValueError("研究区边界名称重复，请先核查")
                    if rows:
                        row_id = rows[0][0]
                    else:
                        cursor.execute("INSERT INTO weidu_boundary (name) VALUES (%s) RETURNING id", (name,))
                        inserted = cursor.fetchone()
                        if inserted is None:
                            raise RuntimeError("研究区边界写入失败：INSERT 未返回主键 ID")
                        row_id = inserted[0]
                    update_geometry(cursor, "weidu_boundary", row_id, geometry)
                if source_srid(cursor, "weidu_boundary") == 4326:
                    recalculate_indicators(cursor)
    print(f"Boundary: {len(features)} records updated")


if __name__ == "__main__":
    import_weidu_boundary()
