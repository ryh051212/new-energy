import { distance, pointOnFeature, voronoi, bbox, featureCollection, intersect, booleanPointInPolygon } from '@turf/turf'
import { stationConfiguration } from './facilityDemand.js'

export const MCDA_WEIGHTS = { fast: 30, regular: 30, parking: 20, road: 20 }
// Scenario starting values, not coefficients prescribed by a planning standard.
export const MCDA_FACTOR_WEIGHTS = {
  fast: { commercial: 32, road: 26, parking: 22, office: 20 },
  regular: { residential: 48, office: 32, parking: 20 },
}
export const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const weighted = terms => {
  const available = terms.filter(([value, weight]) => value != null && weight > 0)
  const total = available.reduce((sum, [, weight]) => sum + weight, 0)
  return total ? available.reduce((sum, [value, weight]) => sum + value * weight, 0) / total : null
}
const unit = value => numeric(value) == null ? null : Math.min(1, value)

export function planningScore(indicators, weights = MCDA_WEIGHTS, factorWeights = MCDA_FACTOR_WEIGHTS) {
  const combine = (keys, coefficients) => weighted(keys.map(key => [unit(indicators[key]), numeric(coefficients[key]) ?? 0]))
  const fast = combine(['commercial','road','parking','office'], {...MCDA_FACTOR_WEIGHTS.fast,...factorWeights?.fast})
  const regular = combine(['residential','office','parking'], {...MCDA_FACTOR_WEIGHTS.regular,...factorWeights?.regular})
  const score = weighted(Object.entries({fast,regular,parking:unit(indicators.parking),road:unit(indicators.road)})
    .map(([key,value]) => [value,numeric(weights[key]) ?? 0]))
  return { fast, regular, score: score == null ? null : score * 100 }
}

// Additional factors are explicitly supplied survey/scenario values, never fabricated POIs.
export function planningRows(features = [], stations = [], overrides = {}, weights = MCDA_WEIGHTS, demandPois = [], factorWeights = MCDA_FACTOR_WEIGHTS) {
  const usable = stations.filter(feature => !stationConfiguration(feature).blocked)
  const factors = features.map(feature => {
    const p = feature.properties, extra = overrides[String(p.id)] || {}
    return { feature, extra, office: numeric(extra.officeCount ?? p.officeCount), parking: numeric(extra.parkingCount ?? p.parkingCount),
      residential: unit(p.residentialNorm), commercial: unit(p.commercialNorm), road: unit(extra.roadIndex ?? p.roadIndex) }
  })
  const officeMax = Math.max(0, ...factors.map(row => row.office || 0)), parkingMax = Math.max(0, ...factors.map(row => row.parking || 0))
  return factors.map(row => {
    const { feature, extra } = row, location = pointOnFeature(feature)
    const office = row.office == null ? null : officeMax > 0 ? row.office / officeMax : 0
    const parking = row.parking == null ? null : parkingMax > 0 ? row.parking / parkingMax : 0
    const indicators = { residential:row.residential, commercial:row.commercial, office, parking, road:row.road }
    const { fast, regular, score } = planningScore(indicators,weights,factorWeights)
    const available = [row.residential, row.commercial, office, parking, row.road].filter(value => value != null).length
    const nearest = usable.map(station => ({feature:station,meters:distance(location,station,{units:'meters'})})).sort((a,b) => a.meters-b.meters)[0]
    const places = demandPois.filter(poi => poi.geometry?.type === 'Point' && poi.properties?.name && booleanPointInPolygon(poi,feature))
      .sort((a,b) => distance(location,a)-distance(location,b))
    const placeNames = [...new Set(places.map(poi => poi.properties.name))].slice(0,2)
    return { ...row, id: String(feature.properties.id), location, fast, regular, score, indicators,
      areaName:placeNames.length ? placeNames.join(' / ')+'周边' : `网格 #${feature.properties.id} · 地点待核查`,
      placeNames,address:places.find(poi => poi.properties.address)?.properties.address || '',nearestStation:nearest?.feature || null,
      factorCount: available, parkingSpaces: numeric(extra.parkingSpaces ?? feature.properties.parkingSpaces),
      availableKva: numeric(extra.availableKva ?? feature.properties.availableKva), nearestMeters: nearest?.meters ?? null }
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id, 'zh-CN', { numeric: true }))
}

export function screenPlanningRows(rows, { radius = 400, onlyProblems = true, requireParking = false, minimumSpaces = 15, requireGrid = false, requestedKw = 60, powerFactor = .9, minimumScore = 1 } = {}) {
  const pool = rows.filter(row => !onlyProblems || row.feature.properties.supplyDemandType === 'high-demand-low-supply')
  if (numeric(radius) == null || radius > 3000 || requireParking && (numeric(minimumSpaces) == null || !Number.isInteger(minimumSpaces)) || requireGrid && (numeric(requestedKw) == null || numeric(powerFactor) == null || powerFactor <= 0 || powerFactor > 1)) return {pool,spaced:[],parking:[],constrained:[],candidates:[]}
  const spaced = pool.filter(row => row.nearestMeters == null || row.nearestMeters >= radius)
  const parking = spaced.filter(row => !requireParking || row.parking != null && row.parking > 0 && row.parkingSpaces != null && row.parkingSpaces >= minimumSpaces)
  const constrained = parking.filter(row => !requireGrid || row.availableKva != null && row.availableKva * powerFactor >= requestedKw)
  const candidates = numeric(minimumScore) == null || minimumScore > 100 ? []
    : constrained.filter(row => numeric(row.score) != null && row.score >= minimumScore)
  return { pool, spaced, parking, constrained, candidates }
}

export function planningRankChanges(rows, baseline) {
  const prior = new Map(baseline.map((row,index) => [row.id,{score:row.score,rank:index+1}]))
  return rows.map((row,index) => {
    const original = prior.get(row.id)
    return {...row,rank:index+1,defaultRank:original?.rank ?? null,defaultScore:original?.score ?? null,
      scoreDelta:row.score != null && original?.score != null ? row.score-original.score : null,
      rankChange:row.score != null && original?.score != null ? original.rank-index-1 : null}
  })
}

export function spacedPlanningRows(rows, existingPoints = [], limit = 8, radius = 400) {
  const chosen = [], occupied = new Set(existingPoints.map(feature => String(feature.properties.planningGridId)))
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || numeric(radius) == null || radius > 3000) return chosen
  for (const row of rows) {
    if (chosen.length >= limit) break
    if (occupied.has(row.id)) continue
    if ([...existingPoints, ...chosen.map(item => item.location)].some(feature => distance(feature, row.location, { units: 'meters' }) < radius)) continue
    chosen.push(row)
  }
  return chosen
}

export function planningBlindSpots(demandPois = [], stations = [], radius = 400) {
  if (numeric(radius) == null) return []
  const usable = stations.filter(feature => !stationConfiguration(feature).blocked)
  return demandPois.flatMap(feature => {
    if (feature.geometry?.type !== 'Point') return []
    const nearest = usable.length ? Math.min(...usable.map(station => distance(feature,station,{units:'meters'}))) : null
    return nearest != null && nearest <= radius ? [] : [{...feature,properties:{...feature.properties,nearestStationMeters:nearest}}]
  })
}

export function planningVoronoi(stations = [], boundary) {
  const polygons = boundary?.type === 'FeatureCollection' ? boundary.features : boundary ? [boundary] : []
  if (!polygons.length) return featureCollection([])
  const seen = new Set(), unique = stations.filter(feature => {
    if (stationConfiguration(feature).blocked || feature.geometry?.type !== 'Point') return false
    const key = feature.geometry.coordinates.join(',')
    if (seen.has(key)) return false
    seen.add(key);return true
  })
  if (!unique.length) return featureCollection([])
  const cells = unique.length === 1 ? polygons.map(feature => ({...feature,properties:unique[0].properties}))
    : voronoi(featureCollection(unique),{bbox:bbox(featureCollection(polygons))}).features
  return featureCollection(cells.flatMap(cell => polygons.flatMap(border => {
    const clipped = intersect(featureCollection([cell,border]))
    return clipped ? [{...clipped,properties:{...cell.properties}}] : []
  })))
}

export function configurationTotals(stations = []) {
  const configurations = stations.map(stationConfiguration).filter(item => !item.blocked)
  const known = configurations.filter(item => item.capacity != null)
  return { stations: configurations.length, known: known.length, unknown: configurations.length - known.length,
    capacityKw: known.length ? known.reduce((sum, item) => sum + item.capacity, 0) : configurations.length ? null : 0,
    piles: configurations.every(item => numeric(item.feature.properties.pileCount ?? item.feature.properties.totalCount) != null)
      ? configurations.reduce((sum, item) => sum + (item.feature.properties.pileCount ?? item.feature.properties.totalCount), 0) : null,
    simulated: known.some(item => item.simulated || item.feature.properties.dataSource === 'sandbox') }
}

export function planningEconomics(points = [], options = {}) {
  const settings = { utilization: .2, sessionKwh: 24, fastUnitWan: 8, regularUnitWan: .5, siteWan: 10,
    marginYuan: .3, annualOpexWan: 2, ...options }
  const totals = configurationTotals(points)
  if (Object.values(settings).some(value => numeric(value) == null) || settings.utilization > 1 || settings.sessionKwh <= 0 || totals.capacityKw == null || totals.piles == null) return null
  const capexWan = points.reduce((sum, feature) => sum + (feature.properties.pileCount ?? feature.properties.totalCount) *
    (feature.properties.chargeType === 'fast' ? settings.fastUnitWan : settings.regularUnitWan) + settings.siteWan, 0)
  const dailyKwh = totals.capacityKw * 24 * settings.utilization
  const annualNetWan = dailyKwh * 365 * settings.marginYuan / 10000 - points.length * settings.annualOpexWan
  return { capexWan, dailyKwh, dailySessions: dailyKwh / settings.sessionKwh, annualNetWan,
    paybackYears: capexWan > 0 && annualNetWan > 0 ? capexWan / annualNetWan : null }
}

// One-hour steps. Battery starts empty: midday charging funds evening discharge.
export function planningLoadProfile(stations, settings = {}) {
  const options = { commercialShare: 45, officeShare: 25, residentialShare: 30, utilization: .65,
    transformerKva: null, baseLoadKw: 0, powerFactor: .9, warningRate: .8, solarKw: 0,
    batteryKwh: 200, batteryKw: 50, efficiency: .9, ...settings }
  const { capacityKw } = configurationTotals(stations)
  const required = ['commercialShare','officeShare','residentialShare','utilization','baseLoadKw','powerFactor','warningRate','solarKw','batteryKwh','batteryKw','efficiency']
  if (capacityKw == null || required.some(key => numeric(options[key]) == null) || options.utilization > 1 || options.powerFactor <= 0 || options.powerFactor > 1 || options.warningRate <= 0 || options.warningRate > 1 || options.efficiency <= 0 || options.efficiency > 1) return null
  const shares = [options.commercialShare, options.officeShare, options.residentialShare]
  const shareTotal = shares.reduce((sum, value) => sum + value, 0)
  if (!shareTotal) return null
  const transformerKw = numeric(options.transformerKva) > 0 ? options.transformerKva * options.powerFactor : null
  const efficiency = Math.sqrt(options.efficiency)
  let energy = 0
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const nightDistance = Math.min(Math.abs(hour - 22), 24 - Math.abs(hour - 22))
    const shapes = [Math.min(1, .82 * Math.exp(-((hour - 12.5) ** 2) / 7.5) + .92 * Math.exp(-((hour - 18.5) ** 2) / 5.5)),
      .88 * Math.exp(-((hour - 11.5) ** 2) / 14), .95 * Math.exp(-(nightDistance ** 2) / 14)]
    const sectors = shares.map((share, index) => capacityKw * options.utilization * share / shareTotal * shapes[index])
    const chargingKw = sectors.reduce((sum, value) => sum + value, 0)
    const solarKw = options.solarKw * Math.max(0, Math.sin((hour - 6) / 12 * Math.PI)) * (hour <= 18 ? 1 : 0)
    const beforeKw = options.baseLoadKw + chargingKw
    const netKw = Math.max(0, beforeKw - solarKw)
    let batteryChargeKw = 0, batteryDischargeKw = 0
    if (hour >= 11 && hour <= 15) {
      const room = transformerKw == null ? Infinity : Math.max(0, transformerKw * options.warningRate - netKw)
      batteryChargeKw = Math.min(options.batteryKw, Math.max(0, options.batteryKwh - energy) / efficiency, room)
      energy += batteryChargeKw * efficiency
    } else if (hour >= 18 && hour <= 21) {
      batteryDischargeKw = Math.min(options.batteryKw, energy * efficiency, netKw)
      energy -= batteryDischargeKw / efficiency
    }
    const afterKw = netKw + batteryChargeKw - batteryDischargeKw
    return { hour, sectors, chargingKw, solarKw, beforeKw, afterKw, batteryChargeKw, batteryDischargeKw,
      storedKwh: Math.max(0, energy), loadRate: transformerKw == null ? null : afterKw / transformerKw * 100 }
  })
  const beforePeak = Math.max(...hours.map(row => row.beforeKw)), afterPeak = Math.max(...hours.map(row => row.afterKw))
  return { hours, capacityKw, transformerKw, beforePeak, afterPeak, peakReductionKw: beforePeak - afterPeak,
    overloadHours: transformerKw == null ? null : hours.filter(row => row.afterKw > transformerKw * options.warningRate).length,
    requiredStorageKwh: transformerKw == null ? null : hours.reduce((sum, row) => sum + Math.max(0, row.beforeKw - row.solarKw - transformerKw * options.warningRate), 0) / efficiency,
    meanChargingKw: mean(hours.map(row => row.chargingKw)) }
}

export function downloadPlanningCsv(filename, columns, rows) {
  const cell = value => '"' + String(value ?? '').replaceAll('"', '""').replace(/^[=+\-@\t\r]/, "'$&") + '"'
  const csv = '\uFEFF' + [columns, ...rows].map(row => row.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
