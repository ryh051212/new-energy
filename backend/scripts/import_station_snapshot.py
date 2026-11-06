"""Validate and replace district station records while retaining outside references."""
import argparse
import csv
import hashlib
import json
import math
from collections import Counter
from contextlib import closing
from pathlib import Path
from psycopg2.extras import Json
from backend.utils.database import get_db_connection
from backend.data.coordinate_transform import wgs84_to_gcj02
from backend.scripts.spatial_migration import backup_database, recalculate_indicators

SOURCE=Path(r'D:\jstrae\项目学习\个人项目\数据\空间供需\充电站数据\魏都区充电站_最终整合版.csv')
DATASET='weidu-final-integrated-20261028'

def read_source():
    with SOURCE.open(encoding='utf-8-sig',newline='') as stream:
        rows=list(csv.DictReader(stream))
    ids=set()
    for r in rows:
        if not r['id'] or r['id'] in ids or not r['名称']:
            raise ValueError('ID 重复或名称缺失')
        ids.add(r['id'])
        x,y=float(r['lon_wgs84']),float(r['lat_wgs84'])
        if not (math.isfinite(x) and math.isfinite(y) and 113<x<115 and 33<y<35):
            raise ValueError('坐标超出许昌核验范围: '+r['id'])
    if not rows: raise ValueError('数据为空')
    return rows

def execute(conn,rows):
    with conn.cursor() as c:
        c.execute("SET LOCAL lock_timeout='10s'")
        c.execute('SELECT pg_advisory_xact_lock(4326001)')
        c.execute("SELECT id FROM stations WHERE NOT is_synthetic AND status<>'retired' AND EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,stations.geom))")
        old=[r[0] for r in c.fetchall()]
        c.execute("SELECT count(*) FROM stations WHERE NOT is_synthetic AND status<>'retired' AND NOT EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,stations.geom))")
        outside_before=c.fetchone()[0]
        inside=[]; outside=[]
        for r in rows:
            x,y=float(r['lon_wgs84']),float(r['lat_wgs84'])
            c.execute('SELECT EXISTS (SELECT 1 FROM weidu_boundary WHERE ST_Covers(geom,ST_SetSRID(ST_MakePoint(%s,%s),4326)))',(x,y))
            (inside if c.fetchone()[0] else outside).append(r)
        if not old or not inside: raise ValueError('区内旧站或新站为空，停止导入')
        c.execute('SELECT id FROM stations WHERE id=ANY(%s)',([r['id'] for r in inside],))
        if c.fetchone(): raise ValueError('新站 ID 与已有数据冲突，停止导入')
        c.execute("UPDATE stations SET status='retired',updated_at=now() WHERE id=ANY(%s)",(old,))
        coordinate_counts=Counter((r['lon_wgs84'],r['lat_wgs84']) for r in inside)
        for r in inside:
            x,y=float(r['lon_wgs84']),float(r['lat_wgs84']);gx,gy=wgs84_to_gcj02(x,y)
            state=r['状态_规范化'];classification=r['综合开放状态分类（研究用）'];group=r['分析组']
            confirmed='官方公示开放（支持非特斯拉，非实时状态）'==classification
            flags=[] if confirmed else [classification or '开放状态待核实']
            if group=='车型待核实':flags.append('车型适用范围待核实')
            if coordinate_counts[(r['lon_wgs84'],r['lat_wgs84'])]>1:flags.append('同坐标记录待复核')
            # 原始标记保留；暂停映射为离线，但不把未标注推断为已开放。
            status='offline' if state=='暂停开放' else 'active'
            baseline={'public_access':True if confirmed else False if state=='不对外开放' else None,
                      'scope_review_flags':flags,'inside_boundary':True,'data_basis':'user_supplied_csv',
                      'source_url':r['证据网址'] or None,'source_updated_at':r['更新时间_北京时间'] or None,
                      'open_status':classification,'analysis_group':group,'source_status':state,
                      'source_record':r}
            c.execute("""INSERT INTO stations(id,name,address,lng,lat,geom,geom_wgs84,geom_gcj02,city,district,
                charge_type,status,is_synthetic,data_source,dataset_id,opening_hours,notes,simulated_fields,baseline_record)
                VALUES(%s,%s,%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),4326),
                ST_SetSRID(ST_MakePoint(%s,%s),0),%s,%s,NULL,%s,false,'user-integrated-csv',%s,%s,%s,'[]'::jsonb,%s)""",
                (r['id'],r['名称'],r['地址'] or None,x,y,x,y,x,y,gx,gy,r['市'] or '许昌市',r['县'] or None,
                 status,DATASET,r['营业时间_简化'] or None,r['研究中建议用法'] or None,Json(baseline)))
        result=recalculate_indicators(c)
        c.execute("SELECT count(*) FROM stations WHERE NOT is_synthetic AND status<>'retired' AND NOT EXISTS (SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,stations.geom))")
        if c.fetchone()[0]!=outside_before:raise ValueError('区外原站数量变化，回滚')
        return {'source_rows':len(rows),'imported_inside':len(inside),'source_outside_skipped':len(outside),
                'old_inside_archived':len(old),'existing_outside_preserved':outside_before,
                'analysis_groups':dict(Counter(r['分析组'] for r in inside)),'grid_analysis':result}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    rows=read_source()
    with closing(get_db_connection()) as conn:
        try: report=execute(conn,rows)
        finally: conn.rollback()
    if args.apply:
        backup=str(backup_database())
        snapshot=Path('data/managed/stations-source-20261028.csv')
        contents=SOURCE.read_bytes()
        if snapshot.exists() and snapshot.read_bytes()!=contents:
            raise ValueError('历史来源快照已存在且内容不同，停止导入')
        if not snapshot.exists():
            with snapshot.open('xb') as f:f.write(contents)
        with closing(get_db_connection()) as conn:
            try: report=execute(conn,rows);conn.commit()
            except Exception: conn.rollback();raise
        report['backup']=backup;report['snapshot']=str(snapshot)
    report.update(committed=args.apply,source_sha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest())
    print(json.dumps(report,ensure_ascii=False,default=str))

if __name__=='__main__':main()
