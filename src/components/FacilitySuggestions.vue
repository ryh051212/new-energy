<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import UiIcon from './UiIcon.vue'
import TermHint from './TermHint.vue'
import PlannerScenarioAssessment from './PlannerScenarioAssessment.vue'
import PlanningImpactReport from './PlanningImpactReport.vue'
import { useFacilitySandbox } from '../composables/useFacilitySandbox.js'

const props = defineProps({ stations: { type: Array, default: () => [] }, features: { type: Array, default: () => [] },
  demandPois: { type: Array, default: () => [] }, boundary: Object, constructionFactors:Object,constructionOptions:Object,loading: Boolean, active: Boolean, locating: Boolean, locationError: String })
const emit = defineEmits(['preview', 'focus-point', 'focus-location', 'focus-place', 'locate', 'district'])
const { tool, stage, center, locationName, radiusMeters, dataScope, dataset, baseline, pointBaseline, comparisonMetric,
  additions, removedIds, selected, result, running, dirty, error, notice, preview,
  setLocation, useDistrict, select, add, removeAddition, toggleRemoval, updateSelected, mapClick, run, reset } = useFacilitySandbox(props)
const editorOpen = ref(false), resultEl = ref(null), requestedLocation = ref(false), settingsOpen = ref(false)
const savedPlans=ref([]),planName=ref(''),snapshotNotice=ref('')
const comparisonPlans=computed(()=>savedPlans.value.filter(item=>item.impact.contextKey===result.value?.planningImpact.contextKey&&item.scope===JSON.stringify([center.value,radiusMeters.value])))
function savePlan(){if(!result.value||dirty.value)return;const name=planName.value.trim()||'备选方案 '+(savedPlans.value.length+1);savedPlans.value=[...savedPlans.value.slice(-3),{name,impact:structuredClone(JSON.parse(JSON.stringify(result.value.planningImpact))),scope:JSON.stringify([center.value,radiusMeters.value]),piles:additions.value.reduce((sum,row)=>sum+row.properties.pileCount,0),kw:additions.value.reduce((sum,row)=>sum+row.properties.pileCount*row.properties.powerKw,0),removed:removedIds.value.length}];planName.value='';snapshotNotice.value='已保留本次结果；继续调整地图后重新分析，可对照备选。'}
watch(preview, value => emit('preview', value), { immediate: true })
watch(center, value => { if (value) { requestedLocation.value = false; focusLocation() } })
watch(radiusMeters, () => { if (center.value) focusLocation() })
watch(result, async value => { if (value) { await nextTick(); resultEl.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } })
const shownAssessment = computed(() => result.value && !dirty.value && stage.value === 'after' ? result.value.after : baseline.value)
const shownPoint = computed(() => result.value && !dirty.value ? stage.value === 'after' ? result.value.diagnostics.pointAfter : result.value.diagnostics.pointBefore : pointBaseline.value)
const metric = (value, digits = 1) => value == null ? '资料不足' : value.toFixed(digits)
const percent = value => value == null ? '资料不足' : value.toFixed(1) + '%'
const labels = { improved: '改善', worse: '下降', tradeoff: '有取舍', unchanged: '未明显改变', insufficient: '资料不足' }
const diagnostics = computed(() => result.value?.diagnostics)
const canEdit = computed(() => !running.value && !props.loading)
function focusLocation() { emit('focus-location', { center: center.value, radiusMeters: radiusMeters.value }) }
function locate() { requestedLocation.value = true; emit('locate') }
function district() { useDistrict(); emit('district') }
function edit(feature) { select(feature.properties.id); tool.value = 'add'; stage.value = 'after'; editorOpen.value = true; emit('focus-point', feature) }
function compareStage(value) { stage.value = value; tool.value = 'inspect' }
const updateNumber = (field, value) => updateSelected(field, value === '' ? null : Number(value))
function addCandidate({ row, spec }) {
  if (running.value || props.loading) return false
  const existing = additions.value.filter(feature => String(feature.properties.planningGridId) === row.id)
  if (existing.length) { existing.forEach(feature => removeAddition(feature.properties.id)); return true }
  return !!add(row.location.geometry.coordinates, { ...spec, name: `网格 #${row.id} 规划站`, planningGridId: row.id })
}
function setDataScope(value) { if (!running.value && ['recorded','all'].includes(value)) dataScope.value = value }
defineExpose({ mapClick, setLocation, addCandidate, setDataScope })
</script>

<template>
  <section class="right-card facility-suggestions local-planning" aria-label="设施布局模拟沙盘">
    <div class="right-heading"><span><UiIcon name="compass" :size="18" />方案推演</span></div>
    <p class="section-caption">检验整套建站方案：补到哪里、原站如何分流、哪些地点更近，以及建设条件是否满足。可保留备选，对比同基准结果。</p>
    <details class="planning-settings" :open="settingsOpen" @toggle="settingsOpen = $event.target.open">
    <summary><span>范围与数据</span><small>{{ center ? '定位周边' : '全区' }} · {{ dataScope === 'recorded' ? '已记录点位' : '含演示点位' }}</small></summary>
    <div class="local-location-actions" role="group" aria-label="模拟范围">
      <button :class="{ active: !center && tool !== 'locate' }" :disabled="!canEdit" @click="district">全区布局</button>
      <button :class="{ active: tool === 'locate' || center }" :disabled="!canEdit" @click="tool = 'locate'; stage = 'after'">{{ center ? '重选定位' : '地图选定位' }}</button>
      <button :disabled="!canEdit || locating" @click="locate">{{ locating ? '定位中…' : '当前位置' }}</button>
    </div>
    <div class="local-scope">
      <label v-if="center">周边半径<select v-model.number="radiusMeters" aria-label="周边分析半径" :disabled="running"><option :value="500">500 米</option><option :value="1000">1 公里</option><option :value="2000">2 公里</option><option :value="3000">3 公里</option><option :value="5000">5 公里</option></select></label>
      <label>站点数据<select v-model="dataScope" aria-label="分析数据范围" :disabled="running"><option value="recorded">已记录点位</option><option value="all">含演示点位</option></select></label>
    </div>
    <p class="local-note"><button v-if="center" class="scope-focus" @click="focusLocation">{{ locationName }} · {{ radiusMeters }} m <UiIcon name="locate" :size="12" /></button><span v-else>魏都区 · 全区需求评价</span></p>
    </details>
    <p v-if="requestedLocation && locationError" class="sandbox-error" role="alert">{{ locationError }}</p>
    <p v-if="error" class="sandbox-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="local-notice" role="status">{{ notice }}</p>
    <section v-if="shownPoint" class="local-current" aria-label="定位当前充电便利程度">
      <div class="local-current-metrics"><article><TermHint term="accessibleService" label="附近充电服务评分" /><strong>{{ metric(shownPoint.serviceIndex) }}</strong></article><article><TermHint term="backupService" label="主要站点退出后的服务评分" /><strong>{{ metric(shownPoint.backupIndex) }}</strong></article></div>
      <p v-if="shownPoint.mainStation && shownPoint.serviceIndex != null" class="local-note">服务依赖 {{ shownPoint.mainStation }}（{{ percent(shownPoint.dependenceShare) }}）；备用保障按该站退出试算。</p>
      <p v-else class="local-note">{{ shownPoint.serviceIndex == null ? '能力或需求资料不足，暂不能评估。' : '此定位暂未获得已知配置的模型服务。' }}</p>
      <p v-if="shownPoint.unknownCapacityStations || shownPoint.uncoveredByDemandModel || shownPoint.simulated" class="local-note">{{ shownPoint.unknownCapacityStations || shownPoint.uncoveredByDemandModel ? '部分站点能力或需求资料不足。' : '' }}{{ shownPoint.simulated ? '包含模拟能力。' : '' }}</p>
    </section>

    <div class="sandbox-toolbar" role="group" aria-label="沙盘点位编辑工具">
      <button :class="{ active: tool === 'add' }" :aria-pressed="tool === 'add'" :disabled="!canEdit" @click="tool = 'add'; stage = 'after'"><UiIcon name="plus" :size="14" />新增站点</button>
      <button :class="{ active: tool === 'remove' }" :aria-pressed="tool === 'remove'" :disabled="!canEdit" @click="tool = 'remove'; stage = 'after'"><UiIcon name="minus" :size="14" />减少站点</button>
      <button class="sandbox-reset" :disabled="!canEdit" @click="reset">重置</button>
    </div>
    <p class="sandbox-help">{{ tool === 'locate' ? '点击地图选定位；切换范围会重置方案。' : tool === 'inspect' ? '点击地图看结果，或继续调整站点。' : tool === 'add' ? '点击地图新增，点击橙色点编辑。' : '点击站点移除，红色点可恢复。' }}</p>
    <div class="sandbox-draft-summary">新增 {{ additions.length }} · 移除 {{ removedIds.length }}</div>
    <ul v-if="additions.length" class="sandbox-point-list" aria-label="新增点位列表"><li v-for="feature in additions" :key="feature.properties.id" :class="{ selected: selected?.properties.id === feature.properties.id }"><button class="sandbox-point-select" :disabled="running" @click="edit(feature)"><i></i><span>{{ feature.properties.name }}</span><small>{{ feature.properties.pileCount ?? '—' }} 桩</small></button><button class="sandbox-remove" :aria-label="'移除 ' + feature.properties.name" :disabled="running" @click="removeAddition(feature.properties.id)"><UiIcon name="close" :size="13" /></button></li></ul>
    <details v-if="selected" class="sandbox-parameters" :open="editorOpen" @toggle="editorOpen = $event.target.open"><summary>点位设置 · {{ selected.properties.pileCount ?? '—' }} 桩 / {{ selected.properties.powerKw ?? '—' }} kW</summary><fieldset :disabled="running"><label class="sandbox-name">名称<input :value="selected.properties.name" maxlength="60" aria-label="模拟点位名称" @input="updateSelected('name', $event.target.value)" /></label><label>分类<select :value="selected.properties.chargeType" aria-label="模拟充电分类" @change="updateSelected('chargeType', $event.target.value)"><option value="fast">快充</option><option value="regular">普通充电</option></select></label><label>桩数<input type="number" min="1" max="1000" step="1" :value="selected.properties.pileCount" aria-label="模拟桩数" @input="updateNumber('pileCount', $event.target.value)" /></label><label class="sandbox-name">单桩功率（kW）<input type="number" min="0.1" max="1000" step="0.1" :value="selected.properties.powerKw" aria-label="模拟单桩功率" @input="updateNumber('powerKw', $event.target.value)" /></label></fieldset></details>
    <div class="sandbox-run-row"><span role="status">{{ running ? '正在分析…' : result ? dirty ? '方案已修改' : '已分析当前方案' : '调整后查看对比' }}</span><button class="sandbox-run" :disabled="!canEdit" @click="run"><UiIcon name="chart" :size="15" />{{ running ? '分析中…' : '分析方案' }}</button></div>

    <section v-if="result" ref="resultEl" class="sandbox-result" aria-label="布局与便利程度对比">
      <p v-if="dirty" class="local-notice">结果待更新，请重新分析。</p>
      <template v-else>
        <div class="layout-stage-switch" role="group" aria-label="模拟前后地图切换"><button v-for="item in [{ id: 'before', label: '模拟前' }, { id: 'after', label: '模拟后' }]" :key="item.id" :aria-pressed="stage === item.id" :class="{ active: stage === item.id }" :disabled="running" @click="compareStage(item.id)">{{ item.label }}</button></div>
        <PlanningImpactReport :impact="result.planningImpact" @focus-place="emit('focus-place',$event)" @focus-station="emit('focus-place',$event)" />
        <section class="plan-alternatives" aria-label="备选方案对照"><h4>保留备选，对照位置价值</h4><div><input v-model="planName" aria-label="备选方案名称" placeholder="备选方案名称" maxlength="30" /><button @click="savePlan">保留当前结果</button></div><p class="local-note" role="status">{{ snapshotNotice || '保留结果后可继续移动或增减点位；只对照相同需求、站点基准及评价范围。' }}</p><div v-if="comparisonPlans.length" class="pss-table-wrap"><table class="local-comparison"><thead><tr><th>备选</th><th>新增 / 移除</th><th>原来无站变有站的需求比例</th><th>全区平均到站距离缩短</th><th>新站需求中原有服务区所占比例</th><th>建设</th></tr></thead><tbody><tr v-for="(plan,index) in comparisonPlans" :key="index"><th>{{ plan.name }}<button aria-label="删除备选结果" @click="savedPlans=savedPlans.filter(item=>item!==plan)">×</button></th><td>{{ plan.piles }} 桩 / {{ plan.kw }} kW<br />移除 {{ plan.removed }} 站</td><td>{{ percent(plan.impact.districtNewlyReachableShare) }}</td><td>{{ metric(plan.impact.districtSavedMeters,0) }} m</td><td>{{ percent(plan.impact.diversionShare) }}</td><td>{{ ({fail:'不满足',pending:'待核查','scenario-pass':'情景满足','no-new-sites':'无新增'})[plan.impact.construction.status] }}</td></tr></tbody></table></div><p v-if="savedPlans.length>comparisonPlans.length" class="local-note">其他备选的基准或范围已变化，未放在本次对照中。</p><p v-if="comparisonPlans.length" class="local-note">桩数、功率或移除配置不同会影响收益；比较位置时请保持配置相同。对照按全区同一份原始需求加权，避免各方案周边范围不同造成误判。</p></section>
        <details class="local-more"><summary>辅助服务指数与运营情景</summary>
        <PlannerScenarioAssessment :points="additions" :result="result" :dirty="dirty" />
        <table class="local-comparison"><thead><tr><th>评价</th><th>模拟前</th><th>模拟后</th></tr></thead><tbody>
          <tr v-if="center"><th><TermHint term="accessibleService" label="定位可达服务" /></th><td>{{ metric(diagnostics.pointBefore.serviceIndex) }}</td><td>{{ metric(diagnostics.pointAfter.serviceIndex) }}</td></tr>
          <tr v-if="center"><th><TermHint term="backupService" label="定位备用保障" /></th><td>{{ metric(diagnostics.pointBefore.backupIndex) }}</td><td>{{ metric(diagnostics.pointAfter.backupIndex) }}</td></tr>
          <tr><th><TermHint term="weakDemand" label="薄弱需求占比 ↓" /></th><td>{{ percent(diagnostics.before.weakDemandShare) }}</td><td>{{ percent(diagnostics.after.weakDemandShare) }}</td></tr>
          <tr><th><TermHint term="underservedService" label="薄弱端服务 ↑" /></th><td>{{ metric(diagnostics.before.underservedAccess) }}</td><td>{{ metric(diagnostics.after.underservedAccess) }}</td></tr>
          <tr><th><TermHint term="accessInequality" label="服务不均衡 ↓" /></th><td>{{ metric(diagnostics.before.inequality, 3) }}</td><td>{{ metric(diagnostics.after.inequality, 3) }}</td></tr>
        </tbody></table>
        <p v-if="diagnostics.partialCapacity" class="local-note">部分能力未知，以上仅比较已知配置。</p>
        <div v-if="diagnostics.candidates.length || diagnostics.removals.length" class="local-directions" aria-label="布局优化方向">
          <p v-if="diagnostics.candidates.length">补点试算优先比较：<button @click="emit('focus-place', diagnostics.candidates[0].feature)">{{ diagnostics.candidates[0].name }} <UiIcon name="locate" :size="12" /></button><small>同配置补 1 桩 / 60 kW，范围内加权服务预计 +{{ metric(diagnostics.candidates[0].estimatedGain) }} 分<span v-if="center">，此定位 +{{ metric(diagnostics.candidates[0].pointGain) }} 分</span>{{ diagnostics.candidates[0].fallback ? '；位置为网格估计点' : '' }}。</small></p>
          <p v-if="diagnostics.removals.length">减少试算优先核查：<button @click="emit('focus-point', diagnostics.removals[0].feature)">{{ diagnostics.removals[0].feature.properties.name || '未命名站点' }} <UiIcon name="locate" :size="12" /></button><small>单独撤去，范围内加权服务预计损失 {{ metric(diagnostics.removals[0].estimatedLoss) }} 分<span v-if="center">，此定位损失 {{ metric(diagnostics.removals[0].pointLoss) }} 分</span>；需核查运营。</small></p>
        </div>
        <details class="local-more"><summary>更多结果</summary>
          <label>地图底色比较什么<select v-model="comparisonMetric" aria-label="地图评价指标"><option value="service">充电服务评分变化（辅助）</option><option value="supply">需求与站点数量差距的变化</option></select></label>
          <button v-for="feature in result.changedPlaces.filter(item => item.properties.matchChange != null && item.properties.matchChange !== 0).slice(0, 5)" :key="feature.properties.id + ':' + feature.geometry.coordinates.join(',')" class="local-place-change" @click="emit('focus-place', feature)"><span>{{ feature.properties.name }}<small>可达服务 {{ metric(feature.properties.beforeMatch) }} → {{ metric(feature.properties.afterMatch) }}</small></span><UiIcon name="locate" :size="13" /></button>
          <p>采用 <a href="https://discovery.ucl.ac.uk/id/eprint/10215441/" target="_blank" rel="noopener noreferrer">Gaussian 2SFCA 可达性方法</a>：能力由附近需求共享，距离越远贡献越小。服务距离假设为 1 km 直线；蓝圈控制编辑和评价范围，圈外服务与需求竞争仍保留。</p>
          <p>前后固定同一基准，100 分不等于实际需求满足。{{ diagnostics.partialCapacity ? '部分站点能力未知，指标仅反映已知配置。' : '' }}{{ diagnostics.simulatedCapacity ? '能力含模拟参数。' : '' }}{{ diagnostics.fallbackDemandShare > 0 ? '部分需求使用网格估计点。' : '' }}补点只比较需求位置，选址条件待核查。</p>
        </details>
        </details>
      </template>
    </section>
    <details v-if="center && shownAssessment || removedIds.length" class="local-more"><summary>周边站点与移除清单</summary>
      <article v-for="row in (shownAssessment?.rows || []).slice(0, 12)" :key="row.id"><button class="local-station-focus" @click="emit('focus-point', row.feature)"><span><b>{{ row.name }}</b><small>{{ Math.round(row.distanceMeters) }} m · {{ row.blocked ? '不可用' : row.simulated ? '模拟站' : row.accessUnknown ? '待核实' : '候选站' }}</small></span></button><button v-if="row.feature.properties.dataSource !== 'sandbox'" class="local-station-toggle" :disabled="!canEdit" @click="toggleRemoval(row.id)">{{ removedIds.includes(row.id) ? '恢复' : '移除' }}</button></article>
      <button v-for="id in removedIds" :key="id" class="local-station-toggle" :disabled="!canEdit" @click="toggleRemoval(id)">恢复 {{ dataset.stations.find(feature => String(feature.properties.id) === id)?.properties.name || id }}</button>
    </details>
    <p class="local-note">模型估算<span v-if="result?.macro.containsDemoRecords || additions.length"> · 含模拟配置</span>；开放与排队待核实。</p>
  </section>
</template>

<style scoped>
.planning-settings{margin:0 0 16px;border:1px solid var(--line);border-radius:8px;padding:0 10px}.planning-settings summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;min-height:40px;font-size:11px;color:var(--ink-700)}.planning-settings summary::-webkit-details-marker{display:none}.planning-settings summary::after{content:'＋';color:var(--ink-400)}.planning-settings[open] summary::after{content:'−'}.planning-settings summary small{flex:1;text-align:right;font-size:10px;color:var(--ink-500)}.planning-settings[open]{padding-bottom:6px}.planning-settings[open] summary{margin-bottom:5px}
.local-directions{padding:8px 10px;background:var(--surface-muted);border-radius:8px;font-size:11px;line-height:1.8;color:var(--ink-600)}.local-directions p{margin:4px 0 9px}.local-directions p:last-child{margin-bottom:3px}.local-directions button{display:inline;max-width:100%;padding:0;border:0;background:none;color:var(--brand-600);font:inherit;text-align:left;overflow-wrap:anywhere}.local-directions small{display:block;color:var(--ink-500);font-size:10px}.local-current-metrics :deep(.term-label){font-size:11px}.local-more a{color:var(--brand-600)}
.scope-focus{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:var(--brand-600);font-size:10px}.local-more{margin:10px 0;font-size:10px;line-height:1.8;color:var(--ink-500)}.local-more summary{cursor:pointer;color:var(--ink-600)}.local-more label{display:flex;align-items:center;justify-content:space-between;margin:8px 0;gap:8px}.local-more select{border:1px solid var(--line);border-radius:5px;padding:5px;background:var(--surface);color:var(--ink-600);font-size:11px}.local-place-change{display:flex;align-items:center;gap:5px;width:100%;border:0;border-bottom:1px solid var(--line);padding:7px 0;background:none;color:var(--ink-700);font-size:11px;text-align:left}.local-place-change>span{flex:1}.local-place-change small{display:block;font-size:10px;color:var(--ink-500)}.local-more article{margin:7px 0}.local-current{padding:9px!important;margin:10px 0!important}.local-verdict{padding:9px!important}.local-location-actions button{font-size:10px!important}
.local-planning h4{margin:0 0 10px;font-size:13px;color:var(--ink-800)}
.local-location-actions,.local-scope,.sandbox-toolbar,.layout-stage-switch{display:flex;gap:6px}
.local-location-actions button{display:flex;align-items:center;justify-content:center;gap:5px;flex:1;padding:9px 5px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink-600);font-size:11px}
.local-location-actions button.active{border-color:var(--brand-200);background:var(--brand-50);color:var(--brand-600)}
.local-anchor{margin:10px 0;padding:10px;border:1px solid var(--brand-200);border-radius:10px;background:var(--brand-50)}.local-anchor button{display:flex;align-items:center;gap:8px;width:100%;padding:0;border:0;background:none;text-align:left;color:var(--brand-700)}.local-anchor span{flex:1;min-width:0}.local-anchor b{display:block;font-size:12px}.local-anchor small{display:block;font-size:10px;margin-top:4px}
.local-scope{margin:12px 0 7px}.local-scope label{flex:1;min-width:0;font-size:10px;color:var(--ink-500)}.local-scope select{display:block;width:100%;margin-top:5px;padding:8px 3px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:11px;color:var(--ink-700)}
.local-note,.local-empty,.sandbox-help{font-size:10px;line-height:1.8;color:var(--ink-500);margin:7px 0}.local-notice{font-size:10px;line-height:1.7;color:var(--brand-600);padding:8px;background:var(--brand-50);border-radius:7px}.sandbox-error{font-size:11px;line-height:1.7;color:#b91c1c}
.local-current{margin:15px 0;padding:12px;border:1px solid var(--line);border-radius:12px}.local-current-metrics{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:12px}.local-current-metrics article span,.local-current-metrics article>small{display:block;font-size:10px;line-height:1.7;color:var(--ink-500)}.local-current-metrics strong{display:block;font-size:21px;line-height:1.5;color:var(--brand-700);overflow-wrap:anywhere}.local-current-metrics strong small{font-size:11px;font-weight:400}
.sandbox-toolbar{padding:4px;border-radius:7px;background:var(--surface-muted)}.sandbox-toolbar button,.layout-stage-switch button{flex:1;display:flex;justify-content:center;align-items:center;gap:4px;padding:8px 2px;border:0;border-radius:5px;background:none;font-size:11px;color:var(--ink-500)}.sandbox-toolbar button.active,.layout-stage-switch button.active{background:var(--surface);color:var(--brand-600);box-shadow:var(--shadow-1)}.sandbox-toolbar .sandbox-reset{flex:0 0 40px}.sandbox-draft-summary{font-size:11px;color:var(--ink-600);margin:8px 0}
.sandbox-point-list{list-style:none;margin:7px 0;padding:0;max-height:150px;overflow:auto}.sandbox-point-list li{display:flex;align-items:center;margin-bottom:3px;padding:4px;border-radius:6px}.sandbox-point-list li.selected{background:var(--brand-50)}.sandbox-point-select{display:flex;align-items:center;gap:6px;flex:1;min-width:0;border:0;background:none;padding:5px 0;text-align:left;font-size:11px;color:var(--ink-700)}.sandbox-point-select i{width:7px;height:7px;border-radius:50%;background:#f59e0b;flex:none}.sandbox-point-select span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sandbox-remove{display:grid;place-items:center;padding:5px;border:0;background:none;color:var(--ink-500)}
.sandbox-parameters,.sandbox-removed-list{font-size:10px;color:var(--ink-500);line-height:1.8;margin:8px 0}.sandbox-parameters{padding:9px;background:var(--surface-muted);border:1px solid var(--line);border-radius:8px}.sandbox-parameters summary,.sandbox-removed-list summary{cursor:pointer;overflow-wrap:anywhere}.sandbox-parameters fieldset{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:0;margin:8px 0;border:0;min-width:0}.sandbox-parameters label{display:flex;flex-direction:column;gap:3px;min-width:0}.sandbox-name{grid-column:1/-1}.sandbox-parameters input,.sandbox-parameters select{box-sizing:border-box;min-width:0;width:100%;padding:7px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--ink-800);font-size:11px}.sandbox-existing,.sandbox-removed-list button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 0;font-size:11px;color:var(--ink-600)}.sandbox-existing span,.sandbox-removed-list span{flex:1;overflow-wrap:anywhere}.sandbox-existing button,.sandbox-removed-list button{border:0;background:none;color:var(--brand-600)}
.sandbox-run-row{display:flex;align-items:center;gap:8px;margin:12px 0}.sandbox-run-row>span{flex:1;font-size:10px;line-height:1.7;color:var(--ink-500)}.sandbox-run{display:flex;align-items:center;gap:4px;padding:10px;border:0;border-radius:8px;background:var(--brand-600);color:white;font-size:11px;white-space:nowrap}
.sandbox-result{margin:15px 0;padding-top:13px;border-top:1px solid var(--line);scroll-margin-top:12px}.local-verdict{margin-bottom:10px;padding:12px;border-radius:10px;background:var(--brand-50);color:var(--brand-700)}.local-verdict b{display:block;font-size:13px;line-height:1.6}.local-verdict small{display:block;margin-top:5px;font-size:10px;line-height:1.7}.local-verdict[data-verdict=worse],.local-verdict[data-verdict=tradeoff]{background:#fff5e8;color:#956025}.layout-stage-switch{padding:3px;border-radius:7px;background:var(--surface-muted)}
.local-comparison{width:100%;border-collapse:collapse;font-size:11px;line-height:1.8;margin:10px 0;font-variant-numeric:tabular-nums}.local-comparison th,.local-comparison td{padding:8px 3px;border-bottom:1px solid var(--line);text-align:right;color:var(--ink-600)}.local-comparison th:first-child{text-align:left;font-weight:500}.local-comparison thead th{font-weight:400;font-size:10px;color:var(--ink-500)}.local-comparison td:last-child{color:var(--brand-700);background:var(--brand-50)}.local-change{font-size:11px;line-height:1.8;color:var(--brand-700)}
.local-stations{padding-top:13px;border-top:1px solid var(--line)}.local-stations article{border-bottom:1px solid var(--line);padding:7px 0}.local-station-focus{display:flex;align-items:center;gap:7px;width:100%;padding:0;border:0;background:none;text-align:left;color:var(--ink-700)}.local-station-focus span{flex:1;min-width:0}.local-station-focus b{display:block;font-size:12px;overflow-wrap:anywhere}.local-station-focus small{display:block;font-size:10px;line-height:1.8;margin-top:3px;color:var(--ink-500)}.local-station-toggle{padding:5px 0;border:0;background:none;color:var(--brand-600);font-size:10px}.local-stations article.removed b{text-decoration:line-through;color:var(--ink-500)}button:disabled{opacity:.45;cursor:default}
@media(max-width:760px){.sandbox-parameters input,.sandbox-parameters select,.local-scope select{font-size:16px}.local-current-metrics strong{font-size:19px}.local-scope label:first-child{flex:.8}}
</style>

