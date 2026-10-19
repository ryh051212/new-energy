import test from 'node:test'
import assert from 'node:assert/strict'
import { point, polygon, destination } from '@turf/turf'
import { analyzeFacilityDiagnostics, pointChargingDiagnostics, weightedAccessibilityGini, diagnosticVerdict } from '../src/utils/facilityDiagnostics.js'
import { chargingDistanceWeight } from '../src/utils/facilityDemand.js'

const center = [113.83, 34.03]
const at = meters => destination(center, meters, 90, { units: 'meters' }).geometry.coordinates
const station = (id, meters, capacity = 60) => point(at(meters), { id, name: id, totalCount: 1, powerKw: capacity })
function fixture() {
  const grid = (id, meters, weight) => {
    const [x, y] = at(meters)
    return polygon([[[x - .003, y - .003], [x + .003, y - .003], [x + .003, y + .003], [x - .003, y + .003], [x - .003, y - .003]]], { id, demandIndex: weight })
  }
  const features = [grid(1, 0, .8), grid(2, 3000, .2)]
  const demandPois = [point(center, { name: '薄弱小区' }), point(at(3000), { name: '充足区域' })]
  const beforeStations = [station('main', 3000, 120), station('backup', 3000, 120)]
  const boundary = polygon([[[113.8, 34], [113.9, 34], [113.9, 34.06], [113.8, 34.06], [113.8, 34]]])
  return { features, demandPois, beforeStations, boundary }
}

test('高斯距离衰减在起点为一、边界为零，中间随距离单调降低', () => {
  assert.equal(chargingDistanceWeight(0), 1)
  assert.equal(chargingDistanceWeight(1000), 0)
  assert.equal(chargingDistanceWeight(2000), 0)
  assert.ok(chargingDistanceWeight(200) > chargingDistanceWeight(700))
  assert.ok(Math.abs(chargingDistanceWeight(500) - (Math.exp(-.125) - Math.exp(-.5)) / (1 - Math.exp(-.5))) < 1e-12)
})

test('相同补桩配置优先改善薄弱需求，重复投到充足区域不提升薄弱端服务', () => {
  const f = fixture()
  const useful = analyzeFacilityDiagnostics({ ...f, afterStations: [...f.beforeStations, station('new', 0, 160)] })
  const redundant = analyzeFacilityDiagnostics({ ...f, afterStations: [...f.beforeStations, station('new', 3000)] })
  assert.ok(useful.after.underservedAccess > useful.before.underservedAccess)
  assert.ok(useful.after.inequality < useful.before.inequality)
  assert.equal(redundant.after.underservedAccess, redundant.before.underservedAccess)
  assert.equal(redundant.candidates[0].name, '薄弱小区')
  assert.equal(redundant.removals[0].estimatedLoss, 0)
  assert.ok(useful.candidates[0].estimatedGain < redundant.candidates[0].estimatedGain, '当前方案已补充的能力减小下一桩的边际收益')
})

test('定位主要供给按贡献而非最近距离排序，备用指标反映最主要单站退出', () => {
  const f = fixture(), beforeStations = [station('near-small', 50, 10), station('far-large', 400, 120)]
  const result = analyzeFacilityDiagnostics({ ...f, beforeStations, afterStations: [beforeStations[0]], center })
  assert.equal(result.pointBefore.mainStation, 'far-large')
  assert.ok(result.pointBefore.dependenceShare > 80)
  assert.ok(result.pointBefore.backupIndex < result.pointBefore.serviceIndex)
  assert.equal(result.pointAfter.backupIndex, 0)
  assert.equal(result.pointAfter.mainStation, 'near-small')
  assert.equal(result.pointVerdict, 'worse')
})

test('选定圈评价保留完整的需求竞争和圈外服务，扩大圈不抬高同一定位的分数', () => {
  const f = fixture()
  f.features = [{ ...f.boundary, properties: { id: 1, demandIndex: 1 } }]
  f.demandPois = [point(center), point(at(400))]
  f.beforeStations = [station('outside-edit-area', 650)]
  const input = { ...f, afterStations: f.beforeStations, center }
  const small = analyzeFacilityDiagnostics({ ...input, radiusMeters: 100 })
  const large = analyzeFacilityDiagnostics({ ...input, radiusMeters: 900 })
  assert.deepEqual(small.pointBefore, large.pointBefore)
  assert.ok(small.pointBefore.serviceIndex > 0)
  assert.equal(small.removals.length, 0, '不提供圈外的撤站试算对象')
  assert.equal(large.removals.length, 1)
  const lessCompetition = pointChargingDiagnostics({ ...f, stations: f.beforeStations, demandPois: [f.demandPois[0]], center })
  assert.ok(lessCompetition.serviceIndex > small.pointBefore.serviceIndex)
})

test('未知能力不当作零服务或零损失，模拟补值明确标记，无供给不称为完全公平', () => {
  const f = fixture(), unknown = point(at(0), { id: 'unknown', totalCount: 4 })
  const result = analyzeFacilityDiagnostics({ ...f, beforeStations: [unknown], afterStations: [unknown, station('new', 0)], center })
  assert.equal(result.pointBefore.serviceIndex, null)
  assert.equal(result.after.weakDemandShare, null)
  assert.equal(result.layoutVerdict, 'insufficient')
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.removals, [])
  assert.equal(result.pointBefore.unknownCapacityStations, 1)
  const empty = analyzeFacilityDiagnostics({ ...f, afterStations: [] })
  assert.equal(empty.after.weakDemandShare, 100)
  assert.equal(empty.after.inequality, null)
  assert.equal(empty.layoutVerdict, 'worse')
  assert.equal(empty.partialCapacity, false)
  f.beforeStations[0].properties.simulatedFields = ['powerKw']
  const simulated = analyzeFacilityDiagnostics({ ...f, afterStations: f.beforeStations })
  assert.equal(simulated.simulatedCapacity, true)
  const removedSimulation = analyzeFacilityDiagnostics({ ...f, afterStations: [] })
  assert.equal(removedSimulation.simulatedCapacity, true, '基准中的模拟能力仍须提示')
})

test('公平性按需求权重计算，均衡改善伴随服务损失时标记取舍', () => {
  assert.equal(weightedAccessibilityGini([0, 0], [1, 1]), null)
  assert.equal(weightedAccessibilityGini([4, 4], [.8, .2]), 0)
  assert.ok(Math.abs(weightedAccessibilityGini([0, 4], [.8, .2]) - .8) < 1e-12)
  assert.equal(diagnosticVerdict({ weakDemandShare: 50, underservedAccess: 20, inequality: .8 }, { weakDemandShare: 60, underservedAccess: 10, inequality: .5 }), 'tradeoff')
})

test('方向试算区分布局收益和定位收益；减少排序先保护选定位置', () => {
  const f = fixture()
  f.beforeStations = [station('local-main', 0, 100), station('far-small', 3000, 10)]
  const base = analyzeFacilityDiagnostics({ ...f, afterStations: f.beforeStations, center, radiusMeters: 5000 })
  assert.equal(base.candidates[0].name, '充足区域')
  assert.ok(base.candidates[0].estimatedGain > 0)
  assert.equal(base.candidates[0].pointGain, 0, '圈内补点不等于定位能获得新服务')
  assert.equal(base.removals[0].feature.properties.id, 'far-small')
  assert.equal(base.removals[0].pointLoss, 0)
  assert.ok(base.removals.find(row => row.feature.properties.id === 'local-main').pointLoss > 0)
  const added = analyzeFacilityDiagnostics({ ...f, afterStations: [...f.beforeStations, station('new', 3000)], center, radiusMeters: 5000 })
  assert.equal(added.pointAfter.serviceIndex, base.pointAfter.serviceIndex)
})

test('能力有记录但附近需求未建模时，定位资料不足，不把未分配能力判为零服务', () => {
  const f = fixture()
  const value = pointChargingDiagnostics({ ...f, demandPois: [], stations: [station('empty-catchment', 1500)], center: at(1500) })
  assert.equal(value.uncoveredByDemandModel, 1)
  assert.equal(value.serviceIndex, null)
})
