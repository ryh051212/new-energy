"""只读核查数据库数量、几何、空间索引以及研究区外的 POI。"""

import argparse
import json
from contextlib import closing
from datetime import datetime
from pathlib import Path

from psycopg2 import sql

if __package__:
    from .database import get_db_connection
else:
    from database import get_db_connection

TABLES = ("stations", "residential_pois", "commercial_pois", "hex_grid", "weidu_boundary")


def audit_database():
    report = {"checked_at": datetime.now().astimezone().isoformat(), "tables": {}}
    with closing(get_db_connection()) as connection:
        connection.set_session(readonly=True)
        with connection.cursor() as cursor:
            for table in TABLES:
                cursor.execute(sql.SQL("""
                    SELECT count(*), count(*) FILTER (WHERE geom IS NULL),
                        count(*) FILTER (WHERE NOT ST_IsValid(geom)),
                        array_agg(DISTINCT ST_SRID(geom))
                    FROM {}
                """).format(sql.Identifier(table)))
                count, missing, invalid, srids = cursor.fetchone()
                cursor.execute("""
                    SELECT indexname FROM pg_indexes
                    WHERE schemaname = 'public' AND tablename = %s
                        AND indexdef ILIKE '%%USING gist (geom)%%'
                """, (table,))
                report["tables"][table] = {
                    "count": count, "missing_geometry": missing,
                    "invalid_geometry": invalid, "srids": srids,
                    "spatial_indexes": [row[0] for row in cursor.fetchall()],
                }
                if srids == [4326]:
                    cursor.execute(sql.SQL("""SELECT count(*) FILTER (WHERE geom_gcj02 IS NULL
                        OR ST_SRID(geom_gcj02)<>0 OR NOT ST_IsValid(geom_gcj02)),
                        count(*) FILTER (WHERE geom_wgs84 IS NULL OR NOT ST_Equals(geom,geom_wgs84))
                        FROM {}""").format(sql.Identifier(table)))
                    bad_raw, mismatch = cursor.fetchone()
                    report["tables"][table]["invalid_source_backup"] = bad_raw
                    report["tables"][table]["main_candidate_mismatch"] = mismatch
            report["point_coverage"] = {}
            for table in TABLES[:3]:
                cursor.execute(sql.SQL("""
                    SELECT count(*) FILTER (WHERE EXISTS (
                        SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom, p.geom))),
                        count(*) FILTER (WHERE EXISTS (
                        SELECT 1 FROM hex_grid h WHERE ST_Covers(h.geom, p.geom)))
                    FROM {} p
                """).format(sql.Identifier(table)))
                in_boundary, in_grid = cursor.fetchone()
                report["point_coverage"][table] = {
                    "inside_boundary": in_boundary, "inside_grid": in_grid,
                    "outside_boundary": report["tables"][table]["count"] - in_boundary,
                }
                cursor.execute(sql.SQL("""SELECT
                    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))
                        AND EXISTS (SELECT 1 FROM hex_grid h WHERE ST_Covers(h.geom,p.geom))),
                    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))
                        AND NOT EXISTS (SELECT 1 FROM hex_grid h WHERE ST_Covers(h.geom,p.geom)))
                    FROM {} p""").format(sql.Identifier(table)))
                inside_both, inside_uncovered = cursor.fetchone()
                report["point_coverage"][table]["inside_boundary_and_grid"] = inside_both
                report["point_coverage"][table]["inside_boundary_without_grid"] = inside_uncovered
            cursor.execute("""
                SELECT sum(station_count), sum(residential_count), sum(commercial_count),
                    count(*) FILTER (WHERE residential_norm IS NULL OR commercial_norm IS NULL)
                FROM hex_grid
            """)
            stations, residential, commercial, missing_norms = cursor.fetchone()
            report["grid_analysis"] = {
                "station_total": stations, "residential_total": residential,
                "commercial_total": commercial, "missing_normalization": missing_norms,
            }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="可选：将核查结果保存为 UTF-8 JSON")
    args = parser.parse_args()
    content = json.dumps(audit_database(), ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content + "\n", encoding="utf-8")
    print(content)


if __name__ == "__main__":
    main()
