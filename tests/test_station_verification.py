import csv
import json
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from backend.station_catalog import station_properties
from backend.station_verification import verification_catalog, apply_station_verification
from backend.trip_charging import rank_trip_stations

ROOT = Path(__file__).resolve().parent.parent


class StationVerificationTests(unittest.TestCase):
    def original_properties(self, station_id):
        with (ROOT / 'data/managed/existing-stations-enriched.csv').open(encoding='utf-8-sig', newline='') as stream:
            row = next(row for row in csv.DictReader(stream) if row['id'] == station_id)
        return {'id': station_id, 'name': row['name'], 'address': row['address'], 'dataSource': 'existing-poi',
                'isSynthetic': False, 'chargeType': row['chargeType'], 'openingHours': row['openingHours'],
                'availableCount': int(row['availableCount']), 'simulatedFields': json.loads(row['simulatedFields'])}

    def test_six_reviews_cover_four_basic_fields_and_keep_unknowns_separate(self):
        catalog = verification_catalog()
        self.assertEqual(len(catalog['stations']), 6)
        checked = []
        for station_id, record in catalog['stations'].items():
            fields = record['fields']
            for field in ('locationDescription', 'openingHours', 'entranceDescription', 'chargeType', 'chargingCurrentTypes'):
                self.assertIn(field, fields)
            for field in ('routingEntrance', 'coordinates', 'operationalStatus'):
                self.assertEqual(fields[field]['state'], 'unknown')
                self.assertIsNone(fields[field]['value'])
            if fields['openingHours']['state'] == 'known':
                checked.append(station_id)
        self.assertEqual(set(checked), {'B0FFJ5K41S', 'B0I1NS8N4O'})
        self.assertEqual(catalog['attempts'][0]['stationsQueried'], ['B0FFJ5K41S'])

    def test_public_facts_replace_only_their_simulated_fields_and_never_verify_realtime(self):
        for station_id in ('B0FFJ5K41S', 'B0I1NS8N4O'):
            original = self.original_properties(station_id)
            actual = apply_station_verification(deepcopy(original))
            self.assertEqual(actual['chargingCurrentTypes'], ['DC'])
            self.assertFalse(actual['chargingCurrentTypesComplete'])
            self.assertEqual(actual['openingHours'], '00:00-24:00')
            self.assertNotIn('chargeType', actual['simulatedFields'])
            self.assertNotIn('openingHours', actual['simulatedFields'])
            for field in ('availableCount', 'powerKw', 'electricityPrice'):
                self.assertIn(field, actual['simulatedFields'])
            self.assertNotIn('verifiedAt', actual)
            self.assertNotIn('availabilityIsRealtime', actual)
            self.assertIn('chargeType', original['simulatedFields'])
        hotel = apply_station_verification(self.original_properties('B0I1NS8N4O'))
        self.assertNotIn('accessPolicy', hotel)

    def test_archived_station_cannot_acquire_public_facts_from_another_station(self):
        original = self.original_properties('B0IAJL39JV')
        result = apply_station_verification(deepcopy(original))
        self.assertNotIn('chargingCurrentTypes', result)
        self.assertIn('chargeType', result['simulatedFields'])
        self.assertEqual(result['fieldVerification']['locationDescription']['state'], 'unknown')
        for changes in ({'name': '已改名站点'}, {'id': 'other-id'}, {'isSynthetic': True}, {'dataSource': 'field-survey'}):
            value = {**original, **changes}
            self.assertEqual(apply_station_verification(deepcopy(value)), value)

    def test_invalid_evidence_never_replaces_values(self):
        original = self.original_properties('B0FFJ5K41S')
        for invalid in ({'checkedAt': '2099-01-01T00:00:00Z'}, {'checkedAt': '2026-10-09T09:00:00'},
                        {'sources': []}, {'value': ''}, {'value': 'mixed'}):
            catalog = deepcopy(verification_catalog())
            catalog['stations'][original['id']]['fields']['chargeType'].update(invalid)
            with patch('backend.station_verification.verification_catalog', return_value=catalog):
                value = apply_station_verification(deepcopy(original))
            self.assertIn('chargeType', value['simulatedFields'])
            self.assertEqual(value['fieldVerification']['chargeType']['state'], 'unknown')

    def test_partial_dc_evidence_does_not_exclude_unknown_ac_support(self):
        properties = station_properties('B0FFJ5K41S', self.original_properties('B0FFJ5K41S')['name'], '', {'data_source': 'existing-poi'})
        feature = {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [113.86, 34.04]}, 'properties': properties}
        self.assertEqual(len(rank_trip_stations([feature], 'urgent', {'chargingRequirement': 'AC'})), 1)
        properties['chargingCurrentTypesComplete'] = True
        self.assertEqual(rank_trip_stations([feature], 'urgent', {'chargingRequirement': 'AC'}), [])


if __name__ == '__main__':
    unittest.main()
