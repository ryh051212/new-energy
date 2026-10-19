"""逐字段公开资料核对；以 ID 和完整名称关联，不把公开资料当现场或实时核验。"""
import json
from copy import deepcopy
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

VERIFICATION_PATH = Path(__file__).resolve().parent.parent / 'data/managed/station-verification.json'
OVERLAY_FIELDS = {'locationDescription', 'openingHours', 'entranceDescription', 'chargeType',
                  'chargingCurrentTypes', 'chargingCurrentTypesComplete', 'accessPolicy'}


def valid_checked_at(value):
    try:
        checked = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return checked.tzinfo is not None and checked <= datetime.now(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return False


def valid_overlay_value(field, value):
    if field == 'chargeType':
        return value in ('fast', 'regular')
    if field == 'chargingCurrentTypes':
        return isinstance(value, list) and bool(value) and all(item in ('DC', 'AC') for item in value)
    if field == 'chargingCurrentTypesComplete':
        return isinstance(value, bool)
    return isinstance(value, str) and bool(value.strip())


@lru_cache(maxsize=1)
def verification_catalog():
    catalog = json.loads(VERIFICATION_PATH.read_text(encoding='utf-8'))
    if catalog.get('version') != 1:
        raise ValueError('不支持的站点核对记录版本')
    return catalog


def apply_station_verification(properties):
    """只替换有有效来源的已知字段；未核验字段及模拟值保留原状态。"""
    catalog = verification_catalog()
    record = catalog.get('stations', {}).get(str(properties['id']))
    if (properties.get('isSynthetic') or not record or record.get('stationName') != properties.get('name')
            or properties.get('dataSource') not in (None, '', 'existing-poi')):
        return properties
    evidence = {}
    for field, item in record.get('fields', {}).items():
        item = deepcopy(item)
        sources = [deepcopy(catalog['sources'][source_id]) for source_id in item.get('sources', [])
                   if source_id in catalog.get('sources', {})]
        sources = [source for source in sources if urlparse(source.get('url', '')).scheme == 'https'
                   and urlparse(source['url']).hostname and valid_checked_at(source.get('checkedAt'))]
        if item.get('state') == 'known' and (not sources or not valid_checked_at(item.get('checkedAt')) or item.get('value') is None
                or (field in OVERLAY_FIELDS and not valid_overlay_value(field, item.get('value')))):
            item.update(state='unknown', value=None, note='核对记录缺少有效来源、值或核对时间。')
        item['sources'] = sources
        evidence[field] = item
        if field in OVERLAY_FIELDS and item.get('state') == 'known':
            properties[field] = deepcopy(item['value'])
            properties['simulatedFields'] = [name for name in properties.get('simulatedFields', []) if name != field]
    properties['fieldVerification'] = evidence
    properties['publicCheckedAt'] = record.get('checkedAt')
    properties['hasSimulatedAttributes'] = bool(properties.get('simulatedFields'))
    return properties
