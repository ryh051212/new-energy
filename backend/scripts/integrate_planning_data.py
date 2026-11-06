"""Activate the acquired baseline. Dry run by default; --apply backs up first.

Existing demo rows are archived with retired status, never physically deleted.
All real station IDs already present must occur in the new snapshot.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from backend.utils.database import get_db_connection
from backend.data.coordinate_transform import wgs84_to_gcj02
from backend.scripts.spatial_migration import recalculate_indicators
from psycopg2 import sql
from psycopg2.extras import Json

SOURCE=ROOT/'weidu_data'
ACTIVE=ROOT/'data/processed/planning-baseline'
DATASET='weidu-observed-20261027'
def read(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))
def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2,default=str)+'\n',encoding='utf-8')

def population_grids(cursor):
    """Preserve GHSL pixel counts; no forced 500000-person calibration."""
    import numpy as np
    import pyproj
    os.environ['PROJ_DATA']=pyproj.datadir.get_data_dir();os.environ['PROJ_LIB']=pyproj.datadir.get_data_dir()
    import rasterio
    from shapely.geometry import Point,shape,mapping
    from shapely.strtree import STRtree
    from shapely.ops import transform,unary_union
    cursor.execute('SELECT id,ST_AsGeoJSON(geom) FROM hex_grid ORDER BY id')
    grids=[(i,shape(json.loads(g))) for i,g in cursor.fetchall()]
    tree=STRtree([g for _,g in grids]);counts={i:0.0 for i,_ in grids};cells={i:0 for i,_ in grids};unassigned=[]
    projection=pyproj.Transformer.from_crs(4326,32649,always_xy=True).transform
    metric=[transform(projection,g) for _,g in grids];metric_tree=STRtree(metric)
    with rasterio.open(SOURCE/'population/population.tif') as raster:
        arr=raster.read(1,masked=True);indices=np.argwhere(~np.ma.getmaskarray(arr))
        for row,col in indices:
            x,y=raster.xy(int(row),int(col));p=Point(x,y);matches=tree.query(p,predicate='covered_by')
            if len(matches):index=min(map(int,matches),key=lambda j:grids[j][0])
            else:
                mp=transform(projection,p);index=int(metric_tree.nearest(mp))
                if mp.distance(metric[index])>5:
                    unassigned.append(float(arr[row,col]));continue
            gid=grids[index][0];counts[gid]+=float(arr[row,col]);cells[gid]+=1
    cursor.execute('SELECT ST_AsGeoJSON(ST_UnaryUnion(ST_Collect(geom))) FROM weidu_boundary')
    boundary=shape(json.loads(cursor.fetchone()[0]));maximum=max(counts.values(),default=0)
    features=[]
    for gid,g in grids:
        intersects=g.intersection(boundary);area=abs(pyproj.Geod(ellps='WGS84').geometry_area_perimeter(intersects)[0])/1e6 if not intersects.is_empty else 0
        value=counts[gid] if cells[gid] else None
        features.append({'type':'Feature','geometry':mapping(g),'properties':{'id':gid,'populationModelCount':value,'populationNorm':value/maximum if value is not None and maximum else None,'populationPixelCount':cells[gid],'populationModelDensity':value/area if value is not None and area else None,'populationYear':2025,'populationIsProjection':True,'populationCalibrated':False,'areaKm2':area}})
    return {'type':'FeatureCollection','features':features,'metadata':{**read(SOURCE/'population/population_metadata.json'),'coordSystem':'WGS84','source':'GHS-POP R2023A','isProjection':True,'calibrated':False,'assignedPopulation':sum(counts.values()),'unassignedPopulation':sum(unassigned),'unassignedPixels':len(unassigned),'gridAssignment':'pixel centre; shared boundaries use smallest grid ID; edge tolerance 5m','notice':'2025模型人口，未经统计人口校准；仅作空间分布参考，不能当作真实充电需求。'}}

def point_params(f):
    x,y=f['geometry']['coordinates'];gx,gy=wgs84_to_gcj02(x,y)
    return x,y,x,y,x,y,gx,gy

def apply_database(conn,charging,pois,population):
    report={}
    with conn.cursor() as c:
        c.execute("SET LOCAL lock_timeout='10s'");c.execute('SELECT pg_advisory_xact_lock(4326027)')
        c.execute('SELECT id FROM stations WHERE NOT is_synthetic')
        missing={r[0] for r in c.fetchall()}-{f['properties']['source_id'] for f in charging['features']}
        if missing:raise ValueError('Existing real stations missing from snapshot: '+str(sorted(missing)))
        c.execute('ALTER TABLE stations ALTER COLUMN charge_type DROP NOT NULL')
        c.execute('ALTER TABLE stations ALTER COLUMN charge_type DROP DEFAULT')
        c.execute("ALTER TABLE stations ADD COLUMN IF NOT EXISTS baseline_record jsonb, ADD COLUMN IF NOT EXISTS collected_at timestamptz")
        c.execute('ALTER TABLE facility_pois ALTER COLUMN address DROP NOT NULL')
        c.execute("UPDATE stations SET status='retired',available_count=0,updated_at=now() WHERE is_synthetic AND status<>'retired'")
        report['archived_demo_rows']=c.rowcount
        for f in charging['features']:
            p=f['properties'];x,y=f['geometry']['coordinates'];gx,gy=wgs84_to_gcj02(x,y)
            c.execute("""INSERT INTO stations(id,name,address,lng,lat,geom,geom_wgs84,geom_gcj02,
                operator,charge_type,total_count,fast_count,regular_count,available_count,power_kw,
                electricity_price,service_price,parking_fee,opening_hours,status,is_synthetic,data_source,dataset_id,observed_at,notes,simulated_fields,baseline_record,collected_at)
                VALUES(%s,%s,%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),0),
                %s,%s,%s,NULL,NULL,NULL,NULL,NULL,NULL,NULL,%s,'active',false,'amap-poi',%s,NULL,%s,'[]'::jsonb,%s,%s)
                ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,lng=EXCLUDED.lng,lat=EXCLUDED.lat,
                geom=EXCLUDED.geom,geom_wgs84=EXCLUDED.geom_wgs84,geom_gcj02=EXCLUDED.geom_gcj02,
                operator=EXCLUDED.operator,charge_type=EXCLUDED.charge_type,total_count=EXCLUDED.total_count,
                fast_count=NULL,regular_count=NULL,available_count=NULL,power_kw=NULL,electricity_price=NULL,service_price=NULL,parking_fee=NULL,
                site_type=NULL,opening_hours=EXCLUDED.opening_hours,status='active',is_synthetic=false,data_source='amap-poi',dataset_id=EXCLUDED.dataset_id,
                observed_at=NULL,notes=EXCLUDED.notes,simulated_fields='[]'::jsonb,baseline_record=EXCLUDED.baseline_record,collected_at=EXCLUDED.collected_at,updated_at=now()""",
                (p['source_id'],p['name'],p.get('address'),x,y,x,y,x,y,gx,gy,p.get('operator'),p.get('charge_type'),p.get('charger_unit_count'),p.get('opening_hours'),DATASET,'真实地图地点；公共开放与设备参数以逐字段证据为准，缺失保留未知。',Json(p),p.get('collected_at')))
        # Replace these two older snapshots after full database backup. The shared
        # source IDs also appear in facility_pois, allowing demand de-duplication.
        for table,category in [('residential_pois','residential'),('commercial_pois','commercial')]:
            c.execute(sql.SQL('DELETE FROM {}').format(sql.Identifier(table)))
            for f in pois['features']:
                p=f['properties']
                if category not in p.get('categories',[]):continue
                x,y=f['geometry']['coordinates'];gx,gy=wgs84_to_gcj02(x,y)
                c.execute(sql.SQL('INSERT INTO {}(id,name,address,lng,lat,geom,geom_wgs84,geom_gcj02) VALUES(%s,%s,%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),0))').format(sql.Identifier(table)),(p['source_id'],p['name'],p.get('address'),x,y,x,y,x,y,gx,gy))
        for f in pois['features']:
            p=f['properties'];x,y=f['geometry']['coordinates'];gx,gy=wgs84_to_gcj02(x,y)
            categories=list(dict.fromkeys(p.get('source_categories',[])+p.get('categories',[])))
            c.execute("""INSERT INTO facility_pois(id,name,address,categories,poi_type,typecode,adcode,district,data_source,source_url,fetched_at,verification_status,lng,lat,geom,geom_wgs84,geom_gcj02,raw)
                VALUES(%s,%s,%s,%s,%s,%s,'411002','魏都区','amap-poi',%s,%s,'map_record_only',%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),4326),ST_SetSRID(ST_MakePoint(%s,%s),0),%s)
                ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,categories=EXCLUDED.categories,poi_type=EXCLUDED.poi_type,typecode=EXCLUDED.typecode,source_url=EXCLUDED.source_url,fetched_at=EXCLUDED.fetched_at,lng=EXCLUDED.lng,lat=EXCLUDED.lat,geom=EXCLUDED.geom,geom_wgs84=EXCLUDED.geom_wgs84,geom_gcj02=EXCLUDED.geom_gcj02,raw=EXCLUDED.raw,updated_at=now()""",
                (p['source_id'],p['name'],p.get('address'),categories,p.get('raw_category'),p.get('raw_typecode'),p['source_url'],p.get('collected_at'),x,y,x,y,x,y,gx,gy,Json(p)))
        c.execute("""CREATE OR REPLACE VIEW facility_grid_counts AS WITH assigned AS (
            SELECT p.id,p.categories,h.id AS hex_id FROM facility_pois p CROSS JOIN LATERAL (
                SELECT g.id FROM hex_grid g WHERE ST_Covers(g.geom,p.geom) OR ST_DWithin(g.geom::geography,p.geom::geography,5)
                ORDER BY ST_Covers(g.geom,p.geom) DESC, ST_Distance(g.geom::geography,p.geom::geography),g.id LIMIT 1) h)
            SELECT g.id,count(a.id) FILTER(WHERE 'parking'=ANY(a.categories))::integer AS parking_count,
            count(a.id) FILTER(WHERE a.categories && ARRAY['office','company','industrial_park','hospital','school'])::integer AS office_count,
            count(a.id) FILTER(WHERE 'work'=ANY(a.categories))::integer AS workplace_count,
            count(a.id) FILTER(WHERE 'hospital'=ANY(a.categories))::integer AS hospital_count,
            count(a.id) FILTER(WHERE 'school'=ANY(a.categories))::integer AS school_count,
            count(a.id) FILTER(WHERE 'leisure'=ANY(a.categories))::integer AS activity_count,
            count(a.id)::integer AS facility_count,
            count(a.id) FILTER(WHERE 'commercial'=ANY(a.categories))::integer AS shopping_count,
            count(a.id) FILTER(WHERE 'leisure'=ANY(a.categories))::integer AS leisure_count,
            count(a.id) FILTER(WHERE 'public_service'=ANY(a.categories))::integer AS public_service_count
            FROM hex_grid g LEFT JOIN assigned a ON a.hex_id=g.id GROUP BY g.id""")
        report['grid_indicators']=recalculate_indicators(c)
        c.execute("CREATE TABLE IF NOT EXISTS planning_population_grid(grid_id integer PRIMARY KEY REFERENCES hex_grid(id), properties jsonb NOT NULL,geom geometry(Geometry,4326) NOT NULL)")
        for f in population['features']:
            c.execute("INSERT INTO planning_population_grid VALUES(%s,%s,ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)) ON CONFLICT(grid_id) DO UPDATE SET properties=EXCLUDED.properties,geom=EXCLUDED.geom",(f['properties']['id'],Json(f['properties']),json.dumps(f['geometry'])))
        c.execute("CREATE TABLE IF NOT EXISTS planning_baseline_catalog(id text PRIMARY KEY,payload jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())")
        metadata={**read(SOURCE/'reports/quality_report.json'),'datasetId':DATASET,'activatedAt':datetime.now(timezone.utc).isoformat(),'syntheticIncluded':False,'populationCalibrated':False}
        for key,value in [('metadata',metadata),('population',population['metadata']),('parameters',read(SOURCE/'parameters/scenario_params.json')),('timeProfiles',list(csv.DictReader((SOURCE/'parameters/time_profiles.csv').open(encoding='utf-8-sig')))),('activityAssumptions',list(csv.DictReader((SOURCE/'parameters/time_activity_assumptions.csv').open(encoding='utf-8-sig')))),('sources',list(csv.DictReader((SOURCE/'metadata/data_sources.csv').open(encoding='utf-8-sig'))))]:
            c.execute("INSERT INTO planning_baseline_catalog(id,payload) VALUES(%s,%s) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()",(key,Json(value)))
        for table in ['stations','facility_pois','residential_pois','commercial_pois','planning_population_grid']:
            c.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table)));report[table]=c.fetchone()[0]
        c.execute("SELECT count(*) FROM stations s WHERE NOT is_synthetic AND status='active' AND EXISTS(SELECT 1 FROM weidu_boundary b WHERE ST_Covers(b.geom,s.geom))")
        report['active_real_stations_inside']=c.fetchone()[0]
    return report

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    charging=read(SOURCE/'charging/charging_stations.geojson');pois=read(SOURCE/'pois/pois.geojson')
    if not read(SOURCE/'reports/validation_checks.json')['passed']:raise ValueError('Source validation has not passed')
    backup=ROOT/'backend/backups'/('planning_baseline_'+datetime.now().strftime('%Y%m%d_%H%M%S'))
    if args.apply:
        backup.mkdir(parents=True)
        environment=os.environ.copy();environment['PGPASSWORD']=os.getenv('DB_PASSWORD','')
        # Importing get_db_connection loads the project's dotenv values first.
        subprocess.run([os.getenv('PG_DUMP_PATH',r'D:\SQL\PostgreSQL\17\bin\pg_dump.exe'),'--host=localhost','--port=5433','--username=postgres','--dbname=nev_webgis','--format=custom','--file='+str(backup/'before.dump')],env=environment,check=True,capture_output=True)
        for name in ['weidu-osm-roads.geojson','weidu-osm-road-network.json','weidu-siting-context.geojson']:
            shutil.copy2(ROOT/'data/processed'/name,backup/name)
    conn=get_db_connection()
    try:
        with conn.cursor() as c:population=population_grids(c)
        report=apply_database(conn,charging,pois,population)
        if args.apply:
            conn.commit()
            ACTIVE.mkdir(parents=True,exist_ok=True)
            for folder in ['population','parameters','metadata']:
                for p in (SOURCE/folder).iterdir():
                    if p.is_file() and p.suffix in ('.json','.csv','.tif'):shutil.copy2(p,ACTIVE/p.name)
            write(ACTIVE/'population-grid.geojson',population)
            shutil.copy2(SOURCE/'roads/roads.geojson',ROOT/'data/processed/weidu-osm-roads.geojson')
            shutil.copy2(SOURCE/'roads/road_network.json',ROOT/'data/processed/weidu-osm-road-network.json')
            context=read(ROOT/'data/processed/weidu-siting-context.geojson');known={str(f['properties']['id']) for f in context['features']}
            for f in read(SOURCE/'buildings/buildings_parking.geojson')['features']:
                p=f['properties'];sid=str(p['id']);aliases={sid,sid.removeprefix('amap:')}
                if known & aliases:continue
                context['features'].append({**f,'properties':{**p,'id':sid,'sourceUrl':p.get('source_url') or p.get('sourceUrl'),'category':p['category'],'coordSystem':'WGS84'}});known.add(sid)
            context['metadata']['featureCount']=len(context['features']);write(ROOT/'data/processed/weidu-siting-context.geojson',context)
        else:conn.rollback()
        report.update(applied=args.apply,backup=str(backup) if args.apply else None,population=population['metadata'])
        write(ROOT/'docs/reports'/('planning-baseline-integration.json' if args.apply else 'planning-baseline-validation.json'),report)
        print(json.dumps({k:v for k,v in report.items() if k not in ['grid_indicators','population']},ensure_ascii=False))
    except Exception:
        conn.rollback();raise
    finally:conn.close()
if __name__=='__main__':main()
