"""按 POI ID 和全名挂接有来源的设备配置；桩、枪、共享功率分别记录。"""
import json
import math
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

if __package__:
    from .station_verification import valid_checked_at
else:
    from station_verification import valid_checked_at

CATALOG_PATH = Path(__file__).resolve().parents[2] / 'data/managed/station-equipment.json'


def count(value):
    return type(value) is int and 0 <= value <= 100000


def power(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 < value <= 1000000


@lru_cache(maxsize=1)
def equipment_catalog():
    catalog = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
    if catalog.get('version') != 1:
        raise ValueError('不支持的站点设备资料版本')
    return catalog


def unknown_equipment(note='尚无可对应此站的设备配置资料；枪数和功率未知。'):
    return dict(state='unknown', pileCount=None, gunCount=None, maxGunPowerKw=None,
                installedPowerKw=None, groups=[], sources=[], checkedAt=None,
                sourceDate=None, complete=False, note=note)


def reviewed_equipment(record, catalog):
    sources = []
    for key in record.get('sources', []):
        source = deepcopy(catalog.get('sources', {}).get(key, {}))
        parsed = urlparse(source.get('url', ''))
        if (parsed.scheme == 'https' and parsed.hostname and not parsed.username
                and not parsed.password and valid_checked_at(source.get('checkedAt'))):
            sources.append(source)
    if not sources or not valid_checked_at(record.get('checkedAt')):
        return unknown_equipment('设备资料缺少有效来源或核对时间，保持未知。')
    groups = deepcopy(record.get('groups', []))
    if not isinstance(groups, list) or not groups:
        return unknown_equipment('设备分组尚未提供，保持未知。')
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('label'), str):
            return unknown_equipment('设备分组无效，保持未知。')
        for field in ('unitCount', 'gunsPerUnit'):
            if group.get(field) is not None and not count(group[field]):
                return unknown_equipment('设备数量无效，保持未知。')
        for field in ('unitPowerKw', 'gunPowerKw', 'ratedCurrentA'):
            if group.get(field) is not None and not power(group[field]):
                return unknown_equipment('设备功率或电流无效，保持未知。')
        # 多枪设备的每枪上限不能超过所列设备的共享额定功率。
        if (power(group.get('unitPowerKw')) and power(group.get('gunPowerKw'))
                and group['gunPowerKw'] > group['unitPowerKw']):
            return unknown_equipment('单枪功率超过所列设备功率，保持未知。')
        group['gunCount'] = (group['unitCount'] * group['gunsPerUnit']
                             if count(group.get('unitCount')) and count(group.get('gunsPerUnit')) else None)
    complete = record.get('complete') is True
    piles = sum(group['unitCount'] for group in groups) if complete and all(count(g.get('unitCount')) for g in groups) else None
    guns = sum(group['gunCount'] for group in groups) if complete and all(count(g.get('gunCount')) for g in groups) else None
    # 仅汇总设备额定输出，不将枪数乘以峰值，也不当作配变容量。
    installed = round(sum(g['unitCount'] * g['unitPowerKw'] for g in groups), 3) if complete and all(
        count(g.get('unitCount')) and power(g.get('unitPowerKw')) for g in groups) else None
    maximum = record.get('maxGunPowerKw')
    if maximum is not None and not power(maximum):
        return unknown_equipment('单枪最高功率无效，保持未知。')
    return dict(state='sourced', pileCount=piles, gunCount=guns, maxGunPowerKw=maximum,
                installedPowerKw=installed, groups=groups, sources=sources,
                checkedAt=record['checkedAt'], sourceDate=record.get('sourceDate'),
                complete=complete, note=record.get('note', ''), basis=record.get('basis', 'public_source'))


def apply_station_equipment(properties):
    # 外部实测目录和虚拟点位不借用原始高德站点的资料。
    if properties.get('isSynthetic') or properties.get('dataSource') != 'existing-poi':
        return properties
    catalog = equipment_catalog()
    record = catalog.get('stations', {}).get(str(properties['id']))
    equipment = reviewed_equipment(record, catalog) if record and record.get('stationName') == properties.get('name') else unknown_equipment()
    properties['chargingEquipment'] = equipment
    # 旧 totalCount / powerKw 的演示值仍有原标记，真实设备资料使用独立字段。
    properties['fieldVerification'] = dict(properties.get('fieldVerification') or {})
    for field in ('pileCount', 'gunCount', 'maxGunPowerKw', 'installedPowerKw'):
        properties[field] = equipment[field]
        properties['fieldVerification'][field] = dict(
            state='known' if equipment[field] is not None else 'unknown', value=equipment[field],
            checkedAt=equipment['checkedAt'], sources=deepcopy(equipment['sources']), note=equipment['note'])
    return properties
