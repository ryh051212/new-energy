"""基于当前研究区与网格生成可复现的虚拟站点；不宣称任何模拟地点是真实设施。"""

import argparse
import csv
import json
import random
from contextlib import closing
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.ops import unary_union

if __package__:
    from .database import get_db_connection
    from .station_catalog import ROOT, FIELDS, DEMO_DATASET
else:
    from database import get_db_connection
    from station_catalog import ROOT, FIELDS, DEMO_DATASET


def build_demo(boundary, grid, count=240, seed=20261005, scope="urban"):
    if count < 1 or scope not in ("urban", "weidu"):
        raise ValueError("count 必须为正整数，scope 只能为 urban 或 weidu")
    rng = random.Random(seed)
    covered = boundary.intersection(grid)
    if covered.is_empty or covered.area <= 0:
        raise ValueError("研究区与网格没有有效交集")
    min_lng, min_lat, max_lng, max_lat = covered.bounds
    inside_count = count if scope == "weidu" else count // 2
    locations = []
    attempts = 0
    while len(locations) < inside_count:
        attempts += 1
        if attempts > count * 1000:
            raise ValueError("无法生成足够的区内点，请检查研究区几何")
        point = Point(round(rng.uniform(min_lng, max_lng), 7), round(rng.uniform(min_lat, max_lat), 7))
        if covered.contains(point):
            locations.append((point, "魏都区", "区内"))
    center = boundary.centroid
    # 城区外延是模拟分区，并非行政区划数据。控制在研究区周边约 15 km 内。
    clusters = [(max_lng + .018, center.y, "城区东部（模拟分区）", "东部"),
                (center.x + .025, max_lat + .012, "城区北部（模拟分区）", "北部"),
                (center.x, min_lat - .018, "城区南部（模拟分区）", "南部"),
                (min_lng - .018, center.y, "城区西部（模拟分区）", "西部")]
    while len(locations) < count:
        cx, cy, district, zone = clusters[(len(locations) - inside_count) % len(clusters)]
        point = Point(round(cx + rng.uniform(-.012, .012), 7), round(cy + rng.uniform(-.009, .009), 7))
        if not boundary.covers(point):
            locations.append((point, district, zone))
    rows = []
    types = ["公共停车场", "居住社区", "商圈停车场", "办公园区", "城市道路停车区", "交通接驳区"]
    for index, (point, district, zone) in enumerate(locations, 1):
        slow_only = index % 4 == 0
        fast = 0 if slow_only else rng.choice([4, 6, 8, 12, 16, 20])
        slow = rng.choice([6, 8, 12, 16]) if slow_only else rng.choice([0, 2, 4, 6])
        total = fast + slow
        status = "maintenance" if index % 29 == 0 else "offline" if index % 41 == 0 else "active"
        rows.append(dict(zip(FIELDS, [
            f"SIM-XC-{index:04d}", f"许昌{zone}示范充电站{index:03d}（虚拟）",
            f"许昌市{district}·模拟{types[index % len(types)]}{index:03d}号（非真实地址）",
            point.x, point.y, "WGS84", "许昌市", district, f"模拟运营商{1 + index % 4}",
            types[index % len(types)], "regular" if slow_only else "fast", total, fast, slow,
            rng.randrange(total + 1) if status == "active" else 0,
            rng.choice([7, 11, 22]) if slow_only else rng.choice([60, 90, 120, 180, 240]),
            round(rng.uniform(.48, .92), 2), round(rng.uniform(.18, .55), 2),
            rng.choice([0, 0, 2, 3, 5]), "00:00-24:00" if index % 5 else "07:00-23:00",
            status, "true", "synthetic", DEMO_DATASET, "2026-10-05T08:00:00+08:00",
            "虚拟演示数据；位置、桩数、空闲、功率、价格均为模拟快照，不可用于实际导航或充电决策",
            "[]",
        ])))
    return rows


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=240)
    parser.add_argument("--seed", type=int, default=20261005)
    parser.add_argument("--scope", choices=("urban", "weidu"), default="urban")
    parser.add_argument("--output", type=Path, default=ROOT / "data/managed/xuchang-stations.csv")
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("维护文件已存在；为保护手工修改，请使用 --output 指定新的文件")
    with closing(get_db_connection()) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT ST_AsGeoJSON(geom) FROM weidu_boundary")
            boundary = unary_union([shape(json.loads(row[0])) for row in cursor.fetchall()])
            cursor.execute("SELECT ST_AsGeoJSON(geom) FROM hex_grid")
            grid = unary_union([shape(json.loads(row[0])) for row in cursor.fetchall()])
    rows = build_demo(boundary, grid, args.count, args.seed, args.scope)
    write_csv(args.output, rows)
    template = ROOT / "data/templates/stations-template.csv"
    if not template.exists():
        write_csv(template, [])
    print(json.dumps({"generated": len(rows), "inside_weidu": sum(row['district'] == '魏都区' for row in rows),
                      "scope": args.scope, "seed": args.seed, "path": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
