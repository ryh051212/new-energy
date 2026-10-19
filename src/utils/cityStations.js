import { collection, offsetPoint, ANGEL_CENTER, createAngelCity } from './angelCity.js'
import { stationDistance } from './charging.js'
import { informationState, stationAvailability, chargingCompatibility } from './stationInformation.js'
import { normalizeTripContext } from './tripCharging.js'
import { validCoordinates } from './stations.js'

export function stationSnapshot(model, result, time) {
  const sessions=(result?.sessions||[]).filter(s=>s.stationId===model.id)
  const charging=sessions.filter(s=>s.start<=time&&s.end>time)
  const waiting=sessions.filter(s=>s.arrival<=time&&s.start>time)
  const capacity=model.enabled?model.piles:0
  return {charging:charging.length,waiting:waiting.length,free:Math.max(0,capacity-charging.length),capacity,
    occupiedSlots:charging.map(s=>s.slot),completed:sessions.filter(s=>s.end<=time).length}
}
function box(center,x,y,width,depth,base,height,properties) {
  const ring=[[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2],[-width/2,-depth/2]]
    .map(([a,b])=>offsetPoint(x+a,y+b,center))
  return {type:'Feature',properties:{...properties,base,height},geometry:{type:'Polygon',coordinates:[ring]}}
}
// Parking layout and vehicles are illustrative; slots are taken from the queue simulation.
export function createStationModels(models,result,time) {
  const structures=[],vehicles=[],pads=[]
  for(const model of models) {
    const center=model.feature.geometry.coordinates, state=stationSnapshot(model,result,time)
    const visible=Math.min(12,model.piles), cols=Math.min(6,Math.max(1,visible)),rows=Math.ceil(visible/cols)
    const properties={stationId:model.id,name:model.name,kind:'station'}
    pads.push(box(center,0,0,cols*7+10,rows*14+8,0,.5,{...properties,color:'#59736b'}))
    for(let slot=0;slot<visible;slot++) {
      const x=(slot%cols-(cols-1)/2)*7,y=(Math.floor(slot/cols)-(rows-1)/2)*14
      const occupied=state.occupiedSlots.includes(slot)
      structures.push(box(center,x,y,5.7,10,.5,.6,{...properties,slot,color:!model.enabled?'#737d7a':occupied?'#3f8294':'#609879'}))
      structures.push(box(center,x,y+4,1.5,1.1,.6,4.3,{...properties,slot,color:!model.enabled?'#596969':occupied?'#f4cb7d':'#8eefc0'}))
      structures.push(box(center,x,y+3.4,1,.2,2.5,3.7,{...properties,slot,color:'#203944'}))
      if(occupied) {
        vehicles.push(box(center,x,y-1,3.6,7.6,.8,2.6,{...properties,slot,kind:'charging-car',color:slot%2?'#dbe9ed':'#ecc88c'}))
        vehicles.push(box(center,x,y-1,3,3.9,2.6,3.9,{...properties,slot,kind:'charging-car',color:'#527b91'}))
      }
    }
  }
  return {pads:collection(pads),structures:collection(structures),vehicles:collection(vehicles)}
}

export function stationCurrentFacts(properties={},now=Date.now()) {
  const number=(key)=>informationState(properties,key,properties[key],now,key==='pricePerKwh'?['electricityPrice','servicePrice']:[]).state==='known' && Number.isFinite(properties[key])&&properties[key]>=0?properties[key]:null
  const price=number('pricePerKwh'),electricity=number('electricityPrice'),service=number('servicePrice')
  const totalPrice=price??(electricity!==null&&service!==null?electricity+service:null)
  const availability=stationAvailability(properties,now)
  const power=number('powerKw'),count=number(properties.pileCount==null?'totalCount':'pileCount')
  return {availability,power,count,price:totalPrice,electricity,service,parking:number('parkingFee'),
    priceText:totalPrice===null?'暂无价格':`${totalPrice.toFixed(2)} 元/度`,
    powerText:power===null?'功率未知':`${power} kW`,
    countText:count===null?'桩数未知':`${count} 桩`,
    opening:informationState(properties,'openingHours',properties.openingHours,now).state==='known'?properties.openingHours:'开放时间未知',
    currentType:chargingCompatibility(properties).currentType,
    hasAssumedFields:['pricePerKwh','powerKw','availableCount'].some(k=>informationState(properties,k).state==='simulated')}
}
export function validDrivingRoutes(data) {
  if(data?.type!=='FeatureCollection'||!Array.isArray(data.features))return []
  return data.features.filter(f=>f?.geometry?.type==='LineString'&&f.geometry.coordinates?.length>=2
    &&f.geometry.coordinates.every(validCoordinates)&&f.properties?.isFallback===false
    &&f.properties.distanceSource==='amap_driving'&&f.properties.distanceType==='driving'
    &&Number.isFinite(f.properties.drivingDistanceMeters)&&f.properties.drivingDistanceMeters>=0
    &&Number.isFinite(f.properties.drivingDurationSeconds)&&f.properties.drivingDurationSeconds>=0).slice(0,3)
}
export function assessCityReachability(feature,origin,profile={},routeState) {
  const p=feature.properties||{},c=normalizeTripContext(profile),straight=stationDistance(feature,origin)*1000
  const route=routeState?.routes?.[0],driving=!!route
  const meters=driving?route.properties.drivingDistanceMeters:straight
  const vehicleKnown=c.batteryKwh>0&&c.currentSoc!==null&&c.consumptionKwh>0&&c.reserveSoc!==null
  const energy=vehicleKnown?meters/100000*c.consumptionKwh:null
  const arrival=energy===null?null:c.currentSoc-energy/c.batteryKwh*100
  const closed=informationState(p,'status').state==='known'&&['closed','inactive','offline','retired','maintenance'].includes(p.status)
    || informationState(p,'accessAllowed').state==='known'&&p.accessAllowed===false
  const incompatible=chargingCompatibility(p,c).prohibited
  const status=closed||incompatible?'blocked':arrival!==null&&arrival<c.reserveSoc?'unreachable':driving&&vehicleKnown?'reachable':'unknown'
  const reason=closed?'站点关闭或限制进入':incompatible?'不符合本车充电类型':status==='unreachable'
    ?driving?'预计到站电量低于保留电量':'仅直线距离已超出电量预算'
    :!vehicleKnown?'请补充车辆电量、电池容量和电耗':!driving?'驾车路线未确认':'按驾车路线估算，到站电量满足保留要求'
  return {status,label:{blocked:'不可使用',unreachable:'电量不足',reachable:'预计可达',unknown:'待确认'}[status],reason,
    straight,meters,driving,driveMinutes:driving?route.properties.drivingDurationSeconds/60:null,
    arrivalSoc:arrival===null?null:Math.round(arrival*10)/10,energy,route,
    routeStatus:routeState?.status||'idle'}
}

// Keep TianShi at its true POI. Other locations use clearly labelled generic blocks.
export function createLocalCity(center,stations=[]) {
  const scene=createAngelCity()
  const atAngel=Math.abs(center[0]-ANGEL_CENTER[0])<.00001&&Math.abs(center[1]-ANGEL_CENTER[1])<.00001
  const shift=coords=>typeof coords[0]==='number'?[coords[0]+center[0]-ANGEL_CENTER[0],coords[1]+center[1]-ANGEL_CENTER[1]]:coords.map(shift)
  if(!atAngel)for(const [key,data] of Object.entries(scene)) {
    data.features=data.features.filter(f=>!['mall','plaza'].includes(f.properties.kind)).map(f=>({...f,
      geometry:{...f.geometry,coordinates:shift(f.geometry.coordinates)},
      properties:{...f.properties,...(key==='roads'?{name:'周边道路（示意）'}:{})}}))
  }
  // Remove bands of the two landmark volumes as well.
  if(!atAngel)scene.bands.features=scene.bands.features.filter(f=>!['building-0','building-2'].includes(f.properties.buildingId))
  // Synthetic building blocks must not cover charging lots at recorded coordinates.
  const cleared=new Set()
  for(const building of scene.buildings.features) {
    const points=building.geometry.coordinates[0],xs=points.map(p=>p[0]),ys=points.map(p=>p[1])
    for(const station of stations) {
      const [lng,lat]=station.geometry.coordinates,dx=42/(111320*Math.cos(lat*Math.PI/180)),dy=24/111320
      if(lng+dx>=Math.min(...xs)&&lng-dx<=Math.max(...xs)&&lat+dy>=Math.min(...ys)&&lat-dy<=Math.max(...ys))cleared.add(building.properties.buildingId)
    }
  }
  for(const key of ['buildings','bands'])scene[key].features=scene[key].features.filter(f=>!cleared.has(f.properties.buildingId))
  return scene
}
