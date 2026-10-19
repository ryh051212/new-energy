import { booleanPointInPolygon, distance, pointOnFeature, point } from '@turf/turf'
import { validCoordinates } from './stations.js'
import { isDemoField, informationState } from './stationInformation.js'

export const SERVICE_RADIUS_METERS = 1000
// Gaussian 2SFCA distance decay; radius is this application's scenario assumption.
export function chargingDistanceWeight(meters, radius = SERVICE_RADIUS_METERS) {
  if (!Number.isFinite(meters) || meters < 0 || meters >= radius || radius <= 0) return 0
  const edge = Math.exp(-.5)
  return (Math.exp(-.5 * (meters / radius) ** 2) - edge) / (1 - edge)
}
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0
const round = value => Math.round(value * 10) / 10
const collection = features => ({ type: 'FeatureCollection', features })

// POI 仅代表需求的空间分布，不推算车辆数。每个网格的原需求指数分配给其 POI。
export function demandLocations(features, demandPois = []) {
  const buckets = new Map(features.map(feature => [String(feature.properties.id), []]))
  const ordered = [...features].sort((a, b) => String(a.properties.id).localeCompare(String(b.properties.id), 'zh-CN', { numeric: true }))
  for (const poi of demandPois) {
    if (poi.geometry?.type !== 'Point' || !validCoordinates(poi.geometry.coordinates)) continue
    const grid = ordered.find(feature => booleanPointInPolygon(poi, feature))
    if (grid) buckets.get(String(grid.properties.id)).push(poi)
  }
  let fallbackGrids = 0
  const locations = features.flatMap(feature => {
    const weight = feature.properties.demandIndex
    if (!positive(weight)) return []
    const pois = buckets.get(String(feature.properties.id))
    if (!pois.length) fallbackGrids++
    const positions = pois.length ? pois : [pointOnFeature(feature)]
    return positions.map(poi => ({ feature: poi, gridId: String(feature.properties.id), weight: weight / positions.length, fallback: !pois.length }))
  })
  return { locations, fallbackGrids }
}

export function stationConfiguration(station) {
  const p = station.properties || {}
  // 已明确不可运营/不可进场的站点排除；未知信息保留并计入资料不足提示。
  const blocked = (informationState(p, 'status').state === 'known' && ['closed', 'inactive', 'offline'].includes(p.status))
    || (informationState(p, 'accessAllowed').state === 'known' && p.accessAllowed === false)
  const pileCount = p.pileCount ?? p.totalCount
  const pilesState = informationState(p, p.pileCount == null ? 'totalCount' : 'pileCount', pileCount).state
  const capacity = Number.isInteger(pileCount) && pileCount >= 0 && positive(p.powerKw) && pilesState !== 'unknown'
    && informationState(p, 'powerKw').state !== 'unknown' ? pileCount * p.powerKw : null
  return { feature: station, blocked, capacity,
    simulated: isDemoField(p, 'pileCount', 'totalCount', 'powerKw'),
    accessUnknown: p.dataSource !== 'sandbox' && (informationState(p, 'openingHours').state !== 'known'
      || informationState(p, 'entranceDescription').state !== 'known') }
}

function assess(features, locations, configurations, referenceCapacity, capture = false, allocationLocations = locations) {
  const usable = configurations.filter(item => !item.blocked && item.capacity !== 0 && validCoordinates(item.feature.geometry?.coordinates))
  const access = locations.map(() => 0)
  const nearest = locations.map(() => Infinity)
  const secondNearest = locations.map(() => Infinity)
  const nearestStations = locations.map(() => null)
  const contributions = new Map()
  for (const station of usable) {
    const weights = locations.map((location, index) => {
      const meters = distance(location.feature, station.feature, { units: 'meters' })
      if (meters < nearest[index]) {
        secondNearest[index] = nearest[index]
        nearest[index] = meters
        nearestStations[index] = station.feature
      } else secondNearest[index] = Math.min(secondNearest[index], meters)
      return chargingDistanceWeight(meters)
    })
    const catchmentDemand = allocationLocations === locations ? weights.reduce((sum, weight, index) => sum + weight * locations[index].weight, 0)
      : allocationLocations.reduce((sum, location) => sum + chargingDistanceWeight(distance(location.feature, station.feature, { units: 'meters' })) * location.weight, 0)
    if (station.capacity === null || catchmentDemand <= 0) continue
    // 单站能力由可达需求共享；重复扎堆不会让已充足需求无限加分。
    const contribution = weights.map(weight => station.capacity * weight / catchmentDemand)
    for (let index = 0; index < locations.length; index++) access[index] += contribution[index]
    if (capture) contributions.set(station.feature, contribution)
  }
  const totalWeight = locations.reduce((sum, location) => sum + location.weight, 0)
  const scores = locations.map((location, index) => referenceCapacity > 0 ? Math.min(1, access[index] / referenceCapacity) * 100 : null)
  const covered = locations.reduce((sum, location, index) => sum + (nearest[index] <= SERVICE_RADIUS_METERS ? location.weight : 0), 0)
  const meanDistance = usable.length && totalWeight ? locations.reduce((sum, location, index) => sum + nearest[index] * location.weight, 0) / totalWeight : null
  const matchScore = totalWeight && referenceCapacity > 0 ? scores.reduce((sum, score, index) => sum + score * locations[index].weight, 0) / totalWeight : null
  const byGrid = new Map(features.map(feature => [String(feature.properties.id), { weight: 0, matched: 0, covered: 0 }]))
  locations.forEach((location, index) => {
    const item = byGrid.get(location.gridId)
    item.weight += location.weight
    item.matched += (scores[index] || 0) * location.weight
    item.covered += (nearest[index] <= SERVICE_RADIUS_METERS ? location.weight : 0)
  })
  const grid = collection(features.map(feature => {
    const item = byGrid.get(String(feature.properties.id))
    return { ...feature, properties: { ...feature.properties, serviceDemandWeight: item.weight,
      demandMatchScore: item.weight && referenceCapacity > 0 ? round(item.matched / item.weight) : null,
      demandReach: item.weight ? round(item.covered / item.weight * 100) : null } }
  }))
  return { demandReach: totalWeight ? round(covered / totalWeight * 100) : null,
    meanDistanceMeters: meanDistance === null ? null : round(meanDistance),
    matchScore: matchScore === null ? null : round(matchScore), grid,
    locationScores: scores, totalWeight, nearest, nearestStations,
    details: capture ? { usable, access, contributions, secondNearest } : null,
    unknownCapacityStations: usable.filter(station => station.capacity === null).length,
    simulatedCapacityStations: usable.filter(station => station.capacity !== null && station.simulated).length,
    accessUnknownStations: usable.filter(station => station.accessUnknown).length,
    excludedStations: configurations.filter(station => station.blocked).length }
}

// 固定其他站点和需求，逐站撤去供给；这里只衡量空间服务依赖，不推断经营效益。
function reviewStations(locations, assessment, referenceCapacity) {
  const { usable, access, contributions, secondNearest } = assessment.details
  return collection(usable.filter(station => station.feature.properties.dataSource !== 'sandbox').map(station => {
    const contribution = contributions.get(station.feature) || locations.map(() => 0)
    let lostScore = 0, lostReach = 0, affectedPlaces = 0
    const affected = []
    locations.forEach((location, index) => {
      const scoreLoss = referenceCapacity > 0 ? Math.max(0, assessment.locationScores[index]
        - Math.min(1, Math.max(0, access[index] - contribution[index]) / referenceCapacity) * 100) : null
      const soleCoverage = assessment.nearestStations[index] === station.feature
        && assessment.nearest[index] <= SERVICE_RADIUS_METERS && secondNearest[index] > SERVICE_RADIUS_METERS
      lostScore += (scoreLoss || 0) * location.weight
      if (soleCoverage) lostReach += location.weight
      if (!location.fallback && ((scoreLoss !== null && scoreLoss > .1) || soleCoverage)) {
        affectedPlaces++
        affected.push({ name: location.feature.properties?.name || '未命名地点', scoreLoss: scoreLoss === null ? null : round(scoreLoss), soleCoverage })
      }
    })
    const matchLoss = referenceCapacity > 0 && assessment.totalWeight ? lostScore / assessment.totalWeight : null
    const reachLoss = assessment.totalWeight ? lostReach / assessment.totalWeight * 100 : null
    const reviewStatus = station.capacity === null || matchLoss === null ? 'unknown'
      : matchLoss > .1 || lostReach > 0 ? 'dependent' : 'review'
    return { ...station.feature, properties: { ...station.feature.properties,
      reviewStatus, removalMatchLoss: matchLoss === null ? null : round(matchLoss),
      removalReachLoss: reachLoss === null ? null : round(reachLoss), affectedPlaces,
      affectedNames: affected.sort((a, b) => Number(b.soleCoverage) - Number(a.soleCoverage) || (b.scoreLoss || 0) - (a.scoreLoss || 0)).slice(0, 3).map(item => item.name).join('、'),
      capacitySimulated: station.simulated, accessUnknown: station.accessUnknown,
    } }
  }))
}

export function compareChargingDemand({ features, beforeStations, afterStations, demandPois = [], scope = null }) {
  const demand = demandLocations(features, demandPois)
  const locations = scope ? demand.locations.filter(location => distance(location.feature, point(scope.center), { units: 'meters' }) <= scope.radiusMeters + 1e-6) : demand.locations
  const fallbackGrids = new Set(locations.filter(location => location.fallback).map(location => location.gridId)).size
  const baseline = beforeStations.map(stationConfiguration), proposed = afterStations.map(stationConfiguration)
  const totalWeight = locations.reduce((sum, location) => sum + location.weight, 0)
  const baselineCapacity = baseline.reduce((sum, station) => sum + (!station.blocked && station.capacity !== null ? station.capacity : 0), 0)
  // 两个方案共用基准均值，新增/删除不能通过重新归一化改变评判尺子。
  // 基准能力完全未知时保持匹配度未知，不从新增配置杜撰原需求。
  const referenceWeight = demand.locations.reduce((sum, location) => sum + location.weight, 0)
  const referenceCapacity = referenceWeight ? baselineCapacity / referenceWeight : 0
  const before = assess(features, locations, baseline, referenceCapacity, false, demand.locations)
  const after = assess(features, locations, proposed, referenceCapacity, true, demand.locations)
  const stationReview = reviewStations(locations, after, referenceCapacity)
  delete before.details
  delete after.details
  const locationResults = collection(locations.map((location, index) => {
    const prior = before.locationScores[index], next = after.locationScores[index]
    const priorDistance = Number.isFinite(before.nearest[index]) ? before.nearest[index] : null
    const nextDistance = Number.isFinite(after.nearest[index]) ? after.nearest[index] : null
    const scoreChange = prior === null || next === null ? null : round(next - prior)
    const distanceChange = priorDistance === null || nextDistance === null ? null : round(priorDistance - nextDistance)
    const improves = scoreChange > 0 || distanceChange >= 1 || priorDistance === null && nextDistance !== null
    const declines = scoreChange < 0 || distanceChange <= -1 || priorDistance !== null && nextDistance === null
    const weak = nextDistance === null || nextDistance > SERVICE_RADIUS_METERS || next !== null && next < 50
    return { ...location.feature, properties: { ...location.feature.properties,
      id: location.feature.properties?.id ?? 'grid-' + location.gridId,
      name: location.feature.properties?.name || (location.fallback ? `网格 #${location.gridId} 代表点` : '未命名地点'), gridId: location.gridId,
      fallback: location.fallback, demandWeight: location.weight,
      beforeMatch: prior === null ? null : round(prior), afterMatch: next === null ? null : round(next),
      matchChange: scoreChange, beforeDistance: priorDistance === null ? null : round(priorDistance),
      afterDistance: nextDistance === null ? null : round(nextDistance), distanceSaved: distanceChange,
      beforeNearest: before.nearestStations[index]?.properties.name || null,
      afterNearest: after.nearestStations[index]?.properties.name || null,
      locationStatus: improves && declines ? 'tradeoff' : improves ? 'improved' : declines ? 'declined' : 'unchanged',
      weak, priority: weak ? location.weight * (next === null ? 100 : 100 - next) : 0,
    } }
  }))
  delete before.nearest; delete before.nearestStations
  delete after.nearest; delete after.nearestStations
  let gainedWeight = 0, lostWeight = 0
  locations.forEach((location, index) => {
    if (before.locationScores[index] === null || after.locationScores[index] === null) return
    const delta = after.locationScores[index] - before.locationScores[index]
    if (delta > 0.1) gainedWeight += location.weight
    else if (delta < -0.1) lostWeight += location.weight
  })
  const changes = [before.matchScore === null ? null : after.matchScore - before.matchScore,
    before.demandReach === null ? null : after.demandReach - before.demandReach,
    before.meanDistanceMeters === null ? (after.meanDistanceMeters === null ? 0 : 1)
      : after.meanDistanceMeters === null ? -1 : before.meanDistanceMeters - after.meanDistanceMeters].map(value => value === null ? null : round(value))
  const improves = changes.some(value => value !== null && value > 0)
  const worsens = changes.some(value => value !== null && value < 0)
  const verdict = !totalWeight ? 'insufficient' : (improves && (worsens || lostWeight > 0) || gainedWeight > 0 && lostWeight > 0)
    ? 'tradeoff' : improves ? 'improved' : worsens ? 'worse' : 'unchanged'
  return { before, after, verdict, locations: locationResults, stationReview, fallbackGrids, demandLocationCount: locations.length, serviceRadiusMeters: SERVICE_RADIUS_METERS,
    referenceCapacityKw: referenceCapacity || null, gainedDemandShare: totalWeight && referenceCapacity > 0 ? round(gainedWeight / totalWeight * 100) : null,
    lostDemandShare: totalWeight && referenceCapacity > 0 ? round(lostWeight / totalWeight * 100) : null }
}
