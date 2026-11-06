import { ACTIVITY_TYPES } from './functionalZones.js'
import { CHARGING_START_PERCENT, PUBLIC_CHARGING_Q, ACTIVITY_WEIGHT } from './chargingStartScenario.js'

const isKnownValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const activityTypes = ACTIVITY_TYPES.map(activity => activity.id)
const dayTypes = ['weekday', 'weekend']
const scenarios = ['low', 'medium', 'high']

// 使用包含端点的百分位插值；已知零值参与统计，缺失值不参与。
export function percentile95(values) {
  const sorted = values.filter(isKnownValue).sort((a, b) => a - b)
  if (!sorted.length) return null

  const index = (sorted.length - 1) * 0.95
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

export function spatialDemandIntensity(model, populationData) {
  const populationByGrid = new Map()
  for (const feature of populationData?.features || []) {
    populationByGrid.set(String(feature.properties.id), feature.properties)
  }

  const rows = []
  for (const profile of model?.profiles || []) {
    const id = String(profile.feature.properties.id)
    const population = populationByGrid.get(id)
    const area = population?.areaKm2
    const values = { ...profile.counts, residential: population?.populationModelCount }
    const density = {}

    for (const activity of activityTypes) {
      density[activity] = null
      if (isKnownValue(values[activity]) && isKnownValue(area) && area > 0) {
        density[activity] = values[activity] / area
      }
    }
    rows.push({ id, density })
  }

  const benchmarks = {}
  for (const activity of activityTypes) {
    const values = rows.map(row => row.density[activity]).filter(isKnownValue)
    const p95 = percentile95(values)
    const nonzeroValues = values.filter(value => value > 0)
    let reference = null
    let coverage = 'standard'

    // 稀疏类别的全量 P95 可能为零，回退到非零样本，保留资料不足标记。
    if (p95 > 0) {
      reference = p95
    } else if (nonzeroValues.length) {
      reference = percentile95(nonzeroValues)
    }

    if (p95 == null) {
      coverage = 'missing'
    } else if (!nonzeroValues.length) {
      coverage = 'zero'
    } else if (p95 === 0) {
      coverage = 'insufficient'
    }
    benchmarks[activity] = { p95, reference, coverage }
  }

  for (const row of rows) {
    row.intensity = {}
    for (const activity of activityTypes) {
      const value = row.density[activity]
      const reference = benchmarks[activity].reference
      row.intensity[activity] = null
      if (!isKnownValue(value)) continue

      if (value === 0) {
        row.intensity[activity] = 0
      } else if (reference > 0) {
        row.intensity[activity] = Math.min(1, value / reference)
      }
    }
  }
  return { rows, benchmarks }
}

// 地图当前时刻与弹窗完整曲线共用同一公式，缺一类资料就保留未知总值。
export function temporalDemandPoint(row, scenario, day, hour) {
  const contributions = {}
  let complete = true
  let total = 0

  for (const activity of activityTypes) {
    const intensity = row?.intensity[activity]
    const publicChargingFactor = PUBLIC_CHARGING_Q[scenario]?.[activity]
    const percent = CHARGING_START_PERCENT[activity]?.[day]?.[hour]
    if (!isKnownValue(intensity) || !isKnownValue(publicChargingFactor) || !isKnownValue(percent)) {
      contributions[activity] = null
      complete = false
      continue
    }

    const contribution = ACTIVITY_WEIGHT * intensity * publicChargingFactor * percent / 100
    contributions[activity] = contribution
    total += contribution
  }
  return { hour, contributions, demandIndex: complete ? total : null }
}

export function temporalDemandScale(spatial) {
  // 所有网格、日期类型与情景共用一个峰值，切换选择时不重新拉伸尺度。
  let scale = 0
  for (const row of spatial.rows) {
    for (const scenario of scenarios) {
      for (const day of dayTypes) {
        for (let hour = 0; hour < 24; hour++) {
          const value = temporalDemandPoint(row, scenario, day, hour).demandIndex
          if (isKnownValue(value)) scale = Math.max(scale, value)
        }
      }
    }
  }
  return scale
}

export function currentTemporalDemandGrid(features, spatial, scale, selection) {
  const rowsById = new Map(spatial.rows.map(row => [row.id, row]))
  const { scenario, day, hour } = selection
  const selectedFeatures = features.map(feature => {
    const row = rowsById.get(String(feature.properties.id))
    const value = temporalDemandPoint(row, scenario, day, hour).demandIndex
    let normalizedValue = null
    if (value != null) {
      normalizedValue = 0
      if (scale > 0) normalizedValue = value / scale
    }

    return {
      ...feature,
      properties: {
        ...feature.properties,
        temporalDemandIndex: value,
        temporalDemandNorm: normalizedValue,
      },
    }
  })
  return { type: 'FeatureCollection', features: selectedFeatures }
}

// 页面可以传入缓存的空间强度与全局尺度，打开弹窗时不必重复计算。
export function buildGridTemporalDemand(model, gridId, populationData, prepared) {
  const spatial = prepared?.spatial ?? spatialDemandIntensity(model, populationData)
  const target = spatial.rows.find(row => row.id === String(gridId))
  const scale = prepared?.scale ?? temporalDemandScale(spatial)
  const series = {}

  for (const scenario of scenarios) {
    series[scenario] = {}
    for (const day of dayTypes) {
      series[scenario][day] = []
      for (let hour = 0; hour < 24; hour++) {
        series[scenario][day].push(temporalDemandPoint(target, scenario, day, hour))
      }
    }
  }

  return {
    series,
    scale,
    available: !!target && activityTypes.every(activity => isKnownValue(target.intensity[activity])),
    missing: activityTypes.filter(activity => !isKnownValue(target?.intensity[activity])),
    benchmarks: spatial.benchmarks,
    intensity: target?.intensity ?? {},
    density: target?.density ?? {},
  }
}
