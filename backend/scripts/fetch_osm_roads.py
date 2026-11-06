"""一次采集道路、节点和转向限制；前端只读本地快照，不直接请求 Overpass。"""
import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import requests
from shapely.geometry import shape
from shapely.ops import unary_union

from .osm_roads import ROOT, ROAD_PATH, NETWORK_PATH, normalize_roads


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--boundary-url', default='http://127.0.0.1:8000/api/boundary')
    parser.add_argument('--boundary', type=Path)
    parser.add_argument('--margin-km', type=float, default=2)
    parser.add_argument('--endpoint', default='https://overpass-api.de/api/interpreter')
    args = parser.parse_args()
    if not 0 <= args.margin_km <= 10:
        parser.error('周边范围仅允许 0～10 km')
    session = requests.Session()
    session.headers['User-Agent'] = 'WeiduEV-WebGIS/1.0 (one-off OSM road research snapshot)'
    if args.boundary:
        boundary = json.loads(args.boundary.read_text(encoding='utf-8-sig'))
    else:
        response = session.get(args.boundary_url, timeout=15)
        response.raise_for_status()
        boundary = response.json()
    features = boundary['features'] if boundary.get('type') == 'FeatureCollection' else [boundary]
    border = unary_union([shape(feature.get('geometry', feature)) for feature in features])
    west, south, east, north = border.bounds
    lat_margin = args.margin_km / 111.2
    lon_margin = lat_margin / math.cos(math.radians((south + north) / 2))
    bbox = [south - lat_margin, west - lon_margin, north + lat_margin, east + lon_margin]
    bounds = ','.join(f'{value:.7f}' for value in bbox)
    query = f'''[out:json][timeout:120];(
way["highway"]["area"!="yes"]({bounds});
relation["type"="restriction"]({bounds});
node["barrier"]({bounds});
node["highway"~"^(traffic_signals|stop|give_way|crossing)$"]({bounds});
);out meta geom;'''
    print(f'Fetching OSM roads for study area + {args.margin_km:g} km context...', flush=True)
    response = session.post(args.endpoint, data={'data': query}, timeout=(15, 150))
    response.raise_for_status()
    raw = response.json()
    fetched_at = datetime.now(timezone.utc).isoformat()
    roads, network = normalize_roads(raw, {'fetchedAt': fetched_at, 'endpoint': args.endpoint,
                                         'bboxSouthWestNorthEast': bbox, 'contextMarginKm': args.margin_km,
                                         'studyArea': '许昌市魏都区', 'query': query}, border)
    # 完整通过转换后才发布，失败不会覆盖已存在的数据。
    for path, value in [(ROOT / 'data/raw/osm-roads-overpass.json', raw), (ROAD_PATH, roads), (NETWORK_PATH, network)]:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + '.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        temporary.replace(path)
    print(json.dumps({key: roads['metadata'][key] for key in ['roadCount', 'nodeCount', 'directedEdgeCount', 'restrictionCount', 'lengthKm', 'fetchedAt']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
