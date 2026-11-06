"""Reproducible, read-only acquisition and QA for Weidu EV planning (Python 3.12).

No database writes. Credentials remain in environment/local dotenv files.
Run from any directory: python pipeline.py core|population|osm|amap|qa|all
"""
import argparse
import csv
import hashlib
import json
import math
import os
import re
import shutil
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import requests
import numpy as np
import pyproj
# PostgreSQL may set PROJ_LIB globally to an older database. This process uses
# the Python wheel's matching database; no system environment is modified.
os.environ['PROJ_DATA'] = pyproj.datadir.get_data_dir()
os.environ['PROJ_LIB'] = pyproj.datadir.get_data_dir()
from pyproj import Geod, Transformer
from shapely import make_valid
from shapely.geometry import shape, mapping, Point, Polygon, LineString, box
from shapely.ops import transform, unary_union, polygonize
from shapely.strtree import STRtree

OUT = Path(__file__).resolve().parents[1]
PROJECT = OUT.parent
sys.path.insert(0, str(PROJECT))
from geo_helpers import gcj02_to_wgs84, wgs84_to_gcj02, normalize_roads, element_geometry

GEOD = Geod(ellps='WGS84')
PROJECTOR = Transformer.from_crs(4326, 32649, always_xy=True).transform
INVERSE = Transformer.from_crs(32649, 4326, always_xy=True).transform
SESSION = requests.Session()
SESSION.headers['User-Agent'] = 'WeiduGIS-StudentResearch/1.0 (academic public-data snapshot)'
WORLDPOP_URL = 'https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2025/CHN/v1/100m/constrained/chn_pop_2025_CN_100m_R2025A_v1.tif'
AMAP_URL = 'https://restapi.amap.com/v3/place/polygon'
OSM_ENDPOINT = os.getenv('WEIDU_OVERPASS_ENDPOINT','https://overpass-api.de/api/interpreter')
CATEGORY_MAP = {'residential':'residential', 'office':'work', 'company':'work', 'industrial_park':'work',
                'mall':'commercial', 'supermarket':'commercial', 'restaurant':'commercial',
                'park':'leisure', 'leisure':'leisure', 'hospital':'public_service',
                'school':'public_service', 'parking':'public_service', 'government_transport':'public_service'}

def now():
    return datetime.now(timezone.utc).isoformat()

def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def input_path(relative):
    bundled=OUT/'raw/input_snapshots'/relative
    return bundled if bundled.exists() else PROJECT/relative

def save(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)

def csv_save(path, rows, fields=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = fields or list(rows[0]) if rows else fields or []
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

def fc(features, **metadata):
    return {'type':'FeatureCollection', 'features':features, 'metadata':{'crs':'EPSG:4326', 'processed_at':now(), 'feature_count':len(features), **metadata}}

def feature(geom, props):
    return {'type':'Feature', 'geometry':mapping(geom), 'properties':props}

def border():
    return unary_union([shape(f['geometry']) for f in read(OUT/'boundary/weidu_boundary.geojson')['features']])

def fetch_json(url, params=None, timeout=45):
    r = SESSION.get(url, params=params, timeout=(15, timeout))
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and data.get('remark'):
        raise ValueError('Remote query incomplete: ' + str(data['remark'])[:160])
    return data

def core():
    """Prefer project WGS84 PostGIS export; never relabel the raw GCJ-02 boundary."""
    cached=OUT/'raw/project_boundary_wgs84.json'
    raw_boundary = read(cached) if cached.exists() else fetch_json('http://127.0.0.1:8000/api/boundary', timeout=15)
    save(OUT/'raw/project_boundary_wgs84.json', raw_boundary)
    geometries = [shape(f['geometry']) for f in raw_boundary['features']]
    original_invalid = sum(not g.is_valid for g in geometries)
    geom = unary_union([make_valid(g) for g in geometries])
    if geom.is_empty or geom.geom_type not in ('Polygon','MultiPolygon') or not geom.is_valid:
        raise ValueError('Invalid study boundary')
    area = abs(GEOD.geometry_area_perimeter(geom)[0])/1e6
    save(OUT/'boundary/weidu_boundary.geojson', fc([feature(geom, {'name':'魏都区','adcode':'411002','source':'existing_project_PostGIS', 'source_boundary':'public/geojson/weidu.json (AreaCity-Polygon)', 'original_coordinate_assumption':'GCJ-02; converted previously by project migration', 'boundary_vintage':None,'officially_certified':False})],
         source='existing project boundary; not a new official survey', source_url='http://127.0.0.1:8000/api/boundary', area_km2=area, original_invalid=original_invalid, license='Original boundary redistribution rights not verified', accuracy_note='Existing project research boundary; compare current administrative scope before population calibration.'))
    # Audit synthetic sources explicitly; exclude every such row from official exports.
    synthetic_source=PROJECT/'data/managed/xuchang-stations.csv'
    if synthetic_source.exists():
        rows = list(csv.DictReader(synthetic_source.open(encoding='utf-8-sig')))
        synthetic = sum(r.get('isSynthetic','').lower() in ('true','1') for r in rows)
        save(OUT/'metadata/excluded_simulated_sources.json', {'file':'data/managed/xuchang-stations.csv','rows':len(rows),'synthetic_rows':synthetic,'action':'excluded; not copied into observed charging data'})
    else:
        synthetic=read(OUT/'metadata/excluded_simulated_sources.json')['synthetic_rows']
    clean_pois()
    clean_charging()
    roads = read(input_path('data/processed/weidu-osm-roads.geojson'))
    network = read(input_path('data/processed/weidu-osm-road-network.json'))
    save(OUT/'roads/roads.geojson', roads)
    save(OUT/'roads/road_network.json', network)
    shutil.copy2(input_path('data/raw/osm-roads-overpass.json'), OUT/'raw/osm_roads_existing.json')
    print(json.dumps({'stage':'core','boundary_area_km2':round(area,4),'excluded_synthetic':synthetic,'roads':len(roads['features'])}, ensure_ascii=False),flush=True)

def clean_pois():
    b = border()
    data = read(input_path('data/raw/amap-facilities.json'))
    files = [(data, 'existing_amap_facilities')]
    if (OUT/'raw/amap_government_transport.json').exists():
        files.append((read(OUT/'raw/amap_government_transport.json'), 'new_amap_government_transport'))
    records, excluded, invalid, duplicate_ids = {}, 0, 0, 0
    for payload, source_label in files:
        for category, query in payload.get('queries',{}).items():
            if category not in CATEGORY_MAP:
                continue
            for p in query.get('pois',[]):
                try:
                    x,y = map(float,p.get('location','').split(','))
                    if not all(map(math.isfinite,(x,y))) or not (100<x<125 and 20<y<45):
                        raise ValueError()
                    lon,lat = gcj02_to_wgs84(x,y)
                    point = Point(lon,lat)
                except (ValueError,TypeError):
                    invalid += 1
                    continue
                if not b.covers(point):
                    excluded += 1
                    continue
                poi_id = p.get('id')
                if not poi_id:
                    invalid += 1
                    continue
                if poi_id in records:
                    duplicate_ids += 1
                    r = records[poi_id]['properties']
                    r['source_categories'] = sorted(set(r['source_categories']+[category]))
                    r['categories'] = sorted(set(r['categories']+[CATEGORY_MAP[category]]))
                    continue
                records[poi_id] = feature(point, {'id':'amap:'+poi_id,'name':p.get('name') or None,'address':p.get('address') or None,
                    'raw_category':p.get('type') or None,'raw_typecode':p.get('typecode') or None,
                    'category':CATEGORY_MAP[category],'categories':[CATEGORY_MAP[category]],'source_categories':[category],
                    'source':'AMap','source_id':poi_id,'source_url':'https://www.amap.com/place/'+poi_id,
                    'source_snapshot':source_label,'collected_at':payload.get('finishedAt') or payload.get('updatedAt'),
                    'source_updated_at':None,'original_crs':'GCJ-02','crs':'EPSG:4326','is_simulated':False,
                    'population':None,'visitors':None,'charging_sessions':None})
    features = list(records.values())
    save(OUT/'pois/pois.geojson',fc(features, source='AMap official place API snapshots', source_url='https://lbs.amap.com/api/webservice/guide/api-advanced/search',
         categories=dict(Counter(f['properties']['category'] for f in features)),duplicates_by_source_id_removed=duplicate_ids, outside_boundary_removed=excluded,invalid_records_removed=invalid,
         completeness='Pagination termination is not a guarantee of complete real-world POI coverage; existing API category results may be capped.',
         license='AMap developer agreement applies; local academic use. Bulk redistribution rights not confirmed.',meaning='Location records, not population, visitors or charging counts.'))
    print('POIs:',len(features),'invalid:',invalid,'outside:',excluded,flush=True)

def clean_charging():
    b = border()
    halo = transform(INVERSE, transform(PROJECTOR,b).buffer(10000))
    source = read(input_path('data/raw/amap-stations.json'))
    records = {}
    for p in source.get('pois',[]):
        try:
            lon,lat = gcj02_to_wgs84(*map(float,p['location'].split(',')))
            point = Point(lon,lat)
            if not halo.covers(point):
                continue
        except (KeyError,ValueError,TypeError):
            continue
        if not p.get('id'):
            continue
        records[p['id']] = charging_poi(p, point, b, collected=None, snapshot='existing raw; acquisition date not embedded')
    extra = OUT/'raw/amap_charging_context.json'
    if extra.exists():
        d = read(extra)
        for query in d.get('queries',{}).values():
            for p in query.get('pois',[]):
                try:
                    point = Point(*gcj02_to_wgs84(*map(float,p['location'].split(','))))
                    if halo.covers(point) and p.get('id'):
                        records[p['id']] = charging_poi(p,point,b,d.get('finishedAt') or d.get('updatedAt'),'new official API query')
                except (KeyError,ValueError,TypeError):
                    continue
    # Use explicit, per-field public evidence only. Never copy enriched simulation fields.
    verified = read(input_path('data/managed/station-verification.json'))
    equipment = read(input_path('data/managed/station-equipment.json'))
    for sid,f in records.items():
        p=f['properties']; evidence=verified.get('stations',{}).get(sid,{})
        if evidence.get('stationName') == p['name']:
            fields=evidence.get('fields',{})
            for src,dst in [('openingHours','opening_hours'),('chargeType','charge_type'),('accessPolicy','access_policy')]:
                item=fields.get(src,{})
                if item.get('state')=='known' and item.get('value') is not None:
                    p[dst]=item['value']
                    p['field_evidence'][dst]={'checked_at':item.get('checkedAt'),'sources':[verified['sources'][s] for s in item.get('sources',[]) if s in verified.get('sources',{})]}
        e=equipment.get('stations',{}).get(sid,{})
        if e.get('stationName')==p['name'] and e.get('basis')=='public_source' and e.get('complete') is True:
            p['max_gun_power_kw']=e.get('maxGunPowerKw')
            units=[g.get('unitCount') for g in e.get('groups',[])]
            p['charger_unit_count']=sum(units) if units and all(type(n) is int for n in units) else None
            p['equipment_note']=e.get('note')
            p['field_evidence']['equipment']={'checked_at':e.get('checkedAt'),'sources':[equipment['sources'][s] for s in e.get('sources',[]) if s in equipment.get('sources',{})]}
        # A directory listing or 'active' DB flag does not prove public access.
    features=list(records.values())
    save(OUT/'charging/charging_stations.geojson',fc(features, source='AMap raw official API + explicit existing public evidence',
        inside_boundary=sum(f['properties']['inside_boundary'] for f in features),context_buffer_m=10000,
        observed_public_access_only=False,public_access_note='Candidate charging locations; unknown public access remains null. Do not count all locations as verified public stations.',
        unknown_fields_remain_null=True,synthetic_rows_included=0,license='AMap terms; attached evidence retains source rights.'))
    print('Charging locations:',len(features),'inside:',sum(f['properties']['inside_boundary'] for f in features),flush=True)

def charging_poi(p,point,b,collected,snapshot):
    return feature(point,{'id':'amap:'+p['id'],'source_id':p['id'],'name':p.get('name') or None,'address':p.get('address') or None,
        'operator':None,'public_access':None,'access_policy':None,'gun_count':None,'charger_unit_count':None,
        'charge_type':None,'max_gun_power_kw':None,'installed_power_kw':None,'opening_hours':None,
        'source':'AMap','source_url':'https://www.amap.com/place/'+p['id'],'raw_category':p.get('type'),
        'collected_at':collected,'source_updated_at':None,'snapshot_note':snapshot,'original_crs':'GCJ-02','crs':'EPSG:4326',
        'inside_boundary':b.covers(point),'is_simulated':False,
        'ordinary_private_ev_eligibility':None,
        'scope_review_flags':re.findall('两轮|电动自行车|电瓶车|重卡|公交|出租|换电|物流',p.get('name','')),
        'scope_review_note':'Name keyword flag only; verify vehicle compatibility, charging vs swapping, and public access before supply analysis.',
        'field_evidence':{}})

def population_worldpop():
    """Download the publisher raster, then crop without interpolation of counts."""
    import rasterio
    from rasterio.mask import mask, raster_geometry_mask
    raw=OUT/'raw/chn_pop_2025_CN_100m_R2025A_v1.tif'
    if not raw.exists():
        part=raw.with_suffix('.tif.part')
        with SESSION.get(WORLDPOP_URL,stream=True,timeout=(20,90)) as r:
            r.raise_for_status()
            size=int(r.headers.get('Content-Length',0)); count=0; last=time.monotonic()
            with part.open('wb') as f:
                for chunk in r.iter_content(1024*1024):
                    if chunk:
                        f.write(chunk);count+=len(chunk)
                    if time.monotonic()-last>20:
                        print('WorldPop downloaded MiB:',round(count/1048576,1),'/',round(size/1048576,1),flush=True);last=time.monotonic()
        if size and count!=size:
            raise ValueError('Incomplete publisher raster download')
        part.replace(raw)
    b=border()
    with rasterio.open(raw) as src:
        if src.crs.to_epsg()!=4326:
            raise ValueError('Unexpected source CRS; polygon needs explicit transformation')
        arr,affine=mask(src,[mapping(b)],crop=True,all_touched=False,filled=True)
        polygon_mask,_,_=raster_geometry_mask(src,[mapping(b)],crop=True,all_touched=False)
        meta=src.profile.copy();meta.update(driver='GTiff',height=arr.shape[1],width=arr.shape[2],transform=affine,compress='deflate',tiled=True,blockxsize=128,blockysize=128,BIGTIFF='IF_SAFER')
        target=OUT/'population/population.tif';target.parent.mkdir(exist_ok=True)
        with rasterio.open(target,'w',**meta) as dst:
            dst.write(arr)
            dst.set_band_description(1,'Estimated residential population count, persons/pixel (2025)')
            dst.update_tags(SOURCE_URL=WORLDPOP_URL,LICENSE='CC-BY-4.0',UNIT='persons_per_pixel',REFERENCE_YEAR='2025',RELEASE='R2025A_v1',IS_OBSERVATION='false',CLIP_RULE='pixel centre within existing project boundary; no resampling',BOUNDARY_STATUS='project research boundary; vintage unverified')
        valid=np.isfinite(arr[0]) & (arr[0]!=src.nodata) & ~polygon_mask
        within=int((~polygon_mask).sum());nodata=int(((arr[0]==src.nodata)&~polygon_mask).sum())
        centre=b.centroid
        dx=GEOD.inv(centre.x,centre.y,centre.x+src.res[0],centre.y)[2]
        dy=GEOD.inv(centre.x,centre.y,centre.x,centre.y+src.res[1])[2]
        report={'source_url':WORLDPOP_URL,'source_file':raw.name,'reference_year':2025,'release':'R2025A v1','units':'estimated persons per pixel','license':'CC-BY-4.0','crs':str(src.crs),'resolution_degrees':list(src.res),'resolution_m_at_study_centre':[dx,dy],'dimensions':[arr.shape[2],arr.shape[1]],'nodata':src.nodata,'pixel_centres_inside':within,'valid_cells':int(valid.sum()),'nodata_inside':nodata,'nodata_inside_percent':100*nodata/within if within else None,'estimated_population_sum':float(arr[0][valid].sum(dtype=np.float64)),'min':float(arr[0][valid].min()) if valid.any() else None,'max':float(arr[0][valid].max()) if valid.any() else None,'negative_valid_values':int((arr[0][valid]<0).sum()),'method':'Centre-in-polygon mask; cells crossing the border are not area-weighted. Sum is modelled, not census count. Nodata is not replaced by zero.','processed_at':now()}
    report['validation_warning']='Administrative-population plausibility requires review: government introduction mixes about 500000/525000 people and different vintages; model total is not calibrated to either. Do not present this as official district population.'
    save(OUT/'population/population_metadata.json',report)
    print(json.dumps({'stage':'population',**report},ensure_ascii=False),flush=True)

def population():
    """GHSL official geographic tile, no reprojection/resampling of counts.

    R6_C30 selected from the official geographic 10-degree grid covering the AOI;
    actual geographic bounds are checked before accepting the file.
    """
    import zipfile
    import rasterio
    from rasterio.mask import mask, raster_geometry_mask
    filename='GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0_R6_C30'
    base='https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/tiles/'
    url=base+filename+'.zip'; archive=OUT/'raw'/(filename+'.zip'); raw=OUT/'raw'/(filename+'.tif')
    if not archive.exists():
        part=archive.with_suffix('.zip.part')
        for attempt in range(5):
            offset=part.stat().st_size if part.exists() else 0
            try:
                with SESSION.get(url,headers={'Range':f'bytes={offset}-'} if offset else {},stream=True,timeout=(20,90)) as r:
                    r.raise_for_status();append=bool(offset and r.status_code==206)
                    count=offset if append else 0; expected=int(r.headers.get('Content-Length',0))+(offset if append else 0);last=time.monotonic()
                    with part.open('ab' if append else 'wb') as f:
                        for chunk in r.iter_content(1024*1024):
                            f.write(chunk);count+=len(chunk)
                            if time.monotonic()-last>20:
                                print('GHSL downloaded MiB:',round(count/1048576,1),'/',round(expected/1048576,1),flush=True);last=time.monotonic()
                if expected and count!=expected:raise ValueError('GHSL download incomplete')
                part.replace(archive);break
            except (requests.RequestException,ValueError) as failure:
                print('GHSL download retry:',attempt+1,type(failure).__name__,flush=True)
                if attempt==4:raise
                time.sleep(3)
    if not raw.exists():
        with zipfile.ZipFile(archive) as z:
            member=next(n for n in z.namelist() if Path(n).name==filename+'.tif')
            with z.open(member) as source,raw.open('wb') as target:shutil.copyfileobj(source,target)
    b=border()
    with rasterio.open(raw) as src:
        if src.crs != rasterio.crs.CRS.from_epsg(4326) or not box(*src.bounds).covers(b):
            raise ValueError('Selected GHSL tile does not cover the boundary or CRS differs')
        nodata_value=-200.0
        arr,affine=mask(src,[mapping(b)],crop=True,all_touched=False,nodata=nodata_value)
        polygon_mask,_,_=raster_geometry_mask(src,[mapping(b)],crop=True,all_touched=False)
        meta=src.profile.copy();meta.update(driver='GTiff',height=arr.shape[1],width=arr.shape[2],transform=affine,crs='EPSG:4326',nodata=nodata_value,compress='deflate',tiled=True,blockxsize=128,blockysize=128,BIGTIFF='IF_SAFER')
        target=OUT/'population/population.tif';target.parent.mkdir(exist_ok=True)
        with rasterio.open(target,'w',**meta) as dst:
            dst.write(arr);dst.set_band_description(1,'Projected residential inhabitants per cell, GHS-POP 2025')
            dst.update_tags(SOURCE_URL=url,LICENSE='European Commission reuse with attribution',UNIT='persons_per_pixel',REFERENCE_YEAR='2025',RELEASE='GHS_POP_R2023A_V1_0',IS_OBSERVATION='false',CLIP_RULE='pixel centre within project boundary; no resampling')
        valid=np.isfinite(arr[0])&(arr[0]!=nodata_value)&~polygon_mask
        centre=b.centroid;within=int((~polygon_mask).sum());nodata=int(((arr[0]==nodata_value)&~polygon_mask).sum())
        report={'source':'GHS-POP','source_url':url,'metadata_url':'https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php','reference_year':2025,'release':'R2023A V1-0','is_projection':True,'units':'estimated persons per pixel; not persons/km2','crs':'EPSG:4326','resolution_degrees':list(src.res),'resolution_m_at_study_centre':[GEOD.inv(centre.x,centre.y,centre.x+src.res[0],centre.y)[2],GEOD.inv(centre.x,centre.y,centre.x,centre.y+src.res[1])[2]],'dimensions':[arr.shape[2],arr.shape[1]],'nodata':nodata_value,'source_nodata':src.nodata,'pixel_centres_inside':within,'valid_cells':int(valid.sum()),'nodata_inside':nodata,'estimated_population_sum':float(arr[0][valid].sum(dtype=np.float64)),'min':float(arr[0][valid].min()) if valid.any() else None,'max':float(arr[0][valid].max()) if valid.any() else None,'negative_valid_values':int((arr[0][valid]<0).sum()),'source_tile_bounds':list(src.bounds),'processed_at':now(),'clip_method':'No resampling; pixel-centre mask. Border cells not area-weighted. Modelled total is not district census.','worldpop_attempt':'Official 2025 922251437-byte raster download interrupted after ~25 MiB; HTTP Range returned 200, not 206. Partial .part file is not a valid raster and is excluded.'}
    report['validation_warning']='Government introduction reports about 500000/525000 people with mixed dates and scopes, while the cropped GHSL sum is about 892503. Review model/vintage/boundary mismatch before absolute demand scaling; do not call this the official district population.'
    save(OUT/'population/population_metadata.json',report)
    print(json.dumps({'stage':'population',**report},ensure_ascii=False),flush=True)

def amap():
    """Two ordinary paginated queries; stop on quota/auth errors, no subdivisions."""
    from dotenv import load_dotenv
    load_dotenv(PROJECT/'backend/.env.local')
    load_dotenv(PROJECT/'.env.local')
    key=os.getenv('AMAP_WEB_KEY') or os.getenv('AMAP_KEY')
    if not key:
        save(OUT/'metadata/amap_acquisition_status.json',{'status':'needs_api_key','requested_at':now()})
        return
    b=border(); halo=transform(INVERSE,transform(PROJECTOR,b).buffer(10000))
    statuses={}
    for category,types,region,path in [
        ('charging','011100',halo,'amap_charging_context.json'),
        ('government_transport','130000|150000',b,'amap_government_transport.json')]:
        west,south,east,north=region.bounds
        polygon=f'{west:.6f},{south:.6f}|{east:.6f},{north:.6f}'
        target=OUT/'raw'/path
        if target.exists() and read(target).get('complete'):
            print('Using completed official API snapshot:',path,flush=True)
            continue
        query={'types':types,'status':'collecting','pages':[],'pois':[]}
        payload={'source':'AMap','endpoint':AMAP_URL,'coordSystem':'GCJ-02','query_bbox_wgs84':list(region.bounds),'startedAt':now(),'queries':{category:query}}
        # AMap polygon arguments use GCJ-02, not the WGS84 analysis bounding box.
        sw=wgs84_to_gcj02(west,south);ne=wgs84_to_gcj02(east,north)
        polygon=f'{sw[0]:.6f},{sw[1]:.6f}|{ne[0]:.6f},{ne[1]:.6f}'
        seen=set()
        for page in range(1,41):
            time.sleep(1.3)
            try:
                d=fetch_json(AMAP_URL,{'key':key,'types':types,'polygon':polygon,'offset':25,'page':page,'extensions':'all'},timeout=35)
            except requests.RequestException as failure:
                query['status']='network_failure';query['error_kind']=type(failure).__name__;break
            if d.get('status')!='1':
                query['status']='api_refused';query['error_info']=d.get('info');query['error_code']=d.get('infocode');break
            pois=d.get('pois',[])
            added=[p for p in pois if p.get('id') not in seen]
            query['pois'].extend(added);seen.update(p['id'] for p in added if p.get('id'))
            query['pages'].append({'page':page,'collected_at':now(),'returned':len(pois),'new':len(added),'reported_count':d.get('count')})
            payload['updatedAt']=now()
            if len(pois)<25:query['status']='complete'
            elif not added:query['status']='repeated_page'
            elif page==40:query['status']='page_limit'
            save(target,payload)
            print('AMap',category,'page',page,'returned',len(pois),'total',len(query['pois']),query['status'],flush=True)
            if query['status']!='collecting':break
        reported=max([int(p.get('reported_count') or 0) for p in query['pages']] or [0])
        if query['status']=='complete' and len(query['pois'])<reported:query['status']='api_result_window_exhausted'
        payload['finishedAt']=now();payload['complete']=query['status']=='complete';payload['exhaustive']=False;save(target,payload)
        statuses[category]={'status':query['status'],'records':len(query['pois']),'page_count':len(query['pages'])}
        if query['status']=='api_refused':
            print('Official API refused; not retrying or bypassing limits.',query.get('error_code'),flush=True)
            break
    save(OUT/'metadata/amap_acquisition_status.json',statuses)
    clean_pois();clean_charging()

def overpass(query,name):
    """Save complete responses; failed requests never replace a good snapshot."""
    target=OUT/'raw'/name
    if target.exists():
        return read(target)
    try:
        r=SESSION.post(OSM_ENDPOINT,data={'data':query},timeout=(20,200))
        r.raise_for_status();d=r.json()
        if d.get('remark') or not isinstance(d.get('elements'),list):
            raise ValueError('Incomplete OSM response')
        save(target,d)
        save(OUT/'metadata'/(Path(name).stem+'_request.json'),{'endpoint':OSM_ENDPOINT,'query':query,'fetched_at':now(),'osm_base_timestamp':d.get('osm3s',{}).get('timestamp_osm_base'),'elements':len(d['elements'])})
        return d
    except (requests.RequestException,ValueError) as e:
        response=getattr(e,'response',None)
        save(OUT/'metadata'/(Path(name).stem+'_failure.json'),{'endpoint':OSM_ENDPOINT,'query':query,'attempted_at':now(),'error_kind':type(e).__name__,'http_status':response.status_code if response is not None else None,'status':'not_acquired; no substitute geometry generated'})
        print('OSM acquisition failed:',name,type(e).__name__,response.status_code if response is not None else '',flush=True)
        return None

def osm():
    b=border(); halo=transform(INVERSE,transform(PROJECTOR,b).buffer(10000))
    west,south,east,north=halo.bounds
    bounds=f'{south:.7f},{west:.7f},{north:.7f},{east:.7f}'
    query=f'[out:json][timeout:180];(way["highway"]["area"!="yes"]({bounds});relation["type"="restriction"]({bounds});node["barrier"]({bounds}););out meta geom;'
    print('Requesting OSM road context (10 km halo)...',flush=True)
    d=overpass(query,'osm_roads_10km.json')
    if d:
        receipt=OUT/'metadata/osm_roads_10km_request.json'
        acquisition=read(receipt) if receipt.exists() else {}
        roads,network=normalize_roads(d,{'fetchedAt':acquisition.get('fetched_at'),'endpoint':acquisition.get('endpoint',OSM_ENDPOINT),'bboxSouthWestNorthEast':[south,west,north,east],'contextMarginKm':10,'query':query},b)
        save(OUT/'roads/roads.geojson',roads);save(OUT/'roads/road_network.json',network)
        # A separately clipped map layer; the routing topology retains full ways.
        clipped=[]
        for f in roads['features']:
            g=shape(f['geometry']).intersection(b)
            if not g.is_empty and g.geom_type in ('LineString','MultiLineString'):
                clipped.append(feature(g,{**f['properties'],'geometry_clipped':True,'routing_use':False}))
        save(OUT/'roads/roads_within_boundary.geojson',fc(clipped,source='OpenStreetMap',license='ODbL-1.0',note='Map display only. Use road_network.json for routing; clipped endpoints are not shared topology.'))
        print('OSM road ways:',len(roads['features']),flush=True)
    west,south,east,north=b.bounds; bounds=f'{south:.7f},{west:.7f},{north:.7f},{east:.7f}'
    query=f'[out:json][timeout:180];(nwr["building"]({bounds});nwr["landuse"]({bounds});nwr["amenity"="parking"]({bounds});nwr["amenity"="charging_station"]({bounds});nwr["office"]({bounds});nwr["shop"]({bounds});nwr["leisure"]({bounds});nwr["public_transport"]({bounds}););out meta geom;'
    print('Requesting OSM buildings, landuse and parking...',flush=True)
    d=overpass(query,'osm_buildings_landuse_parking.json')
    buildings=[];invalid=0
    if d:
        for row in d['elements']:
            tags=row.get('tags',{})
            category='building' if 'building' in tags else 'parking' if tags.get('amenity')=='parking' else 'landuse' if 'landuse' in tags else None
            if not category:continue
            try:
                geom=element_geometry(row)
                if geom is None or geom.is_empty:invalid+=1;continue
                if not geom.is_valid:geom=make_valid(geom)
                geom=geom.intersection(b)
                if geom.is_empty:continue
                capacity=tags.get('capacity')
                buildings.append(feature(geom,{'id':f'osm:{row["type"]}:{row["id"]}','category':category,'name':tags.get('name'),'building_use':tags.get('building:use') or tags.get('building'),'levels':tags.get('building:levels'),'height':tags.get('height'),'landuse':tags.get('landuse'),'capacity':int(capacity) if capacity and capacity.isdigit() else None,'capacity_raw':capacity,'access':tags.get('access'),'opening_hours':tags.get('opening_hours'),'tags':tags,'source':'OpenStreetMap','source_id':row['id'],'source_url':f'https://www.openstreetmap.org/{row["type"]}/{row["id"]}','source_updated_at':row.get('timestamp'),'collected_at':now(),'is_simulated':False}))
            except (ValueError,TypeError):invalid+=1
    # Preserve existing parking point observations with original source IDs; do not merge points and polygons by proximity.
    context=read(input_path('data/processed/weidu-siting-context.geojson'))
    keys={f['properties']['id'] for f in buildings}
    if not d:
        for f in context['features']:
            p=f['properties'];g=shape(f['geometry'])
            if p.get('source')=='OpenStreetMap' and p.get('category')=='landuse' and g.intersects(b):
                buildings.append(feature(g.intersection(b),{**p,'source_updated_at':p.get('observedAt'),'collected_at':None,'is_simulated':False}));keys.add(p['id'])
    for p in read(OUT/'pois/pois.geojson')['features']:
        if 'parking' not in p['properties'].get('source_categories',[]):continue
        props=p['properties']
        if props['id'] in keys:continue
        buildings.append(feature(shape(p['geometry']),{**props,'category':'parking','capacity':None,'capacity_raw':None,'building_use':None,'levels':None,'height':None,'access':None,'opening_hours':None}))
    if buildings:
        save(OUT/'buildings/buildings_parking.geojson',fc(buildings,source='OpenStreetMap + AMap parking POIs',license='Mixed: ODbL-1.0 / AMap terms; source field retained',categories=dict(Counter(f['properties']['category'] for f in buildings)),invalid_osm_geometry=invalid,osm_current_query_succeeded=bool(d),completeness='Volunteered mapping is incomplete. Point parking records may refer to polygon facilities; record count is not unique facility count.'))
    print('Buildings/landuse/parking records:',len(buildings),flush=True)

SPEEDS={'motorway':80,'motorway_link':30,'trunk':60,'trunk_link':30,'primary':40,'primary_link':25,'secondary':35,'secondary_link':25,'tertiary':30,'tertiary_link':20,'unclassified':25,'residential':20,'living_street':10,'service':15,'road':20,'track':10}

def qa():
    """Geometry, source-ID, near-duplicate, missingness and directed topology audit."""
    import networkx as nx
    b=border(); report={'checked_at':now(),'stages':{}}
    for name,path in [('boundary','boundary/weidu_boundary.geojson'),('pois','pois/pois.geojson'),('charging','charging/charging_stations.geojson'),('roads','roads/roads.geojson'),('buildings','buildings/buildings_parking.geojson')]:
        if not (OUT/path).exists():report[name]={'status':'not_acquired'};continue
        d=read(OUT/path);fs=d['features'];gs=[shape(f['geometry']) for f in fs];ids=[str(f.get('id') or f.get('properties',{}).get('id') or i) for i,f in enumerate(fs)]
        info={'status':'acquired','count':len(fs),'invalid_geometry':sum(not g.is_valid for g in gs),'empty_geometry':sum(g.is_empty for g in gs),'duplicate_ids':len(ids)-len(set(ids)),'geometry_types':dict(Counter(g.geom_type for g in gs)),'metadata':d.get('metadata',{})}
        if name in ['pois','charging']:
            info['outside_boundary']=sum(not b.covers(g) for g in gs)
            fields=['name','source','raw_category','operator','public_access','gun_count','charger_unit_count','charge_type','max_gun_power_kw','installed_power_kw','opening_hours','source_updated_at'] if name=='charging' else ['name','raw_category','category','source','collected_at','source_updated_at']
            info['missing_fields']={field:sum(f['properties'].get(field) in (None,'',[]) for f in fs) for field in fields}
            info['synthetic_rows']=sum(f['properties'].get('is_simulated') is True for f in fs)
            info['categories']=dict(Counter(f['properties'].get('category','charging') for f in fs))
            points=[transform(PROJECTOR,g) for g in gs];tree=STRtree(points);pairs=[]
            for i,g in enumerate(points):
                for j in tree.query(g,predicate='dwithin',distance=30):
                    j=int(j)
                    if j<=i:continue
                    p,q=fs[i]['properties'],fs[j]['properties']
                    pairs.append({'first_id':p['id'],'second_id':q['id'],'first_name':p.get('name'),'second_name':q.get('name'),'distance_m':round(g.distance(points[j]),2),'same_name':p.get('name')==q.get('name'),'decision':'flag_only; different source IDs and co-location do not prove duplication'})
            info['nearby_record_pairs_30m']=len(pairs)
            save(OUT/'metadata'/(name+'_near_duplicates.json'),pairs)
        report[name]=info
    network=read(OUT/'roads/road_network.json'); nodes={n['id']:n for n in network['nodes']};graph=nx.DiGraph();missing=0;nonpositive=0
    scenario_edges=[];unsupported=0
    for edge in network['edges']:
        if edge['from'] not in nodes or edge['to'] not in nodes:missing+=1;continue
        if edge.get('lengthM',0)<=0:nonpositive+=1;continue
        if not edge.get('motorVehicleCandidate') or edge.get('motorAccess') in ('prohibited','restricted') or edge.get('directionKnown') is False:continue
        speed=SPEEDS.get(edge['highway'])
        if not speed:continue
        secs=edge['lengthM']/speed*3.6
        graph.add_edge(edge['from'],edge['to'],weight=secs)
        scenario_edges.append({**edge,'scenario_speed_kph':speed,'scenario_travel_seconds':secs,'speed_basis':'author_assumption_not_observed','access_unspecified_assumed_passable':edge.get('motorAccess')=='unspecified'})
    weak=sorted(nx.weakly_connected_components(graph),key=len,reverse=True);strong=sorted(nx.strongly_connected_components(graph),key=len,reverse=True)
    # Connectivity only: preserve every component; never connect geometric crossings by proximity.
    netqa={'node_count_input':len(nodes),'directed_edges_input':len(network['edges']),'motor_scenario_nodes':graph.number_of_nodes(),'motor_scenario_edges':graph.number_of_edges(),'weak_components':len(weak),'strong_components':len(strong),'largest_weak_component_nodes':len(weak[0]) if weak else 0,'largest_weak_component_percent':100*len(weak[0])/graph.number_of_nodes() if weak else None,'largest_strong_component_nodes':len(strong[0]) if strong else 0,'missing_endpoint_edges':missing,'nonpositive_length_edges':nonpositive,'turn_restriction_records':len(network.get('turnRestrictions',[])),'turn_restrictions_applied':False,'barrier_nodes':sum(bool(n.get('tags',{}).get('barrier')) for n in nodes.values()),'access_unspecified_edges_assumed_passable':sum(e['access_unspecified_assumed_passable'] for e in scenario_edges),'snap_distance_max_m_assumption':300,'real_speed_data':False,'network_context_margin_km':network.get('metadata',{}).get('contextMarginKm'),'ten_minute_analysis_status':'supports scenario preparation; turn restrictions/barriers/entrances require review. No real-time guarantee.'}
    save(OUT/'roads/network_quality.json',netqa)
    # Missing station-to-network links are retained and reported, not assigned straight-line travel times.
    node_ids=list(graph.nodes);node_points=[transform(PROJECTOR,Point(nodes[i]['coordinates'])) for i in node_ids];tree=STRtree(node_points)
    snapping=[]
    for f in read(OUT/'charging/charging_stations.geojson')['features']:
        point=transform(PROJECTOR,shape(f['geometry']));index=int(tree.nearest(point));distance=point.distance(node_points[index])
        snapping.append({'station_id':f['properties']['id'],'nearest_node_id':node_ids[index],'distance_m':round(distance,3),'within_300m':distance<=300,'inside_boundary':f['properties']['inside_boundary'],'note':'Distance to mapped node, not verified vehicle entrance or public access.'})
    csv_save(OUT/'roads/station_network_snap_checks.csv',snapping)
    netqa['stations_over_300m_from_node']=sum(not r['within_300m'] for r in snapping)
    save(OUT/'roads/network_quality.json',netqa)
    save(OUT/'roads/road_network_scenario.json',{'metadata':{**network['metadata'],'scenario_only':True,'turnRestrictionsApplied':False,'routingReady':False,'speed_basis':'author assumptions; no real-time traffic','speed_kph':SPEEDS},'nodes':network['nodes'],'edges':scenario_edges,'turnRestrictions':network.get('turnRestrictions',[])})
    report['network']=netqa
    pop=OUT/'population/population_metadata.json'
    report['population']=read(pop) if pop.exists() else {'status':'download_in_progress_or_failed; no formal raster published yet'}
    reported=[]
    for filename in ['amap_charging_context.json','amap_government_transport.json']:
        path=OUT/'raw'/filename
        if not path.exists():continue
        d=read(path)
        for category,q in d['queries'].items():
            n=max([int(p.get('reported_count') or 0) for p in q.get('pages',[])] or [0])
            reported.append({'query':category,'reported_count_peak':n,'unique_downloaded':len(q['pois']),'count_shortfall':max(0,n-len(q['pois'])),'status':'api_result_window_exhausted' if len(q['pois'])<n else q['status'],'exhaustive':False})
    report['amap_query_completeness']=reported
    report['boundary_comparison']={'project_area_km2':abs(GEOD.geometry_area_perimeter(b)[0])/1e6,'government_page_area_km2':89.3729,'government_url':'https://www.weidu.gov.cn/zjwd/walkIntoWD.html','difference_percent':(abs(GEOD.geometry_area_perimeter(b)[0])/1e6/89.3729-1)*100,'decision':'Do not force population totals to match a government figure with uncertain boundary/vintage.'}
    save(OUT/'reports/quality_report.json',report)
    print(json.dumps({'geometry_checks':{k:{i:v for i,v in d.items() if i in ['count','invalid_geometry','duplicate_ids','outside_boundary','synthetic_rows']} for k,d in report.items() if isinstance(d,dict) and 'count' in d},'network':netqa,'amap_query_completeness':reported},ensure_ascii=False),flush=True)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('stage',choices=['core','population','osm','amap','qa','all'])
    args=p.parse_args()
    for name in ['raw','metadata','boundary','population','pois','roads','charging','buildings','parameters','reports']:
        (OUT/name).mkdir(parents=True,exist_ok=True)
    stages={'core':core,'population':population,'osm':osm,'amap':amap,'qa':qa}
    if args.stage=='all':
        for operation in stages.values():operation()
    else:
        stages[args.stage]()

if __name__=='__main__':
    main()
