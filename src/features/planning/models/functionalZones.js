// 用户提供的活动系数表示相对情景，不是实测充电次数。
export const DEMAND_SCENARIOS = [
  { id: 'weekday-day', label: '工作日白天', coefficients: { residential: .35, work: 1, shopping: .55, leisure: .35, public: .75 } },
  { id: 'weekday-night', label: '工作日晚间', coefficients: { residential: 1, work: .15, shopping: .8, leisure: .8, public: .45 } },
  { id: 'weekend', label: '周末', coefficients: { residential: .7, work: .25, shopping: 1, leisure: 1, public: .65 } },
]
export const ACTIVITY_TYPES = [
  { id: 'residential', label: '居住', color: '#7c6bd6', fields: ['populationModelCount'] },
  { id: 'work', label: '工作', color: '#377bc1', fields: ['workplaceCount'] },
  { id: 'shopping', label: '购物', color: '#e48a32', fields: ['shoppingCount', 'commercialCount'] },
  { id: 'leisure', label: '休闲', color: '#209c83', fields: ['leisureCount', 'activityCount'] },
  { id: 'public', label: '公共服务', color: '#cf6388', fields: ['publicServiceCount'] },
]
export const FUNCTIONAL_ZONES = [...ACTIVITY_TYPES,
  { id: 'mixed', label: '混合功能', color: '#9a8248' },
  { id: 'unknown', label: '资料不足', color: '#a5afbd' }]
export const SCENARIO_SCORE_WEIGHTS = { demand: 50, gap: 25, parking: 15, road: 10 }
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
export const demandScenario = id => DEMAND_SCENARIOS.find(scene => scene.id === id) || DEMAND_SCENARIOS[0]

// 只按类别识别活动；多类别 POI 共享一份活动权重，不通过地名推断。
export function poiActivityTypes(poi) {
  const properties = poi.properties || {}
  const categories = new Set(Array.isArray(properties.categories) ? properties.categories : [properties.category])
  const result = []
  if (categories.has('residential')) result.push('residential')
  if (['work','office', 'company', 'industrial_park'].some(key => categories.has(key))) result.push('work')
  if (['commercial', 'mall', 'supermarket', 'shopping','restaurant'].some(key => categories.has(key))) result.push('shopping')
  if (['park', 'leisure'].some(key => categories.has(key))) result.push('leisure')
  if (['public_service','hospital', 'school', 'transport','parking','government_transport'].some(key => categories.has(key))) result.push('public')
  return result
}

export function mergeActivityPois(original = [], facilities = []) {
  const records = new Map()
  for (const feature of [...original, ...facilities]) {
    if (feature.geometry?.type !== 'Point' || !poiActivityTypes(feature).length) continue
    const properties = feature.properties || {}
    const key = properties.id != null
      ? String(properties.id)
      : JSON.stringify([feature.geometry.coordinates, properties.name])
    const previous = records.get(key)
    const categories = [...new Set([
      ...(previous?.properties.categories || []),
      ...(properties.categories || [properties.category]),
    ].filter(Boolean))]
    records.set(key, { ...feature, properties: { ...previous?.properties, ...properties, categories } })
  }
  return [...records.values()]
}

export function functionalZoneModel(features = [], overrides = {}) {
  const rows = features.map(feature => {
    const properties = { ...feature.properties, ...overrides[String(feature.properties.id)] }
    const counts = Object.fromEntries(ACTIVITY_TYPES.map(activity => {
      let value = activity.fields.map(field => properties[field]).find(number)
      if (activity.id === 'public' && value == null && number(properties.hospitalCount) && number(properties.schoolCount)) {
        value = properties.hospitalCount + properties.schoolCount
      }
      return [activity.id, value ?? null]
    }))
    return { feature, counts }
  })
  // 每类活动与总强度都使用全区固定尺度，切换时段不会重新拉伸。
  const maxima = Object.fromEntries(ACTIVITY_TYPES.map(activity => [activity.id,
    Math.max(0, ...rows.map(row => row.counts[activity.id] ?? 0))]))
  const profiles = rows.map(row => {
    const activityIntensity = {}
    for (const activity of ACTIVITY_TYPES) {
      const count = row.counts[activity.id]
      activityIntensity[activity.id] = null
      if (count == null) continue

      activityIntensity[activity.id] = 0
      if (maxima[activity.id] > 0) {
        activityIntensity[activity.id] = count / maxima[activity.id]
      }
    }
    const total = Object.values(activityIntensity).reduce((sum, value) => sum + (value ?? 0), 0)
    const shares = Object.fromEntries(ACTIVITY_TYPES.map(activity => [activity.id, total ? (activityIntensity[activity.id] ?? 0) / total : 0]))
    let dominant = 'unknown'
    for (const activity of ACTIVITY_TYPES) {
      if (shares[activity.id] > (shares[dominant] || 0)) dominant = activity.id
    }
    let zone = 'unknown'
    if (total) {
      zone = 'mixed'
      if (shares[dominant] >= .5) zone = dominant
    }
    return { ...row, activityIntensity, shares, total, zone }
  })
  return { profiles, maxima, scale: Math.max(0, ...profiles.map(row => row.total)) }
}

export function applyDemandScenario(model, scenarioId = 'weekday-day', weights = {}) {
  const scenario = demandScenario(scenarioId)
  const features = model.profiles.map(row => {
    const contributions = {}
    for (const activity of ACTIVITY_TYPES) {
      const intensity = row.activityIntensity[activity.id]
      contributions[activity.id] = null
      if (intensity == null) continue

      contributions[activity.id] = 0
      if (model.scale) {
        contributions[activity.id] = intensity * (weights[activity.id] ?? 1)
          * scenario.coefficients[activity.id] / model.scale
      }
    }
    const known = Object.values(contributions).some(value => value != null)
    const demand = known ? Object.values(contributions).reduce((sum, value) => sum + (value ?? 0), 0) : null
    const zone = FUNCTIONAL_ZONES.find(item => item.id === row.zone)
    let demandTier = 'unknown'
    if (demand != null && row.zone !== 'unknown') {
      if (demand >= .75) {
        demandTier = 'high'
      } else if (demand >= .4) {
        demandTier = 'medium'
      } else {
        demandTier = 'low'
      }
    }
    return {
      ...row.feature,
      properties: {
        ...row.feature.properties,
        originalDemandIndex: row.feature.properties.originalDemandIndex ?? row.feature.properties.demandIndex,
        demandIndex: demand ?? 0,
        scenarioDemandIndex: demand,
        scenarioActivityDemand: contributions,
        activityCounts: row.counts,
        activityShares: row.shares,
        functionalZone: row.zone,
        functionalZoneLabel: zone.label,
        functionalZoneColor: zone.color,
        activityCompleteness: Object.values(row.counts).filter(value => value != null).length,
        demandScenario: scenario.id,
        demandScenarioLabel: scenario.label,
        demandTier,
      },
    }
  })
  // 四象限使用当前情景需求，供给保留现有数据尺度。
  const demandMean = features.length ? features.reduce((sum, feature) => sum + feature.properties.demandIndex, 0) / features.length : 0
  const supplyMean = features.length ? features.reduce((sum, feature) => sum + (feature.properties.supplyIndex || 0), 0) / features.length : 0
  for (const feature of features) {
    const properties = feature.properties
    const highDemand = properties.demandIndex >= demandMean
    const highSupply = (properties.supplyIndex || 0) >= supplyMean
    properties.mismatchIndex = properties.demandIndex - (properties.supplyIndex || 0)
    properties.supplyDemandType = `${highDemand ? 'high' : 'low'}-demand-${highSupply ? 'high' : 'low'}-supply`
  }
  return { key: scenario.id, label: scenario.label, features, scale: model.scale }
}

export function scoreScenarioRows(rows, weights = SCENARIO_SCORE_WEIGHTS) {
  return rows.map(row => {
    const demand = row.feature.properties.scenarioDemandIndex
    const factors = { demand: number(demand) ? demand : null,
      gap: row.nearestMeters == null ? 1 : Math.min(1, row.nearestMeters / 1000),
      parking: row.indicators.parking, road: row.indicators.road }
    const terms = Object.entries(factors).filter(([key, value]) => value != null && number(weights[key]) && weights[key] > 0)
    const denominator = terms.reduce((sum, [key]) => sum + weights[key], 0)
    let score = null
    if (number(demand) && denominator) {
      score = 0
      if (demand !== 0) {
        const weightedTotal = terms.reduce((sum, [key, value]) => sum + value * weights[key], 0)
        score = weightedTotal / denominator * 100
      }
    }
    return {
      ...row,
      score,
      scenarioFactors: factors,
      functionalZone: row.feature.properties.functionalZone,
      functionalZoneLabel: row.feature.properties.functionalZoneLabel,
    }
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id, 'zh-CN', { numeric: true }))
}
