"""将五张业务表由原始 GCJ-02 转为 WGS84，并在同一事务中验证、切换、重算。"""

import argparse
import copy
import json
import math
import os
import subprocess
from contextlib import closing
from datetime import datetime
from pathlib import Path

from psycopg2 import sql
from psycopg2.extras import Json

if __package__:
    from .coordinate_transform import gcj02_to_wgs84, wgs84_to_gcj02
    from .database import get_db_connection
else:
    from coordinate_transform import gcj02_to_wgs84, wgs84_to_gcj02
    from database import get_db_connection

ROOT = Path(__file__).resolve().parent.parent
TABLE_TYPES = {
    "stations": "Point", "residential_pois": "Point", "commercial_pois": "Point",
    "hex_grid": "Polygon", "weidu_boundary": "MultiPolygon",
}
MIGRATION_ID = "gcj02_to_wgs84_v1"


def convert_geometry(geometry):
    """逐顶点转换 Point/Polygon/MultiPolygon，保留环、洞和额外维度。"""
    if geometry.get("type") not in set(TABLE_TYPES.values()):
        raise ValueError(f"不支持的几何类型：{geometry.get('type')}")
    result = copy.deepcopy(geometry)
    errors, shifts = [], []

    def convert(values):
        if not isinstance(values, list) or not values:
            raise ValueError("几何坐标不能为空")
        if isinstance(values[0], (int, float)):
            if len(values) < 2 or any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
                raise ValueError("几何坐标必须为有限数值")
            lng, lat = values[:2]
            if not -180 <= lng <= 180 or not -90 <= lat <= 90:
                raise ValueError("经纬度超出范围")
            wgs = gcj02_to_wgs84(lng, lat)
            check = wgs84_to_gcj02(*wgs)
            errors.append(max(abs(check[0] - lng), abs(check[1] - lat)))
            shifts.append(math.hypot(wgs[0] - lng, wgs[1] - lat))
            return [*wgs, *values[2:]]
        return [convert(child) for child in values]

    result["coordinates"] = convert(result["coordinates"])
    return result, {"vertices": len(errors), "max_roundtrip_error_degrees": max(errors),
                    "min_shift_degrees": min(shifts), "max_shift_degrees": max(shifts)}


def source_srid(cursor, table):
    cursor.execute("""SELECT srid FROM geometry_columns
        WHERE f_table_schema = 'public' AND f_table_name = %s AND f_geometry_column = 'geom'""", (table,))
    row = cursor.fetchone()
    if row is None:
        raise ValueError(f"缺少业务几何列：{table}.geom")
    return row[0]


def spatial_relations(cursor, column):
    """记录全部点-边界/点-网格关系和网格邻接关系，供转换前后逐对比较。"""
    relations = {}
    for table in list(TABLE_TYPES)[:3]:
        for target in ("weidu_boundary", "hex_grid"):
            cursor.execute(sql.SQL("""
                SELECT p.id::text, t.id FROM {} p JOIN {} t
                    ON ST_Covers(t.{}, p.{}) ORDER BY p.id, t.id
            """).format(sql.Identifier(table), sql.Identifier(target),
                         sql.Identifier(column), sql.Identifier(column)))
            relations[f"{table}:{target}"] = set(cursor.fetchall())
    cursor.execute(sql.SQL("""SELECT a.id,b.id FROM hex_grid a JOIN hex_grid b
        ON a.id < b.id AND ST_Intersects(a.{},b.{}) ORDER BY a.id,b.id
    """).format(sql.Identifier(column), sql.Identifier(column)))
    relations["grid_intersections"] = set(cursor.fetchall())
    return relations


def recalculate_indicators(cursor):
    """只统计区内点；共边点选最小 ID，边缘缺口最多容许 5 米近邻归属。"""
    fallbacks = []
    for table, count_column in (("stations", "station_count"),
                                ("residential_pois", "residential_count"),
                                ("commercial_pois", "commercial_count")):
        cursor.execute(sql.SQL("""
            WITH assigned AS (
                SELECT p.id, h.id AS hex_id FROM {} p CROSS JOIN LATERAL (
                    SELECT g.id FROM hex_grid g WHERE ST_Covers(g.geom,p.geom)
                        OR ST_DWithin(g.geom::geography,p.geom::geography,5)
                    ORDER BY ST_Covers(g.geom,p.geom) DESC,
                        CASE WHEN ST_Covers(g.geom,p.geom) THEN 0
                            ELSE ST_Distance(g.geom::geography,p.geom::geography) END,
                        g.id LIMIT 1
                ) h
                WHERE EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))
                    AND (to_jsonb(p)->>'status') IS DISTINCT FROM 'retired'
            ), counts AS (
                SELECT hex_id,count(*)::integer AS n FROM assigned GROUP BY hex_id
            ), complete AS (
                SELECT h.id,COALESCE(c.n,0) AS n FROM hex_grid h LEFT JOIN counts c ON c.hex_id=h.id
            ) UPDATE hex_grid h SET {}=c.n FROM complete c WHERE c.id=h.id
        """).format(sql.Identifier(table), sql.Identifier(count_column)))
        cursor.execute(sql.SQL("""
            SELECT p.id,h.id,ST_Distance(p.geom::geography,h.geom::geography) FROM {} p
            CROSS JOIN LATERAL (SELECT g.id,g.geom FROM hex_grid g
                ORDER BY ST_Distance(g.geom::geography,p.geom::geography),g.id LIMIT 1) h
            WHERE EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))
                AND (to_jsonb(p)->>'status') IS DISTINCT FROM 'retired'
                AND NOT EXISTS (SELECT 1 FROM hex_grid g WHERE ST_Covers(g.geom,p.geom))
        """).format(sql.Identifier(table)))
        for point_id, grid_id, distance in cursor.fetchall():
            if distance > 5:
                raise ValueError(f"{table}/{point_id} 距离最近网格 {distance:.3f} 米，超过 5 米边缘容差")
            fallbacks.append({"table": table, "point_id": point_id, "grid_id": grid_id,
                              "distance_metres": distance, "reason": "inside_boundary_but_grid_edge_gap"})
    cursor.execute("""
        WITH ranges AS (
            SELECT MIN(residential_count) AS rmin,MAX(residential_count) AS rmax,
                MIN(commercial_count) AS cmin,MAX(commercial_count) AS cmax,
                MIN(station_count) AS smin,MAX(station_count) AS smax FROM hex_grid
        ) UPDATE hex_grid h SET
            residential_norm=CASE WHEN x.rmax=x.rmin THEN 0 ELSE (h.residential_count-x.rmin)::double precision/(x.rmax-x.rmin) END,
            commercial_norm=CASE WHEN x.cmax=x.cmin THEN 0 ELSE (h.commercial_count-x.cmin)::double precision/(x.cmax-x.cmin) END,
            supply_index=CASE WHEN x.smax=x.smin THEN 0 ELSE ROUND(((h.station_count-x.smin)::numeric/(x.smax-x.smin)),3)::double precision END
        FROM ranges x
    """)
    cursor.execute("""UPDATE hex_grid SET demand_index=
        ROUND((0.5*residential_norm+0.5*commercial_norm)::numeric,3)::double precision""")
    cursor.execute("""UPDATE hex_grid SET mismatch_index=
        ROUND((demand_index-supply_index)::numeric,3)::double precision""")
    cursor.execute("""
        WITH means AS (SELECT AVG(demand_index) AS demand,AVG(supply_index) AS supply FROM hex_grid)
        UPDATE hex_grid h SET supply_demand_type=CASE
            WHEN h.demand_index>=m.demand AND h.supply_index<m.supply THEN 'high-demand-low-supply'
            WHEN h.demand_index>=m.demand AND h.supply_index>=m.supply THEN 'high-demand-high-supply'
            WHEN h.demand_index<m.demand AND h.supply_index>=m.supply THEN 'low-demand-high-supply'
            ELSE 'low-demand-low-supply' END FROM means m
    """)
    totals = {}
    for table, field in (("stations", "station_count"), ("residential_pois", "residential_count"),
                         ("commercial_pois", "commercial_count")):
        cursor.execute(sql.SQL("""SELECT count(*) FROM {} p WHERE EXISTS
            (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))
            AND (to_jsonb(p)->>'status') IS DISTINCT FROM 'retired'""").format(sql.Identifier(table)))
        expected = cursor.fetchone()[0]
        cursor.execute(sql.SQL("SELECT SUM({}) FROM hex_grid").format(sql.Identifier(field)))
        actual = cursor.fetchone()[0]
        if expected != actual:
            raise ValueError(f"{table} 研究区内点数 {expected} 与网格计数 {actual} 不一致")
        totals[table] = actual
    cursor.execute("""SELECT supply_demand_type,count(*) FROM hex_grid GROUP BY supply_demand_type ORDER BY supply_demand_type""")
    totals["classifications"] = dict(cursor.fetchall())
    totals["edge_tolerance_metres"] = 5
    totals["edge_assignments"] = fallbacks
    return totals


def migrate(connection):
    """调用方管理提交；任意验证失败应回滚整个迁移。"""
    report = {"migration_id": MIGRATION_ID, "checked_at": datetime.now().astimezone().isoformat(),
              "source": "GCJ-02", "target": "EPSG:4326", "tables": {}}
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '10s'")
        cursor.execute("SELECT pg_advisory_xact_lock(4326001)")
        for table in TABLE_TYPES:
            cursor.execute(sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(sql.Identifier(table)))
        srids = {table: source_srid(cursor, table) for table in TABLE_TYPES}
        if set(srids.values()) == {4326}:
            cursor.execute("SELECT to_regclass('public.coordinate_migrations')")
            if cursor.fetchone()[0]:
                cursor.execute("SELECT report FROM coordinate_migrations WHERE migration_id=%s", (MIGRATION_ID,))
                previous = cursor.fetchone()
                if previous:
                    return {**previous[0], "already_applied": True}
            raise ValueError("主列已是 4326，但没有本迁移记录；拒绝再次转换")
        if set(srids.values()) != {0}:
            raise ValueError(f"五张表必须统一为原始 SRID 0：{srids}")
        before_relations = spatial_relations(cursor, "geom")
        for table, geometry_type in TABLE_TYPES.items():
            cursor.execute(sql.SQL("""SELECT count(*) FROM {} WHERE geom IS NULL
                OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom) OR ST_SRID(geom)<>0""").format(sql.Identifier(table)))
            if cursor.fetchone()[0]:
                raise ValueError(f"{table} 存在无效原始几何")
            cursor.execute(sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS geom_gcj02 geometry({},0)")
                           .format(sql.Identifier(table), sql.SQL(geometry_type)))
            cursor.execute(sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS geom_wgs84 geometry({},4326)")
                           .format(sql.Identifier(table), sql.SQL(geometry_type)))
            cursor.execute(sql.SQL("UPDATE {} SET geom_gcj02=geom").format(sql.Identifier(table)))
            cursor.execute(sql.SQL("SELECT id,ST_AsGeoJSON(geom,15) FROM {} ORDER BY id").format(sql.Identifier(table)))
            rows = cursor.fetchall()
            if not rows:
                raise ValueError(f"{table} 为空，拒绝执行迁移")
            metrics = {"count": len(rows), "vertices": 0, "max_roundtrip_error_degrees": 0.0,
                       "min_shift_degrees": float("inf"), "max_shift_degrees": 0.0}
            for row_id, geometry in rows:
                converted, validation = convert_geometry(json.loads(geometry))
                metrics["vertices"] += validation["vertices"]
                for field in ("max_roundtrip_error_degrees", "max_shift_degrees"):
                    metrics[field] = max(metrics[field], validation[field])
                metrics["min_shift_degrees"] = min(metrics["min_shift_degrees"], validation["min_shift_degrees"])
                cursor.execute(sql.SQL("UPDATE {} SET geom_wgs84=ST_SetSRID(ST_GeomFromGeoJSON(%s),4326) WHERE id=%s")
                               .format(sql.Identifier(table)), (json.dumps(converted), row_id))
            if metrics["max_roundtrip_error_degrees"] > 1e-7 or metrics["min_shift_degrees"] == 0:
                raise ValueError(f"{table} 坐标回转验证失败或坐标未转换")
            cursor.execute(sql.SQL("""SELECT count(*) FROM {} WHERE geom_wgs84 IS NULL
                OR ST_IsEmpty(geom_wgs84) OR NOT ST_IsValid(geom_wgs84)
                OR ST_SRID(geom_wgs84)<>4326 OR ST_NPoints(geom_wgs84)<>ST_NPoints(geom_gcj02)
                OR ST_XMin(Box3D(geom_wgs84)) < -180 OR ST_XMax(Box3D(geom_wgs84)) > 180
                OR ST_YMin(Box3D(geom_wgs84)) < -90 OR ST_YMax(Box3D(geom_wgs84)) > 90
            """).format(sql.Identifier(table)))
            if cursor.fetchone()[0]:
                raise ValueError(f"{table} 转换后存在无效几何或顶点数发生变化")
            metrics["invalid_geometry"] = 0
            report["tables"][table] = metrics
        after_relations = spatial_relations(cursor, "geom_wgs84")
        report["spatial_validation"] = {}
        for relation, before in before_relations.items():
            after = after_relations[relation]
            difference = before.symmetric_difference(after)
            report["spatial_validation"][relation] = {"before": len(before), "after": len(after), "changed_pairs": len(difference)}
            if difference:
                raise ValueError(f"{relation} 转换前后有 {len(difference)} 个空间关系变化：{sorted(difference)[:5]}")
        for table, geometry_type in TABLE_TYPES.items():
            cursor.execute(sql.SQL("ALTER TABLE {} ALTER COLUMN geom TYPE geometry({},4326) USING geom_wgs84")
                           .format(sql.Identifier(table), sql.SQL(geometry_type)))
            if geometry_type == "Point":
                cursor.execute(sql.SQL("UPDATE {} SET lng=ST_X(geom),lat=ST_Y(geom)").format(sql.Identifier(table)))
            cursor.execute(sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} USING gist (geom_gcj02)")
                           .format(sql.Identifier(f"idx_{table}_gcj02_gist"), sql.Identifier(table)))
            cursor.execute(sql.SQL("COMMENT ON COLUMN {}.geom IS %s").format(sql.Identifier(table)),
                           ("WGS84 / EPSG:4326，逐坐标由原始 GCJ-02 转换；禁止仅重贴 SRID。",))
            cursor.execute(sql.SQL("COMMENT ON COLUMN {}.geom_gcj02 IS %s").format(sql.Identifier(table)),
                           ("迁移前的原始 GCJ-02 几何，SRID 0；供回溯和高德底图展示。",))
            report["tables"][table]["main_srid"] = source_srid(cursor, table)
        report["recalculated_indicators"] = recalculate_indicators(cursor)
        for table in TABLE_TYPES:
            cursor.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(table)))
        cursor.execute("""CREATE TABLE IF NOT EXISTS coordinate_migrations (
            migration_id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), report jsonb NOT NULL)""")
        report["steps_completed"] = ["batch_conversion", "coordinate_validation", "spatial_validation",
                                     "switch_epsg4326", "recalculate_indicators"]
        cursor.execute("INSERT INTO coordinate_migrations (migration_id,report) VALUES (%s,%s)", (MIGRATION_ID, Json(report)))
    return report


def backup_database():
    path = ROOT / "backend/backups" / f"nev_webgis_before_wgs84_{datetime.now():%Y%m%d_%H%M%S}.dump"
    path.parent.mkdir(parents=True, exist_ok=True)
    executable = os.getenv("PG_DUMP_PATH", r"D:\SQL\PostgreSQL\17\bin\pg_dump.exe")
    environment = os.environ.copy()
    environment["PGPASSWORD"] = os.getenv("DB_PASSWORD", "")
    subprocess.run([executable, "--host=localhost", "--port=5433", "--username=postgres",
                    "--dbname=nev_webgis", "--format=custom", "--file=" + str(path)],
                   env=environment, check=True, capture_output=True)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="备份后正式提交；默认试运行并回滚")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/database-migration-4326.json")
    args = parser.parse_args()
    backup = backup_database() if args.apply else None
    with closing(get_db_connection()) as connection:
        try:
            report = migrate(connection)
            if args.apply:
                connection.commit()
            else:
                connection.rollback()
        except Exception:
            connection.rollback()
            raise
    report["committed"] = args.apply
    if backup:
        report["backup"] = str(backup)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
