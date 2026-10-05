import { distance } from '@turf/turf'
import coordtransform from 'coordtransform'

// 浏览器定位与 OpenStreetMap 使用 WGS84；只转换明确标记为 GCJ-02 的地点。
export function normalizeChargingPoint(feature) {
  if (feature.geometry?.type !== 'Point' || feature.properties?.coordSystem !== 'GCJ-02') return feature
  return {
    ...feature,
    geometry: { ...feature.geometry, coordinates: coordtransform.gcj02towgs84(...feature.geometry.coordinates) },
    properties: { ...feature.properties, coordSystem: 'WGS84' },
  }
}

export function stationDistance(feature, location) {
  return location ? distance(location, feature.geometry.coordinates, { units: 'kilometers' }) : null
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
