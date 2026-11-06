"""Local administrator login with expiring, server-side cookie sessions."""

from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import hmac
import os
import re
from urllib.parse import urlparse
import secrets
from threading import Lock
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

if __package__:
    from ..utils.security import ALLOWED_ORIGINS, check_origin
else:
    from utils.security import ALLOWED_ORIGINS, check_origin

router = APIRouter(prefix="/api/auth", tags=["auth"])
COOKIE_NAME = "weidu_session"
SESSION_SECONDS = 8 * 60 * 60
COOKIE_PATH = '/api'
PASSWORD_ITERATIONS = 600000
_sessions = {}
_attempts = {}
_lock = Lock()


class LoginCredentials(BaseModel):
    username: str = Field(min_length=1, max_length=8, pattern=r'^[A-Za-z]+$', strict=True)
    password: str = Field(min_length=8, max_length=256, strict=True)

    @field_validator('password')
    @classmethod
    def password_policy(cls, value):
        if not re.search(r'[A-Za-z]', value) or not re.search(r'[0-9]', value):
            raise ValueError('密码至少 8 位，必须同时包含英文字母和数字')
        return value


@lru_cache(maxsize=1)
def _credentials():
    username = os.getenv("ADMIN_USERNAME", "admin").strip() or "admin"
    password = os.getenv('ADMIN_PASSWORD', '')
    if not re.fullmatch(r'[A-Za-z]{1,8}', username) or not 8 <= len(password) <= 256 or not re.search(r'[A-Za-z]',password) or not re.search(r'[0-9]',password):
        raise HTTPException(status_code=503, detail='管理员账号尚未正确配置，请联系管理员')
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return username, salt, digest


def _session_key(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _cleanup(now):
    for key in [key for key, value in _sessions.items() if value["expires"] <= now]:
        del _sessions[key]
    for key in [key for key, values in _attempts.items() if not values or values[-1] <= now - 300]:
        del _attempts[key]


def _check_origin(request):
    check_origin(request)


def _secure_cookie(request):
    value = os.getenv('AUTH_COOKIE_SECURE', '').lower()
    return value in ('1', 'true') if value else request.url.scheme == 'https'


def _clear_cookie(request, response):
    for path in (COOKIE_PATH, '/api/auth'):
        response.delete_cookie(COOKIE_NAME, path=path, httponly=True,
                               secure=_secure_cookie(request), samesite='lax')


def _read_session(request):
    token = request.cookies.get(COOKIE_NAME, '')
    if not token or len(token) > 128:
        return None
    with _lock:
        _cleanup(time.time())
        return _sessions.get(_session_key(token))


def require_session(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    session = _read_session(request)
    if session is None:
        raise HTTPException(status_code=401, detail='登录已失效，请重新登录',
                            headers={'Cache-Control': 'no-store'})
    return session


def _result(session=None):
    return {
        "authenticated": session is not None,
        "user": {"username": session["username"]} if session else None,
        "expiresAt": datetime.fromtimestamp(session["expires"], timezone.utc).isoformat() if session else None,
    }


@router.get("/session")
def get_session(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    session = _read_session(request)
    if session is None and request.cookies.get(COOKIE_NAME):
        _clear_cookie(request, response)
    return _result(session)


@router.get('/authorize')
def authorize(session=Depends(require_session)):
    return _result(session)


@router.post("/login")
def login(credentials: LoginCredentials, request: Request, response: Response):
    _check_origin(request)
    username, salt, expected = _credentials()
    now = time.time()
    client = request.client.host if request.client else "local"
    with _lock:
        _cleanup(now)
        recent = [stamp for stamp in _attempts.get(client, []) if stamp > now - 300]
        if len(recent) >= 8:
            retry_after = max(1, int(300 - (now - recent[0])) + 1)
            raise HTTPException(status_code=429, detail="尝试次数较多，请稍后再试",
                                headers={'Retry-After': str(retry_after), 'Cache-Control': 'no-store'})
        _attempts[client] = [*recent, now]
    actual = hashlib.pbkdf2_hmac("sha256", credentials.password.encode(), salt, PASSWORD_ITERATIONS)
    if not (hmac.compare_digest(credentials.username.strip().encode(), username.encode())
            & hmac.compare_digest(actual, expected)):
        raise HTTPException(status_code=401, detail="用户名或密码不正确，请重新输入", headers={'Cache-Control': 'no-store'})
    return _create_session(username, request, response, now)


def _create_session(username, request, response, now=None):
    now = time.time() if now is None else now
    client = request.client.host if request.client else 'local'
    token = secrets.token_urlsafe(32)
    session = {"username": username, "expires": now + SESSION_SECONDS}
    with _lock:
        _cleanup(now)
        _attempts.pop(client, None)
        old_token = request.cookies.get(COOKIE_NAME)
        if old_token:
            _sessions.pop(_session_key(old_token), None)
        if len(_sessions) >= 1024:
            del _sessions[min(_sessions, key=lambda key: _sessions[key]['expires'])]
        _sessions[_session_key(token)] = session
    response.headers["Cache-Control"] = "no-store"
    # 清除旧版本使用的窄路径 Cookie，避免同名 Cookie 干扰鉴权。
    response.delete_cookie(COOKIE_NAME, path='/api/auth', httponly=True,
                           secure=_secure_cookie(request), samesite='lax')
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=_secure_cookie(request), samesite="lax", path=COOKIE_PATH)
    return _result(session)


def local_quick_login_available(request):
    local_hosts = {'127.0.0.1', 'localhost', '::1'}
    origin = request.headers.get('origin')
    return (os.getenv('AUTH_LOCAL_QUICK_LOGIN', '').lower() == 'true'
            and request.client is not None and request.client.host in {'127.0.0.1', '::1'}
            and request.url.hostname in local_hosts
            and (not origin or urlparse(origin).hostname in local_hosts))


@router.get('/quick-login/availability')
def quick_login_availability(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return {'available': local_quick_login_available(request)}


@router.post('/quick-login')
def quick_login(request: Request, response: Response):
    _check_origin(request)
    if not local_quick_login_available(request):
        raise HTTPException(403, '管理员一键登录仅在启用此功能的本机可用')
    username, _, _ = _credentials()
    return _create_session(username, request, response)


@router.post("/logout")
def logout(request: Request, response: Response):
    _check_origin(request)
    token = request.cookies.get(COOKIE_NAME, "")
    with _lock:
        _sessions.pop(_session_key(token), None)
    response.headers["Cache-Control"] = "no-store"
    _clear_cookie(request, response)
    return _result()
