"""真实 PostGIS 重复导入回滚 + 临时 HTTP 服务校验；不请求高德。"""

import json
import socket
import threading
import time
from contextlib import closing
from pathlib import Path

import requests
import uvicorn
from psycopg2 import sql

from backend import main
from backend.coordinate_transform import wgs84_to_gcj02
from backend.database import get_db_connection
from backend.facility_catalog import ROOT, CATEGORIES, import_facilities


def original_hashes(cursor):
    result = {}
    for table in ("stations", "residential_pois", "commercial_pois", "hex_grid", "weidu_boundary"):
        cursor.execute(sql.SQL("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM {} t")
                       .format(sql.Identifier(table)))
        result[table] = cursor.fetchone()[0]
    return result


def check():
    with closing(get_db_connection()) as connection:
        with connection.cursor() as cursor:
            originals = original_hashes(cursor)
            cursor.execute("SELECT count(*) FROM facility_pois")
            expected = cursor.fetchone()[0]
        try:
            for _ in range(2):
                report = import_facilities(connection, ROOT / "data/raw/amap-facilities.json")
                assert report["inserted"] == 0 and report["updated"] == expected
                assert report["quality"]["total"] == expected
                with connection.cursor() as cursor:
                    assert original_hashes(cursor) == originals, "不得修改原始五张业务表"
            with connection.cursor() as cursor:
                cursor.execute("""SELECT ST_X(geom),ST_Y(geom),ST_X(geom_gcj02),ST_Y(geom_gcj02)
                    FROM facility_pois""")
                max_error = max(max(abs(a-b) for a,b in zip(wgs84_to_gcj02(lng,lat),(raw_lng,raw_lat)))
                                for lng,lat,raw_lng,raw_lat in cursor.fetchall())
                assert max_error < 2e-7, max_error
                cursor.execute("SELECT sum(facility_count) FROM facility_grid_counts")
                assert cursor.fetchone()[0] + report["quality"]["without_grid_within_5m"] == expected
        finally:
            connection.rollback()
    print("PASS: 两次重复导入不新增，原五表逐行哈希一致，坐标回转和网格归属核验通过（全部回滚）")

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=port,
                                          log_level="error", lifespan="off"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    session = requests.Session()
    session.trust_env = False
    base = f"http://127.0.0.1:{port}"

    def get(path, **params):
        response = session.get(base + path, params=params, timeout=30)
        response.raise_for_status()
        return response.json()

    try:
        deadline = time.monotonic() + 8
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(.05)
        assert server.started
        data = get("/api/facility-pois")
        assert len(data["features"]) == expected == data["metadata"]["total"]
        assert len({f["properties"]["id"] for f in data["features"]}) == expected
        for feature in data["features"]:
            assert feature["properties"]["coordSystem"] == "WGS84"
            assert feature["properties"]["dataSource"] == "amap-poi"
            assert feature["properties"]["verificationStatus"] == "map_record_only"
        for category in CATEGORIES:
            subset = get("/api/facility-pois", category=category, limit=1)
            assert len(subset["features"]) == 1 and category in subset["features"][0]["properties"]["categories"]
        page = get("/api/facility-pois", limit=2, offset=2)
        assert [f["properties"]["id"] for f in page["features"]] == [f["properties"]["id"] for f in data["features"][2:4]]
        assert page["metadata"]["hasMore"]
        first = data["features"][0]
        lng, lat = first["geometry"]["coordinates"]
        nearby = get("/api/facility-pois", lng=lng, lat=lat, radius=500)
        meters = [f["properties"]["straightDistanceMeters"] for f in nearby["features"]]
        assert meters and meters[0] == 0 and meters == sorted(meters) and max(meters) <= 500.1
        parking = get("/api/facility-pois", category="parking")
        assert all(f["properties"]["candidateStatus"] == "requires_field_check" for f in parking["features"])
        coverage = get("/api/facility-coverage", radius=500)
        for stats in coverage["categories"].values():
            assert stats["count"] == stats["covered"] + stats["uncovered"]
            assert stats["multipleStations"] <= stats["covered"]
        real_stations = get("/api/stations", include_synthetic="false", scope="weidu")
        assert coverage["realStations"] == len(real_stations["features"])
        assert len(coverage["stationNeighbors"]) == len(real_stations["features"])
        grids = get("/api/hex-grid")
        assert len(grids["features"]) == 170
        assert all(isinstance(f["properties"]["officeCount"], int) for f in grids["features"])
        assert sum(f["properties"]["parkingCount"] for f in grids["features"]) <= len(parking["features"])
        for params in ({"category": "unknown"}, {"lng": 113.83}, {"lat": 34},
                       {"lng": "nan", "lat": 34}, {"radius": 0}, {"offset": -1}, {"limit": 0}):
            assert session.get(base + "/api/facility-pois", params=params, timeout=5).status_code == 422
        with closing(get_db_connection()) as connection:
            with connection.cursor() as cursor:
                assert original_hashes(cursor) == originals
        artifact = {"passed": True, "total": expected, "categoryCounts": report["category_counts"],
            "coordinateRoundtripMaxErrorDegrees": max_error, "originalTableHashes": originals,
            "unassignedGrid": report["unassigned_grid"], "coverage": coverage,
            "checks": ["duplicate_import_rolled_back", "original_tables_unchanged", "coordinate_roundtrip",
                "grid_assignment", "all_categories", "pagination", "nearby_sorted_by_distance",
                "parking_requires_field_check", "synthetic_excluded_from_coverage", "invalid_parameters"]}
        (ROOT / "docs/facility-verification.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (ROOT / "data/processed/weidu-facilities.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"PASS: 真实 HTTP 的 {expected} 个设施、12 类筛选、分页、周边距离、选址因子和真实站配套统计")
    finally:
        server.should_exit = True
        thread.join(timeout=8)
        session.close()


if __name__ == "__main__":
    check()
