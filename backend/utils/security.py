"""Shared origin configuration for CORS and cookie-authenticated writes."""

import os
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from fastapi import HTTPException, Request
from starlette.middleware.cors import CORSMiddleware


_backend = Path(__file__).resolve().parents[1]
load_dotenv(_backend / '.env.local')
load_dotenv(_backend.parent / '.env.local')


def allowed_origins():
    defaults = [f'http://{host}:{port}' for host in ('localhost', '127.0.0.1', '[::1]')
                for port in (5173, 5174, 5175, 4173)]
    values = os.getenv('CORS_ALLOWED_ORIGINS', ','.join(defaults)).split(',')
    result = []
    for value in values:
        origin = value.strip().rstrip('/')
        if not origin:
            continue
        parsed = urlsplit(origin)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
                or '*' in origin):
            raise ValueError('CORS_ALLOWED_ORIGINS 必须为逗号分隔的完整 HTTP/HTTPS 来源，不能使用通配符')
        result.append(origin)
    return tuple(dict.fromkeys(result))


ALLOWED_ORIGINS = allowed_origins()


def check_origin(request: Request):
    origin = request.headers.get('origin')
    if not origin:
        if request.headers.get('sec-fetch-site') == 'cross-site':
            raise HTTPException(status_code=403, detail='请求来源不受信任')
        return
    # Vite / 生产反向代理保留 Host 时，同源访问无需另行开放跨域来源。
    same_origin = str(request.base_url).rstrip('/')
    if origin not in ALLOWED_ORIGINS and origin != same_origin:
        raise HTTPException(status_code=403, detail='请求来源不受信任，请从项目网页操作')


def with_cors(app):
    # 包在整个 ASGI 应用外，未处理异常生成的 500 响应也保留 CORS 响应头。
    return CORSMiddleware(app, allow_origins=list(ALLOWED_ORIGINS), allow_credentials=True,
                          allow_methods=['GET', 'POST', 'OPTIONS'],
                          allow_headers=['Content-Type', 'Accept'], expose_headers=['Retry-After'])
