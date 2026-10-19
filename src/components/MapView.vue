<script setup>
//定位函数
let userMarker = null
let userLocation = null
function locateUser(forSimulation = false) {
  if (!map || locating.value || controller.signal.aborted) return
  locationError.value = ''
  mapNoticesVisible.value = true
  if (globalThis.isSecureContext === false) {
    locationError.value = '请通过 HTTPS 或 localhost 打开页面后使用定位'
    return
  }
  if (!navigator.geolocation) {
    locationError.value = '当前浏览器不支持定位'
    return
  }

  locating.value = true
  try {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (controller.signal.aborted) return
        locating.value = false
        // 浏览器获得的是 WGS84，显示时再转换成当前底图坐标。
        const { longitude, latitude } = position.coords
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
          locationFailed({ code: 2 })
          return
        }
        userLocation = [longitude, latitude]
        const coordinate = toMapCoordinate(userLocation, activeBasemap.value)
        if (!userMarker) userMarker = new maplibregl.Marker().setLngLat(coordinate).addTo(map)
        else userMarker.setLngLat(coordinate)
        map.flyTo({ center: coordinate, zoom: 15, offset: explorerFocusOffset() })
        if (forSimulation === true && layoutPreview.value.editing) sandboxPanel.value?.setLocation(userLocation, '设备当前位置')
      },
      locationFailed,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  } catch (error) {
    locationFailed(error)
  }
}
function locationFailed(error) {
  if (controller.signal.aborted) return
  locating.value = false
  locationError.value = error.code === 1 || error.name === 'SecurityError'
    ? '请在浏览器中允许位置权限，再点击定位'
    : error.code === 3 ? '定位超时，请重新点击定位' : '暂时无法定位，请稍后重试'
}
//搜索框函数
async function searchStation() {
  const requestId = ++searchRequestId
  try {
    if (loading.value || !map || controller.signal.aborted) return
    searchError.value = ''
    //去掉输入框前后的空格
    const keyword = stationKeyword.value.trim()
    if (!keyword) {
      matchingStations.value = []
      searchResultCount.value = null
      closeSearchPanel()
      return
    }
    const url = `${API_BASE}/api/stations?name=${encodeURIComponent(keyword)}`
    let features
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const geojson = await response.json()
      controller.signal.throwIfAborted()
      features = geojson.features.filter(station =>
        weiduPolygons.some(polygon => turf.booleanPointInPolygon(station, polygon)))
    } catch (error) {
      if (controller.signal.aborted) throw error
      features = allStationFeatures.value.filter(station =>
        !keyword || station.properties?.name?.includes(keyword))
    }
    if (controller.signal.aborted || requestId !== searchRequestId) return
    matchingStations.value = features
    searchResultCount.value = features.length
    if (features.length) rememberSearch(keyword)
    if (features.length === 1) {
      selectSearchStation(features[0])
    } else {
      openSearchPanel()
      if (features.length > 1) {
        const bbox = turf.bbox({ type: 'FeatureCollection', features })
        map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]].map(coordinate => toMapCoordinate(coordinate, activeBasemap.value)),
          { padding: 70, maxZoom: 14, duration: 600 })
      }
    }
  } catch (error) {
    if (!controller.signal.aborted && requestId === searchRequestId) {
      searchError.value = '搜索充电站失败，请稍后重试'
      mapNoticesVisible.value = true;
      console.error('搜索充电站失败：', error)
    }
  }
}
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import * as maplibregl from 'maplibre-gl';

import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import UiIcon from "./UiIcon.vue";
import FloatingWorkspace from './FloatingWorkspace.vue';
import MovablePanel from './MovablePanel.vue';
import TermHint from './TermHint.vue';
import FacilitySuggestions from './FacilitySuggestions.vue';
import MapLayerControl from './MapLayerControl.vue';
import ExplorerPanelHeading from './ExplorerPanelHeading.vue';
import PlannerOverview from './PlannerOverview.vue';
import PlannerGridDetails from './PlannerGridDetails.vue';
import PlannerSiting from './PlannerSiting.vue';
import PlannerGridCapacity from './PlannerGridCapacity.vue';
import PlannerChargingCarbon from './PlannerChargingCarbon.vue';
import { planningRows, planningBlindSpots, planningVoronoi } from '../utils/plannerPss.js';
import { stationConfiguration } from '../utils/facilityDemand.js';
import { facilityComparisonView } from '../utils/facilityComparison.js';
import { AMAP_STANDARD_SOURCE, toMapCoordinate, fromMapCoordinate, toMapGeoJSON } from '../utils/basemaps.js';
import { chargingMapIcon, chargingMapColor, registerChargingIcons } from '../utils/chargingIcons.js';
import { FACILITY_MAP_LAYERS, facilityPointLayers, facilityPopupLines } from '../utils/facilityMapLayers.js';
// 让 Vite 同时打包 MapLibre 处理地图数据的 Worker。
maplibregl.setWorkerUrl(workerUrl);

// FastAPI 是前端正式数据入口。
// public/geojson 中的文件只保留为原始数据或备份，不再参与正式运行。
const API_BASE = "http://127.0.0.1:8000";
const props = defineProps({ activeRoute: { type: String, default: '/' }, page: { type: Object, default: null }, authenticated: { type: Boolean, default: false } });
const emit = defineEmits(['require-login']);
const panelTitles = { map:'地图浏览', overview:'空间供需', siting:'约束选址', sandbox:'方案推演', grid:'车网协同', carbon:'双碳评估' };
const panelForRoute = route => ['/', '/monitoring/stations'].includes(route) ? 'map' : route === '/planning/candidates' ? 'siting' : route === '/planning/grid' ? 'grid' : route === '/planning/carbon' ? 'carbon' : ['/planning/problems', '/planning/suggestions'].includes(route) ? 'sandbox' : 'overview';
const analysisPanel = ref(props.authenticated ? panelForRoute(props.activeRoute) : 'map');
function allowAnalysis(panel, resume) {
  if (props.authenticated) return true;
  emit('require-login', { label:panelTitles[panel] || '空间分析', run:resume });
  return false;
}
function selectAnalysisPanel(panel) {
  if (!panelTitles[panel]) return;
  if (panel !== 'map' && !allowAnalysis(panel, () => selectAnalysisPanel(panel))) return;
  analysisPanel.value = panel;
}
watch(() => props.activeRoute, route => { selectAnalysisPanel(panelForRoute(route)); });
watch(() => props.authenticated, authenticated => {
  if (authenticated) { analysisPanel.value = panelForRoute(props.activeRoute); return; }
  analysisPanel.value = 'map';
  layoutPreview.value = { stage:'before', features:[] };
  sitingImpact.value = null;
  sitingCandidateRows.value = [];
  selectedHex.value = null;
  pssBlindVisible.value = false;
  pssVoronoiVisible.value = false;
  pssSpacingVisible.value = false;
  pssFactors.value = {};
  planningReferenceInitialized = false;
  lastPlanningResult.value = null;
  isFullscreen.value = false;
  popup?.remove();
  refreshBusinessSources();
  nextTick(() => map?.resize());
});
watch(analysisPanel, async panel => {
  if (['siting','grid','carbon'].includes(panel)) isFullscreen.value = false;
  await nextTick();
  if (!controller.signal.aborted) {
    const body = document.querySelector('.explorer-panel-body');
    if (body) body.scrollTop = 0;
    map?.resize();
    refreshBusinessSources();
    if (panel === 'siting') showSitingOverview();
  }
});
const searchInput = ref(null);
const locating = ref(false);
const locationError = ref('');
// 用户输入的充电站名称
const stationKeyword = ref('')
const SEARCH_HISTORY_KEY = 'weidu-station-search-history-v1';
const searchHistory = ref(readSearchHistory());
const searchPanelOpen = ref(false);
const matchingStations = ref([]);
let searchRequestId = 0;
function readSearchHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
    return Array.isArray(history) ? [...new Set(history.filter(item => typeof item === 'string' && item.trim()))].slice(0, 10) : [];
  } catch { return []; }
}
function rememberSearch(keyword) {
  const name = keyword.trim();
  if (!name) return;
  searchHistory.value = [name, ...searchHistory.value.filter(item => item !== name)].slice(0, 10);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory.value)); } catch { /* 搜索不依赖存储权限。 */ }
}
function clearSearchHistory() {
  searchHistory.value = [];
  try { localStorage.removeItem(SEARCH_HISTORY_KEY); } catch { /* 存储可能被浏览器禁用。 */ }
}
function openSearchPanel() {
  closeMapPanels(false);
  searchPanelOpen.value = true;
  document.addEventListener('pointerdown', closeSearchPanelOutside);
  document.addEventListener('keydown', closeMapPanelsOnEscape);
}
function closeSearchPanelOutside(event) {
  if (!event?.target?.closest?.('.map-search, .map-search-panel')) closeSearchPanel();
}
function closeSearchPanel() {
  searchPanelOpen.value = false;
  document.removeEventListener('pointerdown', closeSearchPanelOutside);
  if (!quickPanelOpen.value && !boundaryPanelOpen.value) document.removeEventListener('keydown', closeMapPanelsOnEscape);
}
function useSearchHistory(keyword) {
  stationKeyword.value = keyword;
  return searchStation();
}
function showStationPopup(station) {
  const properties = station.properties || {};
  popup?.remove();
  popup = new maplibregl.Popup()
    .setLngLat(station.geometry.coordinates)
    .setDOMContent(popupContent([
      properties.name || '充电站',
      '地址：' + (properties.address || '暂无'),
      '编码：' + (properties.id ?? '未知'),
      '类型：' + (properties.chargeType === 'fast' ? '快充' : '普通充电'),
    ])).addTo(map);
}
function selectSearchStation(station) {
  if (!map || !station?.geometry || controller.signal.aborted) return;
  ++searchRequestId;
  rememberSearch(station.properties?.name || stationKeyword.value);
  toggleLayer('stations', true);
  toggleFastOnly(false);
  const displayed = toMapGeoJSON(station, activeBasemap.value);
  map.flyTo({ center: displayed.geometry.coordinates, zoom: 15, duration: 600, offset: explorerFocusOffset() });
  showStationPopup(displayed);
  stationKeyword.value = '';
  searchResultCount.value = null;
  matchingStations.value = [];
  closeSearchPanel();
}
const mapEl = ref(null);
const sandboxPanel = ref(null);
const sitingPanel = ref(null);
const sitingCandidateRows = ref([]), sitingSelectedId = ref('');
let sitingMarkers = [];
const weiduStationCount = ref(0);
let map;
let popup;
let weiduPolygons = [];
let businessData = {};
const stationCount = ref(0); //真实的充电桩数量
const allStationFeatures = ref([]);
const demandPoiFeatures = ref([]);
const facilityPois = ref([]), facilityLoading = ref(false), facilityLoaded = ref(false), facilityError = ref('');
const facilityCounts = computed(() => Object.fromEntries(FACILITY_MAP_LAYERS.map(layer =>
  [layer.category, facilityPois.value.filter(feature => feature.properties.categories.includes(layer.category)).length])));
const searchResultCount = ref(null);
const activeBasemap = ref('street');
// ==================== 本次新增的界面状态 ====================
// 测距：是否正在测距、已经点过的坐标、是否显示测距结果面板
const measuring = ref(false);
const measurePoints = ref([]);
const measurePanelOpen = ref(false);
// 顶部独立图层控件的展开状态。
const quickPanelOpen = ref(false);
const boundaryPanelOpen = ref(false);
const boundaryFill = ref(true);
const boundaryOpacity = ref(4.5);
const boundaryBounds = ref(null);
// 全屏：隐藏数据分析栏，让地图铺满。
const isFullscreen = ref(false);
// 只看快充：勾上以后地图上只留 chargeType 为 fast 的站点
const fastOnly = ref(false);
const fastCount = computed(() => allStationFeatures.value.filter(item => item.properties?.chargeType === 'fast').length);
const regularCount = computed(() => allStationFeatures.value.filter(item => item.properties?.chargeType !== 'fast').length);
const hasChargeTypeData = computed(() => allStationFeatures.value.length > 0);
const gridHighlightSelection = ref(null);
const layoutPreview = ref({ stage: 'before', features: [] });
const pssSpacingVisible = ref(false), pssSpacingRadius = ref(400), pssFactors = ref({}), pssNotice = ref('');
const sitingImpact=ref(null),constructionOptions=ref({radius:400,powerFactor:.9,minimumSpaces:0});
watch(sitingImpact,refreshPlanningImpact);
const pssBlindVisible = ref(false), pssVoronoiVisible = ref(false);
const planningComparisonShown = ref(true), lastPlanningResult = ref(null);
let planningReferenceInitialized = false;
const planningComparisonActive = computed(() => layoutPreview.value.local && layoutPreview.value.editing && planningComparisonShown.value && !!layoutPreview.value.result?.macro?.comparison);
const comparisonView = computed(() => facilityComparisonView(layoutPreview.value.result?.macro
  ? { ...layoutPreview.value, result: layoutPreview.value.result.macro, stage: layoutPreview.value.stage === 'after' ? 'change' : 'before' }
  : layoutPreview.value));
const mapNoticesVisible = ref(true);
// 图例颜色、分级与地图渲染保持一致，是否显示由图层开关决定。
const layerLegends = {
  residential: { items: [{ kind: 'point', color: '#8b5cf6', label: '居住需求样本' }], note: '供需模型使用的原始居住样本，与高德住宅小区目录分别展示。' },
  commercial: { items: [{ kind: 'point', color: '#f59e0b', label: '商业需求样本' }], note: '供需模型使用的原始商业样本，与高德商业设施目录分别展示。' },
  hexgrid: { items: [
    { color: '#0284c7', label: '6 站及以上' },
    { color: '#38bdf8', label: '4 ~ 5 站' },
    { color: '#7dd3fc', label: '2 ~ 3 站' },
    { color: '#bae6fd', label: '1 站' },
    { color: '#f1f5f9', label: '0 站' },
  ],note:'每个六边形内的充电站数量，按站统计。' },
  demandIndex: { items: [
    { color: '#3f6212', label: '很高（指数 0.8 及以上）' },
    { color: '#84cc16', label: '较高（指数 0.6～0.8）' },
    { color: '#bef264', label: '中等（指数 0.4～0.6）' },
    { color: '#d9f99d', label: '较低（指数 0.2～0.4）' },
    { color: '#f7fee7', label: '很低（指数低于 0.2）' },
  ],note:'按小区与商业地点数量估计，颜色越深表示相对需求越高；不是实际车辆数。区间含下限、不含上限。' },
  mismatch: {
    gradient: 'linear-gradient(90deg, #2166ac 0%, #67a9cf 30%, #f7f7f7 50%, #ef8a62 70%, #b2182b 100%)',
    range: ['站点相对较多', '数量与需求较接近', '需求相对较高'],
    note: '蓝色偏向站点数量多，红色偏向需求高；比较的是相对指数，不直接表示缺多少桩。',
  },
  supplyDemandType: { items: [
    { color: '#dc2626', label: '需求较高 · 站点较少' },
    { color: '#f59e0b', label: '需求较高 · 站点较多' },
    { color: '#2563eb', label: '需求较低 · 站点较多' },
    { color: '#d1d5db', label: '需求较低 · 站点较少' },
  ],note:'高低均与全区平均水平比较；站点多不代表可以撤站。' },
};
const coverageRate = computed(() => hexCount.value ? Math.round(occupiedHexCount.value / hexCount.value * 100) : 0);

const hexCount = ref(0); // 六边形总数

const occupiedHexCount = ref(0); //至少有一个充电桩的六边形数量
const residentialCount = ref(0); // 居民小区总数
const commercialCount = ref(0); // 网格内商业设施总数

const selectedHex = ref(null); //当前点击的六边形
// 传给统计图表的“站点数-网格数”分布数据。
const hexDistribution = ref([]);
// 保存加载并处理后的六边形 GeoJSON，供统计和供需分类使用。
const hexData = ref(null);
const emptyFeatures = [];
const displayedResult = computed(() => layoutPreview.value.editing && layoutPreview.value.stage !== 'before' ? layoutPreview.value.result?.macro || layoutPreview.value.result || null : null);
const displayedHexData = computed(() => displayedResult.value?.grid || layoutPreview.value.modelGrid || hexData.value);
const displayedStations = computed(() => displayedResult.value?.stations || layoutPreview.value.modelStations || allStationFeatures.value);
const displayedStationCount = computed(() => displayedResult.value?.after.stationCount ?? (layoutPreview.value.modelStations ? displayedStations.value.length : stationCount.value));
const displayedFastCount = computed(() => displayedStations.value.filter(feature => feature.properties.chargeType === 'fast').length);
const displayedDistribution = computed(() => {
  if (!displayedResult.value && !layoutPreview.value.modelGrid) return hexDistribution.value;
  const counts = new Map();
  displayedHexData.value.features.forEach(feature => counts.set(feature.properties.stationCount, (counts.get(feature.properties.stationCount) || 0) + 1));
  return [...counts].map(([stationCount, hexCount]) => ({ stationCount, hexCount })).sort((a, b) => a.stationCount - b.stationCount);
});
// 地图数据尚未全部加载完成时为 true。
const loading = ref(true);
// 地图主要数据加载失败时显示的错误信息。
const loadError = ref("");
const searchError = ref("");
// 六边形网格单独加载失败时显示的提示信息。
const gridWarning = ref("");
// 组件卸载时用它取消尚未完成的 GeoJSON 请求。
const controller = new AbortController();
const planningFeatures = computed(() => layoutPreview.value.modelGrid?.features || hexData.value?.features || emptyFeatures);
const planningStations = computed(() => layoutPreview.value.modelStations || allStationFeatures.value);
const pssRows = computed(() => planningRows(planningFeatures.value,planningStations.value,pssFactors.value,undefined,demandPoiFeatures.value));
const sitingCandidate = computed(() => sitingCandidateRows.value.find(row => row.id === sitingSelectedId.value) || sitingCandidateRows.value[0] || null);
watch([sitingCandidateRows,sitingSelectedId,loading],refreshSitingMap);
const pssBlindSpots = computed(() => planningBlindSpots(demandPoiFeatures.value,planningStations.value,pssSpacingRadius.value));
const pssVoronoiData = computed(() => pssVoronoiVisible.value ? planningVoronoi(planningStations.value,businessData.weidu) : {type:'FeatureCollection',features:[]});
const draftStations = computed(() => {
  const removed = new Set(layoutPreview.value.removedIds || []);
  return [...planningStations.value.filter(feature => !removed.has(String(feature.properties.id))), ...(layoutPreview.value.points || [])];
});
const pssGridData = computed(() => {
  const rows = pssRows.value;
  const capacities = new Map(rows.map(row => [row.id,{ value:0,unknown:false }]));
  for (const feature of planningStations.value) {
    const configuration = stationConfiguration(feature);
    if (configuration.blocked) continue;
    const row = rows.find(row => turf.booleanPointInPolygon(feature,row.feature));
    if (!row) continue;
    const entry = capacities.get(row.id);
    if (configuration.capacity == null) entry.unknown = true;
    else entry.value += configuration.capacity;
  }
  return { type:'FeatureCollection',features:rows.map(row => ({ ...row.feature,properties:{ ...row.feature.properties,
    pssFastDemand:row.fast,pssRegularDemand:row.regular,pssFactorCount:row.factorCount,
    pssCapacityKw:capacities.get(row.id).unknown ? null : capacities.get(row.id).value } })) };
});
watch([pssGridData,pssSpacingVisible,pssSpacingRadius,pssBlindVisible,pssVoronoiVisible],refreshPssMap);
function refreshPssMap() {
  if (!map || controller.signal.aborted) return;
  map.getSource('pss-grid')?.setData(toMapGeoJSON(pssGridData.value,activeBasemap.value));
  const features = pssSpacingVisible.value && pssSpacingRadius.value > 0 ? planningStations.value.filter(feature => !stationConfiguration(feature).blocked).map(feature =>
    turf.circle(feature.geometry.coordinates,pssSpacingRadius.value/1000,{steps:40,properties:{stationId:feature.properties.id}})) : [];
  map.getSource('pss-spacing')?.setData(toMapGeoJSON({type:'FeatureCollection',features},activeBasemap.value));
  map.getSource('pss-blind')?.setData(toMapGeoJSON({type:'FeatureCollection',features:pssBlindVisible.value ? pssBlindSpots.value : []},activeBasemap.value));
  map.getSource('pss-voronoi')?.setData(toMapGeoJSON(pssVoronoiData.value,activeBasemap.value));
  refreshSitingMap();
}
function setSpacingBuffer({visible,radius}) {
  pssSpacingVisible.value = !!visible;
  if (Number.isFinite(radius) && radius >= 0 && radius <= 3000) pssSpacingRadius.value = radius;
}
function receiveSitingCandidates(rows) {
  const previous = sitingSelectedId.value;
  sitingCandidateRows.value = Array.isArray(rows) ? rows : [];
  if (!sitingCandidateRows.value.some(row => row.id === previous)) sitingSelectedId.value = sitingCandidateRows.value[0]?.id || '';
  if (analysisPanel.value === 'siting' && sitingSelectedId.value !== previous && sitingCandidate.value) nextTick(() => focusSitingGrid(sitingCandidate.value.feature));
}
function clearSitingMarkers() { sitingMarkers.forEach(marker => marker.remove()); sitingMarkers = []; }
function refreshSitingMap() {
  if (!map || controller.signal.aborted || !map.getSource('pss-siting-context')) return;
  clearSitingMarkers();
  const enabled = analysisPanel.value === 'siting', selected = sitingCandidate.value;
  const context = enabled && selected ? [{...selected.feature,properties:{...selected.feature.properties,sitingGeometry:'area'}}] : [];
  if (enabled && selected?.nearestStation) {
    context.push(turf.lineString([selected.location.geometry.coordinates,selected.nearestStation.geometry.coordinates],{sitingGeometry:'connection'}));
    context.push({...selected.nearestStation,properties:{...selected.nearestStation.properties,sitingGeometry:'reference'}});
  }
  map.getSource('pss-siting-context').setData(toMapGeoJSON({type:'FeatureCollection',features:context},activeBasemap.value));
  if (map.getLayer('pss-siting-stations')) map.setLayoutProperty('pss-siting-stations','visibility',enabled && layerGroups.value.find(group => group.id === 'stations')?.visible ? 'visible' : 'none');
  if (!enabled || loading.value) return;
  for (const row of sitingCandidateRows.value) {
    const button = document.createElement('button');
    button.className = 'siting-candidate-marker' + (row.id === selected?.id ? ' selected' : '');
    button.type = 'button';
    button.setAttribute('aria-label','地图候选 '+row.rank+'：'+row.areaName);
    button.setAttribute('data-candidate-id',row.id);
    button.title = row.areaName+' · '+(row.score == null ? '资料不足' : row.score.toFixed(2)+' 分');
    const rank = document.createElement('span');
    rank.textContent = String(row.rank);
    button.append(rank);
    button.addEventListener('pointerdown',event => event.stopPropagation());
    button.addEventListener('click',event => { event.stopPropagation(); sitingPanel.value?.selectCandidate(row.id); });
    sitingMarkers.push(new maplibregl.Marker({element:button,anchor:'center'}).setLngLat(toMapCoordinate(row.location.geometry.coordinates,activeBasemap.value)).addTo(map));
  }
  if (selected?.nearestStation) {
    const station = selected.nearestStation, label = document.createElement('button');
    label.type = 'button'; label.className = 'siting-reference-marker';
    label.textContent = '最近的现有站 · '+(station.properties.name || '未命名站点');
    label.title = station.properties.address || station.properties.name;
    label.addEventListener('pointerdown',event => event.stopPropagation());
    label.addEventListener('click',event => {event.stopPropagation();showStationPopup(toMapGeoJSON(station,activeBasemap.value));});
    const onRight = station.geometry.coordinates[0] >= selected.location.geometry.coordinates[0];
    sitingMarkers.push(new maplibregl.Marker({element:label,anchor:onRight ? 'right' : 'left',offset:[onRight ? -12 : 12,-14]}).setLngLat(toMapCoordinate(station.geometry.coordinates,activeBasemap.value)).addTo(map));
  }
}
function showSitingOverview() {
  if (!map || controller.signal.aborted || !sitingCandidateRows.value.length) return;
  popup?.remove();
  const features = sitingCandidateRows.value.map(row => row.feature);
  map.fitBounds(turf.bbox(toMapGeoJSON({type:'FeatureCollection',features},activeBasemap.value)),{padding:sitingMapPadding(),maxZoom:14,duration:500});
}
function sitingMapPadding() {
  const width=mapEl.value?.clientWidth || 800,height=mapEl.value?.clientHeight || 700;
  return {top:Math.min(176,height*.35),right:Math.min(54,width*.15),bottom:Math.min(72,height*.12),left:Math.min(40,width*.1)};
}
function focusSitingGrid(feature) {
  if (!map || !feature || controller.signal.aborted) return;
  sitingSelectedId.value = String(feature.properties.id);
  const row = sitingCandidateRows.value.find(item => item.id === sitingSelectedId.value);
  if (!row) return;
  popup?.remove();
  const context = [row.feature,...(row.nearestStation ? [row.nearestStation] : [])];
  const bounds = turf.bbox(toMapGeoJSON({type:'FeatureCollection',features:context},activeBasemap.value));
  map.fitBounds(bounds,{padding:sitingMapPadding(),maxZoom:15,duration:500});
  refreshSitingMap();
}
function toggleSitingCandidate(payload) {
  const added = sandboxPanel.value?.addCandidate(payload);
  pssNotice.value = added ? '' : '候选未加入：请在方案推演中查看范围提示；定位周边模式只允许在蓝圈内新增。';
}
function addSitingCandidates({rows,spec}) {
  let count = 0;
  for (const row of rows) if (sandboxPanel.value?.addCandidate({row,spec})) count++;
  pssNotice.value = `已纳入 ${count} 个候选。` + (count < rows.length ? '部分点位不在当前编辑范围内，请到方案推演核查。' : '可进入方案推演编辑配置并分析。');
}
async function toggleGridCandidate() {
  const row = pssRows.value.find(row => row.id === String(selectedHex.value?.id));
  if (!row) return;
  toggleSitingCandidate({row,spec:{chargeType:'fast',pileCount:1,powerKw:60}});
  analysisPanel.value = 'sandbox';
}
// 所有正式空间数据统一通过 FastAPI 获取。
async function readApiGeoJSON(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`${endpoint} 加载失败：HTTP ${response.status}`);
  }

  const data = await response.json();
  controller.signal.throwIfAborted();

  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error(`${endpoint} 返回的数据不是标准 FeatureCollection`);
  }

  return data;
}

async function loadFacilityData() {
  if (!map || facilityLoading.value || controller.signal.aborted) return;
  facilityLoading.value = true;
  facilityError.value = '';
  try {
    const features = [];
    let offset = 0, page;
    do {
      page = await readApiGeoJSON(`/api/facility-pois?limit=10000&offset=${offset}`);
      if (page.metadata?.initialized === false) throw new Error('设施目录尚未入库');
      if (page.metadata?.coordSystem !== 'WGS84') throw new Error('设施坐标系不匹配');
      features.push(...page.features);
      offset += page.features.length;
      if (page.metadata?.hasMore && (!page.features.length || offset >= 100000)) throw new Error('设施分页未完整返回');
    } while (page.metadata?.hasMore);
    controller.signal.throwIfAborted();
    facilityPois.value = features;
    businessData.facilities = { type:'FeatureCollection', features };
    map.getSource('facilities')?.setData(toMapGeoJSON(businessData.facilities, activeBasemap.value));
    facilityLoaded.value = true;
    layerGroups.value.filter(group => group.category).forEach(updateLayerVisibility);
  } catch (error) {
    if (!controller.signal.aborted) facilityError.value = '高德设施目录暂不可用，请重试';
  } finally {
    if (!controller.signal.aborted) facilityLoading.value = false;
  }
}

function popupContent(lines) {
  const content = document.createElement("div");
  lines.forEach((text) => {
    const line = document.createElement("div");
    line.textContent = text;
    content.append(line);
  });
  return content;
}
onMounted(() => {
  map = new maplibregl.Map({
    container: mapEl.value,
    center: toMapCoordinate([113.85, 34.04], activeBasemap.value),
    zoom: 11,
    // Style 是绘图配置：sources 提供数据，layers 决定怎样显示。
    style: {
      version: 8,
      sources: {
        streetTiles: AMAP_STANDARD_SOURCE,
        satelliteTiles: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          attribution: "Tiles © Esri",
        },
        terrainTiles: {
          type: "raster",
          tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenTopoMap contributors",
        },
        // 五类正式业务数据先建立空 Source，地图 load 后统一从 FastAPI 填充。
        weidu: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        stations: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        hexgrid: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        'pss-grid': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-spacing': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-blind': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-voronoi': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-siting-context': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'planning-impact': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        residential: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        commercial: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        facilities: { type:'geojson', data:{type:'FeatureCollection',features:[]} },
        measure: {
          // 测距工具画的线，先放一个空数据，用户点击测距后再填内容
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        'facility-proposals': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-removals': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-service': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-places': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-location': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-nearby': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
      },

      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#e8f2f4" },
        },
        { id: "street-base", type: "raster", source: "streetTiles" },
        { id: "satellite-base", type: "raster", source: "satelliteTiles", layout: { visibility: "none" } },
        { id: "terrain-base", type: "raster", source: "terrainTiles", layout: { visibility: "none" } },
        {
          id: "weidu-fill",
          type: "fill",
          source: "weidu",
          paint: { "fill-color": "#2563eb", "fill-opacity": 0.045 },
        },
        {
          id: "hexgrid-fill",
          type: "fill",
          source: "hexgrid",
          paint: {
            // stationCount 已由 PostGIS 计算，前端只负责按数值设色。
            "fill-color": [
              "step",
              ["coalesce", ["get", "stationCount"], 0],
              "#f1f5f9",
              1, "#bae6fd",
              2, "#7dd3fc",
              4, "#38bdf8",
              6, "#0284c7",
            ],
            "fill-opacity": 0.65,
          },
        },
        {
          // 专门负责显示“当前被图表选中的六边形”
          id: "hexgrid-highlight",

          type: "fill",

          // 仍然使用原来的 hexgrid 数据
          source: "hexgrid",

          // 默认先匹配一个不存在的值
          // 所以页面刚打开的时候什么都不会高亮
          filter: ["==", ["get", "stationCount"], -1],

          paint: {
            // 高亮填充颜色
            "fill-color": gridHighlightColor(),

            // 稍微透明，底下的地图仍然能看见
            "fill-opacity": 0.65,
          },
        },
        {
          // 综合潜在充电需求专题图
          id: "demand-index-fill",

          // 六边形是 Polygon，所以使用 fill
          type: "fill",

          // 继续使用统一的六边形 Source
          source: "hexgrid",

          // 默认关闭，避免与其他专题图互相覆盖
          layout: {
            visibility: "none",
          },

          paint: {
            // 根据每个六边形的 demandIndex 进行分级设色
            "fill-color": [
              "step",

              // 读取当前六边形的综合需求指数
              ["get", "demandIndex"],

              // demandIndex < 0.2
              "#f7fee7",

              // >= 0.2
              0.2,
              "#d9f99d",

              // >= 0.4
              0.4,
              "#bef264",

              // >= 0.6
              0.6,
              "#84cc16",

              // >= 0.8
              0.8,
              "#3f6212",
            ],

            "fill-opacity": 0.75,

            // 六边形边界
            "fill-outline-color": "#94a3b8",
          },
        },
        {
          // =====================================
          // 供需错配专题图
          // =====================================
          id: "mismatch-fill",

          // 六边形是 Polygon
          type: "fill",

          // mismatchIndex 已经存在 hex-grid.json 中
          source: "hexgrid",

          // 默认关闭，避免和其他专题图叠在一起
          layout: {
            visibility: "none",
          },

          paint: {
            // =====================================
            // 根据 mismatchIndex 连续设色
            //
            // 负值：供给相对高
            // 0附近：需求与供给相对接近
            // 正值：需求相对高
            // =====================================
            "fill-color": [
              "interpolate",

              // 线性渐变
              ["linear"],

              // 读取当前六边形的 mismatchIndex
              // 如果不存在，则按0处理
              ["coalesce", ["get", "mismatchIndex"], 0],

              // -1：供给明显高于需求
              -1,
              "#2166ac",

              // -0.4
              -0.4,
              "#67a9cf",

              // 0：相对接近
              0,
              "#f7f7f7",

              // +0.4
              0.4,
              "#ef8a62",

              // +1：需求明显高于供给
              1,
              "#b2182b",
            ],

            "fill-opacity": 0.78,

            // 六边形轮廓
            "fill-outline-color": "#94a3b8",
          },
        },
        {
          // =====================================
          // 供需类型四象限专题图
          // =====================================
          id: "supply-demand-type-fill",

          type: "fill",

          // 分类结果仍然存在统一的 hexgrid Source 中
          source: "hexgrid",

          layout: {
            visibility: "none",
          },

          paint: {
            // 根据 supplyDemandType
            // 给四类网格设置不同颜色
            "fill-color": [
              "match",

              ["get", "supplyDemandType"],

              // 高需求 + 低供给
              // 后续重点关注
              "high-demand-low-supply",
              "#dc2626",

              // 高需求 + 高供给
              "high-demand-high-supply",
              "#f59e0b",

              // 低需求 + 高供给
              "low-demand-high-supply",
              "#2563eb",

              // 低需求 + 低供给
              "low-demand-low-supply",
              "#d1d5db",

              // 防止异常数据没有匹配到
              "#ffffff",
            ],

            "fill-opacity": 0.78,

            "fill-outline-color": "#94a3b8",
          },
        },
        {
          id:'pss-capacity-fill',type:'fill',source:'pss-grid',layout:{visibility:'none'},paint:{'fill-color':['case',['==',['get','pssCapacityKw'],null],'#94a3b8',['interpolate',['linear'],['coalesce',['get','pssCapacityKw'],0],0,'#eff6ff',500,'#93c5fd',2000,'#2563eb',10000,'#172554']],'fill-opacity':.7},
        },
        { id:'pss-spacing-fill',type:'fill',source:'pss-spacing',paint:{'fill-color':'#2563eb','fill-opacity':.06} },
        { id:'pss-spacing-line',type:'line',source:'pss-spacing',paint:{'line-color':'#2563eb','line-opacity':.5,'line-width':1,'line-dasharray':[3,2]} },
        { id:'pss-voronoi-line',type:'line',source:'pss-voronoi',paint:{'line-color':'#8b5cf6','line-width':1.3,'line-opacity':.75} },
        { id:'pss-blind-circle',type:'circle',source:'pss-blind',paint:{'circle-color':'#e35b50','circle-radius':5,'circle-stroke-color':'#fff','circle-stroke-width':1.5} },
        {id:'pss-siting-area',type:'fill',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'area'],paint:{'fill-color':'#f59e0b','fill-opacity':.14}},
        {id:'pss-siting-outline',type:'line',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'area'],paint:{'line-color':'#ed8a12','line-width':3}},
        {id:'pss-siting-connection',type:'line',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'connection'],paint:{'line-color':'#3579d4','line-width':2,'line-dasharray':[3,2]}},
        {id:'pss-siting-reference',type:'circle',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'reference'],paint:{'circle-color':'#3579d4','circle-radius':7,'circle-stroke-color':'#fff','circle-stroke-width':2}},
        {id:'pss-siting-stations',type:'circle',source:'stations',layout:{visibility:'none'},paint:{'circle-color':'#71839a','circle-radius':4,'circle-opacity':.65,'circle-stroke-color':'#fff','circle-stroke-width':1}},
        {
          id: "hexgrid-outline",
          type: "line",
          source: "hexgrid",
          paint: { "line-color": "#94a3b8", "line-width": 0.5 },
          layout: {
            //隐藏六边形
            visibility: "visible",
          },
        },
        ...facilityPointLayers(),
        {
          // 供需模型的原始居住样本，独立于设施目录。
          id: "residential-circle",

          // GeoJSON 中是 Point，所以先用 circle 显示
          type: "circle",

          // 使用刚才创建的 residential Source
          source: "residential",

          paint: {
            // 居民小区只作为辅助需求数据，
            // 圆点不要比充电站更加醒目
            "circle-radius": 4,

            "circle-color": "#8b5cf6",

            "circle-opacity": 0.7,

            "circle-stroke-color": "#ffffff",

            "circle-stroke-width": 1,
          },
        },
        {
          // 商业设施点图层
          id: "commercial-circle",

          type: "circle",

          // 对应上面的 commercial Source
          source: "commercial",

          paint: {
            // 商业 POI 和居民小区区分开
            "circle-radius": 4,

            "circle-color": "#f59e0b",

            "circle-opacity": 0.8,

            "circle-stroke-color": "#ffffff",

            "circle-stroke-width": 1,
          },
        },
        { id: 'facility-service-fill', type: 'fill', source: 'facility-service',
          paint: { 'fill-color': '#dfe4e1', 'fill-opacity': 0.72, 'fill-outline-color': '#ffffff' } },
        { id: 'facility-location-fill', type: 'fill', source: 'facility-location',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#2563eb', 'fill-opacity': .07 } },
        { id: 'facility-location-outline', type: 'line', source: 'facility-location',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [3, 2] } },
        { id: 'facility-nearest-line', type: 'line', source: 'facility-nearby',
          filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#00856a', 'line-width': 2.5, 'line-dasharray': [2, 2] } },
        {
          id: "stations-circle",
          type: "circle",
          source: "stations",
          paint: {
            "circle-color": chargingMapColor,
            "circle-radius": 17,
            "circle-opacity": 0.01,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 0,
          },
        },
        {
          // 充电站头上的白色闪电图标
          // 图标本身要在地图 load 时用 addImage 注册，这里只负责引用
          id: "stations-bolt",
          type: "symbol",
          source: "stations",
          layout: {
            "icon-image": chargingMapIcon,
            // 低缩放层级略收小，避免密集城区标记互相压盖；放大后恢复原尺寸
            "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.9, 13, 1, 15, 1.08],
            // 站点挨得近时也照常显示，不参与避让
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        },
        {
          id: "weidu-outline",
          type: "line",
          source: "weidu",
          paint: { "line-color": "#ef4444", "line-width": 2, "line-dasharray": [2, 2] },
        },
        { id: 'facility-proposal-fill', type: 'fill', source: 'facility-proposals',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.16 } },
        { id: 'facility-proposal-outline', type: 'line', source: 'facility-proposals',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#d97706', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } },
        { id: 'facility-proposal-point', type: 'circle', source: 'facility-proposals',
          filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['case', ['coalesce', ['get', 'sandboxSelected'], false], 10, 8], 'circle-color': '#f59e0b', 'circle-stroke-color': ['case', ['coalesce', ['get', 'sandboxSelected'], false], '#2563eb', '#ffffff'], 'circle-stroke-width': 2.5 } },
        { id: 'facility-removal-point', type: 'circle', source: 'facility-removals',
          paint: { 'circle-radius': 9, 'circle-color': '#fee2e2', 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 2.5 } },
        {id:'planning-impact-point',type:'circle',source:'planning-impact',paint:{'circle-radius':6,'circle-stroke-width':2,'circle-stroke-color':'#fff','circle-color':['case',['boolean',['get','lostReach'],false],'#bd5140',['boolean',['get','newlyReachable'],false],'#0b9473',['>', ['coalesce',['get','distanceSaved'],0],0],'#347fd6','#bd5140']}},
        { id: 'facility-place-point', type: 'circle', source: 'facility-places',
          paint: { 'circle-radius': 6, 'circle-color': ['get', 'placeColor'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } },
        { id: 'facility-nearby-point', type: 'circle', source: 'facility-nearby',
          filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 20, 'circle-color': '#00856a', 'circle-opacity': .05, 'circle-stroke-color': '#00856a', 'circle-stroke-width': 1.5 } },
        { id: 'facility-location-point', type: 'circle', source: 'facility-location',
          filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 9, 'circle-color': '#2563eb', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } },
        {
          // 测距折线：把用户点过的点依次连起来
          id: "measure-line",
          type: "line",
          source: "measure",
          // 同一个数据源里既有线也有点，这里只画线
          filter: ["==", ["geometry-type"], "LineString"],
          paint: { "line-color": "#f97316", "line-width": 3, "line-dasharray": [2, 1.2] },
        },
        {
          // 测距顶点：每次点击的位置画一个小圆点
          id: "measure-point",
          type: "circle",
          source: "measure",
          // 这里只画点，不画线
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 5,
            "circle-color": "#ffffff",
            "circle-stroke-color": "#f97316",
            "circle-stroke-width": 2.5,
          },
        },
      ],
    },
  });
  map.on("load", async () => {
    try {
      layerGroups.value.forEach((group) =>
        toggleLayer(group.id, group.visible),
      );
      // 地图加载完才有 addImage，闪电图标在这里注册
      registerChargingIcons(map);
      // 设施目录与原五类数据并行加载，失败不会中断主地图。
      void loadFacilityData();
      FACILITY_MAP_LAYERS.forEach(layer => {
        map.on('mouseenter', layer.layerIds[0], () => setCursor('pointer'));
        map.on('mouseleave', layer.layerIds[0], () => setCursor(''));
      });
      map.setPaintProperty('hexgrid-highlight', 'fill-color', gridHighlightColor());
      map.on("click", "residential-circle", (e) => {
        const residential = e.features?.[0];
        if (!residential) return;

        console.log("居民小区：", residential.properties.name);
        console.log("地址：", residential.properties.address);
      });
      // 地图和 Style 加载完成后，从 FastAPI 一次性读取五类正式数据。
      const [
        weiduGeoJSON,
        stationsGeoJSON,
        residentialGeoJSON,
        commercialGeoJSON,
        hexGrid,
      ] = await Promise.all([
        readApiGeoJSON("/api/boundary"),
        readApiGeoJSON("/api/stations"),
        readApiGeoJSON("/api/residential-pois"),
        readApiGeoJSON("/api/commercial-pois"),
        readApiGeoJSON("/api/hex-grid"),
      ]);
      map.on("click", "stations-circle", (e) => {
        // 测距时点击只用来取点，不弹站点信息
        if (measuring.value || layoutPreview.value.editing) return;
        const station = e.features?.[0];
        if (!station || !station.geometry) return;

        showStationPopup(station);
      });

      // 根据坐标判断站点是否在魏都区内，和网格统计使用同一批站点。
      let polygons = [weiduGeoJSON];
      if (weiduGeoJSON.type === "FeatureCollection") {
        polygons = weiduGeoJSON.features;
      }
      weiduPolygons = polygons;

      // 研究区只展示魏都区范围内的点数据。
      // 数据来源仍然是 PostGIS/FastAPI，Turf 这里只负责前端显示范围过滤。
      const insideWeidu = (feature) =>
        polygons.some((polygon) => turf.booleanPointInPolygon(feature, polygon));

      const weiduStations = stationsGeoJSON.features.filter(insideWeidu);
      const weiduResidential = residentialGeoJSON.features.filter(insideWeidu);
      const weiduCommercial = commercialGeoJSON.features.filter(insideWeidu);
      demandPoiFeatures.value = [...weiduResidential.map(feature => ({ ...feature, properties: { ...feature.properties, category: 'residential' } })),
        ...weiduCommercial.map(feature => ({ ...feature, properties: { ...feature.properties, category: 'commercial' } }))];

      businessData = {
        ...businessData,
        weidu: weiduGeoJSON,
        stations: { type: 'FeatureCollection', features: weiduStations },
        residential: { type: 'FeatureCollection', features: weiduResidential },
        commercial: { type: 'FeatureCollection', features: weiduCommercial },
        hexgrid: hexGrid,
      };
      refreshBusinessSources();

      weiduStationCount.value = weiduStations.length;
      stationCount.value = weiduStations.length;
      allStationFeatures.value = weiduStations;
      residentialCount.value = weiduResidential.length;
      commercialCount.value = weiduCommercial.length;

      const bbox = turf.bbox(weiduGeoJSON);
      boundaryBounds.value = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];

      // 定位可能先于数据返回，研究区加载不能覆盖已定位的视野。
      if (!userLocation) {
        map.fitBounds(
          boundaryBounds.value.map(coordinate => toMapCoordinate(coordinate, activeBasemap.value)),
          { padding: 20, duration: 0 },
        );
        if (map.getZoom && map.zoomTo) map.zoomTo(map.getZoom() + 0.35, { duration: 0 });
      }
      map.on("mouseenter", "weidu-fill", () => {
        setCursor("pointer");
      });

      map.on("mouseleave", "weidu-fill", () => {
        setCursor("");
      });

      // 六边形中的 stationCount、需求指数、供给指数、错配指数和四象限
      // 已由 PostGIS 计算。前端不再重复空间统计，只读取并展示结果。
      hexData.value = hexGrid;
      loadStatistics(hexGrid);

      map.on("click", (e) => {
        if (!measuring.value && (!layoutPreview.value.editing || layoutPreview.value.tool === 'inspect')
            && !map.queryRenderedFeatures(e.point, {layers:['stations-circle']}).length) {
          const facility = map.queryRenderedFeatures(e.point, {layers:FACILITY_MAP_LAYERS.flatMap(layer => layer.layerIds)})[0];
          if (facility) {
            popup?.remove();
            popup = new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(popupContent(facilityPopupLines(facility))).addTo(map);
            return;
          }
        }
        if(analysisPanel.value==='siting'||analysisPanel.value==='sandbox'&&layoutPreview.value.tool==='inspect'){
          const place=map.queryRenderedFeatures(e.point,{layers:['planning-impact-point']})[0];
          if(place){showPlanningPopup(place,e.lngLat);return;}
        }
        if (analysisPanel.value === 'siting') {
          const coordinate = turf.point(fromMapCoordinate([e.lngLat.lng,e.lngLat.lat],activeBasemap.value));
          const row = sitingCandidateRows.value.find(item => turf.booleanPointInPolygon(coordinate,item.feature));
          if (row) sitingPanel.value?.selectCandidate(row.id);
          return;
        }
        if (layoutPreview.value.editing) {
          if (layoutPreview.value.local) {
            if (layoutPreview.value.tool !== 'inspect') handleSandboxMapClick(e);
            else {
              const feature = map.queryRenderedFeatures(e.point, { layers: ['facility-proposal-point', 'facility-nearby-point', 'stations-circle', 'facility-removal-point'] })[0];
              if (feature) showStationPopup(feature);
              else {
                const grid = map.queryRenderedFeatures(e.point, { layers: ['facility-service-fill'] })[0];
                if (grid) showComparisonPopup(grid, e.lngLat);
                else popup?.remove();
              }
            }
            return;
          }
          if (layoutPreview.value.tool === 'inspect' || layoutPreview.value.stage === 'before') {
            const place = map.queryRenderedFeatures(e.point, { layers: ['facility-place-point'] })[0];
            if (place) { showPlanningPopup(place, e.lngLat); return; }
            const grid = map.queryRenderedFeatures(e.point, { layers: ['facility-service-fill'] })[0];
            if (grid) showComparisonPopup(grid, e.lngLat);
            else popup?.remove();
          } else handleSandboxMapClick(e);
          return;
        }
        // 测距时点击只用来取点，不再选中网格
        if (measuring.value) return;
        // 站点有自己的弹窗，点击站点时不切换网格。
        const stations = map.queryRenderedFeatures(e.point, {
          layers: ["stations-circle"],
        });
        if (stations.length > 0) return;
        const proposal = layoutPreview.value.stage === 'after' && layoutPreview.value.features.length
          ? map.queryRenderedFeatures(e.point, { layers: ['facility-proposal-point', 'facility-proposal-fill'] })[0] : null;
        if (proposal) {
          const p = proposal.properties;
          popup?.remove();
          popup = new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(popupContent([
            '网格 #' + p.id + ' · 模拟新增 1 站',
            '新增前 ' + p.stationCount + ' 站 → 新增后 ' + (Number(p.stationCount) + 1) + ' 站',
            '新增后为数量模拟；区域内具体选址待核验。',
          ])).addTo(map);
          return;
        }

        // 各专题图层共用同一份六边形网格数据。
        const hex = map.queryRenderedFeatures(e.point, {
          layers: [
            "supply-demand-type-fill",
            "mismatch-fill",
            "demand-index-fill",
            "hexgrid-fill",
            "pss-capacity-fill",
          ],
        })[0];
        if (hex) {
          if (!allowAnalysis('overview', () => { selectedHex.value = { ...hex.properties }; selectAnalysisPanel('overview'); })) return;
          const properties = hex.properties ?? {};
          selectedHex.value = { ...properties };
          popup?.remove();
          return;
        }

        map.setFilter("hexgrid-highlight", ["==", ["get", "stationCount"], -1]);
        selectedHex.value = null;
        gridHighlightSelection.value = null;
        popup?.remove(); //组件
        popup = null;
        dismissMapWindows();
      });
      map.on("mouseenter", "hexgrid-fill", () => {
        setCursor("pointer");
      });
      map.on("mouseleave", "hexgrid-fill", () => {
        setCursor("");
      });
    } catch (error) {
      if (!controller.signal.aborted)
        loadError.value = "地图数据加载失败，请刷新重试";
    } finally {
      loading.value = false;
      if (!controller.signal.aborted) applyRouteView();
    }
    map.on("click", "commercial-circle", (e) => {
      // 用户当前点击的商业 POI
      const feature = e.features?.[0];

      if (!feature) return;

      console.log("商业设施：", feature.properties);

      // 这里不要新建第二套属性面板
      // 把 feature / properties
      // 传给你现有的属性面板状态即可
    });
  });
  // Planning starts at the study area. Device location remains an explicit tool.
});

onBeforeUnmount(() => {
  closeSearchPanel();
  closeMapPanels();
  controller.abort();
  locating.value = false;
  userMarker?.remove();
  clearSitingMarkers();
  popup?.remove();
  map?.remove();
});
function setBasemap(type) {
  if (!map || controller.signal.aborted || !['street', 'satellite', 'terrain'].includes(type) || type === activeBasemap.value) return;
  const center = fromMapCoordinate(map.getCenter().toArray(), activeBasemap.value);
  activeBasemap.value = type;
  ['street', 'satellite', 'terrain'].forEach(name => {
    if (map.getLayer(`${name}-base`)) map.setLayoutProperty(`${name}-base`, 'visibility', name === type ? 'visible' : 'none');
  });
  refreshBusinessSources();
  refreshMeasureLayer();
  if (userLocation) userMarker?.setLngLat(toMapCoordinate(userLocation, type));
  popup?.remove();
  map.jumpTo({ center: toMapCoordinate(center, type) });
}
function refreshBusinessSources() {
  if (!map || controller.signal.aborted) return;
  Object.entries(businessData).forEach(([id, data]) => map.getSource(id)?.setData(toMapGeoJSON(data, activeBasemap.value)));
  refreshPssMap();
  refreshLayoutPreview();
  refreshPlanningImpact();
}
function refreshPlanningImpact(){
  if(!map||!map.getSource('planning-impact'))return;
  const impact=analysisPanel.value==='siting'?sitingImpact.value:analysisPanel.value==='sandbox'&&layoutPreview.value.stage!=='before'?layoutPreview.value.result?.planningImpact:null;
  map.getSource('planning-impact').setData(toMapGeoJSON({type:'FeatureCollection',features:impact?.affectedPlaces || []},activeBasemap.value));
}
function showLayoutScenario(preview) {
  const entering = preview.editing && !layoutPreview.value.editing;
  const changedTool = preview.editing && preview.tool !== layoutPreview.value.tool;
  const changedMetric = preview.comparisonMetric !== layoutPreview.value.comparisonMetric;
  if (preview.local && preview.editing) {
    if (changedTool && ['add', 'remove', 'locate'].includes(preview.tool)) planningComparisonShown.value = false;
    if (preview.result && preview.result !== lastPlanningResult.value || changedMetric && preview.result) {
      planningComparisonShown.value = true;
      lastPlanningResult.value = preview.result;
    }
  }
  layoutPreview.value = preview;
  if (entering) {
    if (measuring.value) finishMeasure();
    measurePanelOpen.value = false;
    closeMapPanels(false);
    selectedHex.value = null;
    gridHighlightSelection.value = null;
    toggleLayer('stations', true);
    if (preview.local && !planningReferenceInitialized) {
      planningReferenceInitialized = true;
      if (!layerGroups.value.some(group => group.visible && group.id !== 'boundary' && group.layerIds.some(id => id.endsWith('-fill')))) toggleLayer('mismatch', true);
    }
    if (preview.points?.length) focusLayoutScenario(preview.points);
    else if (globalThis.innerWidth <= 760) mapEl.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (changedTool && preview.tool !== 'inspect' && globalThis.innerWidth <= 760) mapEl.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  popup?.remove();
  refreshBusinessSources();
}
function refreshLayoutPreview() {
  if (!map || controller.signal.aborted) return;
  const preview = layoutPreview.value;
  if (map.getLayer('facility-service-fill')) map.setLayoutProperty('facility-service-fill', 'visibility', !preview.local || planningComparisonActive.value ? 'visible' : 'none');
  refreshLocalChargingPreview(preview);
  if (preview.local) return;
  const after = preview.stage !== 'before';
  const modelStations = preview.modelStations || allStationFeatures.value;
  if (preview.editing) {
    map.getSource('stations')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: modelStations }, activeBasemap.value));
    map.getSource('hexgrid')?.setData(toMapGeoJSON(preview.modelGrid || hexData.value, activeBasemap.value));
  }
  const features = after ? (preview.features || []).flatMap(feature => {
    if (preview.editing) return preview.result?.comparison ? [] : [feature];
    const point = turf.pointOnFeature(feature);
    return [feature, { ...point, properties: { ...feature.properties } }];
  }) : [];
  if (preview.editing && after) {
    features.push(...(preview.points || []).map(feature => ({ ...feature, properties: { ...feature.properties,
      sandboxId: feature.properties.id, sandboxSelected: feature.properties.id === preview.selectedId } })));
    const removed = new Set(preview.removedIds || []);
    map.getSource('stations')?.setData(toMapGeoJSON({ type: 'FeatureCollection',
      features: modelStations.filter(feature => !removed.has(String(feature.properties.id))) }, activeBasemap.value));
    map.getSource('hexgrid')?.setData(toMapGeoJSON(preview.result?.grid || hexData.value || { type: 'FeatureCollection', features: [] }, activeBasemap.value));
    map.getSource('facility-removals')?.setData(toMapGeoJSON({ type: 'FeatureCollection',
      features: modelStations.filter(feature => removed.has(String(feature.properties.id))).map(feature => ({ ...feature,
        properties: { ...feature.properties, removedId: String(feature.properties.id) } })) }, activeBasemap.value));
  } else map.getSource('facility-removals')?.setData({ type: 'FeatureCollection', features: [] });
  const comparison = comparisonView.value;
  map.getSource('facility-service')?.setData(toMapGeoJSON(comparison.data, activeBasemap.value));
  const places = preview.editing && preview.result ? (preview.result.evaluation?.locations?.features || []).filter(feature => !feature.properties.fallback
    && (preview.placeView === 'weak' ? feature.properties.weak : feature.properties.locationStatus !== 'unchanged')).map(feature => ({ ...feature,
      properties: { ...feature.properties, placeColor: preview.placeView === 'weak' ? '#c65a32'
        : feature.properties.locationStatus === 'improved' ? '#00856a' : feature.properties.locationStatus === 'declined' ? '#c65a32' : '#8061a8' } })) : [];
  map.getSource('facility-places')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: places }, activeBasemap.value));
  if (map.getLayer('facility-service-fill')) {
    map.setPaintProperty('facility-service-fill', 'fill-color', comparison.color);
    map.setPaintProperty('facility-service-fill', 'fill-opacity', comparison.opacity);
  }
  layerGroups.value.forEach(updateLayerVisibility);
  map.getSource('facility-proposals')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features }, activeBasemap.value));
  const canvas = map.getCanvas();
  if (canvas.style) canvas.style.cursor = preview.editing && preview.tool !== 'inspect' && after ? 'crosshair' : measuring.value ? 'crosshair' : '';
}
function refreshLocalChargingPreview(preview) {
  const empty = { type: 'FeatureCollection', features: [] };
  const enabled = preview.local && preview.editing;
  const scope = enabled && preview.center ? [turf.circle(preview.center, preview.radiusMeters / 1000, { steps: 80 }),
    turf.point(preview.center, { name: preview.locationName || '分析定位' })] : [];
  map.getSource('facility-location')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: scope }, activeBasemap.value));
  const after = preview.stage !== 'before';
  const diagnostics = enabled ? (preview.result ? after ? preview.result.diagnostics?.pointAfter : preview.result.diagnostics?.pointBefore : preview.pointBaseline) : null;
  const removed = new Set(after ? preview.removedIds || [] : []);
  const showServices = preview.result || !(preview.points?.length || preview.removedIds?.length);
  const nearby = showServices ? (diagnostics?.sources || []).map(row => row.feature) : [];
  const primary = diagnostics?.sources?.[0];
  if (enabled && preview.center && showServices && primary) nearby.push(turf.lineString([preview.center, primary.feature.geometry.coordinates]));
  map.getSource('facility-nearby')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: nearby }, activeBasemap.value));
  if (!preview.local) return;
  const comparison = comparisonView.value;
  const grids = enabled && planningComparisonActive.value ? comparison.data.features.filter(feature => !after || feature.properties.comparisonKnown && feature.properties.comparisonValue !== 0) : [];
  map.getSource('facility-service')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: grids }, activeBasemap.value));
  if (map.getLayer('facility-service-fill')) {
    map.setPaintProperty('facility-service-fill', 'fill-color', comparison.color);
    map.setPaintProperty('facility-service-fill', 'fill-opacity', comparison.opacity);
  }
  map.getSource('facility-places')?.setData(empty);
  const model = preview.modelStations || allStationFeatures.value;
  map.getSource('hexgrid')?.setData(toMapGeoJSON(enabled && after && preview.result?.macro?.grid ? preview.result.macro.grid : preview.modelGrid || hexData.value || empty, activeBasemap.value));
  map.getSource('stations')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: enabled ? model.filter(feature => !removed.has(String(feature.properties.id))) : model }, activeBasemap.value));
  const additions = (enabled && after || analysisPanel.value === 'overview') ? (preview.points || []).map(feature => ({ ...feature, properties: { ...feature.properties,
    sandboxId: feature.properties.id, sandboxSelected: feature.properties.id === preview.selectedId } })) : [];
  map.getSource('facility-proposals')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: additions }, activeBasemap.value));
  map.getSource('facility-removals')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: enabled ? model.filter(feature => removed.has(String(feature.properties.id)))
    .map(feature => ({ ...feature, properties: { ...feature.properties, removedId: String(feature.properties.id) } })) : [] }, activeBasemap.value));
  layerGroups.value.forEach(updateLayerVisibility);
  const canvas = map.getCanvas();
  if (canvas.style) canvas.style.cursor = enabled && preview.tool !== 'inspect' ? 'crosshair' : measuring.value ? 'crosshair' : '';
}
function focusAnalysisLocation({ center, radiusMeters }) {
  if (!map || !center) return;
  const bounds = turf.bbox(toMapGeoJSON(turf.circle(center, radiusMeters / 1000), activeBasemap.value));
  map.fitBounds(bounds, { padding: globalThis.innerWidth <= 760 ? { top: 100, bottom: 45, left: 30, right: 45 }
    : { top: 120, bottom: 60, left: 60, right: 60 }, maxZoom: 16, duration: 500 });
}
function showComparisonPopup(feature, position) {
  const p = feature.properties;
  const value = (number, digits) => typeof number === 'number' && Number.isFinite(number) ? number.toFixed(digits) : '未知';
  const signed = (number, digits) => typeof number === 'number' && Number.isFinite(number) ? (number > 0 ? '+' : '') + number.toFixed(digits) : '未知';
  popup?.remove();
  popup = new maplibregl.Popup().setLngLat(position).setDOMContent(popupContent([
    `网格 #${p.id} · 模拟前后对比`,
    `需求匹配度：${value(p.beforeMatch, 1)} → ${value(p.afterMatch, 1)} 分（${signed(p.matchChange, 1)}）`,
    `供需失配：${value(p.beforeMismatch, 3)} → ${value(p.afterMismatch, 3)}`,
    `失配程度改善：${signed(p.balanceChange, 3)}（正值更接近 0）`,
    '方案估算；供需采用模拟前固定尺度。',
  ])).addTo(map);
}
function focusComparisonGrid(feature) {
  if (!map || !feature) return;
  const center = toMapCoordinate(turf.centerOfMass(feature).geometry.coordinates, activeBasemap.value);
  map.flyTo({ center, zoom: Math.max(map.getZoom(), 13), duration: 600, offset: explorerFocusOffset() });
  showComparisonPopup(feature, center);
}
function showPlanningPopup(feature, position) {
  const p = feature.properties;
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '未知';
  const meters = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) + ' m' : '无可用站点';
  const lines = p.impactModel ? p.impactStation ? [p.name+' · 需求分流试算',`原来分到的全区需求占比 ${number(p.beforeDemandShare)}% → ${number(p.afterDemandShare)}%`,'固定全区原始需求，按功率与距离重新分配。','这是潜在分流；非实际订单、充电量、营收或利用率预测。'] : [p.name+' · 建站出行影响',`距最近站：${meters(p.beforeDistance)} → ${meters(p.afterDistance)}（直线）`,`原最近站：${p.beforeNearest || '无'}；方案最近站：${p.afterNearest || '无'}`,p.newlyReachable?'进入已知配置站的 1 km 服务范围。':p.lostReach?'失去已知配置站的 1 km 服务触达。':`距站变化：缩短 ${meters(p.distanceSaved)}。`,p.fallback?'位置为网格需求估计点。':'按已记录地点位置估算。','不能等同实际行驶里程、排队时间或新增订单。'] : p.reviewStatus ? [
    p.name + ' · 单站移除试算', p.address || '地址未记录',
    `当前方案撤去此站：匹配下降 ${number(p.removalMatchLoss)} 分；触达下降 ${number(p.removalReachLoss)} 个百分点`,
    `影响 ${p.affectedPlaces} 个命名地点：${p.affectedNames || '未筛出明显影响'}`,
    p.capacitySimulated ? '能力含演示参数，需实测复核。' : '按已记录配置估算。',
    '仅为空间服务依赖分析；淘汰需运营、利用率和成本证据。',
  ] : [
    p.name + ' · 地点服务对比', p.address || '地址未记录',
    `匹配度：${number(p.beforeMatch)} → ${number(p.afterMatch)} 分`,
    `最近站距离：${meters(p.beforeDistance)} → ${meters(p.afterDistance)}（直线）`,
    `原最近站：${p.beforeNearest || '无'}；方案最近站：${p.afterNearest || '无'}`,
    p.weak ? '方案后仍需补强：匹配低于 50 分或 1 km 内无站。' : '未进入当前薄弱地点筛选。',
    '依据 POI 与网格需求权重估算，非实际需求满足率；进场、道路及排队待核实。',
  ];
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(position).setDOMContent(popupContent(lines)).addTo(map);
}
function focusPlanningPlace(feature) {
  if (!map || !feature) return;
  const center = toMapCoordinate(feature.geometry.coordinates, activeBasemap.value);
  map.flyTo({ center, zoom: Math.max(map.getZoom(), 15), duration: 600, offset: explorerFocusOffset() });
  showPlanningPopup(feature, center);
}
function handleSandboxMapClick(event) {
  analysisPanel.value = 'sandbox';
  const added = map.queryRenderedFeatures(event.point, { layers: ['facility-proposal-point'] })[0];
  const removed = map.queryRenderedFeatures(event.point, { layers: ['facility-removal-point'] })[0];
  const station = map.queryRenderedFeatures(event.point, { layers: ['stations-circle'] })[0];
  const coordinates = Array.isArray(event.lngLat) ? event.lngLat : [event.lngLat.lng, event.lngLat.lat];
  sandboxPanel.value?.mapClick({ coordinates: fromMapCoordinate(coordinates, activeBasemap.value),
    sandboxId: added?.properties.sandboxId, removedId: removed?.properties.removedId, stationId: station?.properties.id });
  if (['add', 'locate'].includes(layoutPreview.value.tool) && globalThis.innerWidth <= 760) setTimeout(scrollSandboxPanel, 0);
}
function scrollSandboxPanel() {
  analysisPanel.value = 'sandbox';
  setTimeout(() => sandboxPanel.value?.$el?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0);
}
function explorerFocusOffset() { return [0, 0]; }
// 只看快充：给站点相关的三个图层统一加/去过滤条件
function toggleFastOnly(checked) {
  fastOnly.value = checked;
  // null 表示不加过滤，恢复显示全部站点
  const filter = checked ? ['==', ['get', 'chargeType'], 'fast'] : null;
  ['stations-circle', 'stations-bolt'].forEach((layerId) => {
    if (map?.getLayer(layerId)) map.setFilter(layerId, filter);
  });
}
function zoomMap(delta) { map?.zoomTo(map.getZoom() + delta, { duration: 350 }); }
function resetView() {
  if (!map) return;
  map.flyTo({ center: toMapCoordinate([113.8356, 34.0268], activeBasemap.value), zoom: 11.9, duration: 600 });
}
// 全屏：隐藏数据分析栏，再点一次恢复。
function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
  // 侧栏隐藏后地图容器会变宽，等浏览器排好版再让地图重新量一次尺寸
  setTimeout(() => map?.resize(), 0);
}
// ===================== 测距工具 =====================
// 设置鼠标指针样式；测距时十字光标优先，不被悬停效果覆盖
function setCursor(cursor) {
  if (measuring.value) return;
  map.getCanvas().style.cursor = layoutPreview.value.editing ? 'crosshair' : cursor;
}
// 双击时浏览器会先发出两次单击，最后两个点几乎重合，这个距离内的点当成同一个点
const MEASURE_DUPLICATE_KM = 0.03; // 约 30 米
// 1 千米 = 1000 米，用来决定面板显示"米"还是"千米"
const METERS_PER_KILOMETER = 1000;

// 把点过的坐标变成地图要画的数据：一条折线 + 每个点一个圆点
function measureFeatures() {
  const points = measurePoints.value;
  const features = [];
  if (points.length > 1) {
    features.push(turf.lineString(points)); // 折线：把点依次连起来
  }
  points.forEach((point) => {
    features.push(turf.point(point)); // 圆点：标出每次点击的位置
  });
  return features;
}

// 计算总长度，单位千米（不到两个点时长度是 0）
function measureKilometers() {
  const points = measurePoints.value;
  if (points.length < 2) return 0;
  return turf.length(turf.lineString(points), { units: "kilometers" });
}

// 面板里显示的长度文字
const measureText = computed(() => {
  const kilometers = measureKilometers();
  // 不到 1 千米用米，读起来更直观
  if (kilometers < 1) return Math.round(kilometers * METERS_PER_KILOMETER) + " 米";
  return kilometers.toFixed(2) + " 千米";
});

// 操作提示，跟着测距进度变化
const measureHint = computed(() => {
  const count = measurePoints.value.length;
  if (measuring.value) {
    return count < 2 ? "在地图上单击起点，双击结束" : "继续单击加点，双击结束";
  }
  return count < 2 ? "点右侧直尺按钮开始测量" : "已完成测量";
});

// 把最新的点和线交给地图显示
function refreshMeasureLayer() {
  map?.getSource("measure")?.setData(toMapGeoJSON({
    type: "FeatureCollection",
    features: measureFeatures(),
  }, activeBasemap.value));
}

// 单击地图：记录一个点
function addMeasurePoint(event) {
  measurePoints.value = measurePoints.value.concat([fromMapCoordinate(event.lngLat.toArray(), activeBasemap.value)]);
  refreshMeasureLayer();
}

// 开始测距：进入测距模式，并清掉上一次的结果
function startMeasure() {
  if (!map) return;
  closeMapPanels(false);
  measuring.value = true;
  measurePanelOpen.value = true;
  measurePoints.value = [];
  refreshMeasureLayer();
  map.getCanvas().style.cursor = "crosshair"; // 十字光标提示正在取点
  map.doubleClickZoom.disable(); // 双击要用来结束测距，先关掉双击缩放
  map.on("click", addMeasurePoint);
  map.on("dblclick", finishMeasure);
}

// 结束测距：画好的线保留，只是不再继续加点
function finishMeasure() {
  if (!map) return;
  // 双击会先产生两次单击，去掉那个几乎重合的多余点
  const points = measurePoints.value;
  if (points.length >= 2) {
    const last = points[points.length - 1];
    const before = points[points.length - 2];
    if (turf.distance(before, last, { units: "kilometers" }) < MEASURE_DUPLICATE_KM) {
      measurePoints.value = points.slice(0, -1);
      refreshMeasureLayer();
    }
  }
  measuring.value = false;
  map.getCanvas().style.cursor = "";
  map.doubleClickZoom.enable();
  map.off("click", addMeasurePoint);
  map.off("dblclick", finishMeasure);
}

// 清除：把点过的点全部删掉，回到地图空白状态
function clearMeasure() {
  measurePoints.value = [];
  refreshMeasureLayer();
}

// 关闭测距面板：结束测距并清空画好的线
function closeMeasurePanel() {
  if (measuring.value) finishMeasure();
  clearMeasure();
  measurePanelOpen.value = false;
}

// 右上角直尺按钮：没在测距就开始，正在测距就结束
function toggleMeasure() {
  if (measuring.value) {
    finishMeasure();
  } else {
    startMeasure();
  }
}
function focusHex(feature) {
  if (!map || !feature) return;
  const center = turf.centerOfMass(feature).geometry.coordinates;
  popup?.remove();
  selectedHex.value = { ...feature.properties };
  gridHighlightSelection.value = null;
  map.flyTo({ center: toMapCoordinate(center, activeBasemap.value), zoom: Math.max(map.getZoom(), 13), duration: 600, offset: explorerFocusOffset() });
  map.setFilter('hexgrid-highlight', ['==', ['get', 'id'], feature.properties.id]);
}
async function startCandidatePlanning(feature) {
  if (!allowAnalysis('sandbox', () => startCandidatePlanning(feature))) return;
  if (loading.value || !feature) return;
  analysisPanel.value = 'sandbox';
  // Activate the existing sandbox first; locating a candidate never adds a
  // station or resets the user's draft, radius, or data scope.
  await nextTick();
  if (!controller.signal.aborted) {
    const current = displayedHexData.value?.features?.find(item => String(item.properties.id) === String(feature.properties.id));
    focusHex(current || feature);
  }
}
function focusLayoutScenario(features) {
  if (!map || !features.length || controller.signal.aborted) return;
  const bounds = turf.bbox({ type: 'FeatureCollection', features });
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]].map(point => toMapCoordinate(point, activeBasemap.value)),
    { padding: globalThis.innerWidth <= 760 ? { top: 100, right: 45, bottom: 45, left: 30 }
      : { top: 120, right: 60, bottom: 60, left: 60 }, maxZoom: 14, duration: 600 });
  mapEl.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function focusSandboxPoint(feature) {
  if (!map || !feature || controller.signal.aborted) return;
  map.flyTo({ center: toMapCoordinate(feature.geometry.coordinates, activeBasemap.value), zoom: Math.max(map.getZoom(), 14), duration: 500, offset: explorerFocusOffset() });
  mapEl.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
//图层控制模块
const layerGroups = ref([
  { id:'boundary', label:'研究区边界', layerIds:['weidu-fill','weidu-outline'], visible:true },
  { id:'stations', label:'充电站点', layerIds:['stations-circle','stations-bolt'], visible:true },
  { id:'residential', label:'居住需求样本', layerIds:['residential-circle'], visible:false },
  { id:'commercial', label:'商业需求样本', layerIds:['commercial-circle'], visible:false },
  { id:'hexgrid', label:'充电站数量分布', layerIds:['hexgrid-fill','hexgrid-outline'], visible:false },
  { id:'demandIndex', label:'潜在充电需求指数', layerIds:['demand-index-fill'], visible:false },
  { id:'mismatch', label:'供需失配指数', layerIds:['mismatch-fill'], visible:false },
  { id:'supplyDemandType', label:'供需四象限分类', layerIds:['supply-demand-type-fill'], visible:false },
  { id:'capacitySupply', label:'充电设施配置功率', layerIds:['pss-capacity-fill'], visible:false },
  ...FACILITY_MAP_LAYERS.map(layer => ({...layer})),
]);
FACILITY_MAP_LAYERS.forEach(layer => {
  layerLegends[layer.id] = {items:[{kind:'point',color:layer.color,label:layer.label}],
    note:layer.category === 'parking' ? '高德采集记录；可用泊位、收费和公共开放情况待核查。' : '高德采集记录，尚未现场核验。'};
});
layerLegends.capacitySupply = {gradient:'linear-gradient(90deg,#eff6ff,#93c5fd,#2563eb,#172554)',range:['0 kW','10000 kW 及以上'],items:[{color:'#94a3b8',label:'有站点缺少桩数或功率资料'}],note:'网格内桩数 × 单桩功率的合计，单位 kW；含模拟参数时为情景配置能力。'};
const mapLayerItems = computed(() => layerGroups.value.filter(group => group.id !== 'boundary').map(group => ({
  id: group.id, label: group.label,
  section: group.section,
  count: group.category && facilityLoaded.value ? facilityCounts.value[group.category] : null,
  disabled: !!group.category && (!facilityLoaded.value || !facilityCounts.value[group.category]),
  thematic: group.layerIds.some(id => id.endsWith('-fill')),
  visible: group.visible && !isLayerSuppressed(group),
})));
function isLayerSuppressed(group) {
  if (analysisPanel.value === 'siting' && group.id === 'stations') return true;
  const comparison = layoutPreview.value.local ? planningComparisonActive.value : layoutPreview.value.editing && !!layoutPreview.value.result?.comparison;
  return comparison && group.layerIds.some(id => id.endsWith('-fill') && id !== 'weidu-fill');
}
function togglePlanningComparison(visible) {
  planningComparisonShown.value = visible;
  refreshLayoutPreview();
}
const activeLegends = computed(() => layerGroups.value
  .filter(group => group.visible && group.id !== 'boundary' && (!group.category || facilityLoaded.value) && !isLayerSuppressed(group))
  .map(group => {
    let legend = layerLegends[group.id];
    if (group.id === 'stations') {
      legend = { items: [
        { kind: 'point', color: chargingMapColor[3], icon: chargingMapIcon[3], label: '快充' },
        { kind: 'point', color: chargingMapColor.at(-1), icon: chargingMapIcon.at(-1), label: '普通充电', hidden: fastOnly.value },
      ] };
    }
    // 网格加载失败时地图没有专题数据，不显示对应图例。
    if (group.layerIds.some(id => id.includes('fill') && id !== 'weidu-fill') && !hexData.value) return null;
    return legend ? { id: group.id, title: group.label, ...legend } : null;
  })
  .filter(Boolean)
  .concat(gridHighlightSelection.value === null || !hexData.value ? [] : [{
    id: 'gridHighlight', title: '网格站点数量',
    gradient: 'linear-gradient(90deg, ' + GRID_HIGHLIGHT_STOPS.map(item => item[1]).join(', ') + ')',
    range: ['0 站', '10 站及以上'],
    note: gridHighlightSelection.value === 'overview' ? '总览：显示全部网格' : gridHighlightSelection.value + ' 个站点的网格',
  }]).concat(comparisonView.value.legend && (!layoutPreview.value.local || planningComparisonActive.value) ? [comparisonView.value.legend] : []).concat(layoutPreview.value.editing && layoutPreview.value.stage !== 'before' ? [{
    id: 'facilitySandbox', title: '模拟沙盘',
    items: [{ kind: 'point', color: '#f59e0b', label: '新增点位（模拟）' },
      { kind: 'point', color: '#dc2626', label: '模拟移除（可恢复）' }],
    note: layoutPreview.value.local ? '点位调整与供需变化均为模拟。' : layoutPreview.value.result ? '橙色点为新增，红色点为移除；均为模拟。' : '方案编辑中，需求评价待运行',
  }] : layoutPreview.value.stage === 'after' && layoutPreview.value.features.length ? [{
    id: 'facilityProposals', title: '模拟新增',
    items: [{ kind: 'point', color: '#f59e0b', label: '新增区域与站点示意' }],
    note: '新增后模拟 · ' + layoutPreview.value.features.length + ' 站，具体选址待核验',
  }] : []).concat(layoutPreview.value.editing && layoutPreview.value.result?.evaluation?.locations ? [{
    id: 'facilityPlaces', title: layoutPreview.value.placeView === 'weak' ? '薄弱地点 · 方案后' : '受影响的小区／商业地点',
    items: layoutPreview.value.placeView === 'weak' ? [{ kind: 'point', color: '#c65a32', label: '匹配低于 50 分或 1 km 内无站' }]
      : [{ kind: 'point', color: '#00856a', label: '匹配或距离改善' }, { kind: 'point', color: '#c65a32', label: '服务下降' },
        { kind: 'point', color: '#8061a8', label: '匹配与距离有得有失' }],
    note: '圆点对应具体需求地点；点击查看名称与前后服务。',
  }] : []).concat(layoutPreview.value.local && layoutPreview.value.editing && layoutPreview.value.center ? [{
    id: 'facilityLocation', title: '定位周边 · ' + layoutPreview.value.radiusMeters + ' m',
    items: [{ kind: 'point', color: '#2563eb', label: '本次选定的分析位置与范围' }, { kind: 'point', color: '#00856a', label: '可为这个位置提供服务的站点' },
      { kind: 'line', color: '#00856a', label: '连接贡献最大的站点（直线）' }], note: '蓝圈内可调整站点；计算仍保留圈外 1 km 内站点的影响。',
  }] : []).concat(analysisPanel.value==='sandbox'&&layoutPreview.value.stage!=='before'&&layoutPreview.value.result?.planningImpact?.affectedPlaces.length?[{
    id:'planningImpact',title:'建站后，哪些地点去充电更方便',items:[{kind:'point',color:'#0b9473',label:'原来 1 km 内无站，现在有站'},{kind:'point',color:'#347fd6',label:'到最近站更近，或可选站更多'},{kind:'point',color:'#bd5140',label:'到站更远，或附近不再有站'}],note:'圆点是小区、商场等需求地点；点圆点查看前后距站距离，均为直线估计。'
  }]:[]));
const GRID_HIGHLIGHT_STOPS = [[0, '#eff6ff'], [1, '#bfdbfe'], [2, '#93c5fd'], [3, '#60a5fa'], [4, '#2563eb'], [6, '#1e40af'], [10, '#082f49']];
function gridHighlightColor() {
  return ['interpolate', ['linear'], ['coalesce', ['get', 'stationCount'], 0], ...GRID_HIGHLIGHT_STOPS.flat()];
}
function showGridOverview() {
  if (!map?.getLayer('hexgrid-highlight') || !hexData.value) return;
  gridHighlightSelection.value = 'overview';
  selectedHex.value = null;
  popup?.remove();
  map.setFilter('hexgrid-highlight', ['>=', ['get', 'stationCount'], 0]);
  fitBoundary();
}
function highlightHexByStationCount(stationCount) {
  if (!map?.getLayer("hexgrid-highlight")) return;
  selectedHex.value = null;
  popup?.remove();
  map.setFilter("hexgrid-highlight", [
    "==",
    ["get", "stationCount"],
    stationCount,
  ]);
  gridHighlightSelection.value = stationCount;
  const features = displayedHexData.value?.features.filter(feature => feature.properties.stationCount === stationCount) || [];
  if (features.length) map.fitBounds(turf.bbox(toMapGeoJSON({type:'FeatureCollection',features},activeBasemap.value)),{padding:65,maxZoom:14,duration:500});
}
function clearDistributionHighlight() {
  gridHighlightSelection.value = null;
  if (map?.getLayer('hexgrid-highlight')) map.setFilter('hexgrid-highlight',['==',['get','stationCount'],-1]);
}
function toggleLayer(groupId, visible) {
  const group = layerGroups.value.find((item) => item.id === groupId); //检查图层组

  if (!group) return;
  if (groupId !== 'boundary' && visible && group.layerIds.some(id => id.endsWith('-fill'))) {
    if (layoutPreview.value.local && layoutPreview.value.editing) planningComparisonShown.value = false;
    layerGroups.value.filter(item => item.id !== 'boundary' && item.id !== groupId && item.layerIds.some(id => id.endsWith('-fill'))).forEach(item => { item.visible = false; });
    group.visible = visible;
    if (layoutPreview.value.local && layoutPreview.value.editing) refreshLayoutPreview();
    else layerGroups.value.forEach(updateLayerVisibility);
    return;
  }
  group.visible = visible;
  updateLayerVisibility(group);
}
function updateLayerVisibility(group) {
  if (group.id === 'stations' && map?.getLayer('pss-siting-stations')) map.setLayoutProperty('pss-siting-stations','visibility',analysisPanel.value === 'siting' && group.visible ? 'visible' : 'none');
  group.layerIds.forEach((layerId) => {
    if (!map?.getLayer(layerId)) {
      return;
    } //检查图层组地图图层

    map.setLayoutProperty(
      //隐藏函数
      layerId,
      "visibility",
      group.visible && !isLayerSuppressed(group)
        && (layerId !== 'weidu-fill' || boundaryFill.value) ? "visible" : "none",
    );
  });

}
const boundaryVisible = computed(() => layerGroups.value.find(group => group.id === 'boundary').visible);
function toggleBoundaryFill(visible) {
  boundaryFill.value = visible;
  toggleLayer('boundary', boundaryVisible.value);
}
function setBoundaryOpacity(value) {
  boundaryOpacity.value = Number(value);
  if (map?.getLayer('weidu-fill')) map.setPaintProperty('weidu-fill', 'fill-opacity', boundaryOpacity.value / 100);
}
function fitBoundary() {
  if (!map || !boundaryBounds.value || loading.value) return;
  map.fitBounds(boundaryBounds.value.map(coordinate => toMapCoordinate(coordinate, activeBasemap.value)), { padding: 40, duration: 600 });
}
// ---------------- 业务图层与专题视图 ----------------
function applyRouteView() {
  if (loading.value || !map) return;
  const views = {
    '/': ['stations'],
    '/monitoring/stations': ['stations'],
    '/monitoring/demand': ['stations', 'demandIndex'],
    '/monitoring/supply': ['stations', 'hexgrid'],
    '/monitoring/mismatch': ['stations', 'mismatch'],
    '/planning/problems': ['stations', 'supplyDemandType'],
  };
  const visible = views[props.activeRoute] || views['/'];
  // 边界属于地图参考设置，切换专题时保留用户选择。
  layerGroups.value.filter(group => group.id !== 'boundary' && !group.category).forEach(group => toggleLayer(group.id, visible.includes(group.id)));
  selectedHex.value = null;
  gridHighlightSelection.value = null;
  popup?.remove();
  if (map.getLayer('hexgrid-highlight')) map.setFilter('hexgrid-highlight', ['==', ['get', 'stationCount'], -1]);
}
watch(() => props.activeRoute, applyRouteView);
// 点开 / 收起快捷面板
function toggleQuickPanel() {
  if (quickPanelOpen.value) {
    closeMapPanels();
    return;
  }
  closeMapPanels();
  closeSearchPanel();
  if (measuring.value) finishMeasure();
  measurePanelOpen.value = false;
  quickPanelOpen.value = true;
  // 图层面板固定展开，切换专题和地图点选不收起。
  document.addEventListener("keydown", closeMapPanelsOnEscape);
}
function toggleBoundaryPanel() {
  const open = !boundaryPanelOpen.value;
  closeMapPanels(false);
  if (measuring.value) finishMeasure();
  measurePanelOpen.value = false;
  boundaryPanelOpen.value = open;
  if (open) {
    document.addEventListener('click', closeMapPanelsOnOutsideClick);
    document.addEventListener('keydown', closeMapPanelsOnEscape);
  }
}
function closeMapPanels(closeLayers = true) {
  if (closeLayers !== false) quickPanelOpen.value = false;
  boundaryPanelOpen.value = false;
  document.removeEventListener('click', closeMapPanelsOnOutsideClick);
  if (!searchPanelOpen.value && !quickPanelOpen.value) document.removeEventListener('keydown', closeMapPanelsOnEscape);
}
function closeMapPanelsOnEscape(event) {
  if (event.key === 'Escape') { closeMapPanels(); dismissMapWindows(); }
}
function closeMapPanelsOnOutsideClick(event) {
  if (event?.target?.closest?.('.quick-panel, .map-layer-control, .boundary-tool')) return;
  if (boundaryPanelOpen.value) closeMapPanels(false);
}
function dismissMapWindows(event) {
  // 地图内部由 MapLibre 的站点、网格及空白点击事件分别处理。
  // DOM 冒泡不能再次关闭刚刚打开的站点弹窗。
  if (event?.target?.closest?.('.map-canvas, .map-search, .map-search-panel, .map-tools, .quick-panel, .measure-panel, .selected-hex, .map-legend, .basemap-switch, .maplibregl-popup, .right-sidebar, .site-header, button, input, a, label')) return;
  ++searchRequestId;
  closeSearchPanel();
  closeMapPanels(false);
  if (!measuring.value && measurePanelOpen.value) closeMeasurePanel();
  selectedHex.value = null;
  searchResultCount.value = null;
  searchError.value = '';
  mapNoticesVisible.value = false;
  popup?.remove();
}
//右侧属性面板
function loadStatistics(hexData) {
  hexCount.value = hexData.features.length;

  occupiedHexCount.value = hexData.features.filter(
    (hex) => hex.properties.stationCount > 0,
  ).length;
  const countMap = {}; //初始化统计图表
  for (const hex of hexData.features) {
    //遍历六边形的相关数据
    const count = Number(hex.properties.stationCount); //得到每一片六边形的充电桩数量
    countMap[count] = (countMap[count] || 0) + 1;
  }
  hexDistribution.value = Object.entries(countMap) //转换为键值对对象
    .map(([stationCount, hexCount]) => ({
      //充电桩数量,这样的六边形的数量
      stationCount: Number(stationCount),
      hexCount,
    }))
    .sort((a, b) => a.stationCount - b.stationCount);
}
//供需类型数据汇总
// ==========================================
// 统计四种供需类型分别有多少个六边形
// ==========================================
const supplyDemandStats = computed(() => {

  // 初始四种类型都从 0 开始
  const result = {
    highDemandLowSupply: 0,
    highDemandHighSupply: 0,
    lowDemandHighSupply: 0,
    lowDemandLowSupply: 0
  }

  // 如果六边形数据还没加载，就先返回全 0
  if (!displayedHexData.value?.features) {
    return result
  }

  displayedHexData.value.features.forEach((feature) => {

    const type =
      feature.properties?.supplyDemandType

    if (type === 'high-demand-low-supply') {
      result.highDemandLowSupply++
    }

    else if (
      type === 'high-demand-high-supply'
    ) {
      result.highDemandHighSupply++
    }

    else if (
      type === 'low-demand-high-supply'
    ) {
      result.lowDemandHighSupply++
    }

    else if (
      type === 'low-demand-low-supply'
    ) {
      result.lowDemandLowSupply++
    }
  })

  return result
})
/*hexData
↓
170个 Feature
↓
读取 supplyDemandType
↓
分类计数
↓
supplyDemandStats */

</script>
<template>
  <div :class="['dashboard',{ 'map-fullscreen': isFullscreen }]" @click="dismissMapWindows">
    <slot name="header" :panel="analysisPanel" :select-panel="selectAnalysisPanel" :planned-count="layoutPreview.points?.length || 0" />
    <FloatingWorkspace :view="analysisPanel" :fullscreen="isFullscreen || analysisPanel === 'map'" :class="{ 'pss-wide': ['grid','carbon'].includes(analysisPanel), 'pss-siting-workspace': analysisPanel === 'siting' }" @panel-resize="map?.resize()">
      <MovablePanel panel-id="map" title="地图" placement="map" map :available="!['grid','carbon'].includes(analysisPanel)" :min-width="280" :min-height="250">
      <section class="map-area" :class="{ 'sandbox-active': layoutPreview.editing, 'sandbox-editing': layoutPreview.editing && layoutPreview.stage === 'after' }" aria-label="魏都区充电设施地图">
        <div ref="mapEl" class="map-canvas"></div>
        <section v-if="analysisPanel === 'siting'" class="siting-map-summary" aria-label="地图中的选址位置" @click.stop>
          <div><b>地图与右表编号对应</b><span>{{ sitingCandidateRows.length }} 个候选</span><button :disabled="!sitingCandidateRows.length" aria-label="查看全部候选位置" @click="showSitingOverview">查看全部 ↗</button></div>
          <template v-if="sitingCandidate"><strong>{{ sitingCandidate.rank }} 号 · {{ sitingCandidate.areaName }}</strong><p v-if="sitingCandidate.nearestStation">距 {{ sitingCandidate.nearestStation.properties.name || '未命名站点' }} 约 <b>{{ Math.round(sitingCandidate.nearestMeters) }} m</b>（直线）。蓝色虚线连接两处。</p></template>
          <p v-else>当前条件下没有候选，可调整右侧筛选条件。</p>
        </section>
        <div v-if="analysisPanel === 'siting'" class="siting-map-key"><span><i class="key-selected"></i>当前选中的拟建位置</span><span><i class="key-candidate"></i>其他可比较的拟建位置</span><span><i class="key-station"></i>已有充电站</span><span v-if="sitingImpact?.affectedPlaces.length" style="color:#0b9473">● 原来 1 km 内无站，现在有站</span><span v-if="sitingImpact?.affectedPlaces.length" style="color:#347fd6">● 到最近站更近</span></div>
        <div v-if="layoutPreview.editing" class="sandbox-map-hint" role="status"><span><b>{{ layoutPreview.center ? '定位周边' : '全区布局' }}</b> · {{ layoutPreview.tool === 'locate' ? '点击选定位' : layoutPreview.tool === 'inspect' || layoutPreview.stage === 'before' ? '查看对比' : layoutPreview.tool === 'remove' ? '点击移除／恢复' : '点击新增／编辑' }}</span><button @click="scrollSandboxPanel">模拟面板</button></div>

        <!-- 地图操作收拢在一处，规划工作台导航独立于地图状态。 -->
        <div class="planner-map-toolbar">
        <div class="analysis-search">
        <form class="map-search" @submit.prevent="searchStation">
          <UiIcon name="search" :size="19" />
          <input ref="searchInput" v-model="stationKeyword" aria-label="搜索充电站" placeholder="搜索充电站名称" @focus="openSearchPanel" />
          <button type="submit" :disabled="loading">搜索</button>
        </form>
        <div v-if="searchPanelOpen" class="map-search-panel" aria-label="站点搜索与历史记录" @click.stop>
          <template v-if="searchResultCount !== null">
            <div class="search-panel-heading"><b>搜索结果</b><small>{{ searchResultCount }} 个站点</small></div>
            <button v-for="station in matchingStations" :key="station.properties.id" class="search-station-item" @click="selectSearchStation(station)"><UiIcon name="pin" :size="16" /><span>{{ station.properties.name }}</span></button>
            <p v-if="!matchingStations.length" class="search-panel-empty">没有找到匹配的站点</p>
          </template>
          <div class="search-panel-heading"><b>搜索记录</b><button v-if="searchHistory.length" @click="clearSearchHistory">清空</button></div>
          <button v-for="keyword in searchHistory" :key="keyword" class="search-history-item" :disabled="loading" @click="useSearchHistory(keyword)"><UiIcon name="clock" :size="16" /><span>{{ keyword }}</span></button>
          <p v-if="!searchHistory.length" class="search-panel-empty">暂无搜索记录</p>
        </div>
        <div v-if="searchResultCount !== null" class="search-feedback" role="status">
          <span>找到 {{ searchResultCount }} 个站点</span>
          <button aria-label="关闭搜索提示" @click="searchResultCount = null"><UiIcon name="close" :size="13" /></button>
        </div>
        </div>
          <MapLayerControl :open="quickPanelOpen" :layers="mapLayerItems" :loading="loading" :facility-loading="facilityLoading" :facility-error="facilityError" :comparison-available="!!layoutPreview.result?.macro?.comparison && layoutPreview.editing" :comparison-visible="planningComparisonActive" :fast-only="fastOnly" :has-charge-type-data="hasChargeTypeData" @toggle="toggleQuickPanel" @close="closeMapPanels" @toggle-layer="toggleLayer($event.id, $event.visible)" @toggle-comparison="togglePlanningComparison" @toggle-fast="toggleFastOnly" @retry-facilities="loadFacilityData" />
        </div>
        <!-- 底图切换 -->
        <div class="basemap-switch" aria-label="底图切换">
          <button v-for="item in [{id:'street',label:'标准'},{id:'satellite',label:'卫星'},{id:'terrain',label:'地形'}]" :key="item.id" :class="['basemap-option',item.id,{chosen:activeBasemap===item.id}]" :aria-pressed="activeBasemap===item.id" @click="setBasemap(item.id)"><span class="basemap-preview"></span><span>{{ item.label }}</span></button>
        </div>

        <!-- 右上角工具：图层切换、测距、全屏、定位 -->
        <div class="map-tools map-tools-top" aria-label="地图工具">
          <button :class="['boundary-tool',{active:boundaryPanelOpen}]" title="边界控制" aria-label="边界控制" :aria-expanded="boundaryPanelOpen" aria-controls="map-boundary-panel" @click.stop="toggleBoundaryPanel"><UiIcon name="boundary" :size="19" /><span></span></button>
          <button :class="{active:measuring}" title="测距" aria-label="测距" :aria-pressed="measuring" :disabled="layoutPreview.editing" @click="toggleMeasure"><UiIcon name="ruler" :size="19" /></button>
          <button :class="{active:isFullscreen}" :title="isFullscreen ? '退出全屏' : '全屏'" :aria-label="isFullscreen ? '退出全屏' : '全屏'" :aria-pressed="isFullscreen" @click="toggleFullscreen"><UiIcon :name="isFullscreen ? 'compress' : 'expand'" :size="19" /></button>
          <button :disabled="locating" :aria-busy="locating" :title="locating ? '定位中…' : '定位当前位置'" :aria-label="locating ? '定位中' : '定位当前位置'" @click="locateUser"><UiIcon name="locate" :size="19" /></button>
        </div>

        <!-- 测距面板 -->
        <div v-if="measurePanelOpen" class="measure-panel">
          <button class="selected-close" aria-label="关闭测距面板" @click="closeMeasurePanel"><UiIcon name="close" :size="14" /></button>
          <b>测距</b>
          <span class="measure-value">{{ measureText }}</span>
          <span class="measure-hint">{{ measureHint }}</span>
          <div class="measure-actions"><button v-if="measuring" @click="finishMeasure">结束</button><button @click="clearMeasure">清除</button></div>
        </div>

        <!-- 行政边界设置独立于业务图层 -->
        <div v-if="boundaryPanelOpen" id="map-boundary-panel" class="quick-panel map-boundary-panel" aria-label="行政边界控制" @click.stop>
          <div class="map-panel-heading"><b>边界控制</b><button aria-label="关闭边界控制" @click="closeMapPanels(false)"><UiIcon name="close" :size="15" /></button></div>
          <p class="map-panel-note">魏都区行政范围</p>
          <label class="layer-row"><input type="checkbox" :checked="boundaryVisible" :disabled="loading" @change="toggleLayer('boundary', $event.target.checked)" /><span class="layer-symbol"><UiIcon name="boundary" :size="16" /></span><span>显示行政边界</span></label>
          <label :class="['layer-row',{muted:!boundaryVisible}]"><input type="checkbox" :checked="boundaryFill" :disabled="loading || !boundaryVisible" @change="toggleBoundaryFill($event.target.checked)" /><span>显示区域填充</span></label>
          <label class="boundary-opacity"><span>填充不透明度 <output>{{ boundaryOpacity }}%</output></span><input type="range" min="0" max="50" step="0.5" :value="boundaryOpacity" :disabled="loading || !boundaryVisible || !boundaryFill" @input="setBoundaryOpacity($event.target.value)" /></label>
          <button class="boundary-fit" :disabled="loading || !boundaryBounds" @click="fitBoundary"><UiIcon name="locate" :size="16" />定位魏都区范围</button>
        </div>

        <div v-if="mapNoticesVisible && (loadError || gridWarning || searchError || locationError)" class="load-message" role="alert"><UiIcon name="alert" :size="16" />{{ loadError || gridWarning || searchError || locationError }}</div>

        <!-- 图例：同时展示当前开启图层的符号与分级，关闭图层后同步移除 -->
        <div v-if="!loading && activeLegends.length" class="map-legend" aria-label="当前显示图层的图例" tabindex="0">
          <h3>图例</h3>
          <section v-for="legend in activeLegends" :key="legend.id" class="legend-group" :data-legend="legend.id" :aria-label="legend.title + '图例'">
            <h4>{{ legend.title }}<TermHint v-if="['demandIndex', 'mismatch', 'supplyDemandType', 'facilityService'].includes(legend.id)" icon-only :label="legend.title" :term="legend.id === 'demandIndex' ? 'demandIndex' : legend.id === 'mismatch' || legend.title.includes('失配') ? 'mismatchIndex' : legend.id === 'facilityService' ? 'match' : 'quadrant'" /></h4>
            <div v-for="item in legend.items || []" :key="item.label" class="legend-item">
              <span v-if="item.icon" class="legend-glyph" :style="{ '--legend-color': item.color }"><UiIcon :name="item.icon" :size="16" :style="{ color: item.color }" /></span><i v-else :class="['legend-symbol', 'legend-' + (item.kind || 'swatch')]" :style="{ '--legend-color': item.color, '--legend-opacity': item.opacity ?? 1 }" aria-hidden="true"></i><span>{{ item.label }}</span><small v-if="item.hidden" class="legend-hidden-note">已隐藏</small>
            </div>
            <template v-if="legend.gradient">
              <div class="legend-gradient" :style="{ background: legend.gradient }" aria-hidden="true"></div>
              <div class="legend-range"><span v-for="label in legend.range" :key="label">{{ label }}</span></div>
            </template>
            <p v-if="legend.note" class="legend-note">{{ legend.note }}</p>
          </section>
        </div>

        <!-- 缩放与定位 -->
        <div class="map-tools">
          <button title="放大" aria-label="放大" @click="zoomMap(1)"><UiIcon name="plus" :size="19" /></button>
          <button title="缩小" aria-label="缩小" @click="zoomMap(-1)"><UiIcon name="minus" :size="19" /></button>
          <button title="回到魏都区" aria-label="回到魏都区" @click="resetView"><UiIcon name="locate" :size="19" /></button>
        </div>

        <!-- 当前选中网格 -->
        <div v-if="!authenticated" class="guest-map-note"><UiIcon name="compass" :size="16" /><span>游客浏览<span class="guest-map-detail"> · 登录后使用空间分析与规划工具</span></span><button @click="emit('require-login', {})">登录解锁 →</button></div>
        <button v-if="authenticated" class="planner-reference-toggle" :class="{active:pssSpacingVisible}" :aria-pressed="pssSpacingVisible" @click.stop="pssSpacingVisible = !pssSpacingVisible">{{ pssSpacingRadius }} m 间距参考圈</button>
        <PlannerGridDetails v-if="authenticated && analysisPanel !== 'siting'" :grid="selectedHex" :factors="pssGridData.features.find(feature => String(feature.properties.id) === String(selectedHex?.id))?.properties" :planned="layoutPreview.points?.some(feature => String(feature.properties.planningGridId) === String(selectedHex?.id))" @close="selectedHex = null" @add="toggleGridCandidate" @plan="startCandidatePlanning(hexData?.features.find(feature => String(feature.properties.id) === String(selectedHex?.id)))" />
      </section>
      </MovablePanel>

      <MovablePanel v-if="authenticated" panel-id="analysis" title="分析面板" placement="analysis" :available="analysisPanel !== 'map'" :min-width="300" :min-height="220">
      <aside class="right-sidebar explorer-panel" aria-label="数据分析">
        <ExplorerPanelHeading label="" :title="analysisPanel === 'sandbox' ? '方案推演' : '供需总览'" :description="analysisPanel === 'sandbox' ? '调整站点配置，比较方案前后的服务变化。' : '从现状分布出发，识别需要优先关注的区域。'" :icon="analysisPanel === 'sandbox' ? 'compass' : 'chart'" />
        <div class="explorer-panel-body">
        <div v-show="analysisPanel === 'carbon'" id="analysis-carbon" role="region" aria-labelledby="analysis-carbon-tab"><PlannerChargingCarbon /></div>
        <p v-if="pssNotice && analysisPanel === 'siting'" class="pss-alert" role="status">{{ pssNotice }}</p>
        <div v-show="analysisPanel === 'siting'" id="analysis-siting" role="region" aria-labelledby="analysis-siting-tab"><PlannerSiting ref="sitingPanel" :boundary="businessData.weidu" @impact-preview="sitingImpact = $event" @construction-options="constructionOptions = $event" @focus-place="focusPlanningPlace" @focus-station="focusPlanningPlace" :demand-pois="demandPoiFeatures" :selected-id="sitingSelectedId" @candidates-change="receiveSitingCandidates" :features="planningFeatures" :stations="planningStations" :points="layoutPreview.points || emptyFeatures" :loading="loading" :data-scope="layoutPreview.dataScope" :buffer-visible="pssSpacingVisible" @focus-grid="focusSitingGrid" @toggle-candidate="toggleSitingCandidate" @add-candidates="addSitingCandidates" @show-buffer="setSpacingBuffer" @factors-change="pssFactors = $event" @open-simulation="analysisPanel = 'sandbox'" @set-scope="sandboxPanel?.setDataScope($event)" /></div>
        <div v-show="analysisPanel === 'grid'" id="analysis-grid" role="region" aria-labelledby="analysis-grid-tab"><PlannerGridCapacity :stations="draftStations" :before-stations="planningStations" :additions="layoutPreview.points?.length || 0" /></div>
        <div v-show="analysisPanel === 'overview'" id="analysis-overview" role="region" aria-labelledby="analysis-overview-tab">
        <label class="pss-field planner-data-scope">规划数据范围<select :value="layoutPreview.dataScope || 'all'" @change="sandboxPanel?.setDataScope($event.target.value)"><option value="all">含虚拟演示站点</option><option value="recorded">已记录点位（排除虚拟站）</option></select></label>
        <PlannerOverview :features="displayedHexData?.features" :stations="displayedStations" :demand-pois="demandPoiFeatures" :loading="loading" :error="loadError" :distribution="displayedDistribution" :highlighted-count="gridHighlightSelection" :selected-id="selectedHex?.id" @focus-grid="focusHex" @plan-grid="startCandidatePlanning" @highlight-count="highlightHexByStationCount" @clear-highlight="clearDistributionHighlight" @grid-overview="showGridOverview" @show-quadrants="toggleLayer('supplyDemandType', true)" @start-planning="analysisPanel = 'sandbox'" />
        <section class="planner-blind-diagnostics" aria-label="空间盲点与泰森诊断"><h3>空间盲点与最近站分区</h3><p class="pss-note">{{ pssSpacingRadius }} m 直线范围外：<b>{{ loading ? '—' : pssBlindSpots.length }}</b> / {{ demandPoiFeatures.length }} 个需求点。作为服务盲点排查线索。</p><label class="pss-check"><input v-model="pssBlindVisible" type="checkbox" />显示圈外需求点（红点）</label><label class="pss-check"><input v-model="pssVoronoiVisible" type="checkbox" />显示最近站泰森分区（紫线）</label><p class="pss-note">按当前站点范围计算，泰森分区裁剪到研究区，仅表达几何最近站关系；直线范围外不等于没有道路或实际充电服务。</p><button class="pss-link" @click="analysisPanel = 'siting'">进入约束过滤与多准则选址 →</button></section>
        </div>
        <div v-show="analysisPanel === 'sandbox'" id="analysis-sandbox" role="region" aria-labelledby="analysis-sandbox-tab">
          <FacilitySuggestions ref="sandboxPanel" :construction-factors="pssFactors" :construction-options="constructionOptions" :active="analysisPanel === 'sandbox'" :features="hexData?.features || emptyFeatures" :demand-pois="demandPoiFeatures" :stations="allStationFeatures" :boundary="businessData.weidu" :loading="loading" :locating="locating" :location-error="locationError" @locate="locateUser(true)" @district="fitBoundary" @focus-location="focusAnalysisLocation" @focus-point="focusSandboxPoint" @focus-place="focusPlanningPlace" @preview="showLayoutScenario" />
        </div>
        </div>
      </aside>
      </MovablePanel>
    </FloatingWorkspace>

    <footer class="statusbar">
      <span><UiIcon name="pin" :size="14" />当前位置：许昌市 魏都区</span>
      <span>{{ displayedResult ? '沙盘结果' : '数据范围' }}：魏都区 · {{ loading || loadError ? '—' : displayedStationCount }} 个站点</span>
      <span class="status-weather" role="status"><i class="status-dot" :class="{ warning: loadError || gridWarning }"></i>{{ loading ? '正在加载数据' : loadError || gridWarning ? '部分数据不可用' : '数据已加载' }}</span>
    </footer>
  </div>
</template>
