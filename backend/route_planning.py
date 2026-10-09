"""按需获取真实驾车路线；仅返回高德提供的有效、不同的方案。"""

import math
import os
import requests

if __package__:
    from .coordinate_transform import gcj02_to_wgs84
else:
    from coordinate_transform import gcj02_to_wgs84


def get_amap_routes(origin_lng, origin_lat, destination_lng, destination_lat):
    """输入 GCJ-02，输出最多三条 WGS84 LineString，失败返回空列表。"""
    def number(value):
        if isinstance(value, bool):
            raise ValueError('布尔值不是路线数值')
        value = float(value)
        if not math.isfinite(value) or value < 0:
            raise ValueError('无效路线数值')
        return value

    try:
        key = os.getenv('AMAP_WEB_KEY')
        if not key:
            return []
        for value, bound in zip((origin_lng, origin_lat, destination_lng, destination_lat), (180, 90, 180, 90)):
            if isinstance(value, bool) or not math.isfinite(value) or abs(value) > bound:
                return []
        response = requests.get('https://restapi.amap.com/v5/direction/driving', params={
            'key': key, 'origin': f'{origin_lng:.6f},{origin_lat:.6f}',
            'destination': f'{destination_lng:.6f},{destination_lat:.6f}',
            'strategy': 32, 'show_fields': 'cost,polyline',
        }, timeout=5)
        response.raise_for_status()
        data = response.json()
        if data.get('status') != '1':
            return []
        routes, seen = [], set()
        for path in data.get('route', {}).get('paths', []):
            try:
                distance = number(path['distance'])
                duration = number(path['cost']['duration'])
                coordinates, roads = [], []
                for step in path['steps']:
                    segment = []
                    for pair in step['polyline'].split(';'):
                        point = tuple(float(value) for value in pair.split(','))
                        if len(point) != 2 or not all(math.isfinite(value) and abs(value) <= bound for value, bound in zip(point, (180, 90))):
                            raise ValueError('无效路线坐标')
                        segment.append(point)
                    if len(segment) < 2:
                        raise ValueError('路段缺少坐标')
                    for point in segment:
                        if not coordinates or point != coordinates[-1]:
                            coordinates.append(point)
                    road = step.get('road_name')
                    if isinstance(road, str) and road and road not in roads:
                        roads.append(road)
                fingerprint = tuple(coordinates)
                if len(coordinates) < 2 or fingerprint in seen:
                    continue
                try:
                    tolls = number(path['cost'].get('tolls'))
                except (TypeError, ValueError):
                    tolls = None
                seen.add(fingerprint)
                routes.append({'type': 'Feature', 'geometry': {'type': 'LineString',
                    'coordinates': [list(gcj02_to_wgs84(*point)) for point in coordinates]},
                    'properties': {'routeId': str(len(routes) + 1),
                        'routeLabel': '高德推荐' if not routes else f'备选路线 {len(routes) + 1}',
                        'distanceMeters': distance, 'drivingDistanceMeters': distance,
                        'durationSeconds': duration, 'drivingDurationSeconds': duration,
                        'tollsYuan': tolls, 'roads': roads[:3], 'distanceType': 'driving',
                        'distanceSource': 'amap_driving', 'distanceLabel': '驾车距离', 'isFallback': False}})
                if len(routes) == 3:
                    break
            except (TypeError, ValueError, KeyError, AttributeError):
                continue
        return routes
    except Exception as error:
        # 请求异常可能包含 Key，避免记录 URL 或异常正文。
        print('驾车路线方案不可用：', type(error).__name__)
        return []
