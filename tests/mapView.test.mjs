import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as turf from '@turf/turf'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'

// 执行 MapView 真实的内联事件代码，使用本地数据和模拟地图检查功能。
async function mount(failFile = '', leaveDuringFetch = false, activeRoute = '/') {
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
  const listeners = new Map()
  let options
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
  const context = vm.createContext({
    defineProps: () => ({ activeRoute }), watch() {},
    ref: value => ({ value }), computed: callback => ({ get value() { return callback() } }),
    onMounted: callback => { ready = callback },
    onBeforeUnmount: callback => { cleanup = callback }, turf, workerUrl: '',
    maplibregl: { setWorkerUrl() {}, Map: function (config) { options = config; return map }, Popup },
    AbortController, AbortSignal, ResizeObserver: class { observe() {} disconnect() {} },
    console: { error() {}, log() {} },
    document: {
      createElement() { return { children: [], append(child) { this.children.push(child) } } },
      addEventListener(name, callback) { listeners.set(name, callback) },
      removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name) },
    },
    fetch: async (url, config) => {
      requests.push(url)
      if (config?.signal) requestSignal = config.signal
      const filename = url.includes('/api/stations') ? 'stations.json' : url.split('/').pop()
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
  await handlers['load:']()
  return { sources, handlers, popups, map, cleanup, options, visibility, paint, bounds, listeners, filters, requestSignal, requests, context,
    state: vm.runInContext('({ count: weiduStationCount.value, commercialCount: commercialCount.value, error: loadError.value, warning: gridWarning.value, loading: loading.value })', context) }
}

test('首页默认显示热力图并隐藏供给网格', async () => {
  const app = await mount()
  const heatmap = app.options.style.layers.find(layer => layer.id === 'stations-heatmap')
  assert.equal(heatmap.layout.visibility, 'none')
  assert.equal(app.visibility['stations-heatmap'], 'visible')
  assert.equal(app.visibility['hexgrid-fill'], 'none')
  assert.equal(app.visibility['hexgrid-outline'], 'none')
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

test('后端未启动时使用本地站点数据', async () => {
  const app = await mount('api-only')
  assert.equal(app.state.count, 52)
  assert.equal(app.state.error, '')
  assert.ok(app.requests.some(url => url.endsWith('/geojson/stations.json')))
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

test('网格失败仍显示站点，站点失败显示错误', async () => {
  const gridFailure = await mount('hex-grid.json')
  assert.equal(gridFailure.state.count, 52)
  assert.ok(gridFailure.state.warning)
  assert.equal(gridFailure.state.error, '')
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

test('按站名搜索并清空搜索后恢复站点', async () => {
  const app = await mount()
  const name = app.sources.stations.features[0].properties.name
  vm.runInContext(`stationKeyword.value = ${JSON.stringify(name)}`, app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.ok(app.requests.at(-1).includes(`name=${encodeURIComponent(name)}`))
  assert.ok(app.sources.stations.features.length >= 1)
  assert.ok(app.sources.stations.features.every(feature => feature.properties.name.includes(name)))
  vm.runInContext("stationKeyword.value = ''", app.context)
  await vm.runInContext('searchStation()', app.context)
  assert.equal(app.sources.stations.features.length, 52)
  app.cleanup()
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

test('充电站头上的闪电图标跟着「充电站」开关一起显隐', async () => {
  const app = await mount()
  const bolt = app.options.style.layers.find(layer => layer.id === 'stations-bolt')
  assert.equal(bolt.type, 'symbol')
  assert.equal(bolt.layout['icon-image'], 'bolt-icon')
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

test('图例随图层开关增加、移除并支持多层同时展示，全部关闭时为空', async () => {
  const app = await mount()
  const ids = () => legendState(app).map(legend => legend.id)
  assert.deepEqual(ids(), ['stations', 'heatmap'])
  vm.runInContext("toggleLayer('heatmap', false); toggleLayer('residential', true); toggleLayer('commercial', true); toggleLayer('residentialDemand', true)", app.context)
  assert.deepEqual(ids(), ['stations', 'residential', 'commercial', 'residentialDemand'])
  assert.equal(legendState(app).find(legend => legend.id === 'residential').items[0].color,
    app.options.style.layers.find(layer => layer.id === 'residential-circle').paint['circle-color'])
  vm.runInContext('layerGroups.value.forEach(group => toggleLayer(group.id, false))', app.context)
  assert.deepEqual(ids(), [])
  app.cleanup()
})

test('专题路由和手动开启的专题图例独立，显示完整分级并对应地图颜色', async () => {
  const app = await mount('', false, '/monitoring/demand')
  assert.deepEqual(legendState(app).map(legend => legend.id), ['stations', 'demandIndex'])
  vm.runInContext("toggleLayer('demandIndex', false); toggleLayer('hexgrid', true); toggleLayer('supplyDemandType', true); toggleLayer('residentialDemand', true)", app.context)
  const legends = legendState(app)
  assert.deepEqual(legends.map(legend => legend.id), ['stations', 'hexgrid', 'residentialDemand', 'supplyDemandType'])
  const supply = legends.find(legend => legend.id === 'hexgrid').items
  assert.equal(supply.at(-1).label, '0 站')
  assert.equal(supply.at(-1).color, app.sources.hexgrid.features.find(feature => feature.properties.stationCount === 0).properties.color)
  for (const [id, mapLayerId] of [['residentialDemand', 'residential-demand-fill'], ['supplyDemandType', 'supply-demand-type-fill']]) {
    const colors = app.options.style.layers.find(layer => layer.id === mapLayerId).paint['fill-color']
    assert.ok(legends.find(legend => legend.id === id).items.every(item => colors.includes(item.color)))
  }
  vm.runInContext("props.activeRoute = '/monitoring/mismatch'; applyRouteView()", app.context)
  assert.deepEqual(legendState(app).map(legend => legend.id), ['stations', 'mismatch'])
  assert.ok(legendState(app).find(legend => legend.id === 'mismatch').gradient.includes('#2166ac'))
  app.cleanup()
})

test('站点图例跟随真实类型和快充筛选', async () => {
  const app = await mount()
  assert.deepEqual(legendState(app).find(legend => legend.id === 'stations').items.map(item => item.label), ['充电站（类型未标注）'])
  vm.runInContext("allStationFeatures.value = [{ properties: { chargeType: 'fast' } }, { properties: { chargeType: 'slow' } }, { properties: { chargeType: 'unknown' } }]", app.context)
  assert.deepEqual(legendState(app).find(legend => legend.id === 'stations').items.map(item => item.label), ['快充站', '慢充站', '充电站（类型未标注）'])
  vm.runInContext('toggleFastOnly(true)', app.context)
  assert.deepEqual(legendState(app).find(legend => legend.id === 'stations').items.map(item => item.label), ['快充站'])
  vm.runInContext("toggleLayer('stations', false)", app.context)
  assert.ok(!legendState(app).some(legend => legend.id === 'stations'))
  app.cleanup()
})

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
  const html = () => renderToString(Vue.createSSRApp({ render, setup: () => ({ loading: false, activeLegends: legendState(app) }) }))
  vm.runInContext("toggleLayer('heatmap', false); toggleLayer('commercial', true); toggleLayer('residentialDemand', true)", app.context)
  const visibleHtml = await html()
  assert.match(visibleHtml, /商业设施图例/)
  assert.match(visibleHtml, /居民需求分布图例/)
  assert.doesNotMatch(visibleHtml, /密度热力图/)
  assert.doesNotMatch(visibleHtml, /魏都区.*边界|行政区域填充/)
  vm.runInContext('layerGroups.value.forEach(group => toggleLayer(group.id, false))', app.context)
  vm.runInContext("toggleLayer('boundary', true)", app.context)
  assert.doesNotMatch(await html(), /map-legend/)
  app.cleanup()
})
