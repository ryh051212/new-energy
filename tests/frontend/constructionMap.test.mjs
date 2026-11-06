import test from 'node:test'
import assert from 'node:assert/strict'
import { area, booleanPointInPolygon, featureCollection, point, polygon } from '@turf/turf'
import { constructionMapData } from '../../src/features/planning/models/constructionMap.js'
import { assessSitingLocation } from '../../src/features/planning/models/sitingSelection.js'

const box = (x, y, width, height, properties = {}) => polygon([[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]], properties)
const boundary = box(113, 34, .04, .04)
const grid = box(112.99, 33.99, .06, .06, { id: 'grid-1' })
const water = box(113.01, 34.01, .01, .01, { category: 'water', name: '测试水体' })
const blocked = box(113.025, 34.025, .005, .005, { noBuild: true, name: '已知禁建地块' })
const context = featureCollection([water, blocked,
  point([113.005, 34.005], { category: 'parking', id: 'parking' }),
  point([114, 35], { category: 'parking', id: 'outside' }),
  point([113.03, 34.01], { category: 'safety' }),
])

test('建站分区裁剪至边界并挖除水域与禁建地块，停车与风险点不虚构占地', () => {
  const before = JSON.stringify({ boundary, grid, context })
  const result = constructionMapData({ boundary, features: [grid], context })
  const zones = result.features.filter(f => f.properties.constructionKind === 'zone')
  assert.equal(zones.length, 1)
  const expected = area(boundary) - area(water) - area(blocked)
  assert.ok(Math.abs(area(zones[0]) - expected) < 1)
  assert.equal(booleanPointInPolygon(point([113.015, 34.015]), zones[0]), false)
  assert.equal(booleanPointInPolygon(point([113.027, 34.027]), zones[0]), false)
  assert.equal(booleanPointInPolygon(point([113.005, 34.005]), zones[0]), true)
  assert.equal(result.features.filter(f => f.properties.constructionKind === 'parking-symbol').length, 1)
  assert.equal(result.features.filter(f => f.properties.constructionKind === 'risk-symbol').length, 1)
  assert.equal(JSON.stringify({ boundary, grid, context }), before)
})

test('水域内部与共边拒绝新增，停车记录仍保留待核查，因素变化同步排除网格', () => {
  const options = { boundary, features: [grid], context }
  assert.equal(assessSitingLocation([113.015, 34.015], options).allowed, false)
  assert.equal(assessSitingLocation([113.01, 34.015], options).allowed, false)
  assert.equal(assessSitingLocation([113.027, 34.027], options).allowed, false)
  assert.equal(assessSitingLocation([113.005, 34.005], options).allowed, true)
  const result = constructionMapData({ ...options, factors: { 'grid-1': { buildable: false } } })
  assert.equal(result.features.some(f => f.properties.constructionKind === 'zone'), false)
})

test('保留多面、边界洞与水域内岛，尚无边界时不显示虚假分区', () => {
  const lake = polygon([...water.geometry.coordinates, [[[113.013, 34.013], [113.017, 34.013], [113.017, 34.017], [113.013, 34.017], [113.013, 34.013]]][0]], { category: 'water' })
  const options = { boundary: featureCollection([boundary, box(113.06, 34, .01, .01)]), features: [grid], context: featureCollection([lake]) }
  const zone = constructionMapData(options).features.find(f => f.properties.constructionKind === 'zone')
  assert.equal(booleanPointInPolygon(point([113.015, 34.015]), zone), true)
  assert.equal(assessSitingLocation([113.015, 34.015], options).allowed, true)
  assert.equal(constructionMapData({ features: [grid], context }).features.length, 0)
})
