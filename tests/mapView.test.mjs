import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as turf from '@turf/turf'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'
import { chargingMapIcon, chargingMapColor, registerChargingIcons } from '../src/utils/chargingIcons.js'
import { AMAP_STANDARD_SOURCE, toMapCoordinate, fromMapCoordinate, toMapGeoJSON } from '../src/utils/basemaps.js'
import { facilityComparisonView, fixedSupplyComparison, buildFacilityComparison } from '../src/utils/facilityComparison.js'
import { planningRows, planningBlindSpots, planningVoronoi } from '../src/utils/plannerPss.js'
import { stationConfiguration } from '../src/utils/facilityDemand.js'
import { FACILITY_MAP_LAYERS, facilityPointLayers, facilityPopupLines } from '../src/utils/facilityMapLayers.js'

const facilityFixture = { type: 'FeatureCollection', features: [
  turf.point([113.83, 34.04], { id: 'parking-1', name: '测试停车场', address: '测试路 1 号', categories: ['parking', 'mall'], fetchedAt: '2026-10-16T12:00:00+08:00' }),
  turf.point([113.84, 34.04], { id: 'school-1', name: '测试学校', categories: ['school'] }),
], metadata: { initialized: true, coordSystem: 'WGS84', hasMore: false } }

// 执行 MapView 真实的内联事件代码，使用本地数据和模拟地图检查功能。
async function mount(failFile = '', leaveDuringFetch = false, activeRoute = '/', historyStorage = new Map(), locationOptions = {}) {
  const source = fs.readFileSync(new URL('../src/components/MapView.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup>')[1].split('</script>')[0]
    .replace(/^import\b[\s\S]*?["'][^"']+["'];?[ \t]*\r?\n/gm, '').replaceAll('import.meta.env.BASE_URL', '"/"')
  const handlers = {}
  const sources = {}
  const requests = []
  const filters = {}
  const popups = []
  const visibility = {}
  const paint = {}
  const bounds = []
  const flights = []
  const locationRequests = []
  const markers = []
  const accessRequests = []
  const listeners = new Map()
  let options
  let cameraCenter
  let removed = false
  let requestSignal
  let ready
  let cleanup
  const map = {
    doubleClickZoom: { enable() {}, disable() {} },
    off() {},
    on(name, layer, callback) { handlers[`${name}:${typeof layer === 'string' ? layer : ''}`] = callback || layer },
    getSource(name) {
      assert.equal(removed, false, '卸载后不能继续访问地图')
      return { setData(data) { sources[name] = data } }
    },
    getLayer() { return {} },
    setLayoutProperty(id, property, value) { visibility[id] = value },
    setPaintProperty(id, property, value) { paint[`${id}:${property}`] = value },
    fitBounds(...args) { bounds.push(args) }, getCanvas() { return { style: {} } }, resize() {}, remove() { removed = true },
    flyTo(options) { cameraCenter = options.center; flights.push(options) },
    getCenter() { return { toArray: () => Array.from(cameraCenter) } },
    jumpTo(options) { cameraCenter = options.center },
    queryRenderedFeatures() { return [] },
    setFilter(id, filter) { filters[id] = filter },
  }
  class Popup {
    constructor() { popups.push(this) }
    setLngLat() { return this }
    setDOMContent(content) { this.content = content; return this }
    addTo() { return this }
    remove() { this.removed = true }
  }
  class Marker {
    constructor() { markers.push(this) }
    setLngLat(coordinates) { assert.equal(removed, false); this.coordinates = coordinates; return this }
    addTo() { assert.equal(removed, false); return this }
    remove() { this.removed = true }
  }
  const context = vm.createContext({
    defineProps: () => ({ activeRoute, authenticated: locationOptions.authenticated ?? true }), watch() {}, nextTick: Vue.nextTick,
    defineEmits: () => (event, payload) => accessRequests.push({ event, payload }),
    ref: value => ({ value }), computed: callback => ({ get value() { return callback() } }),
    onMounted: callback => { ready = callback },
    onBeforeUnmount: callback => { cleanup = callback }, turf, workerUrl: '', chargingMapIcon, chargingMapColor, registerChargingIcons,
    AMAP_STANDARD_SOURCE, toMapCoordinate, fromMapCoordinate, toMapGeoJSON, facilityComparisonView, planningRows, planningBlindSpots, planningVoronoi, stationConfiguration,
    FACILITY_MAP_LAYERS, facilityPointLayers, facilityPopupLines,
    maplibregl: { setWorkerUrl() {}, Map: function (config) { options = config; cameraCenter = config.center; return map }, Popup, Marker },
    isSecureContext: locationOptions.secure ?? true,
    navigator: { geolocation: locationOptions.supported === false ? undefined : { getCurrentPosition(success, failure, options) {
      if (locationOptions.throws) throw Object.assign(new Error('denied'), { name: 'SecurityError' })
      locationRequests.push({ success, failure, options })
    } } },
    AbortController, AbortSignal, ResizeObserver: class { observe() {} disconnect() {} },
    console: { error() {}, log() {} },
    localStorage: {
      getItem(key) { return historyStorage.get(key) ?? null },
      setItem(key, value) { historyStorage.set(key, value) },
      removeItem(key) { historyStorage.delete(key) },
    },
    document: {
      createElement() { return { children: [], append(child) { this.children.push(child) } } },
      addEventListener(name, callback) { listeners.set(name, callback) },
      removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name) },
    },
    fetch: async (url, config) => {
      requests.push(url)
      if (config?.signal) requestSignal = config.signal
      if (new URL(url, 'http://localhost').pathname === '/api/facility-pois') {
        if (locationOptions.facilityFetch) return locationOptions.facilityFetch(url, config)
        return { ok: true, json: async () => structuredClone(facilityFixture) }
      }
      const filename = ({ '/api/stations': 'stations.json', '/api/boundary': 'weidu.json',
        '/api/residential-pois': 'residential-pois.json', '/api/commercial-pois': 'commercial-pois.json',
        '/api/hex-grid': 'hex-grid.json' })[new URL(url, 'http://localhost').pathname]
      return { ok: filename !== failFile && !(failFile === 'api-only' && url.includes('/api/stations')), json: async () => {
        if (filename === 'health') return { status: 'ok' }
        // 模拟响应解析期间离开页面，此时异步回调仍可能返回。
        if (leaveDuringFetch && filename === 'stations.json') cleanup()
        const data = JSON.parse(fs.readFileSync(new URL(`../public/geojson/${filename}`, import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
        const name = new URL(url, 'http://localhost').searchParams.get('name')
        if (name) data.features = data.features.filter(feature => feature.properties.name.includes(name))
        return data
      } }
    },
  })
  vm.runInContext(script, context)
  ready()
  locationOptions.beforeLoad?.(locationRequests, context)
  await handlers['load:']()
  return { sources, handlers, popups, map, cleanup, options, visibility, paint, bounds, flights, listeners, filters, historyStorage, requestSignal, requests, context, locationRequests, markers, accessRequests,
    state: vm.runInContext('({ count: weiduStationCount.value, commercialCount: commercialCount.value, error: loadError.value, warning: gridWarning.value, loading: loading.value })', context) }
}

test('游客可浏览地图、测距与切换图层，分析入口登录后继续原操作', async () => {
  const app = await mount('', false, '/', new Map(), { authenticated: false })
  assert.equal(vm.runInContext('analysisPanel.value', app.context), 'map')
  vm.runInContext("toggleMeasure(); toggleLayer('commercial', true); setBasemap('satellite')", app.context)
  assert.equal(vm.runInContext('measuring.value', app.context), true)
  assert.equal(app.visibility['commercial-circle'], 'visible')
  assert.equal(app.accessRequests.length, 0)
  for (const panel of ['overview', 'siting', 'sandbox', 'grid', 'carbon']) {
    app.context.requestedPanel = panel
    vm.runInContext('selectAnalysisPanel(requestedPanel)', app.context)
    assert.equal(vm.runInContext('analysisPanel.value', app.context), 'map')
    assert.equal(app.accessRequests.at(-1).event, 'require-login')
  }
  vm.runInContext('props.authenticated = true', app.context)
  app.accessRequests.at(-1).payload.run()
  assert.equal(vm.runInContext('analysisPanel.value', app.context), 'carbon')
  app.cleanup()
})

test('规划首页不主动定位，手动定位后数据迟到保留当前位置，切换底图复用标记', async () => {
  const coordinates = [113.83, 34.04]
  const app = await mount('', false, '/', new Map(), {
    beforeLoad(requests, context) {
      assert.equal(requests.length, 0, '首页默认研究区，不请求设备位置')
      vm.runInContext('locateUser()', context)
      requests[0].success({ coords: { longitude: coordinates[0], latitude: coordinates[1] } })
    },
  })
  assert.equal(app.locationRequests.length, 1)
  assert.equal(app.bounds.length, 0, '研究区数据返回不能覆盖定位视野')
  assert.deepEqual(app.flights.at(-1).center, toMapCoordinate(coordinates))
  assert.equal(app.flights.at(-1).zoom, 15)
  assert.equal(app.markers.length, 1)
  vm.runInContext("setBasemap('satellite')", app.context)
  assert.deepEqual(app.markers[0].coordinates, coordinates)
  vm.runInContext('locateUser(); locateUser()', app.context)
  assert.equal(app.locationRequests.length, 2, '定位进行中不重复请求')
  app.locationRequests[1].success({ coords: { longitude: 113.84, latitude: 34.05 } })
  assert.equal(app.markers.length, 1)
  assert.deepEqual(app.markers[0].coordinates, [113.84, 34.05])
  app.cleanup()
  assert.equal(app.markers[0].removed, true)
})

test('主界面定位拒绝或异常保留研究区，允许重试，卸载后的定位响应不访问地图', async () => {
  const app = await mount()
  assert.equal(app.locationRequests.length, 0)
  assert.equal(app.bounds.length, 1)
  vm.runInContext('locateUser()', app.context)
  app.locationRequests[0].failure({ code: 1 })
  assert.match(vm.runInContext('locationError.value', app.context), /允许位置权限/)
  assert.equal(vm.runInContext('locating.value', app.context), false)
  vm.runInContext('locateUser()', app.context)
  app.locationRequests[1].success({ coords: { longitude: NaN, latitude: 34 } })
  assert.equal(app.markers.length, 0)
  assert.equal(vm.runInContext('locating.value', app.context), false)
  vm.runInContext('locateUser()', app.context)
  app.cleanup()
  app.locationRequests[2].success({ coords: { longitude: 113.83, latitude: 34.04 } })
  assert.equal(app.markers.length, 0)
  assert.equal(app.flights.length, 0)
  for (const options of [{ secure: false }, { supported: false }, { throws: true }]) {
    const failed = await mount('', false, '/', new Map(), options)
    vm.runInContext('locateUser()', failed.context)
    assert.ok(vm.runInContext('locationError.value', failed.context))
    assert.equal(vm.runInContext('locating.value', failed.context), false)
    assert.equal(failed.bounds.length, 1)
    failed.cleanup()
  }
})

test('高德标准底图对齐业务数据，切换卫星及地形时还原坐标且保留视野和统计', async () => {
  const app = await mount()
  assert.equal(app.options.style.sources.streetTiles, AMAP_STANDARD_SOURCE)
  assert.match(AMAP_STANDARD_SOURCE.tiles[0], /autonavi\.com\/appmaptile.*style=7/)
  const original = vm.runInContext('allStationFeatures.value[0].geometry.coordinates', app.context)
  assert.deepEqual(app.sources.stations.features[0].geometry.coordinates, toMapCoordinate(original))
  const counts = app.sources.hexgrid.features.map(feature => feature.properties.stationCount)
  const originalCenter = fromMapCoordinate(app.map.getCenter().toArray())
  vm.runInContext("setBasemap('satellite')", app.context)
  assert.equal(app.visibility['satellite-base'], 'visible')
  assert.deepEqual(app.sources.stations.features[0].geometry.coordinates, original)
  assert.deepEqual(app.sources.hexgrid.features.map(feature => feature.properties.stationCount), counts)
  assert.ok(turf.distance(originalCenter, app.map.getCenter().toArray()) < 0.000001)
  vm.runInContext("setBasemap('terrain'); setBasemap('street'); setBasemap('satellite'); setBasemap('street')", app.context)
  assert.deepEqual(app.sources.stations.features[0].geometry.coordinates, toMapCoordinate(original))
  assert.ok(turf.distance(originalCenter, fromMapCoordinate(app.map.getCenter().toArray())) < 0.000001)
  vm.runInContext('fitBoundary()', app.context)
  const rawBounds = vm.runInContext('boundaryBounds.value', app.context)
  assert.deepEqual(app.bounds.at(-1)[0], rawBounds.map(coordinate => toMapCoordinate(coordinate)))
  app.cleanup()
})

test('网格专题与站点独立叠加，切换专题保留站点开关', async () => {
  const app = await mount()
  assert.equal(app.visibility['hexgrid-fill'], 'none')
  assert.equal(app.visibility['hexgrid-outline'], 'none')
  for (const id of ['hexgrid', 'demandIndex', 'mismatch', 'supplyDemandType', 'capacitySupply']) {
    app.context.theme = id
    vm.runInContext('toggleLayer(theme, true)', app.context)
    assert.equal(app.visibility['stations-bolt'], 'visible')
    assert.equal(app.visibility['stations-circle'], 'visible')
    assert.ok(legendState(app).some(legend => legend.id === 'stations'))
  }
  vm.runInContext("toggleLayer('stations', false); toggleLayer('mismatch', true)", app.context)
  assert.equal(app.visibility['stations-bolt'], 'none')
  assert.equal(app.visibility['stations-circle'], 'none')
  assert.ok(!legendState(app).some(legend => legend.id === 'stations'))
  vm.runInContext("props.activeRoute = '/monitoring/stations'; applyRouteView()", app.context)
  assert.equal(app.visibility['stations-bolt'], 'visible')
  assert.equal(app.visibility['mismatch-fill'], 'none')
  app.cleanup()
})

test('专题路由直接访问和切换时打开对应图层', async () => {
  const app = await mount('', false, '/monitoring/demand')
  assert.equal(app.visibility['demand-index-fill'], 'visible')
  for (const [path, layer] of [
    ['/monitoring/supply', 'hexgrid-fill'],
    ['/monitoring/mismatch', 'mismatch-fill'],
    ['/planning/problems', 'supply-demand-type-fill'],
  ]) {
    vm.runInContext(`props.activeRoute = ${JSON.stringify(path)}; applyRouteView()`, app.context)
    assert.equal(app.visibility[layer], 'visible')
    assert.equal(app.visibility['demand-index-fill'], 'none')
  }
  vm.runInContext("props.activeRoute = '/monitoring/stations'; applyRouteView()", app.context)
  assert.equal(app.visibility['stations-circle'], 'visible')
  assert.equal(app.visibility['supply-demand-type-fill'], 'none')
  app.cleanup()
})

test('后端未启动时明确显示错误，正式地图不读取本地备份', async () => {
  const app = await mount('api-only')
  assert.equal(app.state.count, 0)
  assert.ok(app.state.error)
  assert.ok(app.requests.every(url => url.includes('/api/')))
  app.cleanup()
})

test('加载期间卸载会取消请求，也不会继续更新地图', async () => {
  const app = await mount('', true)
  assert.equal(app.requestSignal.aborted, true)
  assert.deepEqual(app.sources, {})
  assert.equal(app.state.error, '')
})

test('MapView 内联筛选与网格累计数量一致', async () => {
  const app = await mount()
  assert.equal(app.state.error, '')
  assert.equal(app.state.count, 52)
  assert.equal(app.state.commercialCount, 200)
  assert.equal(app.sources.hexgrid.features.reduce((sum, hex) => sum + hex.properties.stationCount, 0), 52)
  assert.equal(app.sources.hexgrid.features.reduce((sum, hex) => sum + hex.properties.commercialCount, 0), 200)
  app.cleanup()
})

test('正式网格或站点请求失败显示数据加载错误', async () => {
  const gridFailure = await mount('hex-grid.json')
  assert.equal(gridFailure.state.count, 0)
  assert.ok(gridFailure.state.error)
  gridFailure.cleanup()
  const stationFailure = await mount('stations.json')
  assert.ok(stationFailure.state.error)
  assert.equal(stationFailure.state.loading, false)
  stationFailure.cleanup()
})

test('站点优先、弹窗文字安全、零数量保留、旧弹窗关闭', async () => {
  const app = await mount()
  app.handlers['click:stations-circle']({ features: [{ geometry: { coordinates: [113.8,34] }, properties: { name: '<b>站点</b>', id: 0 } }] })
  assert.equal(app.popups[0].content.children[0].textContent, '<b>站点</b>')
  assert.equal(app.popups[0].content.children[2].textContent, '编码：0')
  app.map.queryRenderedFeatures = () => [{}]
  const event = { point: {}, lngLat: {}, features: [{ properties: { id: 1, stationCount: 0 } }] }
  app.handlers['click:'](event)
  assert.equal(app.popups.length, 1)
  app.map.queryRenderedFeatures = (_point, options) =>
    options.layers.includes('hexgrid-fill') ? event.features : []
  app.handlers['click:'](event)
  assert.equal(app.popups[0].removed, true)
  assert.equal(app.popups.length, 1, '网格详情只显示一张浮卡，不重复生成弹窗')
  assert.equal(vm.runInContext('selectedHex.value.stationCount', app.context), 0)
  assert.equal(vm.runInContext('selectedHex.value.commercialCount', app.context), undefined, '未知字段不补零')
  app.cleanup()
})

test('按站名搜索定位后保留全部站点，清空搜索框和结果提示', async () => {
  const app = await mount()
  const name = app.sources.stations.features[0].properties.name
  const originalStations = app.sources.stations
  vm.runInContext(`stationKeyword.value = ${JSON.stringify(name)}`, app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.ok(app.requests.at(-1).includes(`name=${encodeURIComponent(name)}`))
  assert.equal(app.sources.stations, originalStations)
  assert.equal(app.popups.at(-1).content.children[0].textContent, name)
  assert.equal(vm.runInContext('stationKeyword.value', app.context), '')
  assert.equal(vm.runInContext('searchResultCount.value', app.context), null)
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), false)
  vm.runInContext("stationKeyword.value = ''", app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.equal(app.sources.stations.features.length, 52)
  app.cleanup()
})

test('有效搜索持久保存、去重，刷新后点击记录定位到站点', async () => {
  const first = await mount()
  const name = first.sources.stations.features[0].properties.name
  vm.runInContext(`stationKeyword.value = ${JSON.stringify(name)}`, first.context)
  await vm.runInContext('searchStation()', first.context)
  await vm.runInContext('searchStation()', first.context)
  assert.deepEqual(JSON.parse(first.historyStorage.get('weidu-station-search-history-v1')), [name])
  assert.ok(first.flights.length)
  first.cleanup()
  const refreshed = await mount('', false, '/', first.historyStorage)
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(searchHistory.value)', refreshed.context)), [name])
  await vm.runInContext('useSearchHistory(searchHistory.value[0])', refreshed.context)
  assert.equal(refreshed.sources.stations.features.length, 52)
  assert.equal(vm.runInContext('stationKeyword.value', refreshed.context), '')
  assert.equal(vm.runInContext('searchResultCount.value', refreshed.context), null)
  assert.equal(refreshed.popups.at(-1).content.children[0].textContent, name)
  assert.deepEqual(refreshed.flights.at(-1).center, refreshed.sources.stations.features[0].geometry.coordinates)
  refreshed.cleanup()
})

test('多匹配搜索及点击定位均保留全部站点，清空输入并保留所选站点历史', async () => {
  const app = await mount()
  const originalStations = app.sources.stations
  vm.runInContext("stationKeyword.value = '充电'; toggleLayer('stations', false); toggleFastOnly(true)", app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.equal(app.sources.stations, originalStations)
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), true)
  assert.equal(app.bounds.at(-1)[1].maxZoom, 14)
  const selectedName = vm.runInContext('matchingStations.value.at(-1).properties.name', app.context)
  vm.runInContext('selectSearchStation(matchingStations.value.at(-1))', app.context)
  assert.equal(app.sources.stations, originalStations)
  assert.equal(app.visibility['stations-circle'], 'visible')
  assert.equal(app.filters['stations-circle'], null)
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), false)
  assert.equal(vm.runInContext('stationKeyword.value', app.context), '')
  assert.equal(vm.runInContext('searchResultCount.value', app.context), null)
  assert.equal(vm.runInContext('searchHistory.value[0]', app.context), selectedName)
  assert.equal(app.flights.at(-1).zoom, 15)
  assert.equal(app.popups.at(-1).content.children[0].textContent, selectedName)
  app.cleanup()
})

test('搜索记录最多十条、最近使用置顶，清空后不再从存储恢复', async () => {
  const app = await mount()
  vm.runInContext("Array.from({length:12}, (_, i) => rememberSearch('记录' + i)); rememberSearch('记录5')", app.context)
  const history = JSON.parse(app.historyStorage.get('weidu-station-search-history-v1'))
  assert.equal(history.length, 10)
  assert.equal(history[0], '记录5')
  assert.equal(new Set(history).size, 10)
  vm.runInContext('clearSearchHistory()', app.context)
  assert.equal(app.historyStorage.size, 0)
  assert.equal(vm.runInContext('searchHistory.value.length', app.context), 0)
  app.cleanup()
})

test('空搜索和零匹配不写历史，存储禁用或损坏时仍可搜索定位', async () => {
  const storage = new Map([['weidu-station-search-history-v1', '{损坏']])
  const app = await mount('', false, '/', storage)
  assert.equal(vm.runInContext('searchHistory.value.length', app.context), 0)
  vm.runInContext("stationKeyword.value = '不存在的站点名称'", app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.equal(vm.runInContext('searchHistory.value.length', app.context), 0)
  assert.equal(app.sources.stations.features.length, 52)
  vm.runInContext("stationKeyword.value = ''", app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.equal(vm.runInContext('searchHistory.value.length', app.context), 0)
  vm.runInContext("localStorage.setItem = () => { throw new Error('禁用存储') }; stationKeyword.value = allStationFeatures.value[0].properties.name", app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.equal(vm.runInContext('searchHistory.value.length', app.context), 1)
  assert.ok(app.flights.length)
  app.cleanup()
})

test('搜索面板点击内部保留，外部和 Escape 关闭，卸载清理监听', async () => {
  const app = await mount()
  vm.runInContext('openSearchPanel()', app.context)
  app.listeners.get('pointerdown')({ target: { closest: () => ({}) } })
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), true)
  app.listeners.get('pointerdown')({ target: { closest: () => null } })
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), false)
  vm.runInContext('openSearchPanel()', app.context)
  app.listeners.get('keydown')({ key: 'Escape' })
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), false)
  vm.runInContext('openSearchPanel()', app.context)
  app.cleanup()
  assert.equal(app.listeners.has('pointerdown'), false)
  assert.equal(app.listeners.has('keydown'), false)
})

test('测距：两个点连成线，长度按米 / 千米显示', async () => {
  const app = await mount()
  // 同一纬度上相差 0.012° 经度，在 34°N 约 1.1 千米
  vm.runInContext('measurePoints.value = [[113.85, 34.04], [113.862, 34.04]]', app.context)
  vm.runInContext('refreshMeasureLayer()', app.context)
  // 传进地图的数据 = 1 条折线 + 2 个点
  assert.equal(app.sources.measure.features.length, 3)
  assert.equal(app.sources.measure.features[0].geometry.type, 'LineString')
  assert.match(vm.runInContext('measureText.value', app.context), /^1\.1\d 千米$/)
  // 只差 0.002°（约 180 米）时改用米显示
  vm.runInContext('measurePoints.value = [[113.85, 34.04], [113.852, 34.04]]', app.context)
  assert.match(vm.runInContext('measureText.value', app.context), /^1\d\d 米$/)
  // 清除以后数据回到空
  vm.runInContext('clearMeasure()', app.context)
  assert.equal(app.sources.measure.features.length, 0)
  app.cleanup()
})

test('高亮固定色阶区分低数量网格，不被最大值稀释，图例与地图颜色一致', async () => {
  const app = await mount()
  const color = app.paint['hexgrid-highlight:fill-color']
  assert.equal(color[0], 'interpolate')
  const stops = color.filter((value, index) => index >= 3 && index % 2 === 1)
  assert.deepEqual(Array.from(stops), [0, 1, 2, 3, 4, 6, 10])
  assert.ok(stops.every((value, index) => index === 0 || value > stops[index - 1]))
  const colors = color.filter((value, index) => index >= 4 && index % 2 === 0)
  const brightness = colors.map(color => .2126 * parseInt(color.slice(1, 3), 16) + .7152 * parseInt(color.slice(3, 5), 16) + .0722 * parseInt(color.slice(5, 7), 16))
  assert.ok(brightness.every((value, index) => index === 0 || value < brightness[index - 1]))
  assert.ok(brightness[0] - brightness.at(-1) > 150, '色阶的明暗差应足够明显')
  vm.runInContext('hexDistribution.value = [{stationCount: 100, hexCount: 1}]', app.context)
  assert.equal(JSON.stringify(vm.runInContext('gridHighlightColor()', app.context)), JSON.stringify(color))
  vm.runInContext('highlightHexByStationCount(0)', app.context)
  assert.equal(JSON.stringify(app.filters['hexgrid-highlight']), '["==",["get","stationCount"],0]')
  const legend = legendState(app).find(item => item.id === 'gridHighlight')
  assert.ok(colors.every(color => legend.gradient.includes(color)))
  assert.match(legend.note, /0 个站点/)
  app.cleanup()
})

test('总览解除柱状图单项筛选，包含零站点网格，复位地图并允许再次选择', async () => {
  const app = await mount()
  vm.runInContext('highlightHexByStationCount(2); selectedHex.value = {id: 1}; showGridOverview()', app.context)
  assert.equal(JSON.stringify(app.filters['hexgrid-highlight']), '[">=",["get","stationCount"],0]')
  assert.equal(vm.runInContext('selectedHex.value', app.context), null)
  assert.equal(app.bounds.at(-1)[1].padding, 40)
  assert.equal(app.bounds.at(-1)[1].duration, 600)
  assert.match(legendState(app).find(item => item.id === 'gridHighlight').note, /总览/)
  vm.runInContext('highlightHexByStationCount(1)', app.context)
  assert.equal(JSON.stringify(app.filters['hexgrid-highlight']), '["==",["get","stationCount"],1]')
  vm.runInContext('applyRouteView()', app.context)
  assert.ok(!legendState(app).some(item => item.id === 'gridHighlight'))
  app.cleanup()
})

test('快充和普通充电使用不同图标，并跟随充电站开关一起显隐', async () => {
  const app = await mount()
  const bolt = app.options.style.layers.find(layer => layer.id === 'stations-bolt')
  assert.equal(bolt.type, 'symbol')
  const icon = bolt.layout['icon-image']
  assert.equal(icon[0], 'match')
  assert.notEqual(icon[3], icon.at(-1))
  assert.equal(icon.at(-1), 'charge-regular')
  assert.equal(icon[2], 'fast')
  // 充电站默认打开，所以闪电也是可见的
  assert.equal(app.visibility['stations-bolt'], 'visible')
  // 关掉「充电站」以后两个图层一起隐藏
  vm.runInContext("toggleLayer('stations', false)", app.context)
  assert.equal(app.visibility['stations-circle'], 'none')
  assert.equal(app.visibility['stations-bolt'], 'none')
  app.cleanup()
})

test('勾选「只看快充」会给站点图层加过滤条件，取消后恢复', async () => {
  const app = await mount()
  vm.runInContext('toggleFastOnly(true)', app.context)
  // 用 JSON 比较：过滤条件是 vm 里创建的数组，不能直接跨环境比较
  const expected = '["==",["get","chargeType"],"fast"]'
  assert.equal(JSON.stringify(app.filters['stations-circle']), expected)
  assert.equal(JSON.stringify(app.filters['stations-bolt']), expected)
  vm.runInContext('toggleFastOnly(false)', app.context)
  assert.equal(app.filters['stations-circle'], null)
  app.cleanup()
})

test('图层管理保留五类供需专题和基础点位，移除重复专题及其地图渲染层', async () => {
  const app = await mount()
  const ids = () => vm.runInContext("mapLayerItems.value.map(item => item.id).join(',')", app.context)
  const expected = ['stations,residential,commercial,hexgrid,demandIndex,mismatch,supplyDemandType,capacitySupply', ...FACILITY_MAP_LAYERS.map(layer => layer.id)].join(',')
  assert.equal(ids(), expected)
  const removedLayers = ['stations-heatmap', 'residential-demand-fill', 'pss-fast-fill', 'pss-regular-fill']
  assert.ok(app.options.style.layers.every(layer => !removedLayers.includes(layer.id)))
  vm.runInContext("toggleLayer('residential', true)", app.context)
  assert.equal(app.visibility['residential-circle'], 'visible')
  assert.ok(!ids().includes('boundary'))
  vm.runInContext("toggleLayer('residential', false)", app.context)
  assert.equal(app.visibility['residential-circle'], 'none')
  assert.equal(ids(), expected)
  app.cleanup()
})

test('设施分类按多类别独立叠加、计数和显示图例，底图切换统一转换坐标', async () => {
  const app = await mount()
  const items = () => JSON.parse(vm.runInContext('JSON.stringify(mapLayerItems.value.filter(item => item.section === "facility"))', app.context))
  assert.equal(items().length, 12)
  assert.equal(items().find(item => item.id === 'facility-parking').count, 1)
  assert.equal(items().find(item => item.id === 'facility-mall').count, 1, '同一设施可以属于多个类别')
  assert.equal(items().find(item => item.id === 'facility-hospital').count, 0)
  assert.equal(items().find(item => item.id === 'facility-hospital').disabled, true, '无记录类别保持禁用')
  assert.deepEqual(JSON.parse(JSON.stringify(app.sources.facilities)), toMapGeoJSON({ type: 'FeatureCollection', features: facilityFixture.features }, 'street'))
  vm.runInContext("toggleLayer('facility-parking', true); toggleLayer('facility-school', true); toggleLayer('mismatch', true)", app.context)
  assert.equal(app.visibility['facility-parking-circle'], 'visible')
  assert.equal(app.visibility['facility-school-circle'], 'visible')
  assert.equal(app.visibility['mismatch-fill'], 'visible')
  assert.equal(app.visibility['stations-circle'], 'visible')
  assert.deepEqual(legendState(app).filter(legend => legend.id.startsWith('facility-')).map(legend => legend.id), ['facility-parking', 'facility-school'])
  const parking = app.options.style.layers.find(layer => layer.id === 'facility-parking-circle')
  assert.deepEqual(parking.filter, ['in', 'parking', ['get', 'categories']])
  assert.equal(legendState(app).find(legend => legend.id === 'facility-parking').items[0].color, parking.paint['circle-color'])
  vm.runInContext("setBasemap('satellite'); toggleLayer('facility-parking', false)", app.context)
  assert.deepEqual(app.sources.facilities.features[0].geometry.coordinates, facilityFixture.features[0].geometry.coordinates)
  assert.equal(app.visibility['facility-school-circle'], 'visible')
  assert.ok(!legendState(app).some(legend => legend.id === 'facility-parking'))
  app.cleanup()
})

test('设施分页完整加载后发布，不改变站点或原需求样本', async () => {
  const app = await mount('', false, '/', new Map(), { facilityFetch: async url => {
    const offset = Number(new URL(url).searchParams.get('offset'))
    return { ok: true, json: async () => ({ ...facilityFixture,
      features: [facilityFixture.features[offset]], metadata: { ...facilityFixture.metadata, hasMore: offset === 0 } }) }
  } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(app.requests.filter(url => url.includes('/api/facility-pois')).length, 2)
  assert.ok(app.requests.some(url => url.endsWith('offset=1')))
  assert.equal(app.sources.facilities.features.length, 2)
  assert.equal(app.sources.stations.features.length, 52)
  assert.equal(app.sources.residential.features.length, 224)
  assert.equal(app.sources.commercial.features.length, 200)
  app.cleanup()
})

test('设施接口失败不影响主地图，重试成功恢复数量与开关', async () => {
  let failed = true
  const app = await mount('', false, '/', new Map(), { facilityFetch: async () =>
    ({ ok: !failed, status: 503, json: async () => structuredClone(facilityFixture) }) })
  assert.equal(app.state.loading, false)
  assert.equal(app.state.error, '')
  assert.match(vm.runInContext('facilityError.value', app.context), /重试/)
  assert.equal(vm.runInContext('facilityLoaded.value', app.context), false)
  assert.equal(vm.runInContext('mapLayerItems.value.find(item => item.id === "facility-parking").count', app.context), null)
  assert.equal(app.sources.stations.features.length, 52)
  failed = false
  await vm.runInContext('loadFacilityData()', app.context)
  assert.equal(vm.runInContext('facilityError.value', app.context), '')
  assert.equal(vm.runInContext('facilityLoading.value', app.context), false)
  assert.equal(vm.runInContext('facilityLoaded.value', app.context), true)
  vm.runInContext("toggleLayer('facility-parking', true)", app.context)
  assert.equal(app.visibility['facility-parking-circle'], 'visible')
  app.cleanup()
})

test('设施后续分页失败或返回未初始化、错误坐标系时，不展示不完整点位', async () => {
  for (const mode of ['second-page', 'empty-page', 'uninitialized', 'coordinates']) {
    const app = await mount('', false, '/', new Map(), { facilityFetch: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'))
      return { ok: !(mode === 'second-page' && offset > 0), status: 503, json: async () => ({
        ...facilityFixture, features: mode === 'empty-page' ? [] : [facilityFixture.features[0]],
        metadata: { initialized: mode !== 'uninitialized', coordSystem: mode === 'coordinates' ? 'GCJ-02' : 'WGS84',
          hasMore: ['second-page', 'empty-page'].includes(mode) },
      }) }
    } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(vm.runInContext('facilityLoaded.value', app.context), false, mode)
    assert.ok(vm.runInContext('facilityError.value', app.context), mode)
    assert.equal(app.sources.facilities?.features.length ?? 0, 0, mode)
    assert.equal(app.state.error, '', mode)
    app.cleanup()
  }
})

test('设施请求迟到时先检查卸载状态，不再访问已移除的地图', async () => {
  let finish, signal
  const app = await mount('', false, '/', new Map(), { facilityFetch: async (_url, config) => {
    signal = config.signal
    return { ok: true, json: () => new Promise(resolve => { finish = resolve }) }
  } })
  assert.equal(vm.runInContext('facilityLoading.value', app.context), true)
  app.cleanup()
  assert.equal(signal.aborted, true)
  let lateSourceAccess = 0
  app.map.getSource = () => { lateSourceAccess++; return { setData() {} } }
  finish(structuredClone(facilityFixture))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lateSourceAccess, 0)
  assert.equal(vm.runInContext('facilityLoaded.value', app.context), false)
})

test('设施点击展示名称、类别、采集时间与核验说明，测距时保留取点行为', async () => {
  const app = await mount()
  const feature = structuredClone(facilityFixture.features[0])
  feature.properties.name = '<img src=x onerror=alert(1)>'
  feature.properties.categories = JSON.stringify(feature.properties.categories)
  app.map.queryRenderedFeatures = (_point, options) => options.layers.includes('facility-parking-circle') ? [feature] : []
  const event = { point: {}, lngLat: { lng: 113.83, lat: 34.04 } }
  app.handlers['click:'](event)
  const lines = app.popups[0].content.children.map(child => child.textContent)
  assert.equal(lines[0], feature.properties.name)
  assert.ok(lines.includes('设施类别：停车场、商场'))
  assert.ok(lines.includes('采集时间：2026-10-16T12:00:00+08:00'))
  assert.ok(lines.includes('核验状态：尚未现场核验'))
  assert.ok(lines.includes('可用泊位、收费及公共开放条件：待核查'))
  vm.runInContext('measuring.value = true', app.context)
  app.handlers['click:'](event)
  assert.equal(app.popups.length, 1)
  app.cleanup()
})

test('边界显示、填充和不透明度独立控制，专题切换保留设置', async () => {
  const app = await mount()
  vm.runInContext('toggleBoundaryFill(false); setBoundaryOpacity(12.5)', app.context)
  assert.equal(app.visibility['weidu-fill'], 'none')
  assert.equal(app.visibility['weidu-outline'], 'visible')
  assert.equal(app.paint['weidu-fill:fill-opacity'], 0.125)
  vm.runInContext("toggleLayer('boundary', false); props.activeRoute = '/monitoring/demand'; applyRouteView()", app.context)
  assert.equal(app.visibility['weidu-outline'], 'none')
  assert.equal(app.visibility['demand-index-fill'], 'visible')
  vm.runInContext("toggleLayer('boundary', true)", app.context)
  assert.equal(app.visibility['weidu-fill'], 'none')
  assert.equal(app.visibility['weidu-outline'], 'visible')
  vm.runInContext('toggleBoundaryFill(true); fitBoundary()', app.context)
  assert.equal(app.visibility['weidu-fill'], 'visible')
  assert.equal(JSON.stringify(app.bounds.at(-1)[0]), JSON.stringify(app.bounds[0][0]))
  assert.equal(app.bounds.at(-1)[1].duration, 600)
  app.cleanup()
})

test('顶部图层面板连续切换和地图点选保持展开，关闭按钮或 Escape 收起，边界面板仍可独立操作', async () => {
  const app = await mount()
  const state = () => vm.runInContext('[boundaryPanelOpen.value, quickPanelOpen.value].join()', app.context)
  vm.runInContext('toggleBoundaryPanel()', app.context)
  assert.equal(state(), 'true,false')
  vm.runInContext('toggleQuickPanel()', app.context)
  assert.equal(state(), 'false,true')
  vm.runInContext('closeMapPanelsOnOutsideClick({target:{closest:()=>null}})', app.context)
  assert.equal(state(), 'false,true', '面板内点击复选框不能收起面板')
  vm.runInContext("toggleLayer('mismatch', true); toggleLayer('demandIndex', true)", app.context)
  assert.equal(state(), 'false,true', '切换专题后继续保留面板')
  assert.equal(app.visibility['mismatch-fill'], 'none')
  assert.equal(app.visibility['demand-index-fill'], 'visible')
  vm.runInContext('openSearchPanel(); closeSearchPanel(); toggleBoundaryPanel()', app.context)
  assert.equal(state(), 'true,true', '搜索与边界操作不能自动收起独立图层面板')
  vm.runInContext('closeMapPanels(false)', app.context)
  assert.equal(state(), 'false,true')
  app.listeners.get('keydown')({ key: 'Enter' })
  assert.equal(state(), 'false,true')
  app.listeners.get('keydown')({ key: 'Escape' })
  assert.equal(state(), 'false,false')
  assert.equal(app.listeners.size, 0)
  vm.runInContext('toggleBoundaryPanel()', app.context)
  app.listeners.get('click')()
  assert.equal(state(), 'false,false')
  vm.runInContext('toggleQuickPanel()', app.context)
  app.cleanup()
  assert.equal(app.listeners.size, 0)
})

const legendState = app => JSON.parse(vm.runInContext('JSON.stringify(activeLegends.value)', app.context))

test('定位周边绘制主要供给连线，保持原网格，底图和退出同步清理', async () => {
  const app = await mount()
  const originalGrid = structuredClone(app.sources.hexgrid)
  const modelStations = JSON.parse(vm.runInContext('JSON.stringify(allStationFeatures.value)', app.context))
  const station = modelStations[0]
  const center = station.geometry.coordinates
  app.context.localPreview = { local: true, editing: true, stage: 'after', tool: 'locate', center,
    radiusMeters: 1000, modelStations, points: [], removedIds: [],
    pointBaseline: { sources: [{ feature: station, share: 100 }] }, features: [] }
  app.context.localClicks = []
  vm.runInContext('sandboxPanel.value = { mapClick: payload => localClicks.push(payload) }; showLayoutScenario(localPreview)', app.context)
  assert.deepEqual(app.sources.hexgrid, originalGrid, '不能通过本地选点重算全区网格')
  assert.equal(app.sources['facility-location'].features[0].geometry.type, 'Polygon')
  assert.deepEqual(app.sources['facility-location'].features[1].geometry.coordinates, toMapCoordinate(center))
  assert.equal(app.sources['facility-nearby'].features.filter(feature => feature.geometry.type === 'LineString').length, 1)
  assert.equal(app.sources['facility-service'].features.length, 0)
  assert.equal(app.sources['facility-places'].features.length, 0)
  assert.equal(vm.runInContext('displayedResult.value', app.context), null)
  assert.ok(legendState(app).some(legend => legend.id === 'facilityLocation'))
  app.handlers['click:']({ point: {}, lngLat: { lng: center[0], lat: center[1] } })
  assert.equal(app.context.localClicks.length, 1, '选择定位阶段必须将点击交给选点工具')
  vm.runInContext("setBasemap('satellite')", app.context)
  assert.deepEqual(app.sources['facility-location'].features[1].geometry.coordinates, center)
  vm.runInContext('showLayoutScenario({ ...localPreview, editing: false, stage: "before" })', app.context)
  assert.equal(app.sources['facility-location'].features.length, 0)
  assert.equal(app.sources['facility-nearby'].features.length, 0)
  assert.equal(app.sources['facility-proposals'].features.length, 0)
  assert.equal(legendState(app).some(legend => legend.id === 'facilityLocation'), false)
  app.cleanup()
})

test('布局编辑可开关专题与图例，使用所选数据范围；结果与选址专题分别查看，草稿不丢失', async () => {
  const app = await mount('', false, '/monitoring/mismatch')
  const features = JSON.parse(vm.runInContext('JSON.stringify(hexData.value.features)', app.context))
  const modelGrid = { type: 'FeatureCollection', features: structuredClone(features) }
  modelGrid.features[0].properties.stationCount = 0
  const after = structuredClone(modelGrid.features)
  after[0].properties.stationCount = 1
  const supply = fixedSupplyComparison(modelGrid.features, after)
  const service = changed => ({ grid: { type: 'FeatureCollection', features: features.map((feature, i) => ({ ...feature,
    properties: { ...feature.properties, demandMatchScore: i === 0 && changed ? 20 : 10 } })) } })
  app.context.localScenario = { local: true, editing: true, tool: 'add', stage: 'after', points: [turf.point([113.83, 34.03], { id: 'draft' })],
    removedIds: [], modelGrid, features: [] }
  app.context.localResult = { macro: { grid: supply.after, comparison: buildFacilityComparison(supply, { before: service(false), after: service(true) }) } }
  vm.runInContext('showLayoutScenario(localScenario)', app.context)
  assert.equal(app.visibility['mismatch-fill'], 'visible', '进入新增模式不能强制隐藏错配图')
  assert.equal(app.sources.hexgrid.features[0].properties.stationCount, 0, '参考专题使用模拟所选数据范围')
  assert.ok(legendState(app).some(legend => legend.id === 'mismatch'))
  vm.runInContext("toggleLayer('mismatch', false); toggleLayer('demandIndex', true)", app.context)
  assert.equal(app.visibility['mismatch-fill'], 'none')
  assert.equal(app.visibility['demand-index-fill'], 'visible')
  assert.ok(!legendState(app).some(legend => legend.id === 'mismatch'))
  vm.runInContext('showLayoutScenario({ ...localScenario, tool: "inspect", result: localResult })', app.context)
  assert.equal(app.visibility['facility-service-fill'], 'visible')
  assert.equal(app.visibility['demand-index-fill'], 'none', '对比结果不与专题叠色')
  vm.runInContext("toggleLayer('mismatch', true)", app.context)
  assert.equal(app.visibility['facility-service-fill'], 'none')
  assert.equal(app.visibility['mismatch-fill'], 'visible')
  assert.equal(app.visibility['demand-index-fill'], 'none')
  assert.equal(app.sources.hexgrid.features[0].properties.stationCount, 1, '模拟后专题反映已分析方案')
  assert.equal(vm.runInContext('layoutPreview.value.points.length', app.context), 1)
  assert.ok(!legendState(app).some(legend => legend.id === 'facilityService'))
  vm.runInContext('togglePlanningComparison(true); toggleBoundaryFill(true)', app.context)
  assert.equal(app.visibility['facility-service-fill'], 'visible', '边界开关不改变专题选择')
  assert.equal(app.visibility['mismatch-fill'], 'none')
  vm.runInContext('showLayoutScenario({ ...layoutPreview.value, tool: "add" })', app.context)
  assert.equal(app.visibility['mismatch-fill'], 'visible', '继续编辑恢复选址参考图')
  vm.runInContext('showLayoutScenario({ ...layoutPreview.value, editing: false, result: null })', app.context)
  assert.equal(app.visibility['mismatch-fill'], 'visible')
  assert.equal(app.visibility['facility-service-fill'], 'none')
  app.cleanup()
})

test('首次布局编辑没有专题时默认展示错配，关闭后切换页签不会重新打开', async () => {
  const app = await mount()
  app.context.draft = { local: true, editing: true, tool: 'add', stage: 'after', points: [], removedIds: [], features: [] }
  vm.runInContext('showLayoutScenario(draft)', app.context)
  assert.equal(app.visibility['mismatch-fill'], 'visible')
  vm.runInContext("toggleLayer('mismatch', false); showLayoutScenario({ ...draft, editing: false }); showLayoutScenario(draft)", app.context)
  assert.equal(app.visibility['mismatch-fill'], 'none')
  app.cleanup()
})

test('设备定位仅在明确选择使用当前位置时传入模拟，地图定位不代替模拟选点', async () => {
  const app = await mount()
  app.context.simulationLocations = []
  vm.runInContext('sandboxPanel.value = { setLocation: coordinates => simulationLocations.push(coordinates) }; layoutPreview.value.editing = true', app.context)
  vm.runInContext('locateUser()', app.context)
  app.locationRequests[0].success({ coords: { longitude: 113.83, latitude: 34.04 } })
  assert.equal(app.context.simulationLocations.length, 0)
  vm.runInContext('locateUser(true)', app.context)
  app.locationRequests[1].success({ coords: { longitude: 113.84, latitude: 34.05 } })
  assert.deepEqual(Array.from(app.context.simulationLocations[0]), [113.84, 34.05])
  app.cleanup()
})

test('沙盘接管地图点选并还原业务坐标；运行结果联动图层和统计，模拟前恢复原始数据', async () => {
  const app = await mount()
  const baseline = structuredClone(app.sources.hexgrid)
  const baselineStations = structuredClone(app.sources.stations)
  app.context.sandboxClicks = []
  vm.runInContext(`sandboxPanel.value = { mapClick: payload => sandboxClicks.push(payload) };
    showLayoutScenario({ editing: true, stage: 'after', tool: 'add', points: [], removedIds: [], features: [] })`, app.context)
  const coordinates = [113.83, 34.04], mapped = toMapCoordinate(coordinates)
  const clicked = { point: {}, lngLat: { lng: mapped[0], lat: mapped[1] } }
  app.handlers['click:'](clicked)
  const payload = app.context.sandboxClicks.at(-1)
  assert.ok(turf.distance(turf.point(payload.coordinates), turf.point(coordinates), { units: 'meters' }) < .01)
  const popupCount = app.popups.length
  app.handlers['click:stations-circle']({ features: [baselineStations.features[0]] })
  assert.equal(app.popups.length, popupCount, '编辑点位时不打开普通站点弹窗')
  app.map.queryRenderedFeatures = (_point, { layers }) => layers.includes('facility-proposal-point')
    ? [{ properties: { sandboxId: 'sandbox-test' } }] : []
  app.handlers['click:'](clicked)
  assert.equal(app.context.sandboxClicks.at(-1).sandboxId, 'sandbox-test')
  app.map.queryRenderedFeatures = (_point, { layers }) => layers.includes('facility-removal-point')
    ? [{ properties: { removedId: 'original-test' } }] : []
  app.handlers['click:'](clicked)
  assert.equal(app.context.sandboxClicks.at(-1).removedId, 'original-test')
  vm.runInContext(`const simulatedGrid = JSON.parse(JSON.stringify(hexData.value));
    simulatedGrid.features[0].properties.stationCount++;
    const addedPoint = turf.point([113.83, 34.04], { id: 'sandbox-test', chargeType: 'fast' });
    showLayoutScenario({ editing: true, stage: 'after', tool: 'add', points: [addedPoint], removedIds: [], features: [],
      result: { grid: simulatedGrid, stations: [...allStationFeatures.value, addedPoint], after: { stationCount: allStationFeatures.value.length + 1 } } })`, app.context)
  assert.equal(app.sources.hexgrid.features[0].properties.stationCount, baseline.features[0].properties.stationCount + 1)
  assert.equal(vm.runInContext('displayedStationCount.value', app.context), baselineStations.features.length + 1)
  assert.equal(vm.runInContext('displayedDistribution.value.reduce((total, row) => total + row.stationCount * row.hexCount, 0)', app.context), baselineStations.features.length + 1)
  assert.ok(legendState(app).some(legend => legend.id === 'facilitySandbox'))
  vm.runInContext("showLayoutScenario({ editing: true, stage: 'before', points: [], removedIds: [], features: [] })", app.context)
  assert.deepEqual(app.sources.hexgrid, baseline)
  assert.deepEqual(app.sources.stations, baselineStations)
  assert.equal(vm.runInContext('displayedStationCount.value', app.context), baselineStations.features.length)
  app.cleanup()
})

test('对比地图切换指标与阶段，查看网格不新增点位，过期和退出还原业务图层', async () => {
  const app = await mount('', false, '/monitoring/mismatch')
  const features = JSON.parse(vm.runInContext('JSON.stringify(hexData.value.features)', app.context))
  const afterFeatures = structuredClone(features)
  afterFeatures[0].properties.stationCount++
  const supply = fixedSupplyComparison(features, afterFeatures)
  const service = after => ({ grid: { type: 'FeatureCollection', features: features.map((feature, i) => ({ ...feature,
    properties: { ...feature.properties, demandMatchScore: i === 0 && after ? 20 : 10 } })) } })
  const comparison = buildFacilityComparison(supply, { before: service(false), after: service(true) })
  app.context.comparisonResult = { grid: supply.after, comparison, after: { stationCount: 999 } }
  app.context.sandboxClicks = []
  vm.runInContext(`sandboxPanel.value = { mapClick: payload => sandboxClicks.push(payload) };
    showLayoutScenario({ editing: true, tool: 'inspect', stage: 'change', comparisonMetric: 'service',
      result: comparisonResult, points: [], removedIds: [], features: [] })`, app.context)
  assert.equal(app.sources['facility-service'].features[0].properties.comparisonValue, 10)
  assert.equal(app.visibility['mismatch-fill'], 'none', '结果图不能与原失配图叠色')
  assert.equal(vm.runInContext('displayedStationCount.value', app.context), 999)
  assert.ok(legendState(app).find(legend => legend.id === 'facilityService').title.includes('变化'))
  app.map.queryRenderedFeatures = (_point, { layers }) => layers.includes('facility-service-fill') ? [comparison.grid.features[0]] : []
  app.handlers['click:']({ point: {}, lngLat: { lng: 113.83, lat: 34.04 } })
  assert.equal(app.context.sandboxClicks.length, 0)
  assert.ok(app.popups.at(-1).content, '点击变化网格展示前后数值')
  vm.runInContext("showLayoutScenario({ ...layoutPreview.value, comparisonMetric: 'supply', stage: 'before' })", app.context)
  const beforeColors = structuredClone(app.paint['facility-service-fill:fill-color'])
  assert.equal(app.sources['facility-service'].features[0].properties.comparisonValue, comparison.grid.features[0].properties.beforeMismatch)
  vm.runInContext("showLayoutScenario({ ...layoutPreview.value, stage: 'after' })", app.context)
  assert.deepEqual(app.paint['facility-service-fill:fill-color'], beforeColors)
  assert.equal(app.sources['facility-service'].features[0].properties.comparisonValue, comparison.grid.features[0].properties.afterMismatch)
  vm.runInContext("showLayoutScenario({ ...layoutPreview.value, result: null, dirty: true })", app.context)
  assert.equal(app.sources['facility-service'].features.length, 0)
  assert.equal(app.visibility['mismatch-fill'], 'visible')
  vm.runInContext("showLayoutScenario({ ...layoutPreview.value, editing: false, stage: 'before' })", app.context)
  assert.equal(app.sources['facility-service'].features.length, 0)
  assert.ok(!legendState(app).some(legend => legend.id === 'facilityService'))
  app.cleanup()
})

test('新增前后地图切换仅更新模拟区域，原始统计保留，底图转换同步且取消后移除图例', async () => {
  const app = await mount()
  const original = structuredClone(app.sources.hexgrid)
  vm.runInContext("showLayoutScenario({ stage: 'after', features: [hexData.value.features[0]] })", app.context)
  assert.equal(app.sources['facility-proposals'].features.length, 2)
  assert.ok(legendState(app).some(legend => legend.id === 'facilityProposals'))
  assert.deepEqual(app.sources.hexgrid, original)
  const proposalArea = app.sources['facility-proposals'].features[0]
  app.map.queryRenderedFeatures = (_point, { layers }) => layers.includes('facility-proposal-fill') ? [proposalArea] : []
  app.handlers['click:']({ point: {}, lngLat: [113.83, 34.04] })
  const popupLines = app.popups.at(-1).content.children.map(item => item.textContent)
  assert.match(popupLines[0], /模拟新增 1 站/)
  assert.equal(popupLines[1], `新增前 ${proposalArea.properties.stationCount} 站 → 新增后 ${proposalArea.properties.stationCount + 1} 站`)
  assert.match(popupLines[2], /数量模拟.*选址待核验/)
  const previousBounds = app.bounds.length
  vm.runInContext('focusLayoutScenario(layoutPreview.value.features)', app.context)
  assert.equal(app.bounds.length, previousBounds + 1)
  assert.equal(app.bounds.at(-1)[1].maxZoom, 14)
  const proposalPoint = app.sources['facility-proposals'].features[1]
  const originalPoint = fromMapCoordinate(proposalPoint.geometry.coordinates)
  vm.runInContext("setBasemap('satellite')", app.context)
  assert.ok(turf.distance(turf.point(originalPoint), app.sources['facility-proposals'].features[1]) < .002)
  vm.runInContext("showLayoutScenario({ stage: 'before', features: [hexData.value.features[0]] })", app.context)
  assert.equal(app.sources['facility-proposals'].features.length, 0)
  assert.ok(!legendState(app).some(legend => legend.id === 'facilityProposals'))
  app.cleanup()
})

test('地图空白保留固定展开的图层面板，收起搜索、边界与网格弹窗，正在测距的取点保留窗体', async () => {
  const app = await mount()
  vm.runInContext('openSearchPanel(); quickPanelOpen.value = true; boundaryPanelOpen.value = true; measurePanelOpen.value = true; selectedHex.value = {id: 1}; searchResultCount.value = 5', app.context)
  vm.runInContext('dismissMapWindows({target:{closest:()=>({})}})', app.context)
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), true)
  vm.runInContext('dismissMapWindows({target:{closest:()=>null}})', app.context)
  assert.equal(vm.runInContext('[searchPanelOpen.value,boundaryPanelOpen.value,measurePanelOpen.value,mapNoticesVisible.value].some(Boolean)', app.context), false)
  assert.equal(vm.runInContext('quickPanelOpen.value', app.context), true)
  assert.equal(vm.runInContext('selectedHex.value', app.context), null)
  assert.equal(vm.runInContext('searchResultCount.value', app.context), null)
  vm.runInContext('measuring.value = true; measurePanelOpen.value = true; dismissMapWindows({target:{closest:()=>null}})', app.context)
  assert.equal(vm.runInContext('measurePanelOpen.value', app.context), true)
  assert.equal(vm.runInContext('measuring.value', app.context), true)
  app.cleanup()
})

test('参考点位与当前单个专题的图例随开关同步，全部关闭时为空', async () => {
  const app = await mount()
  const ids = () => legendState(app).map(legend => legend.id)
  assert.deepEqual(ids(), ['stations'])
  vm.runInContext("toggleLayer('stations', false)", app.context)
  assert.deepEqual(ids(), [])
  vm.runInContext("toggleLayer('hexgrid', true)", app.context)
  assert.deepEqual(ids(), ['hexgrid'])
  vm.runInContext("toggleLayer('residential', true); toggleLayer('commercial', true); toggleLayer('demandIndex', true)", app.context)
  assert.deepEqual(ids(), ['residential', 'commercial', 'demandIndex'])
  assert.equal(legendState(app).find(legend => legend.id === 'residential').items[0].color,
    app.options.style.layers.find(layer => layer.id === 'residential-circle').paint['circle-color'])
  vm.runInContext('layerGroups.value.forEach(group => toggleLayer(group.id, false))', app.context)
  assert.deepEqual(ids(), [])
  app.cleanup()
})

test('供需专题切换互斥，图例仅展示所选专题，分级与地图颜色对应', async () => {
  const app = await mount('', false, '/monitoring/demand')
  vm.runInContext("toggleLayer('stations', false)", app.context)
  assert.deepEqual(legendState(app).map(legend => legend.id), ['demandIndex'])
  vm.runInContext("toggleLayer('hexgrid', true)", app.context)
  assert.deepEqual(legendState(app).map(legend => legend.id), ['hexgrid'])
  assert.equal(app.visibility['demand-index-fill'], 'none')
  const supply = legendState(app).find(legend => legend.id === 'hexgrid').items
  assert.equal(supply.at(-1).label, '0 站')
  const supplyColors = app.options.style.layers.find(layer => layer.id === 'hexgrid-fill').paint['fill-color']
  assert.ok(supply.every(item => supplyColors.includes(item.color)))
  for (const [id, mapLayerId] of [['demandIndex', 'demand-index-fill'], ['supplyDemandType', 'supply-demand-type-fill']]) {
    app.context.nextTheme = id
    vm.runInContext('toggleLayer(nextTheme, true)', app.context)
    assert.deepEqual(legendState(app).map(legend => legend.id), [id])
    assert.equal(app.visibility['hexgrid-fill'], 'none')
    const colors = app.options.style.layers.find(layer => layer.id === mapLayerId).paint['fill-color']
    assert.ok(legendState(app).find(legend => legend.id === id).items.every(item => colors.includes(item.color)))
  }
  vm.runInContext("props.activeRoute = '/monitoring/mismatch'; applyRouteView()", app.context)
  assert.deepEqual(legendState(app).map(legend => legend.id), ['stations', 'mismatch'])
  assert.ok(legendState(app).find(legend => legend.id === 'mismatch').gradient.includes('#2166ac'))
  app.cleanup()
})

test('充电站开启时保留两种图例，快充筛选为普通充电标注已隐藏', async () => {
  const app = await mount()
  assert.deepEqual(legendState(app).find(legend => legend.id === 'stations').items.map(item => item.label), ['快充', '普通充电'])
  vm.runInContext("allStationFeatures.value = [{ properties: { chargeType: 'fast' } }, { properties: { chargeType: 'regular' } }, { properties: { chargeType: 'unknown' } }]", app.context)
  assert.deepEqual(legendState(app).map(legend => legend.id), ['stations'])
  assert.deepEqual(legendState(app).find(legend => legend.id === 'stations').items.map(item => item.label), ['快充', '普通充电'])
  assert.deepEqual(legendState(app).find(legend => legend.id === 'stations').items.map(item => item.icon), [iconName('fast'), iconName('regular')])
  vm.runInContext('toggleFastOnly(true)', app.context)
  assert.deepEqual(legendState(app).find(legend => legend.id === 'stations').items.map(item => item.label), ['快充', '普通充电'])
  assert.equal(legendState(app).find(legend => legend.id === 'stations').items[1].hidden, true)
  vm.runInContext('toggleFastOnly(false)', app.context)
  assert.equal(legendState(app).find(legend => legend.id === 'stations').items[1].hidden, false)
  vm.runInContext("toggleLayer('stations', false)", app.context)
  assert.ok(!legendState(app).some(legend => legend.id === 'stations'))
  app.cleanup()
})

function iconName(type) { return type === 'fast' ? chargingMapIcon[3] : chargingMapIcon.at(-1) }

test('网格加载失败时不显示没有数据的专题图例', async () => {
  const app = await mount('hex-grid.json', false, '/monitoring/demand')
  assert.ok(!legendState(app).some(legend => legend.id === 'demandIndex'))
  vm.runInContext("toggleLayer('hexgrid', true); toggleLayer('mismatch', true)", app.context)
  assert.ok(!legendState(app).some(legend => ['hexgrid', 'mismatch'].includes(legend.id)))
  app.cleanup()
})

test('实际图例模板按当前状态渲染，关闭全部图层后隐藏容器', async () => {
  const app = await mount()
  const source = fs.readFileSync(new URL('../src/components/MapView.vue', import.meta.url), 'utf8')
  const template = source.split('<!-- 图例：同时展示')[1].split('<!-- 缩放与定位 -->')[0].replace(/^[\s\S]*?-->/, '')
  const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
  const html = () => {
    const application = Vue.createSSRApp({ render, setup: () => ({ loading: false, activeLegends: legendState(app) }) })
    application.component('UiIcon', { props: ['name', 'size'], render() { return Vue.h('svg', { 'data-icon': this.name }) } })
    application.component('TermHint', { props: ['term', 'label', 'iconOnly'], render() { return Vue.h('span', { 'data-term': this.term }, this.iconOnly ? '' : this.label) } })
    return renderToString(application)
  }
  vm.runInContext("toggleLayer('commercial', true); toggleLayer('hexgrid', true)", app.context)
  const visibleHtml = await html()
  assert.match(visibleHtml, /商业需求样本图例/)
  assert.match(visibleHtml, /充电站数量分布图例/)
  assert.match(visibleHtml, /普通充电/)
  assert.match(visibleHtml, /data-icon="charge-regular"/)
  vm.runInContext('toggleFastOnly(true)', app.context)
  assert.match(await html(), /普通充电<\/span><small class="legend-hidden-note">已隐藏/)
  assert.doesNotMatch(visibleHtml, /密度热力图/)
  assert.doesNotMatch(visibleHtml, /魏都区.*边界|行政区域填充/)
  vm.runInContext('layerGroups.value.forEach(group => toggleLayer(group.id, false))', app.context)
  vm.runInContext("toggleLayer('boundary', true)", app.context)
  assert.doesNotMatch(await html(), /map-legend/)
  app.cleanup()
})
