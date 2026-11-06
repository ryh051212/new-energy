import asyncio
import json
import os
import unittest
from unittest.mock import patch

from fastapi import Depends, FastAPI
from backend import auth, security


async def asgi_request(app, path, method='GET', origin='http://localhost:5174', body=None, cookie='', extra=()):
    sent = []
    headers = [(b'host', b'127.0.0.1:8000')]
    if origin:
        headers.append((b'origin', origin.encode()))
    if cookie:
        headers.append((b'cookie', cookie.encode()))
    raw = json.dumps(body).encode() if body is not None else b''
    if body is not None:
        headers.append((b'content-type', b'application/json'))
    headers.extend((name.lower().encode(), value.encode()) for name, value in extra)
    received = False

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {'type': 'http.request', 'body': raw, 'more_body': False}
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message)

    scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': method,
             'path': path, 'raw_path': path.encode(), 'root_path': '', 'query_string': b'',
             'headers': headers, 'client': ('127.0.0.1', 4321), 'server': ('127.0.0.1', 8000), 'scheme': 'http'}
    try:
        await app(scope, receive, send)
    except RuntimeError:
        if not sent:
            raise
    start = next(message for message in sent if message['type'] == 'http.response.start')
    raw_headers = [(key.decode(), value.decode()) for key, value in start['headers']]
    data = b''.join(message.get('body', b'') for message in sent if message['type'] == 'http.response.body')
    return start['status'], dict(raw_headers), data, raw_headers


class CorsAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'ADMIN_USERNAME': 'admin', 'ADMIN_PASSWORD': 'test-password-123'})
        self.environment.start()
        auth._credentials.cache_clear()
        auth._sessions.clear()
        auth._attempts.clear()
        api = FastAPI()
        api.include_router(auth.router)

        @api.get('/protected', dependencies=[Depends(auth.require_session)])
        def protected():
            return {'ok': True}

        @api.get('/broken')
        def broken():
            raise RuntimeError('controlled failure')

        self.app = security.with_cors(api)

    def tearDown(self):
        auth._sessions.clear()
        auth._attempts.clear()
        auth._credentials.cache_clear()
        self.environment.stop()

    def call(self, path, **kwargs):
        return asyncio.run(asgi_request(self.app, path, **kwargs))

    def test_preflight_allows_json_credentials_from_dev_and_preview(self):
        for origin in ('http://localhost:5174', 'http://127.0.0.1:4173'):
            status, headers, _, _ = self.call('/api/auth/login', method='OPTIONS', origin=origin,
                extra=[('Access-Control-Request-Method', 'POST'), ('Access-Control-Request-Headers', 'content-type')])
            self.assertEqual(status, 200)
            self.assertEqual(headers['access-control-allow-origin'], origin)
            self.assertEqual(headers['access-control-allow-credentials'], 'true')

    def test_untrusted_origin_is_denied_by_preflight_and_auth(self):
        origin = 'https://unrelated.example'
        status, headers, _, _ = self.call('/api/auth/login', method='OPTIONS', origin=origin,
                                        extra=[('Access-Control-Request-Method', 'POST')])
        self.assertEqual(status, 400)
        self.assertNotIn('access-control-allow-origin', headers)
        status, _, _, _ = self.call('/api/auth/login', method='POST', origin=origin,
                                    body={'username': 'admin', 'password': 'test-password-123'})
        self.assertEqual(status, 403)

    def test_login_cookie_protects_api_and_logout_revokes_it(self):
        self.assertEqual(self.call('/protected')[0], 401)
        status, headers, _, raw = self.call('/api/auth/login', method='POST',
                                            body={'username': 'admin', 'password': 'test-password-123'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['access-control-allow-origin'], 'http://localhost:5174')
        cookie = [value for key, value in raw if key == 'set-cookie'][-1].split(';')[0]
        self.assertEqual(self.call('/protected', cookie=cookie)[0], 200)
        self.assertEqual(self.call('/api/auth/authorize', cookie=cookie)[0], 200)
        self.assertEqual(self.call('/api/auth/logout', method='POST', cookie=cookie, body={})[0], 200)
        self.assertEqual(self.call('/protected', cookie=cookie)[0], 401)

    def test_cors_headers_survive_auth_errors_and_unhandled_server_error(self):
        for path, expected in (('/api/auth/authorize', 401), ('/broken', 500)):
            status, headers, _, _ = self.call(path)
            self.assertEqual(status, expected)
            self.assertEqual(headers['access-control-allow-origin'], 'http://localhost:5174')
            self.assertEqual(headers['access-control-allow-credentials'], 'true')

    def test_custom_origins_are_explicit_and_wildcards_are_rejected(self):
        with patch.dict(os.environ, {'CORS_ALLOWED_ORIGINS': 'https://planner.example, https://planner.example/'}):
            self.assertEqual(security.allowed_origins(), ('https://planner.example',))
        for value in ('*', 'https://*.example', 'https://example/path', 'null'):
            with patch.dict(os.environ, {'CORS_ALLOWED_ORIGINS': value}):
                with self.assertRaises(ValueError):
                    security.allowed_origins()


if __name__ == '__main__':
    unittest.main()
