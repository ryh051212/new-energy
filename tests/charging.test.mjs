import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeChargingPoint, selectChargingStations, stationDistance, stationMetric } from '../src/utils/charging.js'
import coordtransform from 'coordtransform'
import { resolveRoute } from '../src/navigation.js'

const features = [
  { geometry: { type: 'Point', coordinates: [113.85, 34.04] }, properties: { name: '城东站', address: '大学路', chargeType: 'fast', availableCount: 0 } },
  { geometry: { type: 'Point', coordinates: [113.86, 34.04] }, properties: { name: '城西站', address: '大学路', chargeType: 'slow', availableCount: 4 } },
  { geometry: { type: 'Point', coordinates: [113.9, 34.04] }, properties: { name: '未知站', chargeType: 'unknown' } },
]

test('统一标记为 GCJ-02 的站点坐标，不修改原数据或重复转换 WGS84', () => {
  const coordinates = coordtransform.wgs84togcj02(113.85, 34.04)
  const feature = { ...features[0], geometry: { type: 'Point', coordinates }, properties: { ...features[0].properties, coordSystem: 'GCJ-02' } }
  const converted = normalizeChargingPoint(feature)
  assert.equal(converted.properties.coordSystem, 'WGS84')
  assert.equal(feature.properties.coordSystem, 'GCJ-02')
  assert.deepEqual(feature.geometry.coordinates, coordinates)
  assert.ok(stationDistance(converted, [113.85, 34.04]) < 0.005)
  assert.equal(normalizeChargingPoint(converted), converted)
  assert.equal(normalizeChargingPoint(features[0]), features[0])
})
test('按地址、类型、空闲数量和距离组合筛选', () => {
  assert.equal(selectChargingStations(features, { keyword: '大学路' }).length, 2)
  assert.equal(selectChargingStations(features, { type: 'fast', available: true }).length, 0)
  assert.equal(selectChargingStations(features, { available: true })[0].properties.name, '城西站')
  const nearby = selectChargingStations(features, { location: [113.86, 34.04], radius: 1 })
  assert.deepEqual(nearby.map(item => item.properties.name), ['城西站', '城东站'])
})
test('详情保留零值且缺失字段不编造数据', () => {
  assert.equal(stationMetric(0, ' 个'), '0 个')
  for (const value of [null, undefined, '', NaN, -1]) assert.equal(stationMetric(value), '暂无数据')
})
test('旧找充电入口统一进入独立页面', () => {
  for (const route of ['/charging', '/stations', '/charging/search', '/charging/details', '/charging/filter']) {
    assert.equal(resolveRoute(route), '/charging')
  }
})
