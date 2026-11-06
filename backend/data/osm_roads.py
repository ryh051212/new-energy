"""OSM 道路快照与拓扑；保留原始标签，不把图形交叉误当作道路连通。"""
import json
import math
from collections import Counter
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException

ROOT = Path(__file__).resolve().parents[2]
ROAD_PATH = ROOT / 'data/processed/weidu-osm-roads.geojson'
NETWORK_PATH = ROOT / 'data/processed/weidu-osm-road-network.json'
router = APIRouter(prefix='/api/osm-roads', tags=['OSM roads'])
ATTRIBUTION = '© OpenStreetMap contributors'
LICENSE_URL = 'https://www.openstreetmap.org/copyright'
MOTOR_ROADS = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
               'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
               'unclassified', 'living_street', 'service', 'road', 'track'}


def length_m(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    lat, lon = lat2 - lat1, math.radians(b[0] - a[0])
    h = math.sin(lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(lon / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def road_direction(tags):
    value = tags.get('oneway', '').lower()
    if value in {'yes', '1', 'true'}:
        return 'forward'
    if value == '-1':
        return 'reverse'
    if value in {'no', '0', 'false'}:
        return 'both'
    if value:
        return 'conditional-or-unknown'
    return 'forward' if tags.get('junction') in {'roundabout', 'circular'} or tags.get('highway') == 'motorway' else 'both'


def motor_access(tags):
    # 特定交通方式的限制覆盖一般 access；不把 private/destination 当作公共通行。
    value = next((tags[key] for key in ['motorcar', 'motor_vehicle', 'vehicle', 'access'] if key in tags), None)
    if tags.get('highway') in {'construction', 'proposed'} or value in {'no', 'agricultural', 'forestry', 'emergency'}:
        return 'prohibited'
    if value in {'private', 'destination', 'customers', 'delivery', 'permit'}:
        return 'restricted'
    if value in {'yes', 'permissive', 'designated', 'official'}:
        return 'allowed'
    return 'unspecified'


def normalize_roads(raw, metadata, boundary=None):
    if raw.get('remark') or not isinstance(raw.get('elements'), list):
        raise ValueError('Overpass 返回错误或不完整数据，保留原快照')
    features, nodes, edges, restrictions = [], {}, [], []
    skipped, seen = 0, set()
    tagged_nodes = {str(row['id']): row.get('tags', {}) for row in raw['elements'] if row.get('type') == 'node'}
    for row in raw['elements']:
        if row.get('type') == 'relation' and row.get('tags', {}).get('type') == 'restriction':
            restrictions.append({'osmId': row['id'], 'tags': row.get('tags', {}),
                                 'members': [{key: member[key] for key in ['type', 'ref', 'role'] if key in member} for member in row.get('members', [])]})
        tags = row.get('tags', {})
        if row.get('type') != 'way' or 'highway' not in tags or row['id'] in seen:
            continue
        geometry, ids = row.get('geometry', []), row.get('nodes', [])
        if len(geometry) < 2 or len(ids) != len(geometry) or any(not p or not all(isinstance(p.get(key), (int, float)) and math.isfinite(p[key]) for key in ['lon', 'lat']) or abs(p['lon']) > 180 or abs(p['lat']) > 90 for p in geometry):
            skipped += 1
            continue
        coords = [[p['lon'], p['lat']] for p in geometry]
        seen.add(row['id'])
        direction, access = road_direction(tags), motor_access(tags)
        properties = {'osmId': row['id'], 'osmType': 'way', 'name': tags.get('name') or tags.get('ref') or '',
                      'highway': tags['highway'], 'direction': direction, 'motorAccess': access,
                      'motorVehicleCandidate': tags['highway'] in MOTOR_ROADS and access != 'prohibited',
                      'lengthM': round(sum(length_m(a, b) for a, b in zip(coords, coords[1:])), 2),
                      'nodeIds': ids, 'tags': tags, 'osmUpdatedAt': row.get('timestamp')}
        for key in ['oneway', 'lanes', 'maxspeed', 'surface', 'width', 'access', 'motor_vehicle', 'motorcar', 'bridge', 'tunnel', 'layer', 'junction', 'service']:
            properties[key] = tags.get(key)
        if boundary is not None:
            from shapely.geometry import LineString
            properties['intersectsStudyArea'] = boundary.intersects(LineString(coords))
        features.append({'type': 'Feature', 'id': row['id'], 'geometry': {'type': 'LineString', 'coordinates': coords}, 'properties': properties})
        for node_id, coordinate in zip(ids, coords):
            nodes[str(node_id)] = {'id': node_id, 'coordinates': coordinate, 'tags': tagged_nodes.get(str(node_id), {})}
        for index, (a, b) in enumerate(zip(coords, coords[1:])):
            if ids[index] == ids[index + 1] or a == b:
                continue
            directions = [(ids[index], ids[index + 1])] if direction == 'forward' else [(ids[index + 1], ids[index])] if direction == 'reverse' else [(ids[index], ids[index + 1]), (ids[index + 1], ids[index])]
            for branch, (start, end) in enumerate(directions):
                edges.append({'id': f"{row['id']}:{index}:{branch}", 'from': start, 'to': end, 'osmWayId': row['id'],
                              'lengthM': round(length_m(a, b), 3), 'highway': tags['highway'],
                              'motorAccess': access, 'motorVehicleCandidate':properties['motorVehicleCandidate'],
                              'directionKnown': direction != 'conditional-or-unknown' and not any(key.startswith('oneway:') for key in tags)})
    if not features:
        raise ValueError('没有有效道路数据，保留原快照')
    info = {**metadata, 'coordSystem': 'WGS84', 'source': 'OpenStreetMap', 'license': 'ODbL-1.0',
            'attribution': ATTRIBUTION, 'licenseUrl': LICENSE_URL, 'osmBaseTimestamp': raw.get('osm3s', {}).get('timestamp_osm_base'),
            'roadCount': len(features), 'nodeCount': len(nodes), 'directedEdgeCount': len(edges),
            'restrictionCount': len(restrictions), 'skippedWayCount': skipped,
            'roadTypes': dict(Counter(feature['properties']['highway'] for feature in features)),
            'lengthKm': round(sum(feature['properties']['lengthM'] for feature in features) / 1000, 3),
            'topology': 'shared OSM node IDs; geometry crossings are not merged',
            'turnRestrictionsApplied': False, 'routingReady': False}
    return {'type': 'FeatureCollection', 'metadata': info, 'features': features}, {'metadata': info, 'nodes': list(nodes.values()), 'edges': edges, 'turnRestrictions': restrictions}


@lru_cache(maxsize=4)
def _read_snapshot(path, modified):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def read_snapshot(path):
    try:
        return _read_snapshot(str(path), path.stat().st_mtime_ns)
    except FileNotFoundError as failure:
        raise HTTPException(503, 'OSM 道路尚未采集，请运行 python -m backend.fetch_osm_roads') from failure


@router.get('')
def roads():
    return read_snapshot(ROAD_PATH)


@router.get('/metadata')
def road_metadata():
    return read_snapshot(ROAD_PATH)['metadata']


@router.get('/network')
def road_network():
    return read_snapshot(NETWORK_PATH)
