"""Export the existing WGS84 study boundary as a verified Shapefile ZIP."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import shapefile
from shapely.geometry import mapping, shape
from shapely.geometry.polygon import orient

root = Path(__file__).resolve().parents[1]
source = root / 'boundary' / 'weidu_boundary.geojson'
out = root / 'boundary' / 'weidu_boundary_shp'
archive = root / 'boundary' / 'weidu_boundary_shp.zip'
if out.exists() or archive.exists():
    raise FileExistsError('Output already exists; preserve it and choose a new output location.')

data = json.loads(source.read_text(encoding='utf-8'))
features = data['features']
if data.get('metadata', {}).get('crs') != 'EPSG:4326' or not features:
    raise ValueError('Expected a nonempty EPSG:4326 boundary.')
out.mkdir()
base = out / 'weidu_boundary'
with shapefile.Writer(str(base), shapeType=shapefile.POLYGON, encoding='utf-8') as writer:
    writer.field('name', 'C', size=80)
    writer.field('adcode', 'C', size=12)
    writer.field('source', 'C', size=40)
    for feature in features:
        geom = shape(feature['geometry'])
        if geom.is_empty or not geom.is_valid or geom.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError('Invalid or unsupported boundary geometry.')
        polygons = [geom] if geom.geom_type == 'Polygon' else list(geom.geoms)
        rings = []
        for polygon in polygons:
            oriented = orient(polygon, sign=-1.0)
            rings.extend([list(oriented.exterior.coords), *(list(r.coords) for r in oriented.interiors)])
        writer.poly(rings)
        props = feature.get('properties') or {}
        writer.record(props.get('name', ''), props.get('adcode', ''), props.get('source', ''))

base.with_suffix('.prj').write_text('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]', encoding='ascii')
base.with_suffix('.cpg').write_text('UTF-8', encoding='ascii')
readme = out / 'README.txt'
readme.write_text('魏都区研究边界（WGS84 / EPSG:4326）\n转换自项目已有 weidu_data/boundary/weidu_boundary.geojson；该边界来自原项目，版本未知，未获官方勘界认证。请勿作为法定行政勘界成果。\n使用时保持 .shp、.shx、.dbf、.prj、.cpg 同名且位于同一文件夹。\n', encoding='utf-8-sig')

with shapefile.Reader(str(base), encoding='utf-8') as reader:
    records = reader.shapeRecords()
    if len(records) != len(features):
        raise ValueError('Feature count changed during export.')
    for original, record in zip(features, records):
        if not shape(original['geometry']).equals(shape(record.shape.__geo_interface__)):
            raise ValueError('Boundary geometry changed during export.')
        if record.record['name'] != original['properties']['name']:
            raise ValueError('Boundary name changed during export.')

with ZipFile(archive, 'x', ZIP_DEFLATED) as z:
    for item in sorted(out.iterdir()):
        z.write(item, item.name)
    if z.testzip() is not None:
        raise ValueError('ZIP verification failed.')
print(f'Validated {len(features)} boundary feature(s); output: {archive}')
