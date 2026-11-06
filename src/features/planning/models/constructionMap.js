import { bbox, booleanPointInPolygon, difference, featureCollection, intersect, pointOnFeature, union } from '@turf/turf'
import { sitingRestriction } from './sitingSelection.js'

const isArea = feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type)
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

// 水域与已有否决属性才作为排除范围；停车记录、风险点不推导虚构的禁建半径。
export function constructionRestriction(feature) {
  if (feature.properties?.category === 'water') return '水域不作为建站场地'
  return sitingRestriction(feature.properties)
}

export function constructionMapData({ boundary, features = [], factors = {}, context } = {}) {
  const borders = (boundary?.type === 'FeatureCollection' ? boundary.features : [boundary]).filter(isArea)
  if (!borders.length) return featureCollection([])
  const border = borders.length === 1 ? borders[0] : union(featureCollection(borders))
  const borderBox = bbox(border)
  const output = [], exclusions = []
  const clip = feature => {
    if (!overlaps(bbox(feature), borderBox)) return null
    return intersect(featureCollection([feature, border]))
  }
  const addReference = (feature, kind, reason = '') => {
    if (isArea(feature)) {
      const area = clip(feature)
      if (!area) return
      const properties = { ...feature.properties, constructionKind: kind, restrictionReason: reason }
      output.push({ ...area, properties })
      output.push({ ...pointOnFeature(area), properties: { ...properties, constructionKind: kind + '-symbol' } })
      if (kind === 'water' || kind === 'blocked') exclusions.push(area)
    } else if (feature.geometry?.type === 'Point' && booleanPointInPolygon(feature, border)) {
      output.push({ ...feature, properties: { ...feature.properties, constructionKind: kind + '-symbol', restrictionReason: reason } })
    }
  }
  for (const feature of context?.features || []) {
    const reason = constructionRestriction(feature)
    const category = feature.properties?.category
    if (reason) addReference(feature, category === 'water' ? 'water' : 'blocked', reason)
    else if (['parking', 'entrance', 'safety'].includes(category)) addReference(feature, category === 'safety' ? 'risk' : category)
  }
  const grids = features.map(feature => ({ ...feature, properties: { ...feature.properties, ...factors[String(feature.properties.id)] } }))
  for (const feature of grids) {
    const reason = sitingRestriction(feature.properties)
    if (reason) addReference(feature, 'blocked', reason)
  }
  const excluded = exclusions.map(feature => ({ feature, bounds: bbox(feature) }))
  for (const feature of grids) {
    if (sitingRestriction(feature.properties) || !isArea(feature)) continue
    let area = clip(feature)
    if (!area) continue
    const bounds = bbox(area)
    const cuts = excluded.filter(row => overlaps(bounds, row.bounds)).map(row => row.feature)
    if (cuts.length) area = difference(featureCollection([area, ...cuts]))
    if (area) output.push({ ...area, properties: { id: feature.properties.id, constructionKind: 'zone' } })
  }
  return featureCollection(output)
}
