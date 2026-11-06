<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { requestLocalSiting } from '../api/localSiting.js'
import { validateAnalysisLocation } from '../models/localChargingSimulation.js'
import { landuseLabel } from '../models/sitingContext.js'
import { showError } from '../../../shared/feedback/feedback.js'

const props=defineProps({ active:Boolean, disabled:Boolean, boundary:Object, additions:Array, removedIds:Array,
  factors:Object, constraints:Object, dataScope:String, scenarioId:String })
const emit=defineEmits(['change','confirm','focus'])
const center=ref(null), radius=ref(1000), label=ref('地图选择'), result=ref(null), selectedId=ref('')
const loading=ref(false), confirming=ref(false), error=ref(''), water=ref(20), fuel=ref(50)
let controller, revision=0
watch(error,value=>{if(value)showError(value,'周边选址未完成')})
const selected=computed(()=>result.value?.features.find(f=>f.properties.id===selectedId.value))
const parameters=computed(()=>({center:center.value,radiusMeters:radius.value,waterSetbackMeters:water.value,
  fuelSetbackMeters:fuel.value,additions:props.additions || [],removedIds:props.removedIds || [],
  factors:props.factors || {},constraints:props.constraints || {},dataScope:props.dataScope || 'recorded',
  scenarioId:props.scenarioId || 'weekday-day'}))
const snapshot=computed(()=>({center:center.value,radiusMeters:radius.value,features:result.value?.features || [],
  selectedId:selectedId.value,roadAnchor:selected.value?.properties.roadAnchor,active:props.active}))
watch(snapshot,value=>emit('change',value),{immediate:true})
function cancel(){revision++;controller?.abort();loading.value=false;confirming.value=false}
async function refresh(){
  cancel(); result.value=null;selectedId.value='';error.value=''
  if(!center.value || !props.active)return
  controller=new AbortController();const current=revision;loading.value=true
  try{
    const data=await requestLocalSiting(parameters.value,controller.signal)
    if(current!==revision)return
    result.value=data;selectedId.value=data.features[0]?.properties.id || ''
  }catch(failure){if(current===revision && failure.name!=='AbortError')error.value=failure.message}
  finally{if(current===revision)loading.value=false}
}
function search(coordinates,name='地图选择'){
  if(props.disabled)return false
  try{validateAnalysisLocation(coordinates,props.boundary)}catch(failure){error.value=failure.message;return false}
  center.value=[...coordinates];label.value=name;return true
}
function choose(id){if(result.value?.features.some(f=>f.properties.id===id))selectedId.value=id}
async function confirm(){
  if(!selected.value || loading.value || confirming.value || props.disabled)return
  controller?.abort();controller=new AbortController();const current=++revision;confirming.value=true;error.value=''
  try{
    const feature=await requestLocalSiting({...parameters.value,candidateId:selectedId.value},controller.signal,true)
    if(current===revision)emit('confirm',feature)
  }catch(failure){if(current===revision && failure.name!=='AbortError')error.value=failure.message}
  finally{if(current===revision)confirming.value=false}
}
function clear(){cancel();center.value=null;result.value=null;selectedId.value='';error.value=''}
watch(parameters,refresh,{deep:true})
watch(()=>props.active,active=>{if(active && center.value)refresh();else if(!active)cancel()})
onBeforeUnmount(()=>{cancel();emit('change',null)})
defineExpose({search,choose,clear})
</script>

<template>
  <section class="local-siting-search" aria-label="周边约束选址">
    <header><b>选择周边场地</b><button v-if="center" type="button" @click="clear">清除选区</button></header>
    <p class="siting-instruction">点击地图或搜索地点作为中心，筛选圈内场地；确认候选后才新增站点。</p>
    <label class="siting-radius">搜索半径<select v-model.number="radius" aria-label="候选搜索半径" :disabled="disabled"><option :value="500">500 米</option><option :value="1000">1 公里</option><option :value="1500">1.5 公里</option><option :value="2000">2 公里</option><option :value="3000">3 公里</option></select></label>
    <p v-if="center" class="siting-center">{{ label }} · {{ center.map(v=>v.toFixed(5)).join('，') }}<br>选区仅用于寻找候选，已有方案保留。</p>
    <p v-if="loading" role="status">正在核查道路、用地、水域与场地条件…</p>
    <button v-if="error" type="button" class="siting-error" @click="refresh">重新筛选周边场地</button>
    <template v-if="result">
      <p class="siting-count" role="status">圈内 {{ result.metadata.considered }} 处场地，{{ result.metadata.eligible }} 处进入初选<span v-if="result.metadata.eligible>12">（展示前 12 处）</span></p>
      <p v-if="!result.features.length">当前范围没有符合初筛条件的场地，请扩大半径或更换中心。</p>
      <ol class="local-candidate-list" aria-label="圈内可选场地">
        <li v-for="feature in result.features" :key="feature.properties.id"><button type="button" :aria-pressed="selectedId===feature.properties.id" @click="choose(feature.properties.id)"><i>{{ feature.properties.rank }}</i><span><b>{{ feature.properties.name }}</b><small>距中心 {{ feature.properties.distanceMeters }} m · 道路连接 {{ feature.properties.roadGapMeters }} m</small></span></button></li>
      </ol>
      <article v-if="selected" class="local-candidate-detail">
        <header><b>{{ selected.properties.name }}</b><button type="button" @click="emit('focus',selected)">定位</button></header>
        <p>{{ selected.properties.landuse.map(landuseLabel).join('、') || '用地类型待核查' }} · {{ selected.properties.source || '场地目录' }}</p>
        <p>最近已有站：{{ selected.properties.nearestStationMeters==null ? '暂无记录' : selected.properties.nearestStationMeters+' m（直线）' }}</p>
        <ul><li v-for="check in selected.properties.checks" :key="check">{{ check }}</li></ul>
        <p v-for="warning in selected.properties.warnings" :key="warning" class="siting-warning">{{ warning }}</p>
        <button class="confirm-local-site" type="button" :disabled="loading || confirming || disabled" @click="confirm">{{ confirming ? '重新核查中…' : '确认此候选，加入方案' }}</button>
      </article>
      <details v-if="Object.keys(result.metadata.excluded).length"><summary>未进入初选的原因</summary><p v-for="(count,reason) in result.metadata.excluded" :key="reason">{{ reason }}：{{ count }} 处</p></details>
      <small>{{ result.metadata.order }}。{{ result.metadata.basis }}。</small>
    </template>
    <details class="local-siting-settings"><summary>周边筛选设置</summary><label>水边退让（m）<input v-model.number.lazy="water" type="number" min="0" max="200" aria-label="水边情景退让距离"></label><label>加油设施避让（m）<input v-model.number.lazy="fuel" type="number" min="0" max="300" aria-label="加油设施情景避让距离"></label><p>以上为可调整的初筛假设，不是法规安全距离。机动车连接上限 200 m；绿地、农业与特殊用地缺少许可依据时不进入初选。停车入口与配变点不会作为建站场地。</p></details>
  </section>
</template>

<style scoped>
.local-siting-search{margin:16px 0;padding:15px;border:1px solid #c8d9ec;border-radius:10px;background:#f8fbff;font-size:12px;color:#46546a;line-height:1.7}.local-siting-search header{display:flex;justify-content:space-between;gap:8px;align-items:center}.local-siting-search header>b{font-size:14px;color:#233a57}.local-siting-search header button,.siting-error button{border:0;background:none;color:#2563eb;font-size:11px;cursor:pointer}.siting-instruction,.siting-center{color:#64748b;font-size:11px}.siting-radius{display:flex;justify-content:space-between;align-items:center;gap:10px}.siting-radius select,.local-siting-settings input{padding:6px;border:1px solid #d6dfeb;border-radius:6px;background:white;color:#334155}.siting-count{color:#1e5d9a}.local-candidate-list{list-style:none;padding:0;margin:10px 0;max-height:230px;overflow:auto;display:grid;gap:6px}.local-candidate-list button{display:flex;gap:9px;align-items:center;width:100%;padding:9px;border:1px solid #dde6f0;border-radius:7px;background:white;color:#334155;text-align:left;cursor:pointer}.local-candidate-list button[aria-pressed=true]{border-color:#3978d0;background:#edf5ff}.local-candidate-list i{display:grid;place-items:center;flex:none;width:23px;height:23px;background:#dceaff;border-radius:50%;font-style:normal;color:#245b9f}.local-candidate-list b{font-size:12px;font-weight:550}.local-candidate-list small{display:block;font-size:10px;color:#64748b;margin-top:3px}.local-candidate-detail{background:white;border:1px solid #dce6f1;border-radius:8px;padding:12px;margin:12px 0}.local-candidate-detail p{font-size:11px;margin:7px 0}.local-candidate-detail ul{padding-left:17px;font-size:11px;color:#397258}.siting-warning{color:#946c25}.confirm-local-site{width:100%;padding:10px;border:0;border-radius:7px;background:#2865ae;color:white;font-size:12px;margin-top:10px;cursor:pointer}.local-siting-search details{margin-top:12px;font-size:11px}.local-siting-search summary{cursor:pointer;color:#547196}.local-siting-search>small{display:block;color:#75859a;font-size:10px;margin-top:10px}.local-siting-settings label{display:flex;justify-content:space-between;align-items:center;margin:8px 0}.local-siting-settings input{width:75px}.siting-error{color:#b42318}button:disabled{opacity:.5;cursor:default}
</style>
