"""Local parking/site screening. Thresholds are scenario assumptions, not permits."""
import copy
from collections import Counter
from shapely.geometry import Point, shape, mapping
from shapely.ops import transform
from .planning_network import RX, RY, meters, digest
from .planning_engine import coords, restricted

CONSERVATIVE_LAND = {'forest', 'farmland', 'orchard', 'allotments', 'plant_nursery',
                     'cemetery', 'military', 'railway', 'recreation_ground', 'village_green'}


def metric_geometry(geometry):
    return transform(lambda x, y, z=None: (x * RX, y * RY), shape(geometry))


def local_candidates(engine, center, radius, water_setback=20, fuel_setback=50):
    if not engine.boundary.covers(Point(center)):
        raise ValueError('搜索中心须位于魏都区范围内')
    context = [(f['properties'], shape(f['geometry']), metric_geometry(f['geometry']))
               for f in engine.data.get('context', [])]
    excluded, candidates, seen = Counter(), [], []
    existing = [s for s in engine.stations if str(s['properties']['id']) not in engine.options['removedIds']]
    draft = engine.options['additions']
    considered = 0
    for original in engine.data.get('sites', []):
        p = original.get('properties', {})
        entrance_codes = set(str(p.get('typecode') or '').split('|')) & {'150907', '150908', '150909'}
        if entrance_codes or p.get('category') == 'entrance' or p.get('entranceKind') == 'parking' or (p.get('tags') or {}).get('amenity') == 'parking_entrance':
            continue
        feature = copy.deepcopy(original)
        if feature['geometry']['type'] != 'Point':
            feature['geometry'] = mapping(shape(feature['geometry']).representative_point())
        c = coords(feature)
        gap = meters(c, center)
        if gap > radius:
            continue
        if any(meters(c, previous) < 10 for previous in seen):
            continue
        seen.append(c)
        considered += 1
        feature['properties'] = {**p, **engine.options['capacityScenario'], 'chargeType': 'fast',
            'id': 'local-' + digest([p.get('id'), c]), 'name': (p.get('name') or '停车场候选')[:60],
            'planningSource': 'local-buffer', 'feasibility': 'pending'}
        grid, reason = engine.check_site(feature)
        if reason:
            excluded[reason] += 1
            continue
        location, metric = Point(c), Point(c[0] * RX, c[1] * RY)
        land, warnings = [], []
        for cp, geometry, projected in context:
            if cp.get('category') == 'water' and projected.distance(metric) <= water_setback:
                reason = '水域及水边情景退让范围'
                break
            if (cp.get('tags') or {}).get('amenity') == 'fuel' and projected.distance(metric) <= fuel_setback:
                reason = '加油设施情景避让范围'
                break
            if cp.get('category') == 'landuse' and geometry.covers(location):
                value = cp.get('landuse') or (cp.get('tags') or {}).get('landuse')
                land.append(value)
                if value in CONSERVATIVE_LAND and p.get('sitePermission') is not True:
                    reason = '绿地、农业或特殊用地，缺少建设许可依据'
                    break
        if reason:
            excluded[reason] += 1
            continue
        snap = engine.network.snap(c)
        if snap is None:
            excluded['200 米内无可连接机动车道路，或连接跨越障碍'] += 1
            continue
        if all(edge['highway'].removesuffix('_link') in {'motorway', 'trunk'} for edge, _ in snap['branches']):
            excluded['仅邻接快速道路，缺少可用地方道路出入口'] += 1
            continue
        if any(meters(c, coords(s)) < max(5, engine.options['constraints']['radius']) for s in existing + draft):
            excluded['与现有或方案站点重叠，或不满足设置的站间距'] += 1
            continue
        if not engine.group_feasible([*draft, feature]):
            excluded['同网格方案累计泊位或配变余量不足'] += 1
            continue
        if any(edge.get('motorAccess') == 'unspecified' for edge, _ in snap['branches']):
            warnings.append('道路未标注通行权限，现场核查出入口')
        if not land:
            warnings.append('用地类型未覆盖，需补充用地资料')
        if any(value in {'industrial', 'construction'} for value in land):
            warnings.append('工业或施工用地，需核查环境及场地状态')
        warnings.append('权属、消防、可用泊位与配变余量未完成现场核查')
        nearest = min((meters(c, coords(s)) for s in existing), default=None)
        # Explicit preference order; no opaque suitability score.
        feature['properties'].update(gridId=grid['properties']['id'], distanceMeters=round(gap),
            roadGapMeters=round(snap['gap']), roadAnchor=list(snap['anchor']),
            nearestStationMeters=round(nearest) if nearest is not None else None,
            landuse=land, warnings=warnings, source=p.get('source'), sourceUrl=p.get('sourceUrl'),
            checks=['已有停车/场地记录', '区界及已知禁建核查', '水域与加油设施避让', '机动车道路连接核查'])
        candidates.append(feature)
    candidates.sort(key=lambda f: (f['properties']['distanceMeters'], f['properties']['roadGapMeters'], f['properties']['id']))
    for rank, feature in enumerate(candidates, 1):
        feature['properties']['rank'] = rank
    return {'type': 'FeatureCollection', 'features': candidates[:12], 'metadata': {
        'center': list(center), 'radiusMeters': radius, 'considered': considered, 'eligible': len(candidates),
        'excluded': dict(excluded), 'waterSetbackMeters': water_setback, 'fuelSetbackMeters': fuel_setback,
        'order': '中心距离优先，再比较道路连接距离；最多显示 12 处',
        'basis': '已有场地初筛，非施工许可；道路连接线不代表已存在出入口',
        'version': digest([engine.baseline_key, center, radius, water_setback, fuel_setback, engine.options])}}
