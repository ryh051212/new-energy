import test from 'node:test'
import assert from 'node:assert/strict'
import { polygon, point } from '@turf/turf'
import { compareChargingDemand, demandLocations } from '../src/utils/facilityDemand.js'

function fixture() {
  const grid = (id, west, weight) => polygon([[[west, 34], [west + .01, 34], [west + .01, 34.01], [west, 34.01], [west, 34]]], { id, demandIndex: weight })
  const features = [grid(1, 113, .8), grid(2, 113.03, .2)]
  const demandPois = [point([113.002, 34.005]), point([113.035, 34.005])]
  const station = (id, longitude, powerKw = 100, totalCount = 2) => point([longitude, 34.005], { id, powerKw, totalCount })
  const beforeStations = [station('a', 113.035), station('b', 113.035)]
  return { features, demandPois, beforeStations, station }
}

test('相同数量重新选址：服务高需求区域，触达、距离和需求匹配改善，不以站数判断', () => {
  const f = fixture()
  const result = compareChargingDemand({ ...f, afterStations: [f.station('a', 113.002), f.beforeStations[1]] })
  assert.equal(result.before.demandReach, 20)
  assert.equal(result.after.demandReach, 100)
  assert.ok(result.after.meanDistanceMeters < result.before.meanDistanceMeters)
  assert.ok(result.after.matchScore > result.before.matchScore)
  assert.equal(result.verdict, 'improved')
  assert.equal(result.gainedDemandShare, 80)
})

test('相同选址桩数或功率提高会改善未满足需求，重复新增到已充足区域不虚增评分', () => {
  const f = fixture()
  const evaluate = addition => compareChargingDemand({ ...f, afterStations: [...f.beforeStations, addition] })
  const small = evaluate(f.station('new', 113.002, 10, 1))
  const morePiles = evaluate(f.station('new', 113.002, 10, 2))
  const morePower = evaluate(f.station('new', 113.002, 20, 1))
  assert.ok(morePiles.after.matchScore > small.after.matchScore)
  assert.equal(morePiles.after.matchScore, morePower.after.matchScore)
  const redundant = evaluate(f.station('new', 113.035, 1000, 100))
  assert.equal(redundant.after.matchScore, redundant.before.matchScore)
  assert.equal(redundant.verdict, 'unchanged')
  assert.equal(small.referenceCapacityKw, redundant.referenceCapacityKw, '前后固定同一基准，不用方案的新总功率重定标')
})

test('新增多处低需求站仍比新增一处高需求站效果差，删除冗余站可保持服务', () => {
  const f = fixture()
  const redundant = compareChargingDemand({ ...f, afterStations: [...f.beforeStations, f.station('c', 113.035), f.station('d', 113.035)] })
  const useful = compareChargingDemand({ ...f, afterStations: [...f.beforeStations, f.station('new', 113.002)] })
  assert.ok(useful.after.matchScore > redundant.after.matchScore)
  const removed = compareChargingDemand({ ...f, afterStations: [f.beforeStations[0]] })
  assert.equal(removed.verdict, 'unchanged')
  assert.equal(removed.before.matchScore, removed.after.matchScore)
})

test('增删造成局部得失同时标记，移除全部站点显示服务下降和最近距离不可用', () => {
  const f = fixture()
  const swap = compareChargingDemand({ ...f, afterStations: [f.station('new', 113.002)] })
  assert.ok(swap.gainedDemandShare > 0)
  assert.ok(swap.lostDemandShare > 0)
  assert.equal(swap.verdict, 'tradeoff')
  const empty = compareChargingDemand({ ...f, afterStations: [] })
  assert.equal(empty.after.demandReach, 0)
  assert.equal(empty.after.matchScore, 0)
  assert.equal(empty.after.meanDistanceMeters, null)
  assert.equal(empty.verdict, 'worse')
})

test('实际 POI 位置决定距离，网格需求权重不因 POI 数量重复计数；缺失 POI 使用代表点并注明', () => {
  const f = fixture()
  const { locations, fallbackGrids } = demandLocations(f.features, [f.demandPois[0], f.demandPois[0], point([0, 0])])
  assert.equal(locations.length, 3)
  assert.equal(fallbackGrids, 1)
  assert.equal(locations[0].weight + locations[1].weight, .8)
  assert.deepEqual(locations[0].feature.geometry.coordinates, f.demandPois[0].geometry.coordinates)
  const original = structuredClone(f.features)
  const result = compareChargingDemand({ ...f, afterStations: [...f.beforeStations, f.station('new', 113.002)] })
  assert.equal(result.after.meanDistanceMeters, 0)
  assert.equal(result.after.grid.features[0].properties.demandReach, 100)
  assert.deepEqual(f.features, original)
})

test('缺失能力、未知需求和模拟属性保持可区分；不从新增点杜撰基准需求', () => {
  const f = fixture()
  const unknown = point([113.035, 34.005], { id: 'unknown', totalCount: 4 })
  const result = compareChargingDemand({ ...f, beforeStations: [unknown], afterStations: [unknown, f.station('new', 113.002)] })
  assert.equal(result.before.matchScore, null)
  assert.equal(result.after.matchScore, null)
  assert.equal(result.after.unknownCapacityStations, 1)
  assert.equal(result.gainedDemandShare, null)
  assert.equal(result.after.demandReach, 100, '能力未知不影响可识别的点位触达评价')
  f.beforeStations[0].properties.simulatedFields = ['powerKw']
  const demo = compareChargingDemand({ ...f, afterStations: f.beforeStations })
  assert.equal(demo.after.simulatedCapacityStations, 1)
  assert.equal(demo.after.accessUnknownStations, 2)
  const noDemand = compareChargingDemand({ ...f, features: f.features.map(grid => ({ ...grid, properties: { ...grid.properties, demandIndex: 0 } })), afterStations: f.beforeStations })
  assert.equal(noDemand.verdict, 'insufficient')
  assert.equal(noDemand.after.demandReach, null)
})

test('已明确关闭或禁止进场的点位排除，未知开放保留提示，模拟关闭不冒充核实事实', () => {
  const f = fixture()
  const closed = f.station('closed', 113.002)
  closed.properties.status = 'closed'
  const result = compareChargingDemand({ ...f, afterStations: [closed] })
  assert.equal(result.after.excludedStations, 1)
  assert.equal(result.after.demandReach, 0)
  closed.properties.simulatedFields = ['status']
  const simulated = compareChargingDemand({ ...f, afterStations: [closed] })
  assert.equal(simulated.after.excludedStations, 0)
  assert.equal(simulated.after.demandReach, 80)
  closed.properties.accessAllowed = false
  const denied = compareChargingDemand({ ...f, afterStations: [closed] })
  assert.equal(denied.after.excludedStations, 1)
})

test('地点服务输出保留名称地址和最近站，区分能力改善、距离改善、损失与代表点', () => {
  const f = fixture()
  f.demandPois[0].properties = { id: 'home', name: '测试小区', address: '测试路 1 号', category: 'residential' }
  f.beforeStations.forEach(station => { station.properties.name = '原商业区站' })
  const result = compareChargingDemand({ ...f, afterStations: [f.station('new', 113.002)] })
  const home = result.locations.features.find(feature => feature.properties.id === 'home')
  assert.equal(home.properties.name, '测试小区')
  assert.equal(home.properties.address, '测试路 1 号')
  assert.equal(home.properties.afterDistance, 0)
  assert.equal(home.properties.beforeNearest, '原商业区站')
  assert.equal(home.properties.locationStatus, 'improved')
  assert.equal(home.properties.weak, false)
  assert.equal(result.locations.features[1].properties.locationStatus, 'declined')
  assert.equal(result.locations.features[1].properties.weak, true)
  const fallback = compareChargingDemand({ ...f, demandPois: [], afterStations: f.beforeStations })
  assert.ok(fallback.locations.features.every(feature => feature.properties.fallback))
  const unknown = compareChargingDemand({ ...f, beforeStations: [point([113.035, 34.005], { id: 'u' })], afterStations: [point([113.002, 34.005], { id: 'u' })] })
  assert.equal(unknown.locations.features[0].properties.afterMatch, null)
  assert.equal(unknown.locations.features[0].properties.locationStatus, 'improved', '能力未知仍可识别距离改善')
})

test('逐站移除敏感性与重新运行的结果一致，唯一触达地点与共同覆盖冗余站分开识别', () => {
  const f = fixture(), stations = [f.station('home', 113.002), f.station('shop', 113.035)]
  const result = compareChargingDemand({ ...f, beforeStations: stations, afterStations: stations })
  const review = result.stationReview.features.find(feature => feature.properties.id === 'home').properties
  const removed = compareChargingDemand({ ...f, beforeStations: stations, afterStations: [stations[1]] })
  assert.equal(review.reviewStatus, 'dependent')
  assert.equal(review.removalReachLoss, 80)
  assert.equal(review.removalMatchLoss, Math.round((removed.before.matchScore - removed.after.matchScore) * 10) / 10)
  assert.equal(review.affectedPlaces, 1)
  const redundant = compareChargingDemand({ ...f, afterStations: f.beforeStations })
  assert.ok(redundant.stationReview.features.every(feature => feature.properties.reviewStatus === 'review'))
  assert.ok(redundant.stationReview.features.every(feature => feature.properties.removalReachLoss === 0))
})

test('无已知供给、未知能力与演示属性不会产生有依据的真实淘汰结论', () => {
  const f = fixture(), station = point([113.035, 34.005], { id: 'u', name: '资料不足站' })
  const result = compareChargingDemand({ ...f, beforeStations: [station], afterStations: [station] })
  assert.equal(result.stationReview.features[0].properties.reviewStatus, 'unknown')
  assert.equal(result.stationReview.features[0].properties.removalMatchLoss, null)
  f.beforeStations[0].properties.simulatedFields = ['powerKw']
  const demo = compareChargingDemand({ ...f, afterStations: f.beforeStations })
  assert.equal(demo.stationReview.features[0].properties.capacitySimulated, true)
  assert.equal(demo.stationReview.features[0].properties.accessUnknown, true)
})
