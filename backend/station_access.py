"""按站点 ID 和名称关联进场资料；入口坐标未知时保留原站点几何。"""
import json
import math
from copy import deepcopy
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
if __package__:
    from .coordinate_transform import gcj02_to_wgs84
else:
    from coordinate_transform import gcj02_to_wgs84

GUIDES_PATH = Path(__file__).resolve().parent.parent / 'data/managed/station-access-guides.json'


@lru_cache(maxsize=1)
def access_guides():
    data = json.loads(GUIDES_PATH.read_text(encoding='utf-8'))
    return data['guides'] if data.get('version') == 1 else {}


def station_access_guide(station_id, name, is_synthetic=False):
    guide = access_guides().get(str(station_id))
    if is_synthetic or not guide or guide.get('stationName') != name:
        return None
    return deepcopy(guide)


def route_destination(guide, station_coordinates):
    """只接受有来源、带时区核对时间的明确车行入口，不用文字推算坐标。"""
    entrance = (guide or {}).get('routingEntrance')
    fallback = {'coordinates': list(station_coordinates), 'kind': 'station_location',
                'label': '站点定位（车行入口坐标未核验）'}
    if not isinstance(entrance, dict) or entrance.get('kind') != 'vehicle_entrance':
        return fallback
    coordinates = entrance.get('coordinates')
    if not isinstance(coordinates, list) or len(coordinates) != 2 or not all(
        isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value) <= bound
        for value, bound in zip(coordinates, (180, 90))):
        return fallback
    if entrance.get('coordSystem') not in ('WGS84', 'GCJ-02') or not str(entrance.get('sourceUrl', '')).startswith('https://'):
        return fallback
    if not isinstance(entrance.get('checkedAt'), str):
        return fallback
    try:
        checked = datetime.fromisoformat(entrance.get('checkedAt', '').replace('Z', '+00:00'))
        if checked.tzinfo is None or checked > datetime.now(timezone.utc):
            return fallback
    except (ValueError, TypeError):
        return fallback
    destination = list(gcj02_to_wgs84(*coordinates)) if entrance['coordSystem'] == 'GCJ-02' else list(coordinates)
    # 拒绝误关联到远处的入口；该限制是数据校验，不是入口推测。
    lat1, lat2 = (math.radians(point[1]) for point in (station_coordinates, destination))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(destination[0]-station_coordinates[0])/2)**2
    if 12742017.6 * math.asin(math.sqrt(min(1, h))) > 1000:
        return fallback
    return {'coordinates': destination, 'kind': 'vehicle_entrance', 'label': '资料核对的车行入口（入库后按现场指引）'}
