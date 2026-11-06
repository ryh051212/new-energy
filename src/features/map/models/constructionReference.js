import { bbox, pointOnFeature } from '@turf/turf'

export const GRADE_LABELS = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ']

// 使用同一局部等距比例绘制边界、分区和点位，避免原始高德与 WGS84 坐标混用。
export function constructionReferenceDrawing(data) {
  if (data.metadata?.coordSystem !== 'WGS84') throw new Error('建设参考图需要 WGS84 坐标')
  const [west, south, east, north] = bbox(data.boundary)
  const longitudeFactor = Math.cos((north + south) / 2 * Math.PI / 180)
  const width = (east - west) * longitudeFactor
  const height = north - south
  const scale = Math.min(870 / width, 610 / height)
  const left = (1000 - width * scale) / 2
  const top = 65 + (610 - height * scale) / 2
  const project = ([longitude, latitude]) => [
    left + (longitude - west) * longitudeFactor * scale,
    top + (north - latitude) * scale,
  ]

  function geometryPath(geometry) {
    const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
    const paths = []
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const points = ring.map(coordinate => project(coordinate).map(value => value.toFixed(2)).join(','))
        paths.push(`M${points.join('L')}Z`)
      }
    }
    return paths.join('')
  }

  const zones = data.zones.features.map(feature => {
    const labelCoordinates = feature.properties.labelCoordinates ?? pointOnFeature(feature).geometry.coordinates
    const [x, y] = project(labelCoordinates)
    return { ...feature.properties, path: geometryPath(feature.geometry), x, y }
  })
  const power = data.power.features.map(feature => ({
    ...feature.properties,
    coordinates: feature.geometry.coordinates,
    kind: feature.properties.tags?.power,
    position: project(feature.geometry.coordinates),
  }))
  const substations = power.filter(feature => feature.kind === 'substation')
    .sort((a, b) => b.coordinates[1] - a.coordinates[1])
    .map((feature, index) => ({ ...feature, label: `S${String(index + 1).padStart(2, '0')}` }))
  const transformers = power.filter(feature => feature.kind === 'transformer')
  return {
    boundaryPath: data.boundary.features.map(feature => geometryPath(feature.geometry)).join(''),
    zones, substations, transformers,
    scaleBarWidth: scale * 1000 / 111195,
  }
}

export function powerVoltageLabel(value) {
  if (!value) return '电压待核实'
  const volts = String(value).split(';').map(Number)
  if (volts.some(voltage => !Number.isFinite(voltage) || voltage <= 0)) return '电压待核实'
  return `${volts.map(voltage => voltage / 1000).join(' / ')} kV`
}
