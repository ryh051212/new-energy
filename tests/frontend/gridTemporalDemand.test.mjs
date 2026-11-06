import test from 'node:test'
import assert from 'node:assert/strict'
import { polygon } from '@turf/turf'
import { functionalZoneModel } from '../../src/features/planning/models/functionalZones.js'
import { buildGridTemporalDemand, percentile95, spatialDemandIntensity, temporalDemandScale, currentTemporalDemandGrid } from '../../src/features/planning/models/gridTemporalDemand.js'
import { CHARGING_START_PERCENT, PUBLIC_CHARGING_Q } from '../../src/features/planning/models/chargingStartScenario.js'

const grid=(id,p={})=>polygon([[[113,34],[113.01,34],[113.01,34.01],[113,34.01],[113,34]]],{id,workplaceCount:0,shoppingCount:0,leisureCount:0,publicServiceCount:0,...p})
const population=(id,value,area=1)=>({type:'Feature',properties:{id,populationModelCount:value,areaKm2:area}})

test('给定曲线共十条且均为 24 小时 100%',()=>{
  for(const category of Object.values(CHARGING_START_PERCENT))for(const row of Object.values(category)){
    assert.equal(row.length,24);assert.equal(row.reduce((a,b)=>a+b,0),100)
  }
})

test('按 P95 密度、百分比除100、五个0.2权重和Q精确计算，并保留原始数值',()=>{
  const model=functionalZoneModel([grid(1,{workplaceCount:3,shoppingCount:4,leisureCount:5,publicServiceCount:6})])
  const result=buildGridTemporalDemand(model,1,{features:[population(1,100)]})
  const contributions=result.series.medium.weekday[8].contributions
  const manual=.2*(.8*.03+.9*.12+1.1*.01+.9*.01+1*.07)
  assert.ok(Math.abs(result.series.medium.weekday[8].demandIndex-manual)<1e-12)
  assert.ok(Math.abs(contributions.residential-.2*.8*.03)<1e-12)
  assert.ok(result.series.high.weekday[8].demandIndex>result.series.low.weekday[8].demandIndex)
  assert.equal(result.scale,buildGridTemporalDemand(model,1,{features:[population(1,100)]}).scale)
  assert.equal(PUBLIC_CHARGING_Q.medium.shopping,1.1)
})

test('P95包含零值，稀疏类别回退非零P95，已知全零与人口缺失分开处理',()=>{
  assert.ok(Math.abs(percentile95([0,0,0,10])-8.5)<1e-12)
  const features=Array.from({length:30},(_,i)=>grid(i,{workplaceCount:i===0?2:0,shoppingCount:1,leisureCount:1,publicServiceCount:1}))
  const pops={features:features.map((f,i)=>population(i,i===2?null:1))}
  const model=functionalZoneModel(features),spatial=spatialDemandIntensity(model,pops)
  assert.equal(spatial.benchmarks.work.p95,0);assert.equal(spatial.benchmarks.work.reference,2);assert.equal(spatial.benchmarks.work.coverage,'insufficient')
  const missing=buildGridTemporalDemand(model,2,pops)
  assert.equal(missing.available,false);assert.equal(missing.series.medium.weekday[8].demandIndex,null);assert.ok(missing.missing.includes('residential'))
  const empty=functionalZoneModel([grid('x',{shoppingCount:1,leisureCount:1,publicServiceCount:1})])
  const knownZero=buildGridTemporalDemand(empty,'x',{features:[population('x',5)]})
  assert.equal(knownZero.available,true)
  assert.equal(knownZero.benchmarks.work.coverage,'zero')
  assert.equal(knownZero.intensity.work,0)
  assert.equal(knownZero.series.medium.weekday[8].contributions.work,0)
})

test('全区已知零需求保留零值和零尺度，工作日周末只重新分配全天强度',()=>{
  const zeroModel=functionalZoneModel([grid('zero')])
  const zero=buildGridTemporalDemand(zeroModel,'zero',{features:[population('zero',0)]})
  assert.equal(zero.available,true)
  assert.equal(zero.scale,0)
  assert.ok(zero.series.medium.weekday.every(point=>point.demandIndex===0))
  const model=functionalZoneModel([grid('mixed',{workplaceCount:2,shoppingCount:3,leisureCount:4,publicServiceCount:5})])
  const result=buildGridTemporalDemand(model,'mixed',{features:[population('mixed',100)]})
  for(const scenario of ['low','medium','high']){
    const daily=day=>result.series[scenario][day].reduce((sum,point)=>sum+point.demandIndex,0)
    assert.ok(Math.abs(daily('weekday')-daily('weekend'))<1e-12)
  }
})

test('同一时段选择更新全区各格且保留空间差异，原始供需不变，未知与已知零值分开',()=>{
  const features=[grid('home',{demandIndex:.6,stationCount:2,supplyIndex:.4}),
    grid('work',{workplaceCount:100,shoppingCount:100,leisureCount:100,publicServiceCount:100}),
    grid('zero'),grid('missing')]
  const original=structuredClone(features)
  const populationData={features:[population('home',100),population('work',10),population('zero',0)]}
  const model=functionalZoneModel(features),spatial=spatialDemandIntensity(model,populationData),scale=temporalDemandScale(spatial)
  const selection={scenario:'medium',day:'weekday',hour:8}
  const morning=currentTemporalDemandGrid(features,spatial,scale,selection)
  const evening=currentTemporalDemandGrid(features,spatial,scale,{...selection,hour:20})
  assert.ok(evening.features[0].properties.temporalDemandIndex>morning.features[0].properties.temporalDemandIndex)
  assert.ok(evening.features[1].properties.temporalDemandIndex<morning.features[1].properties.temporalDemandIndex)
  assert.equal(evening.features[2].properties.temporalDemandIndex,0)
  assert.equal(evening.features[2].properties.temporalDemandNorm,0)
  assert.equal(evening.features[3].properties.temporalDemandIndex,null)
  assert.equal(evening.features[3].properties.temporalDemandNorm,null)
  for(const scenario of ['low','medium','high']) for(const day of ['weekday','weekend']){
    const selected=currentTemporalDemandGrid(features,spatial,scale,{scenario,day,hour:20})
    for(const [i,feature] of selected.features.entries()){
      const popup=buildGridTemporalDemand(model,feature.properties.id,populationData,{spatial,scale})
      const value=popup.series[scenario][day][20].demandIndex
      assert.equal(feature.properties.temporalDemandIndex,value)
      assert.equal(popup.scale,scale)
      if(value!=null)assert.equal(feature.properties.temporalDemandNorm,value/scale)
      assert.deepEqual(feature.geometry,features[i].geometry)
    }
  }
  assert.equal(evening.features[0].properties.demandIndex,.6)
  assert.equal(evening.features[0].properties.stationCount,2)
  assert.equal(evening.features[0].properties.supplyIndex,.4)
  assert.deepEqual(features,original)
})
