"""导入已采集的高德设施。默认试运行并回滚，--apply 提交。"""

import argparse
import json
from contextlib import closing
from pathlib import Path

from .database import get_db_connection
from .facility_catalog import ROOT, import_facilities, coverage_summary
from .spatial_migration import backup_database


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data/raw/amap-facilities.json")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/facility-import-report.json")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with closing(get_db_connection()) as connection:
        backup_path = backup_database() if args.apply else None
        try:
            report = import_facilities(connection, args.input)
            report["coverage"] = coverage_summary(connection)
            report["applied"] = args.apply
            report["backup"] = str(backup_path) if backup_path else None
            if args.apply:
                connection.commit()
            else:
                connection.rollback()
        except Exception:
            connection.rollback()
            raise
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in (
        "outside_boundary_ids", "rejected", "coverage")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
