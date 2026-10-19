import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizePlanningGrid } from '../src/utils/plannerOverview.js'

const grid = (id, stationCount, demandIndex, supplyDemandType = 'high-demand-low-supply') => ({
  type: 'Feature', geometry: { type:'Polygon',coordinates:[[[113.8,34],[113.81,34],[113.81,34.01],[113.8,34]]] },
  properties: {id, stationCount, demandIndex, supplyDemandType},
})

test('总览按实际网格计数，有站占比不等同站点数占比，候选区域排序不修改原数据', () => {
  const features = [grid(1,0,.2),grid(2,8,.9),grid(3,1,.3,'high-demand-high-supply'),grid(4,0,.8)]
  const before = structuredClone(features), summary = summarizePlanningGrid(features)
  assert.equal(summary.occupied,2)
  assert.equal(summary.occupiedShare,50)
  assert.deepEqual(summary.candidates.map(f=>f.properties.id),[2,4,1])
  assert.deepEqual(summary.quadrants.map(row=>row.count),[3,1,0,0])
  assert.deepEqual(features,before)
})

test('缺失资料不使用演示常量，真实零值保持零，未分类不摊入四象限', () => {
  for (const value of [null,undefined,[]]) {
    const summary=summarizePlanningGrid(value)
    assert.equal(summary.occupiedShare,null)
    assert.equal(summary.gridCount,null)
    assert.ok(summary.quadrants.every(item=>item.count===null))
    assert.equal(summary.candidates.length,0)
  }
  const emptySupply=summarizePlanningGrid([grid(1,0,0,'low-demand-low-supply')])
  assert.equal(emptySupply.occupiedShare,0)
  assert.equal(emptySupply.quadrants[0].count,0)
  const missing=summarizePlanningGrid([grid(1,null,.4),grid(2,1,.7,'unknown')])
  assert.equal(missing.occupiedShare,null)
  assert.equal(missing.unclassified,1)
  assert.equal(missing.candidates.length,0)
})
