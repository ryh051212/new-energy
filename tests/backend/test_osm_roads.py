import copy
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from backend import osm_roads
from tests.backend.test_auth_cors import asgi_request


def way(identifier, ids, coordinates, **tags):
    return {'type': 'way', 'id': identifier, 'nodes': ids,
            'geometry': [{'lon': lon, 'lat': lat} for lon, lat in coordinates],
            'tags': {'highway': 'residential', **tags}}


class OsmRoadTests(unittest.TestCase):
    def test_direction_access_and_shared_node_topology(self):
        raw = {'elements': [
            way(1, [10, 11], [[113, 34], [113.01, 34.01]], oneway='yes', access='private', motorcar='yes'),
            way(2, [20, 21], [[113, 34.01], [113.01, 34]], oneway='-1', bridge='yes'),
            way(3, [11, 30], [[113.01, 34.01], [113.02, 34.01]], motor_vehicle='no'),
            {'type': 'node', 'id': 11, 'tags': {'barrier': 'gate'}},
            {'type': 'relation', 'id': 90, 'tags': {'type': 'restriction', 'restriction': 'no_left_turn'},
             'members': [{'type': 'way', 'ref': 1, 'role': 'from'}]},
        ]}
        original = copy.deepcopy(raw)
        roads, network = osm_roads.normalize_roads(raw, {'fetchedAt': '2026-10-23'})
        self.assertEqual(raw, original)
        self.assertEqual([(e['from'], e['to']) for e in network['edges']], [(10, 11), (21, 20), (11, 30), (30, 11)])
        self.assertEqual(len(network['nodes']), 5, 'geometric crossing must not create a junction')
        self.assertEqual(roads['features'][0]['properties']['motorAccess'], 'allowed')
        self.assertFalse(roads['features'][2]['properties']['motorVehicleCandidate'])
        self.assertEqual(next(node for node in network['nodes'] if node['id'] == 11)['tags']['barrier'], 'gate')
        self.assertEqual(network['turnRestrictions'][0]['osmId'], 90)
        self.assertFalse(network['metadata']['routingReady'])
        self.assertFalse(network['metadata']['turnRestrictionsApplied'])
        self.assertGreater(network['edges'][0]['lengthM'], 1000)

    def test_implicit_oneway_unknown_access_and_invalid_partial_results(self):
        self.assertEqual(osm_roads.road_direction({'highway': 'motorway'}), 'forward')
        self.assertEqual(osm_roads.road_direction({'junction': 'roundabout', 'oneway': 'no'}), 'both')
        self.assertEqual(osm_roads.motor_access({'highway': 'service'}), 'unspecified')
        self.assertEqual(osm_roads.motor_access({'access': 'destination'}), 'restricted')
        self.assertEqual(osm_roads.motor_access({'highway': 'construction', 'access': 'yes'}), 'prohibited')
        for raw in [{'remark': 'timeout', 'elements': []}, {'elements': []}, {'elements': [way(1, [1, 2], [[999, 34], [113, 34]])]}]:
            with self.assertRaises(ValueError):
                osm_roads.normalize_roads(raw, {})

    def test_local_routes_metadata_network_missing_snapshot_and_refresh(self):
        app = FastAPI()
        app.include_router(osm_roads.router)
        def get(url):
            status, _, body, _ = asyncio.run(asgi_request(app, url))
            return status, json.loads(body)
        with tempfile.TemporaryDirectory() as directory:
            path, graph = Path(directory) / 'roads.json', Path(directory) / 'network.json'
            with patch.object(osm_roads, 'ROAD_PATH', path), patch.object(osm_roads, 'NETWORK_PATH', graph):
                self.assertEqual(get('/api/osm-roads')[0], 503)
                roads, network = osm_roads.normalize_roads({'elements': [way(1, [1, 2], [[113, 34], [113.01, 34]])]}, {})
                path.write_text(json.dumps(roads), encoding='utf-8')
                graph.write_text(json.dumps(network), encoding='utf-8')
                self.assertEqual(get('/api/osm-roads')[1]['features'][0]['properties']['osmId'], 1)
                self.assertEqual(get('/api/osm-roads/metadata')[1]['roadCount'], 1)
                self.assertEqual(len(get('/api/osm-roads/network')[1]['edges']), 2)
                roads['metadata']['roadCount'] = 2
                path.write_text(json.dumps(roads) + ' ', encoding='utf-8')
                self.assertEqual(get('/api/osm-roads/metadata')[1]['roadCount'], 2)

