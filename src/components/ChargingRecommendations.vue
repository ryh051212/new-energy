<script setup>
import { ref, computed, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import StationQuickFacts from './StationQuickFacts.vue'
import { TRIP_INTENTS } from '../utils/tripCharging.js'
import { formatChargingDistance } from '../utils/charging.js'
import { routeTollText } from '../utils/stationInformation.js'

const props = defineProps({
  stations: { type: Array, default: () => [] }, status: { type: String, default: 'idle' },
  mode: { type: String, default: 'distance' }, weight: { type: Number, default: 50 },
  radius: { type: Number, default: 0 }, chargeType: { type: String, default: '' },
  availableOnly: Boolean, hasFast: Boolean, hasRegular: Boolean, hasAvailability: Boolean,
  usableRoutesOnly: Boolean, filteredRouteCount: { type: Number, default: 0 },
  metadata: { type: Object, default: null },
  plans: { type: Object, default: () => new Map() },
  planningStation: { type: Object, default: null }, selectedRouteId: { type: String, default: '' },
  activeStationId: { type: String, default: '' }, routeFocused: Boolean,
  intent: { type: String, default: '' }, tripContext: { type: Object, default: () => ({}) },
  destinationInfo: { type: Object, default: null }, socUpdatedAt: { type: String, default: null },
  settingsNotice: { type: String, default: '' }, hasLocation: { type: Boolean, default: true },
  now: Number,
})
const emit = defineEmits(['mode', 'weight', 'type', 'available', 'usable-routes', 'select', 'close', 'retry', 'route', 'retry-route', 'back', 'intent', 'locate', 'update-trip'])
const editingSoc = ref(false)
const currentSoc = ref(props.tripContext.currentSoc ?? '')
const targetSoc = ref(props.tripContext.targetSoc ?? '')
const socError = ref('')
const filterSummary = computed(() => [props.chargeType === 'fast' ? '快充' : props.chargeType === 'regular' ? '普通充电' : '', props.availableOnly ? '仅空闲' : '', props.usableRoutesOnly ? '可用路线' : ''].filter(Boolean).join(' · '))
watch(() => [props.tripContext.currentSoc, props.tripContext.targetSoc], ([current, target]) => {
  currentSoc.value = current ?? ''; targetSoc.value = target ?? ''
})
function editSoc() {
  currentSoc.value = props.tripContext.currentSoc ?? ''; targetSoc.value = props.tripContext.targetSoc ?? ''
  socError.value = ''; editingSoc.value = !editingSoc.value
}
function saveSoc() {
  if (targetSoc.value !== '' && props.tripContext.reserveSoc != null && Number(targetSoc.value) < props.tripContext.reserveSoc) {
    socError.value = `目标电量不能低于保留电量 ${props.tripContext.reserveSoc}%。`; return
  }
  emit('update-trip', { currentSoc: currentSoc.value === '' ? null : Number(currentSoc.value), targetSoc: targetSoc.value === '' ? null : Number(targetSoc.value) })
  editingSoc.value = false; socError.value = ''
}
const displayedStations = computed(() => props.stations)
const activePlan = computed(() => props.planningStation ? planFor(props.planningStation) : null)
const focusedRoute = computed(() => props.routeFocused
  ? activePlan.value?.features.find(route => route.properties.routeId === props.selectedRouteId) : null)
function planFor(station) { return props.plans.get(String(station.properties.id)) }
const draftWeight = ref(props.weight)
watch(() => props.weight, value => { draftWeight.value = value })
const modes = [{ value: 'distance', label: '距离优先' }, { value: 'economy', label: '经济优先' },
  { value: 'balanced', label: '综合推荐' }]
</script>

<template>
  <aside class="charging-recommendations" :aria-label="planningStation ? routeFocused ? '所选路线详情' : '站点路线方案' : '附近推荐站点'" :aria-busy="planningStation ? activePlan?.status === 'loading' : status === 'loading'">
    <header><button v-if="planningStation" class="route-back" :aria-label="routeFocused ? '返回路线方案' : '返回推荐站点'" @click="emit('back')"><UiIcon name="chevron" :size="17" />返回</button><div><small>从当前位置出发</small><h2>{{ planningStation ? routeFocused ? '路线详情' : '选择路线' : '推荐充电站' }}</h2></div><button class="icon-button" aria-label="关闭推荐站点" @click="emit('close')"><UiIcon name="close" :size="19" /></button></header>
    <template v-if="planningStation">
      <section class="route-destination" aria-label="目的充电站">
        <small>目的地</small><h3>{{ planningStation.properties.name }}</h3>
        <p>{{ planningStation.properties.address || '地址暂无' }}</p>
      </section>
      <section v-if="focusedRoute" class="focused-route" aria-label="所选路线">
        <h3>{{ focusedRoute.properties.routeLabel }}</h3>
        <div class="focused-route-metrics"><strong>{{ formatChargingDistance(focusedRoute.properties.distanceMeters) }}</strong><strong>约 {{ Math.ceil(focusedRoute.properties.durationSeconds / 60) }} 分钟</strong></div>
        <p>{{ routeTollText(focusedRoute.properties.tollsYuan) }}</p>
        <p v-if="focusedRoute.properties.roads?.length">经 {{ focusedRoute.properties.roads.join(' · ') }}</p>
      </section>
      <section v-else class="station-route-plans" :aria-label="planningStation.properties.name + '路线方案'" :aria-busy="activePlan?.status === 'loading'">
        <h3>前往该站的路线</h3>
        <p v-if="activePlan?.status === 'loading'" role="status">正在规划驾车路线…</p>
        <template v-else-if="activePlan?.features.length">
          <button v-for="route in activePlan.features" :key="route.properties.routeId" class="route-option" :class="{ selected: selectedRouteId === route.properties.routeId }" :aria-pressed="selectedRouteId === route.properties.routeId" @click="emit('route', { station: planningStation, route })">
            <span><b>{{ route.properties.routeLabel }}</b><small>{{ formatChargingDistance(route.properties.distanceMeters) }} · 约 {{ Math.ceil(route.properties.durationSeconds / 60) }} 分钟</small></span>
            <span class="route-tolls">{{ routeTollText(route.properties.tollsYuan) }}</span>
            <small v-if="route.properties.roads?.length" class="route-roads">经 {{ route.properties.roads.join(' · ') }}</small>
          </button>
          <p class="route-help">最多 3 条实际方案，点击查看单条路线。</p>
        </template>
        <div v-else class="route-fallback" role="status"><b>路线不可使用</b><p>没有可用驾车路线，驾车时间未知。</p><p v-if="activePlan?.metadata?.straightDistanceMeters != null || planningStation.properties.straightDistanceMeters != null">直线参考 {{ formatChargingDistance(activePlan?.metadata?.straightDistanceMeters ?? planningStation.properties.straightDistanceMeters) }}（非驾车距离）。</p><button @click="emit('retry-route', planningStation)">重新规划</button></div>
      </section>
      <footer>道路收费不含充电和停车费用。</footer>
    </template>
    <template v-else>
    <template v-if="intent">
      <div class="recommendation-modes trip-intents" aria-label="这次出行要做什么">
        <button v-for="item in TRIP_INTENTS" :key="item.value" :class="{ active: intent === item.value }" :aria-pressed="intent === item.value" @click="emit('intent', item.value)">{{ item.label }}</button>
      </div>
      <div class="trip-summary">
        <span><UiIcon name="bolt" :size="15" /><template v-if="tripContext.currentSoc != null">电量 <b>{{ tripContext.currentSoc }}%</b><span v-if="tripContext.targetSoc != null"> → {{ tripContext.targetSoc }}%</span></template><template v-else>充电计划</template></span>
        <button :aria-expanded="editingSoc" aria-controls="recommendation-soc-form" @click="editSoc">{{ editingSoc ? '收起' : '修改电量' }}</button>
        <a href="#/charging/settings" aria-label="打开车辆与出行设置"><UiIcon name="settings" :size="15" />设置</a>
      </div>
      <form v-if="editingSoc" id="recommendation-soc-form" class="quick-soc-form" aria-label="修改本次电量" @submit.prevent="saveSoc">
        <label>当前电量（%）<input v-model.number="currentSoc" aria-label="当前电量" type="number" min="0" max="100" step="any" placeholder="如 20" /></label>
        <label>充到（%）<input v-model.number="targetSoc" aria-label="目标电量" type="number" min="0" max="100" step="any" /></label>
        <p v-if="socError" class="quick-soc-error" role="alert">{{ socError }}</p>
        <button type="submit">更新推荐</button>
      </form>
      <a v-if="destinationInfo" class="trip-destination" href="#/charging/settings"><UiIcon name="pin" :size="14" /><span>{{ destinationInfo.name }} · 停留 {{ tripContext.stayMinutes }} 分钟</span><UiIcon name="chevron" :size="12" /></a>
      <p v-if="settingsNotice" class="trip-pending" role="status">{{ settingsNotice }}</p>
      <p v-if="!hasLocation" class="trip-pending">定位后查看附近站点。<button @click="emit('locate')">定位并推荐</button></p>
    </template>
    <div v-else class="recommendation-modes" aria-label="推荐排序方式">
      <button v-for="item in modes" :key="item.value" :class="{ active: mode === item.value }" :aria-pressed="mode === item.value" @click="emit('mode', item.value)">{{ item.label }}</button>
    </div>
    <details class="recommendation-filters">
      <summary><span>筛选</span><small>{{ filterSummary || '不限类型' }}</small><UiIcon name="chevron" :size="13" /></summary>
    <div v-if="!intent && mode === 'balanced'" class="recommendation-weights">
      <label for="recommendation-weight">综合偏好 <span>距离 {{ draftWeight }}% · 费用 {{ 100 - draftWeight }}%</span></label>
      <input id="recommendation-weight" v-model.number="draftWeight" type="range" min="0" max="100" step="5" aria-label="综合推荐距离权重" @change="emit('weight', draftWeight)" />
      <div><span>更省钱</span><button @click="emit('weight', 50); draftWeight = 50">恢复 50 / 50</button><span>更近</span></div>
    </div>
    <div class="recommendation-options" aria-label="可选推荐条件">
      <button :disabled="!hasFast" :class="{ active: chargeType === 'fast' }" :aria-pressed="chargeType === 'fast'" @click="emit('type', 'fast')">快充</button>
      <button :disabled="!hasRegular" :class="{ active: chargeType === 'regular' }" :aria-pressed="chargeType === 'regular'" @click="emit('type', 'regular')">普通充电</button>
      <label><input type="checkbox" :checked="availableOnly" :disabled="!hasAvailability && !availableOnly" @change="emit('available', $event.target.checked)" />仅空闲</label>
    </div>
    </details>
    <div class="recommendation-route-filter">
      <button type="button" :class="{ active: usableRoutesOnly }" :aria-pressed="usableRoutesOnly" @click="emit('usable-routes', !usableRoutesOnly)"><UiIcon name="compass" :size="14" /><span>过滤不可用路线</span><span class="route-filter-state">{{ usableRoutesOnly ? '已开启' : '未开启' }}</span></button>
      <p v-if="usableRoutesOnly && hasLocation && status !== 'loading'" role="status">{{ filteredRouteCount ? `已过滤 ${filteredRouteCount} 个路线不可用的站点` : '仅显示有可用驾车路线的站点' }}</p>
    </div>
    <p class="recommendation-scope"><span>{{ radius ? `直线 ${radius} km 范围` : '附近站点' }}</span><span>{{ stations.length }} 个推荐</span></p>
    <p v-if="status === 'loading' || status === 'error'" class="recommendation-status" :class="{ fallback: status === 'error' }" role="status">
      <template v-if="status === 'loading'">正在更新路线…</template>
      <template v-else-if="status === 'error'">路线暂未更新，先看附近站点。<button @click="emit('retry')">重试</button></template>
    </p>
    <ol v-if="displayedStations.length" class="recommendation-list">
      <li v-for="(station, index) in displayedStations" :key="station.properties.id">
        <button class="recommendation-card" :class="{ active: activeStationId === String(station.properties.id) }" :aria-pressed="activeStationId === String(station.properties.id)" @click="emit('select', station)">
          <div class="recommendation-title"><span class="recommendation-rank">{{ index < stations.length ? index + 1 : '选' }}</span><strong>{{ station.properties.name }}</strong><UiIcon name="pin" :size="16" /></div>
          <StationQuickFacts compact :properties="station.properties" :fit="station.properties.tripFit" :context="tripContext" :now="now" />
        </button>

      </li>
    </ol>
    <div v-else class="recommendation-empty" role="status">
      <p>{{ !hasLocation ? '定位后查看附近充电站。' : status === 'loading' ? '正在查找附近站点…' : usableRoutesOnly ? '暂无可用驾车路线，试试重新获取路线或关闭过滤。' : '暂无合适站点，试试扩大范围或调整筛选。' }}</p>
      <div v-if="usableRoutesOnly && hasLocation && status !== 'loading'" class="route-filter-actions"><button @click="emit('retry')">重新获取路线</button><button @click="emit('usable-routes', false)">显示全部推荐</button></div>
    </div>
    </template>
  </aside>
</template>

<style scoped>
.charging-recommendations{position:absolute;right:76px;top:88px;z-index:4;width:360px;max-width:calc(100% - 96px);max-height:calc(100dvh - 110px);overflow-y:auto;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-2);padding:16px;color:var(--ink-900)}
header{display:flex;align-items:center;gap:12px;margin-bottom:14px}header>div{flex:1}header small{font-size:11px;color:var(--ink-400)}h2{font-size:17px;margin:3px 0 0}.icon-button{display:grid;place-items:center;background:none;border:0;border-radius:50%;padding:5px;color:var(--ink-500)}
.recommendation-modes{display:flex;gap:4px;padding:4px;background:var(--surface-muted);border-radius:var(--r-sm)}.recommendation-modes button{flex:1;border:0;border-radius:var(--r-xs);padding:9px 2px;background:none;font-size:12px;font-weight:600;color:var(--ink-500)}.recommendation-modes button.active{color:var(--ok-600);background:white;box-shadow:var(--shadow-1)}
.trip-summary{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:11px;color:var(--ink-600)}.trip-summary>span{display:flex;gap:4px;align-items:center;flex:1;flex-wrap:wrap}.trip-summary b{color:var(--ink-900)}.trip-summary button,.trip-summary a{display:flex;align-items:center;gap:4px;border:0;background:none;padding:5px 0;color:var(--ok-600);font-size:11px;white-space:nowrap}
.trip-destination{display:flex;align-items:center;gap:6px;color:var(--ink-500);font-size:11px;line-height:1.6;margin-top:8px}.trip-destination>span{flex:1;overflow-wrap:anywhere}.trip-destination>svg:last-child{transform:rotate(-90deg)}.trip-pending{font-size:11px;line-height:1.7;color:#92400e;margin:8px 0}.trip-pending button{border:0;background:none;color:var(--ok-600);font-size:11px;margin-left:4px}
.quick-soc-form{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px;margin:8px 0;background:var(--surface-muted);border-radius:var(--r-sm)}.quick-soc-form label{font-size:11px;color:var(--ink-600)}.quick-soc-form input{display:block;box-sizing:border-box;min-width:0;width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink-900);font-size:14px;margin-top:6px}.quick-soc-form>button{grid-column:1/-1;background:var(--ok-600);color:white;border:0;border-radius:6px;padding:9px;font-size:12px}.quick-soc-error{grid-column:1/-1;font-size:11px;line-height:1.6;color:#b91c1c;margin:0}
.recommendation-filters{margin-top:8px}.recommendation-filters summary{display:flex;align-items:center;gap:6px;padding:7px 0;font-size:11px;color:var(--ink-500);cursor:pointer;list-style:none}.recommendation-filters summary::-webkit-details-marker{display:none}.recommendation-filters summary>span{flex:1}.recommendation-filters summary small{font-size:10px;color:var(--ink-400)}.recommendation-filters[open] summary>svg{transform:rotate(180deg)}.recommendation-options{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:4px 0 8px;font-size:11px;color:var(--ink-500)}.recommendation-options button{padding:6px 8px;border:1px solid var(--line);border-radius:var(--r-xs);background:none;font-size:11px;color:var(--ink-600)}.recommendation-options button.active{background:var(--ok-50);color:var(--ok-600);border-color:#9fdcc0}.recommendation-options label{display:flex;align-items:center;gap:3px;margin-left:auto}.recommendation-options input{accent-color:var(--ok-500)}button:disabled{opacity:.4;cursor:not-allowed}
.recommendation-weights{padding:12px 0 4px}.recommendation-weights label,.recommendation-weights>div{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--ink-500)}.recommendation-weights label span{color:var(--ok-600)}.recommendation-weights input{width:100%;accent-color:var(--ok-500);margin:10px 0}.recommendation-weights button{background:none;border:0;font-size:10px;color:var(--ink-500)}
.recommendation-scope{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--ink-400);margin:8px 0}.recommendation-status{font-size:11px;line-height:1.6;color:var(--ink-500);margin:0 0 10px}.recommendation-status button{background:none;border:0;color:var(--ok-600);font-size:11px;padding-left:6px}
.recommendation-route-filter{margin:6px 0 10px}.recommendation-route-filter>button{display:flex;align-items:center;gap:6px;width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);font-size:11px;color:var(--ink-600);text-align:left}.recommendation-route-filter>button.active{background:var(--ok-50);color:var(--ok-600);border-color:#9fdcc0}.route-filter-state{margin-left:auto;font-size:10px;white-space:nowrap}.recommendation-route-filter p{margin:6px 0 0;font-size:11px;line-height:1.6;color:var(--ink-500)}.route-filter-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin-top:10px}.route-filter-actions button{padding:7px 9px;border:1px solid var(--line);border-radius:var(--r-xs);background:var(--surface);color:var(--ok-600);font-size:11px}.recommendation-empty p{margin:0}
.recommendation-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.recommendation-card{display:block;text-align:left;width:100%;padding:14px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);color:var(--ink-800)}.recommendation-card:hover{border-color:#9fdcc0;background:var(--ok-50)}.recommendation-card.active{border-color:var(--ok-500);background:var(--ok-50);box-shadow:inset 3px 0 var(--ok-500)}.recommendation-title{display:flex;gap:8px;align-items:center}.recommendation-title strong{flex:1;font-size:13px;line-height:1.6}.recommendation-title>svg{color:var(--ink-400);flex:none}.recommendation-rank{display:grid;place-items:center;width:20px;height:20px;flex:none;background:var(--ok-50);color:var(--ok-600);font-size:11px;font-weight:700;border-radius:5px}.recommendation-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--ink-500)}.recommendation-tags>span{padding:3px 6px;background:var(--surface-muted);border-radius:4px}.recommendation-empty{font-size:12px;color:var(--ink-500);padding:20px 6px;text-align:center;line-height:1.8}
.route-back{display:flex;align-items:center;gap:3px;flex:none;border:1px solid var(--line);border-radius:var(--r-sm);padding:7px 9px;background:var(--surface);color:var(--ink-600);font-size:12px}.route-back svg{transform:rotate(90deg)}.route-destination{padding:12px 0;border-top:1px solid var(--line)}.route-destination small{font-size:10px;color:var(--ink-400)}.route-destination h3{font-size:14px;line-height:1.6;margin:4px 0}.route-destination p{font-size:11px;line-height:1.6;color:var(--ink-500);margin:0}
.focused-route{padding:14px;background:var(--brand-50);border:1px solid var(--brand-200);border-radius:var(--r-md)}.focused-route h3{font-size:14px;margin:0 0 14px;color:var(--brand-600)}.focused-route-metrics{display:flex;justify-content:space-between;gap:10px;font-size:17px}.focused-route p{font-size:12px;line-height:1.8;color:var(--ink-600);margin-top:10px}.station-route-plans h3{font-size:13px;margin:8px 0}.station-route-plans p{font-size:11px;line-height:1.6;color:var(--ink-500)}
.route-option{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;width:100%;padding:12px;margin:8px 0;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);color:var(--ink-700)}.route-option.selected{border-color:var(--brand-500);box-shadow:inset 3px 0 var(--brand-500)}.route-option b{display:block;font-size:12px}.route-option small{display:block;font-size:11px;color:var(--ink-500);margin-top:4px}.route-tolls{font-size:11px}.route-roads{width:100%}.route-fallback b{font-size:12px;color:var(--ink-700)}.route-fallback button{margin-top:8px;border:1px solid var(--line);border-radius:var(--r-xs);background:white;color:var(--brand-600);font-size:11px;padding:7px 10px}footer{font-size:10px;line-height:1.7;color:var(--ink-400);margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--ok-500);outline-offset:3px}
@media(max-width:920px){.charging-recommendations{top:146px;width:340px;max-height:calc(100dvh - 166px)}}
@media(max-width:760px){.charging-recommendations{top:auto;right:12px;left:12px;bottom:max(12px,env(safe-area-inset-bottom));width:auto;max-width:none;max-height:60dvh;padding:14px}.recommendation-options label{margin-left:0}.quick-soc-form input{font-size:16px}}
</style>
