"""选址公开参考数据：空间要素与证据单独记录，不生成建设合格结论。"""
import json
import math
from collections import Counter
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from shapely.geometry import Point, Polygon, LineString, mapping
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parents[2]
CONTEXT_PATH = ROOT / 'data/processed/weidu-siting-context.geojson'
EVIDENCE_PATH = ROOT / 'data/managed/siting-public-evidence.json'
router = APIRouter(prefix='/api/siting-context', tags=['Siting context'])


def evidence_config():
    return json.loads(EVIDENCE_PATH.read_text(encoding='utf-8'))


def element_geometry(row):
    def coordinates(points):
        values = [[p.get('lon'), p.get('lat')] for p in points if isinstance(p, dict)]
        if len(values) != len(points) or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for pair in values for v in pair):
            return []
        return values if all(abs(lon) <= 180 and abs(lat) <= 90 for lon, lat in values) else []
    if row.get('type') == 'node':
        coords = coordinates([row])
        return Point(coords[0]) if coords else None
    if row.get('type') == 'way':
        coords = coordinates(row.get('geometry', []))
        if len(coords) < 2:
            return None
        geom = Polygon(coords) if len(coords) >= 4 and coords[0] == coords[-1] else LineString(coords)
        return geom if geom.is_valid and not geom.is_empty else None
    if row.get('type') == 'relation' and row.get('tags', {}).get('type') == 'multipolygon':
        rings = {'outer': [], 'inner': []}
        for member in row.get('members', []):
            if member.get('type') != 'way':
                continue
            coords = coordinates(member.get('geometry', []))
            if len(coords) < 2:
                return None  # 不把缺失外环或内环的数据变成完整面。
            role = member.get('role') or 'outer'
            if role in rings:
                rings[role].append(LineString(coords))
        outer = list(polygonize(unary_union(rings['outer'])))
        if not outer:
            return None
        geom = unary_union(outer)
        if rings['inner']:
            inner = list(polygonize(unary_union(rings['inner'])))
            if not inner:
                return None
            geom = geom.difference(unary_union(inner))
        return geom if geom.is_valid and not geom.is_empty else None
    return None


def context_category(tags):
    if tags.get('amenity') == 'parking':
        return 'parking'
    if tags.get('amenity') == 'parking_entrance' or 'entrance' in tags:
        return 'entrance'
    if tags.get('power') in {'substation', 'transformer'}:
        return 'power'
    if tags.get('natural') == 'water':
        return 'water'
    if 'landuse' in tags:
        return 'landuse'
    if tags.get('amenity') in {'fuel', 'fire_station'} or 'emergency' in tags or 'barrier' in tags:
        return 'safety'
    return None


def normalize_context(raw, facilities, border, evidence, audit=None):
    if raw.get('remark') or not isinstance(raw.get('elements'), list):
        raise ValueError('OSM 参考数据不完整')
    features, skipped = [], 0
    for row in raw['elements']:
        tags = row.get('tags', {})
        category = context_category(tags)
        if category is None:
            continue
        geom = element_geometry(row)
        if geom is None:
            skipped += 1
            continue
        if not border.intersects(geom):
            continue
        identifier = f"osm:{row['type']}:{row['id']}"
        properties = {'id': identifier, 'category': category, 'source': 'OpenStreetMap',
            'sourceUrl': f"https://www.openstreetmap.org/{row['type']}/{row['id']}",
            'name': tags.get('name') or tags.get('operator') or '', 'tags': tags,
            'landuse': tags.get('landuse'), 'voltage': tags.get('voltage'),
            'entranceKind': 'parking' if tags.get('amenity') == 'parking_entrance' else 'unspecified',
            'access': tags.get('motorcar') or tags.get('motor_vehicle') or tags.get('access'),
            'observedAt': raw.get('osm3s', {}).get('timestamp_osm_base'),
            'geometryKind': geom.geom_type, 'coordSystem': 'WGS84'}
        capacity = str(tags.get('capacity', ''))
        if category == 'parking' and capacity.isdigit():
            properties.update(capacity=int(capacity), capacityKind='mapped', capacitySourceUrl=properties['sourceUrl'])
        if category not in {'landuse', 'water'} and geom.geom_type != 'Point':
            geom = geom.representative_point()
            properties['positionMethod'] = 'representative-point'
        features.append({'type': 'Feature', 'id': identifier, 'properties': properties, 'geometry': mapping(geom)})
    parking_evidence = {row['amapId']: row for row in evidence.get('parking', [])}
    for row in facilities:
        if 'parking' not in row['categories']:
            continue
        geom = Point(row['lng'], row['lat'])
        if not border.covers(geom):
            continue
        codes = set(row['typecode'].split('|'))
        entrance = bool(codes & {'150907', '150908', '150909'})
        identifier = 'amap:' + row['id']
        p = {'id': identifier, 'category': 'entrance' if entrance else 'parking',
            'source': 'AMap', 'sourceUrl': row['source_url'], 'name': row['name'],
            'address': row['address'], 'typecode': row['typecode'], 'coordSystem': 'WGS84',
            'entranceKind': 'parking' if entrance else None, 'observedAt': str(row['fetched_at']),
            'parkingType': row['raw'].get('parking_type') or None, 'parentId': row['raw'].get('parent') or None}
        known = parking_evidence.get(row['id'])
        if known and row['name'] == known['expectedName'] and not entrance:
            p.update({key: value for key, value in known.items() if key.startswith('capacity')})
        features.append({'type': 'Feature', 'id': identifier, 'geometry': mapping(geom), 'properties': p})
    categories = dict(Counter(f['properties']['category'] for f in features))
    docs = [{key: value for key, value in doc.items() if key != 'file'} | {'url': f"/api/siting-context/documents/{doc['id']}"} for doc in evidence.get('documents', [])]
    return {'type': 'FeatureCollection', 'features': features, 'metadata': {
        'coordSystem': 'WGS84', 'createdAt': datetime.now(timezone.utc).isoformat(),
        'osmBaseTimestamp': raw.get('osm3s', {}).get('timestamp_osm_base'),
        'featureCount': len(features), 'categoryCounts': categories, 'skippedGeometryCount': skipped,
        'attribution': '© OpenStreetMap contributors; 高德地图；许昌公开项目资料',
        'osmLicenseUrl': 'https://www.openstreetmap.org/copyright', 'sourceLinks': evidence.get('sources', []),
        'documents': docs, 'studyArea': '许昌市魏都区', 'evidenceOnly': True,
        'notice': '地图记录与历史公开资料仅用于初筛；不表示场地授权、消防合格或配变余量已核实。',
        'auditCheckedAt': (audit or {}).get('checkedAt')}}


@lru_cache(maxsize=2)
def _read(path, modified):
    return json.loads(Path(path).read_text(encoding='utf-8'))


@router.get('')
def get_context():
    try:
        return _read(str(CONTEXT_PATH), CONTEXT_PATH.stat().st_mtime_ns)
    except FileNotFoundError as failure:
        raise HTTPException(503, '选址公开参考数据尚未导入') from failure


@router.get('/documents/{document_id}')
def get_document(document_id: str):
    doc = next((row for row in evidence_config()['documents'] if row['id'] == document_id), None)
    if not doc:
        raise HTTPException(404, '参考图件不存在')
    path = ROOT / 'data/reference' / doc['file']
    if not path.is_file():
        raise HTTPException(503, '参考图件尚未导入')
    return FileResponse(path, media_type='image/jpeg', content_disposition_type='inline', filename=doc['title']+'.jpg')
