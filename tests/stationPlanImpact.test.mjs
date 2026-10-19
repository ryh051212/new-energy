import test from 'node:test'
import assert from 'node:assert/strict'
import { point, polygon, destination } from '@turf/turf'
import { candidateFeasibility, createStationImpactContext, evaluateCandidateImpact, evaluatePlanConstruction, evaluateStationPlan, rankPlanningImpacts } from '../src/utils/stationPlanImpact.js'
import { compareChargingDemand } from '../src/utils/facilityDemand.js'
const origin=[113.83,34.03],at=meters=>destination(origin,meters,90,{units:'meters'}).geometry.coordinates
const boundary=polygon([[[113.8,34],[113.9,34],[113.9,34.06],[113.8,34.06],[113.8,34]]])
const grid={...boundary,properties:{id:1,demandIndex:1,residentialNorm:.8,commercialNorm:.4}}
const station=(id,meters,more={})=>point(at(meters),{id,name:id,pileCount:2,powerKw:60,chargeType:'fast',...more})
const poi=(id,meters)=>point(at(meters),{id,name:id})
const fixture=()=>({features:[grid],beforeStations:[station('原有站',0)],demandPois:[poi('原站小区',100),poi('服务空白小区',2300)]})
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`)

test('旧服务评分在重复布点后上升，新评估明确识别分流；固定总需求守恒，不捏造新增用量',()=>{
 const input=fixture(),after=[...input.beforeStations,station('重复建设',0)],copy=structuredClone(input)
 const legacy=compareChargingDemand({...input,demandPois:[poi('近端',100),poi('边缘',900)],afterStations:after})
 assert.ok(legacy.after.matchScore>legacy.before.matchScore)
 const result=evaluateStationPlan({...input,afterStations:after})
 assert.equal(result.verdict,'redistribution')
 assert.equal(result.newlyReachableWeight,0);near(result.averageSavedMeters,0)
 near(result.diversionShare,100);near(result.stationRows.find(row=>row.id==='原有站').relativeChange,-50)
 near(result.stationRows.reduce((sum,row)=>sum+row.afterWeight,0),result.servedAfter)
 near(result.newCatchmentWeight,result.divertedWeight+result.fromGapWeight+result.uncertainOriginWeight)
 assert.deepEqual(input,copy)
})

test('相同桩数功率建在服务空白位置，比重复布点获得真实新增触达和具体地点的距离改善',()=>{
 const input=fixture(),context=createStationImpactContext(input)
 const duplicate=evaluateCandidateImpact(context,{id:'a',areaName:'重复位置',location:point(at(0))},{pileCount:2,powerKw:60})
 const gap=evaluateCandidateImpact(context,{id:'b',areaName:'空白位置',location:point(at(2300))},{pileCount:2,powerKw:60})
 assert.equal(gap.verdict,'gap-filled');assert.ok(gap.newlyReachableWeight>duplicate.newlyReachableWeight)
 const place=gap.affectedPlaces.find(row=>row.properties.name==='服务空白小区')
 assert.ok(place.properties.beforeDistance>2000&&place.properties.afterDistance<1)
 assert.equal(place.properties.newlyReachable,true)
 const rows=[{id:'a',score:99},{id:'b',score:10}],reviews=new Map([['a',{impact:duplicate,feasibility:{status:'pending'}}],['b',{impact:gap,feasibility:{status:'pending'}}]])
 assert.deepEqual(rankPlanningImpacts(rows,reviews).map(row=>row.id),['b','a'])
 assert.deepEqual(rankPlanningImpacts(rows,reviews,'preference').map(row=>row.id),['a','b'])
})

test('移除站点可导致覆盖和出行下降；无需求、零能力和远离需求的位置不自动报改善',()=>{
 const input=fixture(),removed=evaluateStationPlan({...input,afterStations:[]})
 assert.equal(removed.verdict,'tradeoff');assert.ok(removed.lostReachShare>0)
 assert.equal(evaluateStationPlan({...input,afterStations:[...input.beforeStations,station('无效新增',2300,{pileCount:0})]}).verdict,'no-benefit')
 assert.equal(evaluateStationPlan({...input,afterStations:[...input.beforeStations,station('远处新增',6000)]}).verdict,'no-benefit')
 const empty=evaluateStationPlan({...input,demandPois:[],features:[{...grid,properties:{id:1,demandIndex:0}}],afterStations:input.beforeStations})
 assert.equal(empty.verdict,'insufficient');assert.equal(empty.newlyReachableShare,null)
})

test('未知能力不被当成没有站，新增能力不伪装成新覆盖；未知需求来源单独列出',()=>{
 const input={features:[grid],beforeStations:[station('能力未知',100,{powerKw:null})],demandPois:[poi('小区',100)]}
 const result=evaluateStationPlan({...input,afterStations:[...input.beforeStations,station('新站',100)]})
 assert.equal(result.newlyReachableWeight,0);assert.equal(result.partialCapacity,true)
 near(result.uncertainOriginShare,100)
 assert.equal(result.stationRows.find(row=>row.id==='能力未知').beforeShare,null)
 assert.ok(result.stationRows.find(row=>row.id==='能力未知').afterShare==null)
})

test('建设核查缺项为待核查，明确不满足为失败，同网格多个新站合并核查泊位和配变容量',()=>{
 const row={feature:grid,location:point(at(1500)),extra:{},nearestMeters:1500,parkingSpaces:null,availableKva:null}
 const spec={pileCount:2,powerKw:60},options={boundary,radius:400,powerFactor:.9}
 assert.equal(candidateFeasibility(row,spec,options).status,'pending')
 const checked={...row,parkingSpaces:10,availableKva:300,extra:{sitePermission:true,roadAccess:true,fireSafety:true}}
 assert.equal(candidateFeasibility(checked,spec,options).status,'scenario-pass')
 assert.equal(candidateFeasibility({...checked,extra:{...checked.extra,sitePermission:false}},spec,options).status,'fail')
 assert.equal(candidateFeasibility({...checked,nearestMeters:0},spec,options).status,'fail')
 const result=evaluatePlanConstruction({features:[grid],beforeStations:[],additions:[station('拟建A',1000),station('拟建B',1600)],boundary,options:{radius:400},factors:{'1':{parkingSpaces:10,availableKva:200,sitePermission:true,roadAccess:true,fireSafety:true}}})
 assert.equal(result.status,'fail')
 assert.ok(result.rows.every(row=>row.sharedGrid&&row.feasibility.checks.find(check=>check.id==='grid').state==='fail'))
 const outside=candidateFeasibility({...checked,location:point([114,35])},spec,options)
 assert.equal(outside.checks.find(row=>row.id==='boundary').state,'fail')
})
