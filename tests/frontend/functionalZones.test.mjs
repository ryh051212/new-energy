import test from 'node:test'
import assert from 'node:assert/strict'
import { polygon, point } from '@turf/turf'
import { reactive, nextTick } from 'vue'
import { ACTIVITY_TYPES, DEMAND_SCENARIOS, functionalZoneModel, applyDemandScenario, mergeActivityPois, scoreScenarioRows } from '../../src/features/planning/models/functionalZones.js'
import { demandLocations } from '../../src/features/planning/models/facilityDemand.js'
import { planningRows } from '../../src/features/planning/models/plannerPss.js'
import { createStationImpactContext, evaluateCandidateImpact, rankPlanningImpacts } from '../../src/features/planning/models/stationPlanImpact.js'
import { useFacilitySandbox } from '../../src/features/planning/composables/useFacilitySandbox.js'

const counts = { populationModelCount:0, workplaceCount:0, commercialCount:0, activityCount:0, hospitalCount:0, schoolCount:0 }
function grid(id, x, properties = {}) {
  return polygon([[[x,34],[x+.008,34],[x+.008,34.008],[x,34.008],[x,34]]],
    { id, stationCount:0, supplyIndex:0, demandIndex:.5, ...counts, ...properties })
}
const fixtures = () => [grid('home',113,{populationModelCount:10}),grid('work',113.03,{workplaceCount:10}),
  grid('shop',113.06,{commercialCount:10}),grid('rest',113.09,{activityCount:10}),grid('public',113.12,{hospitalCount:10})]
const near = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-10, `${actual} != ${expected}`)

test('五类活动严格使用给定三组系数，功能区稳定，时间切换共用同一强度尺度', () => {
  const features=fixtures(), original=JSON.stringify(features), model=functionalZoneModel(features)
  const expected=[[.35,1,.55,.35,.75],[1,.15,.8,.8,.45],[.7,.25,1,1,.65]]
  for (const [i,scene] of DEMAND_SCENARIOS.entries()) {
    const result=applyDemandScenario(model,scene.id)
    assert.equal(result.scale,1)
    assert.deepEqual(result.features.map(f=>f.properties.functionalZone),ACTIVITY_TYPES.map(a=>a.id))
    result.features.forEach((feature,index)=>near(feature.properties.demandIndex,expected[i][index]))
  }
  assert.equal(JSON.stringify(features),original,'不得修改数据库基础指标')
})

test('混合功能保留各类贡献，零活动与缺失资料不会伪装成已知低需求', () => {
  const missing=polygon([[[114,34],[114.01,34],[114.01,34.01],[114,34.01],[114,34]]],{id:'missing'})
  const features=[grid('mixed',113,{populationModelCount:10,workplaceCount:10,activityCount:10}),grid('zero',113.1),missing]
  const result=applyDemandScenario(functionalZoneModel(features),'weekday-night')
  assert.equal(result.features[0].properties.functionalZone,'mixed')
  near(result.features[0].properties.demandIndex,(1+.15+.8)/3)
  assert.equal(result.features[1].properties.demandIndex,0)
  assert.equal(result.features[1].properties.demandTier,'unknown')
  assert.equal(result.features[2].properties.scenarioDemandIndex,null)
  assert.equal(result.features[2].properties.demandTier,'unknown')
  assert.equal(result.features[2].properties.activityCompleteness,0)
})

test('人工调查覆盖对应功能，医院学校归公共服务，缺失交通数据不被补造', () => {
  const model=functionalZoneModel([grid('a',113,{hospitalCount:3,schoolCount:2})],{'a':{workplaceCount:10}})
  assert.equal(model.profiles[0].counts.public,5)
  assert.equal(model.profiles[0].counts.work,10)
  assert.equal(model.profiles[0].counts.shopping,0)
  assert.equal(model.profiles[0].counts.transport,undefined)
})

test('需求按活动落在对应POI，同ID去重保留分类，无对应POI时只为该活动使用估计点，总权重守恒', () => {
  const features=[grid('a',113,{populationModelCount:10,workplaceCount:5,activityCount:5})]
  const original=[point([113.001,34.001],{id:'home',category:'residential'})]
  const facilities=[point([113.001,34.001],{id:'home',categories:['residential']}),
    point([113.007,34.007],{id:'work',categories:['company','office']})]
  const merged=mergeActivityPois(original,facilities)
  assert.equal(merged.length,2)
  for(const scene of DEMAND_SCENARIOS) {
    const model=applyDemandScenario(functionalZoneModel(features),scene.id)
    const {locations,fallbackGrids}=demandLocations(model.features,merged)
    near(locations.reduce((sum,l)=>sum+l.weight,0),model.features[0].properties.demandIndex)
    assert.equal(locations.find(l=>l.activity==='residential').fallback,true,'人口使用网格代表点，不分配给住宅POI')
    assert.equal(locations.find(l=>l.activity==='work').feature.properties.id,'work')
    assert.equal(locations.find(l=>l.activity==='leisure').fallback,true)
    assert.equal(fallbackGrids,1)
  }
})

test('人口决定居住强度，缺失人口不回退到住宅POI数量',()=>{
  const model=functionalZoneModel([grid('a',113,{populationModelCount:100,residentialCount:500}),grid('b',113.03,{populationModelCount:200,residentialCount:1}),grid('c',113.06,{populationModelCount:null,residentialCount:999})])
  assert.equal(model.profiles[0].activityIntensity.residential,.5)
  assert.equal(model.profiles[1].activityIntensity.residential,1)
  assert.equal(model.profiles[2].activityIntensity.residential,null)
})

test('场景影响综合评分及真实补点排序：白天工作优先、夜间居住优先，未知和零需求不得靠间距得高分', () => {
  const source=fixtures().slice(0,2), model=functionalZoneModel(source)
  for(const [scene,expected] of [['weekday-day','work'],['weekday-night','home']]) {
    const features=applyDemandScenario(model,scene).features
    const rows=scoreScenarioRows(planningRows(features,[])), context=createStationImpactContext({features,beforeStations:[]})
    const reviews=new Map(rows.map(row=>[row.id,{feasibility:{status:'pending'},impact:evaluateCandidateImpact(context,row,{pileCount:2,powerKw:60,chargeType:'fast'})}]))
    assert.equal(rows[0].id,expected)
    assert.equal(rankPlanningImpacts(rows,reviews)[0].id,expected)
    near(context.totalDemandWeight,features.reduce((sum,f)=>sum+f.properties.demandIndex,0))
  }
  const emptyRows=planningRows([grid('zero',113)],[])
  assert.equal(scoreScenarioRows(emptyRows)[0].score,null)
  const knownZero=applyDemandScenario(functionalZoneModel([grid('zero',113)]))
  assert.equal(scoreScenarioRows(planningRows(knownZero.features,[]))[0].score,0)
})

test('建设与道路资料仍独立处理：缺失道路不充零，零权重无有效平均', () => {
  const features=applyDemandScenario(functionalZoneModel(fixtures())).features
  const rows=scoreScenarioRows(planningRows(features,[]))
  assert.equal(rows[0].scenarioFactors.road,null)
  assert.equal(scoreScenarioRows(planningRows(features,[]),{demand:0,gap:0,parking:0,road:0})[0].score,null)
})

test('切换时间场景保留同一建站草稿，旧结果失效，重新分析使用新需求且不能混入旧场景对照', async () => {
  const features=fixtures().slice(0,2), model=functionalZoneModel(features)
  const boundary=polygon([[[112.99,33.99],[113.05,33.99],[113.05,34.02],[112.99,34.02],[112.99,33.99]]])
  const props=reactive({active:true,loading:false,features,stations:[],demandPois:[],boundary,
    demandModel:applyDemandScenario(model,'weekday-day')})
  const sandbox=useFacilitySandbox(props)
  sandbox.add([113.004,34.004],{pileCount:2,powerKw:60})
  await sandbox.run()
  assert.equal(sandbox.dirty.value,false)
  const before=sandbox.result.value.planningImpact
  props.demandModel=applyDemandScenario(model,'weekday-night')
  await nextTick()
  assert.equal(sandbox.additions.value.length,1)
  assert.equal(sandbox.dirty.value,true)
  assert.equal(sandbox.preview.value.analysisResult,null)
  await sandbox.run()
  assert.equal(sandbox.result.value.planningImpact.scenarioKey,'weekday-night')
  assert.notEqual(sandbox.result.value.planningImpact.contextKey,before.contextKey)
  assert.equal(sandbox.additions.value.length,1)
})
