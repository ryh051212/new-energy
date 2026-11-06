<script setup>
import { readGeoJSON } from '../../shared/api/geojson.js';
import { fetchStudyArea, fetchFacilityCatalog } from './api/mapData.js';
import { useSitingMap } from './composables/useSitingMap.js';
import { assessSitingLocation, featuresInSitingScope, sitingRestriction } from '../planning/models/sitingSelection.js';
import { createMapLayerGroups, createMapLegends } from './config/mapLayers.js';
import { SITING_CONTEXT_LAYERS } from './config/sitingContextLayers.js';
import { contextPopupLines } from '../planning/models/sitingContext.js';
import { constructionMapData } from '../planning/models/constructionMap.js';
import { registerConstructionIcons, CONSTRUCTION_REFERENCE_LAYERS } from './config/constructionLayers.js';

import { createMapStyle } from './config/mapStyle.js';
import { useMapMeasure } from './composables/useMapMeasure.js';
import { useMapLocation } from './composables/useMapLocation.js';
import { useStationSearch } from './composables/useStationSearch.js';
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import * as maplibregl from 'maplibre-gl';
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import UiIcon from "../../shared/components/UiIcon.vue";
import FloatingWorkspace from '../../shared/layout/FloatingWorkspace.vue';
import MovablePanel from '../../shared/layout/MovablePanel.vue';
import PlanningPages from '../planning/components/PlanningPages.vue';
import TermHint from '../../shared/components/TermHint.vue';
import FacilitySuggestions from '../planning/components/FacilitySuggestions.vue';
import MapLayerControl from './components/MapLayerControl.vue';
import ExplorerPanelHeading from '../../shared/layout/ExplorerPanelHeading.vue';
import OverviewAnalysisPanel from '../planning/components/OverviewAnalysisPanel.vue';
import RoadPlanningWorkbench from '../planning/components/RoadPlanningWorkbench.vue';
import PlannerSiting from '../planning/components/PlannerSiting.vue';
import { functionalZoneModel, applyDemandScenario, mergeActivityPois, FUNCTIONAL_ZONES } from '../planning/models/functionalZones.js';
import { buildGridTemporalDemand, spatialDemandIntensity, temporalDemandScale, currentTemporalDemandGrid } from '../planning/models/gridTemporalDemand.js';
import PlannerGridCapacity from '../planning/components/PlannerGridCapacity.vue';
import PlannerChargingCarbon from '../carbon/components/PlannerChargingCarbon.vue';
import { planningRows, planningBlindSpots, planningVoronoi } from '../planning/models/plannerPss.js';
import { stationConfiguration } from '../planning/models/facilityDemand.js';
import { stationOpenStatus } from '../stations/models/stationOpenStatus.js';
import { facilityComparisonView } from '../planning/models/facilityComparison.js';
import { toMapCoordinate, fromMapCoordinate, toMapGeoJSON } from './config/basemaps.js';
import { chargingMapIcon, chargingMapColor, registerChargingIcons } from '../stations/models/chargingIcons.js';
import { apiFetch } from '../../shared/api/client.js';
import { analysisPanelRoutes } from '../auth/models/auth.js';
import { FACILITY_MAP_LAYERS, facilityPopupLines } from './config/facilityMapLayers.js';

// 让 Vite 同时打包 MapLibre 处理地图数据的 Worker。
maplibregl.setWorkerUrl(workerUrl);

// FastAPI 是前端正式数据入口。
// public/geojson 中的文件只保留为原始数据或备份，不再参与正式运行。
const props = defineProps({ activeRoute: { type: String, default: '/' }, page: { type: Object, default: null }, authenticated: { type: Boolean, default: false } });
const emit = defineEmits(['require-login', 'select-panel']);
const panelTitles = { map:'充电站分布', overview:'空间供需', siting:'布局规划', sandbox:'布局规划', grid:'车网协同', carbon:'双碳评估' };
const panelForRoute = route => route === '/monitoring/stations' ? 'map' : route === '/planning/grid' ? 'grid' : route === '/planning/carbon' ? 'carbon' : ['/planning/candidates', '/planning/problems', '/planning/suggestions'].includes(route) ? 'sandbox' : 'overview';
const analysisPanel = ref(props.authenticated ? panelForRoute(props.activeRoute) : 'map');
function allowAnalysis(panel, resume) {
  if (props.authenticated) return true;
  emit('require-login', { label:panelTitles[panel] || '空间分析', path:analysisPanelRoutes[panel], run:resume });
  return false;
}
function selectAnalysisPanel(panel) {
  if (panel === 'siting') panel = 'sandbox';
  if (!panelTitles[panel]) return;
  if (panel !== 'map' && !allowAnalysis(panel, () => selectAnalysisPanel(panel))) return;
  analysisPanel.value = panel;
  if (panelForRoute(props.activeRoute) !== panel) emit('select-panel', panel);
}
watch(() => props.activeRoute, route => { selectAnalysisPanel(panelForRoute(route)); });
watch(() => props.authenticated, authenticated => {
  if (authenticated) { analysisPanel.value = panelForRoute(props.activeRoute); return; }
  analysisPanel.value = 'map';
  layoutPreview.value = { stage:'before', features:[] };
  sitingCandidateRows.value = [];
  selectedHex.value = null;
  selectedStation.value = null;
  pssBlindVisible.value = false;
  pssVoronoiVisible.value = false;
  pssSpacingVisible.value = false;
  pssFactors.value = {};
  lastPlanningResult.value = null;
  isFullscreen.value = false;
  popup?.remove();
  refreshBusinessSources();
  nextTick(() => map?.resize());
});
watch(analysisPanel, async panel => {
  if (['sandbox','grid','carbon'].includes(panel)) isFullscreen.value = false;
  if (panel === 'sandbox') { pssSpacingVisible.value = false; pssBlindVisible.value = false; pssVoronoiVisible.value = false; }
  if (panel === 'siting' && !sitingSelection.value) functionalMapMode.value = 'base';
  await nextTick();
  if (!controller.signal.aborted) {
    const body = document.querySelector('.explorer-panel-body');
    if (body) body.scrollTop = 0;
    map?.resize();
    refreshBusinessSources();
    if (panel === 'siting') refreshSitingSelection();
  }
});
const searchInput = ref(null);
const roadResearchPanel = ref(null);
const planningDrawer = ref('layout');
function analyzeRoadDraft(){
  if(loading.value || roadResearchPanel.value?.busy)return;
  planningDrawer.value='effects';roadResearchPanel.value?.calculate('analyze');
}
const roadResearchResult = ref(null), roadResearchView = ref({metric:'coverage',stage:'before'});
const activityWeights = ref({residential:1,work:1,shopping:1,leisure:1,public:1});
const roadMapActive = computed(() => !!roadResearchResult.value && roadResearchView.value.metric !== 'none' && analysisPanel.value === 'sandbox');
let roadResearchMarkers = [];
watch([roadResearchResult,roadResearchView,analysisPanel],refreshRoadResearch);
function setRoadResearchView(value){roadResearchView.value=value;refreshRoadResearch()}
async function applyRoadResearchPlan({features,removedIds,parameters}){
  demandScenarioId.value=parameters.scenarioId;
  activityWeights.value={...parameters.activityWeights};
  sandboxPanel.value?.setDataScope(parameters.dataScope);
  selectAnalysisPanel('sandbox');
  await nextTick();
  planningDrawer.value='layout';
  try {sandboxPanel.value?.replaceRoadPlan(features,removedIds)} catch(error){pssNotice.value=error.message}
}
function focusRoadResearch(feature){
  if(!map)return;
  if(feature.geometry.type!=='Point'){
    const center=toMapCoordinate(turf.centerOfMass(feature).geometry.coordinates,activeBasemap.value);
    map.flyTo({center,zoom:14,duration:500});showRoadGridPopup(feature,center);return;
  }
  const center=toMapCoordinate(feature.geometry.coordinates,activeBasemap.value);
  map.flyTo({center,zoom:15,duration:500});
  if(feature.properties.roadPlanning)showRoadResearchPopup(feature,center);
  else showStationPopup(toMapGeoJSON(feature,activeBasemap.value));
}
function showRoadResearchPopup(feature,position){
  const p=feature.properties, minutes=v=>v==null?'不可达':(v/60).toFixed(2)+' 分钟';
  popup?.remove();
  popup=new maplibregl.Popup({maxWidth:'320px'}).setLngLat(position).setDOMContent(popupContent([
    p.name || '需求地点',`道路最近站时间：${minutes(p.beforeSeconds)} → ${minutes(p.afterSeconds)}`,
    `新增前最近站：${p.beforeNearest || '无'}`,`新增后最近站：${p.afterNearest || '无'}`,
    `时间变化：${p.timeSavedSeconds==null?'无法比较':(p.timeSavedSeconds>=0?'缩短 ':'增加 ')+(Math.abs(p.timeSavedSeconds)/60).toFixed(2)+' 分钟'}`,
    `容量服务指数：${p.beforeCapacityIndex.toFixed(1)} → ${p.afterCapacityIndex.toFixed(1)}`,
  ])).addTo(map);
}
function showRoadGridPopup(feature,position){
  const p=feature.properties,number=(v,unit='')=>v==null?'—':Number(v).toFixed(2)+unit;
  const unavailable=p.demandPointCount===0?'无估计需求地点':'当前路网未找到可达站';
  const nearest=stage=>p[stage+'Nearest'] || unavailable;
  const travel=stage=>p[stage+'NearestMinutes']==null?unavailable:number(p[stage+'NearestMinutes'],' 分钟');
  popup?.remove();
  const content=popupContent([
    '网格 #'+p.id,`情景需求指数：${number(p.scenarioDemandIndex)}`,
    `需求覆盖：${number(p.beforeCoverage,'%')} → ${number(p.afterCoverage,'%')}`,
    `新增前最近站：${nearest('before')}`,
    `新增后最近站：${nearest('after')}`,
    `格内最快到站（道路）：${travel('before')} → ${travel('after')}`,
    `平均到站（可达地点）：${number(p.beforeMinutes,' 分钟')} → ${number(p.afterMinutes,' 分钟')}`,
    ...(p.beforeUnreachableDemandPercent>0||p.afterUnreachableDemandPercent>0?[`不可达需求：${number(p.beforeUnreachableDemandPercent,'%')} → ${number(p.afterUnreachableDemandPercent,'%')}`]:[]),
    '最近站取格内需求地点的最短道路时间，不限覆盖阈值',
    `容量服务指数：${number(p.beforeCapacityIndex)} → ${number(p.afterCapacityIndex)}`,
  ]);
  content.style.maxHeight=Math.max(100,Math.min(340,(map.getCanvas().clientHeight||700)/2-30))+'px';
  content.style.boxSizing='border-box';
  popup=new maplibregl.Popup({maxWidth:'320px'}).setLngLat(position).setDOMContent(content).addTo(map);
}
function refreshRoadResearch(){
  if(!map||controller.signal.aborted||!map.getSource('road-research-grids'))return;
  roadResearchMarkers.forEach(marker=>marker.remove());roadResearchMarkers=[];
  const enabled=roadMapActive.value,result=roadResearchResult.value,view=roadResearchView.value;
  const empty={type:'FeatureCollection',features:[]};
  map.getSource('road-research-grids').setData(toMapGeoJSON(enabled?result.grids:empty,activeBasemap.value));
  map.getSource('road-research-places').setData(toMapGeoJSON(enabled&&view.stage==='after'?{...result.places,features:result.places.features.filter(p=>p.properties.beforeCovered!==p.properties.afterCovered||Math.abs(p.properties.timeSavedSeconds || 0)>=1)}:empty,activeBasemap.value));
  const selectedIds=new Set(result?.selectedStations.features.map(f=>f.properties.id)||[]);
  map.getSource('road-research-sites').setData(toMapGeoJSON(enabled&&analysisPanel.value==='sandbox'&&result.selection&&!localSitingSelection.value?.center?{...result.candidates,features:result.candidates.features.filter(f=>!selectedIds.has(f.properties.id))}:empty,activeBasemap.value));
  if(map.getLayer('road-research-fill')){
    const field=({demand:'scenarioDemandIndex',coverage:view.stage+'Coverage',time:view.stage+'Minutes',capacity:view.stage+'CapacityIndex',gap:'gapClass',deltaCoverage:'deltaCoverage',deltaMinutes:'deltaMinutes',deltaCapacityIndex:'deltaCapacityIndex'})[view.metric]||'beforeCoverage';
    let color;
    if(view.metric==='gap')color=['match',['get',field],'high-gap','#c84d3c','low-gap','#f1b95e','high-covered','#3d8d94','low-covered','#c2d9d3','#cbd5e1'];
    else {const delta=view.metric.startsWith('delta'), time=view.metric==='time';const stops=delta?[-50,'#ce665b',0,'#f1f5f9',50,'#24997a']:time?[0,'#2e9a7b',10,'#f0c36b',20,'#c45d46']:view.metric==='capacity'?[0,'#f1f5f9',100,'#80c5c2',200,'#24758c']:view.metric==='demand'?[0,'#f5f2e9',.5,'#efb55f',1,'#bc4d35']:[0,'#f7e5d8',50,'#f0ce85',100,'#469b85'];
      if(view.metric==='deltaMinutes')stops.splice(0,stops.length,-5,'#24997a',0,'#f1f5f9',5,'#ce665b');
      color=['case',['==',['get',field],null],'#cbd5e1',['interpolate',['linear'],['coalesce',['get',field],0],...stops]];
    }
    map.setPaintProperty('road-research-fill','fill-color',color);
  }
  if(enabled&&view.stage==='after'&&analysisPanel.value==='sandbox')result.selectedStations.features.forEach((feature,index)=>{
    const button=document.createElement('button');button.type='button';button.className='siting-candidate-marker selected';button.textContent=String(index+1);button.title=feature.properties.name;
    button.addEventListener('click',event=>{event.stopPropagation();showStationPopup(toMapGeoJSON(feature,activeBasemap.value))});
    roadResearchMarkers.push(new maplibregl.Marker({element:button}).setLngLat(toMapCoordinate(feature.geometry.coordinates,activeBasemap.value)).addTo(map));
  });
  if(enabled){
    const removed=new Set(view.stage==='after'?result.parameters.removedIds:[]);
    map.getSource('stations')?.setData(toMapGeoJSON({type:'FeatureCollection',features:result.baselineStations.features.filter(s=>!removed.has(String(s.properties.id)))},activeBasemap.value));
    map.getSource('facility-proposals')?.setData(empty);
    map.getSource('facility-removals')?.setData(empty);
  }else{refreshLayoutPreview();refreshFunctionalMap();refreshPlanningImpact()}
  for(const id of ['planning-impact-point','facility-place-point','facility-service-fill','functional-zones-fill'])if(map.getLayer(id)){
    if(enabled)map.setLayoutProperty(id,'visibility','none');
    else if(id==='planning-impact-point'||id==='facility-place-point')map.setLayoutProperty(id,'visibility','visible');
  }
  layerGroups.value.forEach(updateLayerVisibility);
}

// 用户输入的充电站名称

function showStationPopup(station) {
  if (['overview', 'map'].includes(analysisPanel.value) && !layoutPreview.value.editing) {
    selectStationDetail(station);
    return;
  }
  const properties = station.properties || {};
  const typeLabel = ({ fast:'快充', regular:'普通充电' })[properties.chargeType] || '类型待核实';
  const open = stationOpenStatus(properties);
  const equipment = [
    properties.totalCount == null ? '枪/桩数待补充' : `${properties.totalCount} 枪/桩`,
    properties.powerKw == null ? '功率待补充' : `${properties.powerKw} kW`,
    open.hours,
  ].filter(Boolean).join(' · ');
  popup?.remove();
  const content = popupContent([
    properties.name || '充电站',
    '地址：' + (properties.address || '暂无'),
    `${typeLabel} · 开放状态：${open.label}`,
    '设备：' + equipment,
    '说明：' + open.note,
  ]);
  popup = new maplibregl.Popup({ maxWidth: '320px' })
    .setLngLat(station.geometry.coordinates)
    .setDOMContent(content).addTo(map);
}

const mapEl = ref(null);
const sandboxPanel = ref(null);
const sitingPanel = ref(null);
const sitingCandidateRows = ref([]), sitingSelectedId = ref('');
const planningAssistOpen = ref(false);
const localSitingSelection = ref(null);
const sitingSelection = ref(null), sitingPicking = ref(true), sitingSelectionError = ref('');
let sitingPickCursor = 'crosshair';
const sitingLegendExpanded = ref(false), sitingLegendCompact = ref(false);
function resizeSitingLegend() {
  const compact = (mapEl.value?.clientWidth || 800) < 540;
  if (compact !== sitingLegendCompact.value) {
    sitingLegendCompact.value = compact;
    sitingLegendExpanded.value = false;
  }
}

const weiduStationCount = ref(0);
let map;
let popup;
let weiduPolygons = [];
let businessData = {};
const stationCount = ref(0); //真实的充电桩数量
const allStationFeatures = ref([]);
const demandPoiFeatures = ref([]);
const facilityPois = ref([]), facilityLoading = ref(false), facilityLoaded = ref(false), facilityError = ref('');
const roadLoading=ref(false),roadLoaded=ref(false),roadError=ref(''),roadMetadata=ref(null);
const roadFeatures=ref([]),sitingContextData=ref(null),contextLoading=ref(false),contextError=ref('');
const facilityCounts = computed(() => Object.fromEntries(FACILITY_MAP_LAYERS.map(layer =>
  [layer.category, facilityPois.value.filter(feature => feature.properties.categories.includes(layer.category)).length])));

const activeBasemap = ref('street');
// ==================== 本次新增的界面状态 ====================
// 测距：是否正在测距、已经点过的坐标、是否显示测距结果面板

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
const regularCount = computed(() => allStationFeatures.value.filter(item => item.properties?.chargeType === 'regular').length);
const hasChargeTypeData = computed(() => allStationFeatures.value.length > 0);
const gridHighlightSelection = ref(null);
const layoutPreview = ref({ stage: 'before', features: [] });
const pssSpacingVisible = ref(false), pssSpacingRadius = ref(400), pssFactors = ref({}), pssNotice = ref('');
const constructionOptions=ref({radius:0,powerFactor:.9,minimumSpaces:0});
const pssBlindVisible = ref(false), pssVoronoiVisible = ref(false);
const planningComparisonShown = ref(true), lastPlanningResult = ref(null);
const planningComparisonActive = computed(() => layoutPreview.value.local && layoutPreview.value.editing && planningComparisonShown.value && !!layoutPreview.value.result?.macro?.comparison);
const comparisonView = computed(() => facilityComparisonView(layoutPreview.value.result?.macro
  ? { ...layoutPreview.value, result: layoutPreview.value.result.macro, stage: layoutPreview.value.stage === 'after' ? 'change' : 'before' }
  : layoutPreview.value));
const mapNoticesVisible = ref(true);
// 图例颜色、分级与地图渲染保持一致，是否显示由图层开关决定。
const layerLegends = createMapLegends();
const coverageRate = computed(() => hexCount.value ? Math.round(occupiedHexCount.value / hexCount.value * 100) : 0);

const hexCount = ref(0); // 六边形总数

const occupiedHexCount = ref(0); //至少有一个充电桩的六边形数量
const residentialCount = ref(0); // 居民小区总数
const commercialCount = ref(0); // 网格内商业设施总数

const selectedHex = ref(null); // 当前点击的六边形
const selectedStation = ref(null);
// 传给统计图表的“站点数-网格数”分布数据。
const hexDistribution = ref([]);
// 保存加载并处理后的六边形 GeoJSON，供统计和供需分类使用。
const hexData = ref(null);
const emptyFeatures = [];
const displayedResult = computed(() => layoutPreview.value.editing && layoutPreview.value.stage !== 'before' ? layoutPreview.value.result?.macro || layoutPreview.value.result || null : null);
const displayedHexData = computed(() => displayedResult.value?.grid || (layoutPreview.value.editing && layoutPreview.value.modelGrid) || hexData.value);
const displayedStations = computed(() => displayedResult.value?.stations || (layoutPreview.value.editing && layoutPreview.value.modelStations) || allStationFeatures.value);
const displayedStationCount = computed(() => displayedResult.value?.after.stationCount ?? displayedStations.value.length);
const displayedFastCount = computed(() => displayedStations.value.filter(feature => feature.properties.chargeType === 'fast').length);
const displayedDistribution = computed(() => {
  if (!displayedResult.value && !(layoutPreview.value.editing && layoutPreview.value.modelGrid)) return hexDistribution.value;
  const counts = new Map();
  displayedHexData.value.features.forEach(feature => counts.set(feature.properties.stationCount, (counts.get(feature.properties.stationCount) || 0) + 1));
  return [...counts].map(([stationCount, hexCount]) => ({ stationCount, hexCount })).sort((a, b) => a.stationCount - b.stationCount);
});
// 地图数据尚未全部加载完成时为 true。
const loading = ref(true);
// 地图主要数据加载失败时显示的错误信息。
const loadError = ref("");

// 六边形网格单独加载失败时显示的提示信息。
const gridWarning = ref("");
// 组件卸载时用它取消尚未完成的 GeoJSON 请求。
const controller = new AbortController();

const readApiGeoJSON = endpoint => readGeoJSON(endpoint, { signal: controller.signal, fetcher: apiFetch });
const { clearSitingMarkers, refreshSitingMap, showSitingOverview, focusSitingGrid } = useSitingMap({
  getMap: () => map, signal: controller.signal, Marker: maplibregl.Marker, document,
  getState: () => ({ enabled: analysisPanel.value === 'sandbox' && planningAssistOpen.value, selected: sitingCandidate.value,
    rows: sitingCandidateRows.value, basemap: activeBasemap.value, loading: loading.value,
    stationsVisible: layerGroups.value.find(group => group.id === 'stations')?.visible }),
  onCandidate: id => sitingPanel.value?.selectCandidate(id), onStation: showStationPopup,
  onSelection: id => { sitingSelectedId.value = id }, closePopup: () => popup?.remove(), getPadding: sitingMapPadding,
});

// 地图工具各自持有独立状态；这里只连接工具与规划工作台。
const { measuring, measurePoints, measurePanelOpen, measureText, measureHint, measureFeatures, measureKilometers,
  refreshMeasureLayer, addMeasurePoint, startMeasure, finishMeasure, clearMeasure, closeMeasurePanel, toggleMeasure, disposeMeasure } =
  useMapMeasure({ getMap: () => map, activeBasemap, closeMapPanels });
const { locating, locationError, locateUser, locationFailed, getUserLocation, updateLocationMarker, disposeLocation } =
  useMapLocation({ getMap: () => map, activeBasemap, signal: controller.signal, Marker: maplibregl.Marker,
    platform: { navigator, isSecureContext: globalThis.isSecureContext }, getOffset: explorerFocusOffset,
    onNotice: () => { mapNoticesVisible.value = true },
    onLocated: (coordinates, forSimulation) => {
      if (forSimulation === true && layoutPreview.value.editing) sandboxPanel.value?.setLocation(coordinates, '设备当前位置');
    } });
const { stationKeyword, searchHistory, searchPanelOpen, matchingStations, searchResultCount, searchError,
  searchPending, searchSelectionMessage, searchActiveIndex, searchOptionId, clearSearch,
  schedulePoiSearch, startSearchComposition, finishSearchComposition, handleSearchKeydown,
  searchStation, rememberSearch, clearSearchHistory, openSearchPanel, closeSearchPanel, useSearchHistory,
  selectSearchStation, invalidateSearch, disposeSearch } =
  useStationSearch({ getMap: () => map, getBoundary: () => weiduPolygons, getStations: () => allStationFeatures.value,
    getPois: () => [...allStationFeatures.value, ...demandPoiFeatures.value, ...facilityPois.value],
    activeBasemap, loading, signal: controller.signal, quickPanelOpen, boundaryPanelOpen, closeMapPanels, closeMapPanelsOnEscape,
    fetcher: apiFetch, localStorage, document,
    onNotice: () => { mapNoticesVisible.value = true },
    onSelect: station => {
      if (analysisPanel.value === 'sandbox') {
        sandboxPanel.value?.searchSiting(station.geometry.coordinates,station.properties.name);
        map.flyTo({center:toMapCoordinate(station.geometry.coordinates,activeBasemap.value),zoom:15,duration:600});
        return;
      }
      if (analysisPanel.value === 'siting') return selectSitingArea(station.geometry.coordinates, station.properties.name);
      const recorded = allStationFeatures.value.find(item => String(item.properties.id) === String(station.properties.id));
      const isStation = station.properties.source ? station.properties.source === 'stations' : !!recorded;
      if (isStation) { toggleLayer('stations', true); toggleFastOnly(false); }
      const displayed = toMapGeoJSON(isStation && recorded ? recorded : station, activeBasemap.value);
      map.flyTo({ center: displayed.geometry.coordinates, zoom: 15, duration: 600, essential: true, offset: explorerFocusOffset() });
      if (isStation) showStationPopup(displayed);
      else if (['overview', 'map'].includes(analysisPanel.value)) {
        const grid = (hexData.value?.features || []).find(feature =>
          station.geometry?.type === 'Point' && turf.booleanPointInPolygon(station, feature));
        if (grid) openGridDetail(grid);
      }
      else {
        popup?.remove();
        popup = new maplibregl.Popup().setLngLat(displayed.geometry.coordinates).setDOMContent(popupContent([
          displayed.properties.name, '类别：' + poiCategoryLabel(station),
          '地址：' + (displayed.properties.address || '暂无'),
        ])).addTo(map);
      }
    } });

function poiCategoryLabel(feature) {
  const category = feature.properties.category;
  return ({station:'充电站',residential:'居住地点',commercial:'商业地点'})[category]
    || FACILITY_MAP_LAYERS.find(layer => layer.category === category)?.label || '兴趣点';
}

const demandScenarioId = ref('weekday-day'), functionalMapMode = ref('base');
const temporalSelection = ref({
  day: 'weekday',
  scenario: 'medium',
  hour: 8,
})
const functionalMapActive = computed(() => functionalMapMode.value !== 'base' &&
  (analysisPanel.value === 'siting' && !!sitingSelection.value || analysisPanel.value === 'sandbox' && !planningComparisonActive.value));
const populationGridData = ref(null);
const functionalModel = computed(() => {
  const byId = new Map((populationGridData.value?.features || []).map(f => [String(f.properties.id), f.properties.populationModelCount]));
  const features = (hexData.value?.features || emptyFeatures).map(f => ({...f, properties:{...f.properties, populationModelCount:byId.get(String(f.properties.id)) ?? null}}));
  return functionalZoneModel(features, pssFactors.value);
});
const temporalSpatial = computed(() => spatialDemandIntensity(functionalModel.value, populationGridData.value));
const temporalScale = computed(() => temporalDemandScale(temporalSpatial.value));
const temporalGrid = computed(() => currentTemporalDemandGrid(
  hexData.value?.features || emptyFeatures, temporalSpatial.value, temporalScale.value, temporalSelection.value,
));
const overviewPanel = ref(null);
const analysisMovable = ref(null);
const selectedTemporalGrid = computed(() => (hexData.value?.features || []).find(feature => String(feature.properties.id) === String(selectedHex.value?.id)));
const selectedPopulation = computed(() => populationGridData.value?.features?.find(feature =>
  String(feature.properties.id) === String(selectedHex.value?.id))?.properties || null);
const selectedGridStations = computed(() => selectedTemporalGrid.value ? stationsInGrid(selectedTemporalGrid.value) : []);
const selectedTemporalDemand = computed(() => selectedTemporalGrid.value ? buildGridTemporalDemand(
  functionalModel.value, selectedTemporalGrid.value.properties.id, populationGridData.value,
  { spatial:temporalSpatial.value, scale:temporalScale.value },
) : null);
function updateTemporalSelection(change) {
  if (controller.signal.aborted) return;
  if (['weekday','weekend'].includes(change.day)) temporalSelection.value.day = change.day;
  if (['low','medium','high'].includes(change.scenario)) temporalSelection.value.scenario = change.scenario;
  if (Number.isInteger(change.hour) && change.hour >= 0 && change.hour < 24) temporalSelection.value.hour = change.hour;
}
function refreshTemporalDemandMap() {
  if (!map || controller.signal.aborted) return;
  map.getSource('temporal-demand')?.setData(toMapGeoJSON(temporalGrid.value, activeBasemap.value));
}
function refreshDetailSelection() {
  if (!map || controller.signal.aborted) return;
  const empty = { type:'FeatureCollection', features:[] };
  map.getSource('selected-detail-grid')?.setData(toMapGeoJSON(selectedTemporalGrid.value || empty, activeBasemap.value));
  map.getSource('selected-detail-station')?.setData(toMapGeoJSON(selectedStation.value || empty, activeBasemap.value));
}
watch([selectedHex, selectedStation, activeBasemap, hexData], refreshDetailSelection);
watch([selectedHex, selectedStation], () => nextTick(() => map?.resize()));
function closeDetail() {
  selectedHex.value = null;
  selectedStation.value = null;
  gridHighlightSelection.value = null;
  if (map?.getLayer('hexgrid-highlight')) map.setFilter('hexgrid-highlight', ['==', ['get', 'stationCount'], -1]);
  refreshDetailSelection();
}
function selectGridDetail(feature) {
  if (!feature?.properties || controller.signal.aborted) return;
  selectedHex.value = { ...feature.properties };
  selectedStation.value = null;
  gridHighlightSelection.value = null;
  popup?.remove();
  map?.setFilter('hexgrid-highlight', ['==', ['get', 'id'], feature.properties.id]);
  refreshDetailSelection();
  void loadPopulationData({quiet:true});
  nextTick(() => { analysisMovable.value?.open(); overviewPanel.value?.show('demand'); });
}
function openGridDetail(feature) {
  if (!allowAnalysis('overview', () => openGridDetail(feature))) return;
  if (analysisPanel.value === 'map') selectAnalysisPanel('overview');
  selectGridDetail(feature);
}
function selectStationDetail(station) {
  if (!station?.geometry || controller.signal.aborted) return;
  if (analysisPanel.value === 'map' && !allowAnalysis('overview', () => selectStationDetail(station))) return;
  const recorded = allStationFeatures.value.find(item =>
    String(item.properties.id) === String(station.properties?.id)) || station;
  const selected = recorded.geometry.type === 'Point' ? recorded : {
    type:'Feature', properties:recorded.properties || {},
    geometry:{type:'Point',coordinates:recorded.geometry.coordinates},
  };
  const grid = (hexData.value?.features || []).find(feature =>
    turf.booleanPointInPolygon(selected, feature));
  selectedHex.value = grid ? { ...grid.properties } : null;
  selectedStation.value = selected;
  gridHighlightSelection.value = null;
  popup?.remove();
  if (analysisPanel.value === 'map') selectAnalysisPanel('overview');
  map?.setFilter('hexgrid-highlight', grid
    ? ['==', ['get', 'id'], grid.properties.id]
    : ['==', ['get', 'stationCount'], -1]);
  refreshDetailSelection();
  void loadPopulationData({quiet:true});
  nextTick(() => { analysisMovable.value?.open(); overviewPanel.value?.show('stations'); });
}
const stopTemporalDemandWatch = watch([temporalGrid, activeBasemap], refreshTemporalDemandMap);
const scenarioDemandModel = computed(() => applyDemandScenario(functionalModel.value, demandScenarioId.value, activityWeights.value));
const baselineDemandModel = computed(() => applyDemandScenario(functionalModel.value, 'weekday-day'));
const planningDemandPois = computed(() => mergeActivityPois(demandPoiFeatures.value, facilityPois.value));
const planningFeatures = computed(() => layoutPreview.value.modelGrid?.features || scenarioDemandModel.value.features);
const constructionVisible = ref(true);
const constructionViewActive = computed(() => analysisPanel.value === 'sandbox' && planningDrawer.value === 'layout');
const constructionData = computed(() => constructionViewActive.value && constructionVisible.value
  ? constructionMapData({ boundary: businessData.weidu, features: planningFeatures.value, factors: pssFactors.value, context: sitingContextData.value })
  : { type: 'FeatureCollection', features: [] });
let planarViewActive = false;
function refreshConstructionMap() {
  if (!map || controller.signal.aborted) return;
  map.getSource('construction-map')?.setData(toMapGeoJSON(constructionData.value, activeBasemap.value));
  const active = constructionViewActive.value;
  if (active === planarViewActive) return;
  planarViewActive = active;
  if (active) {
    map.easeTo?.({ pitch: 0, bearing: 0, duration: 300 });
    map.dragRotate?.disable(); map.touchPitch?.disable();
    map.touchZoomRotate?.disableRotation(); map.keyboard?.disableRotation();
  } else {
    map.dragRotate?.enable(); map.touchPitch?.enable();
    map.touchZoomRotate?.enableRotation(); map.keyboard?.enableRotation();
  }
}
watch([constructionData, constructionViewActive, activeBasemap], refreshConstructionMap);
const eligibleStationFeatures = computed(() => allStationFeatures.value.filter(feature => {
  const p=feature.properties || {}; let flags=p.scopeReviewFlags;
  if(typeof flags==='string'){try{flags=JSON.parse(flags)}catch{return false}}
  return !flags?.length && p.publicAccess!==false && !['offline','maintenance','retired'].includes(p.status);
}));
const planningStations = computed(() => layoutPreview.value.modelStations || eligibleStationFeatures.value);
const pssRows = computed(() => planningRows(planningFeatures.value,planningStations.value,pssFactors.value,undefined,demandPoiFeatures.value));
const sitingCandidate = computed(() => sitingSelection.value ? sitingCandidateRows.value.find(row => row.id === sitingSelectedId.value) || null : null);
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
watch([pssGridData,pssSpacingVisible,pssSpacingRadius,pssBlindVisible,pssVoronoiVisible,functionalMapMode],refreshPssMap);
watch([analysisPanel,loading], () => {
  if (props.authenticated && !loading.value && ['siting','sandbox'].includes(analysisPanel.value) && !facilityLoaded.value) loadFacilityData();
});
function refreshFunctionalMap() {
  if (!map || controller.signal.aborted) return;
  const features = planningAssistOpen.value ? featuresInSitingScope(planningFeatures.value,sitingSelection.value) : planningFeatures.value;
  map.getSource('functional-zones')?.setData(toMapGeoJSON({type:'FeatureCollection',features},activeBasemap.value));
  const enabled = functionalMapActive.value && !roadMapActive.value;
  layerGroups.value.forEach(updateLayerVisibility);
  if (map.getLayer('functional-zones-fill')) {
    map.setLayoutProperty('functional-zones-fill','visibility',enabled ? 'visible' : 'none');
    map.setPaintProperty('functional-zones-fill','fill-color',functionalMapMode.value === 'zones'
      ? ['coalesce',['get','functionalZoneColor'],'#a5afbd']
      : ['case',['==',['get','functionalZone'],'unknown'],'#a5afbd',['interpolate',['linear'],['coalesce',['get','scenarioDemandIndex'],0],0,'#e8f1ee',.4,'#f5d080',.75,'#ee9849',1,'#bf493e']]);
  }
}
function refreshPssMap() {
  if (!map || controller.signal.aborted) return;
  map.getSource('pss-grid')?.setData(toMapGeoJSON(pssGridData.value,activeBasemap.value));
  const siting = planningAssistOpen.value;
  const localStations = siting ? planningStations.value.filter(feature=>sitingSelection.value && turf.distance(turf.point(sitingSelection.value.center),feature,{units:'meters'})<=sitingSelection.value.radiusMeters+pssSpacingRadius.value) : planningStations.value;
  const features = pssSpacingVisible.value && pssSpacingRadius.value > 0 ? localStations.filter(feature => !stationConfiguration(feature).blocked).map(feature =>
    turf.circle(feature.geometry.coordinates,pssSpacingRadius.value/1000,{steps:40,properties:{stationId:feature.properties.id}})) : [];
  map.getSource('pss-spacing')?.setData(toMapGeoJSON({type:'FeatureCollection',features},activeBasemap.value));
  map.getSource('pss-blind')?.setData(toMapGeoJSON({type:'FeatureCollection',features:!siting && pssBlindVisible.value ? pssBlindSpots.value : []},activeBasemap.value));
  map.getSource('pss-voronoi')?.setData(toMapGeoJSON(siting ? {type:'FeatureCollection',features:[]} : pssVoronoiData.value,activeBasemap.value));
  refreshSitingMap();
  refreshSitingSelection();
  refreshFunctionalMap();
}
function setSpacingBuffer({visible,radius}) {
  pssSpacingVisible.value = !!visible;
  if (Number.isFinite(radius) && radius >= 0 && radius <= 3000) pssSpacingRadius.value = radius;
}
function receiveSitingCandidates(rows) {
  const previous = sitingSelectedId.value;
  sitingCandidateRows.value = sitingSelection.value && Array.isArray(rows) ? rows : [];
  if (!sitingCandidateRows.value.some(row => row.id === previous)) sitingSelectedId.value = '';
}

function sitingLocationStatus(coordinates) {
  return assessSitingLocation(coordinates,{boundary:businessData.weidu,features:planningFeatures.value,factors:pssFactors.value,context:sitingContextData.value});
}
function beginSitingSelection() {
  if (!map || controller.signal.aborted) return;
  sitingSelection.value = null;
  sitingPickCursor = 'crosshair';
  sitingPicking.value = true;
  sitingSelectionError.value = '';
  sitingCandidateRows.value = [];
  sitingSelectedId.value = '';
  sitingLegendExpanded.value = false;
  functionalMapMode.value = 'base';
  popup?.remove();
  refreshPssMap();
  refreshLayoutPreview();
  refreshPlanningImpact();
  setCursor('crosshair');
}
function selectSitingArea(coordinates, label) {
  if (loading.value || controller.signal.aborted) return false;
  const status = sitingLocationStatus(coordinates);
  if (!status.allowed) { sitingSelectionError.value = status.reason; return false; }
  sitingSelectedId.value = '';
  sitingSelection.value = {center:[...coordinates],radiusMeters:sitingSelection.value?.radiusMeters || 1000,
    label:label || `地图选区 · 网格 #${status.feature.properties.id}`};
  sitingPicking.value = false;
  sitingSelectionError.value = '';
  popup?.remove();
  refreshPssMap();
  refreshLayoutPreview();
  refreshPlanningImpact();
  fitSitingSelection();
  setCursor('');
  return true;
}
function changeSitingRadius(radiusMeters) {
  if (!sitingSelection.value || ![500,1000,1500,2000].includes(radiusMeters)) return;
  sitingSelectedId.value = '';
  sitingSelection.value = {...sitingSelection.value,radiusMeters};
  refreshPssMap();
  refreshLayoutPreview();
  refreshPlanningImpact();
  fitSitingSelection();
}
function fitSitingSelection() {
  if (!map || !sitingSelection.value || controller.signal.aborted) return;
  const area = turf.circle(sitingSelection.value.center,sitingSelection.value.radiusMeters/1000,{steps:64});
  map.fitBounds(turf.bbox(toMapGeoJSON(area,activeBasemap.value)),{padding:sitingMapPadding(),duration:500,maxZoom:15});
}
function refreshSitingSelection() {
  if (!map || controller.signal.aborted) return;
  refreshConstructionMap();
  const enabled = analysisPanel.value === 'sandbox';
  const features = enabled ? planningFeatures.value.filter(feature=>sitingRestriction({...feature.properties,...pssFactors.value[String(feature.properties.id)]}))
    .map(feature=>({...feature,properties:{...feature.properties,sitingGeometry:'blocked'}})) : [];
  if (enabled && planningAssistOpen.value && sitingSelection.value) {
    features.push(turf.circle(sitingSelection.value.center,sitingSelection.value.radiusMeters/1000,{steps:64,properties:{sitingGeometry:'scope'}}));
    features.push(turf.point(sitingSelection.value.center,{sitingGeometry:'center'}));
  }
  refreshLocalSiting();
  map.getSource('siting-selection')?.setData(toMapGeoJSON({type:'FeatureCollection',features},activeBasemap.value));
}
function showLocalSiting(value) {
  const previous=localSitingSelection.value;
  localSitingSelection.value=value;
  refreshLocalSiting();
  refreshRoadResearch();
  if(map && value?.center && JSON.stringify([previous?.center,previous?.radiusMeters])!==JSON.stringify([value.center,value.radiusMeters])){
    const area=turf.circle(value.center,value.radiusMeters/1000,{steps:64});
    const width=map.getCanvas().clientWidth || globalThis.innerWidth;
    map.fitBounds(turf.bbox(toMapGeoJSON(area,activeBasemap.value)),{padding:{top:65,bottom:65,left:55,right:Math.min(460,Math.round(width*.38))},duration:500,maxZoom:15});
  }
}
function refreshLocalSiting(){
  if(!map || controller.signal.aborted)return;
  const selection=localSitingSelection.value;
  const features=[];
  if(analysisPanel.value==='sandbox' && selection?.center){
    features.push(turf.circle(selection.center,selection.radiusMeters/1000,{steps:64,properties:{localGeometry:'scope'}}));
    features.push(turf.point(selection.center,{localGeometry:'center'}));
    features.push(...(selection.features || []).map(feature=>({...feature,properties:{...feature.properties,
      localGeometry:'candidate',selected:feature.properties.id===selection.selectedId}})));
    const chosen=selection.features?.find(f=>f.properties.id===selection.selectedId);
    if(chosen && selection.roadAnchor)features.push(turf.lineString([chosen.geometry.coordinates,selection.roadAnchor],{localGeometry:'connection'}));
  }
  map.getSource('local-siting')?.setData(toMapGeoJSON({type:'FeatureCollection',features},activeBasemap.value));
}
function updateSitingCursor(event) {
  if (analysisPanel.value !== 'sandbox' || measuring.value || layoutPreview.value.tool !== 'add') return;
  const coordinates = fromMapCoordinate([event.lngLat.lng,event.lngLat.lat],activeBasemap.value);
  sitingPickCursor = !loading.value && sitingLocationStatus(coordinates).allowed ? 'crosshair' : 'not-allowed';
  setCursor(sitingPickCursor);
}
function setPlanningAssistVisible(visible) {
  planningAssistOpen.value = !!visible;
  refreshPssMap();
}
function useCurrentViewForCandidates() {
  if (!map || loading.value) return;
  const coordinates = fromMapCoordinate(map.getCenter().toArray(),activeBasemap.value);
  selectSitingArea(coordinates,'当前视野周边');
}

function sitingMapPadding() {
  const width=mapEl.value?.clientWidth || 800,height=mapEl.value?.clientHeight || 700;
  return {top:Math.min(100,height*.25),right:Math.min(45,width*.12),bottom:Math.min(64,height*.15),left:Math.min(40,width*.1)};
}

function toggleSitingCandidate(payload) {
  const removing = layoutPreview.value.points?.some(feature=>String(feature.properties.planningGridId)===String(payload.row.id));
  const added = sandboxPanel.value?.addCandidate(payload);
  pssNotice.value = added ? removing ? '已从共同方案移除，方案推演已同步。' : '已新增到共同方案，方案推演的站点列表与地图已同步。' : '候选未加入，请检查配置与研究区范围。';
}
function sendSitingCandidate(row) {
  if (!sandboxPanel.value?.receiveCandidate(row)) { pssNotice.value = '位置未传入，请检查数据是否已就绪。'; return; }
  pssNotice.value = '';
  selectAnalysisPanel('sandbox');
  nextTick(()=>{
    const station = layoutPreview.value.points?.find(feature=>String(feature.properties.planningGridId)===String(row.id));
    if (station && analysisPanel.value === 'sandbox') focusSandboxPoint(station);
  });
}
async function toggleGridCandidate() {
  const row = pssRows.value.find(row => row.id === String(selectedHex.value?.id));
  if (!row) return;
  toggleSitingCandidate({row,spec:{chargeType:'fast',pileCount:1,powerKw:60}});
  selectAnalysisPanel('sandbox');
}
// 所有正式空间数据统一通过 FastAPI 获取。

async function loadSitingContext() {
  if(!map || contextLoading.value || controller.signal.aborted)return;
  contextLoading.value=true;contextError.value='';
  try {
    const data=await readApiGeoJSON('/api/siting-context');
    controller.signal.throwIfAborted();
    if(data.metadata?.coordSystem!=='WGS84')throw new Error('选址参考坐标系无效');
    businessData['siting-context']=data;sitingContextData.value=data;
    map.getSource('siting-context')?.setData(toMapGeoJSON(data,activeBasemap.value));
    refreshConstructionMap();
  }catch(error){if(!controller.signal.aborted)contextError.value='公开选址参考暂不可用，请重试';}
  finally{if(!controller.signal.aborted)contextLoading.value=false;}
}
function loadPlanningReferences() {
  if(!sitingContextData.value)void loadSitingContext();
  if(!roadLoaded.value)void loadRoadData();
}
watch([analysisPanel,loading],()=>{if(analysisPanel.value==='sandbox'&&!loading.value)loadPlanningReferences();});
function focusSitingReference(feature) {
  if(!feature?.geometry || !map)return;
  focusPlanningPlace(feature);
}

async function loadRoadData() {
  if (!map || roadLoading.value || controller.signal.aborted) return;
  roadLoading.value=true;roadError.value='';
  try {
    const data=await readApiGeoJSON('/api/osm-roads');
    controller.signal.throwIfAborted();
    if(data.type!=='FeatureCollection' || !data.features?.length || data.metadata?.coordSystem!=='WGS84') throw new Error('道路数据格式无效');
    businessData['osm-roads']=data;
    map.getSource('osm-roads')?.setData(toMapGeoJSON(data,activeBasemap.value));
    roadMetadata.value=data.metadata;roadFeatures.value=data.features;roadLoaded.value=true;
  } catch(error) {
    if(!controller.signal.aborted) roadError.value='OSM 道路暂不可用，请重试';
  } finally { if(!controller.signal.aborted)roadLoading.value=false; }
}

async function loadFacilityData() {
  if (!map || facilityLoading.value || controller.signal.aborted) return;
  facilityLoading.value = true;
  facilityError.value = '';
  try {
    const { features } = await fetchFacilityCatalog(readApiGeoJSON);
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

let populationPending;
async function loadPopulationData({quiet=false}={}){
  if(businessData.population)return businessData.population;
  if(populationPending)return populationPending;
  if(controller.signal.aborted)return null;
  populationPending=(async()=>{try{
    const data=await readApiGeoJSON('/api/planning-data/population');
    controller.signal.throwIfAborted();
    businessData.population=data;
    populationGridData.value=data;
    map?.getSource('population')?.setData(toMapGeoJSON(data,activeBasemap.value));
    return data;
  }catch(error){
    if(!controller.signal.aborted&&!quiet){
      const group=layerGroups.value.find(g=>g.id==='population');
      if(group){group.visible=false;updateLayerVisibility(group)}
      showError('模型人口资料暂不可用，请稍后重试','人口图层');
    }
    return null;
  }finally{populationPending=null}})();
  return populationPending;
}

function stationsInGrid(feature){
  return allStationFeatures.value.filter(station=>station.geometry?.type==='Point'&&turf.booleanPointInPolygon(station,feature));
}

function popupContent(lines) {
  const content = document.createElement("div");
  content.className = 'map-popup-card';
  lines.forEach((text, index) => {
    const line = document.createElement("div");
    line.className = index === 0 ? 'map-popup-title' : String(text).includes('→') ? 'map-popup-row map-popup-comparison' : 'map-popup-row';
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
    pitch: 0, bearing: 0,
    // Style 是绘图配置：sources 提供数据，layers 决定怎样显示。
    style: createMapStyle(gridHighlightColor()),
  });
  map.on('resize', resizeSitingLegend);
  map.on('mousemove', updateSitingCursor);
  resizeSitingLegend();
  map.on("load", async () => {
    try {
      layerGroups.value.forEach((group) =>
        toggleLayer(group.id, group.visible),
      );
      // 地图加载完才有 addImage，闪电图标在这里注册
      registerChargingIcons(map);
      registerConstructionIcons(map);
      for(let rank=1;rank<=12;rank++){
        const canvas=document.createElement('canvas');canvas.width=canvas.height=48;
        const context=canvas.getContext?.('2d');
        if(context?.fillText){context.fillStyle='#fff';context.font='bold 25px sans-serif';context.textAlign='center';context.textBaseline='middle';context.fillText(String(rank),24,25);map.addImage('local-site-'+rank,context.getImageData(0,0,48,48));}
      }
      // 设施目录与原五类数据并行加载，失败不会中断主地图。
      void loadFacilityData();
      void loadPopulationData({quiet:true});
      FACILITY_MAP_LAYERS.forEach(layer => {
        map.on('mouseenter', layer.layerIds[0], () => setCursor('pointer'));
        map.on('mouseleave', layer.layerIds[0], () => setCursor(''));
      });
      map.setPaintProperty('hexgrid-highlight', 'fill-color', gridHighlightColor());
      // 地图和 Style 加载完成后，从 FastAPI 一次性读取五类正式数据。
      const [
        weiduGeoJSON,
        stationsGeoJSON,
        residentialGeoJSON,
        commercialGeoJSON,
        hexGrid,
      ] = await fetchStudyArea(readApiGeoJSON);
      map.on("click", "stations-circle", (e) => {
        // 测距时点击只用来取点，不弹站点信息
        if (measuring.value || layoutPreview.value.editing || analysisPanel.value === 'siting') return;
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
      weiduStationCount.value = weiduStations.length;
      stationCount.value = weiduStations.length;
      allStationFeatures.value = weiduStations;
      residentialCount.value = weiduResidential.length;
      commercialCount.value = weiduCommercial.length;
      refreshBusinessSources();

      const bbox = turf.bbox(weiduGeoJSON);
      boundaryBounds.value = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];

      // 定位可能先于数据返回，研究区加载不能覆盖已定位的视野。
      if (!getUserLocation()) {
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
        if (constructionViewActive.value && !measuring.value
          && (!layoutPreview.value.editing || layoutPreview.value.tool === 'inspect')) {
          const reference = map.queryRenderedFeatures(e.point, { layers: CONSTRUCTION_REFERENCE_LAYERS })[0];
          if (reference) {
            const lines = contextPopupLines(reference);
            if (reference.properties.restrictionReason) lines.push(reference.properties.restrictionReason);
            popup?.remove();
            popup = new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(popupContent(lines)).addTo(map);
            return;
          }
        }
        if(roadMapActive.value&&!measuring.value&&layoutPreview.value.tool==='inspect'){
          const place=map.queryRenderedFeatures(e.point,{layers:['road-research-place-point']})[0];
          if(place){showRoadResearchPopup(place,e.lngLat);return}
          if(!map.queryRenderedFeatures(e.point,{layers:['stations-circle']}).length){
            const grid=map.queryRenderedFeatures(e.point,{layers:['road-research-fill']})[0];
            if(grid){showRoadGridPopup(grid,e.lngLat);return}
          }
        }
        if(!['overview','map'].includes(analysisPanel.value) && !measuring.value && (!layoutPreview.value.editing || layoutPreview.value.tool==='inspect')
          && !map.queryRenderedFeatures(e.point,{layers:['stations-circle','facility-proposal-point','facility-removal-point','planning-impact-point']}).length) {
          const reference=map.queryRenderedFeatures(e.point,{layers:SITING_CONTEXT_LAYERS.flatMap(group=>group.layerIds)})[0];
          if(reference){popup?.remove();popup=new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(popupContent(contextPopupLines(reference))).addTo(map);return;}
        }
        if (analysisPanel.value === 'siting') {
          if (measuring.value) return;
          if (sitingPicking.value) {
            selectSitingArea(fromMapCoordinate([e.lngLat.lng,e.lngLat.lat],activeBasemap.value));
            return;
          }
          const place=map.queryRenderedFeatures(e.point,{layers:['planning-impact-point']})[0];
          if(place){showPlanningPopup(place,e.lngLat);return;}
          const station = map.queryRenderedFeatures(e.point, { layers:['stations-circle','pss-siting-reference','pss-siting-stations'] })[0];
          if (station) { showStationPopup(station); return; }
          const coordinate = turf.point(fromMapCoordinate([e.lngLat.lng,e.lngLat.lat],activeBasemap.value));
          const row = sitingCandidateRows.value.find(item => turf.booleanPointInPolygon(coordinate,item.feature));
          if (row) sitingPanel.value?.selectCandidate(row.id);
          return;
        }
        if (!['overview','map'].includes(analysisPanel.value) && !measuring.value && (!layoutPreview.value.editing || layoutPreview.value.tool === 'inspect')
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
        // 站点点击事件已打开右侧详情，这里不再切换为网格。
        const stations = map.queryRenderedFeatures(e.point, {
          layers: ["stations-circle"],
        });
        if (stations.length > 0) return;
        const proposal = layoutPreview.value.stage === 'after' && layoutPreview.value.features.length
          ? map.queryRenderedFeatures(e.point, { layers: ['facility-proposal-point', 'facility-proposal-fill'] })[0] : null;
        if (proposal) {
          if (['overview','map'].includes(analysisPanel.value)) {
            const grid = (hexData.value?.features || []).find(feature => String(feature.properties.id) === String(proposal.properties.id));
            if (grid) openGridDetail(grid);
            return;
          }
          const p = proposal.properties;
          popup?.remove();
          popup = new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(popupContent([
            '网格 #' + p.id + ' · 模拟新增 1 站',
            '新增前 ' + p.stationCount + ' 站 → 新增后 ' + (Number(p.stationCount) + 1) + ' 站',
          ])).addTo(map);
          return;
        }

        // 各专题图层共用同一份六边形网格数据。
        const hex = map.queryRenderedFeatures(e.point, {
          layers: [
            "mismatch-fill",
            "demand-index-fill",
            "hexgrid-highlight",
            "pss-capacity-fill",
            "hexgrid-hitarea",
          ],
        })[0];
        if (hex) {
          openGridDetail(hex);
          closeSearchPanel();
          return;
        }

        closeDetail();
        popup?.remove(); //组件
        popup = null;
        dismissMapWindows();
      });
    } catch (error) {
      if (!controller.signal.aborted)
        loadError.value = "地图数据加载失败，请刷新重试";
    } finally {
      loading.value = false;
      if (!controller.signal.aborted) applyRouteView();
    }
  });
  // Planning starts at the study area. Device location remains an explicit tool.
});

onBeforeUnmount(() => {
  stopTemporalDemandWatch?.();
  roadResearchMarkers.forEach(marker=>marker.remove());
  disposeSearch();
  closeMapPanels();
  controller.abort();
  disposeMeasure();
  disposeLocation();
  clearSitingMarkers();
  map?.off('mousemove', updateSitingCursor);
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
  updateLocationMarker(type);
  popup?.remove();
  map.jumpTo({ center: toMapCoordinate(center, type) });
}
function refreshBusinessSources() {
  if (!map || controller.signal.aborted) return;
  Object.entries(businessData).forEach(([id, data]) => map.getSource(id)?.setData(toMapGeoJSON(data, activeBasemap.value)));
  refreshTemporalDemandMap();
  refreshDetailSelection();
  refreshPssMap();
  refreshLayoutPreview();
  refreshPlanningImpact();
  refreshRoadResearch();
}
function refreshPlanningImpact(){
  if(!map||!map.getSource('planning-impact'))return;
  const impact=analysisPanel.value==='sandbox'&&layoutPreview.value.stage!=='before'?layoutPreview.value.result?.planningImpact:null;
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
  if (preview.local) { refreshFunctionalMap(); return; }
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
  // 规划筛选只在编辑时改变图层；普通地图始终展示已采集的站点目录。
  const model = enabled ? preview.modelStations || eligibleStationFeatures.value : allStationFeatures.value;
  map.getSource('hexgrid')?.setData(toMapGeoJSON(enabled && after && preview.result?.macro?.grid ? preview.result.macro.grid : (enabled && preview.modelGrid) || hexData.value || empty, activeBasemap.value));
  map.getSource('stations')?.setData(toMapGeoJSON({ type: 'FeatureCollection', features: enabled ? model.filter(feature => !removed.has(String(feature.properties.id))) : model }, activeBasemap.value));
  const additions = (enabled && after || analysisPanel.value === 'overview' || analysisPanel.value === 'siting' && !!sitingSelection.value) ? (preview.points || []).filter(feature=>analysisPanel.value!=='siting' || turf.distance(turf.point(sitingSelection.value.center),feature,{units:'meters'})<=sitingSelection.value.radiusMeters).map(feature => ({ ...feature, properties: { ...feature.properties,
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
    `失配程度改善：${signed(p.balanceChange, 3)}`,
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
  const distanceChange = typeof p.distanceSaved !== 'number' || !Number.isFinite(p.distanceSaved) ? '无法比较'
    : Math.abs(p.distanceSaved) < 1 ? '基本不变' : (p.distanceSaved > 0 ? '缩短 ' : '增加 ') + meters(Math.abs(p.distanceSaved));
  const lines = p.impactModel ? p.impactStation ? [
    p.name || '充电站', '评估项目：建站前后需求分配',
    `全区需求占比：${number(p.beforeDemandShare)}% → ${number(p.afterDemandShare)}%`,
  ] : [
    p.name || '需求地点',
    `距最近站（直线）：${meters(p.beforeDistance)} → ${meters(p.afterDistance)}`,
    `建站前最近站：${p.beforeNearest || '无'}`,
    `建站后最近站：${p.afterNearest || '无'}`,
    `距离变化：${distanceChange}`,
    `1 km 内可选站址：${p.beforeOptions ?? '未知'} → ${p.afterOptions ?? '未知'} 处`,
    ...(p.newlyReachable ? ['服务变化：附近从无站变为有站'] : p.lostReach ? ['服务变化：附近不再有站'] : []),
  ] : p.reviewStatus ? [
    p.name || '充电站', '评估项目：移除此站', '地址：' + (p.address || '未记录'),
    `匹配度下降：${number(p.removalMatchLoss)} 分`,
    `触达比例下降：${number(p.removalReachLoss)} 个百分点`,
    `受影响地点：${p.affectedPlaces ?? '未知'} 个`,
    `地点名称：${p.affectedNames || '无'}`,
  ] : [
    p.name || '需求地点', '地址：' + (p.address || '未记录'),
    `匹配度：${number(p.beforeMatch)} → ${number(p.afterMatch)} 分`,
    `距最近站（直线）：${meters(p.beforeDistance)} → ${meters(p.afterDistance)}`,
    `建站前最近站：${p.beforeNearest || '无'}`,
    `建站后最近站：${p.afterNearest || '无'}`,
    '服务状态：' + (p.weak ? '仍需补强' : '未列入薄弱地点'),
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
  selectAnalysisPanel('sandbox');
  const added = map.queryRenderedFeatures(event.point, { layers: ['facility-proposal-point'] })[0];
  const removed = map.queryRenderedFeatures(event.point, { layers: ['facility-removal-point'] })[0];
  const candidate = map.queryRenderedFeatures(event.point, { layers: ['local-siting-candidate'] })[0];
  const station = map.queryRenderedFeatures(event.point, { layers: ['stations-circle'] })[0];
  const coordinates = Array.isArray(event.lngLat) ? event.lngLat : [event.lngLat.lng, event.lngLat.lat];
  if (layoutPreview.value.tool === 'add' && !added && !removed && !station) {
    const status = sitingLocationStatus(fromMapCoordinate(coordinates, activeBasemap.value));
    if (!status.allowed) {
      popup?.remove();
      popup = new maplibregl.Popup().setLngLat(coordinates).setDOMContent(popupContent(['无法在此新增站点', status.reason])).addTo(map);
      return;
    }
  }
  sandboxPanel.value?.mapClick({ coordinates: fromMapCoordinate(coordinates, activeBasemap.value),
    anchor:event.originalEvent,candidateId:candidate?.properties.id, sandboxId: added?.properties.sandboxId, removedId: removed?.properties.removedId, stationId: station?.properties.id });
  if (['add', 'locate'].includes(layoutPreview.value.tool) && globalThis.innerWidth <= 760) setTimeout(scrollSandboxPanel, 0);
}
function scrollSandboxPanel() {
  planningDrawer.value='layout';
  selectAnalysisPanel('sandbox');
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
  if (!map || controller.signal.aborted) return;
  if (analysisPanel.value === 'sandbox' && layoutPreview.value.tool === 'add') { map.getCanvas().style.cursor = sitingPickCursor; return; }
  map.getCanvas().style.cursor = analysisPanel.value !== 'siting' && layoutPreview.value.editing ? 'crosshair' : cursor;
}
// 双击时浏览器会先发出两次单击，最后两个点几乎重合，这个距离内的点当成同一个点
 // 约 30 米
// 1 千米 = 1000 米，用来决定面板显示"米"还是"千米"

// 把点过的坐标变成地图要画的数据：一条折线 + 每个点一个圆点

// 计算总长度，单位千米（不到两个点时长度是 0）

// 面板里显示的长度文字

// 操作提示，跟着测距进度变化

// 把最新的点和线交给地图显示

// 单击地图：记录一个点

// 开始测距：进入测距模式，并清掉上一次的结果

// 结束测距：画好的线保留，只是不再继续加点

// 清除：把点过的点全部删掉，回到地图空白状态

// 关闭测距面板：结束测距并清空画好的线

// 右上角直尺按钮：没在测距就开始，正在测距就结束

function focusHex(feature) {
  if (!map || !feature) return;
  const center = turf.centerOfMass(feature).geometry.coordinates;
  popup?.remove();
  selectedHex.value = { ...feature.properties };
  selectedStation.value = null;
  gridHighlightSelection.value = null;
  map.flyTo({ center: toMapCoordinate(center, activeBasemap.value), zoom: Math.max(map.getZoom(), 13), duration: 600, offset: explorerFocusOffset() });
  map.setFilter('hexgrid-highlight', ['==', ['get', 'id'], feature.properties.id]);
}
async function startCandidatePlanning(feature) {
  if (!allowAnalysis('sandbox', () => startCandidatePlanning(feature))) return;
  if (loading.value || !feature) return;
  selectAnalysisPanel('sandbox');
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
const layerGroups = ref(createMapLayerGroups());
const mapLayerItems = computed(() => layerGroups.value.filter(group => group.id !== 'boundary').map(group => ({
  id: group.id, label: group.label,
  section: group.section,
  count: group.category && facilityLoaded.value ? facilityCounts.value[group.category] : null,
  disabled: !!group.category && (!facilityLoaded.value || !facilityCounts.value[group.category]),
  thematic: group.section !== 'reference' && group.layerIds.some(id => id.endsWith('-fill')),
  visible: group.visible && !isLayerSuppressed(group),
})));
function isLayerSuppressed(group) {
  if(group.section==='reference')return false;
  if(roadMapActive.value&&group.id!=='boundary'&&group.layerIds.some(id=>id.endsWith('-fill')))return true;
  if (functionalMapActive.value && group.id !== 'boundary' && group.layerIds.some(id => id.endsWith('-fill'))) return true;
  const comparison = layoutPreview.value.local ? planningComparisonActive.value : layoutPreview.value.editing && !!layoutPreview.value.result?.comparison;
  return comparison && group.layerIds.some(id => id.endsWith('-fill') && id !== 'weidu-fill');
}
function togglePlanningComparison(visible) {
  planningComparisonShown.value = visible;
  refreshLayoutPreview();
}
const activeLegends = computed(() => layerGroups.value
    .filter(group => group.visible && group.id !== 'boundary' && (!group.category || facilityLoaded.value) && (!group.context || !!sitingContextData.value) && (group.id !== 'osmRoads' || roadLoaded.value) && !isLayerSuppressed(group))
  .map(group => {
    let legend = layerLegends[group.id];
    if (group.id === 'stations') {
      legend = { items: [
        ...(fastCount.value ? [{ kind: 'point', color: chargingMapColor[3], icon: chargingMapIcon[3], label: '快充' }] : []),
        ...(regularCount.value ? [{ kind: 'point', color: chargingMapColor[5], icon: chargingMapIcon[5], label: '普通充电', hidden: fastOnly.value }] : []),
        ...(allStationFeatures.value.some(f=>!['fast','regular'].includes(f.properties.chargeType)) ? [{kind:'point',color:chargingMapColor.at(-1),icon:chargingMapIcon.at(-1),label:'类型待核实',hidden:fastOnly.value}] : []),
      ] };
    }
    // 网格加载失败时地图没有专题数据，不显示对应图例。
    if (group.section!=='reference' && group.layerIds.some(id => id.includes('fill') && id !== 'weidu-fill') && !hexData.value) return null;
    const selection = temporalSelection.value;
    const title = group.id === 'demandIndex'
      ? `${group.label} · ${selection.day === 'weekday' ? '工作日' : '周末'} ${String(selection.hour).padStart(2, '0')}:00 · ${{ low: '低', medium: '中', high: '高' }[selection.scenario]}情景`
      : group.label;
    return legend ? { id: group.id, title, ...legend } : null;
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
    id:'planningImpact',title:'建站后，哪些地点去充电更方便',items:[{kind:'point',color:'#0b9473',label:'原来 1 km 内无站，现在有站'},{kind:'point',color:'#347fd6',label:'到站距离缩短'},{kind:'point',color:'#0891b2',label:'距离不变，可选站增加'},{kind:'point',color:'#bd5140',label:'到站更远，或附近不再有站'}],note:'圆点是小区、商场等需求地点；点圆点查看前后距站距离，均为直线估计。'
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
  if(groupId==='population' && visible)void loadPopulationData();
  if (groupId !== 'boundary' && group.section!=='reference' && visible && group.layerIds.some(id => id.endsWith('-fill'))) {
    functionalMapMode.value = 'base';
    if (layoutPreview.value.local && layoutPreview.value.editing) planningComparisonShown.value = false;
    layerGroups.value.filter(item => item.id !== 'boundary' && item.section!=='reference' && item.id !== groupId && item.layerIds.some(id => id.endsWith('-fill'))).forEach(item => { item.visible = false; });
    group.visible = visible;
    if (layoutPreview.value.local && layoutPreview.value.editing) refreshLayoutPreview();
    else layerGroups.value.forEach(updateLayerVisibility);
    return;
  }
  group.visible = visible;
  updateLayerVisibility(group);
}
function updateLayerVisibility(group) {
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
  if (group.id === 'stations' && planningAssistOpen.value) refreshSitingMap();
}
function toggleReferenceLayer({ id, visible }) {
  toggleLayer(id, visible);
  if(id==='osmRoads' && visible && !roadLoaded.value) void loadRoadData();
  if(visible && layerGroups.value.find(group=>group.id===id)?.context && !sitingContextData.value)void loadSitingContext();
  if (analysisPanel.value === 'sandbox' && visible) sitingLegendExpanded.value = true;
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
    '/planning/overview': ['stations', 'demandIndex'],
    '/monitoring/stations': ['stations'],
    '/monitoring/demand': ['stations', 'demandIndex'],
    '/monitoring/supply': ['stations', 'capacitySupply'],
    '/monitoring/mismatch': ['stations', 'mismatch'],
  };
  const visible = views[props.activeRoute] || views['/'];
  // 边界属于地图参考设置，切换专题时保留用户选择。
  if (!['/planning/candidates','/planning/problems','/planning/suggestions'].includes(props.activeRoute)) layerGroups.value.filter(group => group.id !== 'boundary' && group.section !== 'reference' && !group.category).forEach(group => toggleLayer(group.id, visible.includes(group.id)));
  if (!(props.activeRoute === '/planning/overview' && (selectedHex.value || selectedStation.value))) closeDetail();
  popup?.remove();
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
  invalidateSearch();
  closeSearchPanel();
  closeMapPanels(false);
  if (!measuring.value && measurePanelOpen.value) closeMeasurePanel();
  closeDetail();
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
    <FloatingWorkspace :view="analysisPanel" :fullscreen="isFullscreen || analysisPanel === 'map'" :class="{ 'pss-wide': ['grid','carbon'].includes(analysisPanel), 'pss-siting-workspace': analysisPanel === 'sandbox', 'overview-detail-workspace': analysisPanel === 'overview' }" @panel-resize="map?.resize()">
      <MovablePanel panel-id="map" title="地图" placement="map" map :available="!['grid','carbon'].includes(analysisPanel)" :min-width="280" :min-height="250">
      <section class="map-area" :class="{ 'sandbox-active': layoutPreview.editing, 'sandbox-editing': layoutPreview.editing && layoutPreview.stage === 'after' }" aria-label="魏都区充电设施地图">
        <div ref="mapEl" class="map-canvas"></div>
        <details v-if="constructionViewActive && constructionVisible" class="construction-map-legend" open aria-label="建站分区图例" @click.stop>
          <summary>建站分区 · 俯视拖动</summary>
          <div class="construction-legend-items">
            <span><i class="construction-zone-key"></i>建站研究分区</span>
            <span><i class="construction-symbol parking">P</i>停车场 · 建设条件待核查</span>
            <span><i class="construction-symbol water">≈</i>水域 · 排除建站</span>
            <span><i class="construction-symbol blocked">⊘</i>已标注不可建设</span>
            <span><i class="construction-symbol risk">!</i>风险与障碍 · 待核查</span>
            <span><i class="construction-symbol entrance">↪</i>已记录出入口</span>
          </div>
          <p v-if="contextLoading" role="status">正在加载场地与水域…</p>
          <p v-else-if="contextError" role="status">{{ contextError }}<button type="button" @click="loadSitingContext">重试</button></p>
          <p v-else>分区已排除已知水域与禁建范围；其余建设条件仍待核查。</p>
        </details>
        <section v-if="planningAssistOpen" class="siting-map-summary" aria-label="地图选区提示" @click.stop>
          <template v-if="!sitingSelection"><b>可选候选参考</b><p>在设置中选择参考范围；地图点击仍在原位置新增。</p></template>
          <template v-else><div><b>{{ sitingSelection.label }}</b><button @click="useCurrentViewForCandidates">重选参考范围</button></div><p>周边 {{ sitingSelection.radiusMeters }} m · {{ sitingCandidateRows.length }} 处候选，点击编号查看选址依据。</p></template>
          <p v-if="sitingSelectionError" class="siting-selection-error" role="alert">{{ sitingSelectionError }}</p>
        </section>
        <section v-if="functionalMapActive && analysisPanel !== 'siting'" class="functional-map-legend" aria-label="功能分区图例" @click.stop>
          <b>{{ functionalMapMode==='zones' ? 'POI 功能分区' : scenarioDemandModel.label+' · 相对需求' }}</b>
          <div v-if="functionalMapMode==='zones'"><span v-for="zone in FUNCTIONAL_ZONES" :key="zone.id"><i :style="{background:zone.color}"></i>{{ zone.label }}</span></div>
          <div v-else><span><i style="background:#e8f1ee"></i>低 · 0</span><span><i style="background:#f5d080"></i>中 · 0.4</span><span><i style="background:#bf493e"></i>高 · 1</span><span><i style="background:#a5afbd"></i>资料不足</span></div>
        </section>

        <details v-if="analysisPanel === 'sandbox' && !roadMapActive" class="siting-map-key" :open="sitingLegendExpanded" aria-label="选址地图图例" @toggle="sitingLegendExpanded=$event.target.open" @click.stop>
          <summary><UiIcon name="layers" :size="13" />图例<UiIcon name="chevron" :size="11" /></summary>
          <div class="siting-key-group">
            <span v-if="planningAssistOpen && sitingSelection"><i class="key-scope" aria-hidden="true"></i>所选分析范围</span>
            <span v-if="planningAssistOpen && sitingCandidate"><i class="key-number key-selected" aria-hidden="true">{{ sitingCandidate.rank }}</i>当前候选</span>
            <span v-if="planningAssistOpen && sitingCandidateRows.length"><i class="key-number key-candidate" aria-hidden="true">N</i>区域内候选</span>
            <span v-if="localSitingSelection?.center"><i class="key-scope" aria-hidden="true"></i>候选搜索缓冲区</span><span v-if="localSitingSelection?.features?.length"><i class="key-number key-candidate">N</i>圈内初选场地（点击选择）</span><span v-if="localSitingSelection?.roadAnchor"><i class="key-connection"></i>道路几何连接（出入口待核查）</span><span><i class="key-blocked" aria-hidden="true"></i>已标注不可建设</span>
            <span v-if="planningAssistOpen && sitingCandidate?.nearestStation"><i class="key-connection" aria-hidden="true"></i>最近站直线距离</span>
          </div>
          <section v-for="legend in activeLegends" :key="legend.id" class="siting-reference-legend" :aria-label="legend.title+'参考图例'">
            <b>{{ legend.title }}</b>
            <div v-if="legend.items" class="siting-key-group"><span v-for="item in legend.items" :key="item.label" :class="{ 'siting-legend-hidden': item.hidden }"><i :class="item.kind==='point' ? 'key-place' : 'key-swatch'" :style="{background:item.color}" aria-hidden="true"></i>{{ item.label }}<small v-if="item.hidden">已隐藏</small></span></div>
            <template v-if="legend.gradient"><div class="siting-key-gradient" :style="{background:legend.gradient}"></div><div class="siting-key-range"><span v-for="label in legend.range" :key="label">{{ label }}</span></div></template>
          </section>
          <div v-if="functionalMapActive" class="siting-key-group siting-key-places">
            <template v-if="functionalMapMode==='zones'"><span v-for="zone in FUNCTIONAL_ZONES" :key="zone.id"><i class="key-place" :style="{background:zone.color}"></i>{{ zone.label }}</span></template>
            <template v-else><span><i class="key-place" style="background:#e8f1ee"></i>低需求</span><span><i class="key-place" style="background:#bf493e"></i>高需求</span></template>
          </div>
        </details>
        <div v-if="layoutPreview.editing" class="sandbox-map-hint" role="status"><span><b>{{ layoutPreview.center ? '定位周边' : '全区布局' }}</b> · {{ layoutPreview.tool === 'locate' ? '点击选定位' : layoutPreview.tool === 'inspect' || layoutPreview.stage === 'before' ? '查看对比' : layoutPreview.tool === 'remove' ? '点击移除／恢复' : '点击新增／编辑' }}</span><button @click="scrollSandboxPanel">模拟面板</button></div>

        <!-- 地图操作收拢在一处，规划工作台导航独立于地图状态。 -->
        <div class="planner-map-toolbar">
        <div v-if="analysisPanel !== 'sandbox'" class="analysis-search">
        <form class="map-search" @submit.prevent="searchStation">
          <UiIcon name="search" :size="19" />
          <input ref="searchInput" v-model="stationKeyword" role="combobox" aria-label="搜索地点或充电站" :placeholder="analysisPanel === 'siting' ? '搜索地点，选择研究区域' : '搜索地点、充电站名称'" aria-autocomplete="list" aria-controls="poi-search-results" :aria-expanded="searchPanelOpen" :aria-busy="searchPending" :aria-activedescendant="searchActiveIndex >= 0 ? searchOptionId(searchActiveIndex) : undefined" autocomplete="off" maxlength="120" @input="schedulePoiSearch" @compositionstart="startSearchComposition" @compositionend="finishSearchComposition" @keydown="handleSearchKeydown" @focus="openSearchPanel" />
          <button v-if="stationKeyword" type="button" class="search-clear" aria-label="清空搜索" @click="clearSearch"><UiIcon name="close" :size="13" /></button>
          <button type="submit" :disabled="loading">搜索</button>
        </form>
        <div v-if="searchPanelOpen" class="map-search-panel" aria-label="地点搜索与历史记录" @click.stop>
          <p v-if="searchPending" class="search-panel-empty" role="status">正在搜索中…</p>
          <p v-if="searchError" class="search-panel-empty" role="status">{{ searchError }}</p>
          <div id="poi-search-results" role="listbox" aria-label="地点搜索建议">
          <template v-if="!searchPending && searchResultCount !== null">
            <div class="search-panel-heading"><b>搜索结果</b><small>{{ searchResultCount }} 个地点</small></div>
            <button v-for="(station,index) in matchingStations" :id="searchOptionId(index)" :key="station.properties.searchId || station.properties.id" type="button" role="option" :disabled="analysisPanel === 'siting' && !sitingLocationStatus(station.geometry.coordinates).allowed" :title="analysisPanel === 'siting' ? sitingLocationStatus(station.geometry.coordinates).reason : undefined" :aria-selected="searchActiveIndex === index" :class="['search-station-item', {active:searchActiveIndex === index}]" @click="selectSearchStation(station)"><UiIcon name="pin" :size="16" /><span>{{ station.properties.name }}<small>{{ poiCategoryLabel(station) }}{{ station.properties.isSynthetic ? ' · 虚拟演示' : '' }}</small></span></button>
            <p v-if="!matchingStations.length" class="search-panel-empty">没有搜索到内容，换个词试试吧</p>
            <p v-if="matchingStations.length === 20" class="search-panel-empty">最多显示 20 条，请补充关键词缩小范围。</p>
          </template>
          </div>
          <div class="search-panel-heading"><b>搜索记录</b><button v-if="searchHistory.length" @click="clearSearchHistory">清空</button></div>
          <button v-for="keyword in searchHistory" :key="keyword" class="search-history-item" :disabled="loading" @click="useSearchHistory(keyword)"><UiIcon name="clock" :size="16" /><span>{{ keyword }}</span></button>
          <p v-if="!searchHistory.length" class="search-panel-empty">暂无搜索记录</p>
        </div>
        <p v-if="searchSelectionMessage" class="poi-selection-feedback" role="status">{{ searchSelectionMessage }}</p>
        <div v-if="searchResultCount !== null" class="search-feedback" role="status">
          <span>找到 {{ searchResultCount }} 个地点</span>
          <button aria-label="关闭搜索提示" @click="searchResultCount = null"><UiIcon name="close" :size="13" /></button>
        </div>
        </div>
          <MapLayerControl :open="quickPanelOpen" :layers="mapLayerItems" :loading="loading" :facility-loading="facilityLoading" :facility-error="facilityError" :road-loading="roadLoading" :road-error="roadError" :road-metadata="roadMetadata" :context-loading="contextLoading" :context-error="contextError" :context-metadata="sitingContextData?.metadata" :comparison-available="!!layoutPreview.result?.macro?.comparison && layoutPreview.editing" :comparison-visible="planningComparisonActive" :fast-only="fastOnly" :has-charge-type-data="hasChargeTypeData" @toggle="toggleQuickPanel" @close="closeMapPanels" @toggle-layer="toggleReferenceLayer" @toggle-comparison="togglePlanningComparison" @toggle-fast="toggleFastOnly" @retry-facilities="loadFacilityData" @retry-roads="loadRoadData" @retry-context="loadSitingContext" />
        </div>
        <!-- 底图切换 -->
        <div class="basemap-switch" aria-label="底图切换">
          <button v-for="item in [{id:'street',label:'标准'},{id:'satellite',label:'卫星'},{id:'terrain',label:'地形'}]" :key="item.id" :class="['basemap-option',item.id,{chosen:activeBasemap===item.id}]" :aria-pressed="activeBasemap===item.id" @click="setBasemap(item.id)"><span class="basemap-preview"></span><span>{{ item.label }}</span></button>
        </div>

        <!-- 右上角工具：图层切换、测距、全屏、定位 -->
        <div class="map-tools map-tools-top" aria-label="地图工具">
          <button v-if="constructionViewActive" :class="{active:constructionVisible}" title="建站分区与场地符号" aria-label="建站分区与场地符号" :aria-pressed="constructionVisible" @click="constructionVisible=!constructionVisible"><UiIcon name="layers" :size="19" /></button>
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
            <h4>{{ legend.title }}<TermHint v-if="['demandIndex', 'mismatch', 'facilityService'].includes(legend.id)" icon-only :label="legend.title" :term="legend.id === 'demandIndex' ? 'temporalDemand' : legend.id === 'mismatch' || legend.title.includes('失配') ? 'mismatchIndex' : legend.id === 'facilityService' ? 'match' : 'quadrant'" /></h4>
            <div v-for="item in legend.items || []" :key="item.label" class="legend-item">
              <span v-if="item.icon" class="legend-glyph" :style="{ '--legend-color': item.color }"><UiIcon :name="item.icon" :size="16" :style="{ color: item.color }" /></span><i v-else :class="['legend-symbol', 'legend-' + (item.kind || 'swatch')]" :style="{ '--legend-color': item.color, '--legend-opacity': item.opacity ?? 1 }" aria-hidden="true"></i><span>{{ item.label }}</span><small v-if="item.hidden" class="legend-hidden-note">已隐藏</small>
            </div>
            <template v-if="legend.gradient">
              <div class="legend-gradient" :style="{ background: legend.gradient }" aria-hidden="true"></div>
              <div class="legend-range"><span v-for="label in legend.range" :key="label">{{ label }}</span></div>
            </template>
            
          </section>
        </div>

        <!-- 缩放与定位 -->
        <div class="map-tools">
          <button title="放大" aria-label="放大" @click="zoomMap(1)"><UiIcon name="plus" :size="19" /></button>
          <button title="缩小" aria-label="缩小" @click="zoomMap(-1)"><UiIcon name="minus" :size="19" /></button>
          <button title="回到魏都区" aria-label="回到魏都区" @click="resetView"><UiIcon name="locate" :size="19" /></button>
        </div>


      </section>
      </MovablePanel>

      <MovablePanel v-if="authenticated" ref="analysisMovable" panel-id="analysis" title="分析面板" placement="analysis" :available="analysisPanel !== 'map' && (analysisPanel !== 'overview' || !!selectedHex || !!selectedStation)" :min-width="300" :min-height="analysisPanel === 'overview' ? 400 : 220" :class="{ 'overview-detail-slide': analysisPanel === 'overview' && (!!selectedHex || !!selectedStation) }">
      <aside class="right-sidebar explorer-panel" aria-label="数据分析">
        <ExplorerPanelHeading v-if="!['overview','siting','sandbox'].includes(analysisPanel)" label="" title="供需总览" description="从现状分布出发，识别需要优先关注的区域。" icon="chart" />
        <div v-show="analysisPanel !== 'sandbox'" class="explorer-panel-body" :class="{'overview-panel-body': analysisPanel === 'overview'}">
        <OverviewAnalysisPanel v-if="analysisPanel === 'overview' && (selectedHex || selectedStation)" ref="overviewPanel"
          :grid="selectedTemporalGrid?.properties" :population="selectedPopulation" :stations="selectedGridStations"
          :station="selectedStation" :temporal="selectedTemporalDemand" :selection="temporalSelection"
          :loading="loading" :error="loadError" @close="closeDetail" @select-station="selectStationDetail"
          @selection-change="updateTemporalSelection" @show-demand="toggleLayer('demandIndex',true)" />
        <div v-show="analysisPanel === 'carbon'" id="analysis-carbon" role="region" aria-labelledby="analysis-carbon-tab"><PlannerChargingCarbon /></div>
        <div v-show="analysisPanel === 'grid'" id="analysis-grid" role="region" aria-labelledby="analysis-grid-tab"><PlannerGridCapacity :stations="draftStations" :before-stations="planningStations" :additions="layoutPreview.points?.length || 0" /></div>


        </div>
      <PlanningPages :active="analysisPanel === 'sandbox' && !isFullscreen" v-model="planningDrawer">
        <template #effects>
        <RoadPlanningWorkbench ref="roadResearchPanel" v-if="analysisPanel === 'sandbox'" :active="planningDrawer === 'effects' && !isFullscreen" :mode="analysisPanel" :scenario-id="demandScenarioId" :activity-weights="activityWeights" :data-scope="layoutPreview.dataScope || 'recorded'" :additions="layoutPreview.points || emptyFeatures" :removed-ids="layoutPreview.removedIds || emptyFeatures" :factors="pssFactors" :constraints="constructionOptions" :loading="loading" @scenario-change="demandScenarioId=$event" @weights-change="activityWeights=$event" @set-scope="sandboxPanel?.setDataScope($event)" @result="roadResearchResult=$event" @map-change="setRoadResearchView" @apply-plan="applyRoadResearchPlan" @focus-place="focusRoadResearch" />
        </template>
        <template #layout>
        <div v-show="analysisPanel === 'sandbox'" id="analysis-sandbox" role="region" aria-labelledby="analysis-sandbox-tab">
          <FacilitySuggestions ref="sandboxPanel" :site-context="sitingContextData" :roads="roadFeatures" :context-loading="contextLoading" :context-error="contextError" @focus-reference="focusSitingReference" @retry-context="loadPlanningReferences" :demand-model="scenarioDemandModel" :scenario-id="demandScenarioId" :map-mode="functionalMapMode" @scenario-change="demandScenarioId=$event" @map-mode-change="functionalMapMode=$event" :activity-pois="planningDemandPois" :construction-factors="pssFactors" :construction-options="constructionOptions" :active="analysisPanel === 'sandbox'" :panel-visible="planningDrawer === 'layout' && !isFullscreen" @open-layout="planningDrawer='layout'" :features="hexData?.features || emptyFeatures" :demand-pois="demandPoiFeatures" :stations="eligibleStationFeatures" :boundary="businessData.weidu" :loading="loading" :locating="locating" :location-error="locationError" @locate="locateUser(true)" @district="fitBoundary" @focus-location="focusAnalysisLocation" @focus-point="focusSandboxPoint" @focus-place="focusPlanningPlace" @preview="showLayoutScenario" @search-change="showLocalSiting" @planning-assist="setPlanningAssistVisible" @construction-options="constructionOptions=$event">
          <template #plan-search>
            <form class="map-search" @submit.prevent="searchStation"><UiIcon name="search" :size="17" /><input ref="searchInput" v-model="stationKeyword" role="combobox" aria-label="搜索规划位置" placeholder="搜索地点，筛选周边场地" :aria-expanded="searchPanelOpen" aria-controls="siting-search-results" aria-autocomplete="list" :aria-busy="searchPending" :aria-activedescendant="searchActiveIndex >= 0 ? searchOptionId(searchActiveIndex) : undefined" autocomplete="off" maxlength="120" @input="schedulePoiSearch" @compositionstart="startSearchComposition" @compositionend="finishSearchComposition" @keydown="handleSearchKeydown" @focus="openSearchPanel" /><button type="submit" :disabled="loading">搜索</button></form>
            <div v-if="searchPanelOpen" class="map-search-panel" aria-label="选址地点搜索建议" @click.stop>
              <p v-if="searchPending" class="search-panel-empty" role="status">正在搜索…</p><p v-if="searchError" class="search-panel-empty" role="status">{{ searchError }}</p>
              <div id="siting-search-results" role="listbox" aria-label="选址区域搜索结果"><button v-for="(place,index) in matchingStations" :id="searchOptionId(index)" :key="place.properties.searchId || place.properties.id" class="search-station-item" type="button" role="option" :aria-selected="searchActiveIndex===index" :disabled="!sitingLocationStatus(place.geometry.coordinates).allowed" :title="sitingLocationStatus(place.geometry.coordinates).reason" @click="selectSearchStation(place)"><UiIcon name="pin" :size="15" /><span>{{ place.properties.name }}<small>{{ sitingLocationStatus(place.geometry.coordinates).reason || place.properties.address || '以此处为中心筛选周边场地' }}</small></span></button></div>
              <p v-if="!searchPending && searchResultCount===0" class="search-panel-empty">暂无匹配地点，请换个关键词或直接点击地图。</p>
            </div>
          </template>
            <template #planning-tools><PlannerSiting ref="sitingPanel" :selection="sitingSelection" @select-area="useCurrentViewForCandidates" @change-radius="changeSitingRadius" :scenario-id="demandScenarioId" :map-mode="functionalMapMode" :baseline-features="baselineDemandModel.features" @scenario-change="demandScenarioId=$event" @map-mode-change="functionalMapMode=$event" :boundary="businessData.weidu" @focus-place="focusPlanningPlace" @focus-station="focusPlanningPlace" :demand-pois="planningDemandPois" :selected-id="sitingSelectedId" @candidates-change="receiveSitingCandidates" :features="planningFeatures" :stations="planningStations" :points="layoutPreview.points || emptyFeatures" :loading="loading" :data-scope="layoutPreview.dataScope" :buffer-visible="pssSpacingVisible" @focus-grid="focusSitingGrid" @send-candidate="sendSitingCandidate" @show-buffer="setSpacingBuffer" @factors-change="pssFactors = $event" @open-simulation="sandboxPanel?.returnToEditor()" @set-scope="sandboxPanel?.setDataScope($event)" /></template>
          </FacilitySuggestions>
        </div>
        </template>
        <template #action="{ page }">
          <div v-if="page === 'layout'" class="planning-analysis-action">
            <div><b>查看方案效果</b><span>道路覆盖 · 到站时间 · 容量</span></div>
            <button type="button" :disabled="loading || roadResearchPanel?.busy" :aria-busy="!!roadResearchPanel?.busy" @click="analyzeRoadDraft"><UiIcon name="chart" :size="18" />{{ roadResearchPanel?.busy ? '正在分析…' : '分析当前方案' }}<UiIcon name="arrow-right" :size="16" /></button>
          </div>
        </template>
      </PlanningPages>
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
