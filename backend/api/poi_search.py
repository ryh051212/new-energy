"""实验 5 的只读 POI 查询，复用已有正式空间表，不创建演示校园数据。"""

import math
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

if __package__:
    from ..utils.database import get_db_connection
else:
    from utils.database import get_db_connection

router = APIRouter(prefix='/api/pois', tags=['POI 搜索'])
# 表名来自固定白名单；用户输入始终使用 SQL 参数传递。
SOURCES = (
    ('stations', 'station'), ('residential_pois', 'residential'),
    ('commercial_pois', 'commercial'), ('facility_pois', 'facility'),
)


def contains_pattern(keyword):
    """与 icontains 一样按字面包含匹配，百分号和下划线不作为通配符。"""
    return '%' + keyword.replace('\\', '\\\\').replace('%', r'\%').replace('_', r'\_') + '%'


def serialize_poi(row):
    source_id, name, address, lng, lat, category, source, synthetic = row
    if (not isinstance(lng, (int, float)) or isinstance(lng, bool)
            or not isinstance(lat, (int, float)) or isinstance(lat, bool)
            or not math.isfinite(lng) or not math.isfinite(lat)
            or not -180 <= lng <= 180 or not -90 <= lat <= 90):
        return None
    return {'id': f'{source}:{source_id}', 'sourceId': str(source_id), 'name': name,
            'coordinates': [lng, lat], 'address': address or '', 'category': category,
            'source': source, 'coordSystem': 'WGS84', 'isSynthetic': bool(synthetic)}


@router.get('')
def search_pois(q: Annotated[str, Query(max_length=120)] = '',
                limit: Annotated[int, Query(ge=1, le=50)] = 20):
    """按名称返回魏都区 POI，坐标为 geom 的 [经度, 纬度]。空词不查全库。"""
    keyword = q.strip()
    if not keyword:
        return []
    connection = get_db_connection()
    try:
        with connection.cursor() as cursor:
            # 设施目录在早期实验中尚未导入时，其他已存在的 POI 表仍可查询。
            cursor.execute('SELECT ' + ','.join(f"to_regclass('public.{table}')" for table, _ in SOURCES))
            available = cursor.fetchone()
            selects = []
            for priority, ((table, category), exists) in enumerate(zip(SOURCES, available)):
                if not exists:
                    continue
                extra = " AND (to_jsonb(p)->>'status') IS DISTINCT FROM 'retired'" if table == 'stations' else ''
                kind = "COALESCE(p.categories[1],'facility')" if table == 'facility_pois' else f"'{category}'::text"
                synthetic = "COALESCE((to_jsonb(p)->>'is_synthetic')::boolean,false)" if table == 'stations' else 'false'
                selects.append(f"""SELECT p.id::text AS id,p.name,p.address,p.geom,
                    {kind} AS category,'{table}'::text AS source,{synthetic} AS synthetic,{priority} AS priority
                    FROM {table} p WHERE p.geom IS NOT NULL AND NOT ST_IsEmpty(p.geom)
                    AND ST_SRID(p.geom)=4326 AND GeometryType(p.geom)='POINT'{extra}""")
            if not selects:
                raise HTTPException(status_code=503, detail='POI 数据尚未准备好')
            # 同一来源 ID 与坐标的跨表副本只展示一次，优先保留原业务表。
            cursor.execute("""WITH candidates AS (""" + ' UNION ALL '.join(selects) + """), matched AS (
                SELECT DISTINCT ON (id,ST_AsEWKB(geom)) * FROM candidates p
                WHERE name ILIKE %s ESCAPE '\\'
                AND EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,p.geom))
                ORDER BY id,ST_AsEWKB(geom),priority
            ) SELECT id,name,address,ST_X(geom),ST_Y(geom),category,source,synthetic FROM matched
                ORDER BY name,id,source LIMIT %s""", (contains_pattern(keyword), limit))
            return [item for row in cursor.fetchall() if (item := serialize_poi(row)) is not None]
    finally:
        connection.close()
