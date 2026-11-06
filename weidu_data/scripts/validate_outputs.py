"""Validate delivery against data semantics, geometry and publisher originals."""
import csv,hashlib,json,math,sys,zipfile
import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds
from shapely.geometry import shape,Point
from shapely.ops import transform
from pipeline import OUT,read,save,border,PROJECTOR,GEOD,now
from geo_helpers import gcj02_to_wgs84,wgs84_to_gcj02

checks=[]
def check(condition,label):
    if not condition:raise AssertionError(label)
    checks.append(label)

b=border()
for name in ['boundary/weidu_boundary.geojson','pois/pois.geojson','roads/roads.geojson','roads/roads_within_boundary.geojson','charging/charging_stations.geojson','buildings/buildings_parking.geojson']:
    data=read(OUT/name);fs=data['features'];check(bool(fs),name+' nonempty')
    gs=[shape(f['geometry']) for f in fs]
    check(all(g.is_valid and not g.is_empty for g in gs),name+' valid geometry')
    check(all(-180<=g.bounds[0]<=180 and -90<=g.bounds[1]<=90 and -180<=g.bounds[2]<=180 and -90<=g.bounds[3]<=90 for g in gs),name+' coordinate bounds')
    if name.startswith('pois/'):check(all(b.covers(g) for g in gs),'POI clipping')
    if name.startswith('charging/'):
        check(all(f['properties']['is_simulated'] is False for f in fs),'No simulated charging records')
        check(all(f['properties']['gun_count'] is None for f in fs),'Unverified guns remain null, not inferred')
        check(all(transform(PROJECTOR,g).distance(transform(PROJECTOR,b))<=10000.1 for g in gs),'Charging context within 10km metric buffer')
        check(sum(bool(f['properties']['scope_review_flags']) for f in fs)==8,'Special vehicle / swapping name flags retained')

with rasterio.open(OUT/'population/population.tif') as clipped:
    arr=clipped.read(1);inside=~geometry_mask([b.__geo_interface__],arr.shape,clipped.transform)
    check(clipped.crs.to_epsg()==4326,'Population output EPSG:4326')
    check(clipped.nodata==-200,'Population explicit NoData')
    check(np.all(arr[~inside]==clipped.nodata),'Population outside boundary is NoData')
    check(np.isfinite(arr[inside]).all() and (arr[inside]>=0).all(),'Population inside nonnegative finite')
    raw=OUT/'raw/GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0_R6_C30.tif'
    with rasterio.open(raw) as original:
        window=from_bounds(*clipped.bounds,transform=original.transform).round_offsets().round_lengths()
        expected=original.read(1,window=window)
    check(expected.shape==arr.shape and np.array_equal(expected[inside],arr[inside]),'Population retained publisher pixel counts with no interpolation')
    check(clipped.tags()['IS_OBSERVATION']=='false','Population projection is labelled')

for xy in [(113.80,34.02),(113.74,33.99),(113.88,34.09)]:
    restored=wgs84_to_gcj02(*gcj02_to_wgs84(*xy))
    check(max(abs(a-b) for a,b in zip(xy,restored))<1e-7,'GCJ iterative round-trip '+str(xy))

profiles=list(csv.DictReader((OUT/'parameters/time_profiles.csv').open(encoding='utf-8-sig')))
check(len(profiles)==192,'192 private-car external observed intervals')
check(all(abs(sum(float(r[k]) for k in ['driving_ratio','charging_ratio','parked_ratio'])-1)<1e-9 for r in profiles),'External vehicle states sum to one')
check(all(r['basis']=='observed_external_aggregate' and 'not_Weidu' in r['geography'] for r in profiles),'External observed data not relabelled as local observations')
params=read(OUT/'parameters/scenario_params.json')
check(params['model_enabled'] is False and params['local_absolute_scaling']['weidu_private_ev_count'] is None,'Absolute local demand is not fabricated')
for record in read(OUT/'metadata/literature_data_downloads.json'):
    p=OUT/'parameters/literature_observed'/record['name']
    check(hashlib.sha256(p.read_bytes()).hexdigest()==record['sha256'],'Author data checksum '+record['name'])
network=read(OUT/'roads/road_network_scenario.json')
check(network['metadata']['routingReady'] is False and network['metadata']['turnRestrictionsApplied'] is False,'Scenario network does not claim implemented turn restrictions')
check(len(network['turnRestrictions'])==2,'OSM turn restrictions retained')
check(not any(p.name.startswith('.env') for p in OUT.rglob('*')),'No dotenv credentials bundled')
save(OUT/'reports/validation_checks.json',{'checked_at':now(),'passed':True,'check_count':len(checks),'checks':checks})
print(json.dumps({'passed':True,'checks':len(checks)},ensure_ascii=False))
