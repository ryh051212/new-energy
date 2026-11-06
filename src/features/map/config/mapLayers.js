import { FACILITY_MAP_LAYERS } from './facilityMapLayers.js'
import { SITING_CONTEXT_LAYERS,contextLegends } from './sitingContextLayers.js'

// 返回新对象，避免多个地图实例共享图层开关。
export function createMapLayerGroups() {
  return [
  { id:'boundary', label:'研究区边界', layerIds:['weidu-fill','weidu-outline'], visible:true },
  { id:'stations', label:'充电站点', layerIds:['stations-circle','stations-bolt'], visible:true },
  { id:'osmRoads', label:'OSM 道路', section:'reference', layerIds:['osm-roads-line'], visible:false },
  { id:'population', label:'模型人口分布（2025）', section:'reference', layerIds:['population-fill'], visible:false },
  ...SITING_CONTEXT_LAYERS.map(layer=>({...layer})),
  { id:'demandIndex', label:'潜在充电需求指数', layerIds:['demand-index-fill'], visible:false },
  { id:'mismatch', label:'供需失配指数', layerIds:['mismatch-fill'], visible:false },
  { id:'capacitySupply', label:'充电设施配置功率', layerIds:['pss-capacity-fill'], visible:false },
  ...FACILITY_MAP_LAYERS.map(layer => ({...layer})),
]
}

export function createMapLegends() {
  const layerLegends = {
  ...contextLegends(),
  population: {gradient:'linear-gradient(90deg,#f1eef6,#bdc9e1,#74a9cf,#0570b0)',range:['较低','较高'],note:'GHSL 2025预测人口的网格相对分布；未校准为统计人口，也不表示充电订单。'},
  osmRoads: {items:[{color:'#d97706',label:'主干及以上道路'},{color:'#3b82a0',label:'次干及集散道路'},{color:'#64748b',label:'支路、服务道路等'}],note:'OSM 道路快照；含周边道路用于网络衔接，通行与建设条件仍需核查。'},
  demandIndex: { items: [
    { color: '#3f6212', label: '很高（共同尺度 80 及以上）' },
    { color: '#84cc16', label: '较高（共同尺度 60～80）' },
    { color: '#bef264', label: '中等（共同尺度 40～60）' },
    { color: '#d9f99d', label: '较低（共同尺度 20～40）' },
    { color: '#f7fee7', label: '很低（共同尺度低于 20）' },
    { color: '#cbd5e1', label: '资料不足' },
  ],note:'地图与曲线共用固定尺度：100 为当前完整研究区全部时段、情景的共同峰值，不是需求满足率。区间含下限、不含上限；原始指数见计算依据。灰色表示资料不足，不是零需求。' },
  mismatch: {
    gradient: 'linear-gradient(90deg, #2166ac 0%, #67a9cf 30%, #f7f7f7 50%, #ef8a62 70%, #b2182b 100%)',
    range: ['站点相对较多', '数量与需求较接近', '需求相对较高'],
    note: '蓝色偏向站点数量多，红色偏向需求高；比较的是相对指数，不直接表示缺多少桩。',
  },
};

FACILITY_MAP_LAYERS.forEach(layer => {
  layerLegends[layer.id] = {items:[{kind:'point',color:layer.color,label:layer.label}],
    note:layer.category === 'parking' ? '高德采集记录；可用泊位、收费和公共开放情况待核查。' : '高德采集记录，尚未现场核验。'};
});
layerLegends.capacitySupply = {gradient:'linear-gradient(90deg,#eff6ff,#93c5fd,#2563eb,#172554)',range:['0 kW','10000 kW 及以上'],items:[{color:'#94a3b8',label:'有站点缺少桩数或功率资料'}],note:'网格内桩数 × 单桩功率的合计，单位 kW；含模拟参数时为情景配置能力。'};

  return layerLegends
}
