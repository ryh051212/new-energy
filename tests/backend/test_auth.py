import os
from http.cookies import SimpleCookie
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Request, Response
from pydantic import ValidationError
from backend import auth

TEST_PASSWORD = 'test-password-123'

def request(token="", origin="http://127.0.0.1:5173"):
    headers = [(b"origin", origin.encode())] if origin else []
    if token:
        headers.append((b"cookie", f"{auth.COOKIE_NAME}={token}".encode()))
    return Request({"type": "http", "method": "POST", "path": "/api/auth/login",
                    "headers": headers, "client": ("127.0.0.1", 12345), "scheme": "http"})


class AuthenticationTests(unittest.TestCase):
    def test_login_policy_is_enforced_server_side(self):
        for username in ['abcdefghi','admin1','张三','']:
            with self.assertRaises(ValidationError):auth.LoginCredentials(username=username,password=TEST_PASSWORD)
        for password in ['short1','abcdefgh','12345678']:
            with self.assertRaises(ValidationError):auth.LoginCredentials(username='admin',password=password)
        self.assertEqual(auth.LoginCredentials(username='Abcdefgh',password='Pass1234').username,'Abcdefgh')

    def test_quick_login_is_opt_in_and_local_only(self):
        def local_request(host='127.0.0.1:5173', client='127.0.0.1', origin='http://127.0.0.1:5173'):
            return Request({'type':'http','method':'POST','path':'/api/auth/quick-login','scheme':'http',
                'headers':[(b'host',host.encode()),(b'origin',origin.encode())],'client':(client,12345)})
        with patch.dict(os.environ,{'AUTH_LOCAL_QUICK_LOGIN':'false'}):
            with self.assertRaises(HTTPException):auth.quick_login(local_request(),Response())
        with patch.dict(os.environ,{'AUTH_LOCAL_QUICK_LOGIN':'true'}):
            result=auth.quick_login(local_request(),Response())
            self.assertTrue(result['authenticated'])
            for req in [local_request(host='192.168.1.3:5173'),local_request(client='192.168.1.3'),local_request(origin='https://example.org')]:
                with self.assertRaises(HTTPException):auth.quick_login(req,Response())

    def setUp(self):
        self.environment = patch.dict(os.environ, {"ADMIN_USERNAME": "admin", "ADMIN_PASSWORD": TEST_PASSWORD, "AUTH_COOKIE_SECURE": "false"})
        self.environment.start()
        auth._credentials.cache_clear()
        auth._sessions.clear()
        auth._attempts.clear()

    def tearDown(self):
        auth._sessions.clear()
        auth._attempts.clear()
        auth._credentials.cache_clear()
        self.environment.stop()

    def login(self, username="admin", password=TEST_PASSWORD, token=""):
        response = Response()
        result = auth.login(auth.LoginCredentials(username=username, password=password), request(token), response)
        cookie = SimpleCookie(response.headers.getlist("set-cookie")[-1])[auth.COOKIE_NAME]
        return result, cookie, response

    def test_guest_and_forged_cookie_do_not_authenticate(self):
        for token in ("", "admin", "forged-session-token"):
            response = Response()
            result = auth.get_session(request(token), response)
            self.assertEqual(result, {"authenticated": False, "user": None, "expiresAt": None})
            self.assertEqual(response.headers["cache-control"], "no-store")

    def test_default_login_uses_httponly_cookie_and_server_session(self):
        result, cookie, response = self.login()
        self.assertEqual(result["user"], {"username": "admin"})
        self.assertTrue(result["authenticated"])
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "lax")
        self.assertEqual(cookie["path"], "/api")
        self.assertEqual(int(cookie["max-age"]), auth.SESSION_SECONDS)
        self.assertNotIn(cookie.value, auth._sessions)
        self.assertEqual(auth.get_session(request(cookie.value), Response()), result)
        self.assertNotIn("password", str(result))

    def test_wrong_username_and_password_are_rejected(self):
        for username, password in (("admin", "wrongpass123"), ("other", TEST_PASSWORD), ("Admin", TEST_PASSWORD)):
            with self.assertRaises(HTTPException) as error:
                self.login(username, password)
            self.assertEqual(error.exception.status_code, 401)
        self.assertFalse(auth._sessions)

    def test_logout_revokes_cookie_and_prevents_replay(self):
        _, cookie, _ = self.login()
        response = Response()
        self.assertFalse(auth.logout(request(cookie.value), response)["authenticated"])
        self.assertIn("Max-Age=0", response.headers["set-cookie"])
        self.assertFalse(auth.get_session(request(cookie.value), Response())["authenticated"])

    def test_expiry_removes_session(self):
        _, cookie, _ = self.login()
        with patch.object(auth.time, "time", return_value=auth._sessions[auth._session_key(cookie.value)]["expires"] + 1):
            self.assertFalse(auth.get_session(request(cookie.value), Response())["authenticated"])
        self.assertFalse(auth._sessions)

    def test_login_rotates_existing_session(self):
        _, first, _ = self.login()
        _, second, _ = self.login(token=first.value)
        self.assertNotEqual(first.value, second.value)
        self.assertFalse(auth.get_session(request(first.value), Response())["authenticated"])
        self.assertTrue(auth.get_session(request(second.value), Response())["authenticated"])

    def test_cross_origin_login_and_logout_rejected(self):
        with self.assertRaises(HTTPException) as error:
            auth.login(auth.LoginCredentials(username="admin", password=TEST_PASSWORD), request(origin="https://unrelated.example"), Response())
        self.assertEqual(error.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            auth.logout(request(origin="https://unrelated.example"), Response())
        self.assertFalse(auth._sessions)

    def test_repeated_failures_are_rate_limited(self):
        with patch.object(auth, "_credentials", return_value=("admin", b"salt", b"incorrect-hash")):
            with patch.object(auth.hashlib, "pbkdf2_hmac", return_value=b"actual-hash"):
                for _ in range(8):
                    with self.assertRaises(HTTPException) as error:
                        self.login(password="wrongpass123")
                    self.assertEqual(error.exception.status_code, 401)
                with self.assertRaises(HTTPException) as error:
                    self.login()
                self.assertEqual(error.exception.status_code, 429)

    def test_admin_credentials_can_be_configured(self):
        with patch.dict(os.environ, {"ADMIN_USERNAME": "planner", "ADMIN_PASSWORD": "different-password-123"}):
            result, _, _ = self.login("planner", "different-password-123")
            self.assertEqual(result["user"]["username"], "planner")

    def test_missing_or_weak_admin_password_fails_closed(self):
        for password in ('', '123456'):
            with patch.dict(os.environ, {'ADMIN_PASSWORD': password}):
                auth._credentials.cache_clear()
                with self.assertRaises(HTTPException) as error:
                    self.login()
                self.assertEqual(error.exception.status_code, 503)
        self.assertFalse(auth._sessions)

    def test_authorization_rejects_missing_and_expired_sessions(self):
        with self.assertRaises(HTTPException) as error:
            auth.require_session(request(), Response())
        self.assertEqual(error.exception.status_code, 401)
        _, cookie, _ = self.login()
        response = Response()
        session = auth.require_session(request(cookie.value), response)
        self.assertEqual(session['username'], 'admin')
        self.assertEqual(response.headers['cache-control'], 'no-store')

    def test_secure_cookie_and_legacy_cookie_cleanup(self):
        with patch.dict(os.environ, {'AUTH_COOKIE_SECURE': 'true'}):
            _, cookie, response = self.login()
            self.assertTrue(cookie['secure'])
            self.assertIn('Path=/api/auth', response.headers.getlist('set-cookie')[0])
            self.assertIn('Max-Age=0', response.headers.getlist('set-cookie')[0])
            result = Response()
            auth.logout(request(cookie.value), result)
            self.assertEqual(len(result.headers.getlist('set-cookie')), 2)

    def test_alternate_development_port_is_allowed(self):
        result = auth.login(auth.LoginCredentials(username='admin', password=TEST_PASSWORD),
                            request(origin='http://localhost:5174'), Response())
        self.assertTrue(result['authenticated'])


if __name__ == "__main__":
    unittest.main()
