import json
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
from backend import main
from backend.trip_charging import evaluate_trip_station, rank_trip_stations

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/trip-charging.json').read_text(encoding='utf8'))


class TripChargingTests(unittest.TestCase):
    def test_destination_mode_uses_activity_duration_and_keeps_shopping_compatibility(self):
        features, context = FIXTURE['features'], FIXTURE['context']
        new = rank_trip_stations(features, 'destination', {**context, 'stayMinutes': 60})
        old = rank_trip_stations(features, 'shopping', context)
        self.assertEqual([f['properties']['id'] for f in new], [f['properties']['id'] for f in old])
        self.assertEqual(new[0]['properties']['tripFit']['stayChargedEnergyKwh'], old[0]['properties']['tripFit']['shoppingChargedEnergyKwh'])
        short = evaluate_trip_station(features[1], 'destination', {**context, 'stayMinutes': 5})
        self.assertFalse(short['meetsTarget'])
        self.assertLess(short['projectedSoc'], 80)
        long = evaluate_trip_station(features[1], 'destination', {**context, 'stayMinutes': 90})
        self.assertTrue(long['meetsTarget'])
        self.assertEqual(long['projectedSoc'], 80)

    def test_shared_scenarios_rank_for_trip_instead_of_distance(self):
        features, context = FIXTURE['features'], FIXTURE['context']
        for intent, expected in [('urgent', ['shopping-fast', 'far-superfast', 'near-slow']),
                                 ('shopping', ['shopping-fast', 'near-slow']),
                                 ('economy', ['shopping-fast', 'far-superfast', 'near-slow'])]:
            self.assertEqual([f['properties']['id'] for f in rank_trip_stations(features, intent, context)], expected)
        urgent = evaluate_trip_station(features[1], 'urgent', context)
        self.assertEqual((urgent['arrivalSoc'], urgent['chargeEnergyKwh'], urgent['chargeMinutes'], urgent['totalMinutes']), (19.5, 36.3, 30.25, 39.25))
        shopping = evaluate_trip_station(features[1], 'shopping', context)
        self.assertTrue(shopping['meetsTarget'])
        self.assertEqual(shopping['projectedSoc'], 80)
        economy = evaluate_trip_station(features[2], 'economy', context)
        self.assertEqual((economy['extraKm'], economy['extraEnergyCost'], economy['extraTolls'], economy['totalCost']), (4, .18, 8, 89.18))

    def test_unknown_and_zero_are_distinct_and_unsafe_stations_are_excluded(self):
        feature, context = FIXTURE['features'][1], FIXTURE['context']
        fallback = {**feature, 'properties': {**feature['properties'], 'distanceType': 'straight', 'isFallback': True}}
        fit = evaluate_trip_station(fallback, 'urgent', {**context, 'queueMinutes': None})
        self.assertEqual(fit['safety'], 'unknown')
        self.assertIsNone(fit['totalMinutes'])
        for changes in [{'parkingFee': None}, {'drivingTollsYuan': None}, {'tripRoute': {}}]:
            changed = {**feature, 'properties': {**feature['properties'], **changes}}
            self.assertIsNone(evaluate_trip_station(changed, 'economy', context)['totalCost'])
        for changes in [{'status': 'maintenance'}, {'vehicleCompatible': False}, {'drivingDistanceMeters': 100000}]:
            changed = {**feature, 'properties': {**feature['properties'], **changes}}
            self.assertEqual(rank_trip_stations([changed], 'urgent', context), [])
        changed = {**feature, 'properties': {**feature['properties'], 'estimatedWaitMinutes': 0}}
        self.assertEqual(evaluate_trip_station(changed, 'urgent', context)['queueMinutes'], 0)


class TripRecommendationApiTests(unittest.TestCase):
    def test_explicit_current_mismatch_is_excluded_without_guessing_from_fast_charge(self):
        station = {'properties': {'chargingCurrentTypes': ['AC']}}
        self.assertEqual(rank_trip_stations([station], 'urgent', {'chargingRequirement': 'DC'}), [])
        self.assertFalse(evaluate_trip_station({'properties': {'chargeType': 'fast'}}, 'urgent', {'chargingRequirement': 'AC'})['excluded'])
        station['properties']['simulatedFields'] = ['chargingCurrentTypes']
        self.assertFalse(evaluate_trip_station(station, 'urgent', {'chargingRequirement': 'DC'})['excluded'])

    @patch.dict('os.environ', {'AMAP_WEB_KEY': 'test-key'})
    @patch.object(main, 'get_amap_driving_info')
    @patch.object(main, 'get_db_connection')
    def test_full_pool_shortlist_uses_charging_time_and_then_real_road_reachability(self, connect, driving):
        rows = [(str(i), f'站 {i}', '', 113.84, 34.04, i * 100, {'power_kw': 7 if i < 15 else 120}) for i in range(1, 16)]
        connect.return_value.cursor.return_value.fetchall.return_value = rows
        driving.return_value = {'distance': 2000, 'duration': 240, 'tolls': 0}
        result = main.get_recommended_stations(113.82, 34.03, 5, intent='urgent', trip_context=json.dumps(FIXTURE['context']))
        self.assertEqual(result['features'][0]['properties']['id'], '15')
        self.assertEqual(result['features'][0]['properties']['tripFit']['totalMinutes'], 39.25)
        self.assertEqual(result['metadata']['eligibleCount'], 15)
        self.assertEqual(driving.call_count, 10)
        driving.return_value = {'distance': 100000, 'duration': 240, 'tolls': 0}
        result = main.get_recommended_stations(113.82, 34.03, 5, intent='urgent', trip_context=json.dumps(FIXTURE['context']))
        self.assertEqual(result['features'], [])
        self.assertEqual(result['metadata']['excludedCount'], 10)

    @patch.dict('os.environ', {'AMAP_WEB_KEY': 'test-key'})
    @patch.object(main, 'get_amap_driving_info')
    @patch.object(main, 'get_db_connection')
    def test_economy_requests_direct_and_onward_road_legs_and_marks_missing_tolls(self, connect, driving):
        connect.return_value.cursor.return_value.fetchall.return_value = [('one', '站', '', 113.83, 34.04, 1000,
            {'power_kw': 120, 'electricity_price': .8, 'service_price': .2, 'parking_fee': 0})]
        driving.return_value = {'distance': 2000, 'duration': 240, 'tolls': 0}
        result = main.get_recommended_stations(113.82, 34.03, 5, intent='economy', trip_context=json.dumps(FIXTURE['context']))
        fit = result['features'][0]['properties']['tripFit']
        self.assertEqual(fit['totalCost'], 40.33)
        self.assertEqual(driving.call_count, 3)
        driving.assert_any_call(*main.wgs84_to_gcj02(113.82, 34.03), *main.wgs84_to_gcj02(113.84, 34.04))
        driving.assert_any_call(*main.wgs84_to_gcj02(113.83, 34.04), *main.wgs84_to_gcj02(113.84, 34.04))
        driving.return_value = {'distance': 2000, 'duration': 240}
        result = main.get_recommended_stations(113.82, 34.03, 5, intent='economy', trip_context=json.dumps(FIXTURE['context']))
        self.assertIsNone(result['features'][0]['properties']['tripFit']['totalCost'])

    @patch.dict('os.environ', {'AMAP_WEB_KEY': ''})
    @patch.object(main, 'get_db_connection')
    def test_http_validates_trip_input_before_database_and_allows_partial_context(self, connect):
        for value in ['bad-json', '[]', '{"currentSoc":101}', '{"batteryKwh":0}', '{"destination":[200,0]}']:
            with self.assertRaises(HTTPException) as raised:
                main.get_recommended_stations(113.82, 34.03, 5, intent='urgent', trip_context=value)
            self.assertEqual(raised.exception.status_code, 422)
        connect.assert_not_called()
        connect.return_value.cursor.return_value.fetchall.return_value = [('one','站','',113.83,34.04,1000,{'power_kw':120})]
        response = main.get_recommended_stations(113.82, 34.03, 5, intent='urgent')
        self.assertEqual(response['features'][0]['properties']['tripFit']['safety'], 'unknown')
        response = main.get_recommended_stations(113.82, 34.03, 5, intent='destination', trip_context=json.dumps(FIXTURE['context']))
        self.assertEqual(response['metadata']['intent'], 'destination')
