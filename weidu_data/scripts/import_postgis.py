"""Optional PostGIS import. Default is a local dry run; --apply is explicit.

Set WEIDU_PG_DSN in your environment. No password is printed or embedded here.
Raster remains a GeoTIFF for a separate, explicit raster2pgsql workflow.
"""
import argparse,json,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
LAYERS={'boundary':'boundary/weidu_boundary.geojson','pois':'pois/pois.geojson','roads':'roads/roads.geojson','charging':'charging/charging_stations.geojson','buildings_parking':'buildings/buildings_parking.geojson'}
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');parser.add_argument('--dsn-env',default='WEIDU_PG_DSN');args=parser.parse_args()
 layers={name:json.loads((ROOT/path).read_text(encoding='utf-8'))['features'] for name,path in LAYERS.items() if (ROOT/path).exists()}
 print(json.dumps({'mode':'apply' if args.apply else 'dry_run_no_database_connection','schema':'weidu_planning_baseline','layers':{k:len(v) for k,v in layers.items()}},ensure_ascii=False))
 if not args.apply:return
 dsn=os.getenv(args.dsn_env)
 if not dsn:raise SystemExit('Missing DSN environment variable: '+args.dsn_env)
 import psycopg2
 from psycopg2 import sql
 from psycopg2.extras import Json
 with psycopg2.connect(dsn) as conn:
  with conn.cursor() as cur:
   cur.execute('CREATE SCHEMA IF NOT EXISTS weidu_planning_baseline')
   for name,features in layers.items():
    table=sql.Identifier('weidu_planning_baseline',name)
    cur.execute(sql.SQL('CREATE TABLE IF NOT EXISTS {} (source_id text PRIMARY KEY, properties jsonb NOT NULL, geom geometry(Geometry,4326) NOT NULL)').format(table))
    for index,f in enumerate(features):
     props=f.get('properties',{});sid=str(props.get('id') or f.get('id') or props.get('adcode') or index)
     cur.execute(sql.SQL('INSERT INTO {} (source_id,properties,geom) VALUES (%s,%s,ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)) ON CONFLICT (source_id) DO UPDATE SET properties=EXCLUDED.properties,geom=EXCLUDED.geom').format(table),(sid,Json(props),json.dumps(f['geometry'])))
    cur.execute(sql.SQL('CREATE INDEX IF NOT EXISTS {} ON {} USING gist(geom)').format(sql.Identifier(name+'_geom_gix'),table))
 print('Committed to dedicated schema only; existing application tables were not modified.')
if __name__=='__main__':main()
