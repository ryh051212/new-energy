import test from 'node:test'
import assert from 'node:assert/strict'
import { polygon, point } from '@turf/turf'
import { reactive, nextTick } from 'vue'
import { assignFacilityGrid, runFacilitySimulation, facilityDataset, namedFacilityCandidates } from '../src/utils/facilitySandbox.js'
import { useFacilitySandbox } from '../src/composables/useFacilitySandbox.js'

function fixture() {
  const boundary = polygon([[[113, 34], [113.02, 34], [113.02, 34.01], [113, 34.01], [113, 34]]])
  const features = [polygon([[[113, 34], [113.01, 34], [113.01, 34.01], [113, 34.01], [113, 34]]],
    { id: 1, stationCount: 0, demandIndex: .8, supplyIndex: 0, mismatchIndex: .8, supplyDemandType: 'high-demand-low-supply' }),
  polygon([[[113.01, 34], [113.02, 34], [113.02, 34.01], [113.01, 34.01], [113.01, 34]]],
    { id: 2, stationCount: 2, demandIndex: .2, supplyIndex: 1, mismatchIndex: -.8, supplyDemandType: 'low-demand-high-supply' })]
  const stations = [point([113.015, 34.005], { id: 'a', totalCount: 4 }), point([113.016, 34.006], { id: 'b', totalCount: 2 })]
  return { features, stations, boundary }
}
const newPoint = (id = 'new', properties = {}) => point([113.005, 34.005], { id, name: '新增测试站', chargeType: 'fast', pileCount: 6, powerKw: 80, ...properties })

test('真实点位范围排除虚拟站并重算网格站数、供需阈值；名称对应区内 POI，原始数据不变', () => {
  const f = fixture()
  f.stations[1].properties.isSynthetic = true
  const original = structuredClone(f)
  const model = facilityDataset(f, 'recorded')
  assert.equal(model.stations.length, 1)
  assert.deepEqual(model.features.map(feature => feature.properties.stationCount), [0, 1])
  assert.equal(runFacilitySimulation({ ...model, boundary: f.boundary }).before.stationCount, 1)
  const candidates = namedFacilityCandidates(model.features, [point([113.005, 34.005], { name: '待补强小区' }), point([114, 35], { name: '区外' })])
  assert.equal(candidates[0].properties.areaName, '待补强小区')
  assert.equal(candidates[0].properties.placeCount, 1)
  assert.deepEqual(f, original)
  assert.equal(facilityDataset(f, 'all').stations.length, 2)
})

test('新增和移除同时运行：站点总数不变，填补无站网格，桩数与功率按参数计算，供需指数重算', () => {
  const input = fixture(), original = structuredClone(input)
  const result = runFacilitySimulation({ ...input, additions: [newPoint()], removedIds: ['a', 'a'] })
  assert.equal(result.before.stationCount, 2)
  assert.equal(result.after.stationCount, 2)
  assert.equal(result.before.occupied, 1)
  assert.equal(result.after.occupied, 2)
  assert.equal(result.after.occupiedShare, 100)
  assert.equal(result.after.problemGrids, 0)
  assert.equal(result.before.pileCount, 6)
  assert.equal(result.after.pileCount, 8)
  assert.equal(result.addedPowerKw, 480)
  assert.deepEqual(result.grid.features.map(feature => feature.properties.stationCount), [1, 1])
  assert.deepEqual(result.grid.features.map(feature => feature.properties.supplyIndex), [.5, .5])
  assert.deepEqual(result.grid.features.map(feature => feature.properties.mismatchIndex), [.3, -.3])
  assert.deepEqual(input, original)
})

test('最后一个站点被移除才减少有站网格，共边选最小 ID，区外点位及不一致数据拒绝计算', () => {
  const input = fixture()
  assert.equal(runFacilitySimulation({ ...input, removedIds: ['a'] }).after.occupied, 1)
  assert.equal(runFacilitySimulation({ ...input, removedIds: ['a', 'b'] }).after.occupied, 0)
  assert.equal(assignFacilityGrid([113.01, 34.005], [...input.features].reverse(), input.boundary).properties.id, 1)
  assert.throws(() => assignFacilityGrid([112, 34], input.features, input.boundary), /边界内/)
  assert.throws(() => runFacilitySimulation({ ...input, removedIds: ['missing'] }), /已变化/)
  assert.throws(() => runFacilitySimulation({ ...input, stations: [] }), /不一致/)
})

test('模拟参数非法时阻止运行；未知记录桩数不补零，含模拟的原记录明确标记', () => {
  const input = fixture()
  for (const properties of [{ pileCount: 0 }, { pileCount: 1.5 }, { powerKw: NaN }, { powerKw: -1 }, { name: '' }, { chargeType: 'DC' }]) {
    assert.throws(() => runFacilitySimulation({ ...input, additions: [newPoint('new', properties)] }))
  }
  input.stations[0].properties.totalCount = null
  input.stations[1].properties.simulatedFields = ['totalCount']
  const result = runFacilitySimulation({ ...input, additions: [newPoint()] })
  assert.equal(result.before.pileCount, null)
  assert.equal(result.after.pileCount, null)
  assert.equal(result.containsDemoRecords, true)
  assert.equal(result.addedPiles, 6)
})

test('真实响应式沙盘随页签激活，仅在点击运行时计算，编辑标记过期，切换页签保留草稿与结果', async () => {
  const props = reactive({ ...fixture(), active: false }), sandbox = useFacilitySandbox(props)
  sandbox.mapClick({ coordinates: [113.005, 34.005] })
  assert.equal(sandbox.additions.value.length, 0, '数据总览不能编辑模拟点位')
  props.active = true
  sandbox.tool.value = 'locate'
  sandbox.mapClick({ coordinates: [113.014, 34.005] })
  assert.deepEqual(sandbox.center.value, [113.014, 34.005])
  assert.equal(sandbox.additions.value.length, 0, '第一次点地图只选定位，不新增站点')
  sandbox.mapClick({ coordinates: [113.005, 34.005] })
  assert.equal(sandbox.additions.value.length, 1)
  assert.equal(sandbox.result.value, null)
  sandbox.updateSelected('pileCount', 3)
  sandbox.updateSelected('powerKw', 100)
  await sandbox.run()
  assert.equal(sandbox.result.value.after.simulatedPiles, 3)
  assert.equal(sandbox.dirty.value, false)
  assert.equal(sandbox.stage.value, 'after')
  assert.equal(sandbox.tool.value, 'inspect')
  sandbox.mapClick({ coordinates: [113.005, 34.005] })
  assert.equal(sandbox.additions.value.length, 1, '查看对比时点击地图不得新增点位')
  sandbox.updateSelected('powerKw', 120)
  await nextTick()
  assert.equal(sandbox.dirty.value, true)
  assert.equal(sandbox.preview.value.result, null, '不能把上次供需结果当成新方案')
  assert.equal(sandbox.result.value.after.simulatedPiles, 3)
  await sandbox.run()
  assert.equal(sandbox.result.value.stations.at(-1).properties.powerKw, 120)
  sandbox.tool.value = 'remove'
  sandbox.mapClick({ stationId: 'a' })
  assert.deepEqual(sandbox.removedIds.value, ['a'])
  sandbox.mapClick({ removedId: 'a' })
  assert.deepEqual(sandbox.removedIds.value, [])
  const draft = sandbox.additions.value
  await sandbox.run()
  const result = sandbox.result.value
  props.active = false
  assert.equal(sandbox.preview.value.editing, false)
  assert.equal(sandbox.preview.value.stage, 'before')
  assert.equal(sandbox.preview.value.result, null)
  sandbox.mapClick({ coordinates: [113.005, 34.005] })
  props.active = true
  assert.equal(sandbox.preview.value.editing, true)
  assert.equal(sandbox.additions.value, draft)
  assert.equal(sandbox.preview.value.result, result)
  assert.equal(sandbox.stage.value, 'after')
  sandbox.tool.value = 'remove'
  sandbox.mapClick({ sandboxId: sandbox.additions.value[0].properties.id })
  await sandbox.run()
  assert.equal(sandbox.result.value.after.stationCount, 2)
})
