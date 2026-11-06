const collection = features => ({ type: 'FeatureCollection', features })
const finite = value => typeof value === 'number' && Number.isFinite(value)
const round = (value, digits = 3) => Number(value.toFixed(digits))
const delta = (before, after, digits = 3) => finite(before) && finite(after) ? round(after - before, digits) : null

// Freeze the original station-count scale and quadrant thresholds for both scenarios.
export function fixedSupplyComparison(beforeFeatures, afterFeatures) {
  const counts = beforeFeatures.map(feature => feature.properties.stationCount)
  const minimum = Math.min(...counts), maximum = Math.max(...counts)
  const range = maximum - minimum || 1
  const demandMean = beforeFeatures.reduce((sum, feature) => sum + feature.properties.demandIndex, 0) / beforeFeatures.length
  const supplyMean = counts.reduce((sum, count) => sum + round((count - minimum) / range), 0) / counts.length
  const normalize = features => collection(features.map(feature => {
    const p = feature.properties
    const supplyIndex = round((p.stationCount - minimum) / range)
    return { ...feature, properties: { ...p, supplyIndex, mismatchIndex: round(p.demandIndex - supplyIndex),
      supplyDemandType: p.demandIndex >= demandMean
        ? supplyIndex < supplyMean ? 'high-demand-low-supply' : 'high-demand-high-supply'
        : supplyIndex >= supplyMean ? 'low-demand-high-supply' : 'low-demand-low-supply' } }
  }))
  return { before: normalize(beforeFeatures), after: normalize(afterFeatures), reference: { minimum, maximum, range, demandMean, supplyMean } }
}

export function buildFacilityComparison(supply, evaluation) {
  const before = new Map(supply.before.features.map(feature => [String(feature.properties.id), feature.properties]))
  const serviceBefore = new Map(evaluation.before.grid.features.map(feature => [String(feature.properties.id), feature.properties]))
  const serviceAfter = new Map(evaluation.after.grid.features.map(feature => [String(feature.properties.id), feature.properties]))
  const status = value => value === null ? 'unknown' : value > 0 ? 'improved' : value < 0 ? 'declined' : 'unchanged'
  const grid = collection(supply.after.features.map(feature => {
    const p = feature.properties, id = String(p.id), previous = before.get(id)
    const beforeMatch = serviceBefore.get(id)?.demandMatchScore ?? null
    const afterMatch = serviceAfter.get(id)?.demandMatchScore ?? null
    const matchChange = delta(beforeMatch, afterMatch, 1)
    const balanceChange = round(Math.abs(previous.mismatchIndex) - Math.abs(p.mismatchIndex))
    return { ...feature, properties: { ...p,
      beforeStationCount: previous.stationCount, afterStationCount: p.stationCount,
      beforeMatch, afterMatch, matchChange, serviceStatus: status(matchChange),
      beforeMismatch: previous.mismatchIndex, afterMismatch: p.mismatchIndex, balanceChange, supplyStatus: status(balanceChange),
    } }
  }))
  const summarize = key => Object.fromEntries(['improved', 'declined', 'unchanged', 'unknown'].map(state =>
    [state, grid.features.filter(feature => feature.properties[key] === state).length]))
  const averageMismatch = features => round(features.reduce((sum, feature) => sum + Math.abs(feature.properties.mismatchIndex), 0) / features.length)
  const problemCount = features => features.filter(feature => feature.properties.supplyDemandType === 'high-demand-low-supply').length
  return { grid, service: summarize('serviceStatus'), supply: { ...summarize('supplyStatus'),
    beforeMeanMismatch: averageMismatch(supply.before.features), afterMeanMismatch: averageMismatch(supply.after.features),
    beforeProblemGrids: problemCount(supply.before.features), afterProblemGrids: problemCount(supply.after.features) },
    reference: supply.reference }
}

// One definition supplies both the map colors and its legend.
export function facilityComparisonView(preview) {
  const metric = preview.comparisonMetric === 'supply' ? 'supply' : 'service'
  const stage = preview.stage || 'after', change = stage === 'change'
  const result = preview.editing ? preview.result : null
  const label = metric === 'supply' ? '需求与站点数量的差距' : '充电服务指数（辅助）'
  const stateLabel = { before: '模拟前', after: '模拟后', change: '变化' }[stage]
  const data = collection((result?.comparison?.grid.features || []).map(feature => {
    const p = feature.properties
    const value = change ? (metric === 'supply' ? p.balanceChange : p.matchChange)
      : metric === 'supply' ? p[stage === 'before' ? 'beforeMismatch' : 'afterMismatch'] : p[stage === 'before' ? 'beforeMatch' : 'afterMatch']
    return { ...feature, properties: { ...p, comparisonValue: value, comparisonKnown: finite(value),
      comparisonStatus: metric === 'supply' ? p.supplyStatus : p.serviceStatus } }
  }))
  const known = ['==', ['get', 'comparisonKnown'], true]
  const value = ['coalesce', ['get', 'comparisonValue'], 0]
  const directional = ['match', ['get', 'comparisonStatus'], 'improved', '#00856a', 'declined', '#c65a32', '#cbd5d1']
  const stops = metric === 'supply' ? [-1, '#2166ac', -.4, '#67a9cf', 0, '#f7f7f7', .4, '#ef8a62', 1, '#b2182b']
    : [0, '#e9a16e', 50, '#f0d694', 100, '#4fb791']
  const color = ['case', known, change ? directional : ['interpolate', ['linear'], value, ...stops], '#dfe4e1']
  const opacity = change ? ['case', known, ['case', ['==', value, 0], .12, .78], .18] : .72
  const legend = !result?.comparison ? null : { id: 'facilityService', title: `${label} · ${stateLabel}`,
    ...(change ? { items: [{ color: '#00856a', label: metric === 'supply' ? '站点数量与需求更接近' : '模型服务指数提高' },
      { color: '#c65a32', label: metric === 'supply' ? '站点数量与需求差距变大' : '模型服务指数下降' },
      { color: '#cbd5d1', opacity: .3, label: '无变化（按显示精度）' },
      ...(metric === 'service' ? [{ color: '#dfe4e1', label: '无有效需求或能力未知' }] : [])],
      note: '颜色表示变化方向，点击网格查看幅度。' }
      : metric === 'supply' ? { gradient: 'linear-gradient(90deg, #2166ac 0%, #67a9cf 30%, #f7f7f7 50%, #ef8a62 70%, #b2182b 100%)',
        range: ['站点相对较多', '较接近', '需求相对较高'], note: '指数越接近 0，站点数量与需求越接近；两次比较使用同一尺度。' }
        : { gradient: 'linear-gradient(90deg, #e9a16e, #f0d694, #4fb791)', range: ['服务较弱 · 0 分', '服务较强 · 100 分'],
          note: '相对服务能力的模型评分，100 分不表示实际需求全满足；能力或需求资料不足时为灰色。' }) }
  return { data, color, opacity, legend, label, stateLabel }
}
