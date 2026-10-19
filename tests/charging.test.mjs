import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeChargingPoint, selectChargingStations, stationDistance, stationMetric, chargingDistanceInfo, formatChargingDistance, rankChargingRecommendations, chargingStationFacts, hasUsableDrivingRoute } from '../src/utils/charging.js'
import coordtransform from 'coordtransform'
import { resolveRoute } from '../src/navigation.js'

const features = [
  { geometry: { type: 'Point', coordinates: [113.85, 34.04] }, properties: { name: '城东站', address: '大学路', chargeType: 'fast', availableCount: 0 } },
  { geometry: { type: 'Point', coordinates: [113.86, 34.04] }, properties: { name: '城西站', address: '大学路', chargeType: 'regular', availableCount: 4, availabilityIsRealtime: true, availabilityUpdatedAt: new Date().toISOString() } },
  { geometry: { type: 'Point', coordinates: [113.9, 34.04] }, properties: { name: '未知站', chargeType: 'unknown' } },
]

test('可用路线筛选与卡片一致，拒绝降级和不完整路线，真实零距离和时间有效', () => {
  const driving = { distanceType: 'driving', distanceSource: 'amap_driving', isFallback: false,
    drivingDistanceMeters: 1250, drivingDurationSeconds: 180 }
  assert.equal(hasUsableDrivingRoute(driving), true)
  assert.equal(hasUsableDrivingRoute({ ...driving, drivingDistanceMeters: 0, drivingDurationSeconds: 0 }), true)
  const unavailable = [{}, { ...driving, isFallback: true }, { ...driving, distanceType: 'straight' },
    { ...driving, distanceSource: 'postgis_straight' }]
  for (const field of ['drivingDistanceMeters', 'drivingDurationSeconds']) {
    for (const value of [undefined, null, '', '180', -1, NaN, Infinity, true]) unavailable.push({ ...driving, [field]: value })
  }
  for (const properties of unavailable) {
    assert.equal(hasUsableDrivingRoute(properties), false)
    assert.equal(chargingStationFacts(properties).routeSummary, '路线不可使用')
  }
})

test('司机卡片区分到站与充电时间，价格未知不当免费，部分费用不冒充合计', () => {
  const unknown = chargingStationFacts({ distanceType: 'straight', distanceMeters: 0, drivingDurationSeconds: 300, pricePerKwh: null }, { knownCost: 0, totalCost: null })
  assert.equal(unknown.distance, '路线不可使用')
  assert.equal(unknown.straightDistance, '直线参考 约 0 m（非驾车距离）')
  assert.equal(unknown.distanceLabel, '驾车距离')
  assert.equal(unknown.arrivalTime, '驾车时间未知')
  assert.equal(unknown.price, '暂无价格')
  assert.equal(unknown.cost, '')
  const known = chargingStationFacts({ distanceType: 'driving', distanceSource: 'amap_driving', isFallback: false, drivingDistanceMeters: 1250, drivingDurationSeconds: 180, pricePerKwh: 1.2 }, { chargeMinutes: 31.2, chargeCost: 40.33, totalCost: null })
  assert.equal(known.arrivalTime, '约 3 分钟')
  assert.equal(known.chargeTime, '预计充电 32 分钟')
  assert.equal(known.price, '1.20 元/度')
  assert.equal(known.cost, '充电估算 40.33 元（不含停车等费用）')
  assert.equal(known.demoPrice, false)
  assert.equal(chargingStationFacts({}, { totalCost: 0, chargeCost: 10 }).cost, '')
})

test('统一标记为 GCJ-02 的站点坐标，不修改原数据或重复转换 WGS84', () => {
  const coordinates = coordtransform.wgs84togcj02(113.85, 34.04)
  const feature = { ...features[0], geometry: { type: 'Point', coordinates }, properties: { ...features[0].properties, coordSystem: 'GCJ-02' } }
  const converted = normalizeChargingPoint(feature)
  assert.equal(converted.properties.coordSystem, 'WGS84')
  assert.equal(feature.properties.coordSystem, 'GCJ-02')
  assert.deepEqual(feature.geometry.coordinates, coordinates)
  assert.ok(stationDistance(converted, [113.85, 34.04]) < 0.005)
  assert.equal(normalizeChargingPoint(converted), converted)
  assert.equal(normalizeChargingPoint(features[0]), features[0])
})
test('旧慢充与未标注站点归入普通充电，保留快充和真实零桩数', () => {
  for (const chargeType of ['slow', 'unknown']) {
    const original = { ...features[1], properties: { ...features[1].properties, chargeType, slowCount: 4, fastCount: 0 } }
    const normalized = normalizeChargingPoint(original)
    assert.equal(normalized.properties.chargeType, 'regular')
    assert.equal(normalized.properties.regularCount, 4)
    assert.equal(normalized.properties.fastCount, 0)
    assert.ok(!('slowCount' in normalized.properties))
    assert.equal(original.properties.chargeType, chargeType)
  }
})

test('按地址、类型、空闲数量和距离组合筛选', () => {
  assert.equal(selectChargingStations(features, { keyword: '大学路' }).length, 2)
  assert.equal(selectChargingStations(features, { type: 'fast', available: true }).length, 0)
  assert.equal(selectChargingStations(features, { available: true })[0].properties.name, '城西站')
  const nearby = selectChargingStations(features, { location: [113.86, 34.04], radius: 1 })
  assert.deepEqual(nearby.map(item => item.properties.name), ['城西站', '城东站'])
})
test('详情保留零值且缺失字段不编造数据', () => {
  assert.equal(stationMetric(0, ' 个'), '0 个')
  for (const value of [null, undefined, '', NaN, -1]) assert.equal(stationMetric(value), '暂无数据')
})
test('车主端下线后旧入口和收藏地址统一返回规划首页', () => {
  for (const route of ['/charging', '/charing', '/stations', '/charging/search', '/charing/search', '/charging/details', '/charging/filter', '/charging/settings', '/charging/demo', '/charing/settings', '/navigation', '/recommendations']) {
    assert.equal(resolveRoute(route), '/')
  }
  for (const route of ['/', '/monitoring/demand', '/planning/problems']) assert.equal(resolveRoute(route), route)
})

test('驾车和直线距离保留各自数值和类型，降级时不使用驾车字段', () => {
  const location = [113.86, 34.04]
  const route = { distanceType: 'driving', distanceSource: 'amap_driving', isFallback: false,
    straightDistanceMeters: 600, drivingDistanceMeters: 1250, drivingDurationSeconds: 180 }
  const driving = chargingDistanceInfo(features[0], location, route)
  assert.equal(driving.distanceType, 'driving')
  assert.equal(driving.distanceLabel, '驾车距离')
  assert.equal(driving.distanceMeters, 1250)
  assert.equal(driving.straightDistanceMeters, 600)
  assert.equal(driving.drivingDurationSeconds, 180)
  const straight = chargingDistanceInfo(features[0], location, { ...route,
    distanceType: 'straight', distanceSource: 'postgis_straight', isFallback: true })
  assert.equal(straight.distanceMeters, 600)
  assert.equal(straight.distanceLabel, '直线距离（降级估算）')
  assert.equal(straight.drivingDistanceMeters, null)
  assert.equal(straight.drivingDurationSeconds, null)
})

test('没有位置时不展示旧距离，接口失败和无效驾车字段使用本地直线估算，零值有效', () => {
  assert.equal(chargingDistanceInfo(features[0], null, { drivingDistanceMeters: 100 }), null)
  const location = features[0].geometry.coordinates
  const failed = chargingDistanceInfo(features[0], location, null, true)
  assert.equal(failed.isFallback, true)
  assert.equal(failed.distanceSource, 'client_straight')
  assert.equal(failed.distanceMeters, 0)
  for (const value of [null, undefined, '', NaN, -1]) {
    const result = chargingDistanceInfo(features[0], location, { distanceType: 'driving',
      distanceSource: 'amap_driving', isFallback: false, drivingDistanceMeters: value })
    assert.equal(result.distanceType, 'straight')
    assert.equal(result.isFallback, true)
    assert.equal(result.drivingDistanceMeters, null)
  }
  const zero = chargingDistanceInfo(features[0], location, { distanceType: 'driving',
    distanceSource: 'amap_driving', isFallback: false, drivingDistanceMeters: 0, drivingDurationSeconds: 0 })
  assert.equal(zero.distanceType, 'driving')
  assert.equal(zero.drivingDurationSeconds, 0)
  assert.equal(formatChargingDistance(zero.distanceMeters), '约 0 m')
  assert.equal(formatChargingDistance(null), '定位后查看')
  assert.equal(formatChargingDistance(1250), '约 1.3 km')
})

test('本地降级推荐区分距离、费用和综合，缺失费用不当免费，权重极值有效', () => {
  const items = [['near', 100, 3], ['middle', 200, 1.5], ['cheap', 1000, 0.5], ['unknown', 0, null]]
    .map(([id, distanceMeters, pricePerKwh]) => ({ properties: { id, distanceMeters, straightDistanceMeters: distanceMeters, pricePerKwh } }))
  assert.equal(rankChargingRecommendations(items, 'distance')[0].properties.id, 'unknown')
  assert.equal(rankChargingRecommendations(items, 'economy')[0].properties.id, 'cheap')
  assert.equal(rankChargingRecommendations(items, 'balanced')[0].properties.id, 'middle')
  assert.equal(rankChargingRecommendations(items, 'balanced', 0)[0].properties.id, 'cheap')
  assert.equal(rankChargingRecommendations(items, 'balanced', 1)[0].properties.id, 'unknown')
  assert.equal(rankChargingRecommendations(items, 'economy').at(-1).properties.id, 'unknown')
  assert.ok(items.every(item => !('recommendationScore' in item.properties)))
  assert.deepEqual(rankChargingRecommendations([]), [])
  const zero = [{ properties: { id: 'free', distanceMeters: 0, straightDistanceMeters: 0, pricePerKwh: 0 } }]
  assert.equal(rankChargingRecommendations(zero, 'balanced')[0].properties.recommendationScore, 100)
})
