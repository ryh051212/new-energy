<script setup>
import { ref, watch, nextTick, onMounted } from 'vue'
import UiIcon from './UiIcon.vue'
import StationQuickFacts from './StationQuickFacts.vue'

const props = defineProps({
  stations: { type: Array, default: () => [] }, activeStationId: { type: String, default: '' },
  loading: Boolean, error: { type: String, default: '' }, hasLocation: Boolean, locating: Boolean,
  tripContext: { type: Object, default: () => ({}) }, now: Number,
})
const emit = defineEmits(['select', 'locate', 'recommend'])
const list = ref(null)
async function revealSelected() {
  await nextTick()
  list.value?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
}
watch(() => props.activeStationId, revealSelected)
onMounted(revealSelected)
</script>

<template>
  <section ref="list" class="driver-stations" aria-label="车主站点列表" :aria-busy="loading">
    <header><div><h2>{{ hasLocation ? '附近充电站' : '充电站' }}</h2><small>{{ loading ? '正在加载…' : `${stations.length} 个站点` }}</small></div><button class="driver-recommend-link" @click="emit('recommend')"><UiIcon name="star" :size="14" />出行推荐</button></header>
    <button v-if="!hasLocation" class="driver-locate" :disabled="locating" @click="emit('locate')"><UiIcon name="locate" :size="15" />{{ locating ? '正在定位，仍可浏览站点' : '定位查看距离与附近站点' }}</button>
    <p v-if="error" class="driver-list-message" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="driver-list-message" role="status">正在加载充电站…</p>
    <ol v-else-if="stations.length" class="driver-station-list">
      <li v-for="station in stations" :key="station.properties.id">
        <button class="driver-station-card" :data-station-id="station.properties.id" :class="{ active: activeStationId === String(station.properties.id) }" :aria-pressed="activeStationId === String(station.properties.id)" @click="emit('select', station)">
          <div class="driver-card-meta"><small>{{ station.properties.chargeType === 'fast' ? '快充分类' : station.properties.chargeType === 'regular' ? '普通充电分类' : '类型待核验' }}</small><span v-if="station.properties.isSynthetic" class="demo">模拟点位</span><span v-else-if="station.properties.hasSimulatedAttributes" class="demo">属性含模拟</span><span v-else>站点记录</span></div>
          <div class="driver-station-title"><UiIcon :name="station.properties.chargeType === 'fast' ? 'charge-fast' : 'charge-regular'" :size="21" :class="station.properties.chargeType" /><strong>{{ station.properties.name }}</strong><UiIcon name="pin" :size="15" /></div>
          <p>{{ station.properties.address || '地址暂无' }}</p>
          <StationQuickFacts compact :properties="station.properties" :context="tripContext" :now="now" />
        </button>
      </li>
    </ol>
    <p v-else class="driver-list-message">暂无匹配站点，试试清空搜索、扩大范围或取消筛选。</p>
  </section>
</template>

<style scoped>
.driver-stations{color:var(--ink-900)}
.driver-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;color:var(--ink-500)}.driver-card-meta small{font-size:10px;font-weight:650}.driver-card-meta span{padding:3px 6px;font-size:9px;background:var(--surface-muted);border-radius:5px;white-space:nowrap}.driver-card-meta .demo{background:var(--warn-50);color:#97600c}
header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;padding:8px 0;background:var(--surface)}header>div{display:flex;align-items:baseline;gap:10px}h2{margin:0;font-size:15px}header small{font-size:11px;color:var(--ink-500);white-space:nowrap}
.driver-recommend-link{display:flex;align-items:center;gap:4px;padding:5px 0;border:0;background:none;color:var(--ok-600);font-size:11px;white-space:nowrap}
.driver-locate{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:10px 8px;margin:0 0 12px;border:1px solid var(--brand-200);border-radius:var(--r-sm);background:var(--brand-50);color:var(--brand-600);font-size:12px}.driver-locate:disabled{opacity:.65;cursor:default}
.driver-station-list{list-style:none;display:grid;gap:10px;padding:0;margin:0}.driver-station-card{display:block;width:100%;padding:14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);color:var(--ink-900);text-align:left;scroll-margin-top:64px;scroll-margin-bottom:14px}.driver-station-card:hover{background:var(--surface-muted)}.driver-station-card.active{border-color:#8fd4b4;background:var(--ok-50)}
.driver-station-title{display:flex;align-items:center;gap:8px}.driver-station-title strong{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px;line-height:1.6}.driver-station-title svg{flex:none}.driver-station-title .fast{color:#16a34a}.driver-station-title .regular{color:#2563eb}.driver-station-title>svg:last-child{color:var(--ink-400)}
.driver-station-card>p{font-size:11px;color:var(--ink-500);line-height:1.7;margin:7px 0 0;overflow-wrap:anywhere}.driver-station-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;font-size:10px;color:var(--ink-500)}.driver-station-tags>span{padding:3px 6px;background:var(--surface-muted);border-radius:5px}.driver-station-tags .demo-tag{color:#a16207;background:#fffbeb}.driver-list-message{font-size:12px;line-height:1.8;color:var(--ink-500);padding:12px 0}
</style>
