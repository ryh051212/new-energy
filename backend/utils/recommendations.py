"""距离与费用排序；50/50 为本项目可调整默认权重。"""

import math


def rank_recommendations(features, mode='distance', distance_weight=0.5):
    def valid(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0

    distances = [f['properties']['distanceMeters'] for f in features]
    prices = [f['properties'].get('pricePerKwh') for f in features]
    prices = [value for value in prices if valid(value)]

    def normalize(value, values):
        if not valid(value) or not values:
            return 1.0
        minimum, maximum = min(values), max(values)
        return (value - minimum) / (maximum - minimum) if maximum > minimum else 0.0

    ranked = []
    for feature in features:
        properties = feature['properties']
        distance = properties['distanceMeters']
        price = properties.get('pricePerKwh')
        distance_cost = normalize(distance, distances)
        price_cost = normalize(price, prices)
        cost = distance_weight * distance_cost + (1 - distance_weight) * price_cost
        ranked.append({**feature, 'properties': {**properties,
            'rankingMode': mode, 'recommendationScore': round(100 * (1 - cost), 1),
            'rankingReason': {'distance': '距离更近', 'economy': '电费＋服务费更低',
                              'balanced': '距离与费用综合考虑'}[mode],
            '_rankingCost': cost,
        }})

    def key(feature):
        p = feature['properties']
        price = p.get('pricePerKwh')
        unknown = not valid(price)
        tie = (p['distanceMeters'], p['straightDistanceMeters'], str(p['id']))
        if mode == 'economy':
            return (unknown, price if not unknown else math.inf, *tie)
        if mode == 'balanced':
            return (unknown and distance_weight < 1, p['_rankingCost'], *tie)
        return tie

    ranked.sort(key=key)
    for feature in ranked:
        feature['properties'].pop('_rankingCost')
    return ranked
