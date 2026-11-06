import { ref } from 'vue'
import { bbox, booleanPointInPolygon } from '@turf/turf'
import { toMapCoordinate } from '../config/basemaps.js'
import { searchPois } from '../api/poiSearch.js'
import { validCoordinates } from '../../stations/models/stations.js'

// 每个地图实例独立持有防抖、请求和面板状态，卸载时统一释放。
export function useStationSearch({ getMap, getBoundary, getStations, getPois = getStations,
  activeBasemap, loading, signal, quickPanelOpen, boundaryPanelOpen, closeMapPanels,
  closeMapPanelsOnEscape, onSelect, onNotice, fetcher,
  localStorage = globalThis.localStorage, document = globalThis.document, timers = globalThis }) {
  const stationKeyword = ref(''), searchHistory = ref(readSearchHistory())
  const searchPanelOpen = ref(false), matchingStations = ref([]), searchResultCount = ref(null)
  const searchError = ref(''), searchPending = ref(false), searchSelectionMessage = ref('')
  const searchActiveIndex = ref(-1), HISTORY_KEY = 'weidu-station-search-history-v1'
  let requestId = 0, debounceTimer, requestController, composing = false, disposed = false

  function readSearchHistory() {
    try {
      const values = JSON.parse(localStorage.getItem('weidu-station-search-history-v1') || '[]')
      return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && value.trim()))].slice(0, 10) : []
    } catch { return [] }
  }
  function rememberSearch(keyword) {
    const name = keyword.trim()
    if (!name) return
    searchHistory.value = [name, ...searchHistory.value.filter(value => value !== name)].slice(0, 10)
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(searchHistory.value)) } catch { /* 本地记录可选。 */ }
  }
  function clearSearchHistory() {
    searchHistory.value = []
    try { localStorage.removeItem(HISTORY_KEY) } catch { /* 本地记录可选。 */ }
  }
  function invalidateSearch() {
    requestId++
    timers.clearTimeout(debounceTimer)
    debounceTimer = undefined
    requestController?.abort()
    requestController = undefined
    searchPending.value = false
  }
  function clearSearch() {
    invalidateSearch()
    stationKeyword.value = ''
    matchingStations.value = []
    searchResultCount.value = null
    searchActiveIndex.value = -1
    searchError.value = ''
    searchSelectionMessage.value = ''
    closeSearchPanel()
  }
  function schedulePoiSearch(event) {
    // 输入法组词中不查询，等 compositionend 后再计时。
    if (composing || event?.isComposing) return
    invalidateSearch()
    matchingStations.value = []
    searchResultCount.value = null
    searchActiveIndex.value = -1
    searchError.value = ''
    searchSelectionMessage.value = ''
    if (!stationKeyword.value.trim()) { clearSearch(); return }
    openSearchPanel()
    searchPending.value = true
    debounceTimer = timers.setTimeout(() => { void searchStation({ suggestions: true }) }, 300)
  }
  function startSearchComposition() { composing = true; invalidateSearch() }
  function finishSearchComposition(event) {
    composing = false
    stationKeyword.value = event.target.value
    schedulePoiSearch()
  }
  async function searchStation(options = {}) {
    const map = getMap()
    invalidateSearch()
    if (!map || loading.value || signal.aborted || disposed || composing) return
    const keyword = stationKeyword.value.trim()
    if (!keyword) { clearSearch(); return }
    const current = requestId
    const controller = requestController = new AbortController()
    const requestSignal = AbortSignal.any([signal, controller.signal])
    searchPending.value = true
    searchError.value = ''
    matchingStations.value = []
    searchResultCount.value = null
    searchActiveIndex.value = -1
    openSearchPanel()
    try {
      let features
      try {
        features = await searchPois(keyword, { signal: requestSignal, fetcher })
      } catch (error) {
        if (requestSignal.aborted) return
        // 沿用已有降级，明确告知结果仅限已载入数据。
        features = getPois().filter(feature => feature.properties?.name?.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))
        searchError.value = '搜索服务暂不可用，显示已加载数据中的匹配结果。'
        onNotice()
      }
      if (requestSignal.aborted || current !== requestId || disposed) return
      const seen = new Set()
      matchingStations.value = features.filter(feature => {
        if (feature.geometry?.type !== 'Point' || !validCoordinates(feature.geometry.coordinates)
            || !getBoundary().some(polygon => booleanPointInPolygon(feature, polygon))) return false
        const key = feature.properties.searchId || JSON.stringify([feature.properties.id, feature.geometry.coordinates])
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 20)
      searchResultCount.value = matchingStations.value.length
      if (matchingStations.value.length) rememberSearch(keyword)
      // 建议仅更新列表，选中后才定位；手动提交延续原来的单结果直达。
      if (!options.suggestions && matchingStations.value.length === 1) {
        selectSearchStation(matchingStations.value[0])
      } else if (!options.suggestions && matchingStations.value.length > 1) {
        const bounds = bbox({ type: 'FeatureCollection', features: matchingStations.value })
        map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]].map(coordinate => toMapCoordinate(coordinate, activeBasemap.value)),
          { padding: 70, maxZoom: 14, duration: 600 })
      }
    } finally {
      if (current === requestId && !disposed) { searchPending.value = false; requestController = undefined }
    }
  }
  function openSearchPanel() {
    if (disposed) return
    closeMapPanels(false)
    searchPanelOpen.value = true
    document.addEventListener('pointerdown', closeSearchPanelOutside)
    document.addEventListener('keydown', closeMapPanelsOnEscape)
  }
  function closeSearchPanelOutside(event) {
    if (!event?.target?.closest?.('.map-search, .map-search-panel')) closeSearchPanel()
  }
  function closeSearchPanel() {
    invalidateSearch()
    searchPanelOpen.value = false
    searchActiveIndex.value = -1
    document.removeEventListener('pointerdown', closeSearchPanelOutside)
    if (!quickPanelOpen.value && !boundaryPanelOpen.value) document.removeEventListener('keydown', closeMapPanelsOnEscape)
  }
  function useSearchHistory(keyword) { stationKeyword.value = keyword; return searchStation() }
  function selectSearchStation(feature) {
    if (!getMap() || signal.aborted || disposed || feature?.geometry?.type !== 'Point'
        || !validCoordinates(feature.geometry.coordinates)) return
    invalidateSearch()
    if (onSelect(feature) === false) return
    rememberSearch(feature.properties.name || stationKeyword.value)
    searchSelectionMessage.value = '地图已定位至：' + feature.properties.name
    stationKeyword.value = ''
    searchResultCount.value = null
    matchingStations.value = []
    closeSearchPanel()
  }
  function searchOptionId(index) { return 'poi-search-option-' + index }
  function handleSearchKeydown(event) {
    if (composing || event.isComposing) return
    const count = matchingStations.value.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!count) return
      openSearchPanel()
      searchActiveIndex.value = event.key === 'ArrowDown'
        ? (searchActiveIndex.value + 1) % count : (searchActiveIndex.value < 0 ? count - 1 : (searchActiveIndex.value - 1 + count) % count)
      document.getElementById?.(searchOptionId(searchActiveIndex.value))?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && searchPanelOpen.value && searchActiveIndex.value >= 0) {
      event.preventDefault()
      selectSearchStation(matchingStations.value[searchActiveIndex.value])
    }
  }
  function disposeSearch() { disposed = true; closeSearchPanel() }
  return { stationKeyword, searchHistory, searchPanelOpen, matchingStations, searchResultCount,
    searchError, searchPending, searchSelectionMessage, searchActiveIndex, searchOptionId,
    searchStation, rememberSearch, clearSearchHistory, openSearchPanel, closeSearchPanel, useSearchHistory,
    selectSearchStation, invalidateSearch, disposeSearch, clearSearch, schedulePoiSearch,
    startSearchComposition, finishSearchComposition, handleSearchKeydown }
}
