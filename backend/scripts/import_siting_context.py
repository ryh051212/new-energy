"""从已采集的本地公开资料生成选址参考快照，不写入建设合格字段。"""
import argparse
import json
from pathlib import Path
import requests
from shapely.geometry import shape
from shapely.ops import unary_union
from .facility_catalog import read_facilities
from .siting_context import ROOT, CONTEXT_PATH, normalize_context, evidence_config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--boundary', type=Path)
    args = parser.parse_args()
    if args.boundary:
        boundary = json.loads(args.boundary.read_text(encoding='utf-8-sig'))
    else:
        response = requests.get('http://127.0.0.1:8000/api/boundary', timeout=15)
        response.raise_for_status()
        boundary = response.json()
    borders = boundary['features'] if boundary.get('type') == 'FeatureCollection' else [boundary]
    border = unary_union([shape(row.get('geometry', row)) for row in borders])
    raw = json.loads((ROOT / 'data/raw/osm-siting-elements-overpass.json').read_text(encoding='utf-8'))
    facilities, _ = read_facilities(ROOT / 'data/raw/amap-facilities.json')
    data = normalize_context(raw, facilities, border, evidence_config())
    temporary = CONTEXT_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(CONTEXT_PATH)
    print(json.dumps(data['metadata'], ensure_ascii=False))


if __name__ == '__main__':
    main()
