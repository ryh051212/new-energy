import unittest
from shapely.geometry import Polygon, mapping
from backend.core.planning_demand import demand_model


class PopulationDemandTests(unittest.TestCase):
    def test_population_replaces_residential_poi_and_missing_stays_unknown(self):
        def grid(identifier, x, population, poi_count):
            return {'type': 'Feature', 'geometry': mapping(Polygon([(x, 34), (x+.01, 34), (x+.01, 34.01), (x, 34.01)])),
                    'properties': {'id': identifier, 'populationModelCount': population, 'residentialCount': poi_count}}
        features, locations = demand_model([grid(1, 113, 100, 500), grid(2, 113.02, 200, 1),
                                             grid(3, 113.04, None, 999)], [], 'weekday-night')
        self.assertAlmostEqual(features[0]['properties']['scenarioActivityDemand']['residential'], .5)
        self.assertAlmostEqual(features[1]['properties']['scenarioActivityDemand']['residential'], 1)
        self.assertIsNone(features[2]['properties']['scenarioActivityDemand']['residential'])
        self.assertTrue(all(location['fallback'] for location in locations))


if __name__ == '__main__':
    unittest.main()
