import coordtransform from 'coordtransform'

export const AMAP_STANDARD_SOURCE = {
  type: 'raster',
  tiles: [1, 2, 3, 4].map(index => `https://webrd0${index}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}`),
  tileSize: 256,
  maxzoom: 18,
  attribution: '© <a href="https://www.amap.com/" target="_blank" rel="noopener">高德地图</a>',
}

// 数据库、空间分析及距离计算始终使用 WGS84，仅显示高德标准底图时转为 GCJ-02。
// 坐标系说明：https://developer.amap.com/api/javascript-api-v2/guide/abc/basetype
export function toMapCoordinate(coordinate, basemap = 'street') {
  if (basemap !== 'street') return [...coordinate]
  return [...coordtransform.wgs84togcj02(coordinate[0], coordinate[1]), ...coordinate.slice(2)]
}

export function fromMapCoordinate(coordinate, basemap = 'street') {
  if (basemap !== 'street') return [...coordinate]
  let point = coordtransform.gcj02towgs84(coordinate[0], coordinate[1])
  // 迭代反算，避免反复切换底图时积累近似转换误差。
  for (let index = 0; index < 3; index++) {
    const projected = coordtransform.wgs84togcj02(...point)
    point = [point[0] + coordinate[0] - projected[0], point[1] + coordinate[1] - projected[1]]
  }
  return [...point, ...coordinate.slice(2)]
}

export function toMapGeoJSON(data, basemap = 'street') {
  if (!data || basemap !== 'street') return data
  const coordinates = value => typeof value[0] === 'number'
    ? toMapCoordinate(value, basemap) : value.map(coordinates)
  // 原始 bbox 不再对应转换后的坐标，交由地图或 Turf 从几何重新计算。
  const { bbox, ...copy } = data
  if (data.type === 'FeatureCollection') return { ...copy, features: data.features.map(feature => toMapGeoJSON(feature, basemap)) }
  if (data.type === 'Feature') return { ...copy, geometry: toMapGeoJSON(data.geometry, basemap) }
  if (data.type === 'GeometryCollection') return { ...copy, geometries: data.geometries.map(geometry => toMapGeoJSON(geometry, basemap)) }
  return { ...copy, coordinates: coordinates(data.coordinates) }
}
