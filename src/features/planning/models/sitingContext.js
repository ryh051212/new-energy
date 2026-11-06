import { booleanPointInPolygon, distance, point, pointOnFeature, pointToLineDistance, nearestPointOnLine } from '@turf/turf'
import { validCoordinates } from '../../stations/models/stations.js'

export const LANDUSE_GROUPS = [
  {values:['residential'],label:'居住',color:'#e9b949'},
  {values:['commercial','retail'],label:'商业服务',color:'#db82a8'},
  {values:['industrial'],label:'工业',color:'#a68bd2'},
  {values:['forest','grass','meadow','recreation_ground','village_green','farmland','orchard','allotments','plant_nursery'],label:'绿地与农业',color:'#83b579'},
  {values:[],label:'其他用地',color:'#a8b4c4'},
]
const LANDUSE_LABELS={residential:'居住用地',commercial:'商业用地',retail:'零售商业',industrial:'工业用地',forest:'林地',grass:'草地',meadow:'草甸',recreation_ground:'游憩绿地',village_green:'公共绿地',farmland:'农田',orchard:'果园',allotments:'园地',plant_nursery:'苗圃',construction:'施工用地',brownfield:'待开发用地',railway:'铁路用地',cemetery:'墓地',religious:'宗教用地',military:'军事用地',garages:'车库用地',education:'教育用地'}
export const landuseLabel=value=>LANDUSE_LABELS[value] || value || '类型未标注'
export const referenceSourceLabel=feature=>({OpenStreetMap:'OSM',AMap:'高德'})[feature?.properties?.source] || '公开资料'
export function safeReferenceUrl(value) {
  try {const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:''} catch{return ''}
}
export function referenceAnchor(feature) {
  if(!feature?.geometry)return null
  try{return {...pointOnFeature(feature),properties:{...feature.properties}}}catch{return null}
}
export const referenceDistance=value=>value==null?'距离未知':value<1000?Math.round(value)+' m':(value/1000).toFixed(1)+' km'
export function capacityDescription(p={}) {
  if(typeof p.capacity!=='number' || !Number.isFinite(p.capacity) || p.capacity<0)return '泊位数未提供'
  const kind=p.capacityKind==='design'?'公开设计规模':p.capacityKind==='mapped'?'地图标注总泊位':'公开总泊位'
  return `${kind} ${p.capacity} 位${p.capacityDate?'（'+p.capacityDate.slice(0,4)+'年）':''}`
}

export function locationContext(coordinates, data, roads=[]) {
  if(!validCoordinates(coordinates))return null
  const here=point(coordinates),features=data?.features || []
  const nearest=(rows,limit=2)=>rows.flatMap(feature=>{
    const anchor=referenceAnchor(feature)
    if(!validCoordinates(anchor?.geometry.coordinates))return []
    return [{feature,anchor,meters:distance(here,anchor,{units:'meters'})}]
  }).sort((a,b)=>a.meters-b.meters).slice(0,limit)
  const road=roads.filter(feature=>feature.properties?.motorVehicleCandidate && feature.geometry?.type==='LineString')
    .flatMap(feature=>{try{return [{feature,anchor:{...nearestPointOnLine(feature,here),properties:{...feature.properties}},meters:pointToLineDistance(here,feature,{units:'meters'})}]}catch{return []}})
    .sort((a,b)=>a.meters-b.meters)[0] || null
  const landuse=features.filter(feature=>['landuse','water'].includes(feature.properties?.category) && ['Polygon','MultiPolygon'].includes(feature.geometry?.type)
    && booleanPointInPolygon(here,feature))
  const entrances=nearest(features.filter(feature=>feature.properties?.category==='entrance' && feature.properties.entranceKind==='parking'))
  const parking=nearest(features.filter(feature=>feature.properties?.category==='parking'),3)
  const power=nearest(features.filter(feature=>feature.properties?.category==='power'))
  return {road,landuse,entrances,parking,power}
}

export function contextPopupLines(feature) {
  const p=feature.properties || {},kind={landuse:'用地映射',water:'水域映射',entrance:'出入口记录',parking:'停车记录',power:'电力设施位置',safety:'风险与障碍记录'}[p.category] || '道路记录'
  const lines=[p.name || (p.category==='landuse'?landuseLabel(p.landuse):kind),kind+' · '+referenceSourceLabel(feature)]
  if(p.category==='parking')lines.push(capacityDescription(p),'总泊位与可增设充电桩泊位分开核查')
  if(p.category==='power')lines.push(p.voltage?'标注电压：'+p.voltage+' V':'电压未标注','配变可用余量未提供')
  if(p.category==='entrance')lines.push('地图入口记录，机动车通行与场地授权仍需核查')
  if(p.category==='landuse' || p.category==='water')lines.push('用途映射仅作参考，不代表建设许可')
  if(p.observedAt)lines.push('数据日期：'+p.observedAt.slice(0,10))
  return lines
}
