<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { circle, bbox } from '@turf/turf'
import UiIcon from './UiIcon.vue'
import ChargingRecommendations from './ChargingRecommendations.vue'
import StationQuickFacts from './StationQuickFacts.vue'
import { DEFAULT_TRIP, normalizeTripContext, rankTripStations, evaluateTripStation } from '../utils/tripCharging.js'
import { readChargingSettings, saveChargingSettings, normalizeIntent, CHARGING_SETTINGS_KEY } from '../utils/chargingSettings.js'
import { chargingMapIcon, chargingMapColor, registerChargingIcons } from '../utils/chargingIcons.js'
import { AMAP_STANDARD_SOURCE, toMapCoordinate, toMapGeoJSON } from '../utils/basemaps.js'
import { normalizeChargingPoint, selectChargingStations, chargingDistanceInfo, stationMetric, rankChargingRecommendations } from '../utils/charging.js'

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
const highlightedStation = ref(null)
const loading = ref(true)
const locating = ref(false)
const locationError = ref('')
const locationAccuracy = ref(null)
const routeDistances = ref(new Map())
const routeStatus = ref('idle')
const routeRecommendations = ref([])
const recommendationMeta = ref(null)
const recommendationsOpen = ref(false)
const recommendationMode = ref('distance')
const distanceWeight = ref(50)
const savedSettings = ref(readChargingSettings())
const settingsNotice = ref(savedSettings.value.error)
const tripIntent = ref(savedSettings.value.intent)
const tripProfile = ref({ ...DEFAULT_TRIP, ...savedSettings.value.profile })
const tripContext = computed(() => normalizeTripContext({ ...tripProfile.value, origin: location.value }))
function chooseIntent(intent) {
  tripIntent.value = normalizeIntent(intent)
  const result = saveChargingSettings({ ...savedSettings.value, intent: tripIntent.value, profile: tripProfile.value })
  if (result.ok) { savedSettings.value = result.settings; settingsNotice.value = '' }
  else settingsNotice.value = result.error
}
function updateTrip(input) {
  tripProfile.value = { ...tripProfile.value, currentSoc: input.currentSoc, targetSoc: input.targetSoc }
  const result = saveChargingSettings({ ...savedSettings.value, intent: tripIntent.value, profile: tripProfile.value, confirmSoc: true })
  if (result.ok) { savedSettings.value = result.settings; settingsNotice.value = '' }
  else settingsNotice.value = result.error
}
function refreshSettings(event) {
  if (event && event.key !== CHARGING_SETTINGS_KEY && event.key !== null) return
  const value = readChargingSettings()
  savedSettings.value = value; settingsNotice.value = value.error
  tripIntent.value = value.intent; tripProfile.value = { ...DEFAULT_TRIP, ...value.profile }
}
const routePlans = ref(new Map())
const planningStation = ref(null)
const selectedRouteId = ref('')
const routeFocused = ref(false)
const noticesVisible = ref(true)
const pendingPlanningStation = ref(null)
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
let routeController
let routeTimer
let routeRequestId = 0
let routeRequestKey = ''
let planningController
let planningTimer
let planningRequestId = 0
let planningRequestKey = ''
let windowIntentId = 0

const visibleStations = computed(() => selectChargingStations(stations.value, {
  keyword: keyword.value, type: chargeType.value, available: availableOnly.value,
  radius: radius.value, location: location.value,
}))
const recommendedStations = computed(() => {
  if (!location.value) return []
  if (routeStatus.value === 'ready') {
    const features = routeRecommendations.value.map(feature => {
    const original = stations.value.find(station => String(station.properties.id) === String(feature.properties.id))
    return { ...feature, properties: { ...original?.properties, ...feature.properties } }
  })
    return tripIntent.value ? rankTripStations(features, tripIntent.value, tripContext.value).slice(0, 5) : features
  }
  const features = visibleStations.value.map(station => ({ ...station,
    properties: { ...station.properties, ...distanceInfo(station) },
  }))
  return (tripIntent.value ? rankTripStations(features, tripIntent.value, tripContext.value)
    : rankChargingRecommendations(features, recommendationMode.value, distanceWeight.value / 100)).slice(0, 5)
})
const radiusBuffer = computed(() => ({
  type: 'FeatureCollection',
  features: location.value && radius.value > 0
    ? [circle(location.value, radius.value, { units: 'kilometers', steps: 128 })] : [],
}))
const hasFast = computed(() => stations.value.some(station => station.properties?.chargeType === 'fast'))
const hasRegular = computed(() => stations.value.some(station => station.properties?.chargeType === 'regular'))
const hasAvailability = computed(() => stations.value.some(station => Number.isFinite(station.properties?.availableCount)))
const syntheticCount = computed(() => stations.value.filter(station => station.properties?.isSynthetic).length)
const supplementedCount = computed(() => stations.value.filter(station => !station.properties?.isSynthetic && station.properties?.hasSimulatedAttributes).length)
const placeResults = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return query ? places.value.filter(place => `${place.properties?.name || ''} ${place.properties?.address || ''}`.toLowerCase().includes(query)).slice(0, 5) : []
})
const selectedDistanceInfo = computed(() => selected.value ? distanceInfo(selected.value) : null)
const planningStationInfo = computed(() => planningStation.value ? { ...planningStation.value,
  properties: { ...planningStation.value.properties, ...routeDistances.value.get(String(planningStation.value.properties.id)),
    ...distanceInfo(planningStation.value) } } : null)
const selectedTripFit = computed(() => selected.value && tripIntent.value ? evaluateTripStation({ ...selected.value,
  properties: { ...selected.value.properties, ...routeDistances.value.get(String(selected.value.properties.id)),
    ...selectedDistanceInfo.value } }, tripIntent.value, tripContext.value) : null)

function distanceInfo(station) {
  const plan = String(planningStation.value?.properties.id) === String(station.properties.id)
    ? routePlans.value.get(String(station.properties.id)) : null
  const plannedRoute = plan?.features.find(feature => feature.properties.routeId === selectedRouteId.value)
  const info = chargingDistanceInfo(station, location.value,
    plannedRoute?.properties || (plan?.metadata?.isFallback ? plan.metadata : null)
      || routeDistances.value.get(String(station.properties?.id)), routeStatus.value === 'error')
  return plannedRoute && info ? { ...info, drivingTollsYuan: plannedRoute.properties.tollsYuan } : info
}
function updateRouteMap(focus = false) {
  if (disposed || !mapReady) return
  const plan = routePlans.value.get(String(planningStation.value?.properties.id))
  const features = (plan?.features || [])
    .filter(route => !routeFocused.value || route.properties.routeId === selectedRouteId.value)
    .map(route => ({ ...route, properties: { ...route.properties,
    routeSelected: route.properties.routeId === selectedRouteId.value } }))
    .sort((a, b) => Number(a.properties.routeSelected) - Number(b.properties.routeSelected))
  const data = toMapGeoJSON({ type: 'FeatureCollection', features })
  map?.getSource('charging-routes')?.setData(data)
  if (focus && features.length) {
    const [west, south, east, north] = bbox(data)
    map.fitBounds([[west, south], [east, north]], { padding: window.innerWidth <= 760
      ? { top: 150, bottom: Math.round(window.innerHeight * 0.54), left: 40, right: 40 }
      : { top: 110, bottom: 100, left: 60, right: 450 }, maxZoom: 16, duration: 550 })
  }
}
function clearPlanning(clearCache = false) {
  planningRequestId++
  planningController?.abort()
  clearTimeout(planningTimer)
  planningController = null
  planningTimer = null
  planningRequestKey = ''
  pendingPlanningStation.value = null
  planningStation.value = null
  selectedRouteId.value = ''
  routeFocused.value = false
  if (clearCache) routePlans.value = new Map()
  updateRouteMap()
}
async function loadStationPlans(station, force = false) {
  if (disposed || !location.value) return
  const id = String(station.properties.id)
  const [lng, lat] = location.value
  const key = `${lng},${lat}:${id}`
  recommendationsOpen.value = true
  if (!force && planningController && planningRequestKey === key) return
  const cached = routePlans.value.get(id)
  clearPlanning()
  planningStation.value = station
  if (!force && cached?.status === 'ready') {
    selectedRouteId.value = cached.features[0]?.properties.routeId || ''
    updateRouteMap(true)
    return
  }
  const requestId = ++planningRequestId
  planningRequestKey = key
  const requestController = new AbortController()
  planningController = requestController
  const timer = setTimeout(() => requestController.abort(), 12000)
  planningTimer = timer
  routePlans.value = new Map(routePlans.value).set(id, { status: 'loading', features: [], metadata: null })
  try {
    const response = await fetch(`http://127.0.0.1:8000/api/stations/${encodeURIComponent(id)}/routes?lng=${lng}&lat=${lat}`, { signal: requestController.signal })
    if (!response.ok) throw new Error('路线方案加载失败')
    const data = await response.json()
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('无效路线方案')
    const features = data.features.filter(route => route.type === 'Feature' && route.geometry?.type === 'LineString'
      && route.geometry.coordinates?.length >= 2 && route.geometry.coordinates.every(point => Array.isArray(point)
        && point.length === 2 && point.every((value, index) => Number.isFinite(value) && Math.abs(value) <= (index ? 90 : 180)))
      && route.properties?.distanceSource === 'amap_driving' && route.properties.isFallback === false
      && route.properties.distanceType === 'driving'
      && typeof route.properties.distanceMeters === 'number' && Number.isFinite(route.properties.distanceMeters) && route.properties.distanceMeters >= 0
      && typeof route.properties.durationSeconds === 'number' && Number.isFinite(route.properties.durationSeconds) && route.properties.durationSeconds >= 0)
      .slice(0, 3).map((route, index) => ({ ...route, properties: { ...route.properties, routeId: String(route.properties.routeId ?? index + 1) } }))
    if (data.features.length && !features.length) throw new Error('路线坐标不可用')
    if (disposed || requestId !== planningRequestId) return
    routePlans.value = new Map(routePlans.value).set(id, { status: 'ready', features, metadata: data.metadata || null })
    selectedRouteId.value = features[0]?.properties.routeId || ''
    updateRouteMap(true)
  } catch (error) {
    if (!disposed && requestId === planningRequestId) {
      routePlans.value = new Map(routePlans.value).set(id, { status: 'error', features: [], metadata: {
        straightDistanceMeters: chargingDistanceInfo(station, location.value)?.straightDistanceMeters,
        distanceSource: 'client_straight', distanceType: 'straight', isFallback: true,
      } })
      updateRouteMap()
    }
  } finally {
    clearTimeout(timer)
    if (requestId === planningRequestId) { planningController = null; planningTimer = null; planningRequestKey = '' }
  }
}
function chooseRoute({ station, route }) {
  if (String(station.properties.id) !== String(planningStation.value?.properties.id)) return
  selectedRouteId.value = String(route.properties.routeId)
  routeFocused.value = true
  updateRouteMap(true)
}
function returnFromRoutes() {
  if (routeFocused.value) {
    routeFocused.value = false
    updateRouteMap(true)
  } else {
    clearPlanning()
    selected.value = null
  }
  recommendationsOpen.value = true
}
function goToStation(station) {
  if (!station || disposed) return
  if (tripIntent.value && evaluateTripStation({ ...station, properties: { ...station.properties,
    ...routeDistances.value.get(String(station.properties.id)), ...distanceInfo(station) } }, tripIntent.value, tripContext.value).excluded) return
  if (selected.value !== station) chooseStation(station)
  if (location.value) loadStationPlans(station)
  else {
    pendingPlanningStation.value = station
    locate()
  }
}
function dismissChargingWindows(event) {
  if (event?.target?.closest?.('.charging-topbar, .charging-controls, .charging-bottom, .charging-recommendations, .charging-type-legend, .charging-demo-entry, .charging-trip-entry, .maplibregl-ctrl, .charging-user-marker, .maplibregl-popup')) return
  const hadDetail = selected.value && !planningStation.value
  selected.value = null
  pendingPlanningStation.value = null
  if (hadDetail && location.value && window.innerWidth <= 760) recommendationsOpen.value = true
}
function updateMap() {
  if (disposed || !mapReady) return
  const features = visibleStations.value.map(station => {
    const info = distanceInfo(station)
    return info ? { ...station, properties: { ...station.properties, ...info } } : station
  })
  map?.getSource('charging-stations')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features }))
  applyStationHighlight()
  if (selected.value && !visibleStations.value.includes(selected.value)) selected.value = null
}
watch(visibleStations, updateMap)
watch([routeDistances, routeStatus, routePlans, selectedRouteId, planningStation], updateMap)
async function loadRouteDistances(force = false) {
  if (disposed || !location.value) return
  const [lng, lat] = location.value
  const params = new URLSearchParams({ lng, lat, limit: 5, mode: recommendationMode.value,
    distance_weight: distanceWeight.value / 100, radius_km: radius.value,
    charge_type: chargeType.value, available_only: availableOnly.value, name: keyword.value })
  if (tripIntent.value) { params.set('intent', tripIntent.value); params.set('trip_context', JSON.stringify(tripContext.value)) }
  const requestKey = params.toString()
  if (!force && routeRequestKey === requestKey && ['loading', 'ready'].includes(routeStatus.value)) return
  routeRequestKey = requestKey
  const requestId = ++routeRequestId
  routeController?.abort()
  clearTimeout(routeTimer)
  const requestController = new AbortController()
  routeController = requestController
  const timer = setTimeout(() => requestController.abort(), 60000)
  routeTimer = timer
  routeDistances.value = new Map()
  routeRecommendations.value = []
  recommendationMeta.value = null
  routeStatus.value = 'loading'
  try {
    const response = await fetch(`http://127.0.0.1:8000/api/stations/recommended?${params}`, { signal: requestController.signal })
    if (!response.ok) throw new Error('路线结果加载失败')
    const data = await response.json()
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('无效路线结果')
    if (disposed || requestId !== routeRequestId) return
    const features = data.features.filter(feature => feature.properties?.id != null && feature.geometry?.type === 'Point')
      .map(normalizeChargingPoint)
    routeRecommendations.value = features
    recommendationMeta.value = data.metadata || null
    routeDistances.value = new Map(features
      .map(feature => [String(feature.properties.id), feature.properties]))
    routeStatus.value = 'ready'
  } catch (error) {
    if (!disposed && requestId === routeRequestId) routeStatus.value = 'error'
  } finally {
    clearTimeout(timer)
    if (requestId === routeRequestId) { routeController = null; routeTimer = null }
  }
}
watch(location, () => { clearPlanning(true); loadRouteDistances() }, { flush: 'sync' })
watch([radius, chargeType, availableOnly, keyword, recommendationMode, distanceWeight], () => loadRouteDistances())
watch([tripIntent, tripProfile], () => { clearPlanning(); loadRouteDistances() })
watch([radius, chargeType, availableOnly, keyword], () => {
  if (planningStation.value && !visibleStations.value.includes(planningStation.value)) clearPlanning()
})
function updateRadiusBuffer() {
  if (disposed || !mapReady) return
  map?.getSource('charging-radius')?.setData(toMapGeoJSON(radiusBuffer.value))
}
function focusRadiusBuffer() {
  if (disposed || !map || !radiusBuffer.value.features.length) return
  const [west, south, east, north] = bbox(toMapGeoJSON(radiusBuffer.value))
  map.fitBounds([[west, south], [east, north]], {
    padding: { top: 180, bottom: 80, left: 60, right: 60 }, maxZoom: 14, duration: 550,
  })
}
watch(radiusBuffer, updateRadiusBuffer)
function applyStationHighlight() {
  if (disposed || !mapReady) return
  if (map?.getLayer('charging-selected')) map.setFilter('charging-selected', ['==', ['get', '_key'], highlightedStation.value?.properties._key ?? -1])
}
watch(highlightedStation, applyStationHighlight)

function chooseStation(station) {
  clearPlanning()
  selected.value = station
  highlightedStation.value = station
  filtersOpen.value = false
  if (window.innerWidth <= 760) recommendationsOpen.value = false
  map?.flyTo({ center: toMapCoordinate(station.geometry.coordinates), zoom: Math.max(map.getZoom(), 14), duration: 550 })
}
function chooseRecommendation(station) {
  const original = stations.value.find(feature => String(feature.properties.id) === String(station.properties.id))
  if (original) chooseStation(original)
  else feedback.value = '站点数据尚未加载完成，请稍后重试'
}
function search() {
  clearPlanning()
  noticesVisible.value = true
  keyword.value = input.value.trim()
  feedback.value = ''
  filtersOpen.value = false
  selected.value = null
  if (visibleStations.value.length === 1) chooseStation(visibleStations.value[0])
  else if (visibleStations.value.length > 1) {
    const bounds = new maplibregl.LngLatBounds()
    visibleStations.value.forEach(station => bounds.extend(toMapCoordinate(station.geometry.coordinates)))
    map?.fitBounds(bounds, { padding: 90, maxZoom: 14, duration: 550 })
  } else if (placeResults.value.length) choosePlace(placeResults.value[0])
  else feedback.value = '未找到匹配结果，试试站名、地址或清除筛选'
}
function choosePlace(place) {
  clearPlanning()
  selected.value = null
  placeMarker?.remove()
  placeMarker = new maplibregl.Marker({ color: '#337df0' }).setLngLat(toMapCoordinate(place.geometry.coordinates)).addTo(map)
  keyword.value = ''
  map.flyTo({ center: toMapCoordinate(place.geometry.coordinates), zoom: 14, duration: 550 })
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
  if (value > 0) focusRadiusBuffer()
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
  noticesVisible.value = true
  const intentId = ++windowIntentId
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
      if (pendingRadius !== null) {
        radius.value = pendingRadius
        pendingRadius = null
      }
      routeRequestKey = ''
      const pendingStation = pendingPlanningStation.value || planningStation.value
      location.value = [longitude, latitude]
      recommendationsOpen.value = intentId === windowIntentId && !(selected.value && window.innerWidth <= 760 && !pendingStation)
      filtersOpen.value = false
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
        userMarker = new maplibregl.Marker({ element: dot }).setLngLat(toMapCoordinate(location.value)).addTo(map)
      } else userMarker.setLngLat(toMapCoordinate(location.value))
      if (selected.value && !pendingStation) map.flyTo({ center: toMapCoordinate(selected.value.geometry.coordinates), zoom: 14, duration: 550 })
      else if (radius.value > 0) focusRadiusBuffer()
      else map.flyTo({ center: toMapCoordinate(location.value), zoom: 14, duration: 550 })
      feedback.value = `已标记当前位置${locationAccuracy.value === null ? '' : ` · 精度约 ${locationAccuracy.value} m`} · 范围按直线距离筛选`
      if (pendingStation && selected.value === pendingStation && intentId === windowIntentId) loadStationPlans(pendingStation)
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
  window.addEventListener?.('storage', refreshSettings)
  map = new maplibregl.Map({
    container: mapEl.value, center: toMapCoordinate([113.8356, 34.0268]), zoom: 12,
    locale: { 'ScaleControl.Meters': '米', 'ScaleControl.Kilometers': '公里' },
    style: { version: 8, sources: {
      basemap: AMAP_STANDARD_SOURCE,
      'charging-radius': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      'charging-routes': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      'charging-stations': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    }, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#edf3ef' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
      { id: 'charging-radius-fill', type: 'fill', source: 'charging-radius', paint: { 'fill-color': '#60a5fa', 'fill-opacity': 0.18 } },
      { id: 'charging-radius-outline', type: 'line', source: 'charging-radius', paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-opacity': 0.85 } },
      { id: 'charging-routes-halo', type: 'line', source: 'charging-routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.85 } },
      { id: 'charging-routes-line', type: 'line', source: 'charging-routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['get', 'routeSelected'], '#2563eb', '#94a3b8'], 'line-width': ['case', ['get', 'routeSelected'], 5, 3] } },
      { id: 'charging-selected', type: 'circle', source: 'charging-stations', filter: ['==', ['get', '_key'], -1], paint: { 'circle-radius': 23, 'circle-color': '#1bb879', 'circle-opacity': 0.2 } },
      { id: 'charging-points', type: 'circle', source: 'charging-stations', paint: { 'circle-radius': 17, 'circle-color': chargingMapColor, 'circle-opacity': 0.01, 'circle-stroke-width': 0 } },
      { id: 'charging-bolts', type: 'symbol', source: 'charging-stations', layout: { 'icon-image': chargingMapIcon, 'icon-size': 1, 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
    ] },
  })
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left')
  resizeObserver = new ResizeObserver(() => { if (!disposed) map?.resize() })
  resizeObserver.observe(mapEl.value)
  map.on('load', async () => {
    if (disposed) return
    mapReady = true
    updateRadiusBuffer()
    updateRouteMap()
    registerChargingIcons(map)
    try {
      const response = await fetch('http://127.0.0.1:8000/api/stations', { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('无效站点数据')
      if (disposed) return
      stations.value = data.features.map(normalizeChargingPoint)
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
  // 用户端进入时请求真实位置；失败时保留定位重试按钮。
  locate()
})
onBeforeUnmount(() => {
  window.removeEventListener?.('storage', refreshSettings)
  disposed = true
  clearPlanning(true)
  routeRequestId++
  routeController?.abort()
  clearTimeout(routeTimer)
  controller.abort()
  resizeObserver?.disconnect()
  userMarker?.remove()
  placeMarker?.remove()
  map?.remove()
})
</script>

<template>
  <main class="charging-page" :class="{ 'recommendations-visible': recommendationsOpen }" aria-label="找充电" @click.capture="dismissChargingWindows" @keydown.esc="dismissChargingWindows()">
    <div ref="mapEl" class="charging-map"></div>
    <div class="charging-topbar">
      <div class="charging-search-wrap">
        <form class="charging-search" @submit.prevent="search">
          <a href="#/" class="charging-back" aria-label="返回供需分析界面" title="返回供需分析界面"><UiIcon name="chevron" :size="20" /></a>
          <UiIcon name="search" :size="20" />
          <input v-model="input" aria-label="搜索地点或充电站" placeholder="搜索地点 / 搜索充电站" />
          <button v-if="input" type="button" class="charging-clear" aria-label="清空搜索" @click="input = ''; keyword = ''; feedback = ''"><UiIcon name="close" :size="16" /></button>
          <button type="submit" class="charging-search-submit" :disabled="loading">搜索</button>
        </form>
        <a href="#/charging/demo" class="charging-demo-entry"><UiIcon name="compass" :size="17" />虚拟演示</a>
      </div>
      <div class="charging-filter-wrap">
        <div class="charging-filterbar" aria-label="充电站筛选">
          <button :class="{ chosen: chargeType === 'fast' }" :disabled="!hasFast" :title="hasFast ? '筛选快充站' : '暂无快充类型数据'" @click="toggleType('fast')"><UiIcon name="charge-fast" :size="18" class="charging-fast-symbol" />快充</button>
          <button class="charging-regular-filter" :class="{ chosen: chargeType === 'regular' }" :disabled="!hasRegular" :title="hasRegular ? '筛选普通充电站' : '暂无普通充电站'" @click="toggleType('regular')"><UiIcon name="charge-regular" :size="18" class="charging-regular-symbol" />普通充电</button>
          <button :class="{ chosen: radius > 0 }" :aria-expanded="filtersOpen" aria-controls="charging-filters" @click="filtersOpen = !filtersOpen">{{ radius ? `${radius} km` : '距离' }}<UiIcon name="chevron" :size="12" /></button>
          <button :class="{ chosen: availableOnly }" :disabled="!hasAvailability" :title="hasAvailability ? '只看有空闲桩的站点' : '暂无实时空闲数据'" @click="availableOnly = !availableOnly">空闲</button>
          <button :class="{ chosen: filtersOpen }" :aria-expanded="filtersOpen" aria-controls="charging-filters" @click="filtersOpen = !filtersOpen">更多筛选<UiIcon name="chevron" :size="12" /></button>
        </div>
        <section v-if="filtersOpen" id="charging-filters" class="charging-more" aria-label="更多筛选">
          <div class="charging-results-heading"><b>距离与偏好</b><button aria-label="关闭更多筛选" @click="filtersOpen = false"><UiIcon name="close" :size="17" /></button></div>
          <p>距离范围 <small>{{ locating ? '正在定位…' : location ? '直线距离' : '选择范围后定位' }}</small></p>
          <div class="charging-radius"><button v-for="item in [{value:0,label:'不限'},{value:1,label:'1 km'},{value:3,label:'3 km'},{value:5,label:'5 km'}]" :key="item.value" :disabled="!!item.value && locating" :class="{ chosen: radius === item.value }" @click="setRadius(item.value)">{{ item.label }}</button></div>
          <button v-if="!location" class="charging-filter-locate" :disabled="locating" @click="locate()"><UiIcon name="locate" :size="15" />{{ locating ? '正在定位…' : '定位查找附近充电站' }}</button>
          <p class="charging-data-note">可按快充、普通充电筛选。{{ syntheticCount ? '包含 ' + syntheticCount + ' 个虚拟演示站点。' : '' }}{{ supplementedCount ? supplementedCount + ' 个真实地点已补齐演示属性。' : '' }}{{ syntheticCount || supplementedCount ? '演示空闲、功率和费用以实测数据为准。' : hasAvailability ? '空闲数量以数据采集时间为准。' : '暂无实时空闲数据。' }}</p>
          <button class="charging-reset" @click="resetFilters">重置筛选</button>
        </section>
      </div>
    </div>
    <a href="#/charging/settings" class="charging-trip-entry" aria-label="打开车辆与出行设置"><UiIcon name="settings" :size="16" />充电设置<UiIcon name="chevron" :size="12" /></a>
    <div class="map-tools charging-controls" aria-label="地图工具">
      <button aria-label="放大地图" title="放大地图" @click="map?.zoomIn()"><UiIcon name="plus" :size="19" /></button>
      <button aria-label="缩小地图" title="缩小地图" @click="map?.zoomOut()"><UiIcon name="minus" :size="19" /></button>
      <button :disabled="locating" :class="{ active: location }" :aria-busy="locating" :aria-label="locating ? '定位中' : '定位当前位置'" :title="locating ? '定位中…' : location ? '重新定位' : '定位当前位置'" @click="locate()"><UiIcon name="locate" :size="19" /></button>
      <button v-if="location" :class="{ active: recommendationsOpen }" aria-label="显示推荐站点" title="显示推荐站点" :aria-expanded="recommendationsOpen" @click="recommendationsOpen = !recommendationsOpen"><UiIcon name="star" :size="19" /></button>
    </div>
    <ChargingRecommendations v-if="recommendationsOpen" :stations="recommendedStations" :status="routeStatus"
      :intent="tripIntent" :trip-context="tripContext" :destination-info="savedSettings.destinationInfo" :soc-updated-at="savedSettings.socUpdatedAt" :settings-notice="settingsNotice" :has-location="!!location"
      @intent="chooseIntent" @locate="locate()" @update-trip="updateTrip"
      :mode="recommendationMode" :weight="distanceWeight" :radius="radius" :charge-type="chargeType"
      :available-only="availableOnly" :has-fast="hasFast" :has-regular="hasRegular" :has-availability="hasAvailability" :metadata="recommendationMeta"
      :plans="routePlans" :planning-station="planningStationInfo" :selected-route-id="selectedRouteId" :route-focused="routeFocused"
      :active-station-id="String(highlightedStation?.properties.id ?? '')"
      @mode="recommendationMode = $event" @weight="distanceWeight = $event" @type="toggleType"
      @available="availableOnly = $event" @select="chooseRecommendation" @close="recommendationsOpen = false" @retry="loadRouteDistances(true)"
      @route="chooseRoute" @back="returnFromRoutes" @retry-route="loadStationPlans($event, true)" />
    <div class="charging-bottom">
      <div v-if="noticesVisible && locationError" class="charging-location-error" role="alert">
        <UiIcon name="alert" :size="17" /><span>{{ locationError }}</span><button :disabled="locating" @click="locate()">{{ locating ? '定位中…' : '重试' }}</button>
      </div>
      <section v-if="selected && !planningStation" class="charging-detail" aria-label="站点详情">
        <div class="charging-detail-heading"><span :class="['charging-detail-icon',selected.properties.chargeType]"><UiIcon :name="selected.properties.chargeType === 'fast' ? 'charge-fast' : 'charge-regular'" :size="27" /></span><div><small>{{ selected.properties.chargeType === 'fast' ? '快充站' : '普通充电站' }}{{ selected.properties.isSynthetic ? ' · 虚拟演示' : selected.properties.hasSimulatedAttributes ? ' · 属性含演示补全' : '' }}</small><h1>{{ selected.properties.name }}</h1></div><button aria-label="关闭站点详情" @click="selected = null"><UiIcon name="close" :size="20" /></button></div>
        <p class="charging-address"><UiIcon name="pin" :size="15" />{{ selected.properties.address || '地址暂无' }}</p>
        <StationQuickFacts :properties="{ ...selected.properties, ...selectedDistanceInfo }" :fit="selectedTripFit" />
        <div class="charging-detail-tags"><span v-if="selected.properties.availableCount != null">空闲 {{ selected.properties.availableCount }} 个</span><span v-if="selected.properties.powerKw != null">{{ selected.properties.powerKw }} kW</span><span v-if="selected.properties.openingHours">{{ selected.properties.openingHours }}</span></div>
        <p v-if="selected.properties.operator" class="charging-data-note">{{ selected.properties.operator }}</p>
        <div class="charging-detail-foot"><span>{{ selectedTripFit?.excluded ? '该站暂不适合本次充电' : selected.properties.parkingFee === 0 ? '停车免费' : selected.properties.parkingFee > 0 ? '停车 ' + selected.properties.parkingFee + ' 元/小时' : '' }}</span><button :disabled="selectedTripFit?.excluded || (!location && locating && pendingPlanningStation === selected)" @click="goToStation(selected)">{{ selectedTripFit?.excluded ? '暂不推荐' : !location && locating && pendingPlanningStation === selected ? '正在定位…' : '去这里' }}<UiIcon name="compass" :size="15" /></button></div>
      </section>
      <div v-if="noticesVisible && (!selected || feedback || dataError)" class="charging-map-caption" role="status">{{ dataError || feedback || (loading ? '正在加载充电站…' : `地图上有 ${visibleStations.length} 个站点，点击站点查看详情`) }}</div>
    </div>
    <section class="charging-type-legend" aria-label="充电类型图例">
      <h3>充电站图例</h3>
      <div class="charging-legend-items">
        <span><i class="fast" :class="{ 'type-hidden': chargeType === 'regular' }"><UiIcon name="charge-fast" :size="21" /></i><span>快充<small v-if="chargeType === 'regular'">已隐藏</small></span></span>
        <span><i class="regular" :class="{ 'type-hidden': chargeType === 'fast' }"><UiIcon name="charge-regular" :size="21" /></i><span>普通充电<small v-if="chargeType === 'fast'">已隐藏</small></span></span>
      </div>
    </section>
  </main>
</template>

<style scoped>
/* 找充电页沿用全局设计令牌，让两个页面看起来是同一个产品 */
.charging-page{position:relative;height:100dvh;min-height:480px;overflow:hidden;background:var(--surface-sunken);color:var(--ink-900)}
.charging-map{position:absolute;inset:0}

/* 搜索栏：胶囊 + 毛玻璃浮层 */
.charging-topbar{position:absolute;top:20px;left:20px;right:20px;z-index:5;display:grid;grid-template-columns:minmax(0,560px) minmax(0,430px);justify-content:space-between;align-items:start;gap:20px;pointer-events:none}
.charging-topbar>*{pointer-events:auto;min-width:0}
.charging-search-wrap{display:flex;align-items:center;gap:12px;min-width:0}
.charging-search-wrap .charging-search{flex:1;min-width:0}
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
.charging-trip-entry{position:absolute;left:20px;top:84px;z-index:4;display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(255,255,255,.97);border:1px solid #9fdcc0;border-radius:var(--r-pill);box-shadow:var(--shadow-1);color:var(--ok-600);font-size:12px;font-weight:600}
.charging-demo-entry{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:48px;padding:0 14px;border:1px solid var(--brand-200);border-radius:var(--r-pill);background:rgba(255,255,255,.97);box-shadow:var(--shadow-1);color:var(--brand-600);font-size:12px;font-weight:600;white-space:nowrap}
.charging-demo-entry:hover{background:var(--brand-50);color:var(--brand-700)}
.charging-demo-entry:focus-visible{outline:2px solid var(--brand-500);outline-offset:3px}

/* 顶部筛选与底部详情 */
.charging-bottom{position:absolute;bottom:132px;left:20px;width:430px;max-width:calc(100% - 40px);max-height:calc(100dvh - 222px);overflow-y:auto;z-index:3;display:flex;flex-direction:column;gap:9px;padding:3px}
.charging-bottom>*{flex-shrink:0}
.charging-filterbar{display:flex;min-height:48px;background:rgba(255,255,255,.96);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:var(--r-pill);box-shadow:var(--shadow-2);padding:6px}
.charging-filterbar button{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;background:none;border:0;border-radius:var(--r-xs);padding:8px 4px;font-size:12.5px;font-weight:600;color:var(--ink-700)}
.charging-filterbar button:hover:not(:disabled){background:var(--surface-muted)}
.charging-filterbar button:last-child{flex:1.4}
.charging-fast-symbol{color:#16a34a}.charging-regular-symbol{color:#2563eb}
.charging-filterbar .charging-regular-filter.chosen{color:var(--brand-600);background:var(--brand-50)}
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
.charging-detail>.charging-data-note{font-size:11px;line-height:1.7;color:var(--ink-500)}
.charging-detail-heading{display:flex;align-items:center;gap:12px}
.charging-detail-icon{width:42px;height:42px;flex:none;display:grid;place-items:center;background:var(--ok-50);color:var(--ok-600);border-radius:var(--r-md)}
.charging-detail-icon.regular{color:#2563eb;background:var(--brand-50)}
.charging-detail-heading>div{flex:1;min-width:0}
.charging-detail-heading small{font-size:11px;font-weight:600;color:var(--ink-400)}
.charging-detail h1{font-size:16px;font-weight:700;line-height:1.45;letter-spacing:-.2px;margin:3px 0 0;color:var(--ink-900)}
.charging-detail-heading>button{align-self:flex-start}
.charging-address{display:flex;align-items:flex-start;gap:5px;font-size:12px;color:var(--ink-500);line-height:1.6;margin:12px 0}
.charging-detail-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:13px;font-size:12px;color:var(--ink-500)}
.charging-detail-tags{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:14px 0 10px;font-size:11px;color:var(--ink-500)}.charging-detail-tags>span{padding:4px 7px;border-radius:5px;background:var(--surface-muted)}
.charging-detail-foot button{display:flex;align-items:center;gap:6px;color:white;background:var(--ok-600);border:0;border-radius:9px;font-size:13px;font-weight:600;padding:11px 18px}
.charging-map-caption{align-self:center;background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:var(--r-pill);padding:7px 15px;color:var(--ink-500);font-size:11px;box-shadow:var(--shadow-1)}
.charging-type-legend{position:absolute;left:20px;bottom:48px;z-index:4;width:230px;max-width:calc(100% - 40px);padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:rgba(255,255,255,.97);font-size:12px;color:var(--ink-700);box-shadow:var(--shadow-1)}
.charging-type-legend h3{margin:0 0 8px;color:var(--ink-500);font-size:11px;font-weight:700}
.charging-legend-items{display:flex;gap:18px;align-items:center}
.charging-legend-items>span{display:flex;align-items:center;gap:7px;white-space:nowrap}
.charging-legend-items small{display:block;margin-top:2px;color:var(--ink-400);font-size:10px}
.charging-type-legend i{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:8px;color:#fff;border:1.5px solid #fff;box-shadow:0 1px 4px rgba(15,43,80,.18)}.charging-type-legend .fast{background:#16a34a}.charging-type-legend .regular{background:#2563eb}.charging-type-legend .type-hidden{opacity:.5}

/* 定位标记与地图弹窗 */
.charging-page :deep(.maplibregl-ctrl-bottom-left){left:20px;bottom:16px}
.charging-page :deep(.maplibregl-ctrl-scale){margin:0;background:rgba(255,255,255,.75);border:2px solid var(--ink-800);border-top:0;color:var(--ink-900);text-align:center;font-size:11px;line-height:1.6;padding:0 5px;text-shadow:0 1px 2px #fff}
:global(.charging-user-marker){position:relative;width:18px;height:18px;border:3px solid #fff;border-radius:50%;background:var(--brand-500);box-shadow:0 0 0 8px rgba(31,122,240,.16),0 2px 8px rgba(15,43,80,.25)}
:global(.charging-position-label){position:absolute;bottom:26px;left:50%;transform:translateX(-50%);white-space:nowrap;padding:5px 10px;border-radius:var(--r-pill);background:#fff;border:1px solid var(--line);color:var(--brand-600);font-size:11.5px;font-weight:600;box-shadow:var(--shadow-2)}

@media(max-width:920px){
  .charging-topbar{grid-template-columns:minmax(0,1fr);gap:10px}
  .charging-filter-wrap .charging-more{max-height:calc(100dvh - 220px)}
  .charging-controls{top:146px}
  .charging-trip-entry{top:144px}
  .charging-bottom{max-height:calc(100dvh - 370px)}
}
@media(min-width:761px) and (max-width:920px){
  .charging-page.recommendations-visible .charging-bottom{width:calc(100% - 436px)}
}
@media(max-width:760px){
  .charging-page.recommendations-visible .charging-type-legend{display:none}
}
@media(max-width:400px){
  .charging-trip-entry{top:184px}
}
@media(max-width:600px){
  .charging-topbar{top:14px;left:12px;right:12px;gap:8px}
  .charging-search-wrap{gap:8px}
  .charging-search{gap:8px}
  .charging-bottom{left:12px;bottom:max(132px,calc(env(safe-area-inset-bottom) + 126px));max-width:calc(100% - 24px)}
  .charging-page :deep(.maplibregl-ctrl-bottom-left){left:12px;bottom:max(16px,env(safe-area-inset-bottom))}
  .charging-type-legend{left:12px;bottom:max(48px,calc(env(safe-area-inset-bottom) + 42px));max-width:calc(100% - 24px)}
  .charging-controls{right:12px;top:136px}
  .charging-trip-entry{left:12px}
  .charging-demo-entry{padding:0 10px;gap:4px}
  .charging-detail{padding:15px}
  .charging-detail h1{font-size:15px}
}
</style>
