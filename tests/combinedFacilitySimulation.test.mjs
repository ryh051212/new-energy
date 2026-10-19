import test from 'node:test'
import assert from 'node:assert/strict'
import { polygon, point, destination, booleanPointInPolygon, circle } from '@turf/turf'
import { compareChargingDemand } from '../src/utils/facilityDemand.js'
import { runCombinedFacilitySimulation } from '../src/utils/combinedFacilitySimulation.js'

const center = [113.83, 34.03]
const boundary = polygon([[[113.8, 34.01], [113.88, 34.01], [113.88, 34.06], [113.8, 34.06], [113.8, 34.01]]])
const at = meters => destination(center, meters, 90, { units: 'meters' }).geometry.coordinates
const station = (id, meters) => point(at(meters), { id, name: '站 ' + id, totalCount: 4, powerKw: 60 })
const add = (id, meters) => point(at(meters), { id, name: '新增 ' + id, pileCount: 4, powerKw: 60, chargeType: 'fast' })
const input = () => ({ features: [{ ...boundary, properties: { id: 1, demandIndex: 1, stationCount: 1 } }], stations: [station('a', 650)],
  boundary, demandPois: [point(at(400), { id: 'inside', name: '圈内小区' }), point(at(900), { id: 'outside', name: '圈外小区' })] })

test('全区布局可不选定位运行，保留宏观服务与供需两种评价', () => {
  const result = runCombinedFacilitySimulation({ ...input(), additions: [add('new', 200)] })
  assert.equal(result.center, null)
  assert.equal(result.before.stationCount, 1)
  assert.equal(result.after.stationCount, 2)
  assert.equal(result.macro.comparison.grid.features.length, 1)
  assert.equal(result.macro.evaluation.locations.features.length, 2)
  assert.equal(result.macro.before.stationCount, 1)
})

test('圈外站点仍服务圈内需求；裁切评价不重新分配能力或改变全区基准', () => {
  const f = input()
  const full = compareChargingDemand({ features: f.features, beforeStations: f.stations, afterStations: f.stations, demandPois: f.demandPois })
  const regional = runCombinedFacilitySimulation({ ...f, center, radiusMeters: 500 })
  assert.equal(regional.before.stationCount, 0, '车主范围内没有候选站')
  assert.equal(regional.macro.evaluation.before.demandReach, 100, '圈内小区可以使用圈外站点')
  assert.equal(regional.macro.evaluation.locations.features.length, 1)
  assert.equal(regional.macro.evaluation.locations.features[0].properties.name, '圈内小区')
  assert.equal(regional.macro.evaluation.locations.features[0].properties.beforeMatch, full.locations.features[0].properties.beforeMatch)
  assert.equal(regional.macro.evaluation.referenceCapacityKw, full.referenceCapacityKw)
  assert.equal(regional.changedPlaces.length, 0)
})

test('区域网格只绘制范围内部分，增删只产生实际指标变化，代表点不列为真实地点', () => {
  const f = input()
  const result = runCombinedFacilitySimulation({ ...f, center, radiusMeters: 500, additions: [add('new', 100)] })
  assert.equal(result.after.stationCount, 1)
  assert.equal(result.macro.evaluation.locations.features.length, 1)
  assert.equal(result.changedPlaces.some(feature => feature.properties.id === 'outside'), false)
  const area = circle(center, .5, { steps: 64 })
  for (const grid of result.macro.comparison.grid.features) for (const coordinate of grid.geometry.coordinates[0]) {
    assert.ok(booleanPointInPolygon(point(coordinate), area, { ignoreBoundary: false }))
  }
  const fallback = runCombinedFacilitySimulation({ ...f, demandPois: [], additions: [add('new', 100)] })
  assert.equal(fallback.changedPlaces.length, 0)
  assert.equal(fallback.macro.evaluation.fallbackGrids, 1)
})

test('真实但未命名的地点保留实际坐标，不冒充网格代表点', () => {
  const f = input()
  const value = runCombinedFacilitySimulation({ ...f, demandPois: [point(at(400), { id: 'unnamed' })] })
  assert.equal(value.macro.evaluation.locations.features[0].properties.name, '未命名地点')
  assert.equal(value.macro.evaluation.locations.features[0].properties.fallback, false)
})
