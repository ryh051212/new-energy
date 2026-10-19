import json
import unittest
from copy import deepcopy
from pathlib import Path
from backend.station_access import access_guides, station_access_guide, route_destination
from backend.station_catalog import station_properties
from backend.coordinate_transform import wgs84_to_gcj02


class StationAccessTests(unittest.TestCase):
    def test_six_real_pois_have_scoped_evidence_and_no_fabricated_entrance_coordinates(self):
        raw = json.loads((Path(__file__).parent.parent / 'data/raw/amap-stations.json').read_text(encoding='utf-8-sig'))
        names = {poi['id']: poi['name'] for poi in raw['pois']}
        guides = access_guides()
        self.assertEqual(len(guides), 6)
        for station_id, guide in guides.items():
            self.assertEqual(guide['stationName'], names[station_id])
            self.assertIsNone(guide['routingEntrance'])
            self.assertIn('尚未现场核验', guide['notice'])
            self.assertNotIn('verifiedAt', guide)
        self.assertIn('B1', guides['B0FFJ5K41S']['location'])
        self.assertIn('建安大道', guides['B0FFJ5K41S']['entrance'])
        self.assertIn('负二层北侧 S 区', guides['B0M6M6U9DP']['location'])
        self.assertEqual(guides['B0M6M6U9DP']['evidenceStatus'], 'archived_poi')

    def test_guides_require_id_name_and_real_station_match_and_do_not_verify_other_attributes(self):
        station_id = 'B0FFJ5K41S'
        guide = access_guides()[station_id]
        self.assertIsNone(station_access_guide(station_id, '另一个站点'))
        self.assertIsNone(station_access_guide(station_id, guide['stationName'], True))
        self.assertIsNone(station_access_guide('unknown', guide['stationName']))
        copy = station_access_guide(station_id, guide['stationName'])
        copy['location'] = 'changed'
        self.assertNotEqual(copy['location'], access_guides()[station_id]['location'])
        properties = station_properties(station_id, guide['stationName'], '', {'simulated_fields': ['pricePerKwh']})
        self.assertIn('accessGuide', properties)
        self.assertNotIn('verifiedAt', properties)
        self.assertNotIn('availabilityUpdatedAt', properties)

    def test_only_explicit_vehicle_entrance_changes_route_destination_with_coordinate_conversion(self):
        station = [113.84, 34.04]
        entrance = {'kind': 'vehicle_entrance', 'coordinates': [113.841, 34.04], 'coordSystem': 'WGS84',
                    'sourceUrl': 'https://ditu.amap.com/place/test', 'checkedAt': '2026-10-09T01:00:00+08:00'}
        target = route_destination({'routingEntrance': entrance}, station)
        self.assertEqual(target['coordinates'], entrance['coordinates'])
        self.assertEqual(target['kind'], 'vehicle_entrance')
        gcj = {**entrance, 'coordSystem': 'GCJ-02', 'coordinates': list(wgs84_to_gcj02(*entrance['coordinates']))}
        converted = route_destination({'routingEntrance': gcj}, station)['coordinates']
        self.assertAlmostEqual(converted[0], entrance['coordinates'][0], places=6)
        for invalid in [{}, {'kind': 'pedestrian_entrance'}, {'coordinates': [0, 0]}, {'coordinates': [True, 34]},
                        {'sourceUrl': None}, {'checkedAt': None}, {'checkedAt': '2099-01-01T00:00:00Z'}, {'coordSystem': None}]:
            changed = {} if invalid == {} else {**deepcopy(entrance), **invalid}
            self.assertEqual(route_destination({'routingEntrance': changed}, station)['coordinates'], station)
        self.assertEqual(route_destination({'entrance': '入口在东侧'}, station)['kind'], 'station_location')
