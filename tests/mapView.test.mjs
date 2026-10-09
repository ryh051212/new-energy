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
  const listeners = new Map()
  let options
  let cameraCenter
  let removed = false
  let requestSignal
  let ready
  let cleanup
  const map = {
    on(name, layer, callback) { handlers[`${name}:${typeof layer === 'string' ? layer : ''}`] = callback || layer },
    getSource(name) {
      assert.equal(removed, false, '卸载后不能继续访问地图')
      return { setData(data) { sources[name] = data } }
    },
    getLayer() { return {} },
    setLayoutProperty(id, property, value) { visibility[id] = value },
    setPaintProperty(id, property, value) { paint[`${id}:${property}`] = value },
    fitBounds(...args) { bounds.push(args) }, getCanvas() { return {} }, resize() {}, remove() { removed = true },
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
    defineProps: () => ({ activeRoute }), watch() {},
    ref: value => ({ value }), computed: callback => ({ get value() { return callback() } }),
    onMounted: callback => { ready = callback },
    onBeforeUnmount: callback => { cleanup = callback }, turf, workerUrl: '', chargingMapIcon, chargingMapColor, registerChargingIcons,
    AMAP_STANDARD_SOURCE, toMapCoordinate, fromMapCoordinate, toMapGeoJSON,
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
  locationOptions.beforeLoad?.(locationRequests)
  await handlers['load:']()
  return { sources, handlers, popups, map, cleanup, options, visibility, paint, bounds, flights, listeners, filters, historyStorage, requestSignal, requests, context, locationRequests, markers,
    state: vm.runInContext('({ count: weiduStationCount.value, commercialCount: commercialCount.value, error: loadError.value, warning: gridWarning.value, loading: loading.value })', context) }
}

test('主界面进入自动定位一次，数据迟到保留当前位置，切换底图及手动重定位复用标记', async () => {
  const coordinates = [113.83, 34.04]
  const app = await mount('', false, '/', new Map(), {
    beforeLoad(requests) { requests[0].success({ coords: { longitude: coordinates[0], latitude: coordinates[1] } }) },
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
  assert.equal(app.locationRequests.length, 1)
  assert.equal(app.bounds.length, 1)
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

test('热力图默认关闭，开启隐藏充电图标，关闭按站点开关恢复', async () => {
  const app = await mount()
  const heatmap = app.options.style.layers.find(layer => layer.id === 'stations-heatmap')
  assert.equal(heatmap.layout.visibility, 'none')
  assert.equal(app.visibility['stations-heatmap'], 'none')
  assert.equal(app.visibility['hexgrid-fill'], 'none')
  assert.equal(app.visibility['hexgrid-outline'], 'none')
  vm.runInContext("toggleLayer('heatmap', true)", app.context)
  assert.equal(app.visibility['stations-heatmap'], 'visible')
  assert.equal(app.visibility['stations-bolt'], 'none')
  assert.equal(app.visibility['stations-circle'], 'none')
  assert.ok(!legendState(app).some(legend => legend.id === 'stations'))
  vm.runInContext("toggleLayer('stations', true)", app.context)
  assert.equal(app.visibility['stations-bolt'], 'none', '热力图开启时不能重新叠加站点图标')
  vm.runInContext("toggleLayer('heatmap', false)", app.context)
  assert.equal(app.visibility['stations-bolt'], 'visible')
  assert.equal(app.visibility['stations-circle'], 'visible')
  assert.ok(legendState(app).some(legend => legend.id === 'stations'))
  vm.runInContext("toggleLayer('heatmap', true); toggleLayer('stations', false); toggleLayer('heatmap', false)", app.context)
  assert.equal(app.visibility['stations-bolt'], 'none', '用户关闭站点后不能强制恢复图标')
  vm.runInContext("toggleLayer('stations', true); toggleLayer('heatmap', true)", app.context)
  vm.runInContext("props.activeRoute = '/monitoring/stations'; applyRouteView()", app.context)
  assert.equal(app.visibility['stations-heatmap'], 'none')
  assert.equal(app.visibility['stations-bolt'], 'visible')
  app.cleanup()
})

test('专题路由直接访问和切换时打开对应图层', async () => {
  const app = await mount('', false, '/monitoring/demand')
  assert.equal(app.visibility['demand-index-fill'], 'visible')
  assert.equal(app.visibility['stations-heatmap'], 'none')
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
    options.layers.includes('stations-circle') ? [] : event.features
  app.handlers['click:'](event)
  assert.equal(app.popups[0].removed, true)
  assert.equal(app.popups[1].content.children[1].textContent, '充电站数量：0')
  assert.equal(app.popups[1].content.children[3].textContent, '商业设施数量：0')
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
  assert.equal(JSON.stringify(app.filters['stations-heatmap']), expected)
  vm.runInContext('toggleFastOnly(false)', app.context)
  assert.equal(app.filters['stations-circle'], null)
  app.cleanup()
})

test('业务图层可以反复开关，常用和全部列表均不包含行政边界', async () => {
  const app = await mount()
  const ids = () => vm.runInContext("switchableLayers.value.map(item => item.id).join(',')", app.context)
  assert.equal(ids(), 'stations,hexgrid,heatmap,residential,commercial')
  vm.runInContext("toggleLayer('residential', true)", app.context)
  assert.equal(app.visibility['residential-circle'], 'visible')
  assert.equal(ids(), 'stations,hexgrid,heatmap,residential,commercial')
  vm.runInContext("toggleLayer('residential', false)", app.context)
  assert.equal(app.visibility['residential-circle'], 'none')
  vm.runInContext('showAllLayers.value = true', app.context)
  assert.equal(ids(), 'stations,hexgrid,heatmap,residential,commercial,residentialDemand,demandIndex,mismatch,supplyDemandType')
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

test('边界与图层面板互斥，点击外部或 Escape 关闭，卸载清理监听', async () => {
  const app = await mount()
  const state = () => vm.runInContext('[boundaryPanelOpen.value, quickPanelOpen.value].join()', app.context)
  vm.runInContext('toggleBoundaryPanel()', app.context)
  assert.equal(state(), 'true,false')
  vm.runInContext('toggleQuickPanel()', app.context)
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

test('地图空白收起搜索、图层、边界、测距结果与网格弹窗，功能区和正在测距的取点保留窗体', async () => {
  const app = await mount()
  vm.runInContext('openSearchPanel(); quickPanelOpen.value = true; boundaryPanelOpen.value = true; measurePanelOpen.value = true; selectedHex.value = {id: 1}; searchResultCount.value = 5', app.context)
  vm.runInContext('dismissMapWindows({target:{closest:()=>({})}})', app.context)
  assert.equal(vm.runInContext('searchPanelOpen.value', app.context), true)
  vm.runInContext('dismissMapWindows({target:{closest:()=>null}})', app.context)
  assert.equal(vm.runInContext('[searchPanelOpen.value,quickPanelOpen.value,boundaryPanelOpen.value,measurePanelOpen.value,mapNoticesVisible.value].some(Boolean)', app.context), false)
  assert.equal(vm.runInContext('selectedHex.value', app.context), null)
  assert.equal(vm.runInContext('searchResultCount.value', app.context), null)
  vm.runInContext('measuring.value = true; measurePanelOpen.value = true; dismissMapWindows({target:{closest:()=>null}})', app.context)
  assert.equal(vm.runInContext('measurePanelOpen.value', app.context), true)
  assert.equal(vm.runInContext('measuring.value', app.context), true)
  app.cleanup()
})

test('图例随图层开关增加、移除并支持多层同时展示，全部关闭时为空', async () => {
  const app = await mount()
  const ids = () => legendState(app).map(legend => legend.id)
  assert.deepEqual(ids(), ['stations'])
  vm.runInContext("toggleLayer('stations', false)", app.context)
  assert.deepEqual(ids(), [])
  vm.runInContext("toggleLayer('heatmap', true)", app.context)
  assert.deepEqual(ids(), ['heatmap'])
  vm.runInContext("toggleLayer('heatmap', false); toggleLayer('residential', true); toggleLayer('commercial', true); toggleLayer('residentialDemand', true)", app.context)
  assert.deepEqual(ids(), ['residential', 'commercial', 'residentialDemand'])
  assert.equal(legendState(app).find(legend => legend.id === 'residential').items[0].color,
    app.options.style.layers.find(layer => layer.id === 'residential-circle').paint['circle-color'])
  vm.runInContext('layerGroups.value.forEach(group => toggleLayer(group.id, false))', app.context)
  assert.deepEqual(ids(), [])
  app.cleanup()
})

test('专题路由和手动开启的专题图例独立，显示完整分级并对应地图颜色', async () => {
  const app = await mount('', false, '/monitoring/demand')
  vm.runInContext("toggleLayer('stations', false)", app.context)
  assert.deepEqual(legendState(app).map(legend => legend.id), ['demandIndex'])
  vm.runInContext("toggleLayer('demandIndex', false); toggleLayer('hexgrid', true); toggleLayer('supplyDemandType', true); toggleLayer('residentialDemand', true)", app.context)
  const legends = legendState(app)
  assert.deepEqual(legends.map(legend => legend.id), ['hexgrid', 'residentialDemand', 'supplyDemandType'])
  const supply = legends.find(legend => legend.id === 'hexgrid').items
  assert.equal(supply.at(-1).label, '0 站')
  const supplyColors = app.options.style.layers.find(layer => layer.id === 'hexgrid-fill').paint['fill-color']
  assert.ok(supply.every(item => supplyColors.includes(item.color)))
  for (const [id, mapLayerId] of [['residentialDemand', 'residential-demand-fill'], ['supplyDemandType', 'supply-demand-type-fill']]) {
    const colors = app.options.style.layers.find(layer => layer.id === mapLayerId).paint['fill-color']
    assert.ok(legends.find(legend => legend.id === id).items.every(item => colors.includes(item.color)))
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
    return renderToString(application)
  }
  vm.runInContext("toggleLayer('heatmap', false); toggleLayer('commercial', true); toggleLayer('residentialDemand', true)", app.context)
  const visibleHtml = await html()
  assert.match(visibleHtml, /商业设施图例/)
  assert.match(visibleHtml, /居民需求分布图例/)
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
