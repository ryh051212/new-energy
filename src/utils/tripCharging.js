// 出行估算：未知值保持 null，直线距离不能用于确认可达，车辆参数由车主填写。
import { chargingCompatibility } from './stationInformation.js'
export const TRIP_INTENTS = [
  { value: 'urgent', label: '快速补能', description: '先评估到站电量，再比较行驶、等待与补电总时间' },
  { value: 'destination', label: '目的地补能', description: '围绕本次目的地，比较步行距离和活动期间能否补足目标电量' },
  { value: 'economy', label: '成本优先', description: '比较目标补电、停车与额外绕行的预计成本' },
]
export const DEFAULT_TRIP = { currentSoc: null, targetSoc: 80, batteryKwh: null, consumptionKwh: null,
  maxChargeKw: null, reserveSoc: 10, queueMinutes: null, stayMinutes: 60, shoppingMinutes: 60, maxWalkMeters: 800,
  travelPricePerKwh: null, powerFactor: 0.8, efficiency: 0.9, destination: null, origin: null, chargingRequirement: null }
export const isDestinationIntent = intent => ['destination', 'shopping'].includes(intent)
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const number = value => !['number','string'].includes(typeof value) || (typeof value === 'string' && !value.trim())
  ? null : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
const sum = (...values) => values.every(valid) ? values.reduce((a, b) => a + b, 0) : null
const round = value => valid(value) ? Math.round(value * 100) / 100 : null
export function normalizeTripContext(input = {}) {
  const trip = { ...DEFAULT_TRIP, ...input, stayMinutes: Object.hasOwn(input, 'stayMinutes') ? input.stayMinutes
    : Object.hasOwn(input, 'shoppingMinutes') ? input.shoppingMinutes : DEFAULT_TRIP.stayMinutes }
  for (const key of Object.keys(DEFAULT_TRIP).filter(key => !['origin', 'destination', 'chargingRequirement'].includes(key))) trip[key] = number(trip[key])
  trip.chargingRequirement = ['DC', 'AC', 'either'].includes(trip.chargingRequirement) ? trip.chargingRequirement : null
  for (const key of ['currentSoc', 'targetSoc', 'reserveSoc']) if (trip[key] > 100) trip[key] = null
  for (const key of ['batteryKwh', 'consumptionKwh', 'maxChargeKw', 'efficiency', 'powerFactor']) if (!trip[key]) trip[key] = null
  for (const key of ['efficiency', 'powerFactor']) if (trip[key] > 1) trip[key] = null
  const bounds = { batteryKwh: [1, 300], consumptionKwh: [1, 100], maxChargeKw: [1, 1000], queueMinutes: [0, 1440],
    stayMinutes: [0, 1440], shoppingMinutes: [0, 1440], maxWalkMeters: [0, 10000], travelPricePerKwh: [0, 20], powerFactor: [.01, 1], efficiency: [.01, 1] }
  for (const [key, [min, max]] of Object.entries(bounds)) if (trip[key] !== null && (trip[key] < min || trip[key] > max)) trip[key] = null
  for (const key of ['origin', 'destination']) if (!Array.isArray(trip[key]) || trip[key].length !== 2
    || !trip[key].every((value, i) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= (i ? 90 : 180))) trip[key] = null
  trip.shoppingMinutes = trip.stayMinutes
  return trip
}
export function tripInputIssues(trip, intent) {
  const labels = { currentSoc: '当前电量', targetSoc: '目标电量', reserveSoc: '到站保留电量', batteryKwh: '电池容量', consumptionKwh: '百公里电耗', maxChargeKw: '车辆充电功率上限' }
  const issues = Object.entries(labels).filter(([key]) => !valid(trip[key]) || (!key.endsWith('Soc') && !trip[key])).map(([, label]) => label)
  if (isDestinationIntent(intent) && !trip.destination) issues.push('本次目的地')
  if (isDestinationIntent(intent) && !valid(trip.stayMinutes)) issues.push('预计活动时长')
  if (intent === 'economy' && !trip.destination) issues.push('本次出行终点')
  return issues
}
export function geoDistanceMeters(a, b) {
  const r = Math.PI / 180, lat1 = a[1] * r, lat2 = b[1] * r
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((b[0] - a[0]) * r / 2) ** 2
  return 12742017.6 * Math.asin(Math.sqrt(Math.min(1, h)))
}
export function evaluateTripStation(feature, intent, input) {
  const c = normalizeTripContext(input), p = feature.properties || {}, missing = []
  const driving = p.distanceType === 'driving' && p.distanceSource === 'amap_driving' && p.isFallback === false && valid(p.drivingDistanceMeters)
  const meters = driving ? p.drivingDistanceMeters : p.straightDistanceMeters ?? p.distanceMeters
  const vehicleKnown = valid(c.currentSoc) && c.batteryKwh > 0 && c.consumptionKwh > 0 && valid(c.reserveSoc)
  const usedEnergy = vehicleKnown && valid(meters) ? meters / 100000 * c.consumptionKwh : null
  const arrivalSoc = valid(usedEnergy) ? c.currentSoc - usedEnergy / c.batteryKwh * 100 : null
  const unreachable = arrivalSoc !== null && arrivalSoc < c.reserveSoc
  const safety = unreachable ? 'unreachable' : arrivalSoc !== null && driving ? 'reachable' : 'unknown'
  if (!vehicleKnown) missing.push('车辆电量与电耗')
  if (!driving) missing.push('实际驾车路线')
  const energy = arrivalSoc !== null && valid(c.targetSoc) ? Math.max(0, (c.targetSoc - arrivalSoc) / 100 * c.batteryKwh) : null
  const effectivePower = c.maxChargeKw > 0 && valid(p.powerKw) && p.powerKw > 0 && c.powerFactor > 0
    ? Math.min(c.maxChargeKw, p.powerKw) * c.powerFactor : null
  const chargeMinutes = energy === 0 ? 0 : valid(energy) && effectivePower > 0 && c.efficiency > 0 ? energy / c.efficiency / effectivePower * 60 : null
  if (chargeMinutes === null) missing.push('车辆或站点充电功率')
  const queueMinutes = valid(p.estimatedWaitMinutes) ? p.estimatedWaitMinutes : c.queueMinutes
  if (queueMinutes === null) missing.push('排队时间')
  const driveMinutes = driving && valid(p.drivingDurationSeconds) ? p.drivingDurationSeconds / 60 : null
  if (driving && driveMinutes === null) missing.push('驾车时间')
  const walkMeters = c.destination && feature.geometry?.coordinates ? geoDistanceMeters(feature.geometry.coordinates, c.destination) : null
  const walkingMinutes = valid(walkMeters) ? walkMeters / 80 * 2 : null
  const windowMinutes = valid(walkingMinutes) && valid(queueMinutes) && valid(c.stayMinutes)
    ? c.stayMinutes + walkingMinutes : null
  const shoppingEnergy = valid(windowMinutes) && effectivePower > 0 && c.efficiency > 0 ? effectivePower * windowMinutes / 60 * c.efficiency : null
  const shoppingChargedEnergy = valid(energy) && valid(shoppingEnergy) ? Math.min(energy, shoppingEnergy) : null
  const projectedSoc = arrivalSoc !== null && valid(shoppingChargedEnergy) ? Math.min(100, arrivalSoc + shoppingChargedEnergy / c.batteryKwh * 100) : null
  const meetsTarget = valid(energy) && valid(shoppingEnergy) ? shoppingEnergy >= energy : null
  if (isDestinationIntent(intent) && !c.destination) missing.push('目的地位置')
  if (isDestinationIntent(intent) && windowMinutes === null && queueMinutes !== null) missing.push('活动时长或步行距离')
  const parkedMinutes = isDestinationIntent(intent) ? sum(queueMinutes, windowMinutes) : sum(queueMinutes, chargeMinutes)
  const billedEnergy = isDestinationIntent(intent) ? shoppingChargedEnergy : energy
  const gridEnergy = valid(billedEnergy) && c.efficiency > 0 ? billedEnergy / c.efficiency : null
  const electricityCost = valid(gridEnergy) && valid(p.electricityPrice) ? gridEnergy * p.electricityPrice : null
  const serviceCost = valid(gridEnergy) && valid(p.servicePrice) ? gridEnergy * p.servicePrice : null
  const chargeCost = valid(gridEnergy) && valid(p.pricePerKwh) ? gridEnergy * p.pricePerKwh : sum(electricityCost, serviceCost)
  const parkingCost = p.parkingFee === 0 ? 0 : valid(parkedMinutes) && valid(p.parkingFee) ? parkedMinutes / 60 * p.parkingFee : null
  // 完整绕行 = 起点→站点→终点 - 起点→终点；三段都必须有道路数据。
  const route = p.tripRoute || {}
  const extraKm = driving && valid(route.onwardDistanceMeters) && valid(route.directDistanceMeters)
    ? Math.max(0, (p.drivingDistanceMeters + route.onwardDistanceMeters - route.directDistanceMeters) / 1000) : null
  // 去站能耗已经补进离站目标电量，不能再次收费，只计未包含的额外能耗。
  const remainingExtraKm = valid(extraKm) ? Math.max(0, extraKm - p.drivingDistanceMeters / 1000) : null
  const extraEnergyCost = remainingExtraKm === 0 ? 0 : valid(remainingExtraKm) && c.consumptionKwh > 0 && valid(c.travelPricePerKwh)
    ? remainingExtraKm / 100 * c.consumptionKwh * c.travelPricePerKwh : null
  const extraTolls = [p.drivingTollsYuan, route.onwardTollsYuan, route.directTollsYuan].every(valid)
    ? Math.max(0, p.drivingTollsYuan + route.onwardTollsYuan - route.directTollsYuan) : null
  const detourCost = sum(extraEnergyCost, extraTolls)
  if (intent === 'economy' && detourCost === null) missing.push('终点路线或绕行费用')
  if (intent === 'economy' && chargeCost === null) missing.push('充电费用')
  if (intent === 'economy' && parkingCost === null) missing.push('停车计费或停留时间')
  const totalCost = sum(chargeCost, parkingCost, detourCost)
  const totalMinutes = isDestinationIntent(intent) ? sum(driveMinutes, parkedMinutes) : sum(driveMinutes, queueMinutes, chargeMinutes)
  const knownMinutes = [driveMinutes, queueMinutes, chargeMinutes].filter(valid).reduce((a, b) => a + b, 0)
  const operational = !['maintenance', 'offline', 'retired'].includes(p.status) && !chargingCompatibility(p, c).prohibited
  const walkTooFar = isDestinationIntent(intent) && valid(walkMeters) && valid(c.maxWalkMeters) && walkMeters > c.maxWalkMeters
  const excluded = unreachable || !operational || walkTooFar || (p.powerKw === 0 && energy > 0)
  return { intent, excluded, safety, arrivalSoc: arrivalSoc === null ? null : Math.round(arrivalSoc * 10) / 10,
    chargeEnergyKwh: round(energy), chargeMinutes: round(chargeMinutes), driveMinutes: round(driveMinutes), queueMinutes,
    queueSource: valid(p.estimatedWaitMinutes) ? 'station' : queueMinutes !== null ? 'user' : 'unknown',
    totalMinutes: round(totalMinutes), knownMinutes: round(knownMinutes), walkMeters: round(walkMeters), shoppingChargedEnergyKwh: round(shoppingChargedEnergy),
    stayChargedEnergyKwh: round(shoppingChargedEnergy), activityMinutes: c.stayMinutes, parkingMinutes: round(parkedMinutes), walkingSource: 'straight_estimate',
    walkingMinutes: round(walkingMinutes), windowMinutes: round(windowMinutes), projectedSoc: round(projectedSoc), meetsTarget,
    electricityCost: round(electricityCost), serviceCost: round(serviceCost), chargeCost: round(chargeCost), parkingCost: round(parkingCost),
    extraKm: round(extraKm), extraEnergyCost: round(extraEnergyCost), extraTolls: round(extraTolls), detourCost: round(detourCost), totalCost: round(totalCost),
    knownCost: round([chargeCost, parkingCost, detourCost].filter(valid).reduce((a, b) => a + b, 0)), missing: [...new Set(missing)],
    isEstimate: true, hasDemoInputs: !!p.isSynthetic || (p.simulatedFields || []).some(key => ['powerKw', 'electricityPrice', 'servicePrice', 'parkingFee'].includes(key)),
  }
}
export function rankTripStations(features, intent, context) {
  const ranked = features.map(feature => ({ ...feature, properties: { ...feature.properties,
    tripFit: evaluateTripStation(feature, intent, context) } })).filter(feature => !feature.properties.tripFit.excluded)
  const value = x => valid(x) ? x : Infinity
  ranked.sort((a, b) => {
    const x = a.properties.tripFit, y = b.properties.tripFit
    const safety = Number(x.safety !== 'reachable') - Number(y.safety !== 'reachable')
    if (safety) return safety
    if (isDestinationIntent(intent)) {
      const fit = result => result.meetsTarget === true ? 0 : result.meetsTarget === null ? 1 : 2
      return fit(x) - fit(y) || value(x.walkMeters) - value(y.walkMeters) || value(x.chargeMinutes) - value(y.chargeMinutes)
        || value(a.properties.distanceMeters) - value(b.properties.distanceMeters)
    }
    if (intent === 'economy') return Number(x.totalCost === null) - Number(y.totalCost === null)
      || value(x.totalCost) - value(y.totalCost) || x.missing.length - y.missing.length || x.knownCost - y.knownCost || value(a.properties.distanceMeters) - value(b.properties.distanceMeters)
    return Number(x.totalMinutes === null) - Number(y.totalMinutes === null) || value(x.totalMinutes) - value(y.totalMinutes)
      || x.missing.length - y.missing.length || x.knownMinutes - y.knownMinutes || value(a.properties.distanceMeters) - value(b.properties.distanceMeters)
  })
  return ranked
}
