import test from 'node:test'
import assert from 'node:assert/strict'
import { selectChargingStations, stationMetric } from '../src/utils/charging.js'
import { resolveRoute } from '../src/navigation.js'

const features = [
  { geometry: { type: 'Point', coordinates: [113.85, 34.04] }, properties: { name: '城东站', address: '大学路', chargeType: 'fast', availableCount: 0 } },
  { geometry: { type: 'Point', coordinates: [113.86, 34.04] }, properties: { name: '城西站', address: '大学路', chargeType: 'slow', availableCount: 4 } },
  { geometry: { type: 'Point', coordinates: [113.9, 34.04] }, properties: { name: '未知站', chargeType: 'unknown' } },
]
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
