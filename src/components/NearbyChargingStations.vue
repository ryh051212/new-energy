<script setup>
import UiIcon from './UiIcon.vue'
import { stationDistance, formatChargingDistance } from '../utils/charging.js'
import StationQuickFacts from './StationQuickFacts.vue'

defineProps({
  place: { type: Object, required: true }, stations: { type: Array, default: () => [] },
  radius: { type: Number, default: 1 }, loading: Boolean, error: { type: String, default: '' },
  hasLocation: Boolean,
  activeStationId: { type: String, default: '' },
  tripContext: { type: Object, default: () => ({}) }, now: Number,
})
const emit = defineEmits(['radius', 'select', 'close', 'exit'])
</script>

<template>
  <aside class="charging-nearby" aria-label="地点周围充电站">
    <header><div><small>所选地点周围</small><h2>附近充电站</h2></div><button class="icon-button" aria-label="关闭周边站点列表" @click="emit('close')"><UiIcon name="close" :size="19" /></button></header>
    <p class="nearby-place"><UiIcon name="pin" :size="16" /><b>{{ place.properties.name }}</b></p>
    <div class="nearby-radius" aria-label="地点周围查找范围"><button v-for="value in [1, 3, 5, 0]" :key="value" :class="{ active: radius === value }" :aria-pressed="radius === value" @click="emit('radius', value)">{{ value ? `${value} km` : '不限' }}</button></div>
    <p class="nearby-scope">{{ radius ? `地点周围直线 ${radius} km` : '按距地点的直线距离排序' }} · {{ stations.length }} 个站点</p>
    <p v-if="error || loading" class="nearby-empty" role="status">{{ error || '正在加载充电站…' }}</p>
    <ol v-else-if="stations.length" class="nearby-list">
      <li v-for="station in stations" :key="station.properties.id">
        <button class="nearby-station" :class="{ active: activeStationId === String(station.properties.id) }" :aria-pressed="activeStationId === String(station.properties.id)" @click="emit('select', station)">
          <strong>{{ station.properties.name }}</strong>
          <small>{{ station.properties.address || '地址暂无' }}</small>
          <small>距所选地点（直线）{{ formatChargingDistance(stationDistance(station, place.geometry.coordinates) * 1000) }}</small>
          <StationQuickFacts compact :properties="station.properties" :context="tripContext" :now="now" />
        </button>
      </li>
    </ol>
    <p v-else class="nearby-empty">这个范围内暂无匹配站点，试试扩大范围或取消筛选。</p>
    <button class="nearby-exit" @click="emit('exit')">{{ hasLocation ? '返回当前位置推荐' : '结束周边查找' }}</button>
  </aside>
</template>

<style scoped>
.charging-nearby{position:absolute;right:76px;top:88px;z-index:4;width:360px;max-width:calc(100% - 96px);max-height:calc(100dvh - 110px);overflow-y:auto;padding:16px;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-2);color:var(--ink-900)}
header{display:flex;align-items:center;gap:12px}header>div{flex:1}header small{font-size:11px;color:var(--ink-500)}h2{margin:3px 0 0;font-size:17px}.icon-button{display:grid;place-items:center;padding:6px;border:0;border-radius:50%;background:none;color:var(--ink-500)}
.nearby-place{display:flex;align-items:center;gap:8px;margin:15px 0 12px;font-size:13px;overflow-wrap:anywhere}.nearby-place svg{flex-shrink:0;color:var(--brand-600)}
.nearby-radius{display:flex;gap:6px}.nearby-radius button{flex:1;padding:8px 4px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-muted);color:var(--ink-600);font-size:12px}.nearby-radius button.active{background:var(--ok-50);border-color:#9fdcc0;color:var(--ok-600)}
.nearby-scope{font-size:11px;color:var(--ink-500);margin:12px 0}.nearby-list{display:grid;gap:9px;margin:0;padding:0;list-style:none}.nearby-station{display:block;width:100%;padding:13px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);text-align:left;color:var(--ink-900)}.nearby-station:hover,.nearby-station.active{background:var(--ok-50);border-color:#9fdcc0}.nearby-station>strong{display:block;font-size:13px;overflow-wrap:anywhere}.nearby-station>small{display:block;margin-top:6px;font-size:11px;line-height:1.6;color:var(--ink-500);overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}dt{font-size:10px;color:var(--ink-500)}dt span{color:#a16207}dd{margin:5px 0 0;font-size:14px;font-weight:700;overflow-wrap:anywhere}.nearby-tags{font-size:11px;color:var(--ink-500)}.nearby-empty{padding:14px 0;font-size:12px;line-height:1.7;color:var(--ink-500)}.nearby-exit{display:block;margin:14px auto 0;border:0;background:none;color:var(--brand-600);font-size:12px;padding:8px}
@media(min-width:761px) and (max-width:920px){.charging-nearby{top:202px;max-height:calc(100dvh - 230px)}}
@media(max-width:760px){.charging-nearby{left:12px;right:12px;top:auto;bottom:16px;width:auto;max-width:none;max-height:47dvh;padding:14px}.nearby-list{gap:8px}}
</style>
