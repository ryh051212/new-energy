"""Local administrator login with expiring, server-side cookie sessions."""

from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import hmac
import os
import secrets
from threading import Lock
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field


router = APIRouter(prefix="/api/auth", tags=["auth"])
COOKIE_NAME = "weidu_session"
SESSION_SECONDS = 8 * 60 * 60
ALLOWED_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
_sessions = {}
_attempts = {}
_lock = Lock()


class LoginCredentials(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


@lru_cache(maxsize=1)
def _credentials():
    # Called after main.py has loaded the existing local environment files.
    username = os.getenv("ADMIN_USERNAME", "admin").strip() or "admin"
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", os.getenv("ADMIN_PASSWORD", "123456").encode(), salt, 260000)
    return username, salt, digest


def _session_key(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _cleanup(now):
    for key in [key for key, value in _sessions.items() if value["expires"] <= now]:
        del _sessions[key]
    for key in [key for key, values in _attempts.items() if not values or values[-1] <= now - 300]:
        del _attempts[key]


def _check_origin(request):
    if request.headers.get("origin") and request.headers["origin"] not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="请从本项目网页登录")


def _result(session=None):
    return {
        "authenticated": session is not None,
        "user": {"username": session["username"]} if session else None,
        "expiresAt": datetime.fromtimestamp(session["expires"], timezone.utc).isoformat() if session else None,
    }


@router.get("/session")
def get_session(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    token = request.cookies.get(COOKIE_NAME, "")
    with _lock:
        _cleanup(time.time())
        session = _sessions.get(_session_key(token)) if token else None
        return _result(session)


@router.post("/login")
def login(credentials: LoginCredentials, request: Request, response: Response):
    _check_origin(request)
    now = time.time()
    client = request.client.host if request.client else "local"
    with _lock:
        _cleanup(now)
        recent = [stamp for stamp in _attempts.get(client, []) if stamp > now - 300]
        if len(recent) >= 8:
            raise HTTPException(status_code=429, detail="尝试次数较多，请 5 分钟后再试")
        _attempts[client] = [*recent, now]
    username, salt, expected = _credentials()
    actual = hashlib.pbkdf2_hmac("sha256", credentials.password.encode(), salt, 260000)
    if not (hmac.compare_digest(credentials.username.strip().encode(), username.encode())
            & hmac.compare_digest(actual, expected)):
        raise HTTPException(status_code=401, detail="用户名或密码不正确，请重新输入")
    token = secrets.token_urlsafe(32)
    session = {"username": username, "expires": now + SESSION_SECONDS}
    with _lock:
        _attempts.pop(client, None)
        old_token = request.cookies.get(COOKIE_NAME)
        if old_token:
            _sessions.pop(_session_key(old_token), None)
        _sessions[_session_key(token)] = session
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=os.getenv("AUTH_COOKIE_SECURE", "").lower() in ("1", "true"),
                        samesite="lax", path="/api/auth")
    return _result(session)


@router.post("/logout")
def logout(request: Request, response: Response):
    _check_origin(request)
    token = request.cookies.get(COOKIE_NAME, "")
    with _lock:
        _sessions.pop(_session_key(token), None)
    response.headers["Cache-Control"] = "no-store"
    response.delete_cookie(COOKIE_NAME, path="/api/auth", httponly=True, samesite="lax")
    return _result()
