"""只读验证真实 PostGIS 查询与 HTTP 降级结果，不请求高德。"""

import socket
import json
import threading
import time
from contextlib import closing
from unittest.mock import patch

import requests
import uvicorn

from backend import main
from backend.database import get_db_connection


def check():
    with closing(get_db_connection()) as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT ST_X(geom), ST_Y(geom), count(*) OVER ()
                FROM stations s
                WHERE geom IS NOT NULL
                    AND (to_jsonb(s)->>'status') IS DISTINCT FROM 'retired'
                ORDER BY id LIMIT 1
            """)
            row = cursor.fetchone()
    if row is None:
        raise AssertionError('需要至少一个有效站点验证真实距离')
    lng, lat, station_count = row
    with closing(get_db_connection()) as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT id, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography),
                    (to_jsonb(s)->>'electricity_price')::double precision,
                    (to_jsonb(s)->>'service_price')::double precision,
                    CASE WHEN to_jsonb(s)->>'charge_type'='fast' THEN 'fast' ELSE 'regular' END,
                    (to_jsonb(s)->>'available_count')::integer, name, address
                FROM stations s WHERE geom IS NOT NULL
                    AND (to_jsonb(s)->>'status') IS DISTINCT FROM 'retired'
            """, (lng, lat))
            pool = [{'id': station_id, 'distance': distance,
                     'price': round(electricity + service, 2) if electricity is not None and service is not None else None,
                     'type': charge_type, 'available': available, 'name': name, 'address': address}
                    for station_id, distance, electricity, service, charge_type, available, name, address in cursor.fetchall()]
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(main.app, host='127.0.0.1', port=port,
                                          log_level='error', lifespan='off'))
    with patch.dict('os.environ', {'AMAP_WEB_KEY': ''}), \
            patch.object(main, 'get_amap_driving_info', side_effect=AssertionError('禁止调用高德')) as provider:
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.05)
            assert server.started, '临时 API 未能启动'
            url = f'http://127.0.0.1:{port}/api/stations/recommended'
            response = requests.get(url, params={'lng': lng, 'lat': lat, 'limit': 5}, timeout=5)
            response.raise_for_status()
            data = response.json()
            features = data['features']
            assert len(features) == min(5, station_count)
            assert data['metadata']['candidateCount'] == min(10, station_count)
            assert data['metadata']['fallbackCount'] == len(features)
            assert data['metadata']['coordSystem'] == 'WGS84'
            distances = [feature['properties']['distanceMeters'] for feature in features]
            assert distances == sorted(distances)
            assert distances[0] < 0.0001, '当前位置与站点重合时距离应为零'
            for feature in features:
                properties = feature['properties']
                assert properties['distanceSource'] == 'postgis_straight'
                assert properties['distanceType'] == 'straight'
                assert properties['distanceLabel'] == '直线距离（降级估算）'
                assert properties['isFallback'] is True
                assert properties['distanceMeters'] == properties['straightDistanceMeters']
                assert properties['drivingDistanceMeters'] is None
                assert properties['drivingDurationSeconds'] is None
            def request(**extra):
                response = requests.get(url, params={'lng': lng, 'lat': lat, 'limit': 5, **extra}, timeout=5)
                response.raise_for_status()
                return response.json()

            distance_key = lambda station: (station['distance'], str(station['id']))
            economy_key = lambda station: (station['price'] is None,
                                           station['price'] if station['price'] is not None else float('inf'),
                                           *distance_key(station))
            for mode, weight, sort_key in [('economy', 0.5, economy_key), ('balanced', 0, economy_key),
                                           ('balanced', 1, distance_key)]:
                result = request(mode=mode, distance_weight=weight)
                assert [f['properties']['id'] for f in result['features']] == [s['id'] for s in sorted(pool, key=sort_key)[:5]]
                assert result['metadata']['eligibleCount'] == station_count
                for feature in result['features']:
                    p = feature['properties']
                    if p['pricePerKwh'] is not None:
                        assert p['pricePerKwh'] == round(p['electricityPrice'] + p['servicePrice'], 2)
            eligible = [s for s in pool if s['distance'] <= 5000 and s['type'] == 'fast'
                        and (s['available'] or 0) > 0 and '充电' in f"{s['name']} {s['address']}" ]
            filtered = request(mode='economy', radius_km=5, charge_type='fast', available_only=True, name='充电')
            trip = {'currentSoc': 20, 'targetSoc': 80, 'batteryKwh': 60, 'consumptionKwh': 15,
                    'maxChargeKw': 100, 'reserveSoc': 10, 'destination': [lng, lat]}
            for intent in ('urgent', 'shopping', 'economy'):
                result = request(intent=intent, trip_context=json.dumps(trip))
                assert result['metadata']['intent'] == intent
                assert len(result['features']) <= 5
                for feature in result['features']:
                    fit = feature['properties']['tripFit']
                    assert fit['safety'] == 'unknown'
                    assert not fit['excluded']
                    assert fit['queueMinutes'] is None
                    if intent == 'urgent':
                        assert fit['totalMinutes'] is None
                    if intent == 'shopping':
                        assert fit['meetsTarget'] is None
                    if intent == 'economy':
                        assert fit['totalCost'] is None
            invalid = requests.get(url, params={'lng': lng, 'lat': lat, 'intent': 'urgent',
                'trip_context': '{"currentSoc":101}'}, timeout=5)
            assert invalid.status_code == 422
            assert filtered['metadata']['eligibleCount'] == len(eligible)
            assert [f['properties']['id'] for f in filtered['features']] == [s['id'] for s in sorted(eligible, key=economy_key)[:5]]
            assert len(request(name='不存在的站点-qa-check')['features']) == 0
            station_id = features[0]['properties']['id']
            routes_url = f'http://127.0.0.1:{port}/api/stations/{station_id}/routes'
            route_response = requests.get(routes_url, params={'lng': lng, 'lat': lat}, timeout=5)
            route_response.raise_for_status()
            route_data = route_response.json()
            assert route_data['type'] == 'FeatureCollection'
            assert route_data['features'] == [], '高德不可用时不绘制道路路线'
            assert route_data['metadata']['coordSystem'] == 'WGS84'
            assert route_data['metadata']['routeCount'] == 0
            assert route_data['metadata']['isFallback'] is True
            assert route_data['metadata']['distanceSource'] == 'postgis_straight'
            assert route_data['metadata']['straightDistanceMeters'] < 0.0001
            assert requests.get(routes_url, params={'lng': 181, 'lat': lat}, timeout=5).status_code == 422
            assert requests.get(f'http://127.0.0.1:{port}/api/stations/not-found-qa-check/routes',
                                params={'lng': lng, 'lat': lat}, timeout=5).status_code == 404
            for invalid in [{'lng': 181, 'lat': lat}, {'lng': lng, 'lat': 91},
                            {'lng': 'nan', 'lat': lat}, {'lng': lng, 'lat': lat, 'limit': 11},
                            {'lng': lng, 'lat': lat, 'mode': 'invalid'},
                            {'lng': lng, 'lat': lat, 'distance_weight': 1.1},
                            {'lng': lng, 'lat': lat, 'distance_weight': 'nan'},
                            {'lng': lng, 'lat': lat, 'radius_km': -1},
                            {'lng': lng, 'lat': lat, 'charge_type': 'invalid'}]:
                assert requests.get(url, params=invalid, timeout=5).status_code == 422
            provider.assert_not_called()
            print(f'PASS: real PostGIS / HTTP, {station_count} active stations, '
                  f'{len(features)} fallback results; distance/economy/balanced, weights, radius/type/availability/search '
                  f'({len(eligible)} eligible), route planning fallback/404, empty results, invalid parameters; no provider requests')
        finally:
            server.should_exit = True
            thread.join(timeout=5)
            assert not thread.is_alive(), '临时 API 未停止'


if __name__ == '__main__':
    check()
