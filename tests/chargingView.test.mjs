import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { ref, computed, watch, nextTick, effectScope } from 'vue'
import { circle, bbox } from '@turf/turf'
import { filterStations } from '../src/utils/stations.js'
import { normalizeChargingPoint, selectChargingStations, stationDistance, stationMetric, chargingDistanceInfo, formatChargingDistance, rankChargingRecommendations, chargingStationFacts } from '../src/utils/charging.js'
import { chargingMapIcon, chargingMapColor, registerChargingIcons } from '../src/utils/chargingIcons.js'
import { DEFAULT_TRIP, TRIP_INTENTS, normalizeTripContext, rankTripStations, evaluateTripStation, tripInputIssues, isDestinationIntent } from '../src/utils/tripCharging.js'
import { readChargingSettings, saveChargingSettings, normalizeIntent, CHARGING_SETTINGS_KEY } from '../src/utils/chargingSettings.js'
import { AMAP_STANDARD_SOURCE, toMapCoordinate, toMapGeoJSON, fromMapCoordinate } from '../src/utils/basemaps.js'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'

async function mount({ secure = true, supported = true, throws = false, load = true, stationError = false,
  deferRoutes = false, routeError = false, width = 1280, deferPlans = false, planError = false, intent = '',
  planData = { type: 'FeatureCollection', features: [] }, routeData = { type: 'FeatureCollection', features: [] } } = {}) {
  const source = fs.readFileSync(new URL('../src/components/ChargingView.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup>')[1].split('</script>')[0]
    .replace(/^import\b[^\n]*\r?\n/gm, '').replaceAll('import.meta.env.BASE_URL', '"/"')
  const requests = [], routeRequests = [], planRequests = [], markers = [], flights = [], bounds = [], handlers = {}, controls = [], sourceData = {}, mapFilters = {}
  let start, cleanup, removed = false, mapOptions
  const map = {
    on(name, layer, callback) { handlers[`${name}:${typeof layer === 'string' ? layer : ''}`] = callback || layer },
    getSource(name) { assert.equal(removed, false); return { setData(data) { sourceData[name] = data } } },
    getLayer() { return {} }, setFilter(name, filter) { mapFilters[name] = filter }, addImage() {}, getZoom() { return 12 },
    addControl(control, position) { controls.push({ control, position }) },
    flyTo(options) { assert.equal(removed, false); flights.push(options) },
    fitBounds(value, options) { assert.equal(removed, false); bounds.push({ value, options }) },
    resize() {}, remove() { removed = true },
  }
  class Marker {
    constructor(options) { this.options = options; markers.push(this) }
    setLngLat(coordinates) { this.coordinates = coordinates; return this }
    addTo() { return this }
    remove() { this.removed = true }
  }
  const context = vm.createContext({
    ref, computed, watch, circle, bbox, normalizeChargingPoint, selectChargingStations, stationDistance, stationMetric, chargingDistanceInfo, formatChargingDistance, rankChargingRecommendations, filterStations, chargingMapIcon, chargingMapColor, registerChargingIcons, URLSearchParams,
    AMAP_STANDARD_SOURCE, toMapCoordinate, toMapGeoJSON, DEFAULT_TRIP, TRIP_INTENTS, normalizeTripContext, rankTripStations, evaluateTripStation, tripInputIssues, isDestinationIntent,
    readChargingSettings, saveChargingSettings, normalizeIntent, CHARGING_SETTINGS_KEY,
    onMounted(callback) { start = callback }, onBeforeUnmount(callback) { cleanup = callback },
    maplibregl: { setWorkerUrl() {}, Map: function (options) {
      mapOptions = options
      for (const [name, source] of Object.entries(options.style.sources)) if (source.data) sourceData[name] = source.data
      return map
    }, Marker,
      ScaleControl: class { constructor(options) { this.options = options } } }, workerUrl: '',
    window: { isSecureContext: secure, innerWidth: width, innerHeight: 800 },
    navigator: { geolocation: supported ? { getCurrentPosition(success, failure, options) {
      if (throws) throw Object.assign(new Error('denied'), { name: 'SecurityError' })
      requests.push({ success, failure, options })
    } } : undefined },
    AbortController, setTimeout, clearTimeout, ResizeObserver: class { observe() {} disconnect() {} },
    document: { createElement() { return {
      setAttribute() {}, append() {}, getContext() { return {
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, getImageData() { return {} },
      } },
    } } },
    fetch: async (url, options) => {
      if (url.includes('/routes?')) {
        const request = { url, signal: options.signal }
        planRequests.push(request)
        if (deferPlans) return new Promise((resolve, reject) => Object.assign(request, { resolve, reject }))
        return { ok: !planError, json: async () => planData }
      }
      if (url.includes('/api/stations/recommended')) {
        const request = { url, signal: options.signal }
        routeRequests.push(request)
        if (deferRoutes) return new Promise((resolve, reject) => { Object.assign(request, { resolve, reject }) })
        return { ok: !routeError, json: async () => routeData }
      }
      return { ok: !(stationError && url.includes('/api/stations')), status: stationError ? 500 : 200,
        json: async () => JSON.parse(fs.readFileSync(
          new URL(`../public/geojson/${url.includes('/api/stations') ? 'stations.json' : url.split('/').pop()}`, import.meta.url), 'utf8').replace(/^\uFEFF/, '')) }
    },
  })
  const scope = effectScope()
  scope.run(() => vm.runInContext(script, context))
  vm.runInContext(`tripIntent.value = '${intent}'`, context)
  start()
  const loadMap = async () => { await handlers['load:'](); await nextTick() }
  if (load) await loadMap()
  return { requests, routeRequests, planRequests, handlers, markers, flights, bounds, controls, mapFilters, mapOptions, load: loadMap, run: code => vm.runInContext(code, context),
    data: (name = 'charging-stations') => sourceData[name], cleanup() { cleanup(); scope.stop() } }
}

test('出行参数随请求传递；切换目的和车辆参数取消旧请求且忽略迟到结果', async () => {
  const app = await mount({ intent: 'urgent', deferRoutes: true })
  try {
    app.requests[0].success({ coords: { longitude: 113.82, latitude: 34.03, accuracy: 10 } })
    await nextTick()
    const first = app.routeRequests.at(-1)
    assert.equal(new URL(first.url).searchParams.get('intent'), 'urgent')
    app.run("tripProfile.value = normalizeTripContext({ ...DEFAULT_TRIP, currentSoc: 20, batteryKwh: 60, consumptionKwh: 15, maxChargeKw: 100, queueMinutes: 5 })")
    await nextTick()
    assert.equal(first.signal.aborted, true)
    const configured = new URL(app.routeRequests.at(-1).url).searchParams
    const context = JSON.parse(configured.get('trip_context'))
    assert.equal(context.currentSoc, 20)
    assert.deepEqual(context.origin, [113.82, 34.03])
    app.run("chooseIntent('destination')")
    await nextTick()
    assert.equal(new URL(app.routeRequests.at(-1).url).searchParams.get('intent'), 'destination')
    first.resolve({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [{ properties: { id: 'stale' }, geometry: { type: 'Point', coordinates: [113.83, 34.04] } }] }) })
    await nextTick()
    assert.equal(app.run('routeRecommendations.value.length'), 0)
  } finally { app.cleanup() }
})

test('出行推荐服务失效仍使用相同条件，排除不可达站；修改参数清除旧路线', async () => {
  const app = await mount({ intent: 'urgent', routeError: true })
  try {
    app.run("stations.value = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [113.83,34.03] }, properties: { id:'safe',powerKw:120 } }, { type: 'Feature', geometry: { type: 'Point', coordinates: [115,34.03] }, properties: { id:'far',powerKw:120 } }]")
    app.run("tripProfile.value = normalizeTripContext({ ...DEFAULT_TRIP, currentSoc:20, batteryKwh:60, consumptionKwh:15, maxChargeKw:100, queueMinutes:0 })")
    app.requests[0].success({ coords: { longitude: 113.82, latitude: 34.03, accuracy: 10 } })
    await nextTick()
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(app.run('routeStatus.value'), 'error')
    assert.equal(app.run('recommendedStations.value.length'), 1)
    assert.equal(app.run('recommendedStations.value[0].properties.tripFit.safety'), 'unknown')
    assert.equal(app.run('recommendedStations.value[0].properties.tripFit.totalMinutes'), null)
    app.run("planningStation.value = stations.value[0]; routeFocused.value = true; chooseIntent('economy')")
    await nextTick()
    assert.equal(app.run('planningStation.value'), null)
    assert.equal(app.run('routeFocused.value'), false)
  } finally { app.cleanup() }
})

test('用户端加载和两种筛选状态都显示普通充电图例，筛选隐藏有说明', async () => {
  const source = fs.readFileSync(new URL('../src/components/ChargingView.vue', import.meta.url), 'utf8')
  const template = '<section class="charging-type-legend"' + source.split('<section class="charging-type-legend"')[1].split('</section>')[0] + '</section>'
  const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
  for (const chargeType of ['', 'fast', 'regular']) {
    const application = Vue.createSSRApp({ render, setup: () => ({ chargeType }) })
    application.component('UiIcon', { props: ['name', 'size'], render() { return Vue.h('svg', { 'data-icon': this.name }) } })
    const html = await renderToString(application)
    assert.match(html, /普通充电/)
    assert.match(html, /快充/)
    assert.match(html, /data-icon="charge-regular"/)
    assert.match(html, /data-icon="charge-fast"/)
    if (chargeType) assert.match(html, /已隐藏/)
    else assert.doesNotMatch(html, /已隐藏/)
  }
})
const position = (longitude = 113.83, latitude = 34.04) => ({ coords: { longitude, latitude, accuracy: 18.2 } })
const flushRoutes = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }
const routeResult = (station, fallback = false) => ({ type: 'FeatureCollection', features: [{
  type: 'Feature', geometry: station.geometry, properties: {
    id: station.properties.id, straightDistanceMeters: 250,
    drivingDistanceMeters: fallback ? null : 1250, drivingDurationSeconds: fallback ? null : 180,
    distanceMeters: fallback ? 250 : 1250, isFallback: fallback,
    distanceType: fallback ? 'straight' : 'driving', distanceSource: fallback ? 'postgis_straight' : 'amap_driving',
    distanceLabel: fallback ? '直线距离（降级估算）' : '驾车距离',
  },
}] })
const plansResult = (count = 3) => ({ type: 'FeatureCollection', metadata: { isFallback: false },
  features: Array.from({ length: count }, (_, index) => ({ type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[113.83, 34.04], [113.835, 34.041 + index / 1000], [113.84, 34.042]] },
    properties: { routeId: String(index + 1), routeLabel: index ? `备选路线 ${index + 1}` : '高德推荐',
      distanceType: 'driving', distanceSource: 'amap_driving', isFallback: false, straightDistanceMeters: 600,
      distanceMeters: 1000 * (index + 1), drivingDistanceMeters: 1000 * (index + 1),
      durationSeconds: 180 * (index + 1), drivingDurationSeconds: 180 * (index + 1), tollsYuan: 0, roads: ['大学路'] },
  })) })

test('选站只定位，去这里才规划；单条路线与逐级返回、缓存和重新定位正确', async () => {
  const app = await mount({ deferPlans: true })
  app.run('locate()')
  app.requests[0].success(position())
  await flushRoutes()
  assert.equal(app.planRequests.length, 0, '定位推荐时不获取每站的路线几何')
  app.handlers['click:charging-points']({ features: [{ properties: { _key: 0 } }] })
  assert.equal(app.planRequests.length, 0, '点击地图站点只定位并展示详情')
  assert.equal(app.run('planningStation.value'), null)
  app.run('goToStation(selected.value)')
  assert.equal(app.planRequests.length, 1)
  assert.match(app.planRequests[0].url, /\/routes\?lng=113.83&lat=34.04/)
  app.planRequests[0].resolve({ ok: true, json: async () => plansResult(4) })
  await flushRoutes()
  assert.equal(app.data('charging-routes').features.length, 3)
  assert.deepEqual(app.data('charging-routes').features[0].geometry.coordinates[0], toMapCoordinate([113.83, 34.04]))
  assert.equal(app.data('charging-routes').features.at(-1).properties.routeId, '1')
  assert.equal(app.run('selectedDistanceInfo.value.distanceMeters'), 1000)
  app.run("chooseRoute({station:planningStation.value, route:routePlans.value.get(String(planningStation.value.properties.id)).features[1]})")
  await nextTick()
  assert.equal(app.data('charging-routes').features.at(-1).properties.routeId, '2')
  assert.equal(app.data('charging-routes').features.at(-1).properties.routeSelected, true)
  assert.equal(app.run('selectedDistanceInfo.value.distanceMeters'), 2000)
  assert.equal(app.run('routeFocused.value'), true)
  assert.equal(app.data('charging-routes').features.length, 1)
  app.run('returnFromRoutes()')
  assert.equal(app.run('routeFocused.value'), false)
  assert.equal(app.data('charging-routes').features.length, 3)
  assert.equal(app.planRequests.length, 1, '返回方案不重复请求')
  app.run('returnFromRoutes()')
  assert.equal(app.run('planningStation.value'), null)
  assert.equal(app.run('recommendationsOpen.value'), true)
  assert.equal(app.data('charging-routes').features.length, 0)
  app.run('chooseStation(stations.value[0]); goToStation(selected.value)')
  await flushRoutes()
  assert.equal(app.planRequests.length, 1, '同一位置同一站点复用已完成的路线')
  app.run('locate()')
  app.requests[1].success(position(113.85))
  assert.equal(app.planRequests.length, 2, '重新定位后重算正在查看的站点路线')
  assert.equal(app.data('charging-routes').features.length, 0)
  app.cleanup()
  assert.equal(app.planRequests[1].signal.aborted, true)
})

test('用户端点击空白只隐藏详情，推荐、筛选、范围及正在加载的路线保持', async () => {
  const app = await mount({ deferPlans: true })
  app.run('locate()')
  app.requests[0].success(position())
  await flushRoutes()
  app.run('setRadius(5); chooseStation(stations.value[0]); goToStation(selected.value); filtersOpen.value = true')
  await nextTick()
  const buffer = app.data('charging-radius')
  app.run("dismissChargingWindows({ target: { closest: () => ({}) } })")
  assert.equal(app.run('filtersOpen.value'), true)
  app.run("dismissChargingWindows({ target: { closest: () => null } })")
  assert.equal(app.run('filtersOpen.value'), true)
  assert.equal(app.run('recommendationsOpen.value'), true)
  assert.equal(app.run('selected.value'), null)
  assert.equal(app.run('noticesVisible.value'), true)
  assert.equal(app.run('radius.value'), 5)
  assert.deepEqual(app.data('charging-radius'), buffer)
  assert.equal(app.planRequests[0].signal.aborted, false)
  app.planRequests[0].resolve({ ok: true, json: async () => plansResult() })
  await flushRoutes()
  assert.equal(app.data('charging-routes').features.length, 3)
  assert.equal(app.run('planningStation.value'), app.run('stations.value[0]'))
  assert.equal(app.run('recommendationsOpen.value'), true)
  app.cleanup()
})

test('切换站点取消旧路线，失效或无效几何不画直线路线，降级可重试', async () => {
  const app = await mount({ deferPlans: true })
  app.run('locate()')
  app.requests[0].success(position())
  await flushRoutes()
  app.run('chooseStation(stations.value[0]); goToStation(selected.value); chooseStation(stations.value[1]); goToStation(selected.value)')
  assert.equal(app.planRequests[0].signal.aborted, true)
  app.planRequests[1].resolve({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [],
    metadata: { isFallback: true, distanceType: 'straight', distanceSource: 'postgis_straight', straightDistanceMeters: 500 } }) })
  app.planRequests[0].resolve({ ok: true, json: async () => plansResult() })
  await flushRoutes()
  assert.equal(app.run('planningStation.value'), app.run('stations.value[1]'))
  assert.equal(app.run('selectedDistanceInfo.value.isFallback'), true)
  assert.equal(app.run('selectedDistanceInfo.value.distanceMeters'), 500)
  assert.equal(app.data('charging-routes').features.length, 0)
  app.run('loadStationPlans(planningStation.value, true)')
  const invalid = plansResult(1)
  invalid.features[0].geometry.coordinates[1][1] = 91
  app.planRequests[2].resolve({ ok: true, json: async () => invalid })
  await flushRoutes()
  assert.equal(app.run("routePlans.value.get(String(planningStation.value.properties.id)).status"), 'error')
  assert.equal(app.data('charging-routes').features.length, 0)
  app.cleanup()
})

test('定位响应晚于空白点击时仍正常显示推荐窗体', async () => {
  const app = await mount()
  app.run('locate(); dismissChargingWindows()')
  app.requests[0].success(position())
  await flushRoutes()
  assert.equal(app.run('recommendationsOpen.value'), true)
  assert.ok(app.run('location.value'))
  app.cleanup()
})

test('小屏点击空白隐藏站点详情后恢复推荐列表，并保留所选站点底色', async () => {
  const app = await mount({ width: 600 })
  app.requests[0].success(position())
  await flushRoutes()
  app.run('chooseStation(stations.value[0])')
  assert.equal(app.run('recommendationsOpen.value'), false)
  assert.ok(app.run('selected.value'))
  app.run('dismissChargingWindows()')
  await nextTick()
  assert.equal(app.run('selected.value'), null)
  assert.equal(app.run('recommendationsOpen.value'), true)
  assert.equal(app.run('highlightedStation.value'), app.run('stations.value[0]'))
  app.cleanup()
})

test('定位成功后打开右侧推荐，范围和可选筛选及权重切换重新计算并取消旧请求', async () => {
  const app = await mount({ deferRoutes: true })
  assert.equal(app.run('recommendationsOpen.value'), false)
  app.run('setRadius(3)')
  app.requests[0].success(position())
  await nextTick()
  assert.equal(app.run('recommendationsOpen.value'), true)
  assert.equal(app.routeRequests.length, 1, '先选范围再定位只发送一次同条件请求')
  assert.equal(new URL(app.routeRequests[0].url).searchParams.get('radius_km'), '3')
  app.run("recommendationMode.value = 'economy'; toggleType('fast'); availableOnly.value = true")
  await nextTick()
  assert.equal(app.routeRequests[0].signal.aborted, true)
  let params = new URL(app.routeRequests[1].url).searchParams
  assert.equal(params.get('mode'), 'economy')
  assert.equal(params.get('charge_type'), 'fast')
  assert.equal(params.get('available_only'), 'true')
  app.run("recommendationMode.value = 'balanced'; distanceWeight.value = 75; input.value = '大学路'; search()")
  await nextTick()
  params = new URL(app.routeRequests[2].url).searchParams
  assert.equal(params.get('mode'), 'balanced')
  assert.equal(params.get('distance_weight'), '0.75')
  assert.equal(params.get('name'), '大学路')
  assert.equal(app.requests.length, 1, '筛选变化复用当前位置')
  app.cleanup()
})

test('推荐卡使用接口排序和距离，点击关联原始站点，迟到筛选响应不覆盖当前推荐', async () => {
  const app = await mount({ deferRoutes: true })
  const station = app.run('stations.value[0]')
  app.run('locate()')
  app.requests[0].success(position())
  app.run("recommendationMode.value = 'economy'")
  await nextTick()
  app.routeRequests[1].resolve({ ok: true, json: async () => routeResult(station, true) })
  await flushRoutes()
  assert.equal(app.run('recommendedStations.value[0].properties.name'), station.properties.name)
  app.run('chooseRecommendation(recommendedStations.value[0]); updateMap()')
  assert.equal(app.run('selected.value'), station)
  assert.equal(app.run('selectedDistanceInfo.value.isFallback'), true)
  app.routeRequests[0].resolve({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) })
  await flushRoutes()
  assert.equal(app.run('recommendedStations.value.length'), 1)
  app.cleanup()
})

test('推荐服务失败后仍按费用和直线距离推荐，筛选后重算且不沿用旧推荐', async () => {
  const app = await mount({ routeError: true })
  app.run(`stations.value = [
    {type:'Feature',geometry:{type:'Point',coordinates:[113.83,34.04]},properties:{id:'near',name:'近站',chargeType:'regular',availableCount:0,pricePerKwh:3,_key:0}},
    {type:'Feature',geometry:{type:'Point',coordinates:[113.84,34.04]},properties:{id:'cheap',name:'便宜站',chargeType:'fast',availableCount:2,pricePerKwh:0.5,_key:1}},
    {type:'Feature',geometry:{type:'Point',coordinates:[113.831,34.04]},properties:{id:'missing',name:'未知费用',chargeType:'fast',availableCount:2,pricePerKwh:null,_key:2}}
  ]; locate()`)
  app.requests[0].success(position())
  await flushRoutes()
  assert.equal(app.run('recommendedStations.value[0].properties.id'), 'near')
  app.run("recommendationMode.value = 'economy'; availableOnly.value = true; toggleType('fast')")
  await flushRoutes()
  assert.equal(app.run('recommendedStations.value[0].properties.id'), 'cheap')
  assert.equal(app.run('recommendedStations.value.length'), 2)
  assert.ok(app.run('recommendedStations.value.every(station => station.properties.isFallback)'))
  const count = app.routeRequests.length
  app.run('loadRouteDistances(true)')
  await flushRoutes()
  assert.equal(app.routeRequests.length, count + 1)
  app.cleanup()
})

test('接口正常返回空推荐时显示空状态，定位失败不打开推荐框', async () => {
  const app = await mount()
  app.run('locate()')
  app.requests[0].failure({ code: 1 })
  assert.equal(app.run('recommendationsOpen.value'), false)
  assert.equal(app.routeRequests.length, 0)
  app.run('locate()')
  app.requests[1].success(position())
  await flushRoutes()
  assert.equal(app.run('recommendedStations.value.length'), 0)
  assert.equal(app.run('routeStatus.value'), 'ready')
  app.cleanup()
})

test('小屏点击推荐站点先收起列表展示详情，去这里才打开路线面板', async () => {
  const app = await mount({ deferRoutes: true, width: 390 })
  const station = app.run('stations.value[0]')
  app.run('locate()')
  app.requests[0].success(position())
  app.routeRequests[0].resolve({ ok: true, json: async () => routeResult(station) })
  await flushRoutes()
  app.run('chooseRecommendation(recommendedStations.value[0])')
  assert.equal(app.run('recommendationsOpen.value'), false)
  assert.equal(app.planRequests.length, 0)
  assert.equal(app.run('selected.value'), station)
  app.run('goToStation(selected.value)')
  assert.equal(app.run('recommendationsOpen.value'), true)
  assert.equal(app.planRequests.length, 1)
  await nextTick()
  assert.equal(app.run('recommendedStations.value.length'), 1)
  assert.equal(app.routeRequests.length, 1)
  app.cleanup()
})

test('真实定位后展示距离、到站时间与价格，直线结果不冒充驾车时间', async () => {
  const source = fs.readFileSync(new URL('../src/components/StationQuickFacts.vue', import.meta.url), 'utf8')
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
  const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
  for (const fallback of [false, true]) {
    const app = await mount({ deferRoutes: true })
    assert.equal(app.routeRequests.length, 0, '进入页面不请求用户位置或路线')
    const station = app.run('stations.value[0]')
    app.run('chooseStation(stations.value[0]); locate()')
    app.requests[0].success(position())
    assert.match(app.routeRequests[0].url, /recommended\?lng=113\.83&lat=34\.04&limit=5/)
    app.routeRequests[0].resolve({ ok: true, json: async () => routeResult(station, fallback) })
    await flushRoutes()
    const info = app.run('selectedDistanceInfo.value')
    assert.equal(info.distanceType, fallback ? 'straight' : 'driving')
    assert.equal(info.isFallback, fallback)
    assert.equal(app.run('formatChargingDistance(selectedDistanceInfo.value?.distanceMeters)'), fallback ? '约 250 m' : '约 1.3 km')
    const mapStation = app.data().features.find(feature => feature.properties.id === station.properties.id)
    assert.equal(mapStation.properties.distanceType, info.distanceType)
    assert.equal(mapStation.properties.distanceLabel, info.distanceLabel)
    assert.equal(mapStation.properties.isFallback, fallback)
    assert.equal(mapStation.properties.straightDistanceMeters, 250)
    assert.equal(mapStation.properties.drivingDistanceMeters, fallback ? null : 1250)
    assert.equal(station.properties.distanceType, undefined, '距离结果不修改原始站点数据')
    const facts = chargingStationFacts({ ...station.properties, ...info })
    const html = await renderToString(Vue.createSSRApp({ render, setup: () => ({ facts }) }))
    assert.match(html, fallback ? /<dt>直线距离<\/dt>/ : /<dt>距离<\/dt>/)
    assert.match(html, /到站时间|充电价格/)
    assert.ok(html.includes(fallback ? '约 250 m' : '约 1.3 km'))
    if (fallback) { assert.equal(facts.arrivalTime, '暂无'); assert.doesNotMatch(html, /预计 3 分钟/) }
    else assert.equal(facts.arrivalTime, '约 3 分钟')
    app.cleanup()
  }
})

test('推荐接口错误或返回异常时标记本地直线降级，仍保留范围圈和距离筛选', async () => {
  for (const options of [{ routeError: true }, { routeData: { type: 'invalid' } }]) {
    const app = await mount(options)
    const coordinates = app.run('stations.value[0].geometry.coordinates')
    app.run('chooseStation(stations.value[0]); setRadius(1)')
    app.requests[0].success(position(...coordinates))
    await flushRoutes()
    assert.equal(app.run('routeStatus.value'), 'error')
    assert.equal(app.run('selectedDistanceInfo.value.isFallback'), true)
    assert.equal(app.run('selectedDistanceInfo.value.distanceSource'), 'client_straight')
    assert.equal(app.run('formatChargingDistance(selectedDistanceInfo.value?.distanceMeters)'), '约 0 m')
    assert.equal(chargingStationFacts(app.run('selectedDistanceInfo.value')).arrivalTime, '暂无')
    assert.equal(app.data('charging-radius').features.length, 1)
    assert.ok(app.data().features.length > 0)
    app.cleanup()
  }
})

test('重新定位取消旧路线并清除旧距离，迟到响应与离开页面后的响应不更新地图', async () => {
  const app = await mount({ deferRoutes: true })
  const station = app.run('stations.value[0]')
  app.run('chooseStation(stations.value[0]); locate()')
  app.requests[0].success(position())
  app.run('locate()')
  app.requests[1].success(position(113.84, 34.05))
  assert.equal(app.routeRequests[0].signal.aborted, true)
  app.routeRequests[0].resolve({ ok: true, json: async () => routeResult(station) })
  await flushRoutes()
  assert.equal(app.run('routeStatus.value'), 'loading')
  assert.equal(app.run('routeDistances.value.size'), 0)
  app.routeRequests[1].resolve({ ok: true, json: async () => routeResult(station, true) })
  await flushRoutes()
  assert.equal(app.run('selectedDistanceInfo.value.isFallback'), true)
  app.run('locate()')
  app.requests[2].success(position(113.85))
  assert.equal(app.run('routeDistances.value.size'), 0)
  app.cleanup()
  assert.equal(app.routeRequests[2].signal.aborted, true)
  app.routeRequests[2].resolve({ ok: true, json: async () => routeResult(station) })
  await flushRoutes()
  assert.equal(app.run('routeDistances.value.size'), 0)
})

test('找充电使用高德标准地图，地图点及搜索定位转换坐标，原始距离数据保持 WGS84', async () => {
  const app = await mount()
  assert.equal(app.mapOptions.style.sources.basemap, AMAP_STANDARD_SOURCE)
  const station = app.run('stations.value[0]')
  const original = [...station.geometry.coordinates]
  assert.deepEqual(app.data().features[0].geometry.coordinates, toMapCoordinate(original))
  app.run('chooseStation(stations.value[0]); updateMap(); updateMap()')
  assert.deepEqual(app.flights.at(-1).center, app.data().features[0].geometry.coordinates)
  assert.deepEqual(station.geometry.coordinates, original)
  app.run('locate()')
  app.requests[0].success(position(...original))
  await nextTick()
  assert.equal(app.run('formatChargingDistance(selectedDistanceInfo.value?.distanceMeters)'), '约 0 m')
  assert.deepEqual(app.markers.at(-1).coordinates, app.data().features[0].geometry.coordinates)
  app.cleanup()
})

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
  assert.deepEqual(app.markers[0].coordinates, toMapCoordinate([113.84, 34.04]))
  assert.deepEqual(app.flights.at(-1).center, app.markers[0].coordinates)
  assert.ok(app.data().features.every(feature => feature.properties.coordSystem === 'WGS84'))
  app.cleanup()
})

test('选距离先定位，失败后重试仍应用所选范围，重置可取消待应用范围', async () => {
  const app = await mount()
  app.run('setRadius(1)')
  app.requests[0].failure({ code: 3 })
  assert.match(app.run('locationError.value'), /超时/)
  assert.equal(app.data('charging-radius').features.length, 0, '定位失败时不生成预设范围')
  app.run('locate()')
  assert.equal(app.run('locationError.value'), '')
  const stationCoordinates = app.run('stations.value[0].geometry.coordinates')
  app.requests[1].success(position(...stationCoordinates))
  await nextTick()
  assert.equal(app.run('radius.value'), 1)
  assert.equal(app.data('charging-radius').features.length, 1)
  assert.ok(app.data().features.length > 0)
  assert.ok(app.data().features.every(feature => stationDistance({ ...feature, geometry: {
    ...feature.geometry, coordinates: fromMapCoordinate(feature.geometry.coordinates),
  } }, stationCoordinates) <= 1))
  app.cleanup()

  const reset = await mount()
  reset.run('setRadius(3); resetFilters()')
  reset.requests[0].success(position())
  await nextTick()
  assert.equal(reset.run('radius.value'), 0)
  assert.equal(reset.data('charging-radius').features.length, 0)
  reset.cleanup()
})

test('1、3、5 km 缓冲区与距离筛选一致，切换范围和重新定位更新图形，不限与重置清除图形', async () => {
  const app = await mount()
  app.run('locate()')
  app.requests[0].success(position())
  await nextTick()
  assert.equal(app.data('charging-radius').features.length, 0)
  for (const km of [1, 3, 5]) {
    app.run(`setRadius(${km})`)
    await nextTick()
    const buffer = app.data('charging-radius')
    assert.equal(buffer.features.length, 1)
    assert.equal(buffer.features[0].geometry.type, 'Polygon')
    const ring = buffer.features[0].geometry.coordinates[0]
    assert.equal(ring.length, 129)
    assert.deepEqual(ring[0], ring.at(-1), '范围边界闭合')
    for (const coordinate of ring) {
      const feature = { geometry: { type: 'Point', coordinates: fromMapCoordinate(coordinate) } }
      assert.ok(Math.abs(stationDistance(feature, [113.83, 34.04]) - km) < 0.000001, '半径以真实坐标计算，显示转换不改变距离')
    }
    const [west, south, east, north] = bbox(buffer)
    assert.deepEqual(Array.from(app.bounds.at(-1).value, coordinate => Array.from(coordinate)), [[west, south], [east, north]])
  }
  const previousBuffer = app.data('charging-radius')
  app.run('locate()')
  app.requests[1].failure({ code: 2 })
  await nextTick()
  assert.equal(app.data('charging-radius'), previousBuffer, '重新定位失败保留原范围')
  app.run('locate()')
  app.requests[2].success(position(113.84, 34.05))
  await nextTick()
  const vertex = fromMapCoordinate(app.data('charging-radius').features[0].geometry.coordinates[0][0])
  assert.ok(Math.abs(stationDistance({ geometry: { coordinates: vertex } }, [113.84, 34.05]) - 5) < 0.000001)
  assert.notDeepEqual(app.data('charging-radius'), previousBuffer)
  app.run('setRadius(0)')
  await nextTick()
  assert.equal(app.data('charging-radius').features.length, 0)
  app.run('setRadius(3)')
  await nextTick()
  assert.equal(app.data('charging-radius').features.length, 1)
  app.run('resetFilters()')
  await nextTick()
  assert.equal(app.data('charging-radius').features.length, 0)
  app.cleanup()
})

test('地图加载前选距离和定位，地图就绪后补绘范围，站点加载失败仍显示缓冲区', async () => {
  const app = await mount({ load: false, stationError: true })
  app.run('setRadius(3)')
  app.requests[0].success(position())
  await nextTick()
  assert.equal(app.data('charging-radius').features.length, 0)
  await app.load()
  assert.equal(app.data('charging-radius').features.length, 1)
  assert.match(app.run('dataError.value'), /站点数据加载失败/)
  app.cleanup()
  app.run('setRadius(5)')
  await nextTick()
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

test('进入用户端自动定位，成功后居中缩放并使用米制比例尺，退出清理标记', async () => {
  const app = await mount()
  assert.equal(app.markers.length, 0)
  assert.deepEqual(Array.from(app.mapOptions.center), toMapCoordinate([113.8356, 34.0268]))
  assert.equal(app.mapOptions.zoom, 12)
  const icons = app.mapOptions.style.layers.find(layer => layer.id === 'charging-bolts').layout['icon-image']
  const colors = app.mapOptions.style.layers.find(layer => layer.id === 'charging-points').paint['circle-color']
  assert.notEqual(icons[3], icons.at(-1))
  assert.notEqual(colors[3], colors.at(-1))
  assert.equal(app.run('location.value'), null, '初次打开没有预设用户位置')
  assert.equal(app.requests.length, 1, '进入用户端自动请求真实定位一次')
  assert.equal(app.run('locating.value'), true)
  assert.equal(app.controls[0].position, 'bottom-left')
  assert.equal(app.controls[0].control.options.unit, 'metric')
  assert.equal(app.mapOptions.locale['ScaleControl.Meters'], '米')
  assert.equal(app.mapOptions.locale['ScaleControl.Kilometers'], '公里')
  app.requests[0].success(position())
  await nextTick()
  assert.equal(app.markers.length, 1)
  assert.deepEqual(app.markers[0].coordinates, toMapCoordinate([113.83, 34.04]))
  assert.deepEqual(app.flights.at(-1).center, app.markers[0].coordinates)
  assert.equal(app.flights.at(-1).zoom, 14)
  app.cleanup()
  assert.ok(app.markers.every(marker => marker.removed))
})

test('站点底色与窗体独立，关闭详情或点击空白仍保留，点击下一站才切换', async () => {
  const app = await mount()
  app.requests[0].success(position())
  await flushRoutes()
  app.handlers['click:charging-points']({ features: [{ properties: { _key: 0 } }] })
  await flushRoutes()
  assert.equal(app.run('highlightedStation.value'), app.run('stations.value[0]'))
  assert.equal(app.mapFilters['charging-selected'].at(-1), 0)
  app.run('selected.value = null')
  await nextTick()
  assert.equal(app.mapFilters['charging-selected'].at(-1), 0)
  app.run('dismissChargingWindows()')
  await nextTick()
  assert.equal(app.mapFilters['charging-selected'].at(-1), 0)
  assert.equal(app.run('highlightedStation.value'), app.run('stations.value[0]'))
  app.handlers['click:charging-points']({ features: [{ properties: { _key: 1 } }] })
  await flushRoutes()
  assert.equal(app.mapFilters['charging-selected'].at(-1), 1)
  assert.equal(app.run('highlightedStation.value'), app.run('stations.value[1]'))
  app.run('dismissChargingWindows(); recommendationMode.value = "economy"')
  await flushRoutes()
  assert.equal(app.mapFilters['charging-selected'].at(-1), 1)
  app.cleanup()
})

test('选站、推荐和搜索均不规划；定位迟到不自动规划，去这里后切站取消意图', async () => {
  const app = await mount({ deferPlans: true })
  app.run('chooseRecommendation(stations.value[0])')
  assert.equal(app.planRequests.length, 0)
  app.requests[0].success(position())
  await flushRoutes()
  assert.equal(app.planRequests.length, 0)
  assert.deepEqual(app.flights.at(-1).center, toMapCoordinate(app.run('stations.value[0].geometry.coordinates')))
  app.run('input.value = stations.value[0].properties.name; search()')
  assert.equal(app.planRequests.length, 0)
  app.run('goToStation(selected.value)')
  assert.equal(app.planRequests.length, 1)
  app.run('chooseStation(stations.value[1])')
  assert.equal(app.planRequests[0].signal.aborted, true)
  assert.equal(app.planRequests.length, 1, '新站点等待去这里')
  app.planRequests[0].resolve({ ok: true, json: async () => plansResult() })
  await flushRoutes()
  assert.equal(app.run('planningStation.value'), null)
  assert.equal(app.data('charging-routes').features.length, 0)
  app.cleanup()
})

test('没有位置时去这里等待真实定位，切站或关闭后不执行旧规划意图', async () => {
  for (const cancel of ['', 'chooseStation(stations.value[1])', 'dismissChargingWindows()']) {
    const app = await mount({ deferPlans: true })
    app.run('chooseStation(stations.value[0]); goToStation(selected.value)')
    assert.equal(app.requests.length, 1)
    assert.equal(app.planRequests.length, 0)
    if (cancel) app.run(cancel)
    app.requests[0].success(position())
    await flushRoutes()
    assert.equal(app.planRequests.length, cancel ? 0 : 1)
    app.cleanup()
  }
})

test('路线加载中返回推荐后取消请求，迟到结果不恢复路线视图', async () => {
  const app = await mount({ deferPlans: true })
  app.requests[0].success(position())
  app.run('chooseStation(stations.value[0]); goToStation(selected.value); returnFromRoutes()')
  assert.equal(app.planRequests[0].signal.aborted, true)
  app.planRequests[0].resolve({ ok: true, json: async () => plansResult() })
  await flushRoutes()
  assert.equal(app.run('planningStation.value'), null)
  assert.equal(app.run('routeFocused.value'), false)
  assert.equal(app.run('recommendationsOpen.value'), true)
  assert.equal(app.data('charging-routes').features.length, 0)
  app.cleanup()
})
