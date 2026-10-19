import test from 'node:test'
import assert from 'node:assert/strict'
import { point, polygon, area, booleanPointInPolygon } from '@turf/turf'
import { reactive, nextTick } from 'vue'
import { planningScore, MCDA_FACTOR_WEIGHTS, planningRows, planningRankChanges, screenPlanningRows, spacedPlanningRows, planningEconomics, planningLoadProfile, configurationTotals, planningBlindSpots, planningVoronoi } from '../src/utils/plannerPss.js'
import { weightedAccessibilityLorenz, weightedAccessibilityGini } from '../src/utils/facilityDiagnostics.js'
import { useFacilitySandbox } from '../src/composables/useFacilitySandbox.js'

const grid = (id,x,residentialNorm=.8,commercialNorm=.4) => polygon([[[x,34],[x+.004,34],[x+.004,34.004],[x,34.004],[x,34]]],{id,residentialNorm,commercialNorm,demandIndex:.5,stationCount:0,supplyDemandType:'high-demand-low-supply'})
const station = (id,x,more={}) => point([x,34.002],{id,name:id,pileCount:2,powerKw:60,chargeType:'fast',dataSource:'sandbox',...more})

test('评分按公开公式计算，内部系数和外层权重可独立调节，乘同比例系数不改变结果', () => {
  const indicators={commercial:.4,road:1,parking:.6,office:.2,residential:.8}
  const defaults=structuredClone(MCDA_FACTOR_WEIGHTS)
  const initial=planningScore(indicators)
  assert.ok(Math.abs(initial.fast-.56)<1e-12)
  assert.ok(Math.abs(initial.regular-.568)<1e-12)
  assert.ok(Math.abs(initial.score-65.84)<1e-10)
  const coefficients={fast:{commercial:100,road:0,parking:0,office:0},regular:{residential:100,office:0,parking:0}}
  assert.ok(Math.abs(planningScore(indicators,undefined,coefficients).score-68)<1e-10)
  assert.equal(planningScore(indicators,{fast:1,regular:0,parking:0,road:0},coefficients).score,40)
  assert.deepEqual(planningScore(indicators,undefined,{fast:{commercial:64,road:52,parking:44,office:40},regular:{residential:96,office:64,parking:40}}),initial)
  assert.deepEqual(MCDA_FACTOR_WEIGHTS,defaults)
})

test('公式逐层剔除未知项并重新分配有效权重，全零系数保持未知，实测零指标仍为零分', () => {
  const indicators={commercial:.4,residential:.8,road:null,parking:null,office:null}
  assert.ok(Math.abs(planningScore(indicators).score-60)<1e-10)
  const coefficients={fast:{commercial:0,road:100,parking:0,office:0},regular:{residential:0,office:0,parking:0}}
  assert.equal(planningScore(indicators,undefined,coefficients).score,null)
  assert.equal(planningScore({commercial:0,residential:0,road:0,parking:0,office:0}).score,0)
  assert.equal(planningScore(indicators,{fast:0,regular:0,parking:0,road:0}).score,null)
  const rows=planningRows([grid('one',113,.8,.4)],[],{},undefined,[],{fast:{commercial:100,road:0,parking:0,office:0},regular:{residential:0,office:0,parking:0}})
  assert.equal(rows[0].score,40)
  assert.equal(rows[0].indicators.commercial,.4)
})

test('五维缺失保持未知而非补零；现有居民与商业可形成部分资料评分，补充因子改变排序且不改原数据', () => {
  const features=[grid(1,113),grid(2,113.01)], original=structuredClone(features)
  let rows=planningRows(features,[])
  assert.equal(rows[0].factorCount,2)
  assert.equal(rows[0].parking,null)
  assert.equal(rows[0].availableKva,null)
  assert.equal(rows[0].fast,.4)
  assert.ok(Math.abs(rows[0].regular-.8)<1e-12)
  rows=planningRows(features,[],{'2':{officeCount:10,parkingCount:2,roadIndex:1,parkingSpaces:20,availableKva:500}})
  assert.equal(rows[0].id,'2')
  assert.equal(rows[0].factorCount,5)
  assert.equal(planningRows(features,[],{}, {fast:0,regular:0,parking:0,road:0})[0].score,null)
  assert.deepEqual(features,original)
})

test('候选位置使用格内真实地点辨认区域，最近站与距离始终对应同一候选落点', () => {
  const feature=grid(1,113), reference=station('最近现有站',113.002)
  const pois=[point([113.002,34.002],{name:'大学城',address:'大学路 1 号'}),point([113.003,34.003],{name:'学府小区'}),point([113.1,34.002],{name:'格外地点'})]
  const [row]=planningRows([feature],[station('关闭站',113.002,{status:'closed'}),reference],{},undefined,pois)
  assert.deepEqual(row.placeNames,['大学城','学府小区'])
  assert.equal(row.areaName,'大学城 / 学府小区周边')
  assert.equal(row.address,'大学路 1 号')
  assert.equal(row.nearestStation,reference)
  assert.ok(row.nearestMeters<.001)
  assert.ok(booleanPointInPolygon(row.location,feature))
  assert.match(planningRows([feature],[])[0].areaName,/地点待核查/)
})

test('权重变化反馈保留未四舍五入分差与默认排名，未知评分不制造零分变化', () => {
  const features=[grid(1,113,1,.1),grid(2,113.01,.1,1)]
  const baseline=screenPlanningRows(planningRows(features,[])).candidates
  const changed=planningRankChanges(screenPlanningRows(planningRows(features,[],{},{fast:100,regular:0,parking:0,road:0})).candidates,baseline)
  assert.deepEqual(changed.map(row=>row.id),['2','1'])
  assert.equal(changed[0].rank,1)
  assert.equal(changed[0].defaultRank,2)
  assert.equal(changed[0].rankChange,1)
  assert.ok(Math.abs(changed[0].scoreDelta-45)<1e-9)
  assert.equal(changed[1].rankChange,-1)
  assert.ok(changed[1].scoreDelta<0)
  assert.equal(baseline[0].rank,undefined)
  const tiny=planningRankChanges([{id:'tiny',score:10.006}],[{id:'tiny',score:10}])[0]
  assert.ok(tiny.scoreDelta>.005 && tiny.scoreDelta<.007)
  assert.equal(planningRankChanges([{id:'1',score:null}],baseline)[0].scoreDelta,null)
  assert.equal(planningRankChanges([{id:'1',score:null}],baseline)[0].rankChange,null)
  assert.equal(planningRankChanges([{id:'new',score:75}],baseline)[0].rankChange,null)
})

test('间距、泊位、配网约束实际过滤；未知条件不能算核查通过；零站不制造零米距离', () => {
  const rows=planningRows([grid(1,113),grid(2,113.01)],[station('a',113.002)],{'2':{parkingCount:1,parkingSpaces:20,availableKva:50}})
  assert.deepEqual(screenPlanningRows(rows,{radius:400}).candidates.map(row=>row.id),['2'])
  assert.deepEqual(screenPlanningRows(rows,{radius:400,requireParking:true}).candidates.map(row=>row.id),['2'])
  assert.equal(screenPlanningRows(rows,{radius:400,requireGrid:true,requestedKw:60}).candidates.length,0)
  assert.equal(screenPlanningRows(rows,{radius:400,requireGrid:true,requestedKw:40}).candidates.length,1)
  assert.equal(planningRows([grid(1,113)],[])[0].nearestMeters,null)
})

test('批量候选同时约束新站彼此与已有草稿间距，跳过已纳入网格且保留原排序', () => {
  const rows=planningRows([grid(1,113),grid(2,113.001),grid(3,113.01),grid(4,113.02)],[])
  assert.deepEqual(spacedPlanningRows(rows,[],3,400).map(row=>row.id),['1','3','4'])
  assert.deepEqual(spacedPlanningRows(rows,[station('draft',113.002,{planningGridId:'1'})],3,400).map(row=>row.id),['3','4'])
})

test('最低评分默认排除零分，支持自定义含边界门槛；未知评分不冒充有效候选', () => {
  const rows=planningRows([grid('zero',113,0,0),grid('low',113.01,.4999,.4999),
    grid('boundary',113.02,.5,.5),grid('top',113.03,1,1),grid('unknown',113.04,null,null)],[])
  const original=structuredClone(rows)
  assert.deepEqual(screenPlanningRows(rows).candidates.map(row=>row.id),['top','boundary','low'])
  assert.deepEqual(screenPlanningRows(rows,{minimumScore:50}).candidates.map(row=>row.id),['top','boundary'])
  assert.deepEqual(screenPlanningRows(rows,{minimumScore:100}).candidates.map(row=>row.id),['top'])
  assert.deepEqual(screenPlanningRows(rows,{minimumScore:0}).candidates.map(row=>row.id),['top','boundary','low','zero'])
  const screened=screenPlanningRows(rows,{minimumScore:50})
  assert.equal(screened.constrained.length,5)
  assert.deepEqual(spacedPlanningRows(screened.candidates,[],8,400).map(row=>row.id),['top','boundary'])
  for(const minimumScore of [-1,101,NaN,Infinity,null,'50'])assert.equal(screenPlanningRows(rows,{minimumScore}).candidates.length,0)
  assert.deepEqual(rows,original)
})

test('评分门槛与间距、泊位及配网条件同时生效，没有达标候选时返回空列表', () => {
  const rows=planningRows([grid('near',113,1,1),grid('low',113.01,.2,.2),grid('high',113.02,.8,.8)],
    [station('existing',113.002)])
  for(const row of rows)Object.assign(row,{parking:1,parkingSpaces:20,availableKva:100})
  const options={minimumScore:50,radius:400,requireParking:true,minimumSpaces:15,requireGrid:true,requestedKw:60}
  assert.deepEqual(screenPlanningRows(rows,options).candidates.map(row=>row.id),['high'])
  assert.equal(screenPlanningRows(rows,{...options,minimumScore:100}).candidates.length,0)
  assert.equal(screenPlanningRows(rows,{...options,minimumSpaces:21}).candidates.length,0)
  assert.equal(screenPlanningRows(rows,{...options,requestedKw:100}).candidates.length,0)
})

test('投资情景随桩配置与输入变化；无收益时不捏造固定回收期，空方案为零', () => {
  const result=planningEconomics([station('new',113)],{utilization:.25,marginYuan:.5,fastUnitWan:8,siteWan:10,annualOpexWan:2})
  assert.equal(result.capexWan,26)
  assert.equal(result.dailyKwh,720)
  assert.equal(result.dailySessions,30)
  assert.ok(Math.abs(result.paybackYears-26/(720*365*.5/10000-2))<1e-10)
  assert.equal(planningEconomics([station('new',113)],{marginYuan:0}).paybackYears,null)
  assert.equal(planningEconomics([]).capexWan,0)
  assert.equal(planningEconomics([station('new',113)],{utilization:2}),null)
  assert.equal(planningEconomics([station('new',113)],{sessionKwh:''}),null)
})

test('洛伦兹曲线与原需求加权基尼一致，完全无服务时保持资料不足', () => {
  const values=[0,2,10],weights=[.6,.3,.1],curve=weightedAccessibilityLorenz(values,weights)
  assert.deepEqual(curve[0],[0,0]);assert.deepEqual(curve.at(-1),[1,1])
  let area=0
  for(let i=1;i<curve.length;i++)area+=(curve[i][0]-curve[i-1][0])*(curve[i][1]+curve[i-1][1])/2
  assert.ok(Math.abs(1-2*area-weightedAccessibilityGini(values,weights))<1e-12)
  assert.deepEqual(weightedAccessibilityLorenz([0,0],[1,1]),[])
})

test('逐时储能从空电量开始，逐时满足功率、SOC、效率与能量守恒；未填配变不编造负载率', () => {
  const result=planningLoadProfile([station('a',113)],{batteryKwh:100,batteryKw:40,efficiency:.81})
  assert.equal(result.hours.length,24)
  assert.ok(result.hours.every(row=>row.loadRate===null))
  let energy=0,charged=0,discharged=0
  for(const row of result.hours){
    energy+=row.batteryChargeKw*.9-row.batteryDischargeKw/.9
    charged+=row.batteryChargeKw;discharged+=row.batteryDischargeKw
    assert.ok(Math.abs(energy-row.storedKwh)<1e-8)
    assert.ok(energy>=-1e-8 && energy<=100+1e-8)
    assert.ok(row.batteryChargeKw<=40 && row.batteryDischargeKw<=40)
    assert.ok(row.afterKw>=0)
  }
  assert.ok(discharged<=charged*.81+1e-8)
  const check=planningLoadProfile([station('a',113)],{transformerKva:100,baseLoadKw:80,batteryKwh:0,batteryKw:0})
  assert.ok(check.overloadHours>0)
  assert.ok(check.hours.some(row=>row.loadRate>80))
  assert.equal(planningLoadProfile([station('a',113)],{efficiency:0}),null)
  assert.equal(planningLoadProfile([station('a',113)],{commercialShare:0,officeShare:0,residentialShare:0}),null)
})

test('未知能力不补假定功率；部分已知配置仅汇总已知部分，停用站不参与负荷', () => {
  assert.equal(configurationTotals([station('unknown',113,{powerKw:null})]).capacityKw,null)
  assert.equal(planningLoadProfile([station('unknown',113,{powerKw:null})]),null)
  const result=configurationTotals([station('known',113),station('unknown',113,{powerKw:null}),station('blocked',113,{accessAllowed:false,simulatedFields:[]})])
  assert.equal(result.capacityKw,120);assert.equal(result.unknown,1)
})

test('圈外需求点使用地理距离；无站全部标记，不把缺资料替换成零米', () => {
  const pois=[point([113.002,34.002],{name:'近点'}),point([113.02,34.002],{name:'远点'})]
  assert.deepEqual(planningBlindSpots(pois,[station('a',113.002)],400).map(feature=>feature.properties.name),['远点'])
  assert.equal(planningBlindSpots(pois,[],400).length,2)
  assert.equal(planningBlindSpots(pois,[],400)[0].properties.nearestStationMeters,null)
})

test('泰森分区去除重复坐标并裁剪边界，不把最近站分区冒充距离服务圈', () => {
  const boundary=polygon([[[113,34],[113.03,34],[113.03,34.01],[113,34.01],[113,34]]])
  const first=station('a',113.005),second=station('b',113.025)
  const result=planningVoronoi([first,second,station('duplicate',113.005)],boundary)
  assert.equal(result.features.length,2)
  assert.ok(Math.abs(result.features.reduce((sum,feature)=>sum+area(feature),0)-area(boundary))<1)
  assert.ok(result.features.some(feature=>booleanPointInPolygon(first,feature)))
  assert.equal(planningVoronoi([first],boundary).features.length,1)
  assert.equal(planningVoronoi([],boundary).features.length,0)
})

test('候选配置进入同一沙盘草稿，跨工作台保留结果，配置无效时不添加点位', async () => {
  const features=[grid(1,113)],boundary=features[0]
  const props=reactive({active:true,loading:false,features,stations:[],demandPois:[],boundary})
  const sandbox=useFacilitySandbox(props)
  const added=sandbox.add([113.002,34.002],{name:'选址候选',planningGridId:'1',pileCount:8,powerKw:120,chargeType:'fast'})
  assert.equal(added.properties.pileCount,8)
  assert.equal(sandbox.additions.value.length,1)
  assert.equal(sandbox.add([113.002,34.002],{pileCount:0}),null)
  assert.equal(sandbox.additions.value.length,1)
  await sandbox.run()
  props.active=false;await nextTick()
  assert.equal(sandbox.preview.value.points.length,1)
  assert.ok(sandbox.preview.value.analysisResult)
  assert.equal(sandbox.preview.value.result,null)
})
