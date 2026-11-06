"""验证当前演示批次、重复导入、真实替换及真实 HTTP；数据库测试全部回滚。"""

import json
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen

from backend.database import get_db_connection
from backend.station_catalog import ROOT, DEMO_DATASET, read_catalog, sync_catalog


def main():
    rows = read_catalog(ROOT / 'data/managed/xuchang-stations.csv')
    with closing(get_db_connection()) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM stations WHERE status<>'retired'")
            before = cursor.fetchone()[0]
            cursor.execute("SELECT id,name,address,ST_AsEWKT(geom) FROM stations WHERE NOT is_synthetic ORDER BY id")
            originals = cursor.fetchall()
        try:
            report = sync_catalog(connection, rows)
            assert report['inserted'] == 0 and report['updated'] == len(rows)
            assert report['active_stations'] == before
            with connection.cursor() as cursor:
                cursor.execute("SELECT id,name,address,ST_AsEWKT(geom) FROM stations WHERE NOT is_synthetic ORDER BY id")
                assert cursor.fetchall() == originals
                cursor.execute("SELECT count(*) FROM stations WHERE NOT ST_Equals(geom,geom_wgs84) OR ST_SRID(geom)<>4326 OR ST_SRID(geom_gcj02)<>0")
                assert cursor.fetchone()[0] == 0
            connection.rollback()
            replacement = {**rows[0], 'isSynthetic': False, 'dataSource': 'verification-survey',
                           'datasetId': 'replacement-check', 'name': '真实数据替换流程测试'}
            replaced = sync_catalog(connection, [replacement], retire_demo=True)
            assert replaced['synthetic_stations'] == 0
            assert replaced['retired_demo'] == len(rows) - 1
            assert replaced['active_stations'] == len(originals) + 1
        finally:
            connection.rollback()
    print('PASS: repeat import, original preservation, WGS84/GCJ-02 and real replacement (rolled back)')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'backend.main:app',
            '--host', '127.0.0.1', '--port', str(port)], cwd=ROOT, stdout=log, stderr=log,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            for _ in range(100):
                try:
                    with urlopen(base + '/api/stations', timeout=3) as response:
                        data = json.load(response)
                    break
                except (URLError, TimeoutError):
                    if process.poll() is not None:
                        raise RuntimeError('临时 API 启动失败')
                    time.sleep(.1)
            else:
                raise RuntimeError('临时 API 启动超时')
            assert len(data['features']) == before
            assert data['metadata']['syntheticCount'] == len(rows)
            synthetic = [feature for feature in data['features'] if feature['properties']['isSynthetic']]
            for feature in synthetic:
                p = feature['properties']
                assert p['totalCount'] == p['fastCount'] + p['regularCount']
                assert p['availableCount'] <= p['totalCount']
                assert p['coordSystem'] == 'WGS84' and p['dataSource'] == 'synthetic'
                assert p['datasetId'] == DEMO_DATASET
            for path, expected in [('/api/stations?include_synthetic=false', len(originals)),
                                   ('/api/stations?scope=weidu', report['grid_analysis']['stations']),
                                   ('/api/stations?name=' + quote(rows[0]['name']), 1)]:
                with urlopen(base + path, timeout=5) as response:
                    assert len(json.load(response)['features']) == expected
            with urlopen(base + '/api/hex-grid', timeout=5) as response:
                grid = json.load(response)
                assert sum(feature['properties']['stationCount'] for feature in grid['features']) == report['grid_analysis']['stations']
            try:
                urlopen(base + '/api/stations?scope=invalid', timeout=5)
            except HTTPError as error:
                assert error.code == 422
            else:
                raise AssertionError('无效 scope 没有被拒绝')
            print(f"PASS: HTTP {before} stations, {len(rows)} synthetic, {report['grid_analysis']['stations']} inside Weidu; filters and grid agree")
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    main()
