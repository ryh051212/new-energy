import { LANDUSE_GROUPS } from '../../planning/models/sitingContext.js'

export const SITING_CONTEXT_LAYERS=[
  {id:'sitingLanduse',label:'用地与水域参考',section:'reference',context:true,layerIds:['context-landuse-fill','context-landuse-outline'],visible:false},
  {id:'sitingParking',label:'停车与出入口',section:'reference',context:true,layerIds:['context-parking','context-entrance'],visible:false},
  {id:'sitingPower',label:'电力设施位置',section:'reference',context:true,layerIds:['context-power'],visible:false},
  {id:'sitingSafety',label:'风险与障碍参考',section:'reference',context:true,layerIds:['context-safety'],visible:false},
]
export function contextMapLayers() {
  const color=['case',['==',['get','category'],'water'],'#56b7de',['match',['coalesce',['get','landuse'],''],...LANDUSE_GROUPS.filter(g=>g.values.length).flatMap(g=>[g.values,g.color]),'#a8b4c4']]
  const base={source:'siting-context',layout:{visibility:'none'}}
  return [
    {...base,id:'context-landuse-fill',type:'fill',filter:['in',['get','category'],['literal',['landuse','water']]],paint:{'fill-color':color,'fill-opacity':.22}},
    {...base,id:'context-landuse-outline',type:'line',filter:['in',['get','category'],['literal',['landuse','water']]],paint:{'line-color':color,'line-opacity':.7,'line-width':1}},
    ...[['parking','#0f766e',5],['entrance','#c2410c',5],['power','#1173df',6],['safety','#b45309',4]].map(([category,color,radius])=>({...base,id:'context-'+category,type:'circle',filter:['==',['get','category'],category],paint:{'circle-radius':radius,'circle-color':color,'circle-stroke-width':1.5,'circle-stroke-color':'#fff'}})),
  ]
}
export function contextLegends() {
  return {
    sitingLanduse:{items:[...LANDUSE_GROUPS.map(g=>({color:g.color,label:g.label})),{color:'#56b7de',label:'水域'}],note:'OSM 用途映射，不是法定用地或建设许可。'},
    sitingParking:{items:[{kind:'point',color:'#0f766e',label:'停车设施记录'},{kind:'point',color:'#c2410c',label:'已标注出入口'}],note:'高德与 OSM 记录；总泊位不代表可改造泊位，可能重复记录同一场地。'},
    sitingPower:{items:[{kind:'point',color:'#1173df',label:'变电站或变压器位置'}],note:'设备位置，不代表已知容量或可接入余量。'},
    sitingSafety:{items:[{kind:'point',color:'#b45309',label:'已标注风险点或障碍'}],note:'当前资料包含部分加油点和障碍物，覆盖不完整；不表示消防核查结果。'},
  }
}
