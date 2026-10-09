"""保留真实 POI 点位，仅补齐缺失的演示属性，并迁移为快充/普通充电两类。"""

import argparse
import hashlib
import json
import random
import re
from collections import Counter
from contextlib import closing
from pathlib import Path

from psycopg2.extras import Json

from .database import get_db_connection
from .spatial_migration import backup_database
from .station_catalog import ROOT, PROPERTY_COLUMNS, ensure_schema, export_catalog, station_properties


def complete_properties(properties, poi=None):
    """仅填缺失字段；确定性演示值和字段标记可重复执行，保留已知数值及真实的零。"""
    result = {**properties}
    simulated = set(properties.get('simulatedFields') or [])
    rng = random.Random(int.from_bytes(hashlib.sha256(properties['id'].encode()).digest()[:8], 'big'))
    text = f"{properties.get('name') or ''} {properties.get('address') or ''}"
    poi = poi or {}

    def missing(key):
        return result.get(key) in (None, '')

    def fill(key, value, simulated_value=True):
        if missing(key):
            result[key] = value
            if simulated_value:
                simulated.add(key)

    fill('city', poi.get('cityname') or '许昌市', not bool(poi.get('cityname')))
    fill('district', poi.get('adname') or '许昌城区', not bool(poi.get('adname')))
    fill('address', poi.get('address') or '地址待实测补录（演示）', not bool(poi.get('address')))
    inferred = result.get('chargeType') not in ('fast', 'regular', 'slow') or 'chargeType' in simulated
    if inferred:
        result['chargeType'] = 'fast' if re.search(r'超充|快充|超级充电|极速|大功率', text) else 'regular'
        simulated.add('chargeType')
    elif result['chargeType'] == 'slow':
        result['chargeType'] = 'regular'

    operator = re.split(r'[（(]', properties.get('name') or '')[0]
    operator = re.sub(r'(汽车)?(超级)?(超充|快充|充电)站.*$', '', operator).strip()
    fill('operator', operator if operator and operator not in ('汽车', '充电桩') else '演示运营方')
    site = next((label for keyword, label in [('医院', '医院停车场'), ('小区', '社区停车场'),
                ('社区', '社区停车场'), ('酒店', '酒店停车场'), ('学院', '校园停车场'),
                ('广场', '商圈停车场'), ('商场', '商圈停车场'), ('高速', '服务区停车场')]
                if keyword in text), '公共停车场')
    fill('siteType', site)
    fill('status', 'active')

    total, fast, regular = (result.get(key) for key in ('totalCount', 'fastCount', 'regularCount'))
    if total is not None:
        if fast is None:
            fill('fastCount', total - regular if regular is not None else total if result['chargeType'] == 'fast' else 0)
        if regular is None:
            fill('regularCount', total - result['fastCount'])
    else:
        fill('fastCount', rng.choice([6, 8, 12, 16]) if result['chargeType'] == 'fast' else 0)
        fill('regularCount', 0 if result['chargeType'] == 'fast' else rng.choice([4, 6, 8, 12]))
        fill('totalCount', result['fastCount'] + result['regularCount'])
    if inferred:
        result['chargeType'] = 'fast' if result['fastCount'] > 0 else 'regular'
    fill('availableCount', rng.randrange(result['totalCount'] + 1) if result['status'] == 'active' else 0)
    fill('powerKw', rng.choice([60, 90, 120, 180]) if result['chargeType'] == 'fast' else rng.choice([7, 11, 22]))
    fill('electricityPrice', round(rng.uniform(.55, .85), 2))
    fill('servicePrice', round(rng.uniform(.2, .45), 2))
    fill('parkingFee', rng.choice([0, 0, 2, 3]))
    fill('openingHours', '00:00-24:00')
    fill('observedAt', '2026-10-05T08:00:00+08:00')
    result['simulatedFields'] = sorted(simulated)
    if simulated:
        note = '真实 POI 点位保留；缺失属性使用演示补全，simulatedFields 列出待实测替换的字段。'
        if note not in (result.get('notes') or ''):
            result['notes'] = '；'.join(filter(None, [result.get('notes'), note]))
    result['hasSimulatedAttributes'] = bool(simulated)
    result['pricePerKwh'] = round(result['electricityPrice'] + result['servicePrice'], 2)
    return result


def complete_database(connection, pois):
    report = {'existing_stations': 0, 'updated_existing_stations': 0, 'simulated_fields': {}}
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout='10s'")
        cursor.execute('SELECT pg_advisory_xact_lock(4326001)')
        # 记录真实点位，事务结束前验证名称、地址和两套坐标均没有被改动。
        snapshot_sql = """SELECT id,name,address,ST_AsEWKT(geom),ST_AsEWKT(geom_gcj02)
            FROM stations WHERE NOT is_synthetic ORDER BY id"""
        cursor.execute(snapshot_sql)
        originals = cursor.fetchall()
        ensure_schema(cursor)
        cursor.execute("""SELECT id,name,address,to_jsonb(s) - ARRAY['geom','geom_wgs84','geom_gcj02','lng','lat']
            FROM stations s WHERE NOT is_synthetic ORDER BY id FOR UPDATE""")
        fields = Counter()
        for station_id, name, address, record in cursor.fetchall():
            original = station_properties(station_id, name, address, record)
            completed = complete_properties(original, pois.get(station_id))
            report['existing_stations'] += 1
            changed = [field for field in PROPERTY_COLUMNS if completed.get(field) != original.get(field)]
            if changed:
                assignments = ','.join(f'{PROPERTY_COLUMNS[field]}=%s' for field in changed)
                values = [Json(completed[field]) if field == 'simulatedFields' else completed[field] for field in changed]
                cursor.execute(f'UPDATE stations SET {assignments},updated_at=now() WHERE id=%s', [*values, station_id])
                report['updated_existing_stations'] += 1
            fields.update(completed['simulatedFields'])
        cursor.execute(snapshot_sql)
        if cursor.fetchall() != originals:
            raise ValueError('真实站点名称、地址或坐标发生变化，补全已回滚')
        cursor.execute('SELECT charge_type,count(*) FROM stations GROUP BY charge_type ORDER BY charge_type')
        report['charge_types'] = dict(cursor.fetchall())
        report['simulated_fields'] = dict(sorted(fields.items()))
        cursor.execute("SELECT count(*) FROM stations WHERE charge_type NOT IN ('fast','regular') OR charge_type IS NULL")
        if cursor.fetchone()[0]:
            raise ValueError('仍有第三类充电类型，补全已回滚')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='备份后提交；默认试运行并回滚')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/managed/existing-stations-enriched.csv')
    parser.add_argument('--report', type=Path, default=ROOT / 'docs/station-attributes-completion.json')
    args = parser.parse_args()
    if args.apply and args.output.exists():
        raise ValueError('维护文件已存在，请用 --output 指定新路径，避免覆盖手工修改')
    raw = json.loads((ROOT / 'data/raw/amap-stations.json').read_text(encoding='utf-8-sig'))
    pois = {poi['id']: poi for poi in raw['pois'] if poi.get('id')}
    with closing(get_db_connection()) as connection:
        try:
            report = complete_database(connection, pois)
        finally:
            connection.rollback()
    backup = str(backup_database()) if args.apply else None
    if args.apply:
        with closing(get_db_connection()) as connection:
            with connection:
                report = complete_database(connection, pois)
                with connection.cursor() as cursor:
                    cursor.execute('INSERT INTO station_imports(source_file,report) VALUES(%s,%s)',
                                   ('complete-existing-attributes', Json(report)))
            export_catalog(connection, args.output, include_synthetic=False)
    report.update(committed=args.apply, backup=backup, maintenance_file=str(args.output) if args.apply else None)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
