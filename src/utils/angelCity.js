import { normalizeChargingPoint, stationDistance } from './charging.js'
import { validCoordinates } from './stations.js'
import { informationState, chargingCompatibility } from './stationInformation.js'

// Project POI B0J6YS04RS. All model geometry uses WGS84; no shifted raster basemap.
export const ANGEL_CENTER = normalizeChargingPoint({ type: 'Feature', properties: { coordSystem: 'GCJ-02' }, geometry: { type: 'Point', coordinates: [113.846681, 34.03593] } }).geometry.coordinates
export const collection = features => ({ type: 'FeatureCollection', features })
export function offsetPoint(x, y, center = ANGEL_CENTER) {
  return [center[0] + x / (111320 * Math.cos(center[1] * Math.PI / 180)), center[1] + y / 111320]
}
function rect(x, y, w, d, properties) {
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2],[-w/2,-d/2]].map(([a,b]) => offsetPoint(x+a,y+b))] } }
}
function line(points, properties) { return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates: points.map(([x,y]) => offsetPoint(x,y)) } } }
export function createAngelCity() {
  const buildings = [], bands = [], grounds = [], roads = [], trees = []
  function building(x,y,w,d,height,kind,name) {
    const colors = { mall: '#eabf7c', residential: '#b4c6c9', office: '#91aebf', retail: '#90b6ac' }
    const id = `building-${buildings.length}`
    const properties = { id, buildingId:id, name, height, base: 0, kind, color: colors[kind], modeled: true }
    buildings.push(rect(x,y,w,d,properties))
    for (let z=4; z<height-1; z+=kind === 'mall' ? 5 : 6) bands.push(rect(x,y,w+.35,d+.35,{id:`${id}-band-${z}`,buildingId:id,height:z+.75,base:z,color:kind==='mall'?'#716655':'#597686'}))
    buildings.push(rect(x,y,w*.78,d*.75,{...properties, id: `${properties.id}-roof`, base:height,height:height+2,color:kind==='mall'?'#f4dcb2':'#d5dfe0'}))
  }
  grounds.push(rect(0,0,3300,3000,{kind:'ground',color:'#243b40'}))
  grounds.push(rect(40,-10,260,240,{kind:'plaza',color:'#708078'}))
  grounds.push(rect(395,-245,370,240,{kind:'park',color:'#365f51',name:'公园绿地（示意）'}))
  building(0,0,170,130,28,'mall','胖东来天使城 · 示意体量')
  building(43,10,66,60,38,'mall','天使城屋顶体量（示意）')
  // Road relationships follow the landmark address; road widths and branch streets are illustrative.
  roads.push(line([[-1450,-120],[1450,-120]],{name:'建安大道',width:24}))
  roads.push(line([[-120,-1300],[-120,1300]],{name:'八龙路',width:18}))
  roads.push(line([[640,-1300],[640,1300]],{name:'周边道路（示意）',width:15}))
  roads.push(line([[-1450,570],[1450,570]],{name:'街区道路（示意）',width:15}))
  roads.push(line([[-1450,-650],[1450,-650]],{name:'街区道路（示意）',width:15}))
  roads.push(line([[-750,-1300],[-750,1300]],{name:'街区道路（示意）',width:15}))
  const river = line([[-1000,-1500],[-1010,-800],[-940,-300],[-965,350],[-910,950],[-960,1500]],{name:'水系（示意）'})
  const blocks = [[-490,220],[-440,850],[265,350],[920,300],[930,870],[250,900],[-430,-430],[150,-890],[930,-430],[-450,-920],[970,-930]]
  blocks.forEach(([x,y],i) => {
    grounds.push(rect(x,y,355,245,{kind:'block',color:i%3===0?'#42554c':'#3c514e'}))
    for(let row=0;row<2;row++) for(let col=0;col<3;col++) {
      const index=i*6+row*3+col
      const kind=i%4===0?'office':i%4===2?'retail':'residential'
      const height=kind==='retail'?10+(index%4)*5:kind==='office'?38+(index%5)*12:27+(index%8)*9
      building(x-115+col*112,y-62+row*120,kind==='retail'?76:55,kind==='office'?62:38,height,kind,`${kind==='residential'?'住宅':kind==='office'?'办公':'商业'}示意 ${index+1}`)
    }
  })
  for (let x=-1350;x<=1350;x+=52) for (const y of [-151,-88,541,599]) trees.push(rect(x,y,9,9,{height:6+(Math.abs(x)%3),base:1,color:'#497c61'}))
  for(let i=0;i<45;i++) trees.push(rect(245+(i%9)*35,-330+Math.floor(i/9)*40,13,13,{height:8,base:0,color:'#528166'}))
  return { buildings:collection(buildings),bands:collection(bands),grounds:collection(grounds),roads:collection(roads),river:collection([river]),trees:collection(trees) }
}

export function nearbyModelStations(features, radius=1500, center=ANGEL_CENTER) {
  const seen = new Set()
  return features.filter(f=>f?.geometry?.type==='Point' && validCoordinates(f.geometry.coordinates))
    .map(normalizeChargingPoint).filter(f=> {
      const id = String(f.properties?.id ?? '')
      if (!id || seen.has(id) || f.properties.isSynthetic) return false
      seen.add(id)
      return stationDistance(f,center)*1000<=radius
    }).sort((a,b)=>stationDistance(a,center)-stationDistance(b,center))
}
export function stationModel(feature, override={}, profile={}, center=ANGEL_CENTER) {
  const p = feature.properties || {}
  const known = (key) => informationState(p,key).state === 'known' && Number.isFinite(p[key]) && p[key]>=0
  const countKey = p.pileCount == null ? 'totalCount' : 'pileCount'
  const countKnown = known(countKey) && Number.isInteger(p[countKey])
  const powerKnown = known('powerKw') && p.powerKw>0
  const blocked = informationState(p,'status').state==='known' && ['closed','inactive','offline','retired','maintenance'].includes(p.status)
    || informationState(p,'accessAllowed').state==='known' && p.accessAllowed===false
    || chargingCompatibility(p,profile).prohibited
  const count = countKnown ? Math.min(200,p[countKey]) : 8
  const power = powerKnown ? Math.min(1000,p.powerKw) : 60
  return { id:String(p.id),name:p.name || '未命名站点',feature,
    distance:stationDistance(feature,center)*1000,
    piles:override.piles == null ? count : Math.max(0,Math.min(200,Math.round(Number(override.piles)||0))),
    power:override.power == null ? power : Math.max(1,Math.min(1000,Number(override.power)||60)),
    enabled:!blocked && override.enabled!==false, blocked,
    countKnown,powerKnown,assumed:!countKnown||!powerKnown,
    edited:override.piles!=null||override.power!=null||override.enabled!=null }
}
export function modelVehicle(profile={}) {
  const positive=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback
  const battery=positive(profile.batteryKwh,60),soc=Number.isFinite(profile.currentSoc)?profile.currentSoc:30
  const target=Number.isFinite(profile.targetSoc)?profile.targetSoc:80
  return { energy:Math.max(0,(target-soc)/100*battery), maxPower:positive(profile.maxChargeKw,90),
    assumed:!(profile.batteryKwh>0 && Number.isFinite(profile.currentSoc) && Number.isFinite(profile.targetSoc) && profile.maxChargeKw>0),
    battery,soc,target }
}
// Deterministic finite-horizon queue: identical arrivals for baseline and proposal.
// No live occupancy is inferred. Each scenario starts with empty chargers.
export function simulateCharging(models, { arrivals=60, duration=120, vehicle=modelVehicle(), seed=42 }={}) {
  const rate=Math.max(0,Math.min(600,Number(arrivals)||0)), horizon=Math.max(15,Math.min(240,Number(duration)||120))
  let rng=seed>>>0
  const random=()=> { rng=(1664525*rng+1013904223)>>>0; return rng/4294967296 }
  const rows=models.map(m=>({...m,slots:Array(m.enabled?m.piles:0).fill(0),sessions:[],arrived:0,wait:0,energy:0,busyMinutes:0}))
  const sessions=[], count=Math.floor(rate*horizon/60)
  let unserved=0
  for(let i=0;i<count;i++) {
    const arrival=(i+.2+random()*.6)*horizon/count
    const energy=vehicle.energy*(.8+random()*.4)
    if(energy<=0) { unserved++; continue }
    let best=null
    for(const row of rows) {
      if(!row.slots.length) continue
      const slot=row.slots.indexOf(Math.min(...row.slots))
      const start=Math.max(arrival,row.slots[slot])
      const effective=Math.min(row.power,vehicle.maxPower)*.8*.9
      const minutes=energy/effective*60
      const score=start-arrival+minutes+row.distance/80
      if(!best || score<best.score) best={row,slot,start,minutes,score,effective}
    }
    if(!best) {unserved++;continue}
    const {row,slot,start,minutes,effective}=best,end=start+minutes,wait=start-arrival
    row.slots[slot]=end;row.arrived++;row.wait+=wait
    const occupied=Math.max(0,Math.min(end,horizon)-start)
    row.busyMinutes+=occupied;row.energy+=occupied*effective/60
    const session={id:i,stationId:row.id,slot,arrival,start,end,energy,wait}
    sessions.push(session);row.sessions.push(session)
  }
  return {duration:horizon,arrivals:count,unserved,sessions,
    averageWait:sessions.length?sessions.reduce((s,v)=>s+v.wait,0)/sessions.length:0,
    completed:sessions.filter(v=>v.end<=horizon).length,
    energy:rows.reduce((s,r)=>s+r.energy,0),
    rows:rows.map(({slots,...row})=>({...row,averageWait:row.arrived?row.wait/row.arrived:0,utilization:slots.length?row.busyMinutes/(slots.length*horizon):0})) }
}
export function simulationFrame(result,time) {
  const t=Math.max(0,Math.min(result.duration,time))
  return {charging:result.sessions.filter(s=>s.start<=t&&s.end>t),waiting:result.sessions.filter(s=>s.arrival<=t&&s.start>t),completed:result.sessions.filter(s=>s.end<=t).length}
}

export function compareChargingScenarios(before,after) {
  const savedWait=before.averageWait-after.averageWait
  if(after.unserved>before.unserved) return `调整后有 ${after.unserved} 辆未能分配，不能仅凭排队减少判断改善。`
  if(after.completed<before.completed && savedWait>0) return `排队减少 ${savedWait.toFixed(1)} 分钟，但时段内完成车辆减少 ${before.completed-after.completed} 辆。`
  if(savedWait>.05) return `调整后平均排队减少 ${savedWait.toFixed(1)} 分钟。`
  if(savedWait<-.05) return `调整后平均排队增加 ${(-savedWait).toFixed(1)} 分钟。`
  return '调整前后平均排队基本一致。'
}
