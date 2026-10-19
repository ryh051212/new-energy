<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { circle, bbox } from '@turf/turf'
import UiIcon from './UiIcon.vue'
import MainNavigation from './MainNavigation.vue'
import ExplorerPanelHeading from './ExplorerPanelHeading.vue'
import ChargingRecommendations from './ChargingRecommendations.vue'
import NearbyChargingStations from './NearbyChargingStations.vue'
import DriverStationList from './DriverStationList.vue'
import StationQuickFacts from './StationQuickFacts.vue'
import { DEFAULT_TRIP, normalizeTripContext, rankTripStations, evaluateTripStation } from '../utils/tripCharging.js'
import { readChargingSettings, saveChargingSettings, normalizeIntent, CHARGING_SETTINGS_KEY } from '../utils/chargingSettings.js'
import { chargingMapIcon, chargingMapColor, registerChargingIcons } from '../utils/chargingIcons.js'
import { AMAP_STANDARD_SOURCE, toMapCoordinate, toMapGeoJSON } from '../utils/basemaps.js'
import { normalizeChargingPoint, selectChargingStations, chargingDistanceInfo, stationDistance, formatChargingDistance, stationMetric, rankChargingRecommendations, hasUsableDrivingRoute } from '../utils/charging.js'
import { chargingCompatibility, stationAvailability, isDemoField } from '../utils/stationInformation.js'

maplibregl.setWorkerUrl(workerUrl)
const mapEl = ref(null)
const toolbarEl = ref(null)
const toolbarHeight = ref(220)
const informationNow = ref(Date.now())
let informationTimer
const stations = ref([])
watch(stations, () => { informationNow.value = Date.now() }, { flush: 'sync' })
const places = ref([])
const placesLoading = ref(true)
const placesError = ref('')
const searchOpen = ref(false)
const selectedPlace = ref(null)
const nearbyPlace = ref(null)
const nearbyOpen = ref(false)
const panelMode = ref('stations')
const driverListOpen = ref(true)
const input = ref('')
const keyword = ref('')
const chargeType = ref('')
const availableOnly = ref(false)
const usableRoutesOnly = ref(false)
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

const searchCenter = computed(() => nearbyPlace.value?.geometry.coordinates || location.value)
const visibleStations = computed(() => selectChargingStations(stations.value, {
  keyword: keyword.value, type: chargeType.value, available: availableOnly.value,
  radius: radius.value, location: searchCenter.value, now: informationNow.value,
}))
const recommendationCandidates = computed(() => {
  if (!location.value) return []
  if (routeStatus.value === 'ready') {
    const features = routeRecommendations.value.map(feature => {
    const original = stations.value.find(station => String(station.properties.id) === String(feature.properties.id))
    return { ...feature, properties: { ...original?.properties, ...feature.properties, ...distanceInfo(feature) } }
  })
    return tripIntent.value ? rankTripStations(features, tripIntent.value, tripContext.value) : features
  }
  const features = visibleStations.value.map(station => ({ ...station,
    properties: { ...station.properties, ...distanceInfo(station) },
  }))
  return (tripIntent.value ? rankTripStations(features, tripIntent.value, tripContext.value)
    : rankChargingRecommendations(features, recommendationMode.value, distanceWeight.value / 100))
})
const filteredRouteCount = computed(() => recommendationCandidates.value
  .filter(station => !hasUsableDrivingRoute(station.properties)).length)
const recommendedStations = computed(() => (usableRoutesOnly.value
  ? recommendationCandidates.value.filter(station => hasUsableDrivingRoute(station.properties))
  : recommendationCandidates.value).slice(0, 5))
const radiusBuffer = computed(() => ({
  type: 'FeatureCollection',
  features: searchCenter.value && radius.value > 0
    ? [circle(searchCenter.value, radius.value, { units: 'kilometers', steps: 128 })] : [],
}))
const hasFast = computed(() => stations.value.some(station => station.properties?.chargeType === 'fast'))
const hasRegular = computed(() => stations.value.some(station => station.properties?.chargeType === 'regular'))
const hasAvailability = computed(() => stations.value.some(station => stationAvailability(station.properties, informationNow.value).hasRealtime))
const syntheticCount = computed(() => stations.value.filter(station => station.properties?.isSynthetic).length)
const supplementedCount = computed(() => stations.value.filter(station => !station.properties?.isSynthetic && station.properties?.hasSimulatedAttributes).length)
const placeResults = computed(() => {
  const query = input.value.trim().toLowerCase()
  return query ? places.value.filter(place => `${place.properties?.name || ''} ${place.properties?.address || ''}`.toLowerCase().includes(query)).slice(0, 8) : []
})
const stationResults = computed(() => input.value.trim()
  ? selectChargingStations(stations.value, { keyword: input.value }).slice(0, 8) : [])
const driverStations = computed(() => visibleStations.value.map(station => ({ ...station,
  properties: { ...station.properties, ...distanceInfo(station) },
})))
const selectedDistanceInfo = computed(() => selected.value ? distanceInfo(selected.value) : null)
const selectedCompatibility = computed(() => chargingCompatibility(selected.value?.properties, tripContext.value))
const planningStationInfo = computed(() => planningStation.value ? { ...planningStation.value,
  properties: { ...planningStation.value.properties, ...routeDistances.value.get(String(planningStation.value.properties.id)),
    ...distanceInfo(planningStation.value) } } : null)
const selectedTripFit = computed(() => selected.value && tripIntent.value ? evaluateTripStation({ ...selected.value,
  properties: { ...selected.value.properties, ...routeDistances.value.get(String(selected.value.properties.id)),
    ...selectedDistanceInfo.value } }, tripIntent.value, tripContext.value) : null)

function distanceInfo(station) {
  const plan = routePlans.value.get(String(station.properties.id))
  const plannedRoute = plan?.status === 'ready' ? (String(planningStation.value?.properties.id) === String(station.properties.id)
    ? plan.features.find(feature => feature.properties.routeId === selectedRouteId.value) : null) || plan.features[0] : null
  const planUnavailable = plan?.status === 'error' || (plan?.status === 'ready' && !plan.features.length)
  const info = chargingDistanceInfo(station, location.value,
    plannedRoute?.properties || (planUnavailable ? { ...plan.metadata, isFallback: true } : null)
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
      ? { top: Math.min(toolbarHeight.value + 40, window.innerHeight * 0.45), bottom: Math.round(window.innerHeight * 0.46), left: 30, right: 30 }
      : { top: 60, bottom: 80, left: 60, right: 60 }, maxZoom: 16, duration: 550 })
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
  if (chargingCompatibility(station.properties, tripContext.value).prohibited) return
  const id = String(station.properties.id)
  const [lng, lat] = location.value
  const key = `${lng},${lat}:${id}`
  recommendationsOpen.value = true
  nearbyOpen.value = false
  driverListOpen.value = false
  if (!force && planningController && planningRequestKey === key) return
  const cached = routePlans.value.get(id)
  clearPlanning()
  planningStation.value = station
  if (window.innerWidth <= 760) selected.value = null
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
  recommendationsOpen.value = !nearbyPlace.value || !!planningStation.value
  nearbyOpen.value = !!nearbyPlace.value && !planningStation.value
  driverListOpen.value = !planningStation.value && !nearbyPlace.value && panelMode.value === 'stations'
}
function goToStation(station) {
  if (!station || disposed) return
  if (chargingCompatibility(station.properties, tripContext.value).prohibited) return
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
  if (!event?.target?.closest?.('.charging-search-wrap')) filtersOpen.value = false
  if (event?.target?.closest?.('.site-header, .driver-sidebar, .charging-topbar, .charging-controls, .charging-bottom, .charging-recommendations, .charging-nearby, .charging-type-legend, .charging-demo-entry, .charging-trip-entry, .maplibregl-ctrl, .charging-user-marker, .maplibregl-marker, .maplibregl-popup')) return
  searchOpen.value = false
  const hadDetail = selected.value && !planningStation.value
  selected.value = null
  selectedPlace.value = null
  pendingPlanningStation.value = null
  if (hadDetail && window.innerWidth <= 760) {
    if (nearbyPlace.value) nearbyOpen.value = true
    else { driverListOpen.value = true; if (location.value) recommendationsOpen.value = true }
  }
}
function closeStationDetail() {
  selected.value = null
  pendingPlanningStation.value = null
  if (nearbyPlace.value) nearbyOpen.value = true
  else { driverListOpen.value = true; if (location.value) recommendationsOpen.value = true }
}
function openRecommendations() {
  clearPlanning()
  selected.value = null
  selectedPlace.value = null
  panelMode.value = 'recommendations'
  recommendationsOpen.value = true
  driverListOpen.value = false
}
function showStations() {
  clearPlanning()
  panelMode.value = 'stations'
  recommendationsOpen.value = false
  driverListOpen.value = !nearbyPlace.value
  nearbyOpen.value = !!nearbyPlace.value
  selected.value = null
}
function toggleStationList() {
  if (nearbyPlace.value && !planningStation.value) nearbyOpen.value = !nearbyOpen.value
  else if (planningStation.value || panelMode.value === 'recommendations') showStations()
  else {
    driverListOpen.value = !driverListOpen.value
    if (driverListOpen.value) { selected.value = null; pendingPlanningStation.value = null }
  }
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
  if (disposed || !location.value || nearbyPlace.value) return
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
    padding: window.innerWidth <= 760
      ? { top: Math.min(toolbarHeight.value + 40, window.innerHeight * 0.45), bottom: Math.round(window.innerHeight * 0.43), left: 30, right: 30 }
      : { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 14, duration: 550,
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
  searchOpen.value = false
  selectedPlace.value = null
  if (window.innerWidth <= 760) { recommendationsOpen.value = false; nearbyOpen.value = false; driverListOpen.value = false }
  map?.flyTo({ center: toMapCoordinate(station.geometry.coordinates), zoom: Math.max(map.getZoom(), 14),
    offset: window.innerWidth <= 760 ? [0, -Math.round(window.innerHeight * 0.26)] : [0, 0], duration: 550 })
}
function chooseRecommendation(station) {
  const original = stations.value.find(feature => String(feature.properties.id) === String(station.properties.id))
  if (original) chooseStation(original)
  else feedback.value = '站点数据尚未加载完成，请稍后重试'
}
function search() {
  clearPlanning()
  exitNearby(false)
  noticesVisible.value = true
  keyword.value = input.value.trim()
  feedback.value = ''
  filtersOpen.value = false
  selected.value = null
  panelMode.value = 'stations'
  driverListOpen.value = true
  searchOpen.value = !!keyword.value
  if (!keyword.value) return
  // 有地物匹配时展示供选择的结果，避免把同名的第一个地点当作目的地。
  if (placeResults.value.length) return
  if (visibleStations.value.length === 1) chooseStation(visibleStations.value[0])
  else if (visibleStations.value.length > 1) {
    const bounds = new maplibregl.LngLatBounds()
    visibleStations.value.forEach(station => bounds.extend(toMapCoordinate(station.geometry.coordinates)))
    map?.fitBounds(bounds, { padding: 90, maxZoom: 14, duration: 550 })
  } else feedback.value = '未找到匹配结果，试试地点名称、站名或地址'
}
function choosePlace(place) {
  clearPlanning()
  exitNearby(false)
  windowIntentId++
  selected.value = null
  selectedPlace.value = place
  searchOpen.value = false
  filtersOpen.value = false
  recommendationsOpen.value = false
  driverListOpen.value = window.innerWidth > 760
  panelMode.value = 'stations'
  placeMarker?.remove()
  placeMarker = new maplibregl.Marker({ color: '#337df0' }).setLngLat(toMapCoordinate(place.geometry.coordinates)).addTo(map)
  input.value = place.properties?.name || ''
  keyword.value = ''
  map.flyTo({ center: toMapCoordinate(place.geometry.coordinates), zoom: 14, duration: 550 })
  feedback.value = `已定位到 ${place.properties?.name || '所选地点'}`
}
function chooseSearchStation(station) {
  exitNearby(false)
  resetFilters()
  input.value = station.properties.name
  keyword.value = station.properties.name
  feedback.value = ''
  chooseStation(station)
}
function findNearby() {
  if (!selectedPlace.value) return
  clearPlanning(true)
  windowIntentId++
  routeRequestId++
  routeController?.abort()
  clearTimeout(routeTimer)
  routeRequestKey = ''
  routeDistances.value = new Map()
  routeRecommendations.value = []
  recommendationMeta.value = null
  routeStatus.value = 'idle'
  keyword.value = ''
  selected.value = null
  nearbyPlace.value = selectedPlace.value
  selectedPlace.value = null
  radius.value = 1
  pendingRadius = null
  searchOpen.value = false
  recommendationsOpen.value = false
  nearbyOpen.value = true
  driverListOpen.value = false
  panelMode.value = 'stations'
  feedback.value = ''
  updateMap()
  focusRadiusBuffer()
}
function exitNearby(refresh = true) {
  const wasNearby = !!nearbyPlace.value
  nearbyPlace.value = null
  nearbyOpen.value = false
  selectedPlace.value = null
  placeMarker?.remove()
  placeMarker = null
  if (wasNearby) {
    clearPlanning(true)
    radius.value = 0
    recommendationsOpen.value = !!location.value
    driverListOpen.value = true
    panelMode.value = 'stations'
    if (refresh) {
      loadRouteDistances(true)
      if (location.value) map?.flyTo({ center: toMapCoordinate(location.value), zoom: 14, duration: 550 })
    }
  }
}
function clearSearch() {
  input.value = ''
  keyword.value = ''
  feedback.value = ''
  searchOpen.value = false
  selected.value = null
  pendingPlanningStation.value = null
  exitNearby()
  driverListOpen.value = true
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
  if (value > 0 && !searchCenter.value) {
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
      recommendationsOpen.value = !!pendingStation || (!nearbyPlace.value && !selectedPlace.value && intentId === windowIntentId && !(selected.value && window.innerWidth <= 760))
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
      else if (selectedPlace.value) map.flyTo({ center: toMapCoordinate(selectedPlace.value.geometry.coordinates), zoom: 14, duration: 550 })
      else if (nearbyPlace.value && !radius.value) map.flyTo({ center: toMapCoordinate(nearbyPlace.value.geometry.coordinates), zoom: 14, duration: 550 })
      else if (radius.value > 0) focusRadiusBuffer()
      else map.flyTo({ center: toMapCoordinate(location.value), zoom: 14, duration: 550 })
      if (!nearbyPlace.value && !selectedPlace.value) feedback.value = `已标记当前位置${locationAccuracy.value === null ? '' : ` · 精度约 ${locationAccuracy.value} m`} · 范围按直线距离筛选`
      if (pendingStation && selected.value === pendingStation) loadStationPlans(pendingStation)
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
  informationTimer = setInterval(() => { informationNow.value = Date.now() }, 30000)
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
      { id: 'charging-selected', type: 'circle', source: 'charging-stations', filter: ['==', ['get', '_key'], -1], paint: { 'circle-radius': 23, 'circle-color': '#0f9f6e', 'circle-opacity': 0.18 } },
      { id: 'charging-points', type: 'circle', source: 'charging-stations', paint: { 'circle-radius': 17, 'circle-color': chargingMapColor, 'circle-opacity': 0.01, 'circle-stroke-width': 0 } },
      { id: 'charging-bolts', type: 'symbol', source: 'charging-stations', layout: { 'icon-image': chargingMapIcon, 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.92, 14, 1, 16, 1.1], 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
    ] },
  })
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left')
  resizeObserver = new ResizeObserver(() => {
    if (disposed) return
    map?.resize()
    toolbarHeight.value = toolbarEl.value?.getBoundingClientRect().height || 220
  })
  resizeObserver.observe(mapEl.value)
  if (toolbarEl.value) resizeObserver.observe(toolbarEl.value)
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
    const seen = new Set()
    places.value = results.flatMap(result => result.status === 'fulfilled' ? result.value.features || [] : [])
      .map(normalizeChargingPoint)
      .filter(feature => {
        const coordinates = feature.geometry?.coordinates
        if (feature.geometry?.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2
          || !coordinates.every((value, index) => Number.isFinite(value) && Math.abs(value) <= (index ? 90 : 180))) return false
        const id = String(feature.properties?.id ?? `${feature.properties?.name}|${coordinates}`)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
    placesLoading.value = false
    if (results.some(result => result.status === 'rejected')) placesError.value = places.value.length
      ? '部分地点数据加载失败，当前只显示已加载地点' : '地点数据加载失败，请刷新重试'
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
  clearInterval(informationTimer)
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
  <main class="charging-page driver-mode" data-mode="driver" :style="{ '--driver-toolbar-height': toolbarHeight + 'px' }" :class="{ 'driver-panel-visible': driverListOpen || nearbyOpen || (recommendationsOpen && (panelMode === 'recommendations' || planningStation)) }" aria-label="车主模式找充电" @click.capture="dismissChargingWindows" @keydown.esc="dismissChargingWindows()">
    <MainNavigation route="/charging">
    <template #search>
    <div class="charging-topbar">
      <div class="charging-search-wrap">
        <form class="charging-search" @submit.prevent="search">
          <UiIcon name="search" :size="20" />
          <input v-model="input" aria-label="搜索地点或充电站" placeholder="搜索地点 / 搜索充电站" aria-controls="charging-search-results" :aria-expanded="searchOpen && !!input.trim()" @focus="searchOpen = true; filtersOpen = false" @input="searchOpen = true; filtersOpen = false" />
          <button v-if="input || nearbyPlace" type="button" class="charging-clear" aria-label="清空搜索" @click="clearSearch"><UiIcon name="close" :size="16" /></button>
          <button type="submit" class="charging-search-submit" :disabled="loading && placesLoading">搜索</button>
        </form>
        <button class="search-filter-toggle" :class="{ active: filtersOpen || chargeType || radius || availableOnly }" aria-label="筛选充电站" :aria-expanded="filtersOpen" aria-controls="charging-filters" @click="filtersOpen = !filtersOpen; searchOpen = false"><UiIcon name="settings" :size="19" /><span>筛选</span><i v-if="chargeType || radius || availableOnly" aria-label="筛选已生效"></i></button>
        <section v-if="filtersOpen" id="charging-filters" class="search-filter-panel charging-more" aria-label="充电站筛选">
          <div class="charging-results-heading"><b>筛选充电站</b><button aria-label="关闭筛选" @click="filtersOpen = false"><UiIcon name="close" :size="17" /></button></div>
          <div class="charging-filterbar" aria-label="充电类型与状态">
            <button :class="{ chosen: chargeType === 'fast' }" :disabled="!hasFast" :title="hasFast ? '筛选快充站' : '暂无快充类型数据'" @click="toggleType('fast')"><UiIcon name="charge-fast" :size="18" class="charging-fast-symbol" />快充</button>
            <button class="charging-regular-filter" :class="{ chosen: chargeType === 'regular' }" :disabled="!hasRegular" :title="hasRegular ? '筛选普通充电站' : '暂无普通充电站'" @click="toggleType('regular')"><UiIcon name="charge-regular" :size="18" class="charging-regular-symbol" />普通充电</button>
            <button :class="{ chosen: availableOnly }" :disabled="!hasAvailability && !availableOnly" :title="availableOnly ? '取消实时空闲筛选' : hasAvailability ? '只看有实时空闲桩的站点' : '没有实时数据'" @click="availableOnly = !availableOnly">空闲</button>
          </div>
          <p>距离范围 <small>{{ nearbyPlace ? '以所选地点为中心 · 直线距离' : locating ? '正在定位…' : location ? '直线距离' : '选择范围后定位' }}</small></p>
          <div class="charging-radius"><button v-for="item in [{value:0,label:'不限'},{value:1,label:'1 km'},{value:3,label:'3 km'},{value:5,label:'5 km'}]" :key="item.value" :disabled="!!item.value && locating && !nearbyPlace" :class="{ chosen: radius === item.value }" @click="setRadius(item.value)">{{ item.label }}</button></div>
          <button v-if="!searchCenter" class="charging-filter-locate" :disabled="locating" @click="locate()"><UiIcon name="locate" :size="15" />{{ locating ? '正在定位…' : '定位查找附近充电站' }}</button>
          <p class="charging-data-note">快充分类不能确定直流／交流。空闲筛选仅使用运营方标记为实时、5 分钟内更新的状态。{{ syntheticCount ? '包含 ' + syntheticCount + ' 个虚拟演示站点。' : '' }}{{ supplementedCount ? supplementedCount + ' 个地点含演示属性。' : '' }}</p>
          <details class="driver-more-menu"><summary>充电图例<UiIcon name="chevron" :size="11" /></summary><div class="driver-more-content">
          <section class="charging-type-legend" aria-label="充电类型图例"><h3>充电站图例</h3><div class="charging-legend-items"><span><i class="fast" :class="{ 'type-hidden': chargeType === 'regular' }"><UiIcon name="charge-fast" :size="21" /></i><span>快充<small v-if="chargeType === 'regular'">已隐藏</small></span></span><span><i class="regular" :class="{ 'type-hidden': chargeType === 'fast' }"><UiIcon name="charge-regular" :size="21" /></i><span>普通充电<small v-if="chargeType === 'fast'">已隐藏</small></span></span></div></section></div></details>
          <button class="charging-reset" @click="resetFilters">重置筛选</button>
        </section>
        <section v-if="searchOpen && input.trim()" id="charging-search-results" class="charging-search-results" aria-label="搜索结果">
          <div class="charging-results-heading"><b>搜索结果</b><button aria-label="关闭搜索结果" @click="searchOpen = false"><UiIcon name="close" :size="17" /></button></div>
          <template v-if="placeResults.length">
            <h3>地点</h3>
            <button v-for="place in placeResults" :key="place.properties.id || place.properties.name" class="charging-search-result" @click="choosePlace(place)"><UiIcon name="pin" :size="18" /><span><b>{{ place.properties.name }}</b><small>{{ place.properties.address || '地址暂无' }}</small></span><UiIcon name="chevron" :size="12" /></button>
          </template>
          <template v-if="stationResults.length">
            <h3>充电站</h3>
            <button v-for="station in stationResults" :key="station.properties.id" class="charging-search-result" @click="chooseSearchStation(station)"><UiIcon name="bolt" :size="18" /><span><b>{{ station.properties.name }}</b><small>{{ station.properties.address || '地址暂无' }}</small></span><UiIcon name="chevron" :size="12" /></button>
          </template>
          <p v-if="placesLoading" role="status">正在加载地点…</p>
          <p v-else-if="placesError" role="status">{{ placesError }}</p>
          <p v-if="!placesLoading && !placeResults.length && !stationResults.length">未找到匹配结果，试试地点名称、站名或地址。</p>
          <small class="charging-search-scope">地点搜索覆盖项目内的小区与商业地点。</small>
        </section>
      </div>
    </div>
    </template>
    </MainNavigation>
    <div ref="mapEl" class="charging-map"></div>
    <aside class="driver-sidebar explorer-panel" aria-label="车主找桩侧栏">
    <div ref="toolbarEl" class="driver-toolbar">
      <ExplorerPanelHeading label="EXPLORE · 车主模式" title="发现附近充电站" description="找到适合你的站点，查看信息与出行路线。"><a href="#/charging/settings" class="charging-trip-entry" aria-label="打开车辆与出行设置" title="充电设置"><UiIcon name="settings" :size="19" /></a></ExplorerPanelHeading>
    </div>
    <div class="driver-panels explorer-panel-body">
    <div v-if="noticesVisible && locationError" class="charging-location-error" role="alert">
      <UiIcon name="alert" :size="17" /><span>{{ locationError }}</span><button :disabled="locating" @click="locate()">{{ locating ? '定位中…' : '重试' }}</button>
    </div>
    <div id="driver-results" aria-label="充电站列表与推荐">
    <button v-if="panelMode === 'recommendations' && !planningStation" class="driver-return" @click="showStations"><UiIcon name="chevron" :size="12" />返回站点列表</button>
    <ChargingRecommendations v-if="recommendationsOpen && (panelMode === 'recommendations' || planningStation)" :stations="recommendedStations" :status="routeStatus"
      :intent="tripIntent" :trip-context="tripContext" :now="informationNow" :destination-info="savedSettings.destinationInfo" :soc-updated-at="savedSettings.socUpdatedAt" :settings-notice="settingsNotice" :has-location="!!location"
      @intent="chooseIntent" @locate="locate()" @update-trip="updateTrip"
      :mode="recommendationMode" :weight="distanceWeight" :radius="radius" :charge-type="chargeType"
      :available-only="availableOnly" :has-fast="hasFast" :has-regular="hasRegular" :has-availability="hasAvailability" :metadata="recommendationMeta"
      :usable-routes-only="usableRoutesOnly" :filtered-route-count="filteredRouteCount" @usable-routes="usableRoutesOnly = $event"
      :plans="routePlans" :planning-station="planningStationInfo" :selected-route-id="selectedRouteId" :route-focused="routeFocused"
      :active-station-id="String(highlightedStation?.properties.id ?? '')"
      @mode="recommendationMode = $event" @weight="distanceWeight = $event" @type="toggleType"
      @available="availableOnly = $event" @select="chooseRecommendation" @close="showStations" @retry="loadRouteDistances(true)"
      @route="chooseRoute" @back="returnFromRoutes" @retry-route="loadStationPlans($event, true)" />
    <NearbyChargingStations v-if="nearbyPlace && nearbyOpen && !planningStation" :place="nearbyPlace" :stations="driverStations" :trip-context="tripContext" :now="informationNow" :radius="radius" :loading="loading" :error="dataError" :has-location="!!location"
      :active-station-id="String(highlightedStation?.properties.id ?? '')" @radius="setRadius" @select="chooseRecommendation" @close="nearbyOpen = false" @exit="clearSearch" />
    <DriverStationList v-if="driverListOpen && !nearbyPlace && !planningStation && panelMode === 'stations'" :stations="driverStations" :trip-context="tripContext" :now="informationNow" :active-station-id="String(highlightedStation?.properties.id ?? '')" :has-location="!!location" :loading="loading" :error="dataError" :locating="locating" @select="chooseRecommendation" @locate="locate()" @recommend="openRecommendations" />
    </div>
    </div>
    <div class="explorer-panel-foot"><UiIcon name="pin" :size="13" />许昌 · {{ visibleStations.length }} 个站点<span>找充电</span></div>
    </aside>
    <div class="map-tools charging-controls" aria-label="地图工具">
      <button aria-label="放大地图" title="放大地图" @click="map?.zoomIn()"><UiIcon name="plus" :size="19" /></button>
      <button aria-label="缩小地图" title="缩小地图" @click="map?.zoomOut()"><UiIcon name="minus" :size="19" /></button>
      <button :disabled="locating" :class="{ active: location }" :aria-busy="locating" :aria-label="locating ? '定位中' : '定位当前位置'" :title="locating ? '定位中…' : location ? '重新定位' : '定位当前位置'" @click="locate()"><UiIcon name="locate" :size="19" /></button>
      <button :class="{ active: driverListOpen || nearbyOpen }" :aria-label="nearbyPlace ? '显示周边站点' : '显示站点列表'" :title="nearbyPlace ? '显示周边站点' : '显示站点列表'" :aria-expanded="driverListOpen || nearbyOpen" @click="toggleStationList"><UiIcon name="layers" :size="19" /></button>
    </div>
    <a href="#/charging/demo" class="charging-demo-entry driver-sandbox-entry" aria-label="打开虚拟沙盘"><UiIcon name="layers" :size="19" />虚拟沙盘<UiIcon name="chevron" :size="14" /></a>
    <div class="charging-bottom">
      <section v-if="selectedPlace && !selected" class="charging-place-detail charging-detail" aria-label="地点详情">
        <div class="charging-detail-heading"><span class="charging-detail-icon"><UiIcon name="pin" :size="24" /></span><div><small>所选地点</small><h1>{{ selectedPlace.properties.name }}</h1></div><button aria-label="关闭地点详情" @click="selectedPlace = null"><UiIcon name="close" :size="20" /></button></div>
        <p class="charging-address"><UiIcon name="pin" :size="15" />{{ selectedPlace.properties.address || '地址暂无' }}</p>
        <div class="charging-detail-foot"><span>以这个地点为中心查找</span><button @click="findNearby">寻找周围充电站<UiIcon name="bolt" :size="15" /></button></div>
      </section>
      <section v-if="selected" class="charging-detail" role="dialog" aria-modal="false" aria-label="站点详情">
        <div class="charging-detail-heading"><span :class="['charging-detail-icon',selected.properties.chargeType]"><UiIcon :name="selected.properties.chargeType === 'fast' ? 'charge-fast' : 'charge-regular'" :size="27" /></span><div><small>{{ selected.properties.chargeType === 'fast' ? '快充站' : '普通充电站' }}{{ selected.properties.isSynthetic ? ' · 虚拟演示' : selected.properties.hasSimulatedAttributes ? ' · 属性含演示补全' : '' }}</small><h1>{{ selected.properties.name }}</h1></div><button aria-label="关闭站点详情" @click="closeStationDetail"><UiIcon name="close" :size="20" /></button></div>
        <p class="charging-address"><UiIcon name="pin" :size="15" />{{ selected.properties.address || '地址暂无' }}</p>
        <p v-if="nearbyPlace" class="charging-data-note">距 {{ nearbyPlace.properties.name }} {{ formatChargingDistance(stationDistance(selected, nearbyPlace.geometry.coordinates) * 1000) }}（直线）</p>
        <StationQuickFacts :properties="{ ...selected.properties, ...selectedDistanceInfo }" :fit="selectedTripFit" :context="tripContext" :now="informationNow" />
        <div class="charging-detail-tags"><span v-if="selected.properties.powerKw > 0 && !isDemoField(selected.properties, 'powerKw')">标称 {{ selected.properties.powerKw }} kW</span><span v-if="selected.properties.openingHours && !isDemoField(selected.properties, 'openingHours')">营业时间 {{ selected.properties.openingHours }}</span></div>
        <p v-if="selected.properties.operator && !isDemoField(selected.properties, 'operator')" class="charging-data-note">运营方 {{ selected.properties.operator }}</p>
        <div class="charging-detail-foot"><span>{{ selectedCompatibility.prohibited ? '不符合本车充电需求' : selectedTripFit?.excluded ? '该站暂不适合本次充电' : '查看实际路线后决定是否前往' }}</span><button :disabled="selectedCompatibility.prohibited || selectedTripFit?.excluded || (!location && locating && pendingPlanningStation === selected)" @click="goToStation(selected)">{{ selectedCompatibility.prohibited ? '禁止充电' : selectedTripFit?.excluded ? '暂不推荐' : !location && locating && pendingPlanningStation === selected ? '正在定位…' : '查看路线' }}<UiIcon name="compass" :size="15" /></button></div>
      </section>
      <div v-if="noticesVisible && (!selected || feedback || dataError)" class="charging-map-caption" role="status">{{ dataError || feedback || (loading ? '正在加载充电站…' : `地图上有 ${visibleStations.length} 个站点，点击站点查看详情`) }}</div>
    </div>
  </main>
</template>

<style scoped>
.driver-mode .driver-sandbox-entry{position:absolute;right:24px;bottom:max(24px,env(safe-area-inset-bottom));z-index:6;display:flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border:1px solid var(--brand-600);border-radius:var(--r-pill);background:var(--brand-600);color:#fff;font-size:13px;font-weight:600;box-shadow:var(--shadow-2);text-decoration:none}
.driver-sandbox-entry>svg:last-child{transform:rotate(-90deg)}
.driver-mode .driver-sandbox-entry:hover{background:var(--brand-700);border-color:var(--brand-700)}
.driver-sandbox-entry:focus-visible{outline:3px solid var(--brand-200);outline-offset:3px}
.charging-page.driver-mode .charging-bottom{bottom:calc(max(24px,env(safe-area-inset-bottom)) + 56px);max-height:calc(100dvh - var(--header-h) - 104px)}
@media(max-width:760px){
  .driver-mode .driver-sandbox-entry{right:12px;bottom:max(12px,env(safe-area-inset-bottom));padding:0 14px;font-size:12px}
  .charging-page.driver-mode .driver-sidebar.explorer-panel{bottom:calc(max(12px,env(safe-area-inset-bottom)) + 56px);max-height:min(52dvh,calc(100dvh - var(--header-h) - 100px))}
  .charging-page.driver-mode .charging-bottom{bottom:calc(max(12px,env(safe-area-inset-bottom)) + 56px);max-height:calc(100dvh - var(--header-h) - 100px)}
}
/* 将列表顶部留白放进吸顶标题，滚动时标题与容器上沿连续覆盖。 */
.driver-panels:has(>.driver-stations){padding-top:0}
.driver-panels :deep(.driver-stations>header){padding-top:26px}
@media(max-width:760px){.driver-panels :deep(.driver-stations>header){padding-top:22px}}
.driver-mode{--driver-sidebar-width:380px;position:relative;height:100dvh;min-height:480px;overflow:hidden;background:var(--surface-sunken);color:var(--ink-900)}
.charging-map{position:absolute;inset:0 0 0 var(--driver-sidebar-width)}
.driver-sidebar{position:relative;z-index:5;display:flex;flex-direction:column;width:var(--driver-sidebar-width);height:100%;background:var(--surface);border-right:1px solid var(--line);box-shadow:3px 0 14px rgba(15,43,80,.04);min-width:0}
.driver-toolbar{flex:none;padding:20px 18px 12px;border-bottom:1px solid var(--line);position:relative;z-index:2;background:var(--surface)}
.driver-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:18px}.driver-heading>div{display:flex;align-items:center;gap:10px}.driver-brand{display:grid;place-items:center;flex:none}.driver-heading small{display:block;font-size:10px;color:var(--ok-600);margin-bottom:3px}.driver-heading h1{font-size:20px;line-height:1.2;margin:0}.driver-heading nav{display:flex;align-items:center;gap:12px}.charging-trip-entry{display:grid;place-items:center;padding:6px;color:var(--ink-500);border-radius:8px}.charging-trip-entry:hover{background:var(--ok-50);color:var(--ok-600)}.driver-analysis-link{display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;color:var(--ink-500)}.driver-analysis-link>svg{transform:rotate(-90deg)}
.charging-topbar{display:flex;flex-direction:column;gap:10px}.charging-search-wrap{position:relative;min-width:0}.charging-search{display:flex;align-items:center;gap:8px;min-height:46px;padding:5px 5px 5px 12px;background:var(--surface-muted);border:1px solid var(--line);border-radius:var(--r-pill);color:var(--ink-400)}.charging-search:focus-within{border-color:var(--brand-200);box-shadow:var(--focus)}.charging-search input{flex:1;width:0;min-width:0;border:0;background:none;font-size:13px;outline:none;color:var(--ink-900)}.charging-search input::placeholder{color:var(--ink-400)}.charging-search-submit{flex:none;border:0;border-radius:var(--r-pill);padding:8px 14px;background:var(--ok-600);color:#fff;font-size:12px;font-weight:600}
.charging-clear,.charging-results-heading button,.charging-detail-heading>button{display:grid;place-items:center;border:0;background:none;color:var(--ink-400);padding:4px;border-radius:50%}.charging-clear:hover,.charging-results-heading button:hover,.charging-detail-heading>button:hover{background:var(--surface-muted);color:var(--ink-700)}
.charging-search-results{position:absolute;left:0;right:0;top:54px;z-index:8;max-height:min(440px,calc(100dvh - 190px));overflow-y:auto;padding:12px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--shadow-2)}.charging-search-results h3{margin:10px 4px 4px;font-size:11px;color:var(--ink-500)}.charging-search-results p,.charging-search-scope{font-size:11px;line-height:1.7;color:var(--ink-500)}.charging-search-scope{display:block;margin:10px 4px 0}.charging-search-result{display:flex;align-items:center;gap:10px;width:100%;padding:11px 6px;background:none;border:0;border-radius:var(--r-sm);text-align:left;color:var(--ink-600)}.charging-search-result:hover,.charging-search-result:focus-visible{background:var(--brand-50);color:var(--brand-600)}.charging-search-result>span{flex:1;min-width:0;overflow-wrap:anywhere}.charging-search-result b{display:block;font-size:12px;color:var(--ink-800)}.charging-search-result small{display:block;margin-top:4px;font-size:11px;color:var(--ink-500);line-height:1.5}.charging-search-result>svg:last-child{transform:rotate(-90deg)}
.charging-filter-wrap{position:relative}.charging-filterbar{display:flex;align-items:center;gap:3px}.charging-filterbar button{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;padding:9px 3px;white-space:nowrap;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);font-size:12px;color:var(--ink-700)}.charging-fast-symbol{color:var(--ok-500)}.charging-regular-symbol{color:#2563eb}.charging-filterbar button.chosen{color:var(--ok-600);background:var(--ok-50);border-color:#9fdcc0}.charging-filterbar .charging-regular-filter.chosen{color:var(--brand-600);background:var(--brand-50);border-color:var(--brand-200)}button:disabled{cursor:not-allowed;opacity:.45}
.charging-more{position:absolute;top:48px;left:0;right:0;z-index:7;padding:16px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--shadow-2);max-height:calc(100dvh - 240px);overflow-y:auto}.charging-results-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--ink-800);margin-bottom:10px}.charging-more p{font-size:12px;color:var(--ink-700)}.charging-more small{display:block;margin-top:5px;font-size:10px;color:var(--ink-500);line-height:1.6}.charging-radius{display:flex;gap:6px;margin:8px 0}.charging-radius button{flex:1;padding:8px 4px;border:1px solid var(--line);border-radius:6px;background:var(--surface-muted);color:var(--ink-600);font-size:12px}.charging-radius button.chosen{background:var(--ok-50);border-color:#9fdcc0;color:var(--ok-600)}.charging-filter-locate{display:flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid var(--brand-200);border-radius:6px;background:var(--brand-50);color:var(--brand-600);font-size:11px}.charging-reset{border:0;background:none;padding:4px 0;color:var(--ok-600);font-size:12px}.charging-more .charging-data-note{font-size:10px;line-height:1.8;color:var(--ink-500);margin-top:10px}
.driver-more-menu{position:relative;margin-top:8px;color:var(--ink-500);font-size:11px}.driver-more-menu>summary{display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:4px 0;cursor:pointer;list-style:none}.driver-more-menu>summary::-webkit-details-marker{display:none}.driver-more-content{position:absolute;right:0;top:26px;z-index:8;width:230px;padding:12px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-2)}.charging-demo-entry{display:flex;align-items:center;gap:6px;padding:6px 0;color:var(--brand-600);font-size:12px}.charging-type-legend{padding-top:10px;border-top:1px solid var(--line);margin-top:8px}.charging-type-legend h3{margin:0 0 10px;font-size:10px;color:var(--ink-500)}.charging-legend-items{display:flex;gap:15px;align-items:center}.charging-legend-items>span{display:flex;align-items:center;gap:6px;white-space:nowrap}.charging-legend-items small{display:block;margin-top:2px;font-size:9px;color:var(--ink-400)}.charging-type-legend i{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:9px;color:#fff;box-shadow:0 2px 6px rgba(16,24,40,.14)}.charging-type-legend .fast{background:linear-gradient(140deg,#3ddc97,#0f9f6e)}.charging-type-legend .regular{background:linear-gradient(140deg,#60a5fa,#2563eb)}.charging-type-legend .type-hidden{opacity:.45;filter:grayscale(.3)}
.driver-panels{flex:1;min-height:0;overflow-y:auto;padding:18px;scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}.driver-panels :deep(.charging-recommendations),.driver-panels :deep(.charging-nearby){position:static;width:auto;max-width:none;max-height:none;padding:0;border:0;border-radius:0;box-shadow:none;background:transparent;backdrop-filter:none}.driver-return{display:flex;align-items:center;gap:4px;padding:0 0 14px;border:0;background:none;font-size:11px;color:var(--ok-600)}.driver-return svg{transform:rotate(90deg)}
.charging-controls{right:20px;top:20px;bottom:auto;z-index:4}.charging-bottom{position:absolute;right:20px;bottom:24px;width:420px;max-width:calc(100% - var(--driver-sidebar-width) - 40px);max-height:calc(100dvh - 100px);overflow-y:auto;z-index:4;display:flex;flex-direction:column;gap:9px;padding:3px}.charging-bottom>*{flex-shrink:0}.charging-detail{padding:18px;border:1px solid var(--line);border-radius:var(--r-lg);background:rgba(255,255,255,.98);box-shadow:var(--shadow-2)}.charging-detail-heading{display:flex;align-items:center;gap:12px}.charging-detail-icon{width:42px;height:42px;flex:none;display:grid;place-items:center;background:var(--ok-50);color:var(--ok-600);border-radius:var(--r-md)}.charging-detail-icon.fast{color:var(--ok-600);background:var(--ok-50)}.charging-detail-icon.regular{color:#2563eb;background:#eff6ff}.charging-detail-heading>div{flex:1;min-width:0}.charging-detail small{font-size:10px;color:var(--ink-500)}.charging-detail h1{font-size:17px;line-height:1.6;margin:3px 0 0;overflow-wrap:anywhere}.charging-address{display:flex;align-items:flex-start;gap:6px;margin:11px 0;font-size:12px;line-height:1.7;color:var(--ink-600);overflow-wrap:anywhere}.charging-address svg{flex:none;margin-top:3px}.charging-detail-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;font-size:11px;color:var(--ink-500)}.charging-detail-tags>span{background:var(--surface-muted);padding:4px 7px;border-radius:5px}.charging-detail>.charging-data-note{font-size:11px;line-height:1.7;color:var(--ink-500)}.charging-detail-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px;font-size:11px;color:var(--ink-500)}.charging-detail-foot>span{flex:1;min-width:0}.charging-detail-foot button{display:flex;align-items:center;gap:6px;flex:none;padding:11px 16px;border:0;border-radius:9px;background:var(--ok-600);color:#fff;font-size:12px;font-weight:600}.charging-place-detail .charging-detail-icon{background:var(--brand-50);color:var(--brand-600)}.charging-place-detail .charging-detail-foot{flex-wrap:wrap}.charging-map-caption{align-self:center;max-width:100%;padding:7px 12px;border:1px solid var(--line);border-radius:var(--r-pill);background:rgba(255,255,255,.94);box-shadow:var(--shadow-1);color:var(--ink-500);font-size:11px;line-height:1.7;overflow-wrap:anywhere}
.charging-location-error{display:flex;align-items:center;gap:7px;margin-top:8px;padding:8px;border-radius:8px;background:#fffbeb;font-size:10px;line-height:1.7;color:#92400e}.charging-location-error>svg{flex:none}.charging-location-error>span{flex:1;min-width:0}.charging-location-error button{flex:none;border:0;background:none;color:var(--ok-600);font-size:11px}
.driver-mode :deep(.maplibregl-ctrl-bottom-left){left:20px;bottom:16px}.driver-mode :deep(.maplibregl-ctrl-scale){margin:0;background:rgba(255,255,255,.75);border:2px solid var(--ink-800);border-top:0;color:var(--ink-900);text-align:center;font-size:11px;line-height:1.6;padding:0 5px;text-shadow:0 1px 2px #fff}
:global(.charging-user-marker){position:relative;width:18px;height:18px;border:3px solid #fff;border-radius:50%;background:var(--brand-500);box-shadow:0 0 0 8px rgba(79,70,229,.16),0 2px 8px rgba(15,23,42,.25)}:global(.charging-position-label){position:absolute;bottom:26px;left:50%;transform:translateX(-50%);white-space:nowrap;padding:5px 10px;border-radius:var(--r-pill);background:#fff;border:1px solid var(--line);color:var(--brand-600);font-size:11px;box-shadow:var(--shadow-2)}
@media(min-width:761px) and (max-width:1000px){.driver-mode{--driver-sidebar-width:340px}.driver-toolbar,.driver-panels{padding-left:14px;padding-right:14px}.charging-bottom{width:360px;right:14px;max-width:calc(100% - var(--driver-sidebar-width) - 28px)}.charging-detail{padding:14px}.charging-detail h1{font-size:15px}}
@media(max-width:760px){
  .driver-toolbar{z-index:6}
  .charging-detail[role="dialog"]{box-sizing:border-box;max-height:calc(100dvh - var(--driver-toolbar-height) - 70px);overflow-y:auto}
  .charging-map{inset:0}.driver-sidebar{position:static;width:auto;height:auto;background:transparent;border:0;box-shadow:none;pointer-events:none}.driver-toolbar{position:absolute;top:12px;left:12px;right:12px;padding:12px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-2);background:rgba(255,255,255,.97);pointer-events:auto}.driver-heading{margin-bottom:10px}.driver-heading h1{font-size:17px}.driver-heading nav{gap:8px}.charging-topbar{gap:8px}.charging-filterbar button{font-size:11px;padding:8px 2px}.driver-more-menu{margin-top:3px}.driver-more-menu>summary{padding:2px 0}
  .driver-panels{position:absolute;bottom:max(12px,env(safe-area-inset-bottom));left:12px;right:12px;z-index:1;max-height:min(43dvh,calc(100dvh - var(--driver-toolbar-height) - 70px));padding:14px;border:1px solid var(--line);border-radius:var(--r-lg);background:rgba(255,255,255,.98);box-shadow:var(--shadow-2);pointer-events:auto}.driver-mode:not(.driver-panel-visible) .driver-panels{display:none}.charging-controls{top:calc(20px + var(--driver-toolbar-height));right:12px;flex-direction:row;gap:6px}.charging-controls button{width:34px;height:34px;border-radius:9px}
  .charging-bottom{left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));width:auto;max-width:none;max-height:calc(100dvh - var(--driver-toolbar-height) - 70px)}.driver-panel-visible .charging-bottom:has(>.charging-map-caption:only-child){display:none}.charging-detail{padding:15px}.charging-detail h1{font-size:15px}.charging-map-caption{font-size:10px}.driver-mode :deep(.maplibregl-ctrl-bottom-left){left:12px;bottom:calc(24px + 43dvh)}.driver-mode:not(.driver-panel-visible) :deep(.maplibregl-ctrl-bottom-left){bottom:16px}
}
</style>
