<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import UiIcon from './UiIcon.vue'
import CityStationFacts from './CityStationFacts.vue'
import { readChargingSettings } from '../utils/chargingSettings.js'
import { normalizeChargingPoint } from '../utils/charging.js'
import { normalizeTripContext } from '../utils/tripCharging.js'
import { validCoordinates } from '../utils/stations.js'
import { createStationModels, stationSnapshot, assessCityReachability, createLocalCity } from '../utils/cityStations.js'
import { useCityRoutes } from '../composables/useCityRoutes.js'
import { createBuildingInteraction, buildingHighlightColor } from '../utils/cityInteractions.js'
import { ANGEL_CENTER, collection, offsetPoint, createAngelCity, nearbyModelStations, stationModel, modelVehicle, simulateCharging, simulationFrame, compareChargingScenarios } from '../utils/angelCity.js'

maplibregl.setWorkerUrl(workerUrl)
const mapEl=ref(null), loading=ref(true), source=ref(''), dataError=ref(''), mapError=ref(''), features=ref([])
const radius=ref(1500), selectedId=ref(''), overrides=ref({}), profile=ref(readChargingSettings().profile)
const arrivals=ref(60), duration=ref(120), scenario=ref('weekday'), stage=ref('after'), time=ref(30), playing=ref(false), speed=ref(5)
const night=ref(false), flat=ref(false), showBuildings=ref(true), showTrees=ref(true), selectedBuilding=ref(null), notice=ref('')
const appEl=ref(null), detailEl=ref(null), stationPeek=ref(false), hoveredBuilding=ref(null), clickRing=ref(null), feedback=ref(null)
const reduceMotion=ref(false)
const origin=ref([...ANGEL_CENTER]),originName=ref('天使城 · 初始参考位置'),pickingOrigin=ref(false),locatingOrigin=ref(false)
const originLng=ref(ANGEL_CENTER[0].toFixed(6)),originLat=ref(ANGEL_CENTER[1].toFixed(6)),originError=ref(''),placeQuery=ref(''),places=ref([])
const localStations=computed(()=>nearbyModelStations(features.value,radius.value,origin.value))
const baseline=computed(()=>localStations.value.map(f=>stationModel(f,{},profile.value,origin.value)))
const proposed=computed(()=>localStations.value.map(f=>stationModel(f,overrides.value[String(f.properties.id)],profile.value,origin.value)))
const {routes:routeStates,running:routesRunning,refresh:refreshRoutes}=useCityRoutes(origin,localStations)
const reachability=computed(()=>new Map(localStations.value.map(f=>[String(f.properties.id),assessCityReachability(f,origin.value,profile.value,routeStates.value.get(String(f.properties.id)))])))
const reachabilityCounts=computed(()=>{const values=[...reachability.value.values()];return {reachable:values.filter(v=>v.status==='reachable').length,unreachable:values.filter(v=>['unreachable','blocked'].includes(v.status)).length,unknown:values.filter(v=>v.status==='unknown').length}})
const placeResults=computed(()=>{const q=placeQuery.value.trim().toLowerCase();return q?[...places.value,...features.value.map(normalizeChargingPoint)].filter(f=>validCoordinates(f.geometry?.coordinates)&&String(f.properties?.name||'').toLowerCase().includes(q)).slice(0,6):[]})
const isAngelOrigin=computed(()=>Math.abs(origin.value[0]-ANGEL_CENTER[0])<.00001&&Math.abs(origin.value[1]-ANGEL_CENTER[1])<.00001)
const vehicle=computed(()=>modelVehicle(profile.value))
const options=computed(()=>({arrivals:arrivals.value,duration:duration.value,vehicle:vehicle.value}))
const before=computed(()=>simulateCharging(baseline.value,options.value))
const after=computed(()=>simulateCharging(proposed.value,options.value))
const result=computed(()=>stage.value==='before'?before.value:after.value)
const frame=computed(()=>simulationFrame(result.value,time.value))
const selected=computed(()=>proposed.value.find(s=>s.id===selectedId.value))
const selectedResult=computed(()=>result.value.rows.find(s=>s.id===selectedId.value))
const visualTime=computed(()=>Math.floor(time.value*2)/2)
const stationSnapshots=computed(()=>new Map(result.value.rows.map(row=>[row.id,stationSnapshot(row,result.value,visualTime.value)])))
const selectedSnapshot=computed(()=>stationSnapshots.value.get(selectedId.value))
const selectedReachability=computed(()=>reachability.value.get(selectedId.value))
const activeCount=computed(()=>result.value.rows.filter(r=>r.enabled&&r.piles>0).length)
const editedCount=computed(()=>proposed.value.filter(r=>r.edited).length)
const verdict=computed(()=>compareChargingScenarios(before.value,after.value))
const now=ref(Date.now())
let map, observer, animation, controller, disposed=false, mapReady=false, requestVersion=0, lastFrame=0, informationTimer
let buildingInteraction, feedbackTimer, ringTimer, feedbackId=0, motionQuery
let originMarker,locationGeneration=0,stationVisualSignature=''
const markers=[], labels=[]
let city=createAngelCity()
const round=value=>Number(value).toFixed(1)
const clockLabel=computed(()=>`${String(10+Math.floor(time.value/60)).padStart(2,'0')}:${String(Math.floor(time.value%60)).padStart(2,'0')}`)

function inform(message,tone='success') {
  if(disposed) return
  clearTimeout(feedbackTimer)
  feedback.value={message,tone,id:++feedbackId}
  feedbackTimer=setTimeout(()=>feedback.value=null,3800)
}
function clickFeedback(event) {
  const target=event.target.closest?.('button:not(:disabled),summary,input[type="checkbox"],canvas')
  if(!target || reduceMotion.value) return
  const rect=target.getBoundingClientRect()
  clearTimeout(ringTimer)
  clickRing.value={id:++feedbackId,x:event.detail===0?rect.left+rect.width/2:event.clientX,y:event.detail===0?rect.top+rect.height/2:event.clientY}
  ringTimer=setTimeout(()=>clickRing.value=null,550)
}
function closeBuilding() {
  buildingInteraction?.clear();selectedBuilding.value=null;hoveredBuilding.value=null
}
function clearSelection(announce=true) {
  const hadSelection=!!selectedId.value||!!selectedBuilding.value
  closeBuilding();stationPeek.value=false;selectedId.value='';updateRoute();updateMarkers()
  if(announce&&hadSelection) inform('已取消选择，可继续点击建筑或站点。','info')
}
function handleEscape(event) { if(event.key==='Escape') {pickingOrigin.value=false;map?.getCanvas()&&(map.getCanvas().style.cursor='');clearSelection()} }
function setOrigin(coordinates,label='地图选取位置') {
  if(!validCoordinates(coordinates)||Math.abs(coordinates[1])>85) {originError.value='请输入有效的 WGS84 经纬度（经度 ±180，纬度 ±85）。';return}
  locationGeneration++;locatingOrigin.value=false;pickingOrigin.value=false;originError.value=''
  if(map)map.getCanvas().style.cursor=''
  originName.value=label;origin.value=[...coordinates];originLng.value=coordinates[0].toFixed(6);originLat.value=coordinates[1].toFixed(6);placeQuery.value=''
  playing.value=false;time.value=0
  try {sessionStorage.setItem('weidu-ev.city-origin.v1',JSON.stringify({coordinates,label}))}catch{}
  inform('车辆位置已更新，正在重新分析周边站点。')
}
function applyCoordinates() {
  if(!String(originLng.value).trim()||!String(originLat.value).trim()){originError.value='请同时填写经度和纬度。';return}
  setOrigin([Number(originLng.value),Number(originLat.value)],'自定义坐标位置')
}
function locateOrigin() {
  if(!navigator.geolocation){originError.value='设备不支持定位，请使用选点或坐标输入。';return}
  const version=++locationGeneration;locatingOrigin.value=true;originError.value=''
  navigator.geolocation.getCurrentPosition(position=>{
    if(disposed||version!==locationGeneration)return
    setOrigin([position.coords.longitude,position.coords.latitude],'设备当前位置')
  },()=>{if(!disposed&&version===locationGeneration){locatingOrigin.value=false;originError.value='定位未成功，请检查权限或手动选点。'}},{enableHighAccuracy:true,timeout:10000,maximumAge:0})
}
function pickOrigin() {
  locationGeneration++;locatingOrigin.value=false;pickingOrigin.value=!pickingOrigin.value
  if(map)map.getCanvas().style.cursor=pickingOrigin.value?'crosshair':''
  if(pickingOrigin.value&&window.innerWidth<=640)mapEl.value?.scrollIntoView({behavior:reduceMotion.value?'instant':'smooth',block:'start'})
  inform(pickingOrigin.value?'点击地图放置车辆；按 Esc 取消。':'已退出位置选择。','info')
}
function updateVehicle(key,value) {
  const input=value===''?null:Number(value)
  profile.value=normalizeTripContext({...profile.value,[key]:input})
}
async function loadPlaces() {
  const results=await Promise.allSettled(['commercial-pois.json','residential-pois.json'].map(async file=>{
    const response=await fetch(`${import.meta.env.BASE_URL}geojson/${file}`);if(!response.ok)throw new Error('Unavailable');return response.json()
  }))
  if(!disposed)places.value=results.flatMap(r=>r.status==='fulfilled'?(r.value.features||[]):[]).filter(f=>f.geometry?.type==='Point').map(normalizeChargingPoint)
}
function updateCityGeometry() {
  if(!mapReady)return
  closeBuilding()
  city=createLocalCity(origin.value,localStations.value)
  for(const [id,data] of Object.entries(city))map.getSource(id)?.setData(data)
  buildingInteraction=createBuildingInteraction(map,city)
}
function refreshScene() {
  if(!mapReady)return
  closeBuilding();labels.splice(0).forEach(m=>m.remove())
  updateCityGeometry()
  if(isAngelOrigin.value){markerLabel('胖东来 · 天使城',offsetPoint(0,35),'city-landmark-label');markerLabel('建安大道',offsetPoint(370,-120),'city-road-label');markerLabel('八龙路',offsetPoint(-120,400),'city-road-label')}
  originMarker?.remove()
  const vehicle=document.createElement('div');vehicle.className='city-origin-marker';vehicle.innerHTML='<span>🚘</span><b>车辆位置</b>'
  originMarker=new maplibregl.Marker({element:vehicle,anchor:'bottom'}).setLngLat(origin.value).addTo(map)
  map.flyTo({center:origin.value,zoom:15.9,pitch:flat.value?0:56,bearing:-24,duration:reduceMotion.value?0:700})
  stationVisualSignature='';updateMarkers();updateRoute();renderCars();updateStationVisuals()
}
function updateStationVisuals() {
  if(!mapReady)return
  const signature=result.value.rows.map(r=>`${r.id}:${r.piles}:${r.enabled}:${stationSnapshots.value.get(r.id)?.occupiedSlots.join(',')}`).join('|')
  if(signature!==stationVisualSignature){
    const scene=createStationModels(result.value.rows,result.value,visualTime.value)
    map.getSource('station-pads')?.setData(scene.pads);map.getSource('station-models')?.setData(scene.structures);map.getSource('station-cars')?.setData(scene.vehicles)
    stationVisualSignature=signature
  }
  for(const marker of markers){
    const element=marker.getElement(),snapshot=stationSnapshots.value.get(element.dataset.stationId)
    if(!snapshot)continue
    element.querySelector('.city-marker-count').textContent=`充电 ${snapshot.charging} · 闲 ${snapshot.free}`
    element.querySelectorAll('.city-marker-bays i').forEach((bay,i)=>bay.classList.toggle('occupied',i<Math.min(4,snapshot.charging)))
    element.classList.toggle('has-cars',snapshot.charging>0)
  }
}
function selectBuilding(feature) {
  const id=feature?.properties?.buildingId
  const body=city.buildings.features.find(f=>f.properties.id===id)
  if(!body) return
  buildingInteraction?.select(id);buildingInteraction?.hover(null)
  hoveredBuilding.value=null;stationPeek.value=false;selectedBuilding.value=body.properties
  selectedId.value='';updateRoute();updateMarkers()
  inform(`已选中${body.properties.name} · 示意高度 ${body.properties.height} 米`,'info')
}
function focusBuilding() {
  const feature=city.buildings.features.find(f=>f.properties.id===selectedBuilding.value?.buildingId)
  if(!feature) return
  const ring=feature.geometry.coordinates[0].slice(0,-1)
  const center=[0,1].map(axis=>ring.reduce((sum,p)=>sum+p[axis],0)/ring.length)
  map?.flyTo({center,zoom:17.2,pitch:flat.value?0:62,duration:reduceMotion.value?0:850})
  inform('已定位选中建筑，可拖动或旋转查看。','info')
}
async function focusStationEditor() {
  await nextTick()
  detailEl.value?.scrollIntoView({behavior:reduceMotion.value?'instant':'smooth',block:'nearest'})
  detailEl.value?.focus({preventScroll:true})
}
function restoreStation() {
  overrides.value=Object.fromEntries(Object.entries(overrides.value).filter(([id])=>id!==selectedId.value))
  inform('此站已恢复原参数，方案对比已更新。')
}
function changeStage(value) {stage.value=value;inform(value==='before'?'正在查看原方案。':'正在查看调整方案。','info')}
function syncMotion(event) {reduceMotion.value=event.matches}

async function loadData() {
  const version=++requestVersion
  controller?.abort(); controller=new AbortController()
  const requestController=controller
  loading.value=true; dataError.value=''
  inform('正在同步车主模式站点…','info')
  const timeout=setTimeout(()=>requestController.abort(),6500)
  try {
    const response=await fetch('http://127.0.0.1:8000/api/stations',{signal:requestController.signal})
    if(!response.ok) throw new Error('接口不可用')
    const data=await response.json()
    if(data?.type!=='FeatureCollection'||!Array.isArray(data.features)) throw new Error('数据无效')
    if(disposed||version!==requestVersion) return
    features.value=data.features;source.value='车主模式站点接口'
  } catch {
    if(disposed||version!==requestVersion) return
    try {
      const response=await fetch(`${import.meta.env.BASE_URL}geojson/stations.json`)
      if(!response.ok) throw new Error('快照不可用')
      const data=await response.json()
      if(data?.type!=='FeatureCollection'||!Array.isArray(data.features)) throw new Error('快照无效')
      if(disposed||version!==requestVersion) return
      features.value=data.features;source.value='项目站点快照'
      dataError.value='车主接口暂不可用，已加载项目站点快照。'
    } catch { if(!disposed&&version===requestVersion) {features.value=[];source.value='加载失败';dataError.value='站点加载失败，请重试。'} }
  } finally {
    clearTimeout(timeout)
    if(!disposed&&version===requestVersion) {
      loading.value=false
      inform(source.value==='加载失败'?'站点加载失败，请重试。':`${source.value}已加载 · 周边 ${localStations.value.length} 个站点`,source.value==='车主模式站点接口'?'success':'info')
    }
  }
}
function choosePreset() { arrivals.value={weekday:60,weekend:140,holiday:260}[scenario.value];inform(`已应用${{weekday:'工作日',weekend:'周末',holiday:'节假日'}[scenario.value]}客流：每小时 ${arrivals.value} 辆。`) }
function edit(key,value) {
  if(!selected.value) return
  notice.value=''
  overrides.value={...overrides.value,[selectedId.value]:{...overrides.value[selectedId.value],[key]:value}}
  stage.value='after'
  const model=stationModel(selected.value.feature,overrides.value[selectedId.value],profile.value,origin.value)
  inform(key==='enabled'?(model.enabled?'此站已参与模拟。':'此站已退出模拟。'):`已更新${key==='piles'?'桩数为 '+model.piles+' 个':'单桩功率为 '+model.power+' kW'}，对比已重新计算。`)
}
function reset() { overrides.value={};time.value=0;playing.value=false;notice.value='已恢复原方案。';inform('已恢复原方案，模拟时钟已归零。') }
function selectStation(id,fly=true) {
  closeBuilding();selectedId.value=id;stationPeek.value=true
  const station=proposed.value.find(s=>s.id===id)
  if(station&&fly) map?.flyTo({center:station.feature.geometry.coordinates,zoom:18,pitch:flat.value?0:58,duration:reduceMotion.value?0:900})
  updateRoute();updateMarkers()
  nextTick(()=>{
    const item=appEl.value?.querySelector('.city-station-item.active'), list=item?.parentElement
    if(!item||!list)return
    const itemRect=item.getBoundingClientRect(),listRect=list.getBoundingClientRect()
    if(itemRect.top<listRect.top)list.scrollTop+=itemRect.top-listRect.top
    else if(itemRect.bottom>listRect.bottom)list.scrollTop+=itemRect.bottom-listRect.bottom
  })
  if(station) inform(`已选中${station.name}`,'info')
}
function overview() { clearSelection(false);map?.flyTo({center:origin.value,zoom:15.6,pitch:flat.value?0:56,bearing:-24,duration:reduceMotion.value?0:850});inform('已回到车辆位置周边全景。','info') }
function markerLabel(text,coordinates,className) {
  const element=document.createElement('span');element.className=className;element.textContent=text
  labels.push(new maplibregl.Marker({element}).setLngLat(coordinates).addTo(map))
}
function updateMarkers() {
  if(!mapReady) return
  const focusedId=document.activeElement?.dataset.stationId
  markers.splice(0).forEach(m=>m.remove())
  for(const row of result.value.rows) {
    const button=document.createElement('button');button.type='button'
    button.className=`city-station-marker ${row.id===selectedId.value?'selected':''} ${!row.enabled||!row.piles?'disabled':''}`
    button.innerHTML='<span class="city-marker-symbol">ϟ <small>模拟</small></span><span class="city-marker-bays"><i></i><i></i><i></i><i></i></span><span class="city-marker-count"></span>'
    button.title=row.name;button.setAttribute('aria-label',`查看站点 ${row.name}`)
    button.dataset.stationId=row.id;button.setAttribute('aria-pressed',String(row.id===selectedId.value))
    button.onclick=event=>{event.stopPropagation();selectStation(row.id)}
    markers.push(new maplibregl.Marker({element:button,anchor:'bottom'}).setLngLat(row.feature.geometry.coordinates).addTo(map))
    if(row.id===focusedId) button.focus({preventScroll:true})
  }
  updateStationVisuals()
}
function updateRoute() {
  const row=proposed.value.find(r=>r.id===selectedId.value)
  const route=routeStates.value.get(selectedId.value)?.routes?.[0]
  map?.getSource('driving-route')?.setData(collection(route?[route]:[]))
  map?.getSource('connection')?.setData(collection(row&&!route?[{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[origin.value,row.feature.geometry.coordinates]}}]:[]))
}
function updateLayers() {
  if(!mapReady) return
  for(const id of ['buildings','bands']) map.setLayoutProperty(id,'visibility',showBuildings.value?'visible':'none')
  map.setLayoutProperty('trees','visibility',showTrees.value?'visible':'none')
  map.setLight({anchor:'viewport',color:night.value?'#b0c7ff':'#fff5dc',intensity:night.value ? .25 : .55,position:[1.5,210,35]})
  map.setPaintProperty('background','background-color',night.value?'#0b1725':'#22383c')
  map.setPaintProperty('buildings','fill-extrusion-opacity',night.value ? .78 : 1)
  map.setPaintProperty('bands','fill-extrusion-color',buildingHighlightColor(night.value?'#e7cf8a':['get','color']))
}
function renderCars() {
  if(!map?.getSource('traffic')) return
  const amount=Math.min(45,Math.ceil(Number(arrivals.value)/6))
  const cars=Array.from({length:amount},(_,i)=> {
    const x=((time.value*35+i*161)%2700)-1350,y=i%2?-114:-126
    return {type:'Feature',properties:{color:i%3===0?'#edc678':'#85e5c2'},geometry:{type:'Point',coordinates:offsetPoint(i%2?-x:x,y,origin.value)}}
  })
  map.getSource('traffic').setData(collection(cars))
}
function tick(now) {
  if(disposed) return
  if(playing.value&&lastFrame) {
    time.value=Math.min(Number(duration.value),time.value+Math.min(now-lastFrame,250)/1000*Number(speed.value))
    if(time.value>=Number(duration.value)) {playing.value=false;inform('本次模拟播放完成，可拖动进度查看或重新播放。')}
  }
  lastFrame=now
  if(playing.value) animation=requestAnimationFrame(tick)
}
function togglePlay() {if(time.value>=Number(duration.value))time.value=0;playing.value=!playing.value;inform(playing.value?'模拟已开始，可随时暂停或拖动进度。':'模拟已暂停。','info')}
function exportReport() {
  const report={name:'车辆位置周边充电模拟',createdAt:new Date().toISOString(),source:source.value,center:origin.value,originName:originName.value,radiusMeters:radius.value,
    caveat:'建筑与车位为示意，单站最多绘制 12 个车位，统计使用完整桩数。车辆来自假设客流模拟，非现场实况。实线使用接口驾车路线，虚线仅为直线参考；到站电量为估算。',
    vehicle:vehicle.value,options:options.value,overrides:overrides.value,
    before:{averageWait:before.value.averageWait,completed:before.value.completed,energy:before.value.energy,unserved:before.value.unserved},
    after:{averageWait:after.value.averageWait,completed:after.value.completed,energy:after.value.energy,unserved:after.value.unserved},
    stations:proposed.value.map(({feature,...row})=>({...row,coordinates:feature.geometry.coordinates,reachability:reachability.value.get(row.id),snapshot:stationSnapshots.value.get(row.id)}))}
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}))
  const a=document.createElement('a');a.href=url;a.download='车辆周边充电模拟方案.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  notice.value='模拟方案已导出，包含数据来源与假设。'
  inform('已生成方案文件，正在交给浏览器下载。')
}
watch(localStations,rows=>{closeBuilding();stationPeek.value=false;if(!rows.some(r=>String(r.properties.id)===selectedId.value))selectedId.value=String(rows[0]?.properties.id||'');stationVisualSignature='';updateCityGeometry();updateMarkers();updateRoute()})
watch([arrivals,duration,overrides,radius,profile],()=>{playing.value=false;time.value=0;updateMarkers();renderCars()},{deep:true})
watch(stage,updateMarkers)
watch(time,renderCars)
watch([visualTime,result],updateStationVisuals)
watch(routeStates,updateRoute)
watch(origin,refreshScene)
watch(playing,active=>{cancelAnimationFrame(animation);lastFrame=0;if(active)animation=requestAnimationFrame(tick)})
watch([night,showBuildings,showTrees],updateLayers)
watch(flat,()=>{map?.easeTo({pitch:flat.value?0:56,duration:reduceMotion.value?0:600});inform(flat.value?'已切换到二维俯视。':'已切换到三维视角。','info')})
watch(night,value=>inform(value?'已切换到夜景。':'已切换到日景。','info'))
watch(showBuildings,value=>{if(!value)closeBuilding();inform(value?'建筑图层已显示。':'建筑图层已隐藏。','info')})
watch(showTrees,value=>inform(value?'绿化图层已显示。':'绿化图层已隐藏。','info'))
onMounted(()=>{
  motionQuery=window.matchMedia('(prefers-reduced-motion: reduce)');syncMotion(motionQuery);motionQuery.addEventListener('change',syncMotion)
  try {const saved=JSON.parse(sessionStorage.getItem('weidu-ev.city-origin.v1'));if(validCoordinates(saved?.coordinates)&&Math.abs(saved.coordinates[1])<=85)setOrigin(saved.coordinates,String(saved.label||'上次选择的位置'))}catch{}
  loadPlaces()
  loadData()
  informationTimer=setInterval(()=>now.value=Date.now(),30000)
  try {
    map=new maplibregl.Map({container:mapEl.value,center:origin.value,zoom:15.6,pitch:56,bearing:-24,maxPitch:75,minZoom:8,maxZoom:20,attributionControl:false,
      style:{version:8,sources:Object.fromEntries(Object.entries({...city,connection:collection([]),traffic:collection([]),'station-pads':collection([]),'station-models':collection([]),'station-cars':collection([]),'driving-route':collection([])}).map(([id,data])=>[id,{type:'geojson',data,...(['buildings','bands'].includes(id)?{promoteId:'id'}:{})}])),layers:[
        {id:'background',type:'background',paint:{'background-color':'#22383c'}},
        {id:'grounds',type:'fill',source:'grounds',paint:{'fill-color':['get','color']}},
        {id:'river-bank',type:'line',source:'river',paint:{'line-color':'#4b796b','line-width':40}},
        {id:'river',type:'line',source:'river',paint:{'line-color':'#407d90','line-width':26}},
        {id:'road-outline',type:'line',source:'roads',paint:{'line-color':'#72827d','line-width':['+', ['get','width'],5]}},
        {id:'roads',type:'line',source:'roads',paint:{'line-color':'#34474b','line-width':['get','width']}},
        {id:'road-lines',type:'line',source:'roads',paint:{'line-color':'#9baba1','line-width':1,'line-dasharray':[4,7]}},
        {id:'buildings',type:'fill-extrusion',source:'buildings',paint:{'fill-extrusion-color':buildingHighlightColor(),'fill-extrusion-height':['get','height'],'fill-extrusion-base':['get','base'],'fill-extrusion-opacity':1}},
        {id:'bands',type:'fill-extrusion',source:'bands',paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-height':['get','height'],'fill-extrusion-base':['get','base']}},
        {id:'trees',type:'fill-extrusion',source:'trees',paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-height':['get','height'],'fill-extrusion-base':['get','base']}},
        {id:'station-pads',type:'fill-extrusion',source:'station-pads',paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-height':['get','height']}},
        {id:'station-models',type:'fill-extrusion',source:'station-models',paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-height':['get','height'],'fill-extrusion-base':['get','base']}},
        {id:'station-cars',type:'fill-extrusion',source:'station-cars',paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-height':['get','height'],'fill-extrusion-base':['get','base']}},
        {id:'connection',type:'line',source:'connection',paint:{'line-color':'#ffc777','line-width':3,'line-dasharray':[2,3]}},
        {id:'driving-route',type:'line',source:'driving-route',paint:{'line-color':'#6bedc3','line-width':5}},
        {id:'traffic',type:'circle',source:'traffic',paint:{'circle-color':['get','color'],'circle-radius':3,'circle-stroke-color':'#fff','circle-stroke-width':.6}},
      ]}})
    map.addControl(new maplibregl.NavigationControl({visualizePitch:true}),'bottom-right')
    map.on('load',()=>{
      if(disposed)return
      mapReady=true
      refreshScene()
      updateMarkers();updateRoute();updateLayers();renderCars()
    })
    map.on('click',event=>{
      if(!mapReady)return
      if(pickingOrigin.value){setOrigin([event.lngLat.lng,event.lngLat.lat]);return}
      const stationFeature=map.queryRenderedFeatures(event.point,{layers:['station-models','station-cars','station-pads']})[0]
      if(stationFeature){selectStation(stationFeature.properties.stationId);return}
      const feature=showBuildings.value?map.queryRenderedFeatures(event.point,{layers:['buildings','bands']})[0]:null
      if(feature)selectBuilding(feature)
      else clearSelection()
    })
    map.on('mousemove',event=>{
      if(!mapReady)return
      if(pickingOrigin.value){map.getCanvas().style.cursor='crosshair';hoveredBuilding.value=null;return}
      const stationFeature=map.queryRenderedFeatures(event.point,{layers:['station-models','station-cars','station-pads']})[0]
      if(stationFeature){buildingInteraction?.hover(null);hoveredBuilding.value=null;map.getCanvas().style.cursor='pointer';return}
      const feature=showBuildings.value?map.queryRenderedFeatures(event.point,{layers:['buildings','bands']})[0]:null
      buildingInteraction?.hover(feature?.properties?.buildingId)
      const body=feature?city.buildings.features.find(f=>f.properties.id===feature.properties.buildingId):null
      hoveredBuilding.value=body?{name:body.properties.name,x:Math.min(event.point.x+14,mapEl.value.clientWidth-205),y:Math.max(8,event.point.y-55)}:null
      map.getCanvas().style.cursor=feature?'pointer':''
    })
    map.on('mouseout',()=>{buildingInteraction?.hover(null);hoveredBuilding.value=null;map.getCanvas().style.cursor=''})
    map.on('movestart',()=>{buildingInteraction?.hover(null);hoveredBuilding.value=null})
    map.on('error',()=>{mapError.value='三维渲染异常，站点列表与模拟计算仍可使用。'})
    observer=new ResizeObserver(()=>map?.resize());observer.observe(mapEl.value)
  } catch {mapError.value='当前设备无法启动三维场景，可继续使用站点列表与模拟计算。'}
})
onBeforeUnmount(()=>{disposed=true;requestVersion++;locationGeneration++;controller?.abort();cancelAnimationFrame(animation);clearInterval(informationTimer);clearTimeout(feedbackTimer);clearTimeout(ringTimer);motionQuery?.removeEventListener('change',syncMotion);observer?.disconnect();originMarker?.remove();markers.forEach(m=>m.remove());labels.forEach(m=>m.remove());map?.remove()})
</script>

<template>
  <main ref="appEl" class="angel-city" aria-label="三维充电沙盘" @click.capture="clickFeedback" @keydown="handleEscape">
    <span v-if="clickRing" :key="clickRing.id" class="city-click-ring" :style="{left:clickRing.x+'px',top:clickRing.y+'px'}" aria-hidden="true"></span>
    <div class="city-feedback-region" role="status" aria-live="polite" aria-atomic="true"><Transition name="city-toast"><div v-if="feedback" class="city-feedback" :data-tone="feedback.tone"><span aria-hidden="true">{{ feedback.tone==='success'?'✓':'•' }}</span><p :key="feedback.id">{{ feedback.message }}</p><button aria-label="关闭操作提示" @click.stop="feedback=null">×</button></div></Transition></div>
    <header class="city-header">
      <a href="#/charging" class="city-back"><UiIcon name="chevron" :size="18" />车主模式</a>
      <div class="city-title"><span>WEIDU / DIGITAL CITY</span><h1>城市充电<span>车辆周边三维沙盘</span></h1></div>
      <div class="city-source"><i :class="{offline:source!=='车主模式站点接口'}"></i>{{ loading?'正在同步站点…':source }}<button :disabled="loading" @click="loadData">刷新</button></div>
    </header>
    <section class="city-layout">
      <aside class="city-panel city-controls" aria-label="模拟控制">
        <div class="city-section-heading"><span>01 / 车辆与位置</span><b>从我的位置出发</b><p>自选车辆位置，查看周边充电、驾车路线与电量可达性。</p></div>
        <section class="city-origin-panel" aria-label="车辆位置设置"><b>{{ originName }}</b><small>{{ origin[0].toFixed(6) }}, {{ origin[1].toFixed(6) }} · WGS84</small><div class="city-actions"><button :aria-pressed="pickingOrigin" @click="pickOrigin">{{ pickingOrigin?'取消选点':'地图选点' }}</button><button :disabled="locatingOrigin" @click="locateOrigin">{{ locatingOrigin?'定位中…':'设备定位' }}</button></div><label class="city-place-search">查找地点<input v-model="placeQuery" type="search" placeholder="小区、商业地点或站点名称" aria-label="查找车辆位置" /></label><ul v-if="placeQuery.trim()" class="city-place-results"><li v-for="place in placeResults" :key="place.properties.id"><button @click="setOrigin(place.geometry.coordinates,place.properties.name)">{{ place.properties.name }}</button></li><li v-if="!placeResults.length">未找到项目内地点，可使用地图选点或坐标。</li></ul><details><summary>输入经纬度</summary><form @submit.prevent="applyCoordinates"><label>经度<input v-model="originLng" aria-label="车辆经度" inputmode="decimal" /></label><label>纬度<input v-model="originLat" aria-label="车辆纬度" inputmode="decimal" /></label><button type="submit">应用车辆位置</button></form></details><button class="city-restore" @click="setOrigin([...ANGEL_CENTER],'天使城 · 参考位置')">使用天使城参考位置</button><p v-if="originError" class="city-data-error" role="alert">{{ originError }}</p></section>
        <label class="city-field">周边范围<select v-model.number="radius"><option :value="800">800 米 · 附近站点</option><option :value="1500">1.5 公里 · 周边街区</option><option :value="2500">2.5 公里 · 扩展范围</option><option :value="5000">5 公里 · 扩大分析</option></select></label>
        <details class="city-reach-settings" open><summary>本次可达性参数</summary><div class="city-edit-grid"><label>当前电量 %<input :value="profile.currentSoc" aria-label="分析当前电量" type="number" min="0" max="100" placeholder="未填写" @change="updateVehicle('currentSoc',$event.target.value)" /></label><label>电池容量 kWh<input :value="profile.batteryKwh" aria-label="分析电池容量" type="number" min="1" max="300" placeholder="未填写" @change="updateVehicle('batteryKwh',$event.target.value)" /></label><label>百公里电耗<input :value="profile.consumptionKwh" aria-label="分析百公里电耗" type="number" min="1" max="100" placeholder="kWh/100km" @change="updateVehicle('consumptionKwh',$event.target.value)" /></label><label>保留电量 %<input :value="profile.reserveSoc" aria-label="分析保留电量" type="number" min="0" max="100" @change="updateVehicle('reserveSoc',$event.target.value)" /></label></div><small>初始读取车主设置；这里的修改仅用于本次分析。</small><button class="city-restore" @click="profile=readChargingSettings().profile;inform('已重新读取车主车辆设置。')">重新读取车主设置</button></details>
        <label class="city-field">客流情景<select v-model="scenario" @change="choosePreset"><option value="weekday">工作日 · 平稳到访</option><option value="weekend">周末 · 购物高峰</option><option value="holiday">节假日 · 集中到访</option></select></label>
        <label class="city-slider">充电到访量 <b>{{ arrivals }} <small>辆 / 小时</small></b><input v-model.number="arrivals" aria-label="充电到访量" type="range" min="0" max="300" step="10" /></label>
        <label class="city-field">模拟时长<select v-model.number="duration"><option :value="60">1 小时</option><option :value="120">2 小时</option><option :value="240">4 小时</option></select></label>
        <div class="city-vehicle"><UiIcon name="car" :size="20" /><div><b>{{ vehicle.assumed?'演示车辆参数':'已读取车主车辆参数' }}</b><p>{{ vehicle.battery }} kWh · {{ vehicle.soc }}% → {{ vehicle.target }}%</p><small>每车补电约 {{ round(vehicle.energy) }} kWh · 功率上限 {{ vehicle.maxPower }} kW</small><a href="#/charging/settings">调整车辆设置 ↗</a></div></div>
        <div class="city-section-heading compact"><span>02 / 方案对比</span><b>让每一次调整看得见</b></div>
        <div class="city-segment"><button :class="{active:stage==='before'}" :aria-pressed="stage==='before'" @click="changeStage('before')">原方案</button><button :class="{active:stage==='after'}" :aria-pressed="stage==='after'" @click="changeStage('after')">调整方案 <small>{{ editedCount }}</small></button></div>
        <div class="city-comparison"><div><span>平均排队 <small>分钟</small></span><b>{{ round(before.averageWait) }} <i>→</i> {{ round(after.averageWait) }}</b></div><div><span>时段内完成 <small>辆</small></span><b>{{ before.completed }} <i>→</i> {{ after.completed }}</b></div></div>
        <p class="city-verdict">{{ !editedCount?'选择站点，调整桩数或功率开始对比。':verdict }}</p>
        <div class="city-actions"><button @click="reset">重置方案</button><button :disabled="!localStations.length" @click="exportReport">导出方案 ↗</button></div>
        <p v-if="notice" class="city-notice" role="status">{{ notice }}</p>
        <details class="city-assumptions"><summary>模拟假设与数据说明</summary><p>建筑轮廓、高度、支路、水系与车位为示意建模，非测绘复原。车辆位置可自由选择；天使城仅为初始参考位置。</p><p>从空桩开始，假设客流按等待、充电时长和距车辆位置的直线距离选择站点。缺少桩数或功率时按 8 桩、60 kW 演示，可逐站修改。功率折减 0.8、效率 0.9；每车补电需求在车辆目标的 ±20% 内变化。</p><p>单站最多绘制 12 个车位，统计使用完整桩数。站内车辆随模拟时钟变化，非现场实况。平均排队含时段后才开始充电的车辆；完成数与电量仅统计时段内。</p><p>已知关闭、禁止进入或不适配本车的站点排除。道路车辆仅作客流动画。实线使用接口驾车路线，背景道路为示意；虚线仅为直线参考。到站电量按本次车辆参数估算，路线未确认时不判定为可达。</p><a href="https://i.azpdl.cn/pdl-index/weixin/mendian.html" target="_blank" rel="noopener noreferrer">天使城位置参考：胖东来门店信息 ↗</a></details>
      </aside>
      <section class="city-scene" aria-label="三维街区">
        <div ref="mapEl" class="city-map"></div>
        <div v-if="hoveredBuilding && !selectedBuilding" class="city-hover-label" :style="{left:hoveredBuilding.x+'px',top:hoveredBuilding.y+'px'}" aria-hidden="true"><b>{{ hoveredBuilding.name }}</b><span>点击查看建筑</span></div>
        <div class="city-scene-heading"><span class="city-live-tag">3D SCENE <i></i></span><h2>{{ isAngelOrigin?'许昌 · 天使城':'车辆周边街区' }}</h2><p>{{ originName }}<span>建筑与车位为示意 · 车辆为模拟</span></p></div>
        <div v-if="pickingOrigin" class="city-pick-hint" role="status">点击地图放置车辆，周边站点将自动重新分析。<button @click="pickOrigin">取消</button></div>
        <div class="city-map-tools"><button @click="overview" aria-label="回到车辆位置全景" title="回到车辆位置全景"><UiIcon name="locate" :size="18" /></button><button :aria-pressed="flat" @click="flat=!flat">{{ flat?'3D':'2D' }}</button><button :aria-pressed="night" @click="night=!night">{{ night?'日景':'夜景' }}</button></div>
        <div class="city-layer-toggles"><label><input v-model="showBuildings" type="checkbox" />建筑</label><label><input v-model="showTrees" type="checkbox" />绿化</label><span>拖动平移 · 右键旋转 · 滚轮缩放</span></div>
        <div v-if="mapError" class="city-map-error" role="alert">{{ mapError }}</div>
        <Transition name="city-inspect" mode="out-in"><div v-if="selectedBuilding" :key="selectedBuilding.buildingId" class="city-building-card"><button @click="clearSelection()" aria-label="关闭建筑信息">×</button><b>{{ selectedBuilding.name }}</b><span>示意高度 {{ selectedBuilding.height }} m</span><small>体量用于场景表现，非实测高度</small><button class="city-inspect-action" @click="focusBuilding">靠近查看 ↗</button><small class="city-dismiss-hint">点击空白处或 Esc 取消选择</small></div>
        <div v-else-if="stationPeek && selected" :key="selected.id" class="city-building-card city-station-peek"><button aria-label="关闭站点浮窗" @click="stationPeek=false">×</button><small>已选中充电站 · {{ stage==='before'?'原方案':'调整方案' }}</small><b>{{ selected.name }}</b><CityStationFacts :properties="selected.feature.properties" :now="now" :snapshot="selectedSnapshot" compact /><p class="city-peek-reach" :data-state="selectedReachability?.status">{{ selectedReachability?.label }} · {{ selectedReachability?.driving?'驾车':'直线参考' }} {{ Math.round(selectedReachability?.meters||0) }} m</p><button class="city-inspect-action" @click="focusStationEditor">查看与调整此站 ↗</button></div></Transition>
        <div class="city-map-legend"><span><i class="gold"></i>模拟充电车辆</span><span><i class="green"></i>模拟空闲车位</span><span>实线：驾车路线 · 虚线：直线参考</span></div>
        <div class="city-playback"><div class="city-playback-main"><button class="city-play-button" :aria-label="playing?'暂停模拟':'播放模拟'" @click="togglePlay">{{ playing?'Ⅱ':'▶' }}</button><div><b>{{ clockLabel }}</b><small>{{ stage==='before'?'原方案':'调整方案' }} · 模拟时钟</small></div><input v-model.number="time" type="range" min="0" :max="duration" step="0.2" aria-label="模拟进度" /><select v-model.number="speed" aria-label="播放速度"><option :value="1">1 分 / 秒</option><option :value="5">5 分 / 秒</option><option :value="15">15 分 / 秒</option></select></div><button class="city-preview-cars" @click="playing=false;time=Math.min(30,duration)">预览 30 分钟充电车辆</button><div class="city-frame-stats"><span>正在充电 <b>{{ frame.charging.length }}</b></span><span>正在排队 <b>{{ frame.waiting.length }}</b></span><span>已完成 <b>{{ frame.completed }}</b></span></div></div>
      </section>
      <aside class="city-panel city-stations" aria-label="站点与模拟结果">
        <div class="city-section-heading"><span>03 / 站点联动</span><b>周边的每一处补能点</b></div>
        <section class="city-reach-summary" aria-label="周边可达性结果"><div><b>{{ reachabilityCounts.reachable }}</b><span>预计可达</span></div><div><b>{{ reachabilityCounts.unreachable }}</b><span>不足 / 受限</span></div><div><b>{{ reachabilityCounts.unknown }}</b><span>待确认</span></div><button :disabled="routesRunning||!localStations.length" @click="refreshRoutes">{{ routesRunning?'正在分析驾车路线…':'重新分析可达性' }}</button><small>按当前位置与车辆参数估算，不含进场限制及实时路况变化。</small></section>
        <div class="city-station-summary"><div><b>{{ localStations.length }}</b><span>记录站点</span></div><div><b>{{ activeCount }}</b><span>参与模拟</span></div><div><b>{{ Math.round(result.energy) }}</b><span>模拟 kWh</span></div></div>
        <p v-if="dataError" class="city-data-error" role="status">{{ dataError }}<button :disabled="loading" @click="loadData">重试</button></p>
        <p v-if="!loading&&!localStations.length" class="city-empty">范围内暂无站点，请扩大范围或刷新数据。</p>
        <div class="city-station-list"><button v-for="station in proposed" :key="station.id" :class="['city-station-item',{active:station.id===selectedId}]" :aria-pressed="station.id===selectedId" @click="selectStation(station.id)"><span class="city-station-bolt">ϟ</span><span><b>{{ station.name }}</b><small>直线 {{ Math.round(station.distance) }} m · <em :data-state="reachability.get(station.id)?.status">{{ reachability.get(station.id)?.label }}</em></small><small>模拟充电 {{ stationSnapshots.get(station.id)?.charging||0 }} · 空闲 {{ stationSnapshots.get(station.id)?.free||0 }} · {{ station.blocked?'已排除':station.assumed?'含假设':'记录参数' }}</small></span><i v-if="station.edited" title="已调整">●</i></button></div>
        <div v-if="selected" class="city-selected-facts"><CityStationFacts :properties="selected.feature.properties" :now="now" :snapshot="selectedSnapshot" /><section v-if="selectedReachability" class="city-reach-detail" aria-label="所选站点可达性" :data-state="selectedReachability.status"><b>{{ selectedReachability.label }}<small v-if="selectedReachability.routeStatus==='loading'"> · 路线计算中</small></b><p>{{ selectedReachability.reason }}</p><dl><div><dt>{{ selectedReachability.driving?'驾车距离':'直线参考' }}</dt><dd>{{ Math.round(selectedReachability.meters) }} m</dd></div><div><dt>驾车时间</dt><dd>{{ selectedReachability.driveMinutes===null?'未知':round(selectedReachability.driveMinutes)+' 分钟' }}</dd></div><div><dt>{{ selectedReachability.driving?'预计到站电量':'直线耗电后电量' }}</dt><dd>{{ selectedReachability.arrivalSoc===null?'缺车辆参数':selectedReachability.arrivalSoc+'%' }}</dd></div></dl><small>保留电量 {{ profile.reserveSoc??'未填写' }}% · {{ selectedReachability.driving?'基于接口驾车路线估算；入口以现场为准':'直线参考不能证明驾车可达' }}</small></section></div>
        <section v-if="selected" :key="selected.id" ref="detailEl" tabindex="-1" class="city-station-detail" aria-label="站点参数编辑"><div class="city-detail-heading"><span>选中站点</span><label><input type="checkbox" :checked="selected.enabled" :disabled="selected.blocked" @change="edit('enabled',$event.target.checked)" />参与模拟</label></div><h3>{{ selected.name }}</h3><p>{{ selected.feature.properties.address||'记录地址未知' }}</p><div class="city-edit-grid"><label>桩数 <small>{{ overrides[selected.id]?.piles!=null?'方案值':selected.countKnown?'记录值':'假设值' }}</small><input type="number" min="0" max="200" step="1" :value="selected.piles" :disabled="selected.blocked" @change="edit('piles',$event.target.value)" /></label><label>单桩 kW <small>{{ overrides[selected.id]?.power!=null?'方案值':selected.powerKnown?'记录值':'假设值' }}</small><input type="number" min="1" max="1000" step="1" :value="selected.power" :disabled="selected.blocked" @change="edit('power',$event.target.value)" /></label></div><p v-if="selected.blocked" class="city-data-error">记录显示关闭、限制进入或与本车不适配，已排除。</p><div v-if="selectedResult" class="city-detail-metrics"><span>模拟分配 <b>{{ selectedResult.arrived }} 辆</b></span><span>平均排队 <b>{{ round(selectedResult.averageWait) }} 分</b></span><span>桩利用率 <b>{{ Math.round(selectedResult.utilization*100) }}%</b></span></div><button v-if="selected.edited" class="city-restore" @click="restoreStation">恢复此站参数</button></section>
        <p v-if="result.unserved" class="city-data-error">{{ result.unserved }} 辆未分配{{ vehicle.energy===0?'：车辆已达到目标电量。':'：当前无可参与模拟的充电桩。' }}</p>
        <p class="city-footnote">站点位置与属性来自车主模式同源数据。调整仅用于当前沙盘，不修改站点记录。</p>
      </aside>
    </section>
  </main>
</template>

<style src="../angel-city.css"></style>
