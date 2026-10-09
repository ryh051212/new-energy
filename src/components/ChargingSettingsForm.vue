<script setup>
import { ref, computed } from 'vue'
import { normalizeTripContext } from '../utils/tripCharging.js'
import { DESTINATION_CATEGORIES, destinationCatalog, filterDestinations, normalizeDestinationInfo } from '../utils/destinations.js'
import { normalizeIntent } from '../utils/chargingSettings.js'
import UiIcon from './UiIcon.vue'
import DestinationPicker from './DestinationPicker.vue'
const props = defineProps({ context: Object, intent: String, places: Array, destinationInfo: Object })
const emit = defineEmits(['save'])
const draft = ref({ ...normalizeTripContext(props.context) })
const vehicleInitiallyOpen = ['batteryKwh', 'consumptionKwh', 'maxChargeKw'].some(key => draft.value[key] == null)
const category = ref('all')
const query = ref('')
const selectedDestination = ref(normalizeDestinationInfo(props.destinationInfo, draft.value.destination))
const destinationKey = ref('')
const mapOpen = ref(false)
const manualOpen = ref(false)
const manualName = ref(selectedDestination.value?.name || '')
const manualLng = ref(draft.value.destination?.[0] ?? '')
const manualLat = ref(draft.value.destination?.[1] ?? '')
const formError = ref('')
const catalog = computed(() => destinationCatalog(props.places))
const destinations = computed(() => filterDestinations(catalog.value, category.value, query.value))
const normalized = computed(() => normalizeTripContext(draft.value))
function chooseDestination() {
  const place = catalog.value.find(item => item.id === destinationKey.value)
  if (!place) return
  selectedDestination.value = place; draft.value.destination = [...place.coordinates]
  manualName.value = place.name; manualLng.value = place.coordinates[0]; manualLat.value = place.coordinates[1]
  formError.value = ''
}
function pick(point) {
  if (manualName.value === selectedDestination.value?.name) manualName.value = ''
  manualLng.value = point[0]; manualLat.value = point[1]; setManualDestination(); mapOpen.value = false
}
function setManualDestination() {
  const point = [Number(manualLng.value), Number(manualLat.value)]
  if (manualLng.value === '' || manualLat.value === '' || !normalizeTripContext({ destination: point }).destination) {
    formError.value = '请填写有效的 WGS84 经度和纬度，或在地图上选点。'; return
  }
  const value = { id: 'custom', name: manualName.value.trim() || '自选目的地', category: category.value === 'all' ? 'other' : category.value }
  selectedDestination.value = normalizeDestinationInfo(value, point); draft.value.destination = point
  destinationKey.value = ''; formError.value = ''
}
function clearDestination() {
  draft.value.destination = null; selectedDestination.value = null; destinationKey.value = ''
  manualName.value = ''; manualLng.value = ''; manualLat.value = ''; formError.value = ''
}
function revealInvalid(event) {
  let details = event.target.closest('details')
  while (details) { details.open = true; details = details.parentElement.closest('details') }
}
function save() {
  formError.value = ''
  const manualChanged = !selectedDestination.value || manualName.value.trim() !== selectedDestination.value.name
    || Number(manualLng.value) !== selectedDestination.value.coordinates[0] || Number(manualLat.value) !== selectedDestination.value.coordinates[1]
  if (manualOpen.value && manualChanged && (manualLng.value !== '' || manualLat.value !== '' || manualName.value.trim())) {
    setManualDestination(); if (formError.value) return
  }
  for (const [key, value] of Object.entries(draft.value)) {
    if (!['origin','shoppingMinutes'].includes(key) && value !== null && value !== '' && normalized.value[key] === null) {
      formError.value = '部分参数超出有效范围，请核对后保存。'; return
    }
  }
  if (normalized.value.targetSoc !== null && normalized.value.reserveSoc !== null && normalized.value.targetSoc < normalized.value.reserveSoc) {
    formError.value = '目标电量不能低于到站保留电量。'; return
  }
  emit('save', { intent: normalizeIntent(props.intent), profile: normalized.value,
    destinationInfo: normalizeDestinationInfo(selectedDestination.value, normalized.value.destination), confirmSoc: true })
}
</script>

<template>
  <form id="charging-settings-form" class="charging-settings-form" aria-label="车辆与出行设置" @submit.prevent="save" @invalid.capture="revealInvalid">
    <section class="settings-card trip-settings" aria-labelledby="trip-settings-title">
      <div class="settings-card-heading"><span><UiIcon name="compass" :size="20" /></span><div><h2 id="trip-settings-title">本次充电</h2><p>所有推荐方式共用这份充电计划。</p></div></div>
      <div class="settings-fields">
        <label>当前电量（%）<input v-model.number="draft.currentSoc" aria-label="当前电量" type="number" min="0" max="100" step="any" placeholder="如 20" /></label>
        <label>充到多少（%）<input v-model.number="draft.targetSoc" aria-label="目标电量" type="number" min="0" max="100" step="any" /></label>
      </div>
      <p class="settings-help">修改后自动用于三种推荐。</p>

    </section>

    <details class="settings-card vehicle-settings" :open="vehicleInitiallyOpen">
      <summary class="settings-card-heading"><span><UiIcon name="bolt" :size="20" /></span><div><h2>我的车辆</h2><p>{{ vehicleInitiallyOpen ? '首次填写，之后自动沿用。' : `${draft.batteryKwh ?? '—'} kWh · ${draft.consumptionKwh ?? '—'} kWh/100km · ${draft.maxChargeKw ?? '—'} kW` }}</p></div><UiIcon name="chevron" :size="16" /></summary>
      <div class="settings-fields vehicle-fields">
        <label>电池容量（kWh）<input v-model.number="draft.batteryKwh" aria-label="电池容量" type="number" min="1" max="300" step="any" placeholder="如 60" /></label>
        <label>百公里电耗（kWh）<input v-model.number="draft.consumptionKwh" aria-label="百公里电耗" type="number" min="1" max="100" step="any" placeholder="如 15" /></label>
        <label>最大充电功率（kW）<input v-model.number="draft.maxChargeKw" aria-label="车辆充电功率上限" type="number" min="1" max="1000" step="any" placeholder="如 100" /></label>
      </div>
      <p class="settings-help">填写一次，三种推荐方式自动沿用。不清楚的可以留空。</p>
    </details>


    <details class="settings-card destination-settings">
      <summary class="settings-card-heading"><span><UiIcon name="pin" :size="20" /></span><div><h2>目的地与停留</h2><p>{{ selectedDestination ? selectedDestination.name + ' · 停留 ' + draft.stayMinutes + ' 分钟' : '选填，附近充电可以不填。' }}</p></div><UiIcon name="chevron" :size="16" /></summary>
      <div class="shared-destination-fields">
        <div v-if="selectedDestination" class="selected-destination"><UiIcon name="pin" :size="18" /><div><b>{{ selectedDestination.name }}</b><small>{{ DESTINATION_CATEGORIES.find(item => item.value === selectedDestination.category)?.label || '自选地点' }}</small></div><button type="button" aria-label="清除目的地" @click="clearDestination"><UiIcon name="close" :size="16" /></button></div>
        <div class="settings-fields destination-search">
          <label>搜索地点<input v-model="query" aria-label="搜索目的地" type="search" placeholder="名称或地址" /></label>
          <label>选择目的地<select v-model="destinationKey" aria-label="选择目的地" @change="chooseDestination"><option value="">从 {{ destinations.length }} 个地点中选择</option><option v-for="place in destinations" :key="place.id" :value="place.id">{{ place.name }}{{ place.address ? ' · ' + place.address : '' }}</option></select></label>
        </div>
        <p v-if="!destinations.length" class="settings-help">暂无匹配地点，可以展开下方选项，在地图上选点。</p>
        <details class="destination-more">
          <summary>地图选点与其他选项</summary>
          <div class="destination-categories" aria-label="目的地功能区"><button v-for="item in DESTINATION_CATEGORIES" :key="item.value" type="button" :class="{ active: category === item.value }" :aria-pressed="category === item.value" @click="category = item.value; destinationKey = ''">{{ item.label }}</button></div>
          <div class="destination-actions"><button type="button" :aria-expanded="mapOpen" @click="mapOpen = !mapOpen">{{ mapOpen ? '收起地图' : '在地图上选点' }}</button><button type="button" :aria-expanded="manualOpen" @click="manualOpen = !manualOpen">{{ manualOpen ? '收起坐标填写' : '填写名称与坐标' }}</button></div>
          <DestinationPicker v-if="mapOpen" :coordinates="draft.destination" @pick="pick" />
          <div v-if="manualOpen" class="settings-fields manual-destination">
            <label class="settings-wide">地点名称<input v-model="manualName" aria-label="自定义目的地名称" maxlength="100" placeholder="如 图书馆、公司入口" /></label>
            <label>WGS84 经度<input v-model.number="manualLng" aria-label="目的地经度" type="number" min="-180" max="180" step="any" /></label>
            <label>WGS84 纬度<input v-model.number="manualLat" aria-label="目的地纬度" type="number" min="-90" max="90" step="any" /></label>
            <button class="use-coordinates settings-wide" type="button" @click="setManualDestination">使用此位置</button>
            <p class="settings-help settings-wide">地图选点自动转换坐标。手动填写请使用 WGS84，位置尽量靠近实际入口。</p>
          </div>
        </details>
        <div class="settings-fields activity-settings">
          <label>预计停留（分钟）<input v-model.number="draft.stayMinutes" aria-label="预计活动时长" type="number" min="0" max="1440" step="any" /></label>
          <label>最多步行（米，单程）<input v-model.number="draft.maxWalkMeters" aria-label="最多步行距离" type="number" min="0" max="10000" step="any" /></label>
        </div>
      </div>
    </details>

    <details class="settings-card settings-advanced">
      <summary><span><UiIcon name="settings" :size="18" /><b>更多设置</b></span><small>等待时间 · 安全余量 · 估算参数</small><UiIcon name="chevron" :size="16" /></summary>
      <div class="settings-advanced-content">
        <div class="settings-fields">
          <label>等待时间（分钟）<input v-model.number="draft.queueMinutes" aria-label="预计排队时间" type="number" min="0" max="1440" step="any" placeholder="未知请留空" /></label>
          <label>到站保留电量（%）<input v-model.number="draft.reserveSoc" aria-label="到站保留电量" type="number" min="0" max="100" step="any" /></label>
          <label class="settings-wide">行驶用电成本（元/kWh）<input v-model.number="draft.travelPricePerKwh" aria-label="行驶用电成本" type="number" min="0" max="20" step="any" placeholder="用于估算额外绕行能耗" /></label>
          <label>平均功率系数<input v-model.number="draft.powerFactor" aria-label="平均充电功率系数" type="number" min="0.01" max="1" step="any" /></label>
          <label>充电效率<input v-model.number="draft.efficiency" aria-label="充电效率" type="number" min="0.01" max="1" step="any" /></label>
        </div>
        <p class="settings-help">等待留空表示未知，填 0 表示假设无需排队；空闲桩数量不能代表实际等待时间。</p>
        <p class="settings-help">平均功率系数默认 0.8，效率默认 0.9。按车辆与站点功率的较小值估算，停车按小时单价计算，充电曲线和停车优惠以现场为准。</p>
        <p class="settings-help">假设开始充电后再去目的地，活动与往返步行期间持续补电，排队另计。步行按单程直线距离、80 米/分钟估算，实际路线待确认。</p>
      </div>
    </details>
    <p v-if="formError" class="settings-error" role="alert">{{ formError }}</p>
  </form>
</template>

<style scoped>
.charging-settings-form{display:grid;gap:16px;align-items:start}
.settings-card{min-width:0;padding:22px;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-1)}
.settings-card-heading{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.settings-card-heading>span{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:11px;background:var(--ok-50);color:var(--ok-600)}
:is(.vehicle-settings,.destination-settings)>summary{cursor:pointer;list-style:none;margin-bottom:0}:is(.vehicle-settings,.destination-settings)>summary::-webkit-details-marker{display:none}:is(.vehicle-settings,.destination-settings)>summary>div{flex:1;min-width:0}:is(.vehicle-settings,.destination-settings)>summary>svg{color:var(--ink-400)}:is(.vehicle-settings,.destination-settings)[open]>summary{margin-bottom:18px}:is(.vehicle-settings,.destination-settings)[open]>summary>svg{transform:rotate(180deg)}
h2{font-size:16px;margin:0 0 4px;color:var(--ink-900)}
.settings-card-heading p{font-size:12px;color:var(--ink-500);line-height:1.6;margin:0}
h3{font-size:13px;color:var(--ink-800);margin:20px 0 12px}
.settings-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.vehicle-fields{grid-template-columns:repeat(3,minmax(0,1fr))}
.settings-fields label{display:flex;flex-direction:column;gap:7px;min-width:0;font-size:12px;color:var(--ink-600);line-height:1.5}
.settings-wide{grid-column:1/-1}
.settings-fields input,.settings-fields select{width:100%;box-sizing:border-box;min-width:0;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink-900);padding:11px 10px;font-size:14px;outline:none}
.settings-fields input:focus,.settings-fields select:focus{border-color:var(--ok-500);box-shadow:0 0 0 3px rgba(22,163,74,.12)}
.settings-help{font-size:11px;color:var(--ink-500);line-height:1.8;margin:10px 0 0}
.shared-destination-fields{padding-top:14px}.destination-search{margin-top:12px}
.destination-categories{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}
.destination-categories button,.destination-actions button{border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:8px 10px;font-size:11px;color:var(--ink-600)}
.destination-categories button.active{background:var(--ok-50);border-color:#9fdcc0;color:var(--ok-600)}
.selected-destination{display:flex;gap:9px;align-items:center;background:var(--ok-50);border:1px solid #b9e6d0;border-radius:10px;padding:12px;color:var(--ok-600)}
.selected-destination>div{flex:1;min-width:0;overflow-wrap:anywhere}
.selected-destination b{font-size:12px}
.selected-destination small{display:block;font-size:10px;line-height:1.7;margin-top:3px;color:var(--ink-500)}
.selected-destination button{border:0;background:none;color:var(--ink-500);flex:none;padding:4px}
.destination-more{margin-top:14px;font-size:11px;color:var(--ink-500)}
.destination-more summary{cursor:pointer}
.destination-actions{display:flex;gap:10px;margin:14px 0}
.manual-destination{padding:14px;background:var(--surface-muted);border-radius:10px;margin-top:14px}
.use-coordinates{border:1px solid #9fdcc0;background:var(--ok-50);border-radius:8px;color:var(--ok-600);padding:9px;font-size:12px}
.activity-settings{margin-top:18px}
.settings-advanced{padding:0}
.settings-advanced>summary{display:flex;align-items:center;gap:10px;padding:18px 22px;cursor:pointer;list-style:none}
.settings-advanced>summary::-webkit-details-marker{display:none}
.settings-advanced>summary>span{display:flex;align-items:center;gap:10px;flex:1;font-size:13px;color:var(--ink-600)}
.settings-advanced>summary small{font-size:11px;color:var(--ink-400)}
.settings-advanced>summary>svg{color:var(--ink-400);flex:none}
.settings-advanced[open]>summary>svg{transform:rotate(180deg)}
.settings-advanced-content{border-top:1px solid var(--line);padding:20px 22px}
.settings-error{font-size:12px;color:#b91c1c;line-height:1.7;margin:0}
button:focus-visible,summary:focus-visible{outline:2px solid var(--ok-500);outline-offset:3px}
@media(max-width:600px){
  .settings-card{padding:18px}
  .settings-fields{gap:12px}
  .vehicle-fields{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .vehicle-fields>label:last-child{grid-column:1/-1}
  .destination-search{grid-template-columns:minmax(0,1fr)}
  .settings-fields input,.settings-fields select{font-size:16px}
  .settings-advanced{padding:0}
  .settings-advanced>summary{padding:18px}
  .settings-advanced>summary small{display:none}
  .settings-advanced-content{padding:18px}
}
</style>
