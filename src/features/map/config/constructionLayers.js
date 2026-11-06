export const CONSTRUCTION_REFERENCE_LAYERS = ['construction-reference-symbols', 'construction-restriction-fill']

export function constructionLayers() {
  const source = 'construction-map'
  const kind = ['get', 'constructionKind']
  const restricted = ['in', kind, ['literal', ['water', 'blocked']]]
  const color = ['match', kind, 'water', '#38a6d2', 'blocked', '#dc5a58', '#168575']
  return [
    { id: 'construction-zone-fill', type: 'fill', source, filter: ['==', kind, 'zone'], paint: { 'fill-color': '#168575', 'fill-opacity': .055 } },
    { id: 'construction-zone-outline', type: 'line', source, filter: ['==', kind, 'zone'], paint: { 'line-color': '#168575', 'line-width': 1.1, 'line-opacity': .6, 'line-dasharray': [3, 2] } },
    { id: 'construction-restriction-fill', type: 'fill', source, filter: restricted, paint: { 'fill-color': color, 'fill-opacity': .3 } },
    { id: 'construction-restriction-outline', type: 'line', source, filter: restricted, paint: { 'line-color': color, 'line-width': 1.8 } },
    { id: 'construction-restriction-pattern', type: 'fill', source, filter: restricted, paint: { 'fill-pattern': 'construction-hatch', 'fill-opacity': .5 } },
    { id: 'construction-reference-symbols', type: 'symbol', source,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'icon-image': ['match', kind, 'parking-symbol', 'construction-parking', 'entrance-symbol', 'construction-entrance', 'risk-symbol', 'construction-risk', 'water-symbol', 'construction-water', 'construction-blocked'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 11, .7, 14, 1],
        'icon-padding': 5, 'icon-allow-overlap': false, 'icon-ignore-placement': false,
        'symbol-sort-key': ['match', kind, 'blocked-symbol', 0, 'water-symbol', 1, 'parking-symbol', 2, 3],
        'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
      } },
  ]
}

// 本地 Canvas 字形，平面拖动时跟随地图，无需加载在线字体。
export function registerConstructionIcons(map, dom = globalThis.document) {
  if (!map?.addImage || !dom) return
  const icons = { parking: ['#0f766e', 'P'], entrance: ['#b45309', '↪'], risk: ['#b45309', '!'], water: ['#168bb8', ''], blocked: ['#c34444', ''] }
  for (const [name, [color, glyph]] of Object.entries(icons)) {
    if (map.hasImage?.('construction-' + name)) continue
    const canvas = dom.createElement('canvas'); canvas.width = canvas.height = 64
    const ctx = canvas.getContext?.('2d')
    if (!ctx?.arc || !ctx?.stroke) continue
    ctx.scale(2, 2)
    ctx.beginPath(); ctx.arc(16, 16, 13, 0, Math.PI * 2)
    ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1.8; ctx.lineCap = 'round'
    if (name === 'water') {
      for (const y of [12, 17, 22]) {
        ctx.beginPath(); ctx.moveTo(8, y)
        ctx.bezierCurveTo(11, y - 4, 13, y + 4, 16, y)
        ctx.bezierCurveTo(19, y - 4, 21, y + 4, 24, y); ctx.stroke()
      }
    } else if (name === 'blocked') {
      ctx.beginPath(); ctx.arc(16, 16, 7, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(11, 21); ctx.lineTo(21, 11); ctx.stroke()
    } else {
      ctx.font = 'bold 19px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(glyph, 16, 17)
    }
    map.addImage('construction-' + name, ctx.getImageData(0, 0, 64, 64), { pixelRatio: 2 })
  }
  if (map.hasImage?.('construction-hatch')) return
  const canvas = dom.createElement('canvas'); canvas.width = canvas.height = 16
  const ctx = canvas.getContext?.('2d')
  if (!ctx?.stroke) return
  ctx.strokeStyle = '#34536c'; ctx.lineWidth = 1.5
  for (const start of [-16, 0, 16]) { ctx.beginPath(); ctx.moveTo(start, 16); ctx.lineTo(start + 16, 0); ctx.stroke() }
  map.addImage('construction-hatch', ctx.getImageData(0, 0, 16, 16))
}
