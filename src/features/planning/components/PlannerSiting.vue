<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { planningRows, planningRankChanges, screenPlanningRows, downloadPlanningCsv } from '../models/plannerPss.js'
import DemandScenarioControls from './DemandScenarioControls.vue'
import { SCENARIO_SCORE_WEIGHTS, FUNCTIONAL_ZONES, scoreScenarioRows, demandScenario } from '../models/functionalZones.js'
import { CONSTRUCTION_SURVEY_FIELDS } from '../models/stationPlanImpact.js'
import { assessSitingLocation, featuresInSitingScope } from '../models/sitingSelection.js'

const props = defineProps({
  features: { type:Array,default:()=>[] },stations: { type:Array,default:()=>[] },
  demandPois: { type:Array,default:()=>[] },points: { type:Array,default:()=>[] },
  baselineFeatures:{type:Array,default:()=>[]},scenarioId:{type:String,default:'weekday-day'},mapMode:{type:String,default:'zones'},
  loading:Boolean,dataScope:{type:String,default:'all'},bufferVisible:Boolean,selectedId:String,boundary:Object,
  selection:{type:Object,default:null},
})
const emit = defineEmits(['scenario-change','map-mode-change','focus-grid','send-candidate','show-buffer','open-simulation','set-scope','factors-change','candidates-change','construction-options','focus-place','focus-station','select-area','change-radius'])
const weights = ref({...SCENARIO_SCORE_WEIGHTS}), radius = ref(400), onlyProblems = ref(false)
const minimumScore = ref(1)
const formulaOpen = ref(false), zoneFilter = ref('all')
const requireParking = ref(false), requireGrid = ref(false), minimumSpaces = ref(15)
const minimumGridKva = ref(100)
const overrides = ref({}), detailId = ref(''), buffer = ref(false), scope = ref('all'), revision = ref(0)
const constraintsOpen = ref(false), factorsOpen = ref(false), settingsOpen = ref(false)
const candidateTable = ref(null),assessmentEl=ref(null)
function reviewRow(row){chooseRow(row);nextTick(()=>assessmentEl.value?.scrollIntoView({block:'start',behavior:'smooth'}))}
const factorFields = [
  {key:'officeCount',label:'原办公医教 POI 数（旧指标）',step:1},
  {key:'workplaceCount',label:'工作类 POI 数（办公 / 企业 / 园区）',step:1},
  {key:'shoppingCount',label:'购物类 POI 数',step:1},
  {key:'leisureCount',label:'休闲类 POI 数（餐饮 / 公园 / 文体）',step:1},
  {key:'publicServiceCount',label:'公共服务类 POI 数（医院 / 学校）',step:1},
  {key:'parkingCount',label:'停车场 POI 数（开放情况待核查）',step:1},
  {key:'roadIndex',label:'道路通达条件指数（0～1）',step:.01,max:1},
  {key:'parkingSpaces',label:'公共可用泊位数',step:1},
  {key:'availableKva',label:'可用配变余量（kVA）',step:1},
]
const weightFields = [
  {key:'demand',label:'当前场景需求',color:'#e88a28'},
  {key:'gap',label:'现有站服务间距',color:'#8563d9'},
  {key:'parking',label:'停车资源条件',color:'#169f83'},
  {key:'road',label:'道路通达条件',color:'#4081de'},
]
const scenarioLabel = computed(()=>demandScenario(props.scenarioId).label)
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
watch(weights,()=>{revision.value++},{deep:true})

const scopedFeatures = computed(()=>featuresInSitingScope(props.features,props.selection))
const spatialRows = computed(()=>planningRows(scopedFeatures.value,props.stations,overrides.value,undefined,props.demandPois))
const rows = computed(()=>scoreScenarioRows(spatialRows.value,weights.value))
const baselineFeatures = computed(()=>featuresInSitingScope(props.baselineFeatures.length ? props.baselineFeatures : props.features,props.selection))
const baselineSpatialRows = computed(()=>planningRows(baselineFeatures.value,props.stations,overrides.value,undefined,props.demandPois))
const baselineRows = computed(()=>scoreScenarioRows(baselineSpatialRows.value))
const screeningOptions = computed(()=>({
  radius:radius.value,onlyProblems:onlyProblems.value,requireParking:requireParking.value,
  minimumSpaces:minimumSpaces.value,minimumScore:minimumScore.value,
}))
const screening = computed(()=>{
  const pool=rows.value.filter(row=>(zoneFilter.value==='all' || row.functionalZone===zoneFilter.value)
    && assessSitingLocation(row.location.geometry.coordinates,{boundary:props.boundary,features:scopedFeatures.value,factors:overrides.value}).allowed)
  const result=screenPlanningRows(pool,screeningOptions.value)
  const gridAllowed=row=>!requireGrid.value || Number.isFinite(minimumGridKva.value) && minimumGridKva.value>=0
    && row.availableKva!=null && row.availableKva>=minimumGridKva.value
  return {...result,constrained:result.constrained.filter(gridAllowed),candidates:result.candidates.filter(gridAllowed)}
})
const constructionOptions=computed(()=>({radius:radius.value,minimumSpaces:requireParking.value?minimumSpaces.value:0,powerFactor:.9}))
watch(constructionOptions,value=>emit('construction-options',value),{immediate:true})
const candidates = computed(()=>{
  const shortlisted=screening.value.candidates,ids=new Set(shortlisted.map(row=>row.id))
  return planningRankChanges(shortlisted,baselineRows.value.filter(row=>ids.has(row.id)))
})
function conditionChecks(row){
  const survey={...row.feature.properties,...row.extra}
  return [
    ...CONSTRUCTION_SURVEY_FIELDS.map(field=>({label:field.label,value:survey[field.key]===true?'已填满足':survey[field.key]===false?'不满足':'待核查'})),
    {label:'公共可用泊位',value:row.parkingSpaces==null?'待核查':row.parkingSpaces+' 个'},
    {label:'可用配变余量',value:row.availableKva==null?'待核查':row.availableKva+' kVA'},
  ]
}
const conditionLabel=row=>conditionChecks(row).some(check=>check.value==='待核查')?'存在待核查资料':'已有条件资料'
watch(candidates,value=>emit('candidates-change',value),{immediate:true})
watch(()=>props.selection,()=>{detailId.value='';factorsOpen.value=false})
const selected = computed(()=>rows.value.find(row=>row.id===detailId.value))
const selectedCandidate = computed(()=>candidates.value.find(row=>row.id===selected.value?.id))
const selectedCalculation = computed(()=>{
  if(!selected.value)return null
  const values=selected.value.scenarioFactors
  const terms=weightFields.filter(field=>values[field.key]!=null && weights.value[field.key]>0)
  return {denominator:terms.reduce((sum,field)=>sum+weights.value[field.key],0),
    expression:terms.map(field=>`${weights.value[field.key]} × ${values[field.key].toFixed(4)}`).join(' + ')}
})
function updateSurvey(key,value){if(!selected.value)return;const next={...(overrides.value[selected.value.id] || {})};if(value==='')delete next[key];else next[key]=key==='constructionEvidence'?value.slice(0,300):value==='true';overrides.value={...overrides.value,[selected.value.id]:next}}
const available = computed(()=>Object.fromEntries(weightFields.map(field=>[field.key,rows.value.filter(row=>row.scenarioFactors[field.key]!=null).length])))
const missingLabels = computed(()=>weightFields.filter(field=>!available.value[field.key]).map(field=>field.label))
const hasScoringWeight = computed(()=>weightFields.some(field=>available.value[field.key] && weights.value[field.key]>0))
const effectiveWeight = key => {
  const total = weightFields.reduce((sum,field)=>sum+(available.value[field.key] ? weights.value[field.key] : 0),0)
  return available.value[key] && total ? Math.round(weights.value[key]/total*100) : 0
}
const adjusted = computed(()=>props.scenarioId!=='weekday-day' || weightFields.some(field=>available.value[field.key] && effectiveWeight(field.key)!==Math.round(SCENARIO_SCORE_WEIGHTS[field.key]/weightFields.reduce((sum,item)=>sum+(available.value[item.key] ? SCENARIO_SCORE_WEIGHTS[item.key] : 0),0)*100)))
const changedCount = computed(()=>candidates.value.filter(row=>row.scoreDelta!=null && Math.abs(row.scoreDelta)>=.005).length)
const movedCount = computed(()=>candidates.value.filter(row=>row.rankChange).length)
const largestChange = computed(()=>[...candidates.value].sort((a,b)=>Math.abs(b.scoreDelta || 0)-Math.abs(a.scoreDelta || 0))[0])
const fmt = (value,digits=2)=>value==null ? '—' : value.toFixed(digits)
const demandLabel = row=>fmt(row.feature.properties.scenarioDemandIndex==null ? null : row.feature.properties.scenarioDemandIndex*100,1)
const deltaLabel = value=>value==null ? '资料不足' : Math.abs(value)<.005 ? '评分未变' : (value>0?'＋':'−')+Math.abs(value).toFixed(2)+' 分'
const rankLabel = value=>value==null ? '暂无排名比较' : value>0 ? '↑ '+value+' 位' : value<0 ? '↓ '+Math.abs(value)+' 位' : '排名未变'
const tone = row=>row.score>=70 ? 'score-high' : row.score>=50 ? 'score-medium' : 'score-low'
const planned = row=>props.points.some(feature=>String(feature.properties.planningGridId)===row.id)
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
  downloadPlanningCsv('魏都区-约束选址-'+scenarioLabel.value+'.csv',
    ['时间场景','顺位','候选位置','网格','功能区','综合评分','相对工作日白天默认分差','场景需求指数','资料完整类别数','直线间距m','公共泊位','配变余量kVA','是否已纳入','活动系数（居住/工作/购物/休闲/公共）','综合权重（需求/间距/停车/道路）','选址资料状态'],
    candidates.value.map(row=>[scenarioLabel.value,row.rank,row.areaName,row.id,row.functionalZoneLabel,row.score,row.scoreDelta,row.feature.properties.scenarioDemandIndex,row.feature.properties.activityCompleteness,row.nearestMeters,row.parkingSpaces,row.availableKva,planned(row),
      Object.values(demandScenario(props.scenarioId).coefficients).join('/'),weightFields.map(field=>weights.value[field.key]).join('/'),conditionLabel(row)]))
}
</script>

<template>
  <section class="pss-workbench pss-siting" aria-label="约束过滤与多准则选址">
    <div class="siting-intro">
      <div><span class="pss-eyebrow">约束选址</span><h2>{{ selection ? '当前范围的网格候选参考' : '区域筛选参考（可选）' }}</h2><p>{{ '这里只生成网格代表点参考；地图点击新增始终使用原坐标。' }}</p></div>
      <button class="pss-primary" @click="emit('open-simulation')">返回点位编辑 →</button>
    </div>
    <div class="siting-panel-search"><slot name="area-search" /></div>
    <section v-if="!selection" class="siting-area-empty" aria-label="选择选址研究区域">
      <span class="siting-step-number">01</span><h3>需要比较一片区域时再启用</h3>
      <p>先定位一片地图，我们再比较附近的需求、站间距与建设条件。</p>
      <button class="pss-primary" :disabled="loading" @click="emit('select-area')">以当前视野中心筛选候选</button>
      <p>范围半径与间距是候选参考的筛选参数，不会移动你手动新增的站点。</p>
      <p class="siting-area-note">区外与已明确不满足场地条件的位置无法选择。其余位置仍需核查用地、泊位和配电资料。</p>
    </section>
    <template v-else>
    <section class="siting-area-selection" aria-label="当前选址范围">
      <div><span>已选研究位置</span><b>{{ selection.label }}</b><small>{{ selection.center.map(value=>value.toFixed(5)).join('，') }}</small></div>
      <button @click="emit('select-area')">重新选区</button>
      <label>周边范围<select :value="selection.radiusMeters" aria-label="选址分析半径" @change="emit('change-radius',Number($event.target.value))"><option :value="500">500 m</option><option :value="1000">1 km</option><option :value="1500">1.5 km</option><option :value="2000">2 km</option></select></label>
    </section>
    <div class="siting-overview-strip">
      <span>候选 <b>{{ loading ? '—' : candidates.length }}</b> 处</span>
      <span>评分变化 <b :class="{active:changedCount}">{{ changedCount }}</b> 处</span>
      <span>排名变化 <b :class="{active:movedCount}">{{ movedCount }}</b> 处</span>
      <span>方案新增 <b>{{ points.length }}</b> 站</span>
    </div>

    <section class="pss-card siting-table-card" aria-label="候选位置决策表">
      <div class="pss-card-heading"><h3>附近候选位置 · {{ scenarioLabel }}</h3><div><button @click="settingsOpen=!settingsOpen">选址设置</button><button :disabled="!candidates.length" @click="exportRows">导出</button></div></div>
      <div class="pss-table-wrap">
        <table ref="candidateTable" class="pss-table siting-candidate-table">
          <thead><tr><th>候选位置</th><th>综合评分 / 相对白天</th><th>选址条件</th><th>距最近现有站</th><th>下一步</th></tr></thead>
          <TransitionGroup name="siting-rank" tag="tbody">
            <tr v-for="row in candidates" :key="row.id" :data-grid-id="row.id" :class="{'pss-row-planned':planned(row),'siting-row-selected':row.id===selectedId,'siting-row-changed':adjusted && Math.abs(row.scoreDelta || 0)>=.005}">
              <td class="siting-location-cell">
                <button class="siting-location" :aria-label="'查看候选位置 '+row.id" @click="chooseRow(row)">
                  <span class="siting-rank-number">{{ row.rank }}</span>
                  <span><b>{{ row.areaName }}</b><small>{{ row.address || '点击查看地图位置与范围' }}</small><small class="siting-zone-tag">{{ row.functionalZoneLabel }} · 需求 {{ demandLabel(row) }} / 100 · 资料 {{ row.feature.properties.activityCompleteness }}/5</small><em>网格 #{{ row.id }} <strong v-if="adjusted" :class="{'delta-up':row.rankChange>0,'delta-down':row.rankChange<0}">{{ rankLabel(row.rankChange) }}</strong></em></span>
                </button>
              </td>
              <td class="siting-score-cell" data-label="评分">
                <div :key="revision" class="siting-score" :class="[tone(row),{'score-updated':adjusted}]"><strong>{{ fmt(row.score) }}</strong><span class="siting-score-track"><i :style="{width:Math.max(0,row.score || 0)+'%'}"></i></span></div>
                <span class="siting-score-delta" :class="{'delta-up':row.scoreDelta>=.005,'delta-down':row.scoreDelta<=-.005}">{{ adjusted ? deltaLabel(row.scoreDelta) : '初始评分' }}</span>
              </td>
              <td class="siting-demand-cell" data-label="选址条件"><b>{{ conditionLabel(row) }}</b><small style="display:block">公共泊位：{{ row.parkingSpaces==null?'待核查':row.parkingSpaces+' 个' }}</small><small style="display:block">配变余量：{{ row.availableKva==null?'待核查':row.availableKva+' kVA' }}</small></td>
              <td class="siting-nearest-cell" data-label="距最近现有站">
                <button v-if="row.nearestStation" class="siting-nearest" @click="chooseRow(row)"><b>约 {{ Math.round(row.nearestMeters) }} m</b><span>{{ row.nearestStation.properties.name || '未命名站点' }}</span><small>{{ row.nearestStation.properties.isSynthetic ? '虚拟演示站 · 直线参考' : '现有站点 · 直线参考' }}</small></button>
                <span v-else>当前数据范围无可用参照站</span>
              </td>
              <td class="siting-actions-cell">
                <button class="siting-review-link" @click="reviewRow(row)">查看选址依据</button>
                <button class="pss-plan-toggle" :disabled="loading || row.score==null" :aria-label="'用候选位置 '+row.id+' 推演'" @click="emit('send-candidate',row)">{{ planned(row)?'编辑已有站点 →':'使用此参考位置 →' }}</button>
                <button class="siting-review-link" @click="detailId=row.id;settingsOpen=true;factorsOpen=true">核查资料</button>
              </td>
            </tr>
          </TransitionGroup>
        </table>
      </div>
      <p v-if="!candidates.length" class="pss-empty">{{ loading ? '正在读取数据库…' : `暂无评分达到 ${minimumScore} 分且满足约束的候选，可调低最低评分、调整间距或补充评分与建设资料。` }}</p>
      <p class="pss-note">本页筛选候选位置。桩数、功率、增删站点与效果对比统一在方案推演中完成。</p>
    </section>

    <section v-if="selectedCandidate" ref="assessmentEl" class="pss-card siting-condition-card" aria-label="当前候选选址依据"><h3>{{ selectedCandidate.areaName }} · 选址依据</h3><p class="pss-note">{{ selectedCandidate.functionalZoneLabel }} · 场景需求 {{ demandLabel(selectedCandidate) }} / 100 · 距最近站 {{ selectedCandidate.nearestMeters==null?'待核查':Math.round(selectedCandidate.nearestMeters)+' m' }}</p><dl><div v-for="check in conditionChecks(selectedCandidate)" :key="check.label"><dt>{{ check.label }}</dt><dd>{{ check.value }}</dd></div></dl><div class="siting-handoff-actions"><button @click="settingsOpen=true;factorsOpen=true">补充核查资料</button><button class="pss-primary" @click="emit('send-candidate',selectedCandidate)">{{ planned(selectedCandidate)?'前往方案编辑 →':'用此位置推演 →' }}</button></div></section>

    <details class="pss-card siting-settings" :open="settingsOpen" @toggle="settingsOpen=$event.target.open">
      <summary>选址设置 <span>时间场景、评分、筛选与建设资料</span></summary>
    <DemandScenarioControls :scenario-id="scenarioId" :map-mode="mapMode" :features="scopedFeatures" @scenario-change="emit('scenario-change',$event)" @map-mode-change="emit('map-mode-change',$event)" />

    <details class="pss-card siting-weights" aria-label="权重调整与变化反馈">
      <summary>评分偏好与权重 <span>按需调整</span></summary>
      <div class="pss-card-heading"><h3>调整综合评分权重</h3><button @click="weights={...SCENARIO_SCORE_WEIGHTS}">恢复默认权重</button></div>
      <div class="siting-weight-grid">
        <label v-for="field in weightFields" :key="field.key" :class="{unavailable:!available[field.key]}" :style="{'--weight-color':field.color}">
          <span><i></i>{{ field.label }}<b>{{ effectiveWeight(field.key) }}%</b></span>
          <input v-model.number="weights[field.key]" type="range" min="0" max="100" step="5" :disabled="!available[field.key]" :aria-label="field.label+'权重'" />
          <small>{{ available[field.key] ? available[field.key]+' 个网格有可用资料' : '没有资料，暂未参与评分' }}</small>
        </label>
      </div>
      <div class="siting-weight-feedback" :class="{adjusted}" role="status" aria-live="polite">
        <template v-if="!hasScoringWeight"><b>暂无可用于评分的权重</b><span>请为至少一个有资料的因子设置大于零的权重；缺资料的因子可在下方补充。</span></template>
        <template v-else-if="adjusted"><b>{{ changedCount }} 处改分 · {{ movedCount }} 处排名变化</b><span v-if="largestChange">变化最大：{{ largestChange.areaName }}，{{ deltaLabel(largestChange.scoreDelta) }}。</span><span>对比工作日白天的默认权重，限当前候选集合；地图编号同步更新。</span></template>
        <template v-else><b>当前为工作日白天默认权重</b><span>参数可调整，不是官方评分标准。展开下方公式查看计算过程。</span></template>
      </div>
      <p v-if="missingLabels.length" class="siting-missing-note">{{ missingLabels.join('、') }}暂无资料，不计入本轮评分。<button @click="settingsOpen=true;factorsOpen=true">补充资料</button></p>
      <details class="siting-score-formula" :open="formulaOpen" @toggle="formulaOpen=$event.target.open">
        <summary>评分公式与参数（可调整）</summary>
        <p class="pss-note">综合评分 S = 100 × Σ（有效指标 × 对应权重）÷ Σ有效权重。初始权重：场景需求 50、现有站服务间距 25、停车资源 15、道路条件 10，均为可调整的情景设置。</p>
        <p class="pss-note">场景需求来自五类活动与时间系数；服务间距为 min（最近可用站直线距离 / 1000 m，1），当前无可用站时为 1；停车为 POI 数 / 当前范围最大数量；道路为补充的 0～1 指数。未知项不参与平均；需求未知时不评分，已知需求为零时得分为零。</p>
        <p class="pss-note">需求分值用于候选位置的综合评分。泊位、配网、场地、消防等建设条件另行核查；停车 POI 多不代表有可建设泊位。</p>
        <div v-if="selected && selectedCalculation" class="siting-formula-example" aria-label="评分计算示例">
          <b>网格 #{{ selected.id }} · {{ selected.functionalZoneLabel }} · {{ scenarioLabel }}</b>
          <dl><div v-for="field in weightFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ fmt(selected.scenarioFactors[field.key],4) }}</dd></div></dl>
          <p v-if="selected.scenarioFactors.demand===0">当前场景需求为 0，综合评分为 0；不会仅凭间距或停车资源获得高分。</p><p v-else-if="selected.score!=null && selectedCalculation.denominator">S = 100 × ({{ selectedCalculation.expression }}) / {{ selectedCalculation.denominator }} = <strong>{{ fmt(selected.score) }} 分</strong></p><p v-else>需求或有效权重资料不足，暂不评分。</p>
        </div>
      </details>
    </details>

      <div class="siting-score-filter">
        <div class="siting-score-filter-heading"><label for="siting-minimum-score">最低综合评分</label><output for="siting-minimum-score">≥ {{ minimumScore }} 分</output></div>
        <input id="siting-minimum-score" v-model.number="minimumScore" type="range" min="0" max="100" step="1" aria-label="最低综合评分" :aria-valuetext="minimumScore+' 分及以上'" aria-describedby="siting-score-filter-summary" />
        <div class="siting-score-filter-scale"><span>0 分（包含零分）</span><span>100 分</span></div>
        <p id="siting-score-filter-summary" role="status" aria-live="polite">{{ loading ? '正在读取评分…' : `保留 ${candidates.length} 处，已过滤 ${screening.constrained.length-candidates.length} 处评分或建设条件不满足的候选。` }}</p>
      </div>
      <label class="pss-field">功能区筛选<select v-model="zoneFilter" aria-label="功能区筛选"><option value="all">全部功能区</option><option v-for="zone in FUNCTIONAL_ZONES" :key="zone.id" :value="zone.id">{{ zone.label }}</option></select></label>
      <p class="siting-distance-caption">距现有站：从候选落点到该站的<b>直线间距</b>，不是导航里程。点站名可在地图查看连线。</p>
      <div class="siting-screen-summary">初筛 {{ screening.pool.length }} 处 → 间距 ≥ {{ radius }} m 后 {{ screening.spaced.length }} 处 → 建设条件筛选后 {{ screening.constrained.length }} 处 → 评分 ≥ {{ minimumScore }} 分后 {{ candidates.length }} 处</div>
    <details class="pss-card siting-constraints" :open="constraintsOpen" @toggle="constraintsOpen=$event.target.open">
      <summary>候选筛选条件 <span>现有站 {{ stations.length }} 个 · 间距 {{ radius }} m</span></summary>
      <div class="siting-settings-grid">
        <label class="pss-field">站点数据范围<select v-model="scope" aria-label="选址站点范围" @change="emit('set-scope',scope)"><option value="recorded">已记录点位（排除虚拟站）</option><option value="all">含虚拟演示站点</option></select></label>
        <label class="pss-field">最小站间距（m）<input v-model.number="radius" type="number" min="0" max="3000" step="50" @change="emit('show-buffer',{visible:buffer,radius})" /></label>
        <label class="pss-check"><input v-model="buffer" type="checkbox" @change="emit('show-buffer',{visible:buffer,radius})" />在地图叠加间距参考圈</label>
        <label class="pss-check"><input v-model="onlyProblems" type="checkbox" />只看需求较高、站点较少的区域</label>
        <label class="pss-check"><input v-model="requireParking" type="checkbox" />只保留已填写公共停车场且泊位达标的网格</label>
        <label v-if="requireParking" class="pss-field">最少公共泊位<input v-model.number="minimumSpaces" type="number" min="1" step="1" /></label>
        <label class="pss-check"><input v-model="requireGrid" type="checkbox" />只保留配变余量达到阈值的区域</label>
        <label v-if="requireGrid" class="pss-field">最低配变余量（kVA）<input v-model.number="minimumGridKva" type="number" min="0" step="10" /></label>
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

    <details class="pss-card pss-method"><summary>比较依据与功能分工</summary><p>约束选址负责参考图层、区域筛选、位置评分与资料核查，不进行站点配置和建设前后模拟。位置评分是可调整的比较工具。</p><p>选择“用此位置推演”会把位置传入方案推演。已传入的位置会打开同一个站点，不会重复新增；桩数、功率、移除、覆盖与分流效果在那里统一编辑和比较。</p></details>
    </details>
    </template>
  </section>
</template>
