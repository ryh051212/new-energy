<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import UiIcon from './UiIcon.vue'
import { filterStations } from '../utils/stations.js'
import { selectChargingStations, stationDistance, stationMetric } from '../utils/charging.js'

maplibregl.setWorkerUrl(workerUrl)
const mapEl = ref(null)
const stations = ref([])
const places = ref([])
const input = ref('')
const keyword = ref('')
const chargeType = ref('')
const availableOnly = ref(false)
const radius = ref(0)
const location = ref(null)
const selected = ref(null)
const loading = ref(true)
const locating = ref(false)
const filtersOpen = ref(false)
const feedback = ref('')
const dataError = ref('')
const controller = new AbortController()
let map
let userMarker
let placeMarker
let resizeObserver
let disposed = false

const visibleStations = computed(() => selectChargingStations(stations.value, {
  keyword: keyword.value, type: chargeType.value, available: availableOnly.value,
  radius: radius.value, location: location.value,
}))
const hasFast = computed(() => stations.value.some(station => station.properties?.chargeType === 'fast'))
const hasSlow = computed(() => stations.value.some(station => station.properties?.chargeType === 'slow'))
const hasAvailability = computed(() => stations.value.some(station => Number.isFinite(station.properties?.availableCount)))
const placeResults = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return query ? places.value.filter(place => `${place.properties?.name || ''} ${place.properties?.address || ''}`.toLowerCase().includes(query)).slice(0, 5) : []
})
const selectedDistance = computed(() => selected.value ? distanceLabel(selected.value) : '')

function distanceLabel(station) {
  const km = stationDistance(station, location.value)
  return km === null ? '定位后查看' : km < 1 ? `约 ${Math.round(km * 1000)} m` : `约 ${km.toFixed(1)} km`
}
function updateMap() {
  map?.getSource('charging-stations')?.setData({ type: 'FeatureCollection', features: visibleStations.value })
  if (selected.value && !visibleStations.value.includes(selected.value)) selected.value = null
}
watch(visibleStations, updateMap)
watch(selected, station => {
  if (map?.getLayer('charging-selected')) map.setFilter('charging-selected', ['==', ['get', '_key'], station?.properties._key ?? -1])
})

function chooseStation(station) {
  selected.value = station
  filtersOpen.value = false
  map?.flyTo({ center: station.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 550 })
}
function search() {
  keyword.value = input.value.trim()
  feedback.value = ''
  filtersOpen.value = false
  selected.value = null
  if (visibleStations.value.length === 1) chooseStation(visibleStations.value[0])
  else if (visibleStations.value.length > 1) {
    const bounds = new maplibregl.LngLatBounds()
    visibleStations.value.forEach(station => bounds.extend(station.geometry.coordinates))
    map?.fitBounds(bounds, { padding: 90, maxZoom: 14, duration: 550 })
  } else if (placeResults.value.length) choosePlace(placeResults.value[0])
  else feedback.value = '未找到匹配结果，试试站名、地址或清除筛选'
}
function choosePlace(place) {
  selected.value = null
  placeMarker?.remove()
  placeMarker = new maplibregl.Marker({ color: '#337df0' }).setLngLat(place.geometry.coordinates).addTo(map)
  keyword.value = ''
  map.flyTo({ center: place.geometry.coordinates, zoom: 14, duration: 550 })
  feedback.value = `已定位到 ${place.properties?.name || '所选地点'}`
}
function toggleType(type) {
  chargeType.value = chargeType.value === type ? '' : type
}
function resetFilters() {
  chargeType.value = ''
  availableOnly.value = false
  radius.value = 0
}
function locate() {
  if (locating.value || !map) return
  if (!navigator.geolocation) { feedback.value = '浏览器暂不支持定位'; return }
  locating.value = true
  feedback.value = '正在获取你的位置…'
  navigator.geolocation.getCurrentPosition(position => {
    if (disposed) return
    locating.value = false
    location.value = [position.coords.longitude, position.coords.latitude]
    if (!userMarker) {
      const dot = document.createElement('div')
      dot.className = 'charging-user-marker'
      dot.setAttribute('role', 'img')
      dot.setAttribute('aria-label', '当前位置')
      const label = document.createElement('span')
      label.className = 'charging-position-label'
      label.textContent = '当前位置'
      dot.append(label)
      userMarker = new maplibregl.Marker({ element: dot }).setLngLat(location.value).addTo(map)
    } else userMarker.setLngLat(location.value)
    map.flyTo({ center: location.value, zoom: 14, duration: 550 })
    feedback.value = '已标记当前位置 · 距离为直线估算'
  }, error => {
    if (disposed) return
    locating.value = false
    feedback.value = error.code === 1 ? '请在浏览器中允许位置权限，再点击定位' : error.code === 3 ? '定位超时，请重新点击定位' : '暂时无法定位，请稍后重试'
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })
}
async function readJson(file) {
  const response = await fetch(`${import.meta.env.BASE_URL}geojson/${file}`, { signal: controller.signal })
  if (!response.ok) throw new Error('数据加载失败')
  return response.json()
}
onMounted(() => {
  map = new maplibregl.Map({
    container: mapEl.value, center: [113.8356, 34.0268], zoom: 12,
    style: { version: 8, sources: {
      basemap: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' },
      'charging-stations': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    }, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#edf3ef' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
      { id: 'charging-selected', type: 'circle', source: 'charging-stations', filter: ['==', ['get', '_key'], -1], paint: { 'circle-radius': 23, 'circle-color': '#1bb879', 'circle-opacity': 0.2 } },
      { id: 'charging-points', type: 'circle', source: 'charging-stations', paint: { 'circle-radius': 13, 'circle-color': '#11aa70', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } },
      { id: 'charging-bolts', type: 'symbol', source: 'charging-stations', layout: { 'icon-image': 'charging-bolt', 'icon-size': 0.7, 'icon-allow-overlap': true } },
    ] },
  })
  resizeObserver = new ResizeObserver(() => map?.resize())
  resizeObserver.observe(mapEl.value)
  map.on('load', async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 24
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    for (const [i, [x, y]] of [[13, 2], [4, 13], [11, 13], [10, 22], [20, 10], [13, 10]].entries()) {
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
    map.addImage('charging-bolt', ctx.getImageData(0, 0, 24, 24))
    try {
      const [data, boundary] = await Promise.all([readJson('stations.json'), readJson('weidu.json')])
      if (disposed) return
      stations.value = filterStations(data, boundary).features.map((feature, index) => ({ ...feature, properties: { ...feature.properties, _key: index } }))
      updateMap()
    } catch (error) {
      if (!disposed) dataError.value = '站点数据加载失败，请刷新重试'
    } finally {
      if (!disposed) loading.value = false
    }
  })
  // 地点搜索使用当前项目的小区与商业地点数据。
  Promise.allSettled([readJson('residential-pois.json'), readJson('commercial-pois.json')]).then(results => {
    if (disposed) return
    places.value = results.flatMap(result => result.status === 'fulfilled' ? result.value.features || [] : [])
      .filter(feature => feature.geometry?.type === 'Point')
  })
  map.on('click', 'charging-points', event => {
    const key = event.features?.[0]?.properties._key
    const station = stations.value.find(feature => feature.properties._key === Number(key))
    if (station) chooseStation(station)
  })
  map.on('mouseenter', 'charging-points', () => { map.getCanvas().style.cursor = 'pointer' })
  map.on('mouseleave', 'charging-points', () => { map.getCanvas().style.cursor = '' })
})
onBeforeUnmount(() => {
  disposed = true
  controller.abort()
  resizeObserver?.disconnect()
  userMarker?.remove()
  placeMarker?.remove()
  map?.remove()
})
</script>

<template>
  <main class="charging-page" aria-label="找充电">
    <div ref="mapEl" class="charging-map"></div>
    <div class="charging-search-wrap">
      <form class="charging-search" @submit.prevent="search">
        <a href="#/" class="charging-back" aria-label="返回首页"><UiIcon name="chevron" :size="20" /></a>
        <UiIcon name="search" :size="20" />
        <input v-model="input" aria-label="搜索地点或充电站" placeholder="搜索地点 / 搜索充电站" />
        <button v-if="input" type="button" class="charging-clear" aria-label="清空搜索" @click="input = ''; keyword = ''; feedback = ''"><UiIcon name="close" :size="16" /></button>
        <button type="submit" class="charging-search-submit" :disabled="loading">搜索</button>
      </form>
    </div>
    <div class="charging-controls">
      <button aria-label="放大地图" @click="map?.zoomIn()"><UiIcon name="plus" /></button>
      <button aria-label="缩小地图" @click="map?.zoomOut()"><UiIcon name="minus" /></button>
      <button :disabled="locating" :class="['charging-locate', { located: location }]" :aria-busy="locating" aria-label="定位当前位置" title="定位并标记当前位置" @click="locate"><UiIcon name="locate" /><span>{{ locating ? '定位中' : location ? '重新定位' : '定位' }}</span></button>
    </div>
    <div class="charging-bottom">
      <section v-if="filtersOpen" class="charging-more" aria-label="更多筛选">
        <div class="charging-results-heading"><b>距离与偏好</b><button aria-label="关闭更多筛选" @click="filtersOpen = false"><UiIcon name="close" :size="17" /></button></div>
        <p>距离范围 <small>{{ location ? '直线距离' : '定位后可用' }}</small></p>
        <div class="charging-radius"><button v-for="item in [{value:0,label:'不限'},{value:1,label:'1 km'},{value:3,label:'3 km'},{value:5,label:'5 km'}]" :key="item.value" :disabled="!!item.value && !location" :class="{ chosen: radius === item.value }" @click="radius = item.value">{{ item.label }}</button></div>
        <p class="charging-data-note">{{ hasFast || hasSlow ? '可按已标注的充电类型筛选。' : '站点充电类型待补充，快充与慢充筛选暂不可用。' }}{{ hasAvailability ? '' : '暂无实时空闲数据。' }}</p>
        <button class="charging-reset" @click="resetFilters">重置筛选</button>
      </section>
      <div class="charging-filterbar" aria-label="充电站筛选">
        <button :class="{ chosen: chargeType === 'fast' }" :disabled="!hasFast" @click="toggleType('fast')">快充</button>
        <button :class="{ chosen: chargeType === 'slow' }" :disabled="!hasSlow" @click="toggleType('slow')">慢充</button>
        <button :class="{ chosen: radius > 0 }" @click="filtersOpen = !filtersOpen">距离<UiIcon name="chevron" :size="12" /></button>
        <button :class="{ chosen: availableOnly }" :disabled="!hasAvailability" @click="availableOnly = !availableOnly">空闲</button>
        <button :class="{ chosen: filtersOpen }" @click="filtersOpen = !filtersOpen">更多筛选<UiIcon name="chevron" :size="12" /></button>
      </div>
      <section v-if="selected" class="charging-detail" aria-label="站点详情">
        <div class="charging-detail-heading"><span class="charging-detail-icon"><UiIcon name="bolt" :size="24" /></span><div><small>站点详情</small><h1>{{ selected.properties.name }}</h1></div><button aria-label="关闭站点详情" @click="selected = null"><UiIcon name="close" :size="20" /></button></div>
        <p class="charging-address"><UiIcon name="pin" :size="15" />{{ selected.properties.address || '地址暂无' }}</p>
        <dl class="charging-metrics"><div><dt>距离</dt><dd>{{ selectedDistance }}</dd></div><div><dt>快充</dt><dd>{{ stationMetric(selected.properties.fastCount, ' 个') }}</dd></div><div><dt>空闲</dt><dd>{{ stationMetric(selected.properties.availableCount, ' 个') }}</dd></div><div><dt>功率</dt><dd>{{ stationMetric(selected.properties.powerKw, ' kW') }}</dd></div></dl>
        <div class="charging-detail-foot"><span>推荐指数 <b>待评估</b></span><button v-if="!location" @click="locate">定位查看距离<UiIcon name="locate" :size="15" /></button></div>
      </section>
      <div v-if="!selected || feedback || dataError" class="charging-map-caption" role="status">{{ dataError || feedback || (loading ? '正在加载充电站…' : `地图上有 ${visibleStations.length} 个站点，点击 ⚡ 查看详情`) }}</div>
    </div>
  </main>
</template>

<style scoped>
.charging-page{position:relative;height:100dvh;min-height:480px;overflow:hidden;background:#edf3ef;color:#203647}
.charging-map{position:absolute;inset:0}
.charging-search-wrap{position:absolute;top:24px;left:24px;width:440px;max-width:calc(100% - 48px);z-index:3}
.charging-search{display:flex;align-items:center;gap:12px;padding:10px 12px;background:#fff;border-radius:15px;box-shadow:0 5px 25px #1e493320}
.charging-back{display:grid;place-items:center;padding:7px;border-right:1px solid #e8eeeb}.charging-back svg{transform:rotate(90deg)}
.charging-search input{flex:1;min-width:0;border:0;background:none;font-size:14px;outline:none;color:#233947}
.charging-search input::placeholder{color:#85938f}
.charging-search-submit{border:0;background:#0daa71;color:#fff;border-radius:9px;padding:9px 14px;font-size:13px}
.charging-clear,.charging-results-heading button,.charging-detail-heading>button{display:grid;place-items:center;border:0;background:none;color:#869690;padding:4px}
.charging-more,.charging-detail{background:#fff;box-shadow:0 6px 24px #1e49331c;border-radius:16px;padding:16px}
.charging-results-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:#789087;margin-bottom:8px}
.charging-controls{position:absolute;right:24px;top:50%;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px #1e493320}
.charging-controls button{display:grid;place-items:center;width:44px;height:44px;border:0;border-bottom:1px solid #edf2ef;background:#fff;color:#3d6253}
.charging-controls .charging-locate{height:64px;gap:3px;align-content:center;color:#337df0}
.charging-locate span{font-size:10px;white-space:nowrap}.charging-controls .charging-locate.located{background:#edf5ff}
.charging-bottom{position:absolute;bottom:32px;left:24px;width:440px;max-width:calc(100% - 48px);max-height:calc(100dvh - 125px);overflow-y:auto;z-index:3;display:flex;flex-direction:column;gap:10px;padding:3px}
.charging-filterbar{display:flex;background:#fff;border-radius:13px;box-shadow:0 4px 22px #1e49331c;padding:7px 5px}
.charging-bottom>*{flex-shrink:0}
.charging-filterbar button{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;background:none;border:0;border-right:1px solid #edf2ef;padding:10px 4px;font-size:13px;color:#365247}.charging-filterbar button:last-child{border-right:0;flex:1.5}
button.chosen{color:#0a9f67;background:#eaf8f1;border-radius:8px;font-weight:700}
button:disabled{cursor:default;opacity:.42}
.charging-more p{font-size:13px}.charging-more small{float:right;font-size:11px;color:#8a9b92}
.charging-radius{display:flex;gap:8px}.charging-radius button{flex:1;border:1px solid #e4eee8;border-radius:8px;background:#f6f9f7;color:#486253;padding:9px;font-size:12px}.charging-radius button.chosen{background:#eaf8f1;border-color:#91dabb;color:#0a9f67}
.charging-more .charging-data-note{font-size:11px;color:#8a9b92;line-height:1.7}
.charging-reset{border:0;background:none;color:#0aa269;padding:0;font-size:12px}
.charging-detail{padding:20px}.charging-detail-heading{display:flex;align-items:center;gap:12px}.charging-detail-icon{width:44px;height:44px;flex:none;display:grid;place-items:center;background:#e7f8ef;color:#0fa773;border-radius:13px}.charging-detail-heading>div{flex:1;min-width:0}.charging-detail-heading small{font-size:11px;color:#8a9b92}.charging-detail h1{font-size:17px;line-height:1.5;margin:3px 0 0}.charging-detail-heading>button{align-self:flex-start}
.charging-address{display:flex;align-items:center;gap:5px;font-size:12px;color:#86978e;line-height:1.6;margin:12px 0 18px}
.charging-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0;padding:0 0 18px;border-bottom:1px solid #eef3ef}.charging-metrics dt{font-size:11px;color:#86988e;margin-bottom:7px}.charging-metrics dd{margin:0;font-size:13px;font-weight:700;color:#315145}
.charging-detail-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:14px;font-size:12px;color:#85958d}.charging-detail-foot b{color:#547165;margin-left:8px;font-weight:500}.charging-detail-foot button{display:flex;align-items:center;gap:5px;color:#0fa36f;background:none;border:0;font-size:12px;padding:0}
.charging-map-caption{align-self:center;background:#fffffff0;border-radius:20px;padding:8px 14px;color:#668373;font-size:11px;box-shadow:0 3px 14px #1e493310}
:global(.charging-user-marker){position:relative;width:20px;height:20px;border:3px solid #fff;border-radius:50%;background:#3389ff;box-shadow:0 0 0 8px #3389ff25,0 2px 8px #1c4b7333}
:global(.charging-position-label){position:absolute;bottom:28px;left:50%;transform:translateX(-50%);white-space:nowrap;padding:6px 10px;border-radius:8px;background:#fff;color:#337df0;font-size:12px;font-weight:700;box-shadow:0 3px 12px #1c4b7326}
@media(max-width:600px){.charging-search-wrap{top:16px;left:12px;max-width:calc(100% - 24px)}.charging-search{gap:8px}.charging-bottom{left:12px;bottom:max(28px,env(safe-area-inset-bottom));max-width:calc(100% - 24px)}.charging-controls{right:12px;top:34%}.charging-detail{padding:16px}.charging-detail h1{font-size:16px}.charging-metrics{gap:6px}.charging-metrics dd{font-size:12px}}
</style>
