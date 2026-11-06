import { booleanPointInPolygon, distance, point, pointOnFeature } from '@turf/turf'
import { validCoordinates } from '../../stations/models/stations.js'

// 只依据已载入的属性限制选择，不把没有建设资料的位置当作已通过核查。
export function sitingRestriction(properties = {}) {
  if (properties.buildable === false || properties.constructionAllowed === false || properties.noBuild === true) return '该区域已标注为不可建设'
  for (const [key, label] of [['sitePermission', '用地与场地'], ['roadAccess', '车辆出入口'], ['fireSafety', '消防与安全']]) {
    if (properties[key] === false) return `${label}条件不满足`
  }
  return ''
}

export function assessSitingLocation(coordinates, { boundary, features = [], factors = {}, context } = {}) {
  if (!validCoordinates(coordinates)) return { allowed: false, reason: '请选择有效的地图位置' }
  const borders = boundary?.type === 'FeatureCollection' ? boundary.features : boundary ? [boundary] : []
  if (!borders.length || !features.length) return { allowed: false, reason: '选址地图数据尚未就绪' }
  const location = point(coordinates)
  if (!borders.some(border => booleanPointInPolygon(location, border))) return { allowed: false, reason: '请选择魏都区研究范围内的位置' }
  for (const feature of context?.features || []) {
    if (!['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) continue
    const reason = feature.properties?.category === 'water' ? '水域不作为建站场地' : sitingRestriction(feature.properties)
    if (reason && booleanPointInPolygon(location, feature)) return { allowed: false, reason }
  }
  const matches = features.filter(feature => booleanPointInPolygon(location, feature))
  if (!matches.length) return { allowed: false, reason: '此处没有可用的规划网格' }
  // 共边位置只要命中一个明确禁建的网格，就不接受选择。
  for (const feature of matches) {
    const reason = sitingRestriction({ ...feature.properties, ...factors[String(feature.properties.id)] })
    if (reason) return { allowed: false, reason }
  }
  return { allowed: true, feature: matches[0] }
}

export function featuresInSitingScope(features, selection) {
  if (!selection || !validCoordinates(selection.center) || !Number.isFinite(selection.radiusMeters)
      || selection.radiusMeters < 100 || selection.radiusMeters > 3000) return []
  const center = point(selection.center)
  return features.filter(feature => distance(center, pointOnFeature(feature), { units: 'meters' }) <= selection.radiusMeters)
}
