"""导入原始 GCJ-02 GeoJSON，自动适配迁移前和迁移后的数据库列。"""

import json

from psycopg2 import sql

if __package__:
    from .spatial_migration import convert_geometry, source_srid, TABLE_TYPES
else:
    from spatial_migration import convert_geometry, source_srid, TABLE_TYPES


def update_geometry(cursor, table, row_id, geometry):
    if table not in TABLE_TYPES:
        raise ValueError("不支持的业务表")
    if table == "weidu_boundary" and geometry["type"] == "Polygon":
        geometry = {"type": "MultiPolygon", "coordinates": [geometry["coordinates"]]}
    srid = source_srid(cursor, table)
    raw_json = json.dumps(geometry)
    if srid == 4326:
        converted, _ = convert_geometry(geometry)
        cursor.execute(sql.SQL("""UPDATE {} SET
            geom=ST_SetSRID(ST_GeomFromGeoJSON(%s),4326),
            geom_wgs84=ST_SetSRID(ST_GeomFromGeoJSON(%s),4326),
            geom_gcj02=ST_SetSRID(ST_GeomFromGeoJSON(%s),0) WHERE id=%s
        """).format(sql.Identifier(table)), (json.dumps(converted), json.dumps(converted), raw_json, row_id))
    elif srid == 0:
        cursor.execute(sql.SQL("UPDATE {} SET geom=ST_SetSRID(ST_GeomFromGeoJSON(%s),0) WHERE id=%s")
                       .format(sql.Identifier(table)), (raw_json, row_id))
    else:
        raise ValueError(f"不支持的数据库 SRID：{srid}")
    if table in ("stations", "residential_pois", "commercial_pois"):
        cursor.execute(sql.SQL("UPDATE {} SET lng=ST_X(geom),lat=ST_Y(geom) WHERE id=%s")
                       .format(sql.Identifier(table)), (row_id,))
