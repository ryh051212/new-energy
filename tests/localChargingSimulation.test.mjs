import test from 'node:test'
import assert from 'node:assert/strict'
import { point, polygon, destination } from '@turf/turf'
import { reactive, nextTick } from 'vue'
import { assessLocalCharging, runLocalChargingSimulation, withinAnalysisRadius } from '../src/utils/localChargingSimulation.js'
import { useFacilitySandbox } from '../src/composables/useFacilitySandbox.js'

const center = [113.83, 34.03]
const boundary = polygon([[[113.7, 33.9], [114, 33.9], [114, 34.2], [113.7, 34.2], [113.7, 33.9]]])
const station = (id, meters, extra = {}) => point(destination(center, meters, 90, { units: 'meters' }).geometry.coordinates,
  { id, name: '站点 ' + id, totalCount: 4, ...extra })
const addition = (id, meters) => station(id, meters, { name: '模拟站', pileCount: 3, chargeType: 'fast', powerKw: 60 })
const simulate = extra => runLocalChargingSimulation({ center, boundary, radiusMeters: 1000, stations: [station('near', 400), station('outside', 1200)], ...extra })

test('只分析定位半径内站点，新增远于原最近站时距离不变，不生成全区或地点影响', () => {
  const result = simulate({ additions: [addition('new', 700)] })
  assert.equal(result.before.stationCount, 1)
  assert.equal(result.after.stationCount, 2)
  assert.ok(Math.abs(result.after.nearestDistanceMeters - 400) < .001)
  assert.equal(result.distanceSavedMeters, 0)
  assert.equal(result.after.simulatedPiles, 3)
  assert.equal(result.evaluation, undefined)
  assert.equal(result.comparison, undefined)
  assert.equal(result.grid, undefined)
  assert.deepEqual(result.before.candidates.map(row => row.id), ['near'])
})

test('更近的补点缩短定位到站距离，撤去最近站后距离增加，完全移除时不显示零距离', () => {
  const closer = simulate({ additions: [addition('new', 100)] })
  assert.ok(Math.abs(closer.distanceSavedMeters - 300) < .001)
  assert.equal(closer.verdict, 'improved')
  const farther = simulate({ stations: [station('near', 100), station('far', 900)], removedIds: ['near'] })
  assert.equal(farther.verdict, 'worse')
  assert.ok(Math.abs(farther.after.nearestDistanceMeters - 900) < .001)
  const empty = simulate({ removedIds: ['near'] })
  assert.equal(empty.after.stationCount, 0)
  assert.equal(empty.after.nearestDistanceMeters, null)
  assert.equal(empty.distanceSavedMeters, null)
  assert.equal(empty.verdict, 'worse')
  assert.equal(simulate({ stations: [] }).verdict, 'unchanged')
})

test('减少站点同时补一个更近站可能有取舍，功率调整不伪造距离变化', () => {
  const tradeoff = simulate({ stations: [station('a', 500), station('b', 700)], removedIds: ['a', 'b'], additions: [addition('new', 100)] })
  assert.equal(tradeoff.verdict, 'tradeoff')
  assert.equal(tradeoff.stationChange, -1)
  const original = addition('new', 800)
  const modified = { ...original, properties: { ...original.properties, pileCount: 20, powerKw: 100 } }
  const a = simulate({ additions: [original] }), b = simulate({ additions: [modified] })
  assert.equal(a.after.nearestDistanceMeters, b.after.nearestDistanceMeters)
  assert.equal(a.after.stationCount, b.after.stationCount)
  assert.equal(b.after.simulatedPiles, 20)
})

test('明确关闭、禁止进场和零桩站排除；未知桩数、开放入口及演示能力分别标注', () => {
  const value = assessLocalCharging({ center, radiusMeters: 1000, stations: [station('closed', 20, { status: 'closed' }),
    station('private', 40, { accessAllowed: false }), station('zero', 50, { totalCount: 0 }),
    station('unknown', 400, { totalCount: null }), station('demo', 500, { totalCount: 10, simulatedFields: ['totalCount'] })] })
  assert.equal(value.excludedCount, 3)
  assert.equal(value.stationCount, 2)
  assert.equal(value.nearest.id, 'unknown')
  assert.equal(value.knownPiles, 0)
  assert.equal(value.simulatedPiles, 10)
  assert.equal(value.unknownPileStations, 1)
  assert.equal(value.accessUnknownStations, 2)
})

test('边界与半径严格约束新增和减少，半径边缘纳入，输入异常不运行', () => {
  assert.equal(withinAnalysisRadius(station('edge', 1000).geometry.coordinates, center, 1000), true)
  assert.throws(() => simulate({ additions: [addition('new', 1001)] }), /周边范围/)
  assert.throws(() => simulate({ removedIds: ['outside'] }), /周边范围/)
  assert.throws(() => simulate({ center: [115, 35] }), /魏都区/)
  assert.throws(() => simulate({ radiusMeters: 0 }), /半径/)
  assert.throws(() => simulate({ additions: [addition('new', 50), addition('new', 100)] }), /编号重复/)
  assert.throws(() => simulate({ additions: [{ ...addition('new', 50), properties: { ...addition('new', 50).properties, pileCount: 0 } }] }), /桩数/)
})

test('可直接调布局，也可选定位；切换范围清空旧草稿，范围外点击不调整', async () => {
  const props = reactive({ active: true, stations: [station('near', 400), station('outside', 1200)], boundary,
    features: [{ ...boundary, properties: { id: 1, stationCount: 2, demandIndex: 1 } }], demandPois: [point(center, { id: 'home', name: '中心小区' })] })
  const sandbox = useFacilitySandbox(props)
  sandbox.add(center)
  assert.equal(sandbox.additions.value.length, 1, '全区布局无需定位即可新增')
  await sandbox.run()
  assert.equal(sandbox.result.value.macro.after.stationCount, 3)
  sandbox.tool.value = 'locate'
  sandbox.mapClick({ coordinates: center })
  assert.equal(sandbox.additions.value.length, 0, '切换到周边范围重置全区草稿')
  assert.equal(sandbox.baseline.value.stationCount, 1)
  assert.equal(sandbox.result.value, null)
  sandbox.mapClick({ coordinates: station('new', 800).geometry.coordinates })
  sandbox.toggleRemoval('outside')
  assert.deepEqual(sandbox.removedIds.value, [])
  assert.match(sandbox.error.value, /周边范围/)
  await sandbox.run()
  assert.equal(sandbox.result.value.after.stationCount, 2)
  sandbox.radiusMeters.value = 500
  await nextTick()
  assert.equal(sandbox.result.value, null)
  assert.equal(sandbox.additions.value.length, 0)
  assert.equal(sandbox.baseline.value.stationCount, 1)
  sandbox.add(station('outsideDraft', 800).geometry.coordinates)
  assert.equal(sandbox.additions.value.length, 0)
  sandbox.setLocation(station('newCenter', 1200).geometry.coordinates)
  assert.equal(sandbox.baseline.value.nearest.id, 'outside')
  assert.equal(sandbox.additions.value.length, 0)
  props.active = false
  assert.equal(sandbox.preview.value.editing, false)
})
