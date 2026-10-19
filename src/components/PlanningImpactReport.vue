<script setup>
import { computed } from 'vue'
import { downloadPlanningCsv } from '../utils/plannerPss.js'
const props=defineProps({impact:Object,feasibility:Object,compact:Boolean})
const emit=defineEmits(['focus-place','focus-station'])
const labels={'gap-filled':'让原来附近无站的地点有站可选','closer':'部分地点到充电站更近了','more-options':'部分地点附近多了可选站址','redistribution':'主要分流原有站，出行收益有限','no-benefit':'未发现有效补点收益',tradeoff:'有些地点充电变远或失去附近站点',insufficient:'资料不足，暂不能判断'}
const checks={fail:'存在不满足项',pending:'建设资料待核查','scenario-pass':'已填情景条件满足','no-new-sites':'无新增站点'}
const pct=value=>value==null?'待判断':value.toFixed(1)+'%'
const meters=value=>value==null?'无可用参照':Math.round(value)+' m'
const distanceChange=value=>value==null?'无法比较':Math.abs(value)<1?'基本不变':(value>0?'缩短 ':'增加 ')+Math.round(Math.abs(value))+' m'
const stations=computed(()=>props.impact?.stationRows.filter(row=>row.added||Math.abs(row.change || 0)>1e-9||row.afterShare==null)||[])
const construction=computed(()=>props.impact?.construction)
function exportImpact(){
 const rows=[...stations.value.map(row=>['站点',row.name,row.beforeShare,row.afterShare,row.changeShare,'模型需求份额（%），非订单或用量']),
 ...props.impact.affectedPlaces.map(row=>['地点',row.properties.name,row.properties.beforeDistance,row.properties.afterDistance,row.properties.distanceSaved,'直线距离（m）'])]
 downloadPlanningCsv('建站影响核查.csv',['对象','名称','建设前','建设后','变化','口径'],rows)
}
</script>
<template>
 <section v-if="impact" class="impact-report" aria-label="建站必要性与周边影响">
  <div class="impact-verdict" :data-verdict="impact.verdict"><b>{{ labels[impact.verdict] }}</b><span v-if="compact">同一基准单独新增此站；桩数与功率保持一致。</span><span v-else>比较整个草稿的共同作用；移除和新增同时计入。</span></div>
  <div class="impact-metrics">
   <article><span>原来附近无站，现在有了</span><strong>{{ pct(impact.newlyReachableShare) }}</strong><small>占周边估计需求的比例 · 1 km 内</small></article>
   <article><span>到最近站的平均直线距离</span><strong>{{ distanceChange(impact.averageSavedMeters) }}</strong><small>同一批周边地点，前后比较</small></article>
   <article><span>到最近站缩短至少 50 m</span><strong>{{ pct(impact.shortenedShare) }}</strong><small>占周边估计需求的比例</small></article>
   <article><span>附近可选站址增至 2 处以上</span><strong>{{ pct(impact.moreChoicesShare) }}</strong><small>原来不足 2 处 · 1 km 内</small></article>
  </div>
  <p>以上比例按受调整站点 1 km 内的同一份需求加权；最近站直线距离用于比较地点，不能换算为实际行驶时间或排队改善。</p>
  <p v-if="impact.lostReachShare>0" class="impact-fail">有 {{ pct(impact.lostReachShare) }} 的周边需求失去已知配置站的 1 km 触达。</p>
  <p class="impact-origin" v-if="impact.newCatchmentWeight>0">新站分配到的模型需求：{{ pct(impact.fromGapShare) }} 来自原服务空白，{{ pct(impact.diversionShare) }} 来自原有站服务区，{{ pct(impact.uncertainOriginShare) }} 来源待判断。固定原需求重新分配，不代表新增订单或充电量。</p>
  <p v-else>新站未分配到已知模型需求；增加站点数量本身不作为改善结论。</p>
  <section v-if="feasibility" class="impact-construction" aria-label="候选建设条件"><h4>能否建设：{{ checks[feasibility.status] }}</h4><ul><li v-for="check in feasibility.checks" :key="check.id" :class="'impact-'+check.state"><b>{{ check.state==='pass'?'✓':check.state==='fail'?'×':'? ' }} {{ check.label }}</b><span>{{ check.detail }}</span></li></ul><p v-if="feasibility.evidence">资料备注：{{ feasibility.evidence }}</p></section>
  <section v-if="construction" class="impact-construction" aria-label="整套方案建设条件"><h4>能否建设：{{ checks[construction.status] }}</h4><details v-for="row in construction.rows" :key="row.feature.properties.id"><summary>{{ row.name }} · {{ checks[row.feasibility.status] }}</summary><p v-if="row.sharedGrid">同网格新增配置已合并核查泊位及配变容量。</p><ul><li v-for="check in row.feasibility.checks" :key="check.id" :class="'impact-'+check.state"><b>{{ check.label }}</b><span>{{ check.detail }}</span></li></ul></details></section>
  <p v-if="feasibility || construction">用地、出入口、消防、泊位及配变均按已载入资料或本机填写情景核查；缺项保留待核查，情景满足不等于获准施工。</p>
  <h4>哪些原有站可能被分流，分到新站多少</h4>
  <p>下表百分比：在全区估计充电需求中，模型分配给这个站的比例。</p>
  <div class="impact-table-wrap"><table><thead><tr><th>站点</th><th>建站前占比</th><th>建站后占比</th><th>占比变化</th></tr></thead><tbody><tr v-for="row in stations.slice(0,compact?5:20)" :key="row.id"><td><button @click="emit('focus-station',row.feature)">{{ row.added?'[拟建] ':'' }}{{ row.name }}</button></td><td>{{ pct(row.beforeShare) }}</td><td>{{ pct(row.afterShare) }}</td><td>{{ row.changeShare==null?'未知':(row.changeShare>0?'+':'')+row.changeShare.toFixed(2)+' 个百分点' }}</td></tr></tbody></table></div>
  <p v-if="!stations.length">未发现已知配置站的需求分配变化。</p>
  <p>站点份额以全区同一份原始需求为分母，按功率与距离分配，反映潜在分流；不能据此断言实际利用率、营收或拥堵变化。{{ impact.affectedExistingStations }} 个原有站的分配发生变化。</p>
  <h4>车主在哪些地点受益或受损</h4>
  <div class="impact-table-wrap"><table><thead><tr><th>地点</th><th>建站前距最近站</th><th>建站后距最近站</th></tr></thead><tbody><tr v-for="place in impact.affectedPlaces.slice(0,compact?5:20)" :key="place.properties.gridId+':'+place.geometry.coordinates.join(',')"><td><button @click="emit('focus-place',place)">{{ place.properties.name }}</button><small>{{ place.properties.newlyReachable?'附近从无站变为有站':place.properties.lostReach?'附近不再有站':place.properties.distanceSaved>1?'到站更近':place.properties.distanceSaved< -1?'到站更远':'附近多了可选站' }}{{ place.properties.fallback?' · 网格估计点':'' }}</small></td><td>{{ meters(place.properties.beforeDistance) }}</td><td>{{ meters(place.properties.afterDistance) }}</td></tr></tbody></table></div>
  <p v-if="!impact.affectedPlaces.length">未发现具体需求地点的距离或触达变化。</p>
  <p v-if="impact.partialCapacity">有 {{ impact.unknownBefore }} 个原有站能力未知，分流仅涉及已知配置；未知站附近的需求不冒充服务空白。</p>
  <p v-if="impact.simulatedCapacity || impact.fallbackGrids">{{ impact.simulatedCapacity?'含模拟站点配置。':'' }}{{ impact.fallbackGrids?'部分需求分布使用网格估计位置。':'' }}</p>
  <button v-if="!compact" class="impact-export" @click="exportImpact">导出全部受影响站点与地点</button>
 </section>
</template>
<style scoped>
.impact-report{font-size:11px;line-height:1.8;color:var(--ink-600);min-width:0}.impact-report h4{font-size:12px;margin:14px 0 6px;color:var(--ink-800)}.impact-report p{margin:7px 0;font-size:10px}.impact-report small{display:block;font-size:10px;color:var(--ink-500)}.impact-verdict{padding:10px;border-radius:8px;background:var(--brand-50);color:var(--brand-700)}.impact-verdict b,.impact-verdict span{display:block}.impact-verdict b{font-size:13px}.impact-verdict span{font-size:10px}.impact-verdict[data-verdict=redistribution],.impact-verdict[data-verdict=tradeoff],.impact-verdict[data-verdict=no-benefit]{background:#fff4e3;color:#8b5515}.impact-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}.impact-metrics article{padding:8px;border:1px solid var(--line);border-radius:7px}.impact-metrics span{display:block;font-size:10px}.impact-metrics strong{display:block;font-size:18px;color:var(--ink-800)}.impact-construction{padding:0 9px 8px;border:1px solid var(--line);border-radius:8px}.impact-construction summary{cursor:pointer}.impact-construction ul{list-style:none;padding:0;margin:6px 0}.impact-construction li{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--line);font-size:10px}.impact-construction li span{text-align:right}.impact-fail{color:#b94334}.impact-pending{color:#9b701c}.impact-table-wrap{overflow:auto;max-height:290px}.impact-report table{width:100%;border-collapse:collapse;font-size:10px}.impact-report th,.impact-report td{padding:6px 4px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}.impact-report th:first-child,.impact-report td:first-child{text-align:left}.impact-report button{border:0;background:none;padding:0;color:var(--brand-600);font:inherit;cursor:pointer;text-align:left}.impact-report .impact-export{padding:6px 10px;border:1px solid var(--line);border-radius:6px}
</style>
