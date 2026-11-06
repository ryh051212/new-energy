import { computed, ref, nextTick, watch } from 'vue'
import { point, booleanPointInPolygon } from '@turf/turf'
import { validateAnalysisLocation, withinAnalysisRadius, assessLocalCharging } from '../models/localChargingSimulation.js'
import { facilityDataset, assignFacilityGrid, validateSandboxPoint } from '../models/facilitySandbox.js'
import { runCombinedFacilitySimulation } from '../models/combinedFacilitySimulation.js'
import { pointChargingDiagnostics } from '../models/facilityDiagnostics.js'
import { sitingRestriction } from '../models/sitingSelection.js'

export function useFacilitySandbox(props) {
  const active = computed(() => props.active), tool = ref('add'), stage = ref('after')
  const center = ref(null), locationName = ref('地图定位'), radiusMeters = ref(1000), dataScope = ref('recorded')
  const comparisonMetric = ref('service')
  const demandPois = computed(() => props.activityPois || props.demandPois || [])
  const dataset = computed(() => facilityDataset({ features: props.demandModel?.features || props.features || [], stations: props.stations, boundary: props.boundary }, dataScope.value))
  const baseline = computed(() => center.value ? assessLocalCharging({ center: center.value, radiusMeters: radiusMeters.value, stations: dataset.value.stations }) : null)
  const pointBaseline = computed(() => center.value ? pointChargingDiagnostics({ features: dataset.value.features, stations: dataset.value.stations,
    demandPois: demandPois.value, center: center.value }) : null)
  const additions = ref([]), removedIds = ref([]), selectedId = ref(''), selectedExistingId = ref('')
  const result = ref(null), running = ref(false), error = ref(''), notice = ref(''), revision = ref(0), resultRevision = ref(-1)
  let sequence = 0
  const dirty = computed(() => revision.value !== resultRevision.value)
  const selected = computed(() => additions.value.find(feature => feature.properties.id === selectedId.value))
  const selectedExisting = computed(() => dataset.value.stations.find(feature => String(feature.properties.id) === selectedExistingId.value))
  const changed = () => { revision.value++; error.value = ''; notice.value = ''; stage.value = 'after'; if (tool.value === 'inspect') tool.value = 'add' }
  function reset() {
    additions.value = []; removedIds.value = []; result.value = null; selectedId.value = ''; selectedExistingId.value = ''
    changed(); tool.value = 'add'; stage.value = 'after'
  }
  function setLocation(coordinates, name = '地图定位') {
    if (running.value || props.loading) return false
    try {
      center.value = validateAnalysisLocation(coordinates, props.boundary)
      locationName.value = name
      reset()
      notice.value = ''
      return true
    } catch (failure) { error.value = failure.message; return false }
  }
  function useDistrict() { if (running.value) return; if (center.value) { center.value = null; reset() } else { tool.value = 'add'; stage.value = 'after' } }
  function requireInScope(coordinates) {
    validateAnalysisLocation(coordinates, props.boundary)
    if (center.value && !withinAnalysisRadius(coordinates, center.value, radiusMeters.value)) throw new Error('请在定位周边范围内调整点位')
    if (!center.value) assignFacilityGrid(coordinates, dataset.value.features, props.boundary)
  }
  function select(id) { selectedId.value = id; selectedExistingId.value = ''; error.value = '' }
  function add(coordinates, configuration = {}) {
    if (running.value || props.loading) return
    try {
      requireInScope(coordinates)
      const grid = assignFacilityGrid(coordinates, dataset.value.features, props.boundary)
      const matches = dataset.value.features.filter(feature=>booleanPointInPolygon(point(coordinates),feature))
      const restriction = (matches.length ? matches : [grid]).map(feature=>sitingRestriction({ ...feature.properties, ...props.constructionFactors?.[String(feature.properties.id)] })).find(Boolean)
      if (restriction) throw new Error(restriction)
      const id = 'sandbox-' + (++sequence)
      const properties = { name: `模拟点位 ${sequence}`, chargeType: 'fast', pileCount: 1, powerKw: 60,
        gridId: String(grid.properties.id), ...configuration, id, isSynthetic: true, dataSource: 'sandbox', coordSystem: 'WGS84' }
      validateSandboxPoint(properties)
      const feature = point([...coordinates], properties)
      additions.value = [...additions.value, feature]
      changed(); select(id)
      return feature
    } catch (failure) { error.value = failure.message; return null }
  }
  function removeAddition(id) {
    if (running.value) return
    additions.value = additions.value.filter(feature => feature.properties.id !== id)
    changed()
    if (selectedId.value === id) selectedId.value = additions.value.at(-1)?.properties.id || ''
  }
  function toggleCandidate({ row, spec }) {
    if (running.value || props.loading || !row?.location) return false
    const existing = additions.value.filter(feature => String(feature.properties.planningGridId) === String(row.id))
    if (existing.length) { existing.forEach(feature => removeAddition(feature.properties.id)); return true }
    try {
      const coordinates = row.location.geometry.coordinates
      validateAnalysisLocation(coordinates, props.boundary)
      assignFacilityGrid(coordinates, dataset.value.features, props.boundary)
      const configuration = { ...spec, name: `${row.areaName || '网格 #' + row.id} · 拟建站`.slice(0,60),
        planningGridId: String(row.id), planningSource: 'siting' }
      validateSandboxPoint(configuration)
      // 选址导入属于共同方案；跨出旧编辑范围时扩大到全区，保留已有草稿。
      if (center.value && !withinAnalysisRadius(coordinates, center.value, radiusMeters.value)) {
        center.value = null
        locationName.value = '魏都区'
      }
      const feature = add(coordinates, configuration)
      if (feature) notice.value = '已同步选址站点，继续编辑或分析方案。'
      return !!feature
    } catch (failure) { error.value = failure.message; return false }
  }
  function includeCandidate({ row, spec = { chargeType: 'fast', pileCount: 2, powerKw: 60 } }) {
    if (running.value || props.loading || !row?.location) return false
    const existing = additions.value.find(feature => String(feature.properties.planningGridId) === String(row.id))
    if (existing) { select(existing.properties.id); return true }
    return toggleCandidate({ row, spec })
  }
  function toggleRemoval(id) {
    if (running.value || props.loading) return
    try {
      const key = String(id), feature = dataset.value.stations.find(feature => String(feature.properties.id) === key)
      if (!feature) throw new Error('这个站点已变化，请刷新后重试')
      requireInScope(feature.geometry.coordinates)
      removedIds.value = removedIds.value.includes(key) ? removedIds.value.filter(value => value !== key) : [...removedIds.value, key]
      changed(); selectedId.value = ''; selectedExistingId.value = ''
    } catch (failure) { error.value = failure.message }
  }
  function updateSelected(field, value) {
    if (running.value || !selected.value || !['name', 'chargeType', 'pileCount', 'powerKw'].includes(field)) return
    additions.value = additions.value.map(feature => feature.properties.id === selectedId.value
      ? { ...feature, properties: { ...feature.properties, [field]: value } } : feature)
    changed()
  }
  function replaceRoadPlan(features, removals = []) {
    if (running.value || props.loading) return false
    // Validate every proposed location before changing the current draft.
    for (const feature of features) {
      validateAnalysisLocation(feature.geometry.coordinates, props.boundary)
      const grid=assignFacilityGrid(feature.geometry.coordinates, dataset.value.features, props.boundary)
      const restriction=sitingRestriction({...grid.properties,...props.constructionFactors?.[String(grid.properties.id)]})
      if(restriction)throw new Error(restriction)
      validateSandboxPoint({...feature.properties,name:String(feature.properties.name || '推荐站点').slice(0,60)})
    }
    if(removals.some(id=>!dataset.value.stations.some(s=>String(s.properties.id)===String(id))))throw new Error('移除站点不属于当前研究基准')
    center.value = null
    reset()
    for (const feature of features) add(feature.geometry.coordinates, {...feature.properties,name:String(feature.properties.name || '推荐站点').slice(0,60)})
    removedIds.value = [...removals]
    notice.value = '道路规划方案已载入；可继续手工编辑，并重新分析。'
    return additions.value.length === features.length
  }
  function mapClick({ coordinates, sandboxId, stationId, removedId }) {
    if (!active.value || running.value || props.loading || tool.value === 'inspect') return
    if (tool.value === 'locate') { setLocation(coordinates); return }
    if (stage.value === 'before') return
    if (removedId) { toggleRemoval(removedId); return }
    if (sandboxId) { tool.value === 'remove' ? removeAddition(sandboxId) : select(sandboxId); return }
    if (stationId != null) {
      if (tool.value === 'remove') toggleRemoval(stationId)
      else {
        const feature = dataset.value.stations.find(feature => String(feature.properties.id) === String(stationId))
        try { requireInScope(feature?.geometry.coordinates); selectedExistingId.value = String(stationId); selectedId.value = ''; error.value = '' }
        catch (failure) { error.value = failure.message }
      }
      return
    }
    if (tool.value === 'remove') error.value = '请点击范围内要移除的站点；红色点位可点击恢复'
    else add(coordinates)
  }
  async function run() {
    if (running.value || props.loading) return
    running.value = true; error.value = ''
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      result.value = runCombinedFacilitySimulation({ center: center.value, radiusMeters: radiusMeters.value, features: dataset.value.features, stations: dataset.value.stations,
        demandPois: demandPois.value, boundary: props.boundary, additions: additions.value, removedIds: removedIds.value,
        constructionFactors:props.constructionFactors,constructionOptions:props.constructionOptions })
      resultRevision.value = revision.value; stage.value = 'after'; tool.value = 'inspect'
    } catch (failure) { error.value = failure.message }
    finally { running.value = false }
  }
  watch([radiusMeters, dataScope], () => { reset(); notice.value = '范围已切换，方案已重置。' })
  watch([() => props.stations, () => props.features, () => props.demandPois], () => { reset() })
  watch([() => props.constructionFactors, () => props.constructionOptions], changed, {deep:true})
  // Time and survey changes invalidate results while retaining the same editable station plan.
  watch(() => props.demandModel, () => { changed(); notice.value = '需求场景已更新，草稿已保留，请重新分析。' })
  watch(() => props.activityPois, changed)
  const preview = computed(() => ({ local: true, editing: active.value, stage: active.value ? stage.value : 'before', tool: tool.value,
    center: center.value, radiusMeters: radiusMeters.value, locationName: locationName.value, comparisonMetric: comparisonMetric.value, dataScope: dataScope.value,
    baseline: baseline.value, pointBaseline: pointBaseline.value, modelStations: dataset.value.stations, modelGrid: { type: 'FeatureCollection', features: dataset.value.features },
    points: additions.value, removedIds: removedIds.value, selectedId: selectedId.value,
    result: active.value && !dirty.value ? result.value : null, analysisResult: !dirty.value ? result.value : null, dirty: dirty.value, features: [] }))
  return { active, tool, stage, center, locationName, radiusMeters, dataScope, dataset, baseline, pointBaseline, comparisonMetric,
    additions, removedIds, selectedId, selected, selectedExisting, result, running, dirty, error, notice,
    preview, setLocation, useDistrict, select, add, removeAddition, toggleCandidate, includeCandidate, toggleRemoval, updateSelected, replaceRoadPlan, mapClick, run, reset }
}
