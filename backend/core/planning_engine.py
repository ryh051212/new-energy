"""Reproducible station-level coverage, time G2SFCA, and joint greedy siting."""
import copy
import math
import random
from shapely.geometry import Point, shape, mapping
from .planning_demand import demand_model, number, ACTIVITIES
from .planning_network import digest, meters

MODEL = 'road-planning-v1'


def collection(features):
    return {'type': 'FeatureCollection', 'features': features}


def fid(feature):
    return str(feature.get('properties', {}).get('id'))


def coords(feature):
    return feature['geometry']['coordinates']


def blocked(p):
    return p.get('status') in {'closed', 'inactive', 'offline', 'retired'} or p.get('accessAllowed') is False


def restricted(p):
    return p.get('buildable') is False or p.get('constructionAllowed') is False or p.get('noBuild') is True or any(p.get(k) is False for k in ['sitePermission', 'roadAccess', 'fireSafety'])


def weighted_gini(values, weights):
    total, weighted = sum(weights), sum(a * w for a, w in zip(values, weights))
    if not total or not weighted:
        return None
    cumulative_w = cumulative_a = numerator = 0
    for a, w in sorted(zip(values, weights)):
        numerator += w * (a * cumulative_w - cumulative_a)
        cumulative_w += w
        cumulative_a += a * w
    return numerator / (total * weighted)


class PlanningStudy:
    def __init__(self, dataset, network, options):
        self.data, self.network, self.options = dataset, network, options
        self.boundary = shape(dataset['boundary'])
        self.baseline_key = digest([MODEL, dataset, network.version])
        if options.get('baselineKey') and options['baselineKey'] != self.baseline_key:
            raise ValueError('研究数据版本已变化，请重新计算；不能直接还原旧版本结果')
        self.grids, self.locations = demand_model(dataset['grids'], dataset['pois'], options['scenarioId'], options.get('activityWeights'), options.get('factors'))
        self.polygons = [shape(g['geometry']) for g in self.grids]
        self.site_grid_cache = {}
        self.restricted_polygons = [shape(f['geometry']) for f in dataset.get('context', []) if f['geometry']['type'] in {'Polygon','MultiPolygon'} and (restricted(f['properties']) or f['properties'].get('category') == 'water')]
        self.stations = [s for s in dataset['stations'] if not blocked(s.get('properties', {}))
            and (options['dataScope'] == 'all' or not s['properties'].get('isSynthetic'))
            and (self.boundary.covers(Point(coords(s))) or dataset.get('includeBoundaryStationContext') and s['properties'].get('insideStudyArea') is False)]
        if len({fid(s) for s in self.stations}) != len(self.stations):
            raise ValueError('已有站点编号重复')
        self.capacity = options['capacityScenario']['pileCount'] * options['capacityScenario']['powerKw']
        self.tau = options['thresholdMinutes'] * 60
        self.candidates = self.candidate_pool()

    def check_site(self, feature):
        location = Point(coords(feature))
        if not self.boundary.covers(location):
            return None, '位置超出研究区'
        matches = [g for g, polygon in zip(self.grids, self.polygons) if polygon.covers(location)]
        if not matches:
            return None, '位置没有规划网格'
        p = feature.get('properties', {})
        if restricted(p) or any(restricted(g['properties']) for g in matches):
            return None, '已知建设条件不满足'
        for polygon in self.restricted_polygons:
            if polygon.covers(location):
                return None, '位置位于水面或明确禁建范围'
        grid = matches[0]
        self.site_grid_cache[tuple(coords(feature))] = grid
        survey = {**grid['properties'], **p}
        spec = p.get('pileCount', self.options['capacityScenario']['pileCount']) * p.get('powerKw', self.options['capacityScenario']['powerKw'])
        spaces = max(p.get('pileCount', self.options['capacityScenario']['pileCount']), self.options['constraints']['minimumSpaces'])
        if number(survey.get('parkingSpaces')) and survey['parkingSpaces'] < spaces:
            return None, '已知公共泊位不足'
        if number(survey.get('availableKva')) and survey['availableKva'] * self.options['constraints']['powerFactor'] < spec:
            return None, '已知配变余量不足'
        return grid, None

    def site_status(self, grid, feature):
        survey = {**grid['properties'], **feature['properties']}
        return 'scenario-pass' if all(survey.get(k) is True for k in ['sitePermission','roadAccess','fireSafety']) and number(survey.get('parkingSpaces')) and number(survey.get('availableKva')) else 'pending'

    def group_feasible(self, additions):
        groups = {}
        for station in additions:
            key = tuple(coords(station))
            grid = self.site_grid_cache.get(key)
            if grid is None:
                location = Point(key)
                grid = next((g for g, polygon in zip(self.grids, self.polygons) if polygon.covers(location)), None)
                if grid is not None:
                    self.site_grid_cache[key] = grid
            if grid is None:
                return False
            entry = groups.setdefault(fid(grid), {'grid': grid, 'spaces': 0, 'kw': 0})
            p = station['properties']
            entry['spaces'] += max(p.get('pileCount', 1), self.options['constraints']['minimumSpaces'])
            entry['kw'] += p.get('pileCount', 1) * p.get('powerKw', 60)
        for entry in groups.values():
            p = entry['grid']['properties']
            if number(p.get('parkingSpaces')) and entry['spaces'] > p['parkingSpaces']:
                return False
            if number(p.get('availableKva')) and entry['kw'] > p['availableKva'] * self.options['constraints']['powerFactor']:
                return False
        return True

    def candidate_pool(self):
        result, seen = [], set()
        for feature in [*self.data.get('sites', []), *self.options.get('manualCandidates', [])]:
            candidate = copy.deepcopy(feature)
            if candidate['geometry']['type'] != 'Point':
                candidate['geometry'] = mapping(shape(candidate['geometry']).representative_point())
            key = tuple(round(v, 6) for v in coords(candidate))
            if key in seen:
                continue
            seen.add(key)
            grid, reason = self.check_site(candidate)
            if reason:
                continue
            radius = self.options['constraints']['radius']
            if any(meters(coords(candidate), coords(s)) < radius for s in self.stations):
                continue
            p = candidate['properties']
            candidate['properties'] = {**p, 'id': 'site-' + str(p.get('id', digest(key))), 'gridId': grid['properties']['id'],
                'name': p.get('name') or '录入场地', 'feasibility': 'pending', 'planningSource': 'road-optimizer',
                **self.options['capacityScenario'], 'chargeType': 'fast', 'isSynthetic': True, 'dataSource': 'sandbox'}
            candidate['properties']['feasibility'] = self.site_status(grid, candidate)
            result.append(candidate)
        return sorted(result, key=fid)

    def evaluate(self, columns, stations):
        n = len(self.locations)
        nearest, names = [None] * n, [None] * n
        access, capacities = [0.] * n, []
        weights = [p['weight'] for p in self.locations]
        edge = math.exp(-.5)
        def decay(t):
            return (math.exp(-.5 * (t / self.tau) ** 2) - edge) / (1 - edge) if t is not None and t < self.tau else 0
        for station, times in zip(stations, columns):
            p = station['properties']
            capacity = self.capacity if station in self.stations else p.get('pileCount', 1) * p.get('powerKw', 60)
            capacities.append(capacity)
            factors = [decay(t) for t in times]
            denominator = sum(w * f for w, f in zip(weights, factors))
            for i, t in enumerate(times):
                if t is not None and (nearest[i] is None or t < nearest[i]):
                    nearest[i], names[i] = t, p.get('name') or fid(station)
                if denominator:
                    access[i] += factors[i] * capacity / denominator
        return {'nearest': nearest, 'names': names, 'access': access, 'capacities': capacities}

    def analysis(self, additions=None, removed_ids=None, selection=None):
        additions = copy.deepcopy(additions if additions is not None else self.options.get('additions', []))
        removed_ids = removed_ids if removed_ids is not None else self.options.get('removedIds', [])
        known = {fid(s) for s in self.stations}
        if not set(removed_ids) <= known:
            raise ValueError('移除站点不属于当前研究基准')
        if len({fid(s) for s in additions}) != len(additions) or any(fid(s) in known for s in additions):
            raise ValueError('新增站点编号重复或与已有站冲突')
        retained = [s for s in self.stations if fid(s) not in set(removed_ids)]
        if not self.group_feasible(additions):
            raise ValueError('同网格多个新增站的合计泊位或功率不满足已知条件')
        checks = []
        for station in additions:
            grid, reason = self.check_site(station)
            if reason:
                raise ValueError(reason)
            radius = self.options['constraints']['radius']
            if any(meters(coords(station), coords(s)) < radius for s in retained + [a for a in additions if a is not station]):
                raise ValueError('新增站点不满足最小站间距')
            station['properties']['feasibility'] = self.site_status(grid, station)
            checks.append({'id': fid(station), 'gridId': grid['properties']['id'], 'status': station['properties']['feasibility']})
        targets = self.stations + additions
        matrix = self.network.matrix([coords(p['feature']) for p in self.locations], [coords(s) for s in targets])
        before = self.evaluate(matrix['columns'][:len(self.stations)], self.stations)
        after_columns = [column for s, column in zip(self.stations, matrix['columns']) if fid(s) not in set(removed_ids)] + matrix['columns'][len(self.stations):]
        after = self.evaluate(after_columns, retained + additions)
        return self.report(before, after, matrix, additions, removed_ids, checks, selection)

    def report(self, before, after, matrix, additions, removed_ids, checks, selection):
        weights = [p['weight'] for p in self.locations]
        total = sum(weights)
        reference = sum(a * w for a, w in zip(before['access'], weights)) / total if total else 0
        scale = reference or (self.capacity / total if total else 1)
        bottom, remaining = [], total * .2
        for i in sorted(range(len(weights)), key=lambda i: (before['access'][i], self.locations[i]['id'])):
            if remaining <= 1e-12:
                break
            portion = min(weights[i], remaining)
            bottom.append((i, portion)); remaining -= portion
        known_demands = [g['properties']['scenarioDemandIndex'] for g in self.grids if g['properties']['scenarioDemandIndex'] is not None]
        demand_mean = sum(known_demands) / len(known_demands) if known_demands else 0
        def metrics(state):
            reachable = sum(w for w, t in zip(weights, state['nearest']) if t is not None)
            covered = sum(w for w, t in zip(weights, state['nearest']) if t is not None and t <= self.tau)
            average = sum(w * t for w, t in zip(weights, state['nearest']) if t is not None) / reachable / 60 if reachable else None
            low_w = sum(w for _, w in bottom)
            return {'coveragePercent': covered / total * 100 if total else None,
                'averageMinutes': average,
                'allDemandAverageMinutes': average if reachable >= total - 1e-12 and total else None,
                'reachableAverageMinutes': average, 'unreachableDemandPercent': (total - reachable) / total * 100 if total else None,
                'capacityIndex': sum(a * w for a, w in zip(state['access'], weights)) / total / scale * 100 if total else None,
                'weakest20Index': sum(state['access'][i] * w for i, w in bottom) / low_w / scale * 100 if low_w else None,
                'gini': weighted_gini(state['access'], weights), 'stationCount': len(state['capacities']), 'scenarioPowerKw': sum(state['capacities'])}
        before_metrics, after_metrics = metrics(before), metrics(after)
        grids, places = [], []
        buckets = {str(g['properties']['id']): [] for g in self.grids}
        for i, location in enumerate(self.locations):
            buckets[location['gridId']].append(i)
            a, b = before['nearest'][i], after['nearest'][i]
            places.append({**location['feature'], 'properties': {**location['feature'].get('properties', {}),
                'id': location['id'], 'gridId': location['gridId'], 'activity': location['activity'], 'demandWeight': location['weight'],
                'roadPlanning': True, 'fallback': location['fallback'], 'beforeSeconds': a, 'afterSeconds': b,
                'timeSavedSeconds': a - b if a is not None and b is not None else None,
                'beforeNearest': before['names'][i], 'afterNearest': after['names'][i],
                'beforeCovered': a is not None and a <= self.tau, 'afterCovered': b is not None and b <= self.tau,
                'beforeCapacityIndex': before['access'][i] / scale * 100, 'afterCapacityIndex': after['access'][i] / scale * 100,
                'connectionStatus': 'connected' if matrix['sourceConnected'][i] else 'unconnected'}})
        gap_before = gap_after = 0
        for feature in self.grids:
            indices = buckets[str(feature['properties']['id'])]
            local_weight = sum(weights[i] for i in indices)
            p = {**feature['properties']}
            p['demandPointCount'] = len(indices)
            for label, state in [('before', before), ('after', after)]:
                reachable_indices = [i for i in indices if state['nearest'][i] is not None]
                reachable_weight = sum(weights[i] for i in reachable_indices)
                fastest = min(reachable_indices, key=lambda i: state['nearest'][i], default=None)
                covered = sum(weights[i] for i in indices if state['nearest'][i] is not None and state['nearest'][i] <= self.tau)
                p[label + 'Coverage'] = covered / local_weight * 100 if local_weight else None
                # 最近站不按服务阈值截断；不可达地点不清空其他地点已算出的时间。
                p[label + 'Minutes'] = sum(weights[i] * state['nearest'][i] for i in reachable_indices) / reachable_weight / 60 if reachable_weight else None
                p[label + 'Nearest'] = state['names'][fastest] if fastest is not None else None
                p[label + 'NearestMinutes'] = state['nearest'][fastest] / 60 if fastest is not None else None
                p[label + 'ReachablePointCount'] = len(reachable_indices)
                p[label + 'UnreachableDemandPercent'] = max(0, (local_weight - reachable_weight) / local_weight * 100) if local_weight else None
                p[label + 'CapacityIndex'] = sum(weights[i] * state['access'][i] for i in indices) / local_weight / scale * 100 if local_weight else None
            high = p['scenarioDemandIndex'] is not None and p['scenarioDemandIndex'] > 0 and p['scenarioDemandIndex'] >= demand_mean
            p['beforeGap'] = high and p['beforeCoverage'] is not None and p['beforeCoverage'] < 100 - 1e-8
            p['afterGap'] = high and p['afterCoverage'] is not None and p['afterCoverage'] < 100 - 1e-8
            p['gapClass'] = 'unknown' if p['beforeCoverage'] is None else ('high' if high else 'low') + ('-gap' if p['beforeCoverage'] < 100 - 1e-8 else '-covered')
            gap_before += p['beforeGap']; gap_after += p['afterGap']
            for field in ['Coverage', 'Minutes', 'CapacityIndex']:
                p['delta' + field] = p['after' + field] - p['before' + field] if p['after' + field] is not None and p['before' + field] is not None else None
            grids.append({**feature, 'properties': p})
        before_metrics['highDemandGapGrids'], after_metrics['highDemandGapGrids'] = gap_before, gap_after
        changes = {k: after_metrics[k] - v if isinstance(v, (int, float)) and after_metrics[k] is not None else None for k, v in before_metrics.items()}
        adjusted = any(s['properties'].get('pileCount', 1) * s['properties'].get('powerKw', 60) != self.capacity for s in additions)
        return {'modelVersion': MODEL, 'baselineKey': self.baseline_key, 'parameters': copy.deepcopy(self.options),
            'versions': {'demand': digest(self.grids), 'network': self.network.version, 'candidates': digest(self.candidates), 'configuration': digest(self.options)},
            'before': before_metrics, 'after': after_metrics, 'changes': changes, 'grids': collection(grids), 'places': collection(places),
            'baselineStations': collection(self.stations), 'candidates': collection(self.candidates), 'selectedStations': collection(additions), 'selection': selection,
            'construction': checks, 'capacityBasis': 'configuration-scenario' if adjusted else 'uniform-scenario',
            'quality': {**self.network.quality, 'unconnectedDemandPoints': sum(not c for c in matrix['sourceConnected']),
                'boundaryContextStations':sum(not self.boundary.covers(Point(coords(s))) for s in self.stations),
                'supplyAccessBasis':'recorded_locations_public_access_not_verified',
                'unconnectedStations': sum(not c for c in matrix['targetConnected']), 'demandWeight': total,
                'fallbackDemandPoints': sum(p['fallback'] for p in self.locations), 'unknownDemandGrids': sum(g['properties']['scenarioDemandIndex'] is None for g in self.grids)},
            'priorities': sorted([g for g in grids if g['properties']['beforeGap']], key=lambda g: -(g['properties']['scenarioDemandIndex'] or 0) * (100 - (g['properties']['beforeCoverage'] or 0)))}

    def optimize(self, method=None, count=None):
        method, count = method or self.options['method'], count or self.options['requestedCount']
        targets = self.stations + self.candidates
        matrix = self.network.matrix([coords(p['feature']) for p in self.locations], [coords(s) for s in targets])
        before = self.evaluate(matrix['columns'][:len(self.stations)], self.stations)
        current = before['nearest'][:]
        columns = matrix['columns'][len(self.stations):]
        weights = [p['weight'] for p in self.locations]
        chosen, steps, remaining = [], [], list(range(len(self.candidates)))
        cluster_order, centers = self.cluster_order(count, before, columns)
        demand_order = sorted(remaining, key=lambda j: (-sum(w for w, t in zip(weights, columns[j]) if t is not None and t <= self.tau), fid(self.candidates[j])))
        stop = 'requested-count'
        while len(chosen) < count:
            feasible = [j for j in remaining if matrix['targetConnected'][len(self.stations) + j] and all(meters(coords(self.candidates[j]), coords(self.candidates[k])) >= self.options['constraints']['radius'] for k in chosen)
                and self.group_feasible([self.candidates[k] for k in chosen + [j]])]
            if not feasible:
                stop = 'no-feasible-candidates'; break
            def benefit(j):
                covered = sum(w for w, a, b in zip(weights, current, columns[j]) if (a is None or a > self.tau) and b is not None and b <= self.tau)
                saved = sum(w * max(0, a - b) for w, a, b in zip(weights, current, columns[j]) if a is not None and b is not None)
                return covered, saved
            if method == 'mclp':
                j = min(feasible, key=lambda j: (-round(benefit(j)[0], 12), -round(benefit(j)[1], 9), fid(self.candidates[j])))
                gain, saved = benefit(j)
                if gain <= 1e-12 and saved <= 1e-9:
                    stop = 'no-marginal-benefit'; break
            else:
                order = cluster_order if method == 'kmeans' else demand_order
                j = next(j for j in order if j in feasible)
                gain, saved = benefit(j)
            chosen.append(j); remaining.remove(j)
            steps.append({'rank': len(chosen), 'candidateId': fid(self.candidates[j]), 'newlyCoveredWeight': gain,
                'coverageGainPoints': gain / sum(weights) * 100 if sum(weights) else None, 'weightedSavedSeconds': saved})
            current = [min(a, b) if a is not None and b is not None else a if b is None else b for a, b in zip(current, columns[j])]
        selected = [copy.deepcopy(self.candidates[j]) for j in chosen]
        for station, step in zip(selected, steps):
            station['properties'].update(step)
        return self.analysis(selected, [], {'method': method, 'requestedCount': count, 'selectedCount': len(selected),
            'comparableCount': len(selected) == count, 'stopReason': stop, 'steps': steps, 'demandCenters': collection(centers)})

    def cluster_order(self, count, before, columns):
        # Weighted K-means with seeded weighted initialization; centers are NEVER building sites.
        indices = [i for i, t in enumerate(before['nearest']) if t is None or t > self.tau]
        if not indices:
            indices = list(range(len(self.locations)))
        points = [coords(self.locations[i]['feature']) for i in indices]
        weights = [self.locations[i]['weight'] for i in indices]
        if not points or not self.candidates:
            return list(range(len(self.candidates))), []
        rng = random.Random(42)
        centers = [list(points[rng.choices(range(len(points)), weights=weights)[0]])]
        for _ in range(min(count, len(set(map(tuple, points)))) - 1):
            chances = [w * min(meters(p, c) ** 2 for c in centers) for p, w in zip(points, weights)]
            if not sum(chances):
                break
            centers.append(list(points[rng.choices(range(len(points)), weights=chances)[0]]))
        for _ in range(100):
            groups = [[] for _ in centers]
            for p, w in zip(points, weights):
                groups[min(range(len(centers)), key=lambda i: meters(p, centers[i]))].append((p, w))
            updated = [[sum(p[d] * w for p, w in group) / sum(w for _, w in group) for d in [0, 1]] if group else old for group, old in zip(groups, centers)]
            moved = max(meters(a, b) for a, b in zip(centers, updated))
            centers = updated
            if moved < 1:
                break
        order = []
        for center in centers:
            candidates = sorted(range(len(self.candidates)), key=lambda j: (meters(center, coords(self.candidates[j])), fid(self.candidates[j])))
            first = next((j for j in candidates if j not in order), None)
            if first is not None:
                order.append(first)
        order += [j for j in range(len(self.candidates)) if j not in order]
        return order, [{'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': c}, 'properties': {'name': f'需求核心 {i + 1}', 'buildable': False}} for i, c in enumerate(centers)]
