import { distance } from '@turf/turf'
import coordtransform from 'coordtransform'

// 浏览器定位与数据库使用 WGS84；地点统一到 WGS84，底图坐标转换只在显示时进行。
export function normalizeChargingPoint(feature) {
  if (feature.geometry?.type !== 'Point') return feature
  const properties = feature.properties || {}
  const convertCoordinates = properties.coordSystem === 'GCJ-02'
  const convertType = properties.chargeType && !['fast', 'regular'].includes(properties.chargeType)
  const convertCount = properties.regularCount === undefined && properties.slowCount !== undefined
  if (!convertCoordinates && !convertType && !convertCount) return feature
  const normalized = {
    ...feature, properties: { ...properties },
    geometry: convertCoordinates ? { ...feature.geometry, coordinates: coordtransform.gcj02towgs84(...feature.geometry.coordinates) } : feature.geometry,
  }
  if (convertCoordinates) normalized.properties.coordSystem = 'WGS84'
  if (convertType) normalized.properties.chargeType = 'regular'
  if (convertCount) normalized.properties.regularCount = properties.slowCount
  delete normalized.properties.slowCount
  return normalized
}

export function stationDistance(feature, location) {
  return location ? distance(location, feature.geometry.coordinates, { units: 'kilometers' }) : null
}

export function chargingDistanceInfo(feature, location, route = null, routeFailed = false) {
  if (!location) return null
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const straightDistanceMeters = valid(route?.straightDistanceMeters)
    ? route.straightDistanceMeters : stationDistance(feature, location) * 1000
  const driving = route?.isFallback === false && route?.distanceSource === 'amap_driving'
    && route?.distanceType === 'driving' && valid(route?.drivingDistanceMeters)
  const isFallback = !driving && (routeFailed || !!route)
  return {
    straightDistanceMeters,
    distanceMeters: driving ? route.drivingDistanceMeters : straightDistanceMeters,
    drivingDistanceMeters: driving ? route.drivingDistanceMeters : null,
    drivingDurationSeconds: driving && valid(route.drivingDurationSeconds) ? route.drivingDurationSeconds : null,
    distanceType: driving ? 'driving' : 'straight',
    distanceSource: driving ? 'amap_driving' : valid(route?.straightDistanceMeters) ? 'postgis_straight' : 'client_straight',
    distanceLabel: driving ? '驾车距离' : isFallback ? '直线距离（降级估算）' : '直线距离估算',
    isFallback,
  }
}

export function formatChargingDistance(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return '定位后查看'
  return meters < 1000 ? `约 ${Math.round(meters)} m` : `约 ${(meters / 1000).toFixed(1)} km`
}

export function chargingStationFacts(properties = {}, fit = null) {
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const driving = properties.distanceType === 'driving' && !properties.isFallback
  const cost = known(fit?.totalCost) ? fit.totalCost : fit?.chargeCost
  return {
    distance: known(properties.distanceMeters) ? formatChargingDistance(properties.distanceMeters) : '定位后查看',
    distanceLabel: driving ? '距离' : '直线距离',
    arrivalTime: driving && known(properties.drivingDurationSeconds) ? `约 ${Math.ceil(properties.drivingDurationSeconds / 60)} 分钟` : '暂无',
    price: known(properties.pricePerKwh) ? `${properties.pricePerKwh.toFixed(2)} 元/度` : '暂无',
    demoPrice: !!properties.isSynthetic || (properties.simulatedFields || []).some(field => ['electricityPrice', 'servicePrice', 'pricePerKwh'].includes(field)),
    chargeTime: known(fit?.chargeMinutes) ? `充电约 ${Math.ceil(fit.chargeMinutes)} 分钟` : '',
    cost: known(cost) ? `${known(fit?.totalCost) ? '合计' : '充电'}约 ${cost.toFixed(2)} 元` : '',
  }
}

// 接口不可用时对当前筛选结果排序；缺失费用不当作免费。
export function rankChargingRecommendations(features, mode = 'distance', distanceWeight = 0.5) {
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const distances = features.map(feature => feature.properties.distanceMeters).filter(valid)
  const prices = features.map(feature => feature.properties.pricePerKwh).filter(valid)
  const normalize = (value, values) => {
    if (!valid(value) || !values.length) return 1
    const minimum = Math.min(...values), maximum = Math.max(...values)
    return maximum > minimum ? (value - minimum) / (maximum - minimum) : 0
  }
  const ranked = features.map(feature => {
    const p = feature.properties
    const cost = distanceWeight * normalize(p.distanceMeters, distances)
      + (1 - distanceWeight) * normalize(p.pricePerKwh, prices)
    return { feature: { ...feature, properties: { ...p, rankingMode: mode,
      recommendationScore: Math.round(1000 * (1 - cost)) / 10 } }, cost }
  })
  ranked.sort((a, b) => {
    const left = a.feature.properties, right = b.feature.properties
    const unknownLeft = !valid(left.pricePerKwh), unknownRight = !valid(right.pricePerKwh)
    if (mode === 'economy' || (mode === 'balanced' && distanceWeight < 1)) {
      if (unknownLeft !== unknownRight) return Number(unknownLeft) - Number(unknownRight)
    }
    if (mode === 'economy' && !unknownLeft && left.pricePerKwh !== right.pricePerKwh) return left.pricePerKwh - right.pricePerKwh
    if (mode === 'balanced' && a.cost !== b.cost) return a.cost - b.cost
    return left.distanceMeters - right.distanceMeters || left.straightDistanceMeters - right.straightDistanceMeters
      || (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0)
  })
  return ranked.map(item => item.feature)
}

export function selectChargingStations(features, { keyword = '', type = '', available = false, radius = 0, location = null } = {}) {
  const query = keyword.trim().toLowerCase()
  return features.filter(feature => {
    const properties = feature.properties || {}
    const matches = `${properties.name || ''} ${properties.address || ''}`.toLowerCase().includes(query)
    return matches && (!type || properties.chargeType === type) &&
      (!available || Number(properties.availableCount) > 0) &&
      (!radius || !location || stationDistance(feature, location) <= radius)
  }).sort((a, b) => location ? stationDistance(a, location) - stationDistance(b, location) : 0)
}

export function stationMetric(value, unit = '') {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
    ? `${value}${unit}` : '暂无数据'
}
