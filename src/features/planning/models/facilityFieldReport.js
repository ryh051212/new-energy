const headers = ['对象', '名称', '地址', '经度（WGS84）', '纬度（WGS84）', '网格', '评价',
  '原匹配度（分）', '方案匹配度（分）', '匹配变化（分）', '原最近站距离（直线米）', '方案最近站距离（直线米）',
  '原最近站', '方案最近站', '单站撤去匹配损失（分）', '单站撤去触达损失（百分点）', '受影响地点', '核查事项']
const statuses = { improved: '改善', declined: '下降', tradeoff: '有得有失', unchanged: '无变化' }
const stationStatuses = { dependent: '空间服务依赖', review: '调整复核线索', unknown: '能力资料不足' }
function cell(value) {
  if (value == null) return '""'
  const content = typeof value === 'string' && /^\s*[=+@-]/.test(value) ? "'" + value : String(value)
  return '"' + content.replaceAll('"', '""') + '"'
}

// 可带到现场的地点与站点清单；不输出虚拟站，也不将代表点当作真实小区。
export function facilityReviewCsv(result) {
  const scope = result?.dataScope === 'all' ? '评价包含虚拟演示站；' : result?.dataScope === 'recorded' ? '评价排除虚拟站；' : ''
  const capacityNote = result?.evaluation?.after?.simulatedCapacityStations ? '能力计算含演示参数；' : ''
  const places = (result?.evaluation?.locations.features || []).filter(feature => !feature.properties.fallback).map(feature => {
    const p = feature.properties
    return [p.category === 'residential' ? '小区' : p.category === 'commercial' ? '商业地点' : '需求地点', p.name, p.address,
      ...feature.geometry.coordinates, p.gridId, statuses[p.locationStatus] + (p.weak ? '；方案后仍需补强' : ''),
      p.beforeMatch, p.afterMatch, p.matchChange, p.beforeDistance, p.afterDistance, p.beforeNearest, p.afterNearest,
      null, null, null, scope + capacityNote + 'POI 与需求权重估算；核查真实需求、道路与入口、开放时间、排队及可用建设用地']
  })
  const stations = (result?.evaluation?.stationReview.features || []).filter(feature => !feature.properties.isSynthetic).map(feature => {
    const p = feature.properties
    return ['已有站点', p.name, p.address, ...feature.geometry.coordinates, null, stationStatuses[p.reviewStatus],
      null, null, null, null, null, null, null, p.removalMatchLoss, p.removalReachLoss, p.affectedNames,
      scope + (p.capacitySimulated ? '能力含演示参数；' : '') + '核实桩数功率、开放入口、利用率、排队与经营成本；逐站独立试算，不能直接判定淘汰']
  })
  const proposed = (result?.stations || []).filter(feature => feature.properties.dataSource === 'sandbox').map(feature => {
    const p = feature.properties
    return ['试算新增点', p.name, null, ...feature.geometry.coordinates, p.gridId, '未核验建设选址',
      null, null, null, null, null, null, null, null, null, null,
      scope + `试算配置 ${p.pileCount} 桩 × ${p.powerKw} kW；核查停车场入口、建设用地、配电与实际需求`]
  })
  return '\uFEFF' + [headers, ...places, ...stations, ...proposed].map(row => row.map(cell).join(',')).join('\r\n')
}
