"""Read-only source checks; no credentials or URL query secrets are printed."""
import json
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
(ROOT / 'metadata').mkdir(parents=True, exist_ok=True)
(ROOT / 'raw').mkdir(exist_ok=True)
session = requests.Session()
session.headers['User-Agent'] = 'WeiduGIS-StudentResearch/1.0 (public-data validation)'
urls = {
    'worldpop_2025': 'https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2025/CHN/v1/100m/constrained/chn_pop_2025_CN_100m_R2025A_v1.tif',
    'worldpop_2026': 'https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2026/CHN/v1/100m/constrained/chn_pop_2026_CN_100m_R2025A_v1.tif',
    'worldpop_catalog': 'https://stac.worldpop.org/collections/CHN/items/chn_pop_2025_CN_100m_R2025A_v1',
    'overpass_status': 'https://overpass-api.de/api/status',
    'government_area': 'https://www.weidu.gov.cn/zjwd/walkIntoWD.html',
    'worldpop_config': 'https://stac.worldpop.org/config.js',
}
results = {}
for key, url in urls.items():
    try:
        if key.startswith('worldpop_20'):
            r = session.get(url, headers={'Range': 'bytes=0-65535'}, timeout=(15, 40), stream=True)
            chunk = next(r.iter_content(65536), b'')
            results[key] = {'url': url, 'status': r.status_code, 'content_range': r.headers.get('Content-Range'), 'accept_ranges': r.headers.get('Accept-Ranges'), 'content_length': r.headers.get('Content-Length'), 'last_modified': r.headers.get('Last-Modified'), 'sample_bytes': len(chunk), 'tiff_signature': chunk[:4].hex()}
            r.close()
        else:
            r = session.get(url, timeout=(15, 30))
            results[key] = {'url': url, 'status': r.status_code, 'content_type': r.headers.get('Content-Type'), 'length': len(r.content)}
            if r.ok:
                (ROOT / 'raw' / (key + '.html' if 'text/html' in r.headers.get('Content-Type','') else key + '.txt')).write_bytes(r.content)
    except requests.RequestException as e:
        results[key] = {'url': url, 'error': type(e).__name__}
    print(key, json.dumps(results[key], ensure_ascii=False), flush=True)
(ROOT / 'metadata/source_probe.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
