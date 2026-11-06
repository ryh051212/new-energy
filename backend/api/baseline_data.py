"""Published planning data, with modelled/observed/scenario provenance intact."""
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from ..utils.database import get_db_connection

router=APIRouter(prefix='/api/planning-data',tags=['Planning baseline'])
ACTIVE=Path(__file__).resolve().parents[2]/'data/processed/planning-baseline'

def catalog(key):
    conn=get_db_connection()
    try:
        with conn.cursor() as c:
            c.execute("SELECT to_regclass('public.planning_baseline_catalog')")
            if c.fetchone()[0] is None:raise HTTPException(503,'规划基础数据尚未接入')
            c.execute('SELECT payload FROM planning_baseline_catalog WHERE id=%s',(key,))
            row=c.fetchone()
            if not row:raise HTTPException(503,'该项规划资料尚未接入')
            return row[0]
    finally:conn.close()

@router.get('/metadata')
def metadata():
    data=catalog('metadata')
    return {'datasetId':data['datasetId'],'activatedAt':data['activatedAt'],'syntheticIncluded':False,
        'counts':{key:data[key]['count'] for key in ['pois','charging','roads','buildings']},
        'stationScope':data['charging']['metadata'],'poiCategories':data['pois']['categories'],
        'completeness':data['amap_query_completeness'],'stationMissingFields':data['charging']['missing_fields'],
        'population':catalog('population'),'boundary':data['boundary_comparison'],'network':data['network']}

@router.get('/population')
def population():
    meta=catalog('population');conn=get_db_connection()
    try:
        with conn.cursor() as c:
            c.execute('SELECT properties,ST_AsGeoJSON(geom) FROM planning_population_grid ORDER BY grid_id')
            features=[{'type':'Feature','properties':p,'geometry':json.loads(g)} for p,g in c.fetchall()]
        return {'type':'FeatureCollection','features':features,'metadata':meta}
    finally:conn.close()

@router.get('/population.tif')
def population_raster():
    path=ACTIVE/'population.tif'
    if not path.is_file():raise HTTPException(503,'人口栅格尚未接入')
    return FileResponse(path,media_type='image/tiff',filename='weidu-ghsl-population-2025.tif')

@router.get('/time-profiles')
def time_profiles():
    rows=catalog('timeProfiles')
    return {'profiles':[{**r,**{field:float(r[field]) for field in ['driving_ratio','charging_ratio','parked_ratio']},'interval_index':int(r['interval_index'])} for r in rows],
        'metadata':{'source':'Zhan et al. (2025), Zenodo supporting data','sourceUrl':'https://doi.org/10.5281/zenodo.13852045','license':'CC-BY-4.0',
        'observationPeriod':'2020-11—2021-10','vehicleType':'私人乘用车','geography':'其他七座中国城市，非魏都区','basis':'observed_external_aggregate',
        'intervalMinutes':15,'unit':'时点车辆状态比例','notice':'包括私人和公共地点充电；不等于公共充电到达率、日充电概率或本区订单。'}}

@router.get('/parameters')
def parameters():
    return {'parameters':catalog('parameters'),'activityAssumptions':catalog('activityAssumptions')}

@router.get('/sources')
def sources():return {'sources':catalog('sources')}
