"""Smaller follow-up after combined Overpass query failed; no spatial tiling."""
from pipeline import OUT, border, overpass, save, osm
b=border();west,south,east,north=b.bounds
bbox=f'{south:.7f},{west:.7f},{north:.7f},{east:.7f}'
query=f'[out:json][timeout:120];(way["building"]({bbox});way["landuse"]({bbox});nwr["amenity"="parking"]({bbox}););out meta geom;'
d=overpass(query,'osm_buildings_parking_followup.json')
if d:
    d['collection_scope_note']='Building ways, landuse ways and parking n/w/r only; building relations and building nodes not queried in this smaller follow-up.'
    save(OUT/'raw/osm_buildings_landuse_parking.json',d)
    osm()
