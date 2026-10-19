import { distance } from '@turf/turf'
import coordtransform from 'coordtransform'
import { knownNumber, isDemoField, chargingCompatibility, stationAvailability, stationPrice, formatInformationTime, informationState, stationInformationStates } from './stationInformation.js'

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
    routeDestinationKind: driving ? route.routeDestinationKind : null,
    routeDestinationLabel: driving ? route.routeDestinationLabel : null,
  }
}

export function formatChargingDistance(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return '定位后查看'
  return meters < 1000 ? `约 ${Math.round(meters)} m` : `约 ${(meters / 1000).toFixed(1)} km`
}

export function hasUsableDrivingRoute(properties = {}) {
  return properties.distanceType === 'driving' && properties.isFallback === false
    && properties.distanceSource === 'amap_driving' && knownNumber(properties.drivingDistanceMeters)
    && knownNumber(properties.drivingDurationSeconds)
}

export function chargingStationFacts(properties = {}, fit = null, context = {}, now = Date.now()) {
  const known = knownNumber
  const driving = properties.distanceType === 'driving' && properties.isFallback === false
    && properties.distanceSource === 'amap_driving' && known(properties.drivingDistanceMeters)
  const routeUsable = hasUsableDrivingRoute(properties)
  const straight = known(properties.straightDistanceMeters) ? properties.straightDistanceMeters
    : properties.distanceType === 'straight' && known(properties.distanceMeters) ? properties.distanceMeters : null
  const price = stationPrice(properties, 'pricePerKwh')
  const electricity = stationPrice(properties, 'electricityPrice'), service = stationPrice(properties, 'servicePrice'), parking = stationPrice(properties, 'parkingFee')
  const unitPrice = price ?? (electricity !== null && service !== null ? electricity + service : null)
  const compatibility = chargingCompatibility(properties, context), availability = stationAvailability(properties, now)
  const sourceLabels = { 'existing-poi': '原始 POI', synthetic: '虚拟演示数据' }
  const source = properties.isSynthetic ? '虚拟演示数据' : typeof properties.dataSource === 'string' && properties.dataSource.trim()
    && !isDemoField(properties, 'dataSource') && !['unknown', '未知', '暂无', '-'].includes(properties.dataSource.trim().toLowerCase()) ? sourceLabels[properties.dataSource] || properties.dataSource : '数据来源未知'
  const verifiedAt = !isDemoField(properties, 'verifiedAt') && Date.parse(properties.verifiedAt) <= now ? formatInformationTime(properties.verifiedAt) : ''
  const guide = !isDemoField(properties, 'accessGuide') && properties.accessGuide?.location ? properties.accessGuide : null
  const sourceLink = value => typeof value === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*(?:amap\.com|tesla\.cn)(?:\/|$)/i.test(value) ? value : ''
  const accessGuide = guide ? { ...guide, sourceUrl: sourceLink(guide.sourceUrl), amapUrl: sourceLink(guide.amapUrl),
    reviewedTime: formatInformationTime(guide.reviewedAt), evidenceLabel: guide.evidenceStatus === 'public_source_checked' ? '已核对公开资料，尚未现场核验' : 'POI 存档资料，当前情况未核验' } : null
  const amount = value => value < .01 ? '不足 0.01' : value.toFixed(2)
  const chargeCostKnown = routeUsable && !compatibility.prohibited && unitPrice !== null && !fit?.hasDemoInputs
    && known(fit?.chargeCost) && fit.chargeCost > 0
  const totalCostKnown = chargeCostKnown && electricity !== null && service !== null && parking !== null && known(fit?.totalCost) && fit.totalCost > 0
  return {
    informationStates: stationInformationStates(properties, now),
    feeState: informationState(properties, 'pricePerKwh', unitPrice ?? properties.pricePerKwh, now, ['electricityPrice', 'servicePrice']),
    availabilityState: isDemoField(properties, 'availableCount') && known(properties.availableCount) ? 'simulated' : availability.hasRealtime ? 'known' : 'unknown',
    routeUsable, distance: driving ? formatChargingDistance(properties.drivingDistanceMeters) : '路线不可使用', distanceLabel: '驾车距离',
    arrivalTime: routeUsable ? `约 ${Math.ceil(properties.drivingDurationSeconds / 60)} 分钟` : '驾车时间未知',
    routeSummary: routeUsable ? `${formatChargingDistance(properties.drivingDistanceMeters)} · 约 ${Math.ceil(properties.drivingDurationSeconds / 60)} 分钟` : '路线不可使用',
    routeNote: routeUsable ? properties.routeDestinationKind === 'vehicle_entrance' ? '驾车至车行入口；入库后按现场指引'
      : guide ? '驾车至站点定位；入口坐标未核验，车库内路段未计入' : '从当前位置出发' : driving ? `驾车距离 ${formatChargingDistance(properties.drivingDistanceMeters)}，缺少驾车时间` : '未获取可用驾车路线',
    straightDistance: straight !== null ? `直线参考 ${formatChargingDistance(straight)}（非驾车距离）` : '',
    compatibility, price: unitPrice !== null ? `${amount(unitPrice)} 元/度` : '暂无价格',
    electricityPrice: electricity !== null ? `${amount(electricity)} 元/度` : '暂无价格',
    servicePrice: service !== null ? `${amount(service)} 元/度` : '暂无价格',
    parkingFee: parking !== null ? `${amount(parking)} 元/小时` : '暂无价格',
    demoPrice: isDemoField(properties, 'electricityPrice', 'servicePrice', 'pricePerKwh', 'parkingFee'),
    chargeTime: routeUsable && !compatibility.prohibited && !fit?.hasDemoInputs && known(fit?.chargeMinutes) && fit.chargeMinutes > 0 ? `预计充电 ${Math.ceil(fit.chargeMinutes)} 分钟` : '',
    cost: totalCostKnown ? `使用成本估算 ${amount(fit.totalCost)} 元（充电、停车及绕行）`
      : chargeCostKnown ? `充电估算 ${amount(fit.chargeCost)} 元（不含停车等费用）` : '',
    availability, source, verifiedAt: verifiedAt || '核验时间未知',
    accessGuide,
    dataNote: properties.isSynthetic ? '虚拟站点，仅供演示' : properties.hasSimulatedAttributes || properties.simulatedFields?.length ? '含演示补全属性，不能作为实测依据' : '',
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

export function selectChargingStations(features, { keyword = '', type = '', available = false, radius = 0, location = null, now = Date.now() } = {}) {
  const query = keyword.trim().toLowerCase()
  return features.filter(feature => {
    const properties = feature.properties || {}
    const matches = `${properties.name || ''} ${properties.address || ''}`.toLowerCase().includes(query)
    return matches && (!type || properties.chargeType === type) &&
      (!available || (stationAvailability(properties, now).hasRealtime && properties.availableCount > 0)) &&
      (!radius || !location || stationDistance(feature, location) <= radius)
  }).sort((a, b) => location ? stationDistance(a, location) - stationDistance(b, location) : 0)
}

export function stationMetric(value, unit = '') {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
    ? `${value}${unit}` : '暂无数据'
}
