import test from 'node:test'
import assert from 'node:assert/strict'
import { fixedSupplyComparison, buildFacilityComparison, facilityComparisonView } from '../src/utils/facilityComparison.js'

const grid = (id, stationCount, demandIndex) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { id, stationCount, demandIndex } })
const service = (features, scores) => ({ grid: { type: 'FeatureCollection', features: features.map((feature, index) => ({ ...feature, properties: { ...feature.properties, demandMatchScore: scores[index] } })) } })

test('新增改变全区最大站数时，未调整网格的供需指数和四象限保持原基准', () => {
  const before = [grid(1, 0, .8), grid(2, 2, .5), grid(3, 4, .1)]
  const after = [grid(1, 1, .8), grid(2, 2, .5), grid(3, 8, .1)]
  const result = fixedSupplyComparison(before, after)
  assert.equal(result.after.features[1].properties.supplyIndex, .5)
  assert.deepEqual(result.after.features[1], result.before.features[1])
  assert.equal(result.after.features[2].properties.supplyIndex, 2, '超出原最大值仍按原尺度计算，不能重定标或截断')
  assert.equal(result.reference.supplyMean, .5)
  assert.equal(before[0].properties.supplyIndex, undefined, '不能改写正式数据')
})

test('原站数相同时结果有限且无变更时差值为零', () => {
  const before = [grid(1, 0, .8), grid(2, 0, .2)]
  const result = fixedSupplyComparison(before, [grid(1, 1, .8), before[1]])
  assert.equal(result.reference.range, 1)
  assert.equal(result.after.features[0].properties.supplyIndex, 1)
  assert.deepEqual(result.before.features[1], result.after.features[1])
})

test('分别计算服务和失配变化；加站过量可以失配恶化，未知服务不能当作零', () => {
  const before = [grid(1, 0, .8), grid(2, 2, .5), grid(3, 4, .1)]
  const after = [grid(1, 1, .8), grid(2, 2, .5), grid(3, 8, .1)]
  const comparison = buildFacilityComparison(fixedSupplyComparison(before, after), {
    before: service(before, [10, 70, null]), after: service(after, [35, 65, null]),
  })
  assert.deepEqual(comparison.service, { improved: 1, declined: 1, unchanged: 0, unknown: 1 })
  assert.equal(comparison.supply.improved, 1)
  assert.equal(comparison.supply.declined, 1)
  assert.equal(comparison.supply.unchanged, 1)
  assert.deepEqual(comparison.grid.features.map(feature => feature.properties.matchChange), [25, -5, null])
  assert.deepEqual(comparison.grid.features.map(feature => feature.properties.balanceChange), [.25, 0, -1])
  assert.equal(comparison.supply.beforeProblemGrids, 1)
  assert.equal(comparison.supply.afterProblemGrids, 1, '缓解不足不等于已经跨过问题分类阈值')
})

test('前后和变化地图使用相同网格、固定色阶、正确方向，待运行与退出清空图层', () => {
  const grids = [grid(1, 0, .8), grid(2, 2, .2)]
  const supply = fixedSupplyComparison(grids, [grid(1, 1, .8), grids[1]])
  const comparison = buildFacilityComparison(supply, { before: service(grids, [null, 30]), after: service(grids, [null, 30.1]) })
  const preview = { editing: true, result: { comparison }, comparisonMetric: 'service' }
  const before = facilityComparisonView({ ...preview, stage: 'before' })
  const after = facilityComparisonView({ ...preview, stage: 'after' })
  assert.deepEqual(before.color, after.color)
  assert.deepEqual(before.data.features.map(feature => feature.properties.comparisonValue), [null, 30])
  assert.deepEqual(after.data.features.map(feature => feature.properties.comparisonValue), [null, 30.1])
  const change = facilityComparisonView({ ...preview, stage: 'change' })
  assert.equal(change.data.features[0].properties.comparisonKnown, false)
  assert.equal(change.data.features[1].properties.comparisonValue, .1)
  assert.equal(change.data.features[1].properties.comparisonStatus, 'improved')
  const mismatch = facilityComparisonView({ ...preview, stage: 'change', comparisonMetric: 'supply' })
  assert.equal(mismatch.data.features[0].properties.comparisonValue, .5)
  assert.equal(facilityComparisonView({ ...preview, result: null }).data.features.length, 0)
  assert.equal(facilityComparisonView({ ...preview, editing: false }).legend, null)
})
