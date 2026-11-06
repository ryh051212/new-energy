// Hover and selection are independent. All parts of a building share the visual state.
// Pattern: https://maplibre.org/maplibre-gl-js/docs/examples/create-a-hover-effect/
export function buildingHighlightColor(baseColor = ['get', 'color']) {
  return ['case', ['boolean', ['feature-state', 'selected'], false], '#f5c878',
    ['boolean', ['feature-state', 'hover'], false], '#b7f2d3', baseColor]
}

export function createBuildingInteraction(map, city) {
  const groups = new Map()
  for (const source of ['buildings', 'bands']) {
    for (const feature of city[source].features) {
      const { id, buildingId } = feature.properties
      if (!groups.has(buildingId)) groups.set(buildingId, [])
      groups.get(buildingId).push({ source, id })
    }
  }
  const active = { selected: null, hover: null }
  function set(key, id) {
    const next = groups.has(id) ? id : null
    if (active[key] === next) return
    for (const feature of groups.get(active[key]) || []) map.setFeatureState(feature, { [key]: false })
    active[key] = next
    for (const feature of groups.get(next) || []) map.setFeatureState(feature, { [key]: true })
  }
  return {
    select: id => set('selected', id),
    hover: id => set('hover', id),
    clear: () => { set('selected', null); set('hover', null) },
  }
}
