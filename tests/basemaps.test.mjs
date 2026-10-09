import test from 'node:test'
import assert from 'node:assert/strict'
import coordtransform from 'coordtransform'
import { toMapCoordinate, fromMapCoordinate, toMapGeoJSON } from '../src/utils/basemaps.js'

test('高德坐标转换保留高程，反算可反复切换，境外坐标保持原值', () => {
  const original = [113.861916, 34.044075, 20]
  const displayed = toMapCoordinate(original)
  assert.deepEqual(displayed, [...coordtransform.wgs84togcj02(...original), 20])
  assert.ok(Math.abs(displayed[0] - original[0]) > 0.001)
  let point = original
  for (let index = 0; index < 20; index++) point = fromMapCoordinate(toMapCoordinate(point))
  assert.ok(Math.abs(point[0] - original[0]) < 1e-9)
  assert.ok(Math.abs(point[1] - original[1]) < 1e-9)
  assert.equal(point[2], 20)
  assert.deepEqual(toMapCoordinate(original, 'satellite'), original)
  assert.deepEqual(toMapCoordinate([-74, 40]), [-74, 40])
})

test('转换复合几何、边界洞和网格时保留属性与空几何，不修改数据库数据', () => {
  const point = [113.85, 34.04]
  const ring = [point, [113.86, 34.04], [113.86, 34.05], point]
  const data = { type: 'FeatureCollection', bbox: [113.85, 34.04, 113.86, 34.05], features: [
    { type: 'Feature', id: 1, properties: { stationCount: 2 }, geometry: { type: 'MultiPolygon', coordinates: [[ring, ring]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [
      { type: 'Point', coordinates: point }, { type: 'LineString', coordinates: ring },
    ] } },
    { type: 'Feature', properties: {}, geometry: null },
  ] }
  const snapshot = structuredClone(data)
  const rendered = toMapGeoJSON(data)
  assert.deepEqual(rendered.features[0].geometry.coordinates[0][1][0], toMapCoordinate(point))
  assert.deepEqual(rendered.features[1].geometry.geometries[0].coordinates, toMapCoordinate(point))
  assert.equal(rendered.features[2].geometry, null)
  assert.equal(rendered.features[0].properties.stationCount, 2)
  assert.equal(rendered.features[0].id, 1)
  assert.ok(!('bbox' in rendered))
  assert.deepEqual(data, snapshot)
  assert.equal(toMapGeoJSON(data, 'terrain'), data)
})
