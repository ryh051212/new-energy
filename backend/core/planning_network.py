"""Directed, edge-snapped scenario routing. No straight-line routing fallback."""
import hashlib
import heapq
import json
import math
from collections import OrderedDict, defaultdict
from threading import RLock
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

SPEEDS = {'motorway': 80, 'trunk': 60, 'primary': 40, 'secondary': 35, 'tertiary': 30,
          'residential': 20, 'living_street': 10, 'service': 10, 'road': 20, 'unclassified': 20}
PROFILE = 'urban-scenario-v1'
RX, RY = 111195 * math.cos(math.radians(34.04)), 111195


def xy(coordinates):
    return coordinates[0] * RX, coordinates[1] * RY


def meters(a, b):
    return math.dist(xy(a), xy(b))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()[:24]


class RoadNetwork:
    def __init__(self, network, roads, obstacles=()):
        self.version = digest([network, roads, list(obstacles), PROFILE])
        self.nodes = {str(n['id']): n for n in network['nodes']}
        ways = {str(f['properties']['osmId']): f['properties'] for f in roads['features']}
        self.edges, self.reverse, self.groups = [], defaultdict(list), defaultdict(list)
        self.blockers = [shape(g) for g in obstacles if g]
        self.forbidden, self.only = defaultdict(set), defaultdict(set)
        self.no_uturn, self.only_uturn = set(), set()
        self.unsupported_restrictions = 0
        for relation in network.get('turnRestrictions', []):
            members = relation.get('members', [])
            incoming = next((str(m['ref']) for m in members if m['role'] == 'from'), None)
            outgoing = next((str(m['ref']) for m in members if m['role'] == 'to'), None)
            via = next((str(m['ref']) for m in members if m['role'] == 'via' and m['type'] == 'node'), None)
            restriction = relation.get('tags', {}).get('restriction', '')
            if not all([incoming, outgoing, via]) or relation.get('tags', {}).get('restriction:conditional') or relation.get('tags', {}).get('except'):
                self.unsupported_restrictions += 1
                continue
            if restriction == 'no_u_turn' and incoming == outgoing:
                self.no_uturn.add((via, incoming))
            elif restriction == 'only_u_turn' and incoming == outgoing:
                self.only_uturn.add((via, incoming))
            elif restriction.startswith('no_'):
                self.forbidden[(via, incoming)].add(outgoing)
            elif restriction.startswith('only_'):
                self.only[(via, incoming)].add(outgoing)
        excluded = defaultdict(int)
        for entry in network['edges']:
            highway = entry['highway'].removesuffix('_link')
            if highway not in SPEEDS or not entry.get('motorVehicleCandidate') or entry.get('motorAccess') in {'restricted', 'prohibited'} or not entry.get('directionKnown'):
                excluded['accessOrRoadType'] += 1
                continue
            a, b = str(entry['from']), str(entry['to'])
            if any(self.blocked_node(self.nodes[n].get('tags', {})) for n in [a, b]):
                excluded['barrier'] += 1
                continue
            speed = SPEEDS[highway]
            tags = ways.get(str(entry['osmWayId']), {})
            try:
                limit = float(str(tags.get('maxspeed', '')).split(';')[0])
                if limit > 0:
                    speed = min(speed, limit)
            except (ValueError, TypeError):
                pass
            if entry['highway'].endswith('_link'):
                speed = min(speed, 30)
            delay = 20 if self.nodes[b].get('tags', {}).get('highway') == 'traffic_signals' else 0
            edge = {**entry, 'a': a, 'b': b, 'way': str(entry['osmWayId']), 'seconds': entry['lengthM'] / (speed / 3.6), 'delay': delay}
            i = len(self.edges)
            edge['index'] = i
            self.edges.append(edge)
            self.reverse[b].append(i)
            self.groups[tuple(sorted((a, b)))].append(i)
        self.group_keys = list(self.groups)
        self.lines = [LineString([xy(self.nodes[a]['coordinates']), xy(self.nodes[b]['coordinates'])]) for a, b in self.group_keys]
        self.tree = STRtree(self.lines)
        self.snap_cache, self.matrix_cache, self.column_cache = OrderedDict(), OrderedDict(), OrderedDict()
        self.lock = RLock()
        self.quality = {'profile': PROFILE, 'speedKmh': SPEEDS, 'signalDelaySeconds': 20,
            'inputEdges': len(network['edges']), 'routableEdges': len(self.edges), 'excludedEdges': dict(excluded),
            'turnRestrictionCount': len(network.get('turnRestrictions', [])), 'unsupportedTurnRestrictions': self.unsupported_restrictions,
            'maxSnapMeters': 200, 'accessUnspecifiedEdges': sum(e.get('motorAccess') == 'unspecified' for e in self.edges),
            'sourceMetadata': network.get('metadata', {}), 'timeBasis': 'osm-scenario-driving'}

    @staticmethod
    def blocked_node(tags):
        if tags.get('motorcar', tags.get('motor_vehicle', tags.get('access'))) in {'yes', 'permissive'}:
            return False
        return tags.get('barrier') in {'bollard', 'block', 'bus_trap', 'cycle_barrier', 'gate', 'lift_gate'} or tags.get('access') in {'no', 'private'}

    def allowed_turn(self, node, incoming, outgoing_index):
        if outgoing_index == -1:
            return True
        outgoing = self.edges[outgoing_index]
        key = (node, incoming['way'])
        uturn = incoming['a'] == outgoing['b'] and incoming['way'] == outgoing['way']
        if key in self.no_uturn and uturn or key in self.only_uturn and not uturn:
            return False
        return outgoing['way'] not in self.forbidden[key] and (not self.only[key] or outgoing['way'] in self.only[key])

    def snap(self, coordinates):
        key = tuple(coordinates)
        if key in self.snap_cache:
            return self.snap_cache[key]
        p = Point(xy(coordinates))
        candidates = sorted((float(self.lines[int(i)].distance(p)), int(i)) for i in self.tree.query(p.buffer(200)))
        result = None
        for gap, i in candidates:
            if gap > 200:
                break
            line = self.lines[i]
            fraction = line.project(p, normalized=True)
            anchor = line.interpolate(fraction, normalized=True)
            anchor_wgs = (anchor.x / RX, anchor.y / RY)
            connector = LineString([coordinates, anchor_wgs])
            if gap > .01 and any(connector.intersects(obstacle) for obstacle in self.blockers):
                continue
            a, b = self.group_keys[i]
            branches = [(self.edges[j], fraction if self.edges[j]['a'] == a else 1 - fraction) for j in self.groups[(a, b)]]
            result = {'gap': gap, 'connectorSeconds': gap / (10 / 3.6), 'branches': branches, 'anchor': anchor_wgs}
            break
        self.snap_cache[key] = result
        if len(self.snap_cache) > 10000:
            self.snap_cache.popitem(last=False)
        return result

    def distances_to(self, target_snap):
        costs, queue = {}, []
        for edge, f in target_snap['branches']:
            key = (edge['a'], edge['index'] if f > 1e-9 else -1)
            cost = f * edge['seconds'] + target_snap['connectorSeconds']
            if cost < costs.get(key, math.inf):
                costs[key] = cost
                heapq.heappush(queue, (cost, key[0], key[1]))
        while queue:
            cost, node, next_index = heapq.heappop(queue)
            if cost != costs.get((node, next_index)):
                continue
            for i in self.reverse[node]:
                edge = self.edges[i]
                if not self.allowed_turn(node, edge, next_index):
                    continue
                key = (edge['a'], edge['index'])
                total = cost + edge['seconds'] + edge['delay']
                if total < costs.get(key, math.inf):
                    costs[key] = total
                    heapq.heappush(queue, (total, key[0], key[1]))
        by_node = defaultdict(list)
        for (node, next_index), cost in costs.items():
            by_node[node].append((next_index, cost))
        return by_node

    def time(self, source, target, field):
        if source is None or target is None:
            return None
        best = math.inf
        for edge, fraction in source['branches']:
            for next_index, cost in field.get(edge['b'], []):
                if self.allowed_turn(edge['b'], edge, next_index):
                    best = min(best, (1 - fraction) * edge['seconds'] + edge['delay'] + cost)
            # Direct travel on the same directed segment must not detour to an endpoint.
            for other, end_fraction in target['branches']:
                if edge['id'] == other['id'] and fraction <= end_fraction:
                    best = min(best, (end_fraction - fraction) * edge['seconds'] + target['connectorSeconds'])
        return best + source['connectorSeconds'] if math.isfinite(best) else None

    def matrix(self, sources, targets):
        key = digest([sources, targets])
        with self.lock:
            if key in self.matrix_cache:
                self.matrix_cache.move_to_end(key)
                return self.matrix_cache[key]
            source_snaps, target_snaps = [self.snap(c) for c in sources], [self.snap(c) for c in targets]
            columns = []
            sources_key = digest(sources)
            for coordinates, target in zip(targets, target_snaps):
                column_key = (sources_key, tuple(coordinates))
                if column_key not in self.column_cache:
                    field = self.distances_to(target) if target else {}
                    self.column_cache[column_key] = [self.time(source, target, field) for source in source_snaps]
                    if len(self.column_cache) > 600:
                        self.column_cache.popitem(last=False)
                columns.append(self.column_cache[column_key])
            result = {'columns': columns, 'sourceConnected': [s is not None for s in source_snaps],
                      'targetConnected': [s is not None for s in target_snaps]}
            self.matrix_cache[key] = result
            if len(self.matrix_cache) > 4:
                self.matrix_cache.popitem(last=False)
            return result
