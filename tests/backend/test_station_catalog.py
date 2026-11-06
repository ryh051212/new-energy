import csv
import tempfile
import unittest
from pathlib import Path

from shapely.geometry import box

from backend.generate_demo_stations import build_demo, write_csv
from backend.station_catalog import read_catalog, station_properties
from backend.complete_station_attributes import complete_properties


class StationCatalogTests(unittest.TestCase):
    def setUp(self):
        self.rows = build_demo(box(113.8, 34, 113.9, 34.1), box(113.8, 34, 113.9, 34.1), count=12)

    def read(self, rows):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'stations.csv'
            write_csv(path, rows)
            return read_catalog(path)

    def test_generator_is_reproducible_and_ids_stable(self):
        again = build_demo(box(113.8, 34, 113.9, 34.1), box(113.8, 34, 113.9, 34.1), count=12)
        self.assertEqual(self.rows, again)
        rows = self.read(self.rows)
        self.assertEqual(len(set(row['id'] for row in rows)), 12)
        self.assertTrue(all(row['isSynthetic'] and row['dataSource'] == 'synthetic' for row in rows))
        self.assertEqual(sum(row['district'] == '魏都区' for row in rows), 6)

    def test_invalid_records_are_rejected(self):
        invalid = [dict(availableCount=999), dict(totalCount=-1), dict(fastCount=1.5),
                   dict(powerKw='NaN'), dict(longitude=181), dict(coordSystem=''),
                   dict(isSynthetic='false'), dict(status='offline', availableCount=3),
                   dict(observedAt='2026-10-05T08:00:00')]
        for change in invalid:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    self.read([{**self.rows[0], **change}])
        with self.assertRaises(ValueError):
            self.read([self.rows[0], self.rows[0]])

    def test_zero_is_preserved_and_blank_is_unknown(self):
        row = {**self.rows[0], 'availableCount': 0, 'parkingFee': 0, 'powerKw': '',
               'electricityPrice': '', 'observedAt': ''}
        result = self.read([row])[0]
        self.assertEqual(result['availableCount'], 0)
        self.assertEqual(result['parkingFee'], 0)
        self.assertIsNone(result['powerKw'])
        self.assertIsNone(result['electricityPrice'])
        self.assertIsNone(result['observedAt'])

    def test_real_replacement_accepts_same_stable_id_with_explicit_provenance(self):
        result = self.read([{**self.rows[0], 'isSynthetic': 'false', 'dataSource': 'field-survey',
                             'datasetId': 'xuchang-real-2027', 'name': '实测站点'}])[0]
        self.assertFalse(result['isSynthetic'])
        self.assertEqual(result['id'], self.rows[0]['id'])

    def test_serializer_preserves_unknown_values_and_rounds_price(self):
        properties = station_properties('id', 'name', 'address', {'available_count': 0,
            'electricity_price': .58, 'service_price': .29, 'is_synthetic': True})
        self.assertEqual(properties['availableCount'], 0)
        self.assertIsNone(properties['powerKw'])
        self.assertEqual(properties['pricePerKwh'], .87)
        self.assertEqual(properties['coordSystem'], 'WGS84')
        self.assertTrue(properties['isSynthetic'])
        self.assertIsNone(station_properties('id', 'name', '', {})['pricePerKwh'])

    def test_owner_metadata_is_explicit_and_not_inferred_from_speed_or_import_time(self):
        unknown = station_properties('id', 'name', '', {'charge_type': 'fast', 'updated_at': '2026-10-09T09:00:00+08:00'})
        self.assertNotIn('chargingCurrentTypes', unknown)
        self.assertNotIn('verifiedAt', unknown)
        self.assertNotIn('availabilityUpdatedAt', unknown)
        supplied = station_properties('id', 'name', '', {'charging_current_types': ['DC'], 'verified_at': '2026-10-09T09:00:00+08:00',
            'availability_is_realtime': True, 'availability_updated_at': '2026-10-09T09:59:00+08:00'})
        self.assertEqual(supplied['chargingCurrentTypes'], ['DC'])
        self.assertTrue(supplied['availabilityIsRealtime'])
        self.assertEqual(supplied['verifiedAt'], '2026-10-09T09:00:00+08:00')

    def test_only_two_types_and_simulated_provenance_are_supported(self):
        for charge_type in ('unknown', 'mixed', ''):
            with self.subTest(charge_type=charge_type), self.assertRaises(ValueError):
                self.read([{**self.rows[0], 'chargeType': charge_type}])
        row = {**self.rows[0], 'simulatedFields': '["powerKw", "availableCount"]'}
        self.assertEqual(self.read([row])[0]['simulatedFields'], ['powerKw', 'availableCount'])
        for fields in ('{}', '["wrong"]', '["powerKw", "powerKw"]'):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.read([{**row, 'simulatedFields': fields}])
        properties = station_properties('id', 'name', 'address', {'charge_type': 'regular',
            'regular_count': 8, 'simulated_fields': ['powerKw'], 'is_synthetic': False})
        self.assertEqual(properties['chargeType'], 'regular')
        self.assertEqual(properties['regularCount'], 8)
        self.assertTrue(properties['hasSimulatedAttributes'])
        self.assertFalse(properties['isSynthetic'])
        self.assertNotIn('slowCount', properties)

    def test_completion_preserves_known_data_and_zero_and_is_idempotent(self):
        original = station_properties('real-id', '真实超充站', '已有地址', {
            'charge_type': 'unknown', 'fast_count': 8, 'regular_count': 0, 'available_count': 0,
            'parking_fee': 0, 'electricity_price': .68, 'status': 'active', 'operator': '实测运营商',
            'is_synthetic': False, 'simulated_fields': ['chargeType'],
        })
        completed = complete_properties(original, {'cityname': '许昌市', 'adname': '魏都区'})
        for field in ('id', 'name', 'address', 'operator', 'fastCount', 'regularCount', 'availableCount', 'parkingFee', 'electricityPrice', 'isSynthetic'):
            self.assertEqual(completed[field], original[field])
        self.assertEqual(completed['totalCount'], 8)
        self.assertEqual(completed['chargeType'], 'fast')
        self.assertEqual(completed['district'], '魏都区')
        self.assertNotIn('district', completed['simulatedFields'])
        self.assertNotIn('availableCount', completed['simulatedFields'])
        self.assertIn('powerKw', completed['simulatedFields'])
        self.assertEqual(complete_properties(completed), completed)
        self.assertIsNone(original['powerKw'])

    def test_completion_regular_counts_sum_and_offline_availability_is_zero(self):
        original = station_properties('real-regular', '社区站', '原地址', {'charge_type': 'regular',
            'total_count': 6, 'status': 'maintenance', 'is_synthetic': False})
        completed = complete_properties(original)
        self.assertEqual(completed['fastCount'], 0)
        self.assertEqual(completed['regularCount'], 6)
        self.assertEqual(completed['availableCount'], 0)
        self.assertEqual(completed['chargeType'], 'regular')


if __name__ == '__main__':
    unittest.main()
