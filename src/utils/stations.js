import { booleanPointInPolygon } from '@turf/turf'

export function validCoordinates(coordinates) {
  return Array.isArray(coordinates) && coordinates.length >= 2 &&
    Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1]) &&
    Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90
}

export function filterStations(stations, boundary) {
  if (stations?.type !== 'FeatureCollection' || !Array.isArray(stations.features)) {
    throw new Error('站点文件不是有效的 FeatureCollection')
  }
  // 边界文件可能是一个面，也可能包含多个面。
  let polygons = [boundary]
  if (boundary && boundary.type === 'FeatureCollection') {
    polygons = boundary.features
  }
  if (!Array.isArray(polygons) || polygons.length === 0) {
    throw new Error('行政区边界不能为空')
  }
  polygons.forEach((polygon) => {
    if (!polygon || !polygon.geometry) {
      throw new Error('行政区边界格式不正确')
    }
    if (polygon.geometry.type !== 'Polygon' && polygon.geometry.type !== 'MultiPolygon') {
      throw new Error('行政区边界必须是面要素')
    }
  })

  const features = stations.features.filter((station) => {
    if (!station || !station.geometry || station.geometry.type !== 'Point') {
      return false
    }
    if (!validCoordinates(station.geometry.coordinates)) {
      return false
    }
    // 只要位于其中一个行政区块内，就保留这个站点。
    let inside = false
    polygons.forEach((polygon) => {
      if (booleanPointInPolygon(station, polygon)) {
        inside = true
      }
    })
    return inside
  })
  return {
    type: 'FeatureCollection',
    features: features,
  }
}

export function convertPois(pois) {
  if (!Array.isArray(pois)) throw new Error('原始数据 pois 必须是数组')
  const features = new Map()
  for (const [index, poi] of pois.entries()) {
    if (typeof poi?.location !== 'string') continue
    const parts = poi.location.split(',').map(part => part.trim())
    if (parts.length !== 2 || parts.some(part => !part)) continue
    const coordinates = parts.map(Number)
    if (!validCoordinates(coordinates)) continue
    const text = value => typeof value === 'string' ? value : ''
    const id = text(poi.id).trim()
    // 缺少 ID 的站点分别保留；无效记录不会覆盖已有的有效记录。
    features.set(id ? `id:${id}` : `row:${index}`, {
      type: 'Feature',
      properties: {
        id, name: text(poi.name), type: text(poi.type), address: text(poi.address),
        district: text(poi.adname), city: text(poi.cityname), coordSystem: 'GCJ-02',
        chargeType: poi.chargeType === 'fast' ? 'fast' : 'regular'
      },
      geometry: { type: 'Point', coordinates }
    })
  }
  return { type: 'FeatureCollection', features: [...features.values()] }
}
