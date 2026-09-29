import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as turf from '@turf/turf'

// 执行 MapView 真实的内联事件代码，使用本地数据和模拟地图检查功能。
async function mount(failFile = '', leaveDuringFetch = false) {
  const source = fs.readFileSync(new URL('../src/components/MapView.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup>')[1].split('</script>')[0]
    .replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.env.BASE_URL', '"/"')
  const handlers = {}
  const sources = {}
  const requests = []
  const popups = []
  const visibility = {}
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
    fitBounds() {}, getCanvas() { return {} }, resize() {}, remove() { removed = true },
    queryRenderedFeatures() { return [] },
    setFilter() {},
  }
  class Popup {
    constructor() { popups.push(this) }
    setLngLat() { return this }
    setDOMContent(content) { this.content = content; return this }
    addTo() { return this }
    remove() { this.removed = true }
  }
  const context = vm.createContext({
    ref: value => ({ value }), computed: callback => ({ get value() { return callback() } }),
    onMounted: callback => { ready = callback },
    onBeforeUnmount: callback => { cleanup = callback }, turf, workerUrl: '',
    maplibregl: { setWorkerUrl() {}, Map: function (config) { options = config; return map }, Popup },
    AbortController, AbortSignal, ResizeObserver: class { observe() {} disconnect() {} },
    console: { error() {}, log() {} },
    document: { createElement() { return { children: [], append(child) { this.children.push(child) } } } },
    fetch: async (url, config) => {
      requests.push(url)
      if (config?.signal) requestSignal = config.signal
      const filename = url.includes('/api/stations') ? 'stations.json' : url.split('/').pop()
      return { ok: filename !== failFile, json: async () => {
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
  return { sources, handlers, popups, map, cleanup, options, visibility, requestSignal, requests, context,
    state: vm.runInContext('({ count: weiduStationCount.value, commercialCount: commercialCount.value, error: loadError.value, warning: gridWarning.value, loading: loading.value })', context) }
}

test('热力图与网格默认隐藏', async () => {
  const app = await mount()
  const heatmap = app.options.style.layers.find(layer => layer.id === 'stations-heatmap')
  assert.equal(heatmap.layout.visibility, 'none')
  assert.equal(app.visibility['stations-heatmap'], 'none')
  assert.equal(app.visibility['hexgrid-fill'], 'none')
  assert.equal(app.visibility['hexgrid-outline'], 'none')
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
