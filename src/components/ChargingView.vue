<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import UiIcon from './UiIcon.vue'
import { filterStations } from '../utils/stations.js'
import { normalizeChargingPoint, selectChargingStations, stationDistance, stationMetric } from '../utils/charging.js'

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
const locationError = ref('')
const locationAccuracy = ref(null)
const filtersOpen = ref(false)
const feedback = ref('')
const dataError = ref('')
const controller = new AbortController()
let map
let userMarker
let placeMarker
let resizeObserver
let disposed = false
let mapReady = false
let pendingRadius = null

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
  if (disposed || !mapReady) return
  map?.getSource('charging-stations')?.setData({ type: 'FeatureCollection', features: visibleStations.value })
  if (selected.value && !visibleStations.value.includes(selected.value)) selected.value = null
}
watch(visibleStations, updateMap)
watch(selected, station => {
  if (disposed || !mapReady) return
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
  pendingRadius = null
}
function setRadius(value) {
  if (value > 0 && !location.value) {
    pendingRadius = value
    locate()
    return
  }
  pendingRadius = null
  radius.value = value
}
function locationFailed(error) {
  if (disposed) return
  locating.value = false
  locationError.value = error.code === 1 || error.name === 'SecurityError'
    ? '请在浏览器中允许位置权限，再点击重试'
    : error.code === 3 ? '定位超时，请点击重试' : '暂时无法获取位置，请稍后重试'
  feedback.value = ''
}
function locate() {
  if (disposed || locating.value || !map) return
  locationError.value = ''
  if (window.isSecureContext === false) {
    locationError.value = '请通过 HTTPS 或 localhost 打开页面后使用定位'
    return
  }
  if (!navigator.geolocation) { locationError.value = '浏览器暂不支持定位'; return }
  locating.value = true
  feedback.value = '正在获取你的位置…'
  try {
    navigator.geolocation.getCurrentPosition(position => {
      if (disposed) return
      const { longitude, latitude, accuracy } = position.coords
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
        locationFailed({ code: 2 })
        return
      }
      locating.value = false
      location.value = [longitude, latitude]
      locationAccuracy.value = Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null
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
      if (pendingRadius !== null) {
        radius.value = pendingRadius
        pendingRadius = null
      }
      map.flyTo({ center: location.value, zoom: 14, duration: 550 })
      feedback.value = `已标记当前位置${locationAccuracy.value === null ? '' : ` · 精度约 ${locationAccuracy.value} m`} · 距离为直线估算`
    }, locationFailed, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
  } catch (error) {
    locationFailed(error)
  }
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
  resizeObserver = new ResizeObserver(() => { if (!disposed) map?.resize() })
  resizeObserver.observe(mapEl.value)
  map.on('load', async () => {
    if (disposed) return
    mapReady = true
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
      stations.value = filterStations(data, boundary).features.map(normalizeChargingPoint)
        .map((feature, index) => ({ ...feature, properties: { ...feature.properties, _key: index } }))
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
      .map(normalizeChargingPoint)
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
    <div class="charging-topbar">
      <div class="charging-search-wrap">
        <form class="charging-search" @submit.prevent="search">
          <a href="#/" class="charging-back" aria-label="返回首页"><UiIcon name="chevron" :size="20" /></a>
          <UiIcon name="search" :size="20" />
          <input v-model="input" aria-label="搜索地点或充电站" placeholder="搜索地点 / 搜索充电站" />
          <button v-if="input" type="button" class="charging-clear" aria-label="清空搜索" @click="input = ''; keyword = ''; feedback = ''"><UiIcon name="close" :size="16" /></button>
          <button type="submit" class="charging-search-submit" :disabled="loading">搜索</button>
        </form>
      </div>
      <div class="charging-filter-wrap">
        <div class="charging-filterbar" aria-label="充电站筛选">
          <button :class="{ chosen: chargeType === 'fast' }" :disabled="!hasFast" :title="hasFast ? '筛选快充站' : '暂无快充类型数据'" @click="toggleType('fast')">快充</button>
          <button :class="{ chosen: chargeType === 'slow' }" :disabled="!hasSlow" :title="hasSlow ? '筛选慢充站' : '暂无慢充类型数据'" @click="toggleType('slow')">慢充</button>
          <button :class="{ chosen: radius > 0 }" :aria-expanded="filtersOpen" aria-controls="charging-filters" @click="filtersOpen = !filtersOpen">{{ radius ? `${radius} km` : '距离' }}<UiIcon name="chevron" :size="12" /></button>
          <button :class="{ chosen: availableOnly }" :disabled="!hasAvailability" :title="hasAvailability ? '只看有空闲桩的站点' : '暂无实时空闲数据'" @click="availableOnly = !availableOnly">空闲</button>
          <button :class="{ chosen: filtersOpen }" :aria-expanded="filtersOpen" aria-controls="charging-filters" @click="filtersOpen = !filtersOpen">更多筛选<UiIcon name="chevron" :size="12" /></button>
        </div>
        <section v-if="filtersOpen" id="charging-filters" class="charging-more" aria-label="更多筛选">
          <div class="charging-results-heading"><b>距离与偏好</b><button aria-label="关闭更多筛选" @click="filtersOpen = false"><UiIcon name="close" :size="17" /></button></div>
          <p>距离范围 <small>{{ locating ? '正在定位…' : location ? '直线距离' : '选择范围后定位' }}</small></p>
          <div class="charging-radius"><button v-for="item in [{value:0,label:'不限'},{value:1,label:'1 km'},{value:3,label:'3 km'},{value:5,label:'5 km'}]" :key="item.value" :disabled="!!item.value && locating" :class="{ chosen: radius === item.value }" @click="setRadius(item.value)">{{ item.label }}</button></div>
          <button v-if="!location" class="charging-filter-locate" :disabled="locating" @click="locate()"><UiIcon name="locate" :size="15" />{{ locating ? '正在定位…' : '定位查找附近充电站' }}</button>
          <p class="charging-data-note">{{ hasFast || hasSlow ? '可按已标注的充电类型筛选。' : '站点充电类型待补充，快充与慢充筛选暂不可用。' }}{{ hasAvailability ? '' : '暂无实时空闲数据。' }}</p>
          <button class="charging-reset" @click="resetFilters">重置筛选</button>
        </section>
      </div>
    </div>
    <div class="map-tools charging-controls" aria-label="地图工具">
      <button aria-label="放大地图" title="放大地图" @click="map?.zoomIn()"><UiIcon name="plus" :size="19" /></button>
      <button aria-label="缩小地图" title="缩小地图" @click="map?.zoomOut()"><UiIcon name="minus" :size="19" /></button>
      <button :disabled="locating" :class="{ active: location }" :aria-busy="locating" :aria-label="locating ? '定位中' : '定位当前位置'" :title="locating ? '定位中…' : location ? '重新定位' : '定位当前位置'" @click="locate()"><UiIcon name="locate" :size="19" /></button>
    </div>
    <div class="charging-bottom">
      <div v-if="locationError" class="charging-location-error" role="alert">
        <UiIcon name="alert" :size="17" /><span>{{ locationError }}</span><button :disabled="locating" @click="locate()">{{ locating ? '定位中…' : '重试' }}</button>
      </div>
      <section v-if="selected" class="charging-detail" aria-label="站点详情">
        <div class="charging-detail-heading"><span class="charging-detail-icon"><UiIcon name="bolt" :size="24" /></span><div><small>站点详情</small><h1>{{ selected.properties.name }}</h1></div><button aria-label="关闭站点详情" @click="selected = null"><UiIcon name="close" :size="20" /></button></div>
        <p class="charging-address"><UiIcon name="pin" :size="15" />{{ selected.properties.address || '地址暂无' }}</p>
        <dl class="charging-metrics"><div><dt>距离</dt><dd>{{ selectedDistance }}</dd></div><div><dt>快充</dt><dd>{{ stationMetric(selected.properties.fastCount, ' 个') }}</dd></div><div><dt>空闲</dt><dd>{{ stationMetric(selected.properties.availableCount, ' 个') }}</dd></div><div><dt>功率</dt><dd>{{ stationMetric(selected.properties.powerKw, ' kW') }}</dd></div></dl>
        <div class="charging-detail-foot"><span>推荐指数 <b>待评估</b></span><button v-if="!location" :disabled="locating" @click="locate()">{{ locating ? '正在定位…' : '定位查看距离' }}<UiIcon name="locate" :size="15" /></button></div>
      </section>
      <div v-if="!selected || feedback || dataError" class="charging-map-caption" role="status">{{ dataError || feedback || (loading ? '正在加载充电站…' : `地图上有 ${visibleStations.length} 个站点，点击 ⚡ 查看详情`) }}</div>
    </div>
  </main>
</template>

<style scoped>
/* 找充电页沿用全局设计令牌，让两个页面看起来是同一个产品 */
.charging-page{position:relative;height:100dvh;min-height:480px;overflow:hidden;background:var(--surface-sunken);color:var(--ink-900)}
.charging-map{position:absolute;inset:0}

/* 搜索栏：胶囊 + 毛玻璃浮层 */
.charging-topbar{position:absolute;top:20px;left:20px;right:20px;z-index:5;display:grid;grid-template-columns:minmax(0,430px) minmax(0,430px);justify-content:space-between;align-items:start;gap:20px;pointer-events:none}
.charging-topbar>*{pointer-events:auto;min-width:0}
.charging-filter-wrap{display:flex;flex-direction:column;gap:10px}
.charging-filter-wrap .charging-more{margin-right:52px;max-height:calc(100dvh - 150px);overflow-y:auto}
.charging-search{display:flex;align-items:center;gap:10px;min-height:48px;padding:6px 6px 6px 10px;background:rgba(255,255,255,.95);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:var(--r-pill);box-shadow:var(--shadow-2);color:var(--ink-400);transition:border-color var(--t),box-shadow var(--t)}
.charging-search:focus-within{border-color:var(--brand-200);box-shadow:var(--shadow-2),var(--focus)}
.charging-back{display:grid;place-items:center;padding:7px;border:0;background:none;border-right:1px solid var(--line);color:var(--ink-500);border-radius:var(--r-pill)}
.charging-back:hover{color:var(--brand-600)}
.charging-back svg{transform:rotate(90deg)}
.charging-search input{flex:1;min-width:0;border:0;background:none;font-size:13.5px;outline:none;color:var(--ink-900)}
.charging-search input::placeholder{color:var(--ink-400)}
.charging-search-submit{border:0;background:var(--ok-500);color:#fff;border-radius:var(--r-pill);padding:8px 16px;font-size:12.5px;font-weight:600}
.charging-search-submit:hover:not(:disabled){background:var(--ok-600)}
.charging-clear,.charging-results-heading button,.charging-detail-heading>button{display:grid;place-items:center;border:0;background:none;color:var(--ink-400);padding:4px;border-radius:50%}
.charging-clear:hover,.charging-results-heading button:hover,.charging-detail-heading>button:hover{background:var(--surface-muted);color:var(--ink-700)}

/* 卡片式浮层 */
.charging-more,.charging-detail{background:rgba(255,255,255,.97);backdrop-filter:blur(10px);border:1px solid var(--line);box-shadow:var(--shadow-2);border-radius:var(--r-lg);padding:16px}
.charging-results-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;font-weight:700;color:var(--ink-800);margin-bottom:10px}

/* 右侧地图控件（缩放 + 定位） */
.charging-controls{right:20px;top:88px;bottom:auto;z-index:4}

/* 顶部筛选与底部详情 */
.charging-bottom{position:absolute;bottom:22px;left:20px;width:430px;max-width:calc(100% - 40px);max-height:calc(100dvh - 112px);overflow-y:auto;z-index:3;display:flex;flex-direction:column;gap:9px;padding:3px}
.charging-bottom>*{flex-shrink:0}
.charging-filterbar{display:flex;min-height:48px;background:rgba(255,255,255,.96);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:var(--r-pill);box-shadow:var(--shadow-2);padding:6px}
.charging-filterbar button{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;background:none;border:0;border-radius:var(--r-xs);padding:8px 4px;font-size:12.5px;font-weight:600;color:var(--ink-700)}
.charging-filterbar button:hover:not(:disabled){background:var(--surface-muted)}
.charging-filterbar button:last-child{flex:1.4}
button.chosen{color:var(--ok-600);background:var(--ok-50)}
button:disabled{cursor:not-allowed;opacity:.42}
.charging-filter-locate{display:flex;align-items:center;gap:6px;margin-top:12px;padding:8px 10px;border:1px solid var(--brand-200);border-radius:var(--r-sm);background:var(--brand-50);color:var(--brand-600);font-size:12px;font-weight:600}
.charging-location-error{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:12px;box-shadow:var(--shadow-2);font-size:12px;line-height:1.6;color:var(--ink-700)}
.charging-location-error>svg{color:var(--warn-500)}
.charging-location-error>span{flex:1;min-width:0}
.charging-location-error button{flex:none;border:0;background:var(--brand-50);color:var(--brand-600);padding:7px 10px;border-radius:var(--r-sm);font-size:12px;font-weight:600}
.charging-more p{font-size:12.5px;font-weight:600;color:var(--ink-700)}
.charging-more small{float:right;font-size:11px;font-weight:500;color:var(--ink-400)}
.charging-radius{display:flex;gap:6px;margin-top:8px}
.charging-radius button{flex:1;border:1px solid var(--line);border-radius:var(--r-xs);background:var(--surface-muted);color:var(--ink-600);padding:8px;font-size:12px;font-weight:600}
.charging-radius button:hover:not(:disabled){border-color:var(--brand-200);color:var(--brand-600)}
.charging-radius button.chosen{background:var(--ok-50);border-color:#9fdcc0;color:var(--ok-600)}
.charging-more .charging-data-note{font-size:11px;font-weight:400;color:var(--ink-400);line-height:1.7;margin-top:8px}
.charging-reset{border:0;background:none;color:var(--ok-600);padding:0;font-size:12px;font-weight:600;margin-top:6px}
.charging-reset:hover{color:var(--ok-500)}

.charging-detail{padding:18px}
.charging-detail-heading{display:flex;align-items:center;gap:12px}
.charging-detail-icon{width:42px;height:42px;flex:none;display:grid;place-items:center;background:var(--ok-50);color:var(--ok-600);border-radius:var(--r-md)}
.charging-detail-heading>div{flex:1;min-width:0}
.charging-detail-heading small{font-size:11px;font-weight:600;color:var(--ink-400)}
.charging-detail h1{font-size:16px;font-weight:700;line-height:1.45;letter-spacing:-.2px;margin:3px 0 0;color:var(--ink-900)}
.charging-detail-heading>button{align-self:flex-start}
.charging-address{display:flex;align-items:flex-start;gap:5px;font-size:12px;color:var(--ink-500);line-height:1.6;margin:12px 0 16px}
.charging-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:0;padding:0 0 16px;border-bottom:1px solid var(--line)}
.charging-metrics dt{font-size:11px;font-weight:500;color:var(--ink-400);margin-bottom:6px}
.charging-metrics dd{margin:0;font-size:13px;font-weight:700;color:var(--ink-800);font-variant-numeric:tabular-nums}
.charging-detail-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:13px;font-size:12px;color:var(--ink-500)}
.charging-detail-foot b{color:var(--ink-600);margin-left:8px;font-weight:600}
.charging-detail-foot button{display:flex;align-items:center;gap:5px;color:var(--ok-600);background:none;border:0;font-size:12px;font-weight:600;padding:0}
.charging-map-caption{align-self:center;background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:var(--r-pill);padding:7px 15px;color:var(--ink-500);font-size:11px;box-shadow:var(--shadow-1)}

/* 定位标记与地图弹窗 */
:global(.charging-user-marker){position:relative;width:18px;height:18px;border:3px solid #fff;border-radius:50%;background:var(--brand-500);box-shadow:0 0 0 8px rgba(31,122,240,.16),0 2px 8px rgba(15,43,80,.25)}
:global(.charging-position-label){position:absolute;bottom:26px;left:50%;transform:translateX(-50%);white-space:nowrap;padding:5px 10px;border-radius:var(--r-pill);background:#fff;border:1px solid var(--line);color:var(--brand-600);font-size:11.5px;font-weight:600;box-shadow:var(--shadow-2)}

@media(max-width:920px){
  .charging-topbar{grid-template-columns:minmax(0,1fr);gap:10px}
  .charging-filter-wrap .charging-more{max-height:calc(100dvh - 220px)}
  .charging-controls{top:146px}
  .charging-bottom{max-height:calc(100dvh - 296px)}
}
@media(max-width:600px){
  .charging-topbar{top:14px;left:12px;right:12px;gap:8px}
  .charging-search{gap:8px}
  .charging-bottom{left:12px;bottom:max(20px,env(safe-area-inset-bottom));max-width:calc(100% - 24px)}
  .charging-controls{right:12px;top:136px}
  .charging-detail{padding:15px}
  .charging-detail h1{font-size:15px}
  .charging-metrics{gap:4px}
  .charging-metrics dd{font-size:12px}
}
</style>
