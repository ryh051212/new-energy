<script setup>
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { DEMAND_SCENARIOS, ACTIVITY_TYPES } from '../models/functionalZones.js'
import { createPlanningRequests } from '../api/roadPlanning.js'
import { showError } from '../../../shared/feedback/feedback.js'
import UiDrawer from '../../../shared/components/UiDrawer.vue'
import UiIcon from '../../../shared/components/UiIcon.vue'

const props = defineProps({ mode:String, scenarioId:String, activityWeights:Object, dataScope:String,
  additions:{type:Array,default:()=>[]}, removedIds:{type:Array,default:()=>[]}, factors:Object, constraints:Object, loading:Boolean, active:{type:Boolean,default:true} })
const emit = defineEmits(['scenario-change','weights-change','set-scope','result','map-change','apply-plan','focus-place'])
const threshold=ref(10), count=ref(5), piles=ref(1), power=ref(60), method=ref('mclp'), step=ref('edit')
const metric=ref('coverage'), stage=ref('before'), result=ref(null), experiments=ref(null), busy=ref(false), error=ref(''), stale=ref(false)
const experimentType=ref('methods'), experimentMode=ref('reoptimize'), imported=ref(null), fileInput=ref(null)
const drawer=ref('')
const scenarioLabel=computed(()=>DEMAND_SCENARIOS.find(s=>s.id===(props.scenarioId || 'weekday-day'))?.label || '当前需求情景')
watch(()=>props.active,active=>{if(!active)drawer.value=''})
watch(error,value=>{if(value)showError(value,'方案分析未完成')})
const requests=createPlanningRequests()
let requestVersion=0
const parameters=computed(()=>({scenarioId:props.scenarioId || 'weekday-day',activityWeights:props.activityWeights || {},dataScope:props.dataScope || 'recorded',
  thresholdMinutes:threshold.value,requestedCount:count.value,method:method.value,
  capacityScenario:{pileCount:piles.value,powerKw:power.value}, constraints:{radius:0,minimumSpaces:0,powerFactor:.9,...props.constraints},
  factors:props.factors || {},additions:props.mode==='overview'?[]:props.additions, removedIds:props.mode==='overview'?[]:props.removedIds,
  manualCandidates:props.mode==='overview'?[]:props.additions}))
const metrics=[['coveragePercent','需求加权覆盖','%'],['averageMinutes','平均到站（可达地点）',' 分钟'],['highDemandGapGrids','高需求缺口',' 格'],
  ['capacityIndex','容量情景服务指数',''],['weakest20Index','原最弱20%需求服务指数',''],['gini','容量服务不均衡','']]
const fmt=(value,unit='',digits=1)=>value==null?'—':Number(value).toFixed(digits)+unit
const change=(key,unit)=>{const v=result.value?.changes[key];return v==null?'—':(v>0?'+':'')+fmt(v,key==='coveragePercent'?' 个百分点':unit,key==='gini'?3:1)}
const labels={mclp:'MCLP 贪心',kmeans:'加权 K-means',demand:'高需求优先'}
const availableMetrics=computed(()=>props.mode==='overview'?['demand','coverage','time','gap','capacity']:['coverage','time','capacity','deltaCoverage','deltaMinutes','deltaCapacityIndex','gap','demand'])
const metricLabels={demand:'潜在需求',coverage:'道路时间覆盖',time:'最近站时间',gap:'需求—可达性缺口',capacity:'容量情景服务',deltaCoverage:'覆盖变化',deltaMinutes:'出行时间变化',deltaCapacityIndex:'容量服务变化',none:'关闭研究专题'}
function refreshMap(){emit('map-change',{metric:metric.value,stage:stage.value});emit('result',stale.value?null:result.value)}
function invalidate(){requestVersion++;requests.cancel();busy.value=false;stale.value=true;experiments.value=null;refreshMap()}
watch(parameters,invalidate,{deep:true})
watch(()=>props.mode,()=>{step.value='edit';result.value=null;stage.value='before';invalidate()})
watch([metric,stage],refreshMap)
onBeforeUnmount(()=>{requests.cancel()})
function cancelAnalysis(){requestVersion++;requests.cancel();busy.value=false}
async function calculate(operation,override){
  if(props.loading||busy.value)return
  const version=++requestVersion
  busy.value=true;error.value=''
  const input=override || {...parameters.value,experimentType:experimentType.value,experimentMode:experimentMode.value}
  try {
    const data=await requests.run(operation,input)
    if(!data)return
    if(operation==='experiments')experiments.value=data
    else {result.value=data;stale.value=false;imported.value=null;stage.value=props.mode==='overview'?'before':'after';if(props.mode!=='overview'&&(operation==='optimize'||input.additions?.length||input.removedIds?.length))step.value='evaluate';refreshMap()}
  } catch(failure){if(version===requestVersion&&failure.name!=='AbortError')error.value=failure.message}
  finally {if(version===requestVersion)busy.value=false}
}
function applyPlan(data=result.value){
  if(!data)return
  emit('apply-plan',{features:data.selectedStations.features,removedIds:data.parameters?.removedIds || [],parameters:data.parameters})
  step.value='edit'
}
function exportJson(){
  const data={...result.value,parameters:{...result.value.parameters,baselineKey:result.value.baselineKey,additions:result.value.selectedStations.features},experiments:experiments.value}
  download('魏都区道路规划方案.json',JSON.stringify(data,null,2),'application/json')
}
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function exportCsv(){
  const rows=[['方案','方法','需求场景','阈值min','申请站数','实际站数','等数量可比','现状覆盖%','方案覆盖%','变化百分点','方案平均时间min','容量服务指数','最弱20%服务指数','服务不均衡','路网版本']]
  for(const r of experiments.value?.rows || [])rows.push([r.label,labels[r.parameters.method],r.parameters.scenarioId,r.parameters.thresholdMinutes,r.parameters.requestedCount,r.selectedCount,r.comparable,r.before.coveragePercent,r.after.coveragePercent,r.changes.coveragePercent,r.after.averageMinutes,r.after.capacityIndex,r.after.weakest20Index,r.after.gini,r.versions.network])
  download('魏都区规划对比.csv','\ufeff'+rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n'),'text/csv;charset=utf-8')
}
async function readImport(event){try{
  const file=event.target.files[0];if(!file)return
  if(file.size>10*1024*1024)throw new Error('方案文件不能超过 10 MB')
  const data=JSON.parse(await file.text())
  if(data.modelVersion!=='road-planning-v1'||!data.parameters||!data.baselineKey||!Array.isArray(data.selectedStations?.features))throw new Error('不是有效的道路规划方案')
  imported.value=data;error.value=''
}catch(failure){error.value=failure.message}finally{event.target.value=''}}
async function restore(){
  const data=imported.value,p=data.parameters
  threshold.value=p.thresholdMinutes;count.value=p.requestedCount;method.value=p.method;piles.value=p.capacityScenario.pileCount;power.value=p.capacityScenario.powerKw
  emit('scenario-change',p.scenarioId);emit('weights-change',p.activityWeights);emit('set-scope',p.dataScope)
  await nextTick()
  calculate('analyze',{...p,baselineKey:data.baselineKey,additions:data.selectedStations.features})
}
function setWeight(key,value){emit('weights-change',{...props.activityWeights,[key]:Number(value)})}
defineExpose({calculate,busy})
</script>

<template>
  <section class="road-study" aria-label="道路覆盖与容量规划">
    <header class="road-heading">
      <div><small>道路覆盖与容量</small><h2>{{ mode==='overview'?'现状分析':'方案效果' }}</h2></div>
      <b :class="{'is-demo':dataScope==='all'}">{{ dataScope==='all'?'演示情景':'已记录站点' }}</b>
    </header>
    <div class="road-action-bar">
      <button class="road-primary" :disabled="loading||busy" :aria-busy="busy" @click="drawer='';calculate('analyze')"><UiIcon name="chart" :size="18" />{{busy?'正在分析…':mode==='overview'?'分析现状':'重新分析方案'}}</button>
      <button class="road-settings-trigger" :aria-expanded="drawer==='settings'" aria-label="打开道路分析设置" @click="drawer='settings'"><UiIcon name="settings" :size="17" /><span>参数</span></button>
    </div>
    <div class="road-context"><span>{{scenarioLabel}}</span><span>{{threshold}} 分钟道路范围</span></div>
    <div v-if="busy" class="road-state road-running" role="status"><span>正在计算道路覆盖与容量…</span><button type="button" @click="cancelAnalysis">取消分析</button></div>
    <button v-if="error" class="road-error" type="button" @click="showError(error,'方案分析未完成')">分析未完成，查看详情</button>
    <p v-if="stale&&result" class="road-notice" role="status">方案已修改，重新分析后更新结果。</p>
    <template v-if="result&&!stale">
      <div v-if="mode!=='overview'" class="road-stage-switch" role="group" aria-label="比较新增前后"><button :class="{active:stage==='before'}" :aria-pressed="stage==='before'" @click="stage='before'">新增前</button><button :class="{active:stage==='after'}" :aria-pressed="stage==='after'" @click="stage='after'">新增后</button></div>
      <div class="road-highlights" aria-label="道路分析概要">
        <article><span>需求加权覆盖</span><strong>{{fmt(result[stage].coveragePercent,'%')}}</strong><small v-if="mode!=='overview'&&stage==='after'">较新增前 {{change('coveragePercent','%')}}</small><small v-else-if="mode!=='overview'">新增前基准</small><small v-else>{{threshold}} 分钟道路范围内</small></article>
        <article><span>平均到站（可达地点）</span><strong>{{fmt(result[stage].averageMinutes)}}<em>分钟</em></strong><small v-if="mode!=='overview'&&stage==='after'">变化 {{change('averageMinutes',' 分钟')}}</small><small v-else-if="mode!=='overview'">新增前基准</small><small v-else>不受 {{threshold}} 分钟覆盖限制</small></article>
      </div>
      <p v-if="result[stage].unreachableDemandPercent>0" class="road-notice">{{fmt(result[stage].unreachableDemandPercent,'%')}} 的估计需求未找到可达路线，平均时间按其余可达地点计算。</p>
      <label class="road-topic-label">地图显示<select v-model="metric"><option v-for="key in availableMetrics" :key="key" :value="key">{{metricLabels[key]}}</option><option value="none">关闭研究专题</option></select></label>
      <button class="road-entry" @click="drawer='details'"><span><strong>查看分析明细</strong><small>指标对比、受影响地点与数据质量</small></span><UiIcon name="arrow-right" :size="17" /></button>
      <div v-if="result.selection" class="road-selection-summary"><strong>{{labels[result.selection.method]}} · 推荐 {{result.selection.selectedCount}} 站</strong><p v-if="!result.selection.comparableCount" class="road-status">{{result.selection.stopReason==='no-marginal-benefit'?'进一步选站已无覆盖或时间收益。':'可行且可接入道路的候选不足。'}}未达到 {{result.selection.requestedCount}} 站。</p><button :disabled="busy" @click="applyPlan()">将结果替换为编辑草稿</button></div>
    </template>
    <div v-else-if="!busy" class="road-empty"><UiIcon name="chart" :size="28" /><p>点击上方按钮分析{{mode==='overview'?'现状':'当前方案'}}，查看道路覆盖与到站时间。</p></div>
    <div class="road-secondary-actions" v-if="mode!=='overview'"><button @click="drawer='settings'"><UiIcon name="compass" :size="15" />自动选址</button><button @click="drawer='tools'"><UiIcon name="file" :size="15" />实验与方案文件</button></div>
    <button v-else-if="$slots.reference" class="road-entry road-reference-entry" @click="drawer='reference'"><UiIcon name="layers" :size="17" /><span><strong>统计与辅助图层</strong><small>站点分布 · 盲点 · 最近站分区</small></span><UiIcon name="arrow-right" :size="17" /></button>

    <UiDrawer :open="drawer==='settings'&&active" title="分析参数" label="道路分析设置抽屉" close-label="关闭道路分析设置" eyebrow="效果评价" @close="drawer=''">
      <div class="road-drawer-content">
        <section class="road-setting-section"><h3>需求与评价范围</h3><div class="road-controls">
          <label>需求情景<select :value="scenarioId" :disabled="busy" @change="emit('scenario-change',$event.target.value)"><option v-for="s in DEMAND_SCENARIOS" :key="s.id" :value="s.id">{{s.label}}</option></select></label>
          <label>站点基准<select :value="dataScope || 'recorded'" :disabled="busy" @change="emit('set-scope',$event.target.value)"><option value="recorded">已记录站点</option><option value="all">含虚拟站的演示模式</option></select></label>
          <label>道路时间阈值（分钟）<input v-model.number="threshold" type="number" min="1" max="60" :disabled="busy" /></label>
        </div></section>
        <section v-if="mode!=='overview'" class="road-setting-section"><h3>自动选址</h3><div class="road-controls"><label>最多新增站数<input v-model.number="count" type="number" min="1" max="20" :disabled="busy" /></label><label>自动选址方法<select v-model="method" :disabled="busy"><option value="mclp">MCLP 贪心</option><option value="kmeans">加权 K-means</option><option value="demand">高需求优先</option></select></label></div><button class="road-primary" :disabled="loading||busy" @click="drawer='';calculate('optimize')">自动推荐站点</button></section>
        <details class="road-setting-section"><summary>活动权重与情景容量</summary><div class="road-controls"><label v-for="a in ACTIVITY_TYPES" :key="a.id">{{a.label}}活动权重<input :value="activityWeights?.[a.id]??1" type="number" min="0" max="5" step=".1" :disabled="busy" @change="setWeight(a.id,$event.target.value)" /></label><label>每站情景桩数<input v-model.number="piles" type="number" min="1" max="1000" :disabled="busy" /></label><label>单桩情景功率（kW）<input v-model.number="power" type="number" min=".1" max="1000" :disabled="busy" /></label></div></details>
        <details class="road-setting-section"><summary>计算依据</summary><p>OSM 路网按道路等级速度情景、单行和已知通行限制计算；不是实时路况。已有站统一采用以上容量假设，不覆盖真实设备记录。新站采用草稿配置，配置不同时单独标为配置调整情景。</p><p>G2SFCA 容量服务指数共用现状标尺；有现状服务时均值为 100，不是服务满足率。道路未接入与不可达分别保留；不以直线距离补出道路时间。权重与时间系数是情景参数。</p></details>
        <div class="road-drawer-footer"><button class="road-primary" :disabled="loading||busy" @click="drawer='';calculate('analyze')">{{mode==='overview'?'应用参数并分析现状':'应用参数并分析方案'}}</button><button v-if="mode==='overview'" @click="drawer='tools'">方案文件</button></div>
      </div>
    </UiDrawer>

    <UiDrawer :open="drawer==='reference'&&active" title="统计与辅助图层" label="统计与辅助图层抽屉" close-label="关闭统计与辅助图层" eyebrow="现状分析" @close="drawer=''">
      <div class="road-drawer-content"><slot name="reference" /></div>
    </UiDrawer>
    <UiDrawer :open="drawer==='details'&&active" title="分析明细" label="道路分析明细抽屉" close-label="关闭道路分析明细" eyebrow="效果评价" @close="drawer=''">
      <div class="road-drawer-content">
        <template v-if="result&&!stale">
          <section class="road-setting-section"><h3>新增前后对比</h3><div class="road-table"><table><thead><tr><th>评价指标</th><th>新增前</th><th>新增后</th><th>变化</th></tr></thead><tbody><tr v-for="[key,label,unit] in metrics" :key="key"><th>{{label}}</th><td>{{fmt(result.before[key],unit,key==='gini'?3:1)}}</td><td>{{fmt(result.after[key],unit,key==='gini'?3:1)}}</td><td>{{change(key,unit)}}</td></tr></tbody></table></div>
          <p v-if="result.before.unreachableDemandPercent>0||result.after.unreachableDemandPercent>0" class="road-notice">不可达需求：{{fmt(result.before.unreachableDemandPercent,'%')}} → {{fmt(result.after.unreachableDemandPercent,'%')}}。平均到站时间按可达地点需求加权，不受覆盖阈值限制；前后可达地点可能不同。</p><p class="road-status">{{result.capacityBasis==='uniform-scenario'?'统一容量情景':'配置调整情景'}} · 未接入需求点 {{result.quality.unconnectedDemandPoints}} · 网格估计点 {{result.quality.fallbackDemandPoints}}</p></section>
          <section v-if="result.selection" class="road-setting-section"><h3>{{labels[result.selection.method]}} · 推荐 {{result.selection.selectedCount}} / {{result.selection.requestedCount}} 站</h3><p v-if="!result.selection.comparableCount" class="road-notice">{{result.selection.stopReason==='no-marginal-benefit'?'覆盖和时间均无进一步收益，停止选站。':'可行且可接入道路的候选不足。'}}未达到目标站数，不能按同站数排名。</p><div class="road-table"><table><thead><tr><th>顺序 / 场地</th><th>本轮新增覆盖</th></tr></thead><tbody><tr v-for="(site,i) in result.selectedStations.features" :key="site.properties.id"><th><button @click="emit('focus-place',site)">{{i+1}} · {{site.properties.name}}</button><small>{{site.properties.feasibility==='scenario-pass'?'情景资料满足':'工程条件待核查'}}</small></th><td>{{fmt(result.selection.steps[i].coverageGainPoints,' 个百分点',2)}}</td></tr></tbody></table></div><button :disabled="busy" @click="applyPlan();drawer=''">将结果替换为编辑草稿</button></section>
          <details class="road-setting-section"><summary>缺口优先区域与地点变化</summary><div class="road-priorities"><button v-for="grid in result.priorities.slice(0,10)" :key="grid.properties.id" @click="emit('focus-place',grid)">网格 #{{grid.properties.id}} · 需求 {{fmt(grid.properties.scenarioDemandIndex,'',3)}} · 覆盖 {{fmt(grid.properties.beforeCoverage,'%')}}</button></div><div class="road-priorities"><button v-for="p in result.places.features.filter(p=>p.properties.beforeCovered!==p.properties.afterCovered||Math.abs(p.properties.timeSavedSeconds||0)>=1).slice(0,12)" :key="p.properties.id" @click="emit('focus-place',p)">{{p.properties.name}}：{{fmt(p.properties.beforeSeconds==null?null:p.properties.beforeSeconds/60,' 分钟')}} → {{fmt(p.properties.afterSeconds==null?null:p.properties.afterSeconds/60,' 分钟')}}</button></div></details>
          <details class="road-setting-section"><summary>路网质量与版本</summary><p>可路由有向边 {{result.quality.routableEdges}} / {{result.quality.inputEdges}} · 吸附上限 {{result.quality.maxSnapMeters}} m · 未接入站点 {{result.quality.unconnectedStations}}。</p><p>未明确通行属性的边 {{result.quality.accessUnspecifiedEdges}}，不能处理的转向限制 {{result.quality.unsupportedTurnRestrictions}}。OSM 未记录的限制不能视为已核实。</p><p>路网 {{result.versions.network}} · 候选池 {{result.versions.candidates}}</p></details>
          <div class="road-actions"><button @click="exportJson">{{mode==='overview'?'导出现状与参数 JSON':'导出完整方案 JSON'}}</button></div>
        </template><p v-else class="road-status">方案或参数已变化，请先重新分析。</p>
      </div>
    </UiDrawer>

    <UiDrawer :open="drawer==='tools'&&active" :title="mode==='overview'?'方案文件':'实验与方案文件'" label="道路分析工具抽屉" close-label="关闭道路分析工具" eyebrow="效果评价" @close="drawer=''">
      <div class="road-drawer-content">
        <section class="road-setting-section"><h3>方案文件</h3><div class="road-actions"><button :disabled="busy" @click="fileInput.click()">载入方案</button><input ref="fileInput" hidden type="file" accept=".json,application/json" @change="readImport" /><button v-if="imported" :disabled="busy" @click="drawer='';restore()">校验版本并复算载入方案</button><button v-if="result&&!stale" @click="exportJson">导出完整方案 JSON</button></div></section>
        <section v-if="mode!=='overview'" class="road-setting-section road-experiments"><h3>方法、数量与敏感性实验</h3><div class="road-controls"><label>对比内容<select v-model="experimentType"><option value="methods">高需求 / K-means / MCLP</option><option value="counts">新增 3 / 5 / 8 座</option><option value="thresholds">5 / 10 / 15 分钟</option><option value="scenarios">工作日白天 / 夜间 / 周末</option><option value="weights">居住活动权重 0.8 / 1 / 1.2</option></select></label><label>方案处理<select v-model="experimentMode" :disabled="['methods','counts'].includes(experimentType)"><option value="reoptimize">每个情景重新选址</option><option value="fixed">固定同一方案跨情景评价</option></select></label></div><button class="road-primary" :disabled="loading||busy" @click="experimentMode=['methods','counts'].includes(experimentType)?'reoptimize':experimentMode;calculate('experiments')">{{busy?'实验计算中…':'运行对比实验'}}</button><template v-if="experiments"><p>{{experiments.experimentMode==='fixed'?'固定方案评价':'各情景重新选址'}} · 共用候选池</p><div class="road-table"><table><thead><tr><th>情景</th><th>站数</th><th>覆盖变化</th><th>时间min</th><th>容量指数</th><th>最弱20%</th></tr></thead><tbody><tr v-for="(row,i) in experiments.rows" :key="i"><th>{{row.label}}<small v-if="!row.comparable">不参与等数量排名</small></th><td>{{row.selectedCount}}</td><td>{{fmt(row.changes.coveragePercent,' pp',2)}}</td><td>{{fmt(row.after.averageMinutes)}}</td><td>{{fmt(row.after.capacityIndex)}}</td><td>{{fmt(row.after.weakest20Index)}}</td></tr></tbody></table></div><div class="road-actions"><button @click="exportCsv">导出实验 CSV</button><button v-if="result" @click="exportJson">导出方案与完整实验</button></div></template></section>
        <details v-if="experiments?.stability?.length" class="road-setting-section"><summary>推荐点稳定性（{{experiments.experimentMode==='fixed'?'固定方案，出现次数不代表重选稳定性':'各情景重新选址'}}）</summary><div class="road-priorities"><p v-for="site in experiments.stability" :key="site.id">{{site.name}} · {{site.frequency}} / {{experiments.rows.length}} 次入选</p><p v-for="(row,i) in experiments.rows" :key="i">{{row.label}} 与首个情景的站址重合率：{{fmt(row.overlapWithFirst==null?null:row.overlapWithFirst*100,'%')}}</p></div></details>
      </div>
    </UiDrawer>
  </section>
</template>

<style scoped>
.road-study{padding:0;margin:0;min-width:0;color:#334155}.road-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px}.road-heading small{font-size:10px;color:#7b8799}.road-heading h2{font-size:21px;letter-spacing:-.5px;margin:6px 0 0;color:#26334a}.road-heading>b{font-size:10px;white-space:nowrap;padding:6px 9px;border-radius:99px;background:#eaf6ef;color:#237056}.road-heading>b.is-demo{background:#fff0d8;color:#a66c15}
:is(.road-study,.road-drawer-content) button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #dce4ed;background:#fff;color:#53617c;border-radius:12px;padding:10px 12px;font:inherit;font-size:11px;cursor:pointer;transition:background .16s,border-color .16s,box-shadow .16s}:is(.road-study,.road-drawer-content) button:hover:enabled{background:#f5f7ff;border-color:#bec9e4}:is(.road-study,.road-drawer-content) button:focus-visible{outline:2px solid #818cf8;outline-offset:3px}:is(.road-study,.road-drawer-content) button:disabled{opacity:.5;cursor:default}
.road-action-bar{position:sticky;top:0;z-index:2;display:flex;gap:8px;align-items:stretch;padding:8px 0;background:rgba(255,255,255,.96);backdrop-filter:blur(12px)}:is(.road-study,.road-drawer-content) .road-primary{min-height:44px;padding:12px 15px;border-color:#4f46e5;background:linear-gradient(135deg,#5b50ed,#4338ca);color:white;font-weight:650;box-shadow:0 5px 12px #4f46e522}:is(.road-study,.road-drawer-content) .road-primary:hover:enabled{background:linear-gradient(135deg,#5145e3,#3730a3);border-color:#4338ca}.road-action-bar>.road-primary{flex:1;font-size:13px}.road-action-bar>.road-settings-trigger{padding:10px 12px}.road-context{display:flex;flex-wrap:wrap;gap:5px 12px;margin:7px 0 18px;font-size:10px;color:#7a879a}.road-stage-switch{display:flex;gap:4px;padding:4px;margin:18px 0 12px;border:1px solid #e6eaf4;border-radius:14px;background:#f3f5fa}.road-stage-switch button{flex:1;border-color:transparent;background:transparent;padding:8px}.road-stage-switch button.active{color:#4f46e5;background:#fff;border-color:#e2e7f3;box-shadow:0 2px 6px #24315408}
.road-highlights{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0 18px}.road-highlights article{min-width:0;padding:16px 13px;background:linear-gradient(145deg,#f6f8ff,#fff);border:1px solid #e4e9f5;border-radius:17px}.road-highlights article>span{display:block;font-size:10px;color:#78859a}.road-highlights strong{display:flex;align-items:baseline;gap:4px;margin:12px 0 8px;font-size:27px;letter-spacing:-1px;color:#2d3f62;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.road-highlights em{font-size:10px;letter-spacing:0;font-weight:400;font-style:normal;color:#8792a3}.road-highlights article>small{display:block;font-size:9px;line-height:1.6;color:#688076;overflow-wrap:anywhere}
:is(.road-study,.road-drawer-content) label{display:grid;gap:7px;font-size:11px;color:#60708a;min-width:0}:is(.road-study,.road-drawer-content) input,:is(.road-study,.road-drawer-content) select{box-sizing:border-box;width:100%;min-width:0;padding:10px;font:inherit;color:#334155;background:white;border:1px solid #dce4ed;border-radius:11px}.road-topic-label{margin:15px 0}.road-entry{width:100%;justify-content:space-between!important;text-align:left;padding:14px!important;border-radius:15px!important}.road-entry>span{display:grid;gap:6px;min-width:0}.road-entry strong{font-size:12px;font-weight:600;color:#3f4e6c}.road-entry small{font-size:10px;line-height:1.6;color:#8792a5}.road-entry>svg{flex:none}.road-secondary-actions{display:flex;gap:8px;margin-top:16px}.road-secondary-actions button{flex:1;font-size:10px;padding:10px 8px}.road-empty{display:grid;justify-items:center;gap:8px;text-align:center;padding:28px 16px;border:1px dashed #dce4ee;border-radius:17px;background:#fafbfe;color:#94a0b5;margin:10px 0}.road-empty p{max-width:235px;font-size:11px;line-height:1.8}.road-selection-summary{padding:14px;border:1px solid #e2e9f3;border-radius:15px;margin-top:16px}.road-selection-summary>strong{font-size:12px}.road-selection-summary>button{width:100%;margin-top:13px}
:is(.road-study,.road-drawer-content) p{font-size:11px;line-height:1.8;overflow-wrap:anywhere}.road-state,.road-status{color:#7c8799}.road-state{padding:12px;background:#f4f5ff;border-radius:12px}.road-error{width:100%;color:#b43f39!important;background:#fff2f0!important;border-color:#f6d5d0!important}.road-notice{color:#946222;background:#fff8eb;padding:11px 12px;border-radius:12px}
.road-drawer-content{min-width:0;color:#334155;padding-top:16px}.road-setting-section{padding:15px;margin:0 0 13px;border:1px solid #e0e7f1;border-radius:16px;background:#ffffffb8}.road-setting-section h3{font-size:13px;margin:0 0 14px;color:#40516c}.road-setting-section summary{cursor:pointer;color:#52617b;font-size:12px;font-weight:600;line-height:1.8}.road-setting-section details{font-size:11px}.road-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px;margin:15px 0}.road-setting-section .road-controls:last-child{margin-bottom:0}.road-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}.road-drawer-footer{position:sticky;bottom:-24px;padding:15px 0 10px;background:linear-gradient(transparent,#f4f7fd 16%)}.road-drawer-footer>button{width:100%}
.road-table{overflow-x:auto;max-width:100%;margin:13px 0;border:1px solid #e5eaf2;border-radius:12px}.road-table table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}.road-table th,.road-table td{border-bottom:1px solid #e6edf3;padding:10px 8px;text-align:right;line-height:1.7;white-space:nowrap}.road-table th:first-child{text-align:left;white-space:normal;min-width:85px;font-weight:500}.road-table thead th{font-size:10px;color:#7b879a;background:#f8faff}.road-table td:last-child{color:#236d63}.road-table tr:last-child>td,.road-table tr:last-child>th{border-bottom:0}.road-table th>button{border:0;padding:0;text-align:left;background:none;border-radius:0}.road-table small{display:block;font-size:10px;color:#9b6d2e}.road-priorities{display:grid;gap:7px;margin:12px 0}.road-priorities button{text-align:left;justify-content:flex-start;overflow-wrap:anywhere}.road-experiments .road-controls{grid-template-columns:1fr}
@media(max-width:420px){.road-heading h2{font-size:19px}.road-action-bar>.road-primary{font-size:12px;padding:11px}.road-context{font-size:9px;gap:5px 9px}.road-highlights{gap:8px}.road-highlights article{padding:14px 10px}.road-highlights strong{font-size:24px}.road-highlights article>span{font-size:9px}.road-highlights article>small{font-size:9px}.road-controls{gap:10px}.road-setting-section{padding:12px}.road-drawer-content input,.road-drawer-content select{font-size:12px}.road-table th,.road-table td{font-size:10px;padding:8px 5px}.road-heading>b{font-size:9px}.road-secondary-actions button{font-size:9px;gap:5px}.road-drawer-content .road-controls{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){:is(.road-study,.road-drawer-content) button{transition:none}}
.road-running{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px}.road-running button{flex:none;padding:6px 10px;font-size:10px}.road-reference-entry{margin-top:16px}.road-reference-entry>svg{flex:none;color:#7b86a0}.road-reference-entry>span{flex:1}.road-study .road-empty{display:flex;align-items:center;gap:14px;padding:20px 16px;border:1px dashed #dce2f0;background:#f8faff;border-radius:16px;text-align:left}.road-empty>svg{flex:none;color:#8b90b7}.road-study .road-empty p{margin:0;font-size:11px;line-height:1.8;color:#7c879d}
</style>
