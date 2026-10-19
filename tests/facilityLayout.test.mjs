import test from 'node:test'
import assert from 'node:assert/strict'
import { facilityCandidates, compareFacilityLayout } from '../src/utils/facilityLayout.js'

const grid = (id, stationCount, demandIndex, supplyDemandType = 'high-demand-low-supply') => ({ type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[113.8, 34], [113.81, 34], [113.81, 34.01], [113.8, 34]]] },
  properties: { id, stationCount, demandIndex, supplyDemandType } })
const features = () => [grid(1, 1, .786), grid(2, 0, .75), grid(3, 1, .729), grid(4, 5, .99, 'high-demand-high-supply')]

test('三个新增建议只使一个无站网格变为有站，已有站网格不重复增加覆盖统计', () => {
  const input = features(), original = structuredClone(input)
  const result = compareFacilityLayout(input, ['1', '2', '3'])
  assert.equal(result.addedCount, 3)
  assert.equal(result.newlyOccupied, 1)
  assert.deepEqual(result.before, { stationCount: 7, occupied: 3, occupiedShare: 75 })
  assert.deepEqual(result.after, { stationCount: 10, occupied: 4, occupiedShare: 100 })
  assert.equal(result.occupiedShareChange, 25)
  assert.deepEqual(input, original, '原始站点数和供需属性不被情景修改')
})

test('取消无站网格建议后站点数仍增加，有站网格数和占比保持不变；全取消等于新增前', () => {
  const result = compareFacilityLayout(features(), [1, 3], 172)
  assert.equal(result.after.stationCount, 174)
  assert.equal(result.before.occupied, result.after.occupied)
  assert.equal(result.occupiedShareChange, 0)
  const empty = compareFacilityLayout(features(), [], 172)
  assert.deepEqual(empty.after, empty.before)
})

test('高供给区域、过期 ID 及重复选择不生成额外新增建议，未知站点数不冒充零', () => {
  assert.deepEqual(facilityCandidates(features()).map(feature => feature.properties.id), [1, 2, 3])
  assert.equal(compareFacilityLayout(features(), [1, '1', 4, 999]).addedCount, 1)
  const missing = features()
  missing[0].properties.stationCount = null
  assert.deepEqual(facilityCandidates(missing).map(feature => feature.properties.id), [2, 3])
  const result = compareFacilityLayout(missing, [2, 3])
  assert.equal(result.before.stationCount, null)
  assert.equal(result.before.occupied, null)
  assert.equal(result.after.occupiedShare, null)
  const noGrid = compareFacilityLayout([], [], 172)
  assert.equal(noGrid.after.stationCount, 172)
  assert.equal(noGrid.after.occupiedShare, null)
})
