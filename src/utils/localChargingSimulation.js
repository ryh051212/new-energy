import { booleanPointInPolygon, distance, point } from '@turf/turf'
import { validCoordinates } from './stations.js'
import { informationState, isDemoField } from './stationInformation.js'
import { validateSandboxPoint } from './facilitySandbox.js'

export function validateAnalysisLocation(coordinates, boundary) {
  if (!validCoordinates(coordinates)) throw new Error('定位坐标无效')
  const borders = boundary?.type === 'FeatureCollection' ? boundary.features : boundary ? [boundary] : []
  if (!borders.some(border => booleanPointInPolygon(point(coordinates), border))) throw new Error('请在魏都区范围内选择定位')
  return [...coordinates]
}

export function withinAnalysisRadius(coordinates, center, radiusMeters) {
  return validCoordinates(coordinates) && validCoordinates(center)
    && distance(point(center), point(coordinates), { units: 'meters' }) <= radiusMeters + 1e-6
}

function stationDetails(feature, center) {
  const p = feature.properties || {}
  const piles = p.pileCount ?? p.totalCount
  const pileState = informationState(p, p.pileCount == null ? 'totalCount' : 'pileCount', piles).state
  const blocked = informationState(p, 'status').state === 'known' && ['closed', 'inactive', 'offline'].includes(p.status)
    || informationState(p, 'accessAllowed').state === 'known' && p.accessAllowed === false
    || pileState === 'known' && piles === 0
  const simulated = p.dataSource === 'sandbox' || p.isSynthetic === true
  const verifiedAccess = informationState(p, 'status').state === 'known' && ['active', 'open', 'operational', 'online'].includes(p.status)
    && informationState(p, 'accessAllowed').state === 'known' && p.accessAllowed === true
    && informationState(p, 'openingHours').state === 'known' && informationState(p, 'entranceDescription').state === 'known'
  return { feature, id: String(p.id), name: p.name || '未命名站点',
    distanceMeters: distance(point(center), feature, { units: 'meters' }),
    blocked, simulated, accessUnknown: !simulated && !blocked && !verifiedAccess,
    pileCount: Number.isInteger(piles) && piles >= 0 && pileState !== 'unknown' ? piles : null,
    pilesSimulated: isDemoField(p, 'pileCount', 'totalCount'),
    fast: p.chargeType === 'fast' && informationState(p, 'chargeType').state !== 'unknown' }
}

export function assessLocalCharging({ center, radiusMeters, stations }) {
  if (!validCoordinates(center)) throw new Error('请先在地图上选择定位')
  if (!Number.isFinite(radiusMeters) || radiusMeters < 100 || radiusMeters > 5000) throw new Error('周边半径需在 100～5000 米之间')
  const rows = stations.filter(feature => feature.geometry?.type === 'Point'
    && withinAnalysisRadius(feature.geometry.coordinates, center, radiusMeters))
    .map(feature => stationDetails(feature, center))
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id, 'zh-CN', { numeric: true }))
  const candidates = rows.filter(row => !row.blocked)
  return { rows, candidates, stationCount: candidates.length, excludedCount: rows.length - candidates.length,
    nearest: candidates[0] || null, nearestDistanceMeters: candidates[0]?.distanceMeters ?? null,
    fastCount: candidates.filter(row => row.fast).length,
    knownPiles: candidates.filter(row => row.pileCount !== null && !row.pilesSimulated).reduce((sum, row) => sum + row.pileCount, 0),
    simulatedPiles: candidates.filter(row => row.pileCount !== null && row.pilesSimulated).reduce((sum, row) => sum + row.pileCount, 0),
    unknownPileStations: candidates.filter(row => row.pileCount === null).length,
    accessUnknownStations: candidates.filter(row => row.accessUnknown).length }
}

export function runLocalChargingSimulation({ center, radiusMeters, stations, boundary, additions = [], removedIds = [] }) {
  validateAnalysisLocation(center, boundary)
  const before = assessLocalCharging({ center, radiusMeters, stations })
  const existing = new Map(stations.map(feature => [String(feature.properties.id), feature]))
  if (existing.size !== stations.length) throw new Error('站点编号重复，请刷新数据')
  const removed = new Set(removedIds.map(String))
  for (const id of removed) {
    const feature = existing.get(id)
    if (!feature) throw new Error('待移除的站点已变化，请重新选择')
    if (!withinAnalysisRadius(feature.geometry.coordinates, center, radiusMeters)) throw new Error('只能调整定位周边范围内的站点')
  }
  const ids = new Set(existing.keys())
  const applied = additions.map(feature => {
    validateSandboxPoint(feature.properties)
    validateAnalysisLocation(feature.geometry.coordinates, boundary)
    if (!withinAnalysisRadius(feature.geometry.coordinates, center, radiusMeters)) throw new Error('请在定位周边范围内添加点位')
    const id = String(feature.properties.id)
    if (ids.has(id)) throw new Error('模拟点位编号重复')
    ids.add(id)
    return { ...feature, properties: { ...feature.properties, totalCount: feature.properties.pileCount,
      dataSource: 'sandbox', isSynthetic: true, simulatedFields: ['pileCount', 'totalCount', 'powerKw', 'chargeType'] } }
  })
  const resultStations = [...stations.filter(feature => !removed.has(String(feature.properties.id))), ...applied]
  const after = assessLocalCharging({ center, radiusMeters, stations: resultStations })
  const distanceSavedMeters = before.nearest && after.nearest ? before.nearestDistanceMeters - after.nearestDistanceMeters : null
  const stationChange = after.stationCount - before.stationCount
  const closer = before.nearest === null && after.nearest !== null || distanceSavedMeters > 1
  const farther = before.nearest !== null && after.nearest === null || distanceSavedMeters < -1
  const improved = closer || stationChange > 0
  const declined = farther || stationChange < 0
  return { local: true, center: [...center], radiusMeters, before, after, stations: resultStations,
    distanceSavedMeters, stationChange, addedCount: applied.length, removedCount: removed.size,
    verdict: improved && declined ? 'tradeoff' : improved ? 'improved' : declined ? 'worse' : 'unchanged' }
}
