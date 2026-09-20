import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as turf from '@turf/turf'

// 执行 MapView 真实的内联事件代码，使用本地数据和模拟地图检查功能。
async function mount(failFile = '') {
  const source = fs.readFileSync(new URL('../src/components/MapView.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup>')[1].split('</script>')[0]
    .replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.env.BASE_URL', '"/"')
  const handlers = {}
  const sources = {}
  const popups = []
  let ready
  let cleanup
  const map = {
    on(name, layer, callback) { handlers[`${name}:${typeof layer === 'string' ? layer : ''}`] = callback || layer },
    getSource(name) { return { setData(data) { sources[name] = data } } },
    fitBounds() {}, getCanvas() { return {} }, resize() {}, remove() {},
    queryRenderedFeatures() { return [] },
  }
  class Popup {
    constructor() { popups.push(this) }
    setLngLat() { return this }
    setDOMContent(content) { this.content = content; return this }
    addTo() { return this }
    remove() { this.removed = true }
  }
  const context = vm.createContext({
    ref: value => ({ value }), onMounted: callback => { ready = callback },
    onBeforeUnmount: callback => { cleanup = callback }, turf, workerUrl: '',
    maplibregl: { setWorkerUrl() {}, Map: function () { return map }, Popup },
    AbortController, AbortSignal, ResizeObserver: class { observe() {} disconnect() {} },
    console: { error() {} },
    document: { createElement() { return { children: [], append(child) { this.children.push(child) } } } },
    fetch: async url => {
      const filename = url.split('/').pop()
      return { ok: filename !== failFile, json: async () => JSON.parse(fs.readFileSync(new URL(`../public/geojson/${filename}`, import.meta.url), 'utf8')) }
    },
  })
  vm.runInContext(script, context)
  ready()
  await handlers['load:']()
  return { sources, handlers, popups, map, cleanup,
    state: vm.runInContext('({ count: weiduStationCount.value, error: loadError.value, warning: gridWarning.value, loading: loading.value })', context) }
}

test('MapView 内联筛选与网格累计数量一致', async () => {
  const app = await mount()
  assert.equal(app.state.error, '')
  assert.equal(app.state.count, 52)
  assert.equal(app.sources.hexgrid.features.reduce((sum, hex) => sum + hex.properties.stationCount, 0), 52)
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
  app.handlers['click:hexgrid-fill'](event)
  assert.equal(app.popups.length, 1)
  app.map.queryRenderedFeatures = () => []
  app.handlers['click:hexgrid-fill'](event)
  assert.equal(app.popups[0].removed, true)
  assert.equal(app.popups[1].content.children[1].textContent, '充电站数量：0')
  app.cleanup()
})
