import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { ref, computed, watch, nextTick, effectScope } from 'vue'
import { filterStations } from '../src/utils/stations.js'
import { normalizeChargingPoint, selectChargingStations, stationDistance, stationMetric } from '../src/utils/charging.js'

async function mount({ secure = true, supported = true, throws = false } = {}) {
  const source = fs.readFileSync(new URL('../src/components/ChargingView.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup>')[1].split('</script>')[0]
    .replace(/^import\b[^\n]*\r?\n/gm, '').replaceAll('import.meta.env.BASE_URL', '"/"')
  const requests = [], markers = [], flights = [], handlers = {}
  let start, cleanup, removed = false, mapData
  const map = {
    on(name, layer, callback) { handlers[`${name}:${typeof layer === 'string' ? layer : ''}`] = callback || layer },
    getSource() { assert.equal(removed, false); return { setData(data) { mapData = data } } },
    getLayer() { return {} }, setFilter() {}, addImage() {}, getZoom() { return 12 },
    flyTo(options) { assert.equal(removed, false); flights.push(options) },
    resize() {}, remove() { removed = true },
  }
  class Marker {
    constructor() { markers.push(this) }
    setLngLat(coordinates) { this.coordinates = coordinates; return this }
    addTo() { return this }
    remove() { this.removed = true }
  }
  const context = vm.createContext({
    ref, computed, watch, normalizeChargingPoint, selectChargingStations, stationDistance, stationMetric, filterStations,
    onMounted(callback) { start = callback }, onBeforeUnmount(callback) { cleanup = callback },
    maplibregl: { setWorkerUrl() {}, Map: function () { return map }, Marker }, workerUrl: '',
    window: { isSecureContext: secure },
    navigator: { geolocation: supported ? { getCurrentPosition(success, failure, options) {
      if (throws) throw Object.assign(new Error('denied'), { name: 'SecurityError' })
      requests.push({ success, failure, options })
    } } : undefined },
    AbortController, ResizeObserver: class { observe() {} disconnect() {} },
    document: { createElement() { return {
      setAttribute() {}, append() {}, getContext() { return {
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, getImageData() { return {} },
      } },
    } } },
    fetch: async url => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(
      new URL(`../public/geojson/${url.split('/').pop()}`, import.meta.url), 'utf8').replace(/^\uFEFF/, '')) }),
  })
  const scope = effectScope()
  scope.run(() => vm.runInContext(script, context))
  start()
  await handlers['load:']()
  await nextTick()
  return { requests, markers, flights, run: code => vm.runInContext(code, context),
    data: () => mapData, cleanup() { cleanup(); scope.stop() } }
}
const position = (longitude = 113.83, latitude = 34.04) => ({ coords: { longitude, latitude, accuracy: 18.2 } })

test('找充电定位只请求一次，重新定位复用标记，并显示精度', async () => {
  const app = await mount()
  app.run('locate(); locate()')
  assert.equal(app.requests.length, 1)
  assert.equal(app.run('locating.value'), true)
  assert.equal(app.requests[0].options.maximumAge, 0)
  app.requests[0].success(position())
  await nextTick()
  assert.equal(app.run('locating.value'), false)
  assert.match(app.run('feedback.value'), /精度约 18 m/)
  app.run('locate()')
  app.requests[1].success(position(113.84))
  await nextTick()
  assert.equal(app.markers.length, 1)
  assert.equal(app.markers[0].coordinates[0], 113.84)
  assert.equal(app.flights.at(-1).center[0], 113.84)
  assert.ok(app.data().features.every(feature => feature.properties.coordSystem === 'WGS84'))
  app.cleanup()
})

test('选距离先定位，失败后重试仍应用所选范围，重置可取消待应用范围', async () => {
  const app = await mount()
  app.run('setRadius(1)')
  app.requests[0].failure({ code: 3 })
  assert.match(app.run('locationError.value'), /超时/)
  app.run('locate()')
  assert.equal(app.run('locationError.value'), '')
  const stationCoordinates = app.run('stations.value[0].geometry.coordinates')
  app.requests[1].success(position(...stationCoordinates))
  await nextTick()
  assert.equal(app.run('radius.value'), 1)
  assert.ok(app.data().features.length > 0)
  assert.ok(app.data().features.every(feature => stationDistance(feature, stationCoordinates) <= 1))
  app.cleanup()

  const reset = await mount()
  reset.run('setRadius(3); resetFilters()')
  reset.requests[0].success(position())
  await nextTick()
  assert.equal(reset.run('radius.value'), 0)
  reset.cleanup()
})

test('权限拒绝、不可用和超时均恢复按钮，重新定位失败保留已有位置', async () => {
  const app = await mount()
  app.run('locate()')
  app.requests[0].success(position())
  for (const [code, message] of [[1, /位置权限/], [2, /暂时无法/], [3, /超时/]]) {
    app.run('locate()')
    app.requests.at(-1).failure({ code })
    assert.equal(app.run('locating.value'), false)
    assert.match(app.run('locationError.value'), message)
    assert.equal(app.run('location.value[0]'), 113.83)
  }
  app.cleanup()
})

test('非安全页面、不支持定位及同步异常有明确提示', async () => {
  for (const [options, message] of [[{ secure: false }, /HTTPS/], [{ supported: false }, /不支持/], [{ throws: true }, /位置权限/]]) {
    const app = await mount(options)
    app.run('locate()')
    assert.equal(app.run('locating.value'), false)
    assert.match(app.run('locationError.value'), message)
    assert.equal(app.markers.length, 0)
    app.cleanup()
  }
})

test('无效坐标不进入地图，离开路由后的定位回调不访问地图', async () => {
  const app = await mount()
  app.run('locate()')
  app.requests[0].success(position(NaN))
  assert.equal(app.markers.length, 0)
  assert.equal(app.run('location.value'), null)
  app.run('locate()')
  app.cleanup()
  app.requests[1].success(position())
  app.requests[1].failure({ code: 3 })
  await nextTick()
  assert.equal(app.markers.length, 0)
  assert.equal(app.flights.length, 0)
})
