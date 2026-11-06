import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend import main


class StationsApiTests(unittest.TestCase):
    @patch.dict("os.environ", {"DB_PASSWORD": "test-password"})
    @patch.object(main, "get_db_connection")
    def test_query_with_and_without_name(self, get_db_connection):
        connection = get_db_connection.return_value
        cursor = connection.cursor.return_value
        cursor.fetchall.return_value = [("station-1", "测试充电站", "测试地址", '{"type":"Point","coordinates":[113.8,34.0]}', {})]

        result = main.get_stations("测试")
        sql, params = cursor.execute.call_args.args
        self.assertIn("name ILIKE %s", sql)
        self.assertEqual(params, ["%测试%"])
        self.assertEqual(result["features"][0]["geometry"]["coordinates"], [113.8, 34.0])
        self.assertTrue(connection.close.called)

        cursor.execute.reset_mock()
        main.get_stations()
        self.assertNotIn("name ILIKE", cursor.execute.call_args.args[0])
        self.assertEqual(cursor.execute.call_args.args[1], [])

    @patch.dict("os.environ", {"DB_PASSWORD": ""})
    def test_missing_password_returns_service_error(self):
        with self.assertRaises(HTTPException) as raised:
            main.get_stations()
        self.assertEqual(raised.exception.status_code, 503)

    @patch.dict("os.environ", {"DB_PASSWORD": "test-password"})
    @patch.object(main, "get_db_connection")
    def test_real_locations_with_demo_attributes_remain_real_and_use_two_types(self, connect):
        cursor = connect.return_value.cursor.return_value
        geometry = '{"type":"Point","coordinates":[113.8,34.0]}'
        cursor.fetchall.return_value = [('real-1', '真实站点', '原地址', geometry,
            {'charge_type': 'regular', 'regular_count': 6, 'is_synthetic': False,
             'simulated_fields': ['powerKw'], 'power_kw': 7})]
        result = main.get_stations(include_synthetic=False)
        properties = result['features'][0]['properties']
        self.assertEqual(properties['chargeType'], 'regular')
        self.assertEqual(properties['regularCount'], 6)
        self.assertEqual(properties['simulatedFields'], ['powerKw'])
        self.assertFalse(properties['isSynthetic'])
        self.assertEqual(result['metadata']['supplementedCount'], 1)
        self.assertEqual(result['metadata']['syntheticCount'], 0)


class RecommendedStationsApiTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {'DB_PASSWORD': 'test-password', 'AMAP_WEB_KEY': 'test-key'})
        environment.start()
        self.addCleanup(environment.stop)
        connection_patch = patch.object(main, 'get_db_connection')
        self.connect = connection_patch.start()
        self.addCleanup(connection_patch.stop)
        route_patch = patch.object(main, 'get_amap_driving_info')
        self.route = route_patch.start()
        self.addCleanup(route_patch.stop)
        self.cursor = self.connect.return_value.cursor.return_value
        self.rows = [
            ('a', '站点 A', '地址 A', 113.83, 34.04, 300.25, {'electricity_price': 1.0, 'service_price': 0.5}),
            ('b', '站点 B', '地址 B', 113.84, 34.04, 600.5, {'electricity_price': 0.6, 'service_price': 0.3}),
            ('c', '站点 C', '地址 C', 113.85, 34.04, 900.75, {}),
        ]
        self.cursor.fetchall.return_value = self.rows

    def test_success_uses_driving_distance_and_converts_only_provider_coordinates(self):
        self.route.side_effect = [
            {'distance': 1400, 'duration': 240},
            {'distance': 1100, 'duration': 180},
            {'distance': 2000, 'duration': 360},
        ]
        result = main.get_recommended_stations(113.82, 34.03, 2)
        self.assertEqual([f['properties']['id'] for f in result['features']], ['b', 'a'])
        first = result['features'][0]
        self.assertEqual(first['geometry']['coordinates'], [113.84, 34.04])
        self.assertEqual(first['properties']['distanceMeters'], 1100)
        self.assertEqual(first['properties']['straightDistanceMeters'], 600.5)
        self.assertEqual(first['properties']['drivingDurationSeconds'], 180)
        self.assertEqual(first['properties']['distanceSource'], 'amap_driving')
        self.assertEqual(first['properties']['distanceType'], 'driving')
        self.assertEqual(first['properties']['distanceLabel'], '驾车距离')
        self.assertFalse(first['properties']['isFallback'])
        self.assertEqual(result['metadata']['fallbackCount'], 0)
        self.route.assert_any_call(*main.wgs84_to_gcj02(113.82, 34.03), *main.wgs84_to_gcj02(113.84, 34.04))
        sql, params = self.cursor.execute.call_args.args
        self.assertIn('ST_Distance(s.geom::geography, u.geog)', sql)
        self.assertIn("IS DISTINCT FROM 'retired'", sql)
        self.assertEqual(params, (113.82, 34.03))
        self.assertTrue(self.cursor.close.called)
        self.assertTrue(self.connect.return_value.close.called)

    def test_partial_failure_keeps_station_and_marks_straight_distance(self):
        self.route.side_effect = [
            {'distance': 1400, 'duration': 240}, None,
            {'distance': 2000, 'duration': 360},
        ]
        result = main.get_recommended_stations(113.82, 34.03, 5)
        self.assertEqual([f['properties']['id'] for f in result['features']], ['b', 'a', 'c'])
        fallback = result['features'][0]['properties']
        self.assertTrue(fallback['isFallback'])
        self.assertEqual(fallback['distanceMeters'], 600.5)
        self.assertEqual(fallback['distanceSource'], 'postgis_straight')
        self.assertEqual(fallback['distanceType'], 'straight')
        self.assertEqual(fallback['distanceLabel'], '直线距离（降级估算）')
        self.assertIsNone(fallback['drivingDistanceMeters'])
        self.assertIsNone(fallback['drivingDurationSeconds'])
        self.assertEqual(result['metadata']['candidateCount'], 3)
        self.assertEqual(result['metadata']['fallbackCount'], 1)
        self.assertEqual(self.route.call_count, 3)

    def test_all_provider_failures_return_straight_distance_instead_of_empty_result(self):
        self.route.return_value = None
        result = main.get_recommended_stations(113.82, 34.03, 2)
        self.assertEqual([f['properties']['id'] for f in result['features']], ['a', 'b'])
        self.assertEqual(result['metadata']['fallbackCount'], 2)
        self.assertEqual(result['metadata']['distanceUnit'], 'meters')
        self.assertTrue(all(f['properties']['isFallback'] for f in result['features']))

    @patch.dict('os.environ', {'AMAP_WEB_KEY': ''})
    def test_missing_key_returns_fallback_without_contacting_provider(self):
        result = main.get_recommended_stations(113.82, 34.03, 5)
        self.assertEqual(len(result['features']), 3)
        self.assertEqual(result['metadata']['fallbackCount'], 3)
        self.route.assert_not_called()

    def test_empty_candidates_and_maximum_limit(self):
        self.cursor.fetchall.return_value = []
        result = main.get_recommended_stations(113.82, 34.03, 10)
        self.assertEqual(result['features'], [])
        self.assertEqual(result['metadata']['candidateCount'], 0)
        self.assertEqual(result['metadata']['fallbackCount'], 0)
        self.assertEqual(self.cursor.execute.call_args.args[1], (113.82, 34.03))
        self.route.assert_not_called()

    def test_economy_uses_full_pool_before_shortlisting_and_preserves_price_provenance(self):
        self.cursor.fetchall.return_value = [
            (f's{i}', f'站 {i}', '地址', 113.84, 34.04, i * 100,
             {'electricity_price': 2 - i / 10, 'service_price': 0,
              'charge_type': 'fast', 'available_count': 2, 'simulated_fields': ['electricityPrice']})
            for i in range(1, 16)
        ]
        self.route.return_value = None
        result = main.get_recommended_stations(113.82, 34.03, 5, mode='economy')
        self.assertEqual([f['properties']['id'] for f in result['features']], ['s15', 's14', 's13', 's12', 's11'])
        self.assertEqual(result['metadata']['candidateCount'], 10)
        self.assertEqual(result['metadata']['eligibleCount'], 15)
        self.assertEqual(self.route.call_count, 10)
        first = result['features'][0]['properties']
        self.assertEqual(first['pricePerKwh'], 0.5)
        self.assertEqual(first['simulatedFields'], ['electricityPrice'])
        self.assertEqual(first['availableCount'], 2)

    def test_optional_filters_are_parameterized_and_missing_prices_do_not_rank_as_free(self):
        self.route.return_value = None
        result = main.get_recommended_stations(113.82, 34.03, 5, mode='economy',
            radius_km=3, charge_type='fast', available_only=True, name="路' OR true --")
        self.assertEqual([f['properties']['id'] for f in result['features']], ['b', 'a', 'c'])
        sql, params = self.cursor.execute.call_args.args
        self.assertIn('ST_DWithin(s.geom::geography, u.geog, %s)', sql)
        self.assertIn('available_count', sql)
        self.assertNotIn("路' OR true --", sql)
        self.assertEqual(params, (113.82, 34.03, 3000, 'fast', "%路' OR true --%", "%路' OR true --%"))
        self.assertIsNone(result['features'][-1]['properties']['pricePerKwh'])

    def test_balanced_weight_extremes_and_candidate_cap(self):
        self.route.return_value = None
        self.cursor.fetchall.return_value = self.rows * 8
        main.get_recommended_stations(113.82, 34.03, 10, mode='balanced', distance_weight=1)
        self.assertEqual(self.route.call_count, 20)
        self.cursor.fetchall.return_value = self.rows
        result = main.get_recommended_stations(113.82, 34.03, 5, mode='balanced', distance_weight=0)
        self.assertEqual([f['properties']['id'] for f in result['features']], ['b', 'a', 'c'])
        self.assertEqual(result['metadata']['weights'], {'distance': 0, 'price': 1})


class AmapDrivingTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {'AMAP_WEB_KEY': 'test-key'})
        environment.start()
        self.addCleanup(environment.stop)
        request_patch = patch.object(main.requests, 'get')
        self.request = request_patch.start()
        self.addCleanup(request_patch.stop)
        self.response = self.request.return_value
        self.coordinates = (113.82, 34.03, 113.84, 34.04)

    def test_valid_route_and_zero_values(self):
        for distance, duration in [('1200', '240'), ('0', '0')]:
            with self.subTest(distance=distance):
                self.response.json.return_value = {
                    'status': '1', 'route': {'paths': [{'distance': distance, 'cost': {'duration': duration}}]},
                }
                self.assertEqual(main.get_amap_driving_info(*self.coordinates),
                                 {'distance': int(distance), 'duration': int(duration)})
        self.assertEqual(self.request.call_args.kwargs['timeout'], 5)

    def test_timeout_connection_http_and_json_errors_return_no_route(self):
        self.request.side_effect = main.requests.Timeout('timeout')
        self.assertIsNone(main.get_amap_driving_info(*self.coordinates))
        self.request.side_effect = main.requests.ConnectionError('offline')
        self.assertIsNone(main.get_amap_driving_info(*self.coordinates))
        self.request.side_effect = None
        self.response.raise_for_status.side_effect = main.requests.HTTPError('503')
        self.assertIsNone(main.get_amap_driving_info(*self.coordinates))
        self.response.raise_for_status.side_effect = None
        self.response.json.side_effect = ValueError('invalid JSON')
        self.assertIsNone(main.get_amap_driving_info(*self.coordinates))

    def test_failed_status_empty_paths_and_invalid_values_return_no_route(self):
        payloads = [{'status': '0', 'info': 'DAILY_QUERY_OVER_LIMIT'},
                    {'status': '1', 'route': {'paths': []}},
                    {'status': '1', 'route': None}, []]
        payloads.extend({'status': '1', 'route': {'paths': [{'distance': distance, 'cost': {'duration': duration}}]}}
                        for distance, duration in [(None, '60'), ('100', None), ('bad', '60'),
                                                  ('-1', '60'), ('100', '-1'), ('NaN', '60'),
                                                  ('100', 'Infinity'), (True, '60')])
        for payload in payloads:
            with self.subTest(payload=payload):
                self.response.json.return_value = payload
                self.assertIsNone(main.get_amap_driving_info(*self.coordinates))

    def test_invalid_coordinates_do_not_contact_provider(self):
        for coordinates in [(113.82, 91, 113.84, 34.04), (181, 34.03, 113.84, 34.04),
                            (float('nan'), 34.03, 113.84, 34.04), (True, 34.03, 113.84, 34.04)]:
            with self.subTest(coordinates=coordinates):
                self.assertIsNone(main.get_amap_driving_info(*coordinates))
        self.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
