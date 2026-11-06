"""Authenticated, read-only planning API. No writes to the station database."""
import copy
import json
import time
from pathlib import Path
from threading import RLock
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict, model_validator
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from .auth import require_session
from ..data.osm_roads import ROAD_PATH, NETWORK_PATH, read_snapshot
from ..core.siting_context import CONTEXT_PATH
from ..core.planning_network import RoadNetwork, digest
from ..core.planning_engine import PlanningStudy
from ..core.planning_demand import ACTIVITIES
from ..core.local_siting import local_candidates

router = APIRouter(prefix='/api/planning', tags=['Road planning'], dependencies=[Depends(require_session)])
ROOT = Path(__file__).resolve().parents[1]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Capacity(StrictModel):
    pileCount: int = Field(1, ge=1, le=1000, strict=True)
    powerKw: float = Field(60, gt=0, le=1000)


class Constraints(StrictModel):
    radius: float = Field(0, ge=0, le=3000)
    minimumSpaces: int = Field(0, ge=0, le=10000, strict=True)
    powerFactor: float = Field(.9, gt=0, le=1)


class Geometry(StrictModel):
    type: Literal['Point'] = 'Point'
    coordinates: tuple[float, float]

    @model_validator(mode='after')
    def valid(self):
        if not -180 <= self.coordinates[0] <= 180 or not -90 <= self.coordinates[1] <= 90:
            raise ValueError('点位坐标无效')
        return self


class Site(BaseModel):
    model_config = ConfigDict(extra='ignore', allow_inf_nan=False)
    type: Literal['Feature'] = 'Feature'
    geometry: Geometry
    properties: dict = Field(default_factory=dict)

    @model_validator(mode='after')
    def valid(self):
        p = self.properties
        if not isinstance(p.get('id'), (str, int)) or isinstance(p.get('id'), bool):
            raise ValueError('站点须有稳定编号')
        Capacity(pileCount=p.get('pileCount', 1), powerKw=p.get('powerKw', 60))
        if len(str(p.get('name', ''))) > 160:
            raise ValueError('站点名称过长')
        return self


class PlanningRequest(StrictModel):
    scenarioId: Literal['weekday-day', 'weekday-night', 'weekend'] = 'weekday-day'
    activityWeights: dict[str, float] = Field(default_factory=lambda: {k: 1 for k in ACTIVITIES})
    dataScope: Literal['recorded', 'all'] = 'recorded'
    thresholdMinutes: float = Field(10, ge=1, le=60)
    capacityScenario: Capacity = Field(default_factory=Capacity)
    constraints: Constraints = Field(default_factory=Constraints)
    additions: list[Site] = Field(default_factory=list, max_length=50)
    removedIds: list[str] = Field(default_factory=list, max_length=2000)
    manualCandidates: list[Site] = Field(default_factory=list, max_length=50)
    factors: dict[str, dict] = Field(default_factory=dict, max_length=2000)
    baselineKey: str | None = Field(None, max_length=64)
    method: Literal['mclp', 'kmeans', 'demand'] = 'mclp'
    requestedCount: int = Field(5, ge=1, le=20, strict=True)
    experimentType: Literal['methods', 'counts', 'thresholds', 'scenarios', 'weights'] = 'methods'
    experimentMode: Literal['reoptimize', 'fixed'] = 'reoptimize'

    @model_validator(mode='after')
    def valid(self):
        if set(self.activityWeights) - set(ACTIVITIES) or any(not 0 <= v <= 5 for v in self.activityWeights.values()):
            raise ValueError('活动权重仅接受五类活动的 0～5 情景系数')
        numeric_fields = {'officeCount','workplaceCount','shoppingCount','commercialCount','leisureCount','activityCount','publicServiceCount','hospitalCount','schoolCount','parkingCount','parkingSpaces','availableKva','roadIndex'}
        bool_fields = {'sitePermission','roadAccess','fireSafety','buildable','constructionAllowed','noBuild'}
        for values in self.factors.values():
            for key, value in values.items():
                if key in bool_fields and isinstance(value, bool):
                    continue
                if key in numeric_fields and isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1000000:
                    continue
                if key == 'constructionEvidence' and isinstance(value, str) and len(value) <= 300:
                    continue
                raise ValueError('建设与活动补充资料无效')
        return self


_cache = {'at': 0, 'dataset': None, 'network': None, 'files': None}
_lock = RLock()


def load_data():
    # Reuse the existing PostGIS serializers, with explicit arguments (never Query objects).
    from . import main
    signature = [(str(p), p.stat().st_mtime_ns if p.exists() else None) for p in [ROAD_PATH, NETWORK_PATH, CONTEXT_PATH]]
    with _lock:
        if _cache['dataset'] is not None and time.monotonic() - _cache['at'] < 30 and signature == _cache['files']:
            return _cache['dataset'], _cache['network']
        boundary = mapping(unary_union([shape(f['geometry']) for f in main.get_boundary()['features']]))
        grids = main.get_hex_grid()['features']
        from .baseline_data import population as population_data
        try:
            population_by_id = {str(f['properties']['id']): f['properties'].get('populationModelCount')
                                for f in population_data()['features']}
        except HTTPException:
            population_by_id = {}
        for grid in grids:
            grid['properties']['populationModelCount'] = population_by_id.get(str(grid['properties']['id']))
        # Boundary context may serve district demand; scope-review facilities
        # (trucks, swapping, buses, etc.) are not default private-car supply.
        stations = [f for f in main.get_stations('', False, 'all')['features'] if not f['properties'].get('scopeReviewFlags')]
        residential = main.get_residential_pois()['features']
        commercial = main.get_commercial_pois()['features']
        for f in residential:
            f['properties']['category'] = 'residential'
        for f in commercial:
            f['properties']['category'] = 'commercial'
        facilities = main.get_facility_pois(None, '', 10000, 0, None, None, 500)
        if facilities.get('metadata', {}).get('hasMore') or facilities.get('metadata', {}).get('initialized') is False:
            raise HTTPException(503, '设施候选目录尚未完整加载')
        context = read_snapshot(CONTEXT_PATH)['features']
        sites = []
        for source, features in [('catalog', facilities['features']), ('context', context)]:
            for feature in features:
                p = feature['properties']
                categories = p.get('categories') or [p.get('category')]
                if 'parking' in categories or p.get('buildable') is True or p.get('constructionAllowed') is True:
                    sites.append({**feature, 'properties': {**p, 'id': source + ':' + str(p.get('id', digest(feature)))}})
        dataset = {'boundary': boundary, 'grids': grids, 'stations': stations, 'includeBoundaryStationContext':True, 'pois': residential + commercial + facilities['features'], 'sites': sites, 'context': context}
        obstacles = [f['geometry'] for f in context if f['geometry']['type'] in {'Polygon','MultiPolygon'} and (f['properties'].get('category') == 'water' or f['properties'].get('noBuild') is True or f['properties'].get('constructionAllowed') is False)]
        road_data, graph = read_snapshot(ROAD_PATH), read_snapshot(NETWORK_PATH)
        network = _cache['network']
        if network is None or signature != _cache['files']:
            network = RoadNetwork(graph, road_data, obstacles)
        _cache.update(at=time.monotonic(), dataset=dataset, network=network, files=signature)
        return dataset, network


def study(request):
    data, network = load_data()
    return PlanningStudy(data, network, request.model_dump(mode='json'))


def run(request, operation):
    try:
        engine = study(request)
        return operation(engine)
    except ValueError as error:
        raise HTTPException(409 if '版本' in str(error) else 422, str(error)) from error


@router.post('/analyze')
def analyze(request: PlanningRequest):
    return run(request, lambda engine: engine.analysis())


class LocalSitingRequest(PlanningRequest):
    center: tuple[float, float]
    radiusMeters: float = Field(1000, ge=100, le=3000)
    waterSetbackMeters: float = Field(20, ge=0, le=200)
    fuelSetbackMeters: float = Field(50, ge=0, le=300)
    candidateId: str | None = Field(None, max_length=100)

    @model_validator(mode='after')
    def valid_center(self):
        if not -180 <= self.center[0] <= 180 or not -90 <= self.center[1] <= 90:
            raise ValueError('搜索中心坐标无效')
        return self


@router.post('/local-candidates')
def nearby_sites(request: LocalSitingRequest):
    return run(request, lambda engine: local_candidates(engine, request.center, request.radiusMeters,
        request.waterSetbackMeters, request.fuelSetbackMeters))


@router.post('/local-candidates/confirm')
def confirm_nearby_site(request: LocalSitingRequest):
    def confirm(engine):
        result = local_candidates(engine, request.center, request.radiusMeters,
            request.waterSetbackMeters, request.fuelSetbackMeters)
        feature = next((f for f in result['features'] if f['properties']['id'] == request.candidateId), None)
        if feature is None:
            raise ValueError('该场地已不符合当前范围或约束，请重新筛选')
        return feature
    return run(request, confirm)


@router.post('/optimize')
def optimize(request: PlanningRequest):
    return run(request, lambda engine: engine.optimize())


@router.post('/experiments')
def experiments(request: PlanningRequest):
    def execute(engine):
        base = request.model_dump(mode='json')
        kind, mode = request.experimentType, request.experimentMode
        variations = ({'methods': [('method', m) for m in ['demand','kmeans','mclp']],
            'counts': [('requestedCount', n) for n in [3,5,8]], 'thresholds': [('thresholdMinutes', n) for n in [5,10,15]],
            'scenarios': [('scenarioId', s) for s in ['weekday-day','weekday-night','weekend']],
            'weights': [('activityWeights', {**base['activityWeights'], 'residential': v}) for v in [.8,1,1.2]]})[kind]
        # One common candidate universe for all variants, even if a demand scenario changes.
        candidates = engine.candidates
        fixed = base['additions'] or engine.optimize()['selectedStations']['features'] if mode == 'fixed' else None
        rows = []
        for key, value in variations:
            options = {**copy.deepcopy(base), key: value}
            current = PlanningStudy(engine.data, engine.network, options)
            current.candidates = copy.deepcopy(candidates)
            result = current.analysis(fixed, base['removedIds']) if fixed is not None else current.optimize()
            selected_count = len(result['selectedStations']['features'])
            rows.append({'label': str(value) if key != 'activityWeights' else '居住权重 ' + str(value['residential']),
                'parameters': options, 'before': result['before'], 'after': result['after'], 'changes': result['changes'],
                'selectedStations': result['selectedStations'], 'selection': result['selection'],
                'selectedCount': selected_count, 'comparable': selected_count == options['requestedCount'] and not base['removedIds'],
                'versions': result['versions']})
        counts = {}
        for row in rows:
            for feature in row['selectedStations']['features']:
                key = str(feature['properties']['id'])
                entry = counts.setdefault(key, {'id': key, 'name': feature['properties'].get('name'), 'frequency': 0})
                entry['frequency'] += 1
        reference_ids = {str(f['properties']['id']) for f in rows[0]['selectedStations']['features']} if rows else set()
        for row in rows:
            ids = {str(f['properties']['id']) for f in row['selectedStations']['features']}
            row['overlapWithFirst'] = len(ids & reference_ids) / len(ids | reference_ids) if ids | reference_ids else None
        return {'modelVersion': 'road-planning-v1', 'baselineKey': engine.baseline_key, 'experimentType': kind, 'experimentMode': mode,
            'candidateVersion': digest(candidates), 'rows': rows, 'stability': sorted(counts.values(), key=lambda r: (-r['frequency'], r['id']))}
    return run(request, execute)
