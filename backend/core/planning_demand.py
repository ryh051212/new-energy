"""Shared planning demand contract; matches functionalZones.js, without inferred orders."""
import math
from shapely.geometry import shape, Point

SCENARIOS = {
    'weekday-day': dict(residential=.35, work=1, shopping=.55, leisure=.35, public=.75),
    'weekday-night': dict(residential=1, work=.15, shopping=.8, leisure=.8, public=.45),
    'weekend': dict(residential=.7, work=.25, shopping=1, leisure=1, public=.65),
}
ACTIVITIES = tuple(SCENARIOS['weekday-day'])
FIELDS = {'residential': ['populationModelCount'], 'work': ['workplaceCount'],
          'shopping': ['shoppingCount', 'commercialCount'], 'leisure': ['leisureCount', 'activityCount'],
          'public': ['publicServiceCount']}
LABELS = {'residential': '人口', 'work': '工作', 'shopping': '购物', 'leisure': '休闲', 'public': '公共服务与交通', 'mixed': '混合功能', 'unknown': '资料不足'}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def activities(poi):
    p = poi.get('properties', {})
    categories = set(p.get('categories') or [p.get('category')])
    groups = {'residential': {'residential'}, 'work': {'work', 'office', 'company', 'industrial_park'},
              'shopping': {'commercial', 'mall', 'supermarket', 'shopping', 'restaurant'},
              'leisure': {'park', 'leisure'}, 'public': {'public_service','hospital', 'school', 'transport','parking','government_transport'}}
    return [key for key, values in groups.items() if categories & values]


def merge_pois(pois):
    result = {}
    for feature in pois:
        if feature.get('geometry', {}).get('type') != 'Point' or not activities(feature):
            continue
        p = feature['properties']
        key = str(p.get('id', (feature['geometry']['coordinates'], p.get('name'))))
        previous = result.get(key, {}).get('properties', {})
        categories = list(dict.fromkeys((previous.get('categories') or []) + (p.get('categories') or [p.get('category')])))
        result[key] = {**feature, 'properties': {**previous, **p, 'categories': [c for c in categories if c]}}
    return list(result.values())


def demand_model(grids, pois, scenario_id='weekday-day', weights=None, overrides=None):
    weights = {key: (weights or {}).get(key, 1) for key in ACTIVITIES}
    rows = []
    for feature in grids:
        p = {**feature['properties'], **(overrides or {}).get(str(feature['properties']['id']), {})}
        counts = {key: next((p[f] for f in fields if number(p.get(f))), None) for key, fields in FIELDS.items()}
        if counts['public'] is None and number(p.get('hospitalCount')) and number(p.get('schoolCount')):
            counts['public'] = p['hospitalCount'] + p['schoolCount']
        rows.append((feature, p, counts))
    maxima = {k: max((c[k] or 0 for _, _, c in rows), default=0) for k in ACTIVITIES}
    intensities = [{k: None if c[k] is None else c[k] / maxima[k] if maxima[k] else 0 for k in ACTIVITIES} for _, _, c in rows]
    # Fixed across time scenarios and activity-weight experiments.
    scale = max((sum(v or 0 for v in row.values()) for row in intensities), default=0)
    output, polygons = [], []
    for (feature, p, counts), intensity in zip(rows, intensities):
        contributions = {k: None if intensity[k] is None else intensity[k] * weights[k] * SCENARIOS[scenario_id][k] / scale if scale else 0 for k in ACTIVITIES}
        known = any(v is not None for v in contributions.values())
        total = sum(v or 0 for v in intensity.values())
        dominant = max(ACTIVITIES, key=lambda k: intensity[k] or 0)
        zone = 'unknown' if not total else dominant if (intensity[dominant] or 0) / total >= .5 else 'mixed'
        output.append({**feature, 'properties': {**p, 'scenarioDemandIndex': sum(v or 0 for v in contributions.values()) if known else None,
            'scenarioActivityDemand': contributions, 'functionalZone': zone, 'functionalZoneLabel': LABELS[zone],
            'activityCompleteness': sum(v is not None for v in counts.values()), 'demandScenario': scenario_id}})
        polygons.append(shape(feature['geometry']))
    buckets = [[] for _ in output]
    # Stable grid assignment on shared boundaries.
    order = sorted(range(len(output)), key=lambda i: (len(str(output[i]['properties']['id'])), str(output[i]['properties']['id'])))
    for poi in merge_pois(pois):
        pos = Point(poi['geometry']['coordinates'])
        for i in order:
            if polygons[i].covers(pos):
                buckets[i].append(poi)
                break
    locations = []
    for i, feature in enumerate(output):
        for activity, weight in feature['properties']['scenarioActivityDemand'].items():
            if not weight:
                continue
            matching = [] if activity == 'residential' else [p for p in buckets[i] if activity in activities(p)]
            positions = matching or [{'type': 'Feature', 'geometry': polygons[i].representative_point().__geo_interface__,
                'properties': {'name': f"网格 #{feature['properties']['id']} 估计点"}}]
            for j, poi in enumerate(positions):
                locations.append({'feature': poi, 'gridId': str(feature['properties']['id']), 'activity': activity,
                    'id': f"{feature['properties']['id']}:{activity}:{j}", 'weight': weight / len(positions), 'fallback': not bool(matching)})
    return output, locations
