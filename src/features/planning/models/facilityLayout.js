const validCount = value => Number.isInteger(value) && value >= 0
const hasGrid = feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type)
const gridId = feature => String(feature.properties.id)

export function facilityCandidates(features = [], limit = 3) {
  const seen = new Set()
  return features.filter(feature => {
    const p = feature?.properties
    if (!hasGrid(feature) || p?.id == null || seen.has(gridId(feature))) return false
    seen.add(gridId(feature))
    return p.supplyDemandType === 'high-demand-low-supply' && validCount(p.stationCount)
      && typeof p.demandIndex === 'number' && Number.isFinite(p.demandIndex) && p.demandIndex >= 0
  }).sort((a, b) => b.properties.demandIndex - a.properties.demandIndex
    || gridId(a).localeCompare(gridId(b), 'zh-CN', { numeric: true })).slice(0, limit)
}

// 仅比较“各选中网格新增 1 站”的数量情景，不推断服务半径、供需指数或建设可行性。
export function compareFacilityLayout(features = [], selectedIds = [], stationCount) {
  const selected = new Set(selectedIds.map(String))
  const additions = facilityCandidates(features).filter(feature => selected.has(gridId(feature)))
  const known = features.length > 0 && features.every(feature => validCount(feature.properties?.stationCount))
  const occupied = known ? features.filter(feature => feature.properties.stationCount > 0).length : null
  const count = validCount(stationCount) ? stationCount : known ? features.reduce((sum, feature) => sum + feature.properties.stationCount, 0) : null
  const newlyOccupied = additions.filter(feature => feature.properties.stationCount === 0).length
  const share = value => value === null || !features.length ? null : value / features.length * 100
  return { additions, addedCount: additions.length, newlyOccupied, gridCount: features.length,
    before: { stationCount: count, occupied, occupiedShare: share(occupied) },
    after: { stationCount: count === null ? null : count + additions.length,
      occupied: occupied === null ? null : occupied + newlyOccupied,
      occupiedShare: share(occupied === null ? null : occupied + newlyOccupied) },
    occupiedShareChange: known ? newlyOccupied / features.length * 100 : null }
}
