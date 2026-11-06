import unittest
from copy import deepcopy
from unittest.mock import patch

from fastapi import HTTPException
from backend import main, route_planning
from backend.coordinate_transform import wgs84_to_gcj02


def path(index=0, **overrides):
    return {'distance': str(1000 + index * 100), 'cost': {'duration': '180', 'tolls': '0'},
            'steps': [{'road_name': '大学路', 'polyline': f'113.83,34.04;113.84,{34.04 + index / 100}'},
                      {'road_name': '八一路', 'polyline': f'113.84,{34.04 + index / 100};113.85,34.05'}], **overrides}


class AmapRoutesTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {'AMAP_WEB_KEY': 'test-key'})
        environment.start()
        self.addCleanup(environment.stop)
        request_patch = patch.object(route_planning.requests, 'get')
        self.request = request_patch.start()
        self.addCleanup(request_patch.stop)
        self.response = self.request.return_value
        self.coordinates = (113.82, 34.03, 113.85, 34.05)

    def test_distinct_valid_routes_are_capped_at_three_and_converted_to_wgs84(self):
        paths = [path(distance='bad'), path(0), path(0), path(1), path(2), path(3)]
        self.response.json.return_value = {'status': '1', 'route': {'paths': paths}}
        routes = route_planning.get_amap_routes(*self.coordinates)
        self.assertEqual(len(routes), 3)
        self.assertEqual([route['properties']['routeId'] for route in routes], ['1', '2', '3'])
        self.assertEqual(routes[0]['properties']['routeLabel'], '高德推荐')
        self.assertEqual(routes[0]['properties']['roads'], ['大学路', '八一路'])
        self.assertEqual(routes[0]['properties']['tollsYuan'], 0)
        self.assertEqual(len(routes[0]['geometry']['coordinates']), 3, '路段连接点不重复')
        self.assertEqual(routes[0]['geometry']['type'], 'LineString')
        projected = wgs84_to_gcj02(*routes[0]['geometry']['coordinates'][0])
        self.assertAlmostEqual(projected[0], 113.83, places=6)
        self.assertAlmostEqual(projected[1], 34.04, places=6)
        self.assertEqual(self.request.call_args.kwargs['params']['strategy'], 32)
        self.assertEqual(self.request.call_args.kwargs['params']['show_fields'], 'cost,polyline,tmcs')

    def test_tmc_geometry_is_converted_and_unknown_is_preserved(self):
        route = path()
        route['steps'][0]['tmcs'] = [
            {'tmc_status': '畅通', 'tmc_distance': '500', 'tmc_polyline': '113.83,34.04;113.84,34.04'},
            {'tmc_status': '未知', 'tmc_distance': '200', 'tmc_polyline': '113.84,34.04;113.85,34.05'},
            {'tmc_status': '缓行', 'tmc_distance': '100', 'tmc_polyline': '113.85,34.05;113.86,34.05'},
        ]
        self.response.json.return_value = {'status': '1', 'route': {'paths': [route]}}
        data = route_planning.get_amap_routes(*self.coordinates)[0]['properties']
        self.assertEqual(len(data['trafficSegments']), 3)
        self.assertTrue(data['trafficAvailable'])
        self.assertEqual(data['trafficScope'], 'route_only')
        self.assertEqual(data['trafficDistanceByStatus']['未知'], 200)
        self.assertEqual(data['trafficDistanceByStatus']['畅通'], 500)
        self.assertTrue(data['trafficFetchedAt'].endswith('+00:00'))
        position = data['trafficSegments'][0]['geometry']['coordinates'][0]
        self.assertAlmostEqual(wgs84_to_gcj02(*position)[0], 113.83, places=6)
        self.assertEqual(data['trafficSegments'][1]['properties']['trafficStatus'], '未知')

    def test_bad_or_missing_tmc_does_not_hide_valid_route(self):
        for segments in (None, [], [{'tmc_distance': 'NaN', 'tmc_polyline': '113,34;114,34'}],
                         [{'tmc_distance': 5, 'tmc_polyline': '181,34;113,34'}], [None]):
            route = path()
            route['steps'][0]['tmcs'] = segments
            self.response.json.return_value = {'status': '1', 'route': {'paths': [route]}}
            data = route_planning.get_amap_routes(*self.coordinates)[0]['properties']
            self.assertEqual(data['trafficSegments'], [])
            self.assertFalse(data['trafficAvailable'])
            self.assertEqual(data['trafficStatus'], 'unavailable')
            self.assertIsNone(data['trafficFetchedAt'])
            self.assertIsNone(data['trafficDistanceByStatus'])
        route = path()
        route['steps'][0]['tmcs'] = [{'tmc_status': '未识别', 'tmc_distance': '5', 'tmc_polyline': '113,34;114,34'}]
        self.response.json.return_value = {'status': '1', 'route': {'paths': [route]}}
        data = route_planning.get_amap_routes(*self.coordinates)[0]['properties']
        self.assertEqual(data['trafficStatus'], 'unknown')
        self.assertFalse(data['trafficAvailable'])

    def test_bad_numbers_bad_geometry_and_duplicate_paths_do_not_create_fake_alternatives(self):
        for broken in [path(distance='NaN'), path(distance=-1), path(distance=True), path(cost={'duration': 'Infinity'}),
                       path(steps=[]), path(steps=[{'polyline': '181,34;113,34'}]),
                       path(steps=[{'polyline': '113,34;bad'}]), path(steps=[{'polyline': '113,34'}])]:
            with self.subTest(broken=broken):
                self.response.json.return_value = {'status': '1', 'route': {'paths': [broken]}}
                self.assertEqual(route_planning.get_amap_routes(*self.coordinates), [])
        self.response.json.return_value = {'status': '1', 'route': {'paths': [path(cost={'duration': '0'}), path(cost={'duration': '0'})]}}
        result = route_planning.get_amap_routes(*self.coordinates)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['properties']['durationSeconds'], 0)
        self.assertIsNone(result[0]['properties']['tollsYuan'])

    def test_missing_key_invalid_coordinates_and_provider_errors_return_empty_routes(self):
        with patch.dict('os.environ', {'AMAP_WEB_KEY': ''}):
            self.assertEqual(route_planning.get_amap_routes(*self.coordinates), [])
        self.assertEqual(route_planning.get_amap_routes(181, 34, 113, 34), [])
        self.request.assert_not_called()
        self.request.side_effect = route_planning.requests.Timeout('timeout')
        self.assertEqual(route_planning.get_amap_routes(*self.coordinates), [])
        self.request.side_effect = None
        self.response.raise_for_status.side_effect = route_planning.requests.HTTPError('503')
        self.assertEqual(route_planning.get_amap_routes(*self.coordinates), [])
        self.response.raise_for_status.side_effect = None
        for data in [{'status': '0'}, {'status': '1', 'route': None}, []]:
            self.response.json.return_value = data
            self.assertEqual(route_planning.get_amap_routes(*self.coordinates), [])


class StationRoutesApiTests(unittest.TestCase):
    @patch.object(main, 'get_amap_routes')
    @patch.object(main, 'get_db_connection')
    def test_postgis_distance_success_fallback_and_missing_station(self, connect, provider):
        cursor = connect.return_value.cursor.return_value
        cursor.fetchone.return_value = ('大学路站', 113.85, 34.05, 600.5, {})
        route = {'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[113.82, 34.03], [113.85, 34.05]]},
                 'properties': {'routeId': '1', 'distanceMeters': 1200, 'distanceSource': 'amap_driving', 'isFallback': False}}
        provider.return_value = [deepcopy(route)]
        result = main.get_station_routes('a', 113.82, 34.03)
        self.assertEqual(result['metadata']['coordSystem'], 'WGS84')
        self.assertEqual(result['metadata']['routeCount'], 1)
        self.assertEqual(result['metadata']['routeDestinationKind'], 'station_location')
        self.assertFalse(result['metadata']['isFallback'])
        self.assertEqual(result['features'][0]['properties']['straightDistanceMeters'], 600.5)
        provider.assert_called_with(*wgs84_to_gcj02(113.82, 34.03), *wgs84_to_gcj02(113.85, 34.05))
        sql, params = cursor.execute.call_args.args
        self.assertIn('ST_Distance', sql)
        self.assertIn("IS DISTINCT FROM 'retired'", sql)
        self.assertEqual(params, (113.82, 34.03, 'a'))
        self.assertTrue(cursor.close.called)
        self.assertTrue(connect.return_value.close.called)
        provider.return_value = []
        fallback = main.get_station_routes('a', 113.82, 34.03)
        self.assertEqual(fallback['features'], [])
        self.assertEqual(fallback['traffic']['features'], [])
        self.assertFalse(fallback['metadata']['trafficAvailable'])
        self.assertTrue(fallback['metadata']['isFallback'])
        self.assertEqual(fallback['metadata']['distanceSource'], 'postgis_straight')
        self.assertEqual(fallback['metadata']['straightDistanceMeters'], 600.5)
        cursor.fetchone.return_value = None
        with self.assertRaises(HTTPException) as raised:
            main.get_station_routes('missing', 113.82, 34.03)
        self.assertEqual(raised.exception.status_code, 404)

    @patch.object(main, 'station_access_guide')
    @patch.object(main, 'get_amap_routes')
    @patch.object(main, 'get_db_connection')
    def test_verified_vehicle_entrance_is_route_target_without_moving_station_geometry(self, connect, provider, guide):
        connect.return_value.cursor.return_value.fetchone.return_value = ('地下车库站', 113.85, 34.05, 600.5, {})
        guide.return_value = {'routingEntrance': {'kind': 'vehicle_entrance', 'coordinates': [113.849,34.05], 'coordSystem': 'WGS84',
            'sourceUrl': 'https://ditu.amap.com/place/test', 'checkedAt': '2026-10-09T01:00:00+08:00'}}
        provider.return_value = []
        result = main.get_station_routes('test',113.82,34.03)
        provider.assert_called_once_with(*wgs84_to_gcj02(113.82,34.03),*wgs84_to_gcj02(113.849,34.05))
        self.assertEqual(result['metadata']['destination'],[113.849,34.05])
        self.assertEqual(result['metadata']['stationCoordinates'],[113.85,34.05])
        self.assertEqual(result['metadata']['routeDestinationKind'],'vehicle_entrance')
