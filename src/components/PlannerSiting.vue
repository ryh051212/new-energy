<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { distance } from '@turf/turf'
import { MCDA_WEIGHTS, MCDA_FACTOR_WEIGHTS, planningRows, planningRankChanges, screenPlanningRows, spacedPlanningRows, downloadPlanningCsv } from '../utils/plannerPss.js'
import PlanningImpactReport from './PlanningImpactReport.vue'
import { CONSTRUCTION_SURVEY_FIELDS, createStationImpactContext, evaluateCandidateImpact, candidateFeasibility, rankPlanningImpacts } from '../utils/stationPlanImpact.js'

const props = defineProps({
  features: { type:Array,default:()=>[] },stations: { type:Array,default:()=>[] },
  demandPois: { type:Array,default:()=>[] },points: { type:Array,default:()=>[] },
  loading:Boolean,dataScope:{type:String,default:'all'},bufferVisible:Boolean,selectedId:String,boundary:Object,
})
const emit = defineEmits(['focus-grid','toggle-candidate','add-candidates','show-buffer','open-simulation','set-scope','factors-change','candidates-change','impact-preview','construction-options','focus-place','focus-station'])
const weights = ref({...MCDA_WEIGHTS}), radius = ref(400), onlyProblems = ref(false), rankingMode=ref('need')
const minimumScore = ref(1)
const formulaWeights = ref(structuredClone(MCDA_FACTOR_WEIGHTS)), formulaOpen = ref(false)
const requireParking = ref(false), requireGrid = ref(false), minimumSpaces = ref(15), batchSize = ref(8)
const chargeType = ref('fast'), pileCount = ref(2), powerKw = ref(60), powerFactor = ref(.9)
const overrides = ref({}), detailId = ref(''), buffer = ref(false), scope = ref('all'), revision = ref(0)
const constraintsOpen = ref(false), factorsOpen = ref(false)
const candidateTable = ref(null),assessmentEl=ref(null)
function reviewRow(row){chooseRow(row);nextTick(()=>assessmentEl.value?.scrollIntoView({block:'start',behavior:'smooth'}))}
const factorFields = [
  {key:'officeCount',label:'办公 / 科教 / 医卫 POI 数',step:1},
  {key:'parkingCount',label:'停车场 POI 数（开放情况待核查）',step:1},
  {key:'roadIndex',label:'道路通达条件指数（0～1）',step:.01,max:1},
  {key:'parkingSpaces',label:'公共可用泊位数',step:1},
  {key:'availableKva',label:'可用配变余量（kVA）',step:1},
]
const weightFields = [
  {key:'fast',label:'快充需求',color:'#e88a28'},
  {key:'regular',label:'普通充电需求',color:'#8563d9'},
  {key:'parking',label:'公共停车条件',color:'#169f83'},
  {key:'road',label:'道路通达条件',color:'#4081de'},
]
const formulaGroups = [
  {key:'fast',label:'快充需求分 F快',fields:[{key:'commercial',label:'商业 C'},{key:'road',label:'道路 R'},{key:'parking',label:'停车 P'},{key:'office',label:'办公医教 O'}]},
  {key:'regular',label:'普通充电需求分 F普',fields:[{key:'residential',label:'居民 H'},{key:'office',label:'办公医教 O'},{key:'parking',label:'停车 P'}]},
]
const indicatorFields = [{key:'residential',label:'居民 H'},{key:'commercial',label:'商业 C'},{key:'office',label:'办公医教 O'},{key:'parking',label:'停车 P'},{key:'road',label:'道路 R'}]
const formulaAdjusted = computed(()=>formulaGroups.some(group=>group.fields.some(field=>formulaWeights.value[group.key][field.key]!==MCDA_FACTOR_WEIGHTS[group.key][field.key])))
function resetFormula(){formulaWeights.value=structuredClone(MCDA_FACTOR_WEIGHTS)}
try {
  const saved = JSON.parse(localStorage.getItem('weidu-planning-factors-v1') || '{}')
  for (const [id,values] of Object.entries(saved)) {
    if (!values || typeof values !== 'object') continue
    overrides.value[id] = Object.fromEntries(factorFields.filter(field => typeof values[field.key] === 'number'
      && Number.isFinite(values[field.key]) && values[field.key] >= 0
      && (field.max == null || values[field.key] <= field.max)).map(field=>[field.key,values[field.key]]))
    for(const field of CONSTRUCTION_SURVEY_FIELDS)if(typeof values[field.key]==='boolean')overrides.value[id][field.key]=values[field.key]
    if(typeof values.constructionEvidence==='string')overrides.value[id].constructionEvidence=values.constructionEvidence.slice(0,300)
  }
} catch { /* Optional local survey scenarios. */ }
watch(()=>props.bufferVisible,value=>{buffer.value=value},{immediate:true})
watch(()=>props.dataScope,value=>{scope.value=value || 'all'},{immediate:true})
watch(()=>props.selectedId,value=>{if(value)detailId.value=value},{immediate:true})
watch(overrides,value=>{
  try { localStorage.setItem('weidu-planning-factors-v1',JSON.stringify(value)) } catch { /* Optional persistence. */ }
  emit('factors-change',value)
},{deep:true,immediate:true})
watch([weights,formulaWeights],()=>{revision.value++},{deep:true})

const rows = computed(()=>planningRows(props.features,props.stations,overrides.value,weights.value,props.demandPois,formulaWeights.value))
const baselineRows = computed(()=>planningRows(props.features,props.stations,overrides.value,MCDA_WEIGHTS,props.demandPois))
const spec = computed(()=>({chargeType:chargeType.value,pileCount:pileCount.value,powerKw:powerKw.value}))
const validSpec = computed(()=>Number.isInteger(pileCount.value) && pileCount.value>0 && pileCount.value<=1000 && Number.isFinite(powerKw.value) && powerKw.value>0 && powerKw.value<=1000)
const screeningOptions = computed(()=>({
  radius:radius.value,onlyProblems:onlyProblems.value,requireParking:requireParking.value,minimumSpaces:minimumSpaces.value,
  requireGrid:requireGrid.value,requestedKw:validSpec.value ? pileCount.value*powerKw.value : Infinity,powerFactor:powerFactor.value,minimumScore:minimumScore.value,
}))
const screening = computed(()=>screenPlanningRows(rows.value,screeningOptions.value))
const impactContext=computed(()=>createStationImpactContext({features:props.features,beforeStations:props.stations,demandPois:props.demandPois}))
const constructionOptions=computed(()=>({radius:radius.value,minimumSpaces:requireParking.value?minimumSpaces.value:0,powerFactor:powerFactor.value}))
watch(constructionOptions,value=>emit('construction-options',value),{immediate:true})
const reviews=computed(()=>new Map(baselineRows.value.map(row=>{
 const impact=evaluateCandidateImpact(impactContext.value,row,spec.value)
 const feasibility=candidateFeasibility(row,spec.value,{...constructionOptions.value,boundary:props.boundary,referenceCount:props.stations.length})
 return [row.id,{feasibility,impact:impact?{newlyReachableWeight:impact.newlyReachableWeight,newlyReachableShare:impact.newlyReachableShare,averageSavedMeters:impact.averageSavedMeters,distanceBenefitTotal:impact.distanceBenefitTotal,verdict:impact.verdict}:null}]
})))
const candidates = computed(()=>{
  const shortlisted = screening.value.candidates
  const ids = new Set(shortlisted.map(row=>row.id))
  return planningRankChanges(rankPlanningImpacts(shortlisted,reviews.value,rankingMode.value),
    rankPlanningImpacts(baselineRows.value.filter(row=>ids.has(row.id)),reviews.value,rankingMode.value))
})
watch(candidates,value=>emit('candidates-change',value),{immediate:true})
const batch = computed(()=>spacedPlanningRows(candidates.value.filter(row=>reviews.value.get(row.id)?.feasibility.status!=='fail'),props.points,batchSize.value,radius.value))
const selected = computed(()=>rows.value.find(row=>row.id===detailId.value) || rows.value[0])
const selectedCandidate = computed(()=>candidates.value.find(row=>row.id===selected.value?.id))
const selectedCalculation = computed(()=>{
  if(!selected.value)return null
  const values={fast:selected.value.fast,regular:selected.value.regular,parking:selected.value.indicators.parking,road:selected.value.indicators.road}
  const terms=weightFields.filter(field=>values[field.key]!=null && weights.value[field.key]>0)
  return {denominator:terms.reduce((sum,field)=>sum+weights.value[field.key],0),
    expression:terms.map(field=>`${weights.value[field.key]} × ${values[field.key].toFixed(4)}`).join(' + ')}
})
const selectedImpact=computed(()=>evaluateCandidateImpact(impactContext.value,selectedCandidate.value,spec.value))
watch(selectedImpact,value=>emit('impact-preview',value),{immediate:true})
function updateSurvey(key,value){if(!selected.value)return;const next={...(overrides.value[selected.value.id] || {})};if(value==='')delete next[key];else next[key]=key==='constructionEvidence'?value.slice(0,300):value==='true';overrides.value={...overrides.value,[selected.value.id]:next}}
const impactLabel=row=>({ 'gap-filled':'让附近无站的地点有站',closer:'部分地点到站更近','more-options':'附近多了可选站址',redistribution:'主要分流原有站','no-benefit':'未见补点收益',tradeoff:'有些地点服务变差',insufficient:'资料不足' }[reviews.value.get(row.id)?.impact?.verdict] || '配置待完善')
const available = computed(()=>Object.fromEntries(weightFields.map(field=>[field.key,rows.value.filter(row=>row[field.key]!=null).length])))
const missingLabels = computed(()=>weightFields.filter(field=>!available.value[field.key]).map(field=>field.label))
const hasScoringWeight = computed(()=>weightFields.some(field=>available.value[field.key] && weights.value[field.key]>0))
const effectiveWeight = key => {
  const total = weightFields.reduce((sum,field)=>sum+(available.value[field.key] ? weights.value[field.key] : 0),0)
  return available.value[key] && total ? Math.round(weights.value[key]/total*100) : 0
}
const adjusted = computed(()=>formulaAdjusted.value || weightFields.some(field=>available.value[field.key] && effectiveWeight(field.key)!==Math.round(MCDA_WEIGHTS[field.key]/weightFields.reduce((sum,item)=>sum+(available.value[item.key] ? MCDA_WEIGHTS[item.key] : 0),0)*100)))
const changedCount = computed(()=>candidates.value.filter(row=>row.scoreDelta!=null && Math.abs(row.scoreDelta)>=.005).length)
const movedCount = computed(()=>candidates.value.filter(row=>row.rankChange).length)
const largestChange = computed(()=>[...candidates.value].sort((a,b)=>Math.abs(b.scoreDelta || 0)-Math.abs(a.scoreDelta || 0))[0])
const fmt = (value,digits=2)=>value==null ? '—' : value.toFixed(digits)
const deltaLabel = value=>value==null ? '资料不足' : Math.abs(value)<.005 ? '评分未变' : (value>0?'＋':'−')+Math.abs(value).toFixed(2)+' 分'
const rankLabel = value=>value==null ? '暂无排名比较' : value>0 ? '↑ '+value+' 位' : value<0 ? '↓ '+Math.abs(value)+' 位' : '排名未变'
const tone = row=>row.score>=70 ? 'score-high' : row.score>=50 ? 'score-medium' : 'score-low'
const planned = row=>props.points.some(feature=>String(feature.properties.planningGridId)===row.id)
const conflicts = row=>!planned(row) && props.points.some(feature=>distance(feature,row.location,{units:'meters'})<radius.value)
function chooseRow(row) {
  detailId.value=row.id
  emit('focus-grid',row.feature)
}
function selectCandidate(id) {
  const row=candidates.value.find(row=>row.id===String(id))
  if(!row)return
  chooseRow(row)
  nextTick(()=>Array.from(candidateTable.value?.querySelectorAll('tbody tr') || [])
    .find(element=>element.dataset.gridId===row.id)?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'}))
}
defineExpose({selectCandidate})
function updateFactor(field,raw) {
  if(!selected.value)return
  const next={...(overrides.value[selected.value.id] || {})},value=raw==='' ? null : Number(raw)
  if(value==null)delete next[field.key]
  else if(!Number.isFinite(value) || value<0 || field.max!=null && value>field.max || field.step===1 && !Number.isInteger(value))return
  else next[field.key]=value
  overrides.value={...overrides.value,[selected.value.id]:next}
}
function exportRows() {
  downloadPlanningCsv('魏都区-约束选址.csv',
    ['顺位','候选位置','周边地址','网格','当前评分','相对初始参数分差','初始顺位','排名变化','参照现有站','站点ID','直线间距m','快充需求','普通需求','因子资料数','公共泊位','配变余量kVA','已纳入情景','最低偏好评分','外层权重（快充/普通/停车/道路）','快充系数（商业/道路/停车/办公医教）','普通充电系数（居民/办公医教/停车）','居民指数H','商业指数C','办公医教指数O','停车指数P','道路指数R'],
    candidates.value.map(row=>[row.rank,row.areaName,row.address,row.id,row.score,row.scoreDelta,row.defaultRank,row.rankChange,row.nearestStation?.properties.name,row.nearestStation?.properties.id,row.nearestMeters,row.fast,row.regular,row.factorCount,row.parkingSpaces,row.availableKva,planned(row),minimumScore.value,
      weightFields.map(field=>weights.value[field.key]).join('/'),formulaGroups[0].fields.map(field=>formulaWeights.value.fast[field.key]).join('/'),formulaGroups[1].fields.map(field=>formulaWeights.value.regular[field.key]).join('/'),
      ...indicatorFields.map(field=>row.indicators[field.key])]))
}
</script>

<template>
  <section class="pss-workbench pss-siting" aria-label="约束过滤与多准则选址">
    <div class="siting-intro">
      <div><span class="pss-eyebrow">约束选址 · 找需要补站的位置</span><h2>哪里需要建，条件是否允许</h2><p>同样的桩数与功率，优先比较补到的服务空白和距离收益；选中位置可核查建设条件、周边分流。</p></div>
      <button class="pss-primary" @click="emit('open-simulation')">查看方案推演 →</button>
    </div>
    <div class="siting-overview-strip">
      <span>候选 <b>{{ loading ? '—' : candidates.length }}</b> 处</span>
      <span>评分变化 <b :class="{active:changedCount}">{{ changedCount }}</b> 处</span>
      <span>排名变化 <b :class="{active:movedCount}">{{ movedCount }}</b> 处</span>
      <span>方案新增 <b>{{ points.length }}</b> 站</span>
    </div>

    <section class="pss-card siting-weights" aria-label="权重调整与变化反馈">
      <div class="pss-card-heading"><h3>调整选址偏好</h3><button @click="weights={...MCDA_WEIGHTS}">恢复默认权重</button></div>
      <div class="siting-weight-grid">
        <label v-for="field in weightFields" :key="field.key" :class="{unavailable:!available[field.key]}" :style="{'--weight-color':field.color}">
          <span><i></i>{{ field.label }}<b>{{ effectiveWeight(field.key) }}%</b></span>
          <input v-model.number="weights[field.key]" type="range" min="0" max="100" step="5" :disabled="!available[field.key]" :aria-label="field.label+'权重'" />
          <small>{{ available[field.key] ? available[field.key]+' 个网格有可用资料' : '没有资料，暂未参与评分' }}</small>
        </label>
      </div>
      <div class="siting-weight-feedback" :class="{adjusted}" role="status" aria-live="polite">
        <template v-if="!hasScoringWeight"><b>暂无可用于评分的权重</b><span>请为至少一个有资料的因子设置大于零的权重；缺资料的因子可在下方补充。</span></template>
        <template v-else-if="adjusted"><b>{{ changedCount }} 处改分 · {{ movedCount }} 处排名变化</b><span v-if="largestChange">变化最大：{{ largestChange.areaName }}，{{ deltaLabel(largestChange.scoreDelta) }}。</span><span>分差与排名对比初始情景参数，地图编号同步更新。</span></template>
        <template v-else><b>当前为初始情景参数</b><span>参数可调整，不是官方评分标准。展开下方公式查看计算过程。</span></template>
      </div>
      <p v-if="missingLabels.length" class="siting-missing-note">{{ missingLabels.join('、') }}暂无资料，不计入本轮评分。<button @click="factorsOpen=true">补充资料</button></p>
      <details class="siting-score-formula" :open="formulaOpen" @toggle="formulaOpen=$event.target.open">
        <summary>评分公式与参数（可调整）</summary>
        <p class="pss-note">采用分层加权平均。当前初始系数是本工具的情景假设，未引用地方规范或文献定值；可按调查、专家判断或研究方案修改。</p>
        <div class="siting-formula-equations" aria-label="当前评分公式">
          <p>F快 = ({{ formulaWeights.fast.commercial }}C + {{ formulaWeights.fast.road }}R + {{ formulaWeights.fast.parking }}P + {{ formulaWeights.fast.office }}O) / Σ有效快充系数</p>
          <p>F普 = ({{ formulaWeights.regular.residential }}H + {{ formulaWeights.regular.office }}O + {{ formulaWeights.regular.parking }}P) / Σ有效普通充电系数</p>
          <p>S = 100 × ({{ weights.fast }}F快 + {{ weights.regular }}F普 + {{ weights.parking }}P + {{ weights.road }}R) / Σ有效外层权重</p>
        </div>
        <p class="pss-note">H、C 为数据库中的居民与商业标准化指数，项目生成公式为 (数量 − 最小值) / (最大值 − 最小值)，无差异时为 0。O、P 分别为当前网格的办公医教、停车 POI 数 / 当前评估网格中的最大数量；最大数量为 0 时取 0。R 为补充的 0～1 道路条件指数。</p>
        <p class="pss-note">各层只将有资料且系数大于 0 的项计入分子和分母，缺资料不补 0；无有效项时评分为未知。停车、道路可同时参与需求分和总分，将相应系数设为 0 可取消该层贡献。</p>
        <div class="siting-formula-controls">
          <fieldset v-for="group in formulaGroups" :key="group.key"><legend>{{ group.label }} · 内部系数</legend>
            <label v-for="field in group.fields" :key="field.key"><span>{{ field.label }}</span><input v-model.number="formulaWeights[group.key][field.key]" type="range" min="0" max="100" step="1" :aria-label="group.label+'：'+field.label+'系数'" /><output>{{ formulaWeights[group.key][field.key] }}</output></label>
          </fieldset>
        </div>
        <button class="pss-link" @click="resetFormula">恢复初始内部系数</button>
        <div v-if="selected && selectedCalculation" class="siting-formula-example" aria-label="评分计算示例">
          <b>网格 #{{ selected.id }} · 当前计算示例</b>
          <dl><div v-for="field in indicatorFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ fmt(selected.indicators[field.key],4) }}</dd></div></dl>
          <p>F快 = {{ fmt(selected.fast,4) }}，F普 = {{ fmt(selected.regular,4) }}</p>
          <p v-if="selectedCalculation.denominator">S = 100 × ({{ selectedCalculation.expression }}) / {{ selectedCalculation.denominator }} = <strong>{{ fmt(selected.score) }} 分</strong></p><p v-else>有效权重合计为 0，评分资料不足。</p>
        </div>
      </details>
    </section>

    <section class="pss-card siting-table-card" aria-label="候选位置决策表">
      <div class="pss-card-heading"><h3>地图编号 ↔ 候选位置</h3><div><button @click="constraintsOpen=!constraintsOpen">筛选与建站配置</button><button :disabled="!candidates.length" @click="exportRows">导出</button></div></div>
      <div class="siting-score-filter">
        <div class="siting-score-filter-heading"><label for="siting-minimum-score">最低偏好评分</label><output for="siting-minimum-score">≥ {{ minimumScore }} 分</output></div>
        <input id="siting-minimum-score" v-model.number="minimumScore" type="range" min="0" max="100" step="1" aria-label="最低偏好评分" :aria-valuetext="minimumScore+' 分及以上'" aria-describedby="siting-score-filter-summary" />
        <div class="siting-score-filter-scale"><span>0 分（包含零分）</span><span>100 分</span></div>
        <p id="siting-score-filter-summary" role="status" aria-live="polite">{{ loading ? '正在读取评分…' : `保留 ${candidates.length} 处，已过滤 ${screening.constrained.length-candidates.length} 处低分或评分不足的候选。` }}</p>
      </div>
      <label class="pss-field">候选优先顺序<select v-model="rankingMode" aria-label="候选优先顺序"><option value="need">优先补到附近无站的地点，再比到站距离</option><option value="preference">按选址偏好评分排序</option></select></label>
      <p class="siting-distance-caption">距现有站：从候选落点到该站的<b>直线间距</b>，不是导航里程。点站名可在地图查看连线。</p>
      <div class="siting-screen-summary">初筛 {{ screening.pool.length }} 处 → 间距 ≥ {{ radius }} m 后 {{ screening.spaced.length }} 处 → 建设条件筛选后 {{ screening.constrained.length }} 处 → 评分 ≥ {{ minimumScore }} 分后 {{ candidates.length }} 处</div>
      <div class="pss-table-wrap">
        <table ref="candidateTable" class="pss-table siting-candidate-table">
          <thead><tr><th>候选位置</th><th>偏好评分 / 相对默认</th><th>同样配置建在这里的作用</th><th>距最近现有站</th><th>方案</th></tr></thead>
          <TransitionGroup name="siting-rank" tag="tbody">
            <tr v-for="row in candidates" :key="row.id" :data-grid-id="row.id" :class="{'pss-row-planned':planned(row),'siting-row-selected':row.id===selectedId,'siting-row-changed':adjusted && Math.abs(row.scoreDelta || 0)>=.005}">
              <td class="siting-location-cell">
                <button class="siting-location" :aria-label="'查看候选位置 '+row.id" @click="chooseRow(row)">
                  <span class="siting-rank-number">{{ row.rank }}</span>
                  <span><b>{{ row.areaName }}</b><small>{{ row.address || '点击查看地图位置与范围' }}</small><em>网格 #{{ row.id }} <strong v-if="adjusted" :class="{'delta-up':row.rankChange>0,'delta-down':row.rankChange<0}">{{ rankLabel(row.rankChange) }}</strong></em></span>
                </button>
              </td>
              <td class="siting-score-cell" data-label="评分">
                <div :key="revision" class="siting-score" :class="[tone(row),{'score-updated':adjusted}]"><strong>{{ fmt(row.score) }}</strong><span class="siting-score-track"><i :style="{width:Math.max(0,row.score || 0)+'%'}"></i></span></div>
                <span class="siting-score-delta" :class="{'delta-up':row.scoreDelta>=.005,'delta-down':row.scoreDelta<=-.005}">{{ adjusted ? deltaLabel(row.scoreDelta) : '初始评分' }}</span>
              </td>
              <td class="siting-demand-cell" data-label="补点价值">
                <b>{{ impactLabel(row) }}</b><small style="display:block">原来无站变有站 {{ fmt(reviews.get(row.id)?.impact?.newlyReachableShare,1) }}%</small><small style="display:block">平均到站缩短 {{ fmt(reviews.get(row.id)?.impact?.averageSavedMeters,0) }} m</small><small>{{ reviews.get(row.id)?.feasibility.status==='fail'?'条件有不满足项':'建设资料待核查' }}</small>
              </td>
              <td class="siting-nearest-cell" data-label="距最近现有站">
                <button v-if="row.nearestStation" class="siting-nearest" @click="chooseRow(row)"><b>约 {{ Math.round(row.nearestMeters) }} m</b><span>{{ row.nearestStation.properties.name || '未命名站点' }}</span><small>{{ row.nearestStation.properties.isSynthetic ? '虚拟演示站 · 直线参考' : '现有站点 · 直线参考' }}</small></button>
                <span v-else>当前数据范围无可用参照站</span>
              </td>
              <td class="siting-actions-cell">
                <button class="siting-review-link" @click="reviewRow(row)">评估此处</button>
                <button class="pss-plan-toggle" :disabled="loading || !planned(row) && (!validSpec || row.score==null || conflicts(row) || reviews.get(row.id)?.feasibility.status==='fail')" :title="conflicts(row) ? '与已有方案点位不满足当前最小间距' : ''" :aria-label="(planned(row)?'移除规划网格 ':'纳入规划网格 ')+row.id" @click="emit('toggle-candidate',{row,spec})">{{ planned(row)?'✓ 已纳入':conflicts(row)?'间距不足':'＋ 纳入' }}</button>
                <button class="siting-review-link" @click="detailId=row.id;factorsOpen=true">核查资料</button>
              </td>
            </tr>
          </TransitionGroup>
        </table>
      </div>
      <p v-if="!candidates.length" class="pss-empty">{{ loading ? '正在读取数据库…' : `暂无评分达到 ${minimumScore} 分且满足约束的候选，可调低最低评分、调整间距或补充评分与建设资料。` }}</p>
      <div class="pss-batch"><label>批量上限 <input v-model.number="batchSize" type="number" min="1" max="20" aria-label="批量候选上限" /></label><button class="pss-primary" :disabled="loading || !validSpec || !batch.length || !hasScoringWeight" @click="emit('add-candidates',{rows:batch,spec})">按顺位纳入 {{ batch.length }} 个候选</button></div>
      <p class="pss-note">候选点是网格内估计位置，周边地点用于辨认区域；不代表该小区或商场已同意建设。批量操作校核新点彼此及与草稿点的间距。</p>
    </section>

    <section v-if="selectedCandidate" ref="assessmentEl" class="pss-card" aria-label="当前候选影响评估"><h3>{{ selectedCandidate.areaName }} · 单点预评估</h3><PlanningImpactReport :impact="selectedImpact" :feasibility="reviews.get(selectedCandidate.id)?.feasibility" compact @focus-place="emit('focus-place',$event)" @focus-station="emit('focus-station',$event)" /><button @click="factorsOpen=true">补充此区域建设资料</button></section>

    <details class="pss-card siting-constraints" :open="constraintsOpen" @toggle="constraintsOpen=$event.target.open">
      <summary>空间约束与拟建站配置 <span>现有站 {{ stations.length }} 个 · 间距 {{ radius }} m</span></summary>
      <div class="siting-settings-grid">
        <label class="pss-field">站点数据范围<select v-model="scope" aria-label="选址站点范围" @change="emit('set-scope',scope)"><option value="recorded">已记录点位（排除虚拟站）</option><option value="all">含虚拟演示站点</option></select></label>
        <label class="pss-field">最小站间距（m）<input v-model.number="radius" type="number" min="0" max="3000" step="50" @change="emit('show-buffer',{visible:buffer,radius})" /></label>
        <label class="pss-check"><input v-model="buffer" type="checkbox" @change="emit('show-buffer',{visible:buffer,radius})" />在地图叠加间距参考圈</label>
        <label class="pss-check"><input v-model="onlyProblems" type="checkbox" />只看需求较高、站点较少的区域</label>
        <label class="pss-check"><input v-model="requireParking" type="checkbox" />只保留已填写公共停车场且泊位达标的网格</label>
        <label v-if="requireParking" class="pss-field">最少公共泊位<input v-model.number="minimumSpaces" type="number" min="1" step="1" /></label>
        <label class="pss-check"><input v-model="requireGrid" type="checkbox" />配变已知余量须满足拟建功率</label>
        <label v-if="requireGrid" class="pss-field">功率因数<input v-model.number="powerFactor" type="number" min=".1" max="1" step=".01" /></label>
        <label class="pss-field">充电类型<select v-model="chargeType"><option value="fast">快充</option><option value="regular">普通充电</option></select></label>
        <label class="pss-field">桩数<input v-model.number="pileCount" type="number" min="1" max="1000" step="1" /></label>
        <label class="pss-field">单桩功率 kW<input v-model.number="powerKw" type="number" min=".1" max="1000" step=".1" /></label>
      </div>
      <p class="pss-note">切换站点范围会重置草稿。间距为可调整情景假设，非当地法定标准；未知泊位或配变资料不能作为核查通过。</p>
    </details>

    <details class="pss-card siting-factors" :open="factorsOpen" @toggle="factorsOpen=$event.target.open">
      <summary>补充候选区域的建设与需求资料 <span>{{ selected?.areaName }}</span></summary>
      <label class="pss-field">资料填写网格<select :value="selected?.id" @change="detailId=$event.target.value"><option v-for="row in rows" :key="row.id" :value="row.id">{{ row.areaName }} · #{{ row.id }}</option></select></label>
      <p class="pss-note">数据库提供居民、商业及已采集的停车场、办公医教数量；停车场开放情况与可用泊位仍须核查。以下修改仅作为本机情景。</p>
      <div v-if="selected" class="siting-settings-grid"><label v-for="field in factorFields" :key="field.key" class="pss-field">{{ field.label }}<input :value="overrides[selected.id]?.[field.key] ?? selected.feature.properties[field.key] ?? ''" type="number" min="0" :max="field.max" :step="field.step" placeholder="资料待补充" :aria-label="field.label" @input="updateFactor(field,$event.target.value)" /></label></div>
      <div v-if="selected" class="siting-settings-grid"><label v-for="field in CONSTRUCTION_SURVEY_FIELDS" :key="field.key" class="pss-field">{{ field.label }}<select :value="overrides[selected.id]?.[field.key] == null ? '' : String(overrides[selected.id][field.key])" :aria-label="field.label" @change="updateSurvey(field.key,$event.target.value)"><option value="">待核查</option><option value="true">情景：满足</option><option value="false">情景：不满足</option></select></label><label class="pss-field">资料来源 / 核查备注<input :value="overrides[selected.id]?.constructionEvidence || ''" maxlength="300" @input="updateSurvey('constructionEvidence',$event.target.value)" /></label></div>
      <button v-if="selected" class="pss-link" @click="overrides={...overrides,[selected.id]:{}}">清除该区域的情景补充</button>
    </details>

    <details class="pss-card pss-method"><summary>比较依据与功能分工</summary><p>约束选址比较单个位置是否值得补、条件是否满足；方案推演把多个新增及移除站一起重新分配原有需求，检查分流、地点收益与合并建设约束。多个单点收益不能直接相加。</p><p>同配置补点排序依次比较：已知服务空白触达需求权重、加权距站缩短、偏好评分；明确不满足建设条件的位置靠后。若要按评分高低查看，请选择“按选址偏好评分排序”。需求指数是空间权重，非实测订单。1 km 直线是情景服务范围。</p><p>评分公式和当前系数见“调整选址偏好”中的“评分公式与参数”。调整系数改变偏好评分，不改变原始需求或补点收益；停车与配网等硬约束单独筛选。评分阈值是用户设定的筛选条件。</p></details>
  </section>
</template>
