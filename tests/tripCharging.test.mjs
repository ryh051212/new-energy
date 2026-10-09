import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeTripContext, evaluateTripStation, rankTripStations } from '../src/utils/tripCharging.js'
const { context, features } = JSON.parse(fs.readFileSync(new URL('./fixtures/trip-charging.json', import.meta.url), 'utf8'))
const modified = (index, properties) => ({ ...features[index], properties: { ...features[index].properties, ...properties } })

test('补完就走优先总时间，不是最近或标称功率最大；车辆功率上限生效', () => {
  assert.deepEqual(rankTripStations(features, 'urgent', context).map(f => f.properties.id), ['shopping-fast', 'far-superfast', 'near-slow'])
  const fit = evaluateTripStation(features[1], 'urgent', context)
  assert.equal(fit.safety, 'reachable')
  assert.equal(fit.arrivalSoc, 19.5)
  assert.equal(fit.chargeEnergyKwh, 36.3)
  assert.equal(fit.chargeMinutes, 30.25)
  assert.equal(fit.totalMinutes, 39.25)
  assert.equal(fit.queueSource, 'user')
})
test('购物围绕所选超市，先看能否补够；停车时长含步行，补电不超过目标', () => {
  const ranked = rankTripStations(features, 'shopping', context)
  assert.deepEqual(ranked.map(f => f.properties.id), ['shopping-fast', 'near-slow'])
  assert.equal(ranked[0].properties.tripFit.meetsTarget, true)
  assert.equal(ranked[0].properties.tripFit.projectedSoc, 80)
  assert.equal(ranked[1].properties.tripFit.meetsTarget, false)
  assert.ok(ranked[1].properties.tripFit.parkingCost > 20)
  assert.ok(ranked[1].properties.tripFit.shoppingChargedEnergyKwh < 6)
  assert.ok(ranked[0].properties.tripFit.windowMinutes > context.shoppingMinutes)
})
test('省钱考虑停车和完整绕行，单价低的慢充不一定最便宜', () => {
  const ranked = rankTripStations(features, 'economy', context)
  assert.equal(ranked[0].properties.id, 'shopping-fast')
  assert.equal(ranked[0].properties.tripFit.totalCost, 40.33)
  const far = evaluateTripStation(features[2], 'economy', context)
  assert.equal(far.extraKm, 4)
  assert.equal(far.extraEnergyCost, .18)
  assert.equal(far.extraTolls, 8)
  assert.equal(far.totalCost, 89.18)
})
test('未知排队、费用、收费路线都不算零；直线不能确认可达', () => {
  const fallback = modified(1, { distanceType: 'straight', isFallback: true, drivingDistanceMeters: null, drivingDurationSeconds: null })
  const fit = evaluateTripStation(fallback, 'urgent', { ...context, queueMinutes: null })
  assert.equal(fit.safety, 'unknown')
  assert.equal(fit.totalMinutes, null)
  assert.equal(fit.queueMinutes, null)
  for (const changes of [{ parkingFee: null }, { pricePerKwh: null, electricityPrice: null }, { drivingTollsYuan: null }, { tripRoute: {} }]) {
    assert.equal(evaluateTripStation(modified(1, changes), 'economy', context).totalCost, null)
  }
  assert.equal(evaluateTripStation(features[1], 'shopping', { ...context, queueMinutes: null }).meetsTarget, null)
  assert.equal(evaluateTripStation(features[1], 'urgent', {}).safety, 'unknown')
})
test('不推荐电量低于保留值、维护中或不兼容的站，空集不回退最近站', () => {
  const inputs = [modified(1, { drivingDistanceMeters: 100000 }), modified(0, { status: 'maintenance' }), modified(2, { vehicleCompatible: false })]
  assert.deepEqual(rankTripStations(inputs, 'urgent', context), [])
  assert.equal(evaluateTripStation(modified(1, { drivingDistanceMeters: 100000 }), 'urgent', context).safety, 'unreachable')
  assert.deepEqual(rankTripStations([modified(0, { powerKw: 0 })], 'urgent', context), [])
})
test('站点等待估计覆盖用户假设，零值有效；无效输入保持未知，排序不改原值', () => {
  const snapshot = JSON.stringify(features)
  assert.equal(evaluateTripStation(modified(1, { estimatedWaitMinutes: 0 }), 'urgent', context).queueMinutes, 0)
  const trip = normalizeTripContext({ currentSoc: 101, batteryKwh: 0, maxChargeKw: false, destination: [200, 90] })
  assert.equal(trip.currentSoc, null)
  assert.equal(trip.batteryKwh, null)
  assert.equal(trip.destination, null)
  rankTripStations(features, 'economy', context)
  assert.equal(JSON.stringify(features), snapshot)
})

test('目的地补能适用于任意功能区，活动时长控制补电量；兼容旧购物字段', () => {
  const legacy = rankTripStations(features, 'shopping', context)
  const general = rankTripStations(features, 'destination', { ...context, stayMinutes: 60 })
  assert.deepEqual(general.map(f => f.properties.id), legacy.map(f => f.properties.id))
  assert.equal(general[0].properties.tripFit.stayChargedEnergyKwh, legacy[0].properties.tripFit.shoppingChargedEnergyKwh)
  assert.equal(general[0].properties.tripFit.activityMinutes, 60)
  assert.ok(general[0].properties.tripFit.parkingMinutes > 65)
  const short = evaluateTripStation(features[1], 'destination', { ...context, stayMinutes: 5 })
  assert.equal(short.meetsTarget, false)
  assert.ok(short.projectedSoc < 80)
  const long = evaluateTripStation(features[1], 'destination', { ...context, stayMinutes: 90 })
  assert.equal(long.meetsTarget, true)
  assert.equal(long.projectedSoc, 80)
  assert.equal(normalizeTripContext({ shoppingMinutes: 45 }).stayMinutes, 45)
})
