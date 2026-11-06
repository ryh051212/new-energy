import { circle, booleanIntersects, featureCollection, intersect } from '@turf/turf'
import { runFacilitySimulation } from './facilitySandbox.js'
import { compareChargingDemand } from './facilityDemand.js'
import { fixedSupplyComparison, buildFacilityComparison } from './facilityComparison.js'
import { runLocalChargingSimulation, withinAnalysisRadius } from './localChargingSimulation.js'
import { analyzeFacilityDiagnostics } from './facilityDiagnostics.js'
import { evaluateStationPlan, evaluatePlanConstruction } from './stationPlanImpact.js'

export function facilityScopeFeatures(features, center, radiusMeters) {
  if (!center) return features
  const area = circle(center, radiusMeters / 1000, { steps: 64 })
  return features.filter(feature => booleanIntersects(feature, area)).flatMap(feature => {
    const clipped = intersect(featureCollection([feature, area]))
    return clipped ? [{ ...clipped, properties: { ...feature.properties } }] : []
  })
}

export function runCombinedFacilitySimulation(input) {
  const { center = null, radiusMeters = 1000, features, stations, boundary, demandPois = [], additions = [], removedIds = [] } = input
  const local = center ? runLocalChargingSimulation({ center, radiusMeters, stations, boundary, additions, removedIds }) : null
  const macro = runFacilitySimulation({ features, stations, boundary, demandPois, additions, removedIds })
  if (center) {
    macro.evaluation = compareChargingDemand({ features, beforeStations: stations, afterStations: macro.stations, demandPois, scope: { center, radiusMeters } })
    macro.comparison = buildFacilityComparison(fixedSupplyComparison(features, macro.grid.features), macro.evaluation)
    macro.comparison.grid.features = facilityScopeFeatures(macro.comparison.grid.features, center, radiusMeters)
    const scoped = macro.comparison.grid.features
    const average = field => scoped.length ? scoped.reduce((sum, feature) => sum + Math.abs(feature.properties[field]), 0) / scoped.length : null
    macro.comparison.supply.beforeMeanMismatch = average('beforeMismatch')
    macro.comparison.supply.afterMeanMismatch = average('afterMismatch')
    for (const state of ['improved', 'declined', 'unchanged', 'unknown']) {
      macro.comparison.supply[state] = scoped.filter(feature => feature.properties.supplyStatus === state).length
      macro.comparison.service[state] = scoped.filter(feature => feature.properties.serviceStatus === state).length
    }
  }
  const changes = macro.evaluation.locations.features.filter(feature => !feature.properties.fallback && feature.properties.locationStatus !== 'unchanged')
  const diagnostics = analyzeFacilityDiagnostics({ features, beforeStations: stations, afterStations: macro.stations, demandPois, center, radiusMeters, boundary })
  const scopedStations = stations.filter(feature => !center || withinAnalysisRadius(feature.geometry.coordinates, center, radiusMeters))
  const planningImpact = evaluateStationPlan({ features, beforeStations:stations, afterStations:macro.stations, demandPois, scope:center?{center,radiusMeters}:null })
  planningImpact.construction = evaluatePlanConstruction({features,beforeStations:stations,additions,removedIds,boundary,factors:input.constructionFactors,options:input.constructionOptions})
  return { ...(local || { local: true, center: null, radiusMeters, before: { stationCount: scopedStations.length }, after: { stationCount: macro.stations.length }, verdict: macro.evaluation.verdict }),
    macro, diagnostics, planningImpact, changedPlaces: changes, addedCount: additions.length, removedCount: removedIds.length,
    stations: macro.stations }
}
