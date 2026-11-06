import unittest
from copy import deepcopy

from backend.recommendations import rank_recommendations


def station(station_id, distance, price):
    return {'type': 'Feature', 'properties': {'id': station_id, 'distanceMeters': distance,
            'straightDistanceMeters': distance, 'pricePerKwh': price}}


class RecommendationRankingTests(unittest.TestCase):
    def test_modes_and_extreme_weights_choose_the_expected_tradeoff(self):
        features = [station('near', 100, 3), station('middle', 200, 1.5), station('cheap', 1000, 0.5)]
        self.assertEqual(rank_recommendations(features, 'distance')[0]['properties']['id'], 'near')
        self.assertEqual(rank_recommendations(features, 'economy')[0]['properties']['id'], 'cheap')
        self.assertEqual(rank_recommendations(features, 'balanced')[0]['properties']['id'], 'middle')
        for weight, expected in [(0, 'cheap'), (1, 'near')]:
            self.assertEqual(rank_recommendations(features, 'balanced', weight)[0]['properties']['id'], expected)

    def test_missing_invalid_and_zero_prices_are_distinct(self):
        features = [station('missing', 0, None), station('paid', 100, 1), station('free', 200, 0),
                    station('invalid', 10, float('nan')), station('negative', 5, -1)]
        for mode in ['economy', 'balanced']:
            ids = [f['properties']['id'] for f in rank_recommendations(features, mode, 0)]
            self.assertEqual(ids[:2], ['free', 'paid'])
        self.assertEqual(rank_recommendations(features, 'balanced', 1)[0]['properties']['id'], 'missing')

    def test_empty_and_equal_values_have_finite_scores_and_do_not_mutate_inputs(self):
        self.assertEqual(rank_recommendations([], 'balanced'), [])
        features = [station('b', 0, 0), station('a', 0, 0)]
        original = deepcopy(features)
        ranked = rank_recommendations(features, 'balanced')
        self.assertEqual([f['properties']['id'] for f in ranked], ['a', 'b'])
        self.assertTrue(all(f['properties']['recommendationScore'] == 100 for f in ranked))
        self.assertEqual(features, original)
