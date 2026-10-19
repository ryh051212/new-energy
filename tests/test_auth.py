import os
from http.cookies import SimpleCookie
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Request, Response
from backend import auth


def request(token="", origin="http://127.0.0.1:5173"):
    headers = [(b"origin", origin.encode())] if origin else []
    if token:
        headers.append((b"cookie", f"{auth.COOKIE_NAME}={token}".encode()))
    return Request({"type": "http", "method": "POST", "path": "/api/auth/login",
                    "headers": headers, "client": ("127.0.0.1", 12345), "scheme": "http"})


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"ADMIN_USERNAME": "admin", "ADMIN_PASSWORD": "123456", "AUTH_COOKIE_SECURE": "false"})
        self.environment.start()
        auth._credentials.cache_clear()
        auth._sessions.clear()
        auth._attempts.clear()

    def tearDown(self):
        auth._sessions.clear()
        auth._attempts.clear()
        auth._credentials.cache_clear()
        self.environment.stop()

    def login(self, username="admin", password="123456", token=""):
        response = Response()
        result = auth.login(auth.LoginCredentials(username=username, password=password), request(token), response)
        cookie = SimpleCookie(response.headers["set-cookie"])[auth.COOKIE_NAME]
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
        self.assertEqual(cookie["path"], "/api/auth")
        self.assertEqual(int(cookie["max-age"]), auth.SESSION_SECONDS)
        self.assertNotIn(cookie.value, auth._sessions)
        self.assertEqual(auth.get_session(request(cookie.value), Response()), result)
        self.assertNotIn("password", str(result))

    def test_wrong_username_and_password_are_rejected(self):
        for username, password in (("admin", "wrong"), ("other", "123456"), ("Admin", "123456")):
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
            auth.login(auth.LoginCredentials(username="admin", password="123456"), request(origin="https://unrelated.example"), Response())
        self.assertEqual(error.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            auth.logout(request(origin="https://unrelated.example"), Response())
        self.assertFalse(auth._sessions)

    def test_repeated_failures_are_rate_limited(self):
        with patch.object(auth, "_credentials", return_value=("admin", b"salt", b"incorrect-hash")):
            with patch.object(auth.hashlib, "pbkdf2_hmac", return_value=b"actual-hash"):
                for _ in range(8):
                    with self.assertRaises(HTTPException) as error:
                        self.login(password="wrong")
                    self.assertEqual(error.exception.status_code, 401)
                with self.assertRaises(HTTPException) as error:
                    self.login()
                self.assertEqual(error.exception.status_code, 429)

    def test_admin_credentials_can_be_configured(self):
        with patch.dict(os.environ, {"ADMIN_USERNAME": "planner", "ADMIN_PASSWORD": "different-password"}):
            result, _, _ = self.login("planner", "different-password")
            self.assertEqual(result["user"]["username"], "planner")


if __name__ == "__main__":
    unittest.main()
