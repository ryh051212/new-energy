import { booleanPointInPolygon, point, pointToLineDistance, lineString, pointOnFeature } from '@turf/turf'
import { validCoordinates } from './stations.js'
import { facilityCandidates } from './facilityLayout.js'
import { compareChargingDemand } from './facilityDemand.js'
import { fixedSupplyComparison, buildFacilityComparison } from './facilityComparison.js'

const count = value => Number.isInteger(value) && value >= 0
const round3 = value => Math.sign(value) * Math.round(Math.abs(value) * 1000 + 1e-10) / 1000
const clone = value => JSON.parse(JSON.stringify(value))
const byId = (a, b) => String(a.properties.id).localeCompare(String(b.properties.id), 'zh-CN', { numeric: true })
const polygons = boundary => boundary?.type === 'FeatureCollection' ? boundary.features : boundary ? [boundary] : []

export function assignFacilityGrid(coordinates, features, boundary) {
  if (!validCoordinates(coordinates)) throw new Error('点位坐标无效')
  const location = point(coordinates)
  const borders = polygons(boundary)
  if (!borders.length || !borders.some(polygon => booleanPointInPolygon(location, polygon))) throw new Error('请在魏都区边界内添加点位')
  const covered = features.filter(feature => booleanPointInPolygon(location, feature)).sort(byId)
  if (covered.length) return covered[0]
  // 与 PostGIS 一致：区内边缘缺口最多接受 5 米近邻，共边优先选择最小网格 ID。
  const nearby = features.map(feature => {
    const rings = feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates.flat() : feature.geometry.coordinates
    return { feature, distance: Math.min(...rings.map(ring => pointToLineDistance(location, lineString(ring), { units: 'meters' }))) }
  }).filter(item => item.distance <= 5).sort((a, b) => a.distance - b.distance || byId(a.feature, b.feature))
  if (nearby.length) return nearby[0].feature
  throw new Error('这个位置没有可用网格，请在网格覆盖范围内选点')
}

export function validateSandboxPoint(properties) {
  if (!properties?.name?.trim() || properties.name.length > 60) throw new Error('点位名称请填写 1～60 个字符')
  if (!['fast', 'regular'].includes(properties.chargeType)) throw new Error('请选择充电分类')
  if (!Number.isInteger(properties.pileCount) || properties.pileCount < 1 || properties.pileCount > 1000) throw new Error('桩数请填写 1～1000 的整数')
  if (!Number.isFinite(properties.powerKw) || properties.powerKw <= 0 || properties.powerKw > 1000) throw new Error('单桩功率请填写大于 0、不超过 1000 的数值')
}

export function namedFacilityCandidates(features, demandPois = []) {
  return facilityCandidates(features).map(feature => {
    const places = demandPois.filter(poi => poi.geometry?.type === 'Point' && booleanPointInPolygon(poi, feature))
    return { ...feature, properties: { ...feature.properties,
      areaName: places.slice(0, 2).map(poi => poi.properties?.name).filter(Boolean).join('、') || `网格 #${feature.properties.id}`,
      placeCount: places.length } }
  })
}

export function facilityDataset({ features = [], stations = [], boundary }, scope = 'all') {
  if (scope === 'all') return { features, stations }
  const recorded = stations.filter(station => !station.properties.isSynthetic)
  if (!features.length || !boundary) return { features, stations: recorded }
  const grids = clone(features)
  const counts = new Map(grids.map(grid => [String(grid.properties.id), 0]))
  for (const station of recorded) {
    const grid = assignFacilityGrid(station.geometry.coordinates, features, boundary)
    const key = String(grid.properties.id)
    counts.set(key, counts.get(key) + 1)
  }
  grids.forEach(grid => { grid.properties.stationCount = counts.get(String(grid.properties.id)) })
  return { features: fixedSupplyComparison(grids, grids).before.features, stations: recorded }
}

export function suggestedSandboxPoints(features, boundary, demandPois = []) {
  return namedFacilityCandidates(features, demandPois).map(feature => {
    const coordinates = pointOnFeature(feature).geometry.coordinates
    const grid = assignFacilityGrid(coordinates, features, boundary)
    return point(coordinates, { id: 'suggestion-' + feature.properties.id, name: `${feature.properties.areaName}附近补点`.slice(0, 60),
      chargeType: 'fast', pileCount: 1, powerKw: 60, gridId: grid.properties.id, isSynthetic: true, coordSystem: 'WGS84' })
  })
}

const recordedPiles = stations => stations.every(feature => count(feature.properties.totalCount))
  ? stations.reduce((sum, feature) => sum + feature.properties.totalCount, 0) : null
function summary(features, stations, pileCount) {
  const occupied = features.filter(feature => feature.properties.stationCount > 0).length
  return { stationCount: stations.length, occupied, occupiedShare: occupied / features.length * 100,
    problemGrids: features.filter(feature => feature.properties.supplyDemandType === 'high-demand-low-supply').length,
    pileCount }
}

export function runFacilitySimulation({ features, stations, boundary, demandPois = [], additions = [], removedIds = [] }) {
  if (!features?.length || !Array.isArray(stations)) throw new Error('站点或网格数据尚未就绪')
  if (features.some(feature => !count(feature.properties?.stationCount)
      || typeof feature.properties.demandIndex !== 'number' || !Number.isFinite(feature.properties.demandIndex))) throw new Error('网格指标不完整，请刷新数据后运行')
  if (new Set(features.map(feature => String(feature.properties.id))).size !== features.length) throw new Error('网格编号重复，无法计算')
  if (features.reduce((sum, feature) => sum + feature.properties.stationCount, 0) !== stations.length) throw new Error('站点与网格统计不一致，请刷新数据')
  const existing = new Map(stations.map(feature => [String(feature.properties.id), feature]))
  const removed = [...new Set(removedIds.map(String))].map(id => {
    if (!existing.has(id)) throw new Error('待移除的站点已变化，请重新选择')
    return existing.get(id)
  })
  if (new Set(additions.map(feature => String(feature.properties.id))).size !== additions.length) throw new Error('新增点位编号重复')
  const resultFeatures = clone(features), gridMap = new Map(resultFeatures.map(feature => [String(feature.properties.id), feature]))
  for (const station of removed) {
    const grid = assignFacilityGrid(station.geometry.coordinates, features, boundary)
    const record = gridMap.get(String(grid.properties.id)).properties
    if (!record.stationCount) throw new Error('待移除站点与网格统计不一致')
    record.stationCount--
  }
  const applied = additions.map(feature => {
    validateSandboxPoint(feature.properties)
    if (existing.has(String(feature.properties.id))) throw new Error('模拟编号与原站点冲突')
    const grid = assignFacilityGrid(feature.geometry.coordinates, features, boundary)
    gridMap.get(String(grid.properties.id)).properties.stationCount++
    return { ...clone(feature), properties: { ...feature.properties, gridId: grid.properties.id,
      totalCount: feature.properties.pileCount, isSynthetic: true, dataSource: 'sandbox',
      simulatedFields: ['chargeType', 'totalCount', 'pileCount', 'powerKw'] } }
  })
  const supply = fixedSupplyComparison(features, resultFeatures)
  const removedSet = new Set(removedIds.map(String)), retained = stations.filter(feature => !removedSet.has(String(feature.properties.id)))
  const resultStations = [...clone(retained), ...applied]
  const beforePiles = recordedPiles(stations), afterPiles = recordedPiles(resultStations)
  const evaluation = compareChargingDemand({ features, beforeStations: stations, afterStations: resultStations, demandPois })
  return { grid: supply.after, stations: resultStations,
    evaluation, comparison: buildFacilityComparison(supply, evaluation),
    before: summary(supply.before.features, stations, beforePiles), after: summary(supply.after.features, resultStations, afterPiles),
    addedCount: additions.length, removedCount: removed.length,
    addedPiles: applied.reduce((sum, feature) => sum + feature.properties.pileCount, 0),
    addedPowerKw: round3(applied.reduce((sum, feature) => sum + feature.properties.pileCount * feature.properties.powerKw, 0)),
    containsDemoRecords: stations.some(feature => feature.properties.isSynthetic || feature.properties.simulatedFields?.length),
    affectedGridIds: [...new Set([...applied.map(feature => feature.properties.gridId), ...removed.map(feature => assignFacilityGrid(feature.geometry.coordinates, features, boundary).properties.id)])] }
}
