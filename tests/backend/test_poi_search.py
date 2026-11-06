import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from backend import poi_search
from tests.backend.test_auth_cors import asgi_request


class PoiSearchTests(unittest.TestCase):
    def setUp(self):
        self.patch = patch.object(poi_search, 'get_db_connection')
        self.connect = self.patch.start()
        self.addCleanup(self.patch.stop)
        self.cursor = self.connect.return_value.cursor.return_value.__enter__.return_value
        self.cursor.fetchone.return_value = tuple(table for table, _ in poi_search.SOURCES)
        self.cursor.fetchall.return_value = [('lib-1', '图书馆', '测试路', 113.83, 34.04, 'school', 'facility_pois', False)]

    def test_query_uses_formal_geometry_scope_name_order_and_parameter_binding(self):
        rows = poi_search.search_pois(' 图书 ')
        sql, params = self.cursor.execute.call_args.args
        self.assertEqual(params, ('%图书%', 20))
        for expected in ('ST_X(geom)', 'ST_Y(geom)', 'ST_SRID(p.geom)=4326', 'ST_Covers', 'ORDER BY name,id,source', 'DISTINCT ON', 'retired'):
            self.assertIn(expected, sql)
        self.assertNotIn('图书', sql)
        self.assertEqual(rows[0]['coordinates'], [113.83, 34.04])
        self.assertEqual(rows[0]['id'], 'facility_pois:lib-1')
        self.assertEqual(rows[0]['coordSystem'], 'WGS84')
        self.connect.return_value.close.assert_called_once()

    def test_contains_treats_sql_wildcards_and_quotes_as_literal_input(self):
        query = "50%_O'Reilly\\"
        poi_search.search_pois(query)
        sql, params = self.cursor.execute.call_args.args
        self.assertEqual(params[0], "%50\\%\\_O'Reilly\\\\%")
        self.assertNotIn(query, sql)

    def test_empty_keyword_does_not_query_and_missing_optional_catalog_keeps_old_data(self):
        self.assertEqual(poi_search.search_pois('   '), [])
        self.connect.assert_not_called()
        self.cursor.fetchone.return_value = ('stations', 'residential_pois', 'commercial_pois', None)
        poi_search.search_pois('充电')
        self.assertNotIn('FROM facility_pois', self.cursor.execute.call_args.args[0])

    def test_unknown_coordinates_are_rejected_and_virtual_flag_is_preserved(self):
        self.cursor.fetchall.return_value += [
            ('bad', '错误点', '', float('nan'), 34, 'station', 'stations', False),
            ('demo', '虚拟站', '', 113.84, 34.04, 'station', 'stations', True),
        ]
        rows = poi_search.search_pois('站')
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[1]['isSynthetic'])
        self.assertIsNone(poi_search.serialize_poi(('x', 'x', '', True, 34, 'station', 'stations', False)))

    def test_connection_is_closed_on_query_failure_and_no_tables_is_unavailable(self):
        self.cursor.execute.side_effect = RuntimeError('query failed')
        with self.assertRaises(RuntimeError):
            poi_search.search_pois('图书')
        self.connect.return_value.close.assert_called_once()
        self.cursor.execute.side_effect = None
        self.cursor.fetchone.return_value = (None, None, None, None)
        with self.assertRaises(HTTPException) as raised:
            poi_search.search_pois('图书')
        self.assertEqual(raised.exception.status_code, 503)

    def test_read_only_http_contract_and_input_limits(self):
        app = FastAPI()
        app.include_router(poi_search.router)
        async def check():
            status, _, body, _ = await asgi_request(app, '/api/pois')
            self.assertEqual((status, json.loads(body)), (200, []))
            for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
                status, _, _, _ = await asgi_request(app, '/api/pois', method=method)
                self.assertEqual(status, 405)
            for query in ('q=' + 'a' * 121, 'q=x&limit=51', 'q=x&limit=0'):
                async def with_query(scope, receive, send):
                    scope = {**scope, 'query_string': query.encode()}
                    await app(scope, receive, send)
                status, _, _, _ = await asgi_request(with_query, '/api/pois')
                self.assertEqual(status, 422)
        asyncio.run(check())
