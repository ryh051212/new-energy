import { point, distance } from '@turf/turf'
import { demandLocations, stationConfiguration, chargingDistanceWeight, SERVICE_RADIUS_METERS } from './facilityDemand.js'
import { withinAnalysisRadius } from './localChargingSimulation.js'
import { assignFacilityGrid } from './facilitySandbox.js'
import { validCoordinates } from './stations.js'

const rounded = value => value == null ? null : Math.round(value * 10) / 10
const score = (access, reference) => reference > 0 ? Math.min(1, access / reference) * 100 : null
const atDistance = (a, b) => distance(a, b, { units: 'meters' })

function model(locations, stations) {
  const supply = stations.map(stationConfiguration).filter(station => !station.blocked && station.capacity !== 0 && validCoordinates(station.feature.geometry?.coordinates))
  const contributions = supply.map(station => {
    const weights = locations.map(location => chargingDistanceWeight(atDistance(location.feature, station.feature)))
    const demand = weights.reduce((sum, weight, index) => sum + weight * locations[index].weight, 0)
    return { ...station, demand, values: weights.map(weight => station.capacity != null && demand > 0 ? station.capacity * weight / demand : 0) }
  })
  return { supply: contributions, access: locations.map((_, index) => contributions.reduce((sum, item) => sum + item.values[index], 0)) }
}

export function weightedAccessibilityGini(values, weights) {
  const rows = values.map((value, index) => ({ value, weight: weights[index] })).filter(row => Number.isFinite(row.value) && row.weight > 0).sort((a, b) => a.value - b.value)
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0)
  const totalAccess = rows.reduce((sum, row) => sum + row.value * row.weight, 0)
  if (!totalWeight || !totalAccess) return null
  let prefixWeight = 0, prefixAccess = 0, numerator = 0
  for (const row of rows) {
    numerator += row.weight * (row.value * prefixWeight - prefixAccess)
    prefixWeight += row.weight; prefixAccess += row.weight * row.value
  }
  return Math.min(1, Math.max(0, numerator / (totalWeight * totalAccess)))
}

export function weightedAccessibilityLorenz(values, weights) {
  const rows = values.map((value,index) => ({ value, weight: weights[index] })).filter(row => Number.isFinite(row.value) && row.value >= 0 && row.weight > 0).sort((a,b) => a.value-b.value)
  const totalWeight = rows.reduce((sum,row) => sum+row.weight,0), totalAccess = rows.reduce((sum,row) => sum+row.value*row.weight,0)
  if (!totalWeight || !totalAccess) return []
  let weight = 0, access = 0
  return [[0,0], ...rows.map(row => { weight += row.weight; access += row.value*row.weight; return [weight/totalWeight,access/totalAccess] })]
}

function summarize(locations, access, indices, reference) {
  const rows = indices.map(index => ({ access: access[index], weight: locations[index].weight, score: score(access[index], reference) }))
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0)
  if (!totalWeight || !reference) return { weakDemandShare: null, underservedAccess: null, inequality: null, lorenz: [] }
  const weak = rows.filter(row => row.score < 50).reduce((sum, row) => sum + row.weight, 0)
  let budget = totalWeight * .25, underserved = 0
  for (const row of [...rows].sort((a, b) => a.score - b.score)) {
    const taken = Math.min(budget, row.weight)
    underserved += taken * row.score; budget -= taken
    if (budget <= 1e-12) break
  }
  return { weakDemandShare: rounded(weak / totalWeight * 100), underservedAccess: rounded(underserved / (totalWeight * .25)),
    inequality: weightedAccessibilityGini(rows.map(row => row.access), rows.map(row => row.weight)),
    lorenz: weightedAccessibilityLorenz(rows.map(row => row.access), rows.map(row => row.weight)) }
}

function probe(model, coordinates, reference) {
  const location = point(coordinates)
  const nearby = model.supply.filter(item => atDistance(item.feature, location) < SERVICE_RADIUS_METERS)
  const contributions = nearby.filter(item => item.capacity != null && item.demand > 0).map(item => ({
    item, value: item.capacity * chargingDistanceWeight(atDistance(item.feature, location)) / item.demand }))
    .sort((a, b) => b.value - a.value)
  const access = contributions.reduce((sum, row) => sum + row.value, 0)
  const strongest = contributions[0]
  const unknown = nearby.filter(item => item.capacity == null).length
  const unmodeled = nearby.filter(item => item.capacity != null && item.demand <= 0).length
  const pointReference = !contributions.length && unmodeled ? 0 : reference
  return { serviceIndex: rounded(score(access, pointReference)), backupIndex: rounded(score(access - (strongest?.value || 0), pointReference)),
    rawAccess: access,
    mainStation: strongest?.item.feature.properties.name || null, mainStationId: strongest?.item.feature.properties.id ?? null,
    dependenceShare: access > 0 ? rounded((strongest?.value || 0) / access * 100) : null,
    unknownCapacityStations: unknown, simulated: contributions.some(row => row.item.simulated),
    uncoveredByDemandModel: unmodeled,
    sources: contributions.map(row => ({ feature: row.item.feature, share: access > 0 ? rounded(row.value / access * 100) : 0 })) }
}

export function diagnosticVerdict(before, after, local = false) {
  const fields = local ? [['serviceIndex', 1], ['backupIndex', 1]]
    : [['weakDemandShare', -1], ['underservedAccess', 1], ['inequality', -100]]
  const deltas = fields.filter(([key]) => before?.[key] != null && after?.[key] != null).map(([key, sign]) => (after[key] - before[key]) * sign)
  if (!deltas.length) return 'insufficient'
  const up = deltas.some(delta => delta > .099), down = deltas.some(delta => delta < -.099)
  return up && down ? 'tradeoff' : up ? 'improved' : down ? 'worse' : 'unchanged'
}

function setup({ features, stations, demandPois = [] }) {
  const { locations } = demandLocations(features, demandPois)
  const baseline = model(locations, stations)
  const weight = locations.reduce((sum, location) => sum + location.weight, 0)
  const capacity = baseline.supply.reduce((sum, item) => sum + (item.capacity || 0), 0)
  return { locations, baseline, reference: weight > 0 ? capacity / weight : 0 }
}

export function pointChargingDiagnostics(input) {
  const { center } = input
  if (!center) return null
  const { baseline, reference } = setup(input)
  return probe(baseline, center, reference)
}

export function analyzeFacilityDiagnostics({ features, beforeStations, afterStations, demandPois = [], center = null, radiusMeters = 1000, boundary }) {
  const { locations, baseline, reference } = setup({ features, stations: beforeStations, demandPois })
  const proposed = model(locations, afterStations)
  const indices = locations.map((_, index) => index).filter(index => !center || withinAnalysisRadius(locations[index].feature.geometry.coordinates, center, radiusMeters))
  const before = summarize(locations, baseline.access, indices, reference)
  const after = summarize(locations, proposed.access, indices, reference)
  const pointBefore = center ? probe(baseline, center, reference) : null
  const pointAfter = center ? probe(proposed, center, reference) : null
  const totalWeight = indices.reduce((sum, index) => sum + locations[index].weight, 0)
  const improvements = [], seen = new Set()
  if (reference > 0 && totalWeight > 0) for (const index of indices) {
    const location = locations[index], coordinates = location.feature.geometry.coordinates
    const key = coordinates.map(value => value.toFixed(7)).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    try { assignFacilityGrid(coordinates, features, boundary) } catch { continue }
    const weights = locations.map(target => chargingDistanceWeight(atDistance(location.feature, target.feature)))
    const demand = weights.reduce((sum, weight, target) => sum + weight * locations[target].weight, 0)
    if (!demand) continue
    const gain = indices.reduce((sum, target) => sum + locations[target].weight * (score(proposed.access[target] + 60 * weights[target] / demand, reference) - score(proposed.access[target], reference)), 0) / totalWeight
    if (gain <= .05) continue
    const pointGain = center && pointAfter.serviceIndex != null ? rounded(score(pointAfter.rawAccess + 60 * chargingDistanceWeight(atDistance(point(center), location.feature)) / demand, reference) - score(pointAfter.rawAccess, reference)) : null
    improvements.push({ feature: location.feature, estimatedGain: rounded(gain), pointGain, fallback: location.fallback,
      name: location.feature.properties.name || (location.fallback ? `网格 #${location.gridId} 估计点` : '未命名需求地点') })
  }
  const candidates = improvements.sort((a, b) => b.estimatedGain - a.estimatedGain || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 3)
  // 每次只撤去一站；固定其他配置和完整需求竞争，不把低损失直接解释为可淘汰。
  const removals = reference > 0 && totalWeight > 0 ? proposed.supply.filter(item => item.capacity != null && item.demand > 0
    && item.feature.properties.dataSource !== 'sandbox' && (!center || withinAnalysisRadius(item.feature.geometry.coordinates, center, radiusMeters)))
    .map(item => {
      const loss = indices.reduce((sum, index) => sum + locations[index].weight * (score(proposed.access[index], reference)
        - score(Math.max(0, proposed.access[index] - item.values[index]), reference)), 0) / totalWeight
      const without = summarize(locations, proposed.access.map((value, index) => Math.max(0, value - item.values[index])), indices, reference)
      const withoutPoint = center ? probe({ supply: proposed.supply.filter(other => other !== item) }, center, reference) : null
      return { feature: item.feature, estimatedLoss: rounded(loss), weakDemandIncrease: rounded(without.weakDemandShare - after.weakDemandShare),
        pointLoss: pointAfter?.serviceIndex != null && withoutPoint?.serviceIndex != null ? rounded(score(pointAfter.rawAccess, reference) - score(withoutPoint.rawAccess, reference)) : null,
        underservedLoss: rounded(after.underservedAccess - without.underservedAccess) }
    }).sort((a, b) => (center ? (a.pointLoss ?? Infinity) - (b.pointLoss ?? Infinity) : 0) || a.estimatedLoss - b.estimatedLoss || a.underservedLoss - b.underservedLoss).slice(0, 3) : []
  const excludedWeight = indices.filter(index => locations[index].fallback).reduce((sum, index) => sum + locations[index].weight, 0)
  return { before, after, pointBefore, pointAfter, candidates, removals, referenceCapacity: reference || null,
    layoutVerdict: diagnosticVerdict(before, after), pointVerdict: center ? diagnosticVerdict(pointBefore, pointAfter, true) : null,
    fallbackDemandShare: totalWeight ? rounded(excludedWeight / totalWeight * 100) : null,
    knownCapacityShare: proposed.supply.length ? rounded(proposed.supply.filter(item => item.capacity != null).length / proposed.supply.length * 100) : null,
    partialCapacity: [...baseline.supply, ...proposed.supply].some(item => item.capacity == null),
    simulatedCapacity: [...baseline.supply, ...proposed.supply].some(item => item.capacity != null && item.simulated),
    method: 'Gaussian 2SFCA', serviceRadiusMeters: SERVICE_RADIUS_METERS }
}
