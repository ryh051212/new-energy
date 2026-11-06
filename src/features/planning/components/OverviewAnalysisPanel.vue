<script setup>
import { computed, ref, watch } from 'vue'
import TemporalDemandChart from './TemporalDemandChart.vue'
import { stationOpenStatus } from '../../stations/models/stationOpenStatus.js'

const props = defineProps({
  grid: Object, population: Object, stations: { type: Array, default: () => [] },
  station: Object, temporal: Object, selection: { type: Object, required: true },
  loading: Boolean, error: String,
})
const emit = defineEmits(['close', 'select-station', 'selection-change', 'show-demand'])
const active = ref('demand')
const tabs = [
  { id: 'demand', label: '时段需求' },
  { id: 'area', label: '区域数据' },
  { id: 'stations', label: '充电站数据' },
]
const number = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—'
const field = value => number(value) === '—' ? '待接入' : number(value)
const typeLabel = value => ({ fast: '快充', regular: '普通充电' })[value] || '类型待核实'
const selectedStation = computed(() => props.station?.properties)
const stationStatus = computed(() => selectedStation.value ? stationOpenStatus(selectedStation.value) : null)
watch(() => props.station?.properties?.id, id => { if (id != null) active.value = 'stations' })
function show(tab) { if (tabs.some(item => item.id === tab)) active.value = tab }
function moveTab(event, index) {
  const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!offset && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length
  active.value = tabs[next].id
  event.currentTarget.parentElement.children[next].focus()
}
defineExpose({ show })
</script>

<template>
  <section class="overview-analysis" aria-label="地点分析详情">
    <header class="overview-detail-head">
      <div><small>{{ station ? '充电站' : '六边形区域' }}</small><h2>{{ station?.properties?.name || (grid ? `网格 #${grid.id}` : '区域详情') }}</h2><p>{{ grid ? `魏都区 · 网格 #${grid.id}` : '魏都区' }}</p></div>
      <button type="button" class="overview-detail-close" aria-label="关闭分析面板" @click="emit('close')">×</button>
    </header>
    <nav class="overview-analysis-tabs" role="tablist" aria-label="地点分析内容">
      <button v-for="(tab, index) in tabs" :id="`overview-${tab.id}-tab`" :key="tab.id" type="button" role="tab" :aria-selected="active === tab.id" :aria-controls="`overview-${tab.id}-panel`" :tabindex="active === tab.id ? 0 : -1" @click="show(tab.id)" @keydown="moveTab($event, index)">{{ tab.label }}</button>
    </nav>
    <div v-if="loading" class="overview-detail-page" role="status">正在加载区域资料…</div>
    <div v-else-if="error" class="overview-detail-page" role="status">{{ error }}</div>
    <div v-else :key="active" class="overview-detail-page" role="tabpanel" :id="`overview-${active}-panel`" :aria-labelledby="`overview-${active}-tab`">
      <template v-if="active === 'demand'">
        <div class="overview-detail-actions"><b>网格分时需求</b><button type="button" @click="emit('show-demand')">显示需求地图</button></div>
        <template v-if="grid && temporal">
          <div class="overview-detail-controls"><label>日期<select :value="selection.day" @change="emit('selection-change', { day: $event.target.value })"><option value="weekday">工作日</option><option value="weekend">周末</option></select></label><label>公共倾向<select :value="selection.scenario" @change="emit('selection-change', { scenario: $event.target.value })"><option value="low">低情景</option><option value="medium">中情景</option><option value="high">高情景</option></select></label></div>
          <label class="overview-detail-hour"><span>当前时段 <b>{{ String(selection.hour).padStart(2, '0') }}:00</b></span><input type="range" min="0" max="23" step="1" :value="selection.hour" aria-label="选择需求时间" @input="emit('selection-change', { hour: Number($event.target.value) })" /></label>
          <TemporalDemandChart :temporal="temporal" :selection="selection" />
          <p class="overview-detail-note">相对需求情景，用于地点与时段比较，不代表实测订单或电力负荷。</p>
        </template>
        <p v-else class="overview-detail-empty">当前地点没有可计算的网格需求资料。</p>
      </template>
      <template v-else-if="active === 'area'">
        <template v-if="grid"><div class="overview-area-cards"><article><span>模型人口</span><strong>{{ field(population?.populationModelCount) }}</strong><small>GHSL 2025 预测人数</small></article><article><span>人口密度</span><strong>{{ field(population?.populationModelDensity) }}</strong><small>人 / km²</small></article><article><span>格内站点</span><strong>{{ stations.length }}</strong><small>已记录地点</small></article><article><span>设施 POI</span><strong>{{ field(grid.facilityCount) }}</strong><small>地图采集记录</small></article></div>
          <h3>功能地点</h3><dl class="overview-area-list"><div v-for="[label, value] in [['住宅',grid.residentialCount],['工作',grid.workplaceCount],['商业',grid.shoppingCount ?? grid.commercialCount],['休闲',grid.leisureCount ?? grid.activityCount],['公共服务',grid.publicServiceCount]]" :key="label"><dt>{{ label }}</dt><dd>{{ field(value) }}</dd></div></dl>
          <p class="overview-detail-note">POI 数量不代表人口、到访人数或充电次数；模型人口尚未经本地统计校准。</p>
        </template><p v-else class="overview-detail-empty">当前地点没有关联的六边形区域。</p>
      </template>
      <template v-else>
        <article v-if="selectedStation" class="overview-station-selected"><span class="overview-station-tag">当前选中</span><h3>{{ selectedStation.name || '充电站' }}</h3><p>{{ selectedStation.address || '地址待补充' }}</p><dl><div><dt>类型</dt><dd>{{ typeLabel(selectedStation.chargeType) }}</dd></div><div><dt>开放状态</dt><dd>{{ stationStatus?.label }}</dd></div><div><dt>开放时间</dt><dd>{{ stationStatus?.hours || '待核实' }}</dd></div><div><dt>枪/桩数</dt><dd>{{ field(selectedStation.totalCount) }}</dd></div><div><dt>功率</dt><dd>{{ selectedStation.powerKw == null ? '待接入' : `${number(selectedStation.powerKw)} kW` }}</dd></div></dl><p class="overview-detail-note">{{ stationStatus?.note }}</p></article>
        <h3>区域内充电站 <small>{{ stations.length }} 处</small></h3>
        <p v-if="!stations.length" class="overview-detail-empty">当前网格没有已记录的充电站。</p>
        <div v-else class="overview-station-list"><button v-for="item in stations" :key="item.properties.id" type="button" :class="{ selected: String(item.properties.id) === String(selectedStation?.id) }" @click="emit('select-station', item)"><b>{{ item.properties.name || '未命名充电站' }}</b><small>{{ typeLabel(item.properties.chargeType) }} · {{ item.properties.address || '地址待补充' }}</small><span aria-hidden="true">›</span></button></div>
        <p class="overview-detail-note">位置来自站点记录；缺失的设备及运营字段保留待接入。</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.overview-analysis{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--ink-700);font-size:12px}.overview-detail-head{display:flex;justify-content:space-between;gap:10px;padding:16px 15px 12px;background:linear-gradient(120deg,#f1f5ff,#fff);border-bottom:1px solid var(--line)}.overview-detail-head small{color:var(--brand-600);font-weight:700}.overview-detail-head h2{margin:4px 0;font-size:17px;line-height:1.35;color:var(--ink-900)}.overview-detail-head p{margin:0;color:var(--ink-500);font-size:11px}.overview-detail-close{width:27px;height:27px;flex:none;border:0;border-radius:50%;background:#e9eef8;color:#52627b;font-size:20px;cursor:pointer}.overview-analysis-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:9px;border-bottom:1px solid var(--line)}.overview-analysis-tabs button{min-width:0;padding:9px 2px;border:0;border-radius:7px;background:transparent;color:var(--ink-500);font-size:11px;cursor:pointer}.overview-analysis-tabs button[aria-selected=true]{background:#eef2ff;color:#4338ca;font-weight:700}.overview-detail-page{flex:1;min-height:0;overflow:auto;padding:14px 15px 20px;scrollbar-width:thin}.overview-detail-actions{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.overview-detail-actions button{padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--brand-600);font:inherit;cursor:pointer}.overview-detail-controls{display:grid;grid-template-columns:1fr 1fr;gap:9px}.overview-detail-controls label{display:grid;gap:5px}.overview-detail-controls select{min-width:0;padding:7px 5px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink-700)}.overview-detail-hour{display:grid;gap:7px;margin:12px 0}.overview-detail-hour span{display:flex;justify-content:space-between}.overview-detail-hour b{color:var(--brand-600)}.overview-detail-hour input{width:100%;margin:0;accent-color:var(--brand-600)}.overview-area-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.overview-area-cards article{display:grid;gap:4px;padding:11px;border:1px solid var(--line);border-radius:9px;background:#f8fafc}.overview-area-cards strong{font-size:19px;color:var(--ink-900)}.overview-area-cards small,.overview-detail-note{font-size:10px;color:var(--ink-500);line-height:1.65}.overview-detail-page h3{margin:18px 0 9px;font-size:12px;color:var(--ink-800)}.overview-detail-page h3 small{font-weight:400;color:var(--ink-500)}.overview-area-list,.overview-station-selected dl{display:grid;gap:0;margin:0}.overview-area-list div,.overview-station-selected dl div{display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid var(--line)}.overview-area-list dt,.overview-station-selected dt{color:var(--ink-500)}.overview-area-list dd,.overview-station-selected dd{margin:0;font-weight:650;text-align:right}.overview-station-selected{padding:12px;border:1px solid #c7d2fe;border-radius:10px;background:#f8faff}.overview-station-selected h3{margin:6px 0!important;font-size:15px!important}.overview-station-selected>p{margin:5px 0;color:var(--ink-500);line-height:1.6}.overview-station-tag{font-size:10px;color:#4338ca;font-weight:700}.overview-station-list{display:grid;gap:6px}.overview-station-list button{display:grid;grid-template-columns:1fr auto;gap:4px 8px;width:100%;text-align:left;padding:10px;border:1px solid var(--line);border-radius:9px;background:#fff;cursor:pointer;color:var(--ink-800)}.overview-station-list button.selected{border-color:#818cf8;background:#f4f6ff}.overview-station-list small{grid-column:1;color:var(--ink-500);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.overview-station-list button span{grid-column:2;grid-row:1/3;align-self:center;font-size:20px;color:var(--brand-600)}.overview-detail-empty{padding:16px;border:1px dashed var(--line);border-radius:9px;color:var(--ink-500);line-height:1.8}.overview-analysis button:focus-visible,.overview-analysis select:focus-visible,.overview-analysis input:focus-visible{outline:2px solid var(--brand-400);outline-offset:2px}
</style>
