import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'
import { formatChargingDistance, stationMetric, chargingStationFacts } from '../src/utils/charging.js'
import { routeTollText } from '../src/utils/stationInformation.js'
import { TRIP_INTENTS, tripInputIssues, rankTripStations, evaluateTripStation, isDestinationIntent, normalizeTripContext } from '../src/utils/tripCharging.js'

const source = fs.readFileSync(new URL('../src/components/ChargingRecommendations.vue', import.meta.url), 'utf8')
const script = source.split('<script setup>')[1].split('</script>')[0].replace(/^import\b[^\n]*\r?\n/gm, '')
const template = source.slice(source.indexOf('<template>') + '<template>'.length, source.lastIndexOf('</template>'))
const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
const factsSource = fs.readFileSync(new URL('../src/components/StationQuickFacts.vue', import.meta.url), 'utf8')
const factsTemplate = factsSource.slice(factsSource.indexOf('<template>') + 10, factsSource.lastIndexOf('</template>'))
const factsRender = new Function('Vue', compile(factsTemplate, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
async function panel(overrides = {}, interact) {
  const props = { stations: [], status: 'ready', mode: 'distance', weight: 50, radius: 0, chargeType: '',
    availableOnly: false, usableRoutesOnly: false, filteredRouteCount: 0, hasFast: true, hasRegular: true, hasAvailability: true, metadata: null,
    plans: new Map(), planningStation: null, selectedRouteId: '', activeStationId: '', routeFocused: false,
    intent: '', tripContext: {}, destinationInfo: null, socUpdatedAt: null, settingsNotice: '', hasLocation: true, now: Date.now(), ...overrides }
  const emitted = []
  const context = vm.createContext({ ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, formatChargingDistance, stationMetric,
    TRIP_INTENTS, tripInputIssues, evaluateTripStation, isDestinationIntent, routeTollText, defineProps: () => props, defineEmits: () => (...args) => emitted.push(args) })
  const scope = Vue.effectScope()
  scope.run(() => vm.runInContext(script, context))
  interact?.({ run: code => vm.runInContext(code, context), emitted })
  const app = Vue.createSSRApp({ render, setup: () => ({ ...props, formatChargingDistance, stationMetric, routeTollText,
    TRIP_INTENTS, isDestinationIntent, ...vm.runInContext('({ modes, draftWeight, emit, displayedStations, planFor, activePlan, focusedRoute, editingSoc, currentSoc, targetSoc, socError, filterSummary, editSoc, saveSoc })', context) }) })
  app.component('UiIcon', { render: () => Vue.h('svg') })
  app.component('StationQuickFacts', { props: { properties: Object, fit: Object, context: Object, now: Number, compact: Boolean }, render: factsRender,
    setup: props => ({ facts: Vue.computed(() => chargingStationFacts(props.properties, props.fit, props.context, props.now)) }) })
  try { return await renderToString(app) } finally { scope.stop() }
}

test('推荐面板完整显示三种模式、可选条件和综合可调权重', async () => {
  const html = await panel({ mode: 'balanced', weight: 75, radius: 3, chargeType: 'fast', availableOnly: true })
  for (const label of ['距离优先', '经济优先', '综合推荐', '仅空闲', '综合推荐距离权重', '距离 75%', '费用 25%', '直线 3 km']) assert.ok(html.includes(label), label)
  assert.match(html, /type="checkbox" checked/)
  assert.match(html, /type="range"[^>]*value="75"/)
})

test('路线过滤按钮始终可见，显示开启状态和过滤数量，空结果提供恢复和重试', async () => {
  const initial = await panel()
  assert.match(initial, /aria-pressed="false"[^>]*><svg[^>]*><\/svg><span>过滤不可用路线/)
  const filtered = await panel({ usableRoutesOnly: true, filteredRouteCount: 3 })
  for (const text of ['已开启', '已过滤 3 个路线不可用的站点', '暂无可用驾车路线', '显示全部推荐', '重新获取路线']) assert.ok(filtered.includes(text), text)
  assert.match(filtered, /aria-pressed="true"[^>]*><svg[^>]*><\/svg><span>过滤不可用路线/)
  const loading = await panel({ usableRoutesOnly: true, status: 'loading', filteredRouteCount: 3 })
  assert.ok(loading.includes('正在查找附近站点'))
  assert.doesNotMatch(loading, /已过滤 3 个|显示全部推荐|暂无可用驾车路线/)
  const noLocation = await panel({ usableRoutesOnly: true, hasLocation: false })
  assert.ok(noLocation.includes('定位后查看附近充电站'))
  assert.doesNotMatch(noLocation, /暂无可用驾车路线|显示全部推荐/)
})

test('推荐侧栏只显示路线概要；详细费用、状态和核验留给站点弹窗', async () => {
  const stations = [
    { properties: { id: 'drive', name: '驾车站', distanceMeters: 1250, drivingDistanceMeters: 1250, distanceType: 'driving', distanceSource: 'amap_driving', isFallback: false, drivingDurationSeconds: 180, pricePerKwh: 1.2 } },
    { properties: { id: 'fallback', name: '降级站', distanceMeters: 500, distanceType: 'straight', isFallback: true, pricePerKwh: null } },
    { properties: { id: 'demo', name: '演示站', distanceMeters: 0, pricePerKwh: 0, simulatedFields: ['servicePrice'] } },
  ]
  const html = await panel({ stations })
  for (const label of ['驾车', '约 1.3 km', '约 3 分钟', '路线不可使用']) assert.ok(html.includes(label), label)
  assert.doesNotMatch(html, /<dl|充电单价|没有实时数据|核验时间未知|0\.00 元|空闲 \d+ 个/)
  assert.equal((html.match(/分钟/g) || []).length, 1)
  assert.ok((await panel()).includes('暂无合适站点'))
  assert.ok((await panel({ status: 'error', stations })).includes('路线暂未更新'))
  assert.ok((await panel({ status: 'loading' })).includes('正在查找附近站点'))
})

test('路线方案单独展示目的地、返回按钮和道路收费，失效按实际展示', async () => {
  const station = { properties: { id: 'selected', name: '所选站', straightDistanceMeters: 500 } }
  const features = [1, 2, 3].map(routeId => ({ properties: { routeId: String(routeId), routeLabel: `方案 ${routeId}`,
    distanceMeters: routeId * 1000, durationSeconds: 180, tollsYuan: 0, roads: ['大学路'] } }))
  const html = await panel({ planningStation: station, selectedRouteId: '2', plans: new Map([['selected', { status: 'ready', features }]]) })
  assert.ok(html.includes('所选站路线方案'))
  assert.equal((html.match(/class="route-option/g) || []).length, 3)
  assert.ok(html.includes('aria-pressed="true"'))
  assert.ok(html.includes('道路收费 暂无价格'))
  assert.ok(html.includes('经 大学路'))
  assert.ok(html.includes('返回推荐站点'))
  assert.doesNotMatch(html, /class="recommendation-card/)
  assert.doesNotMatch(html, /推荐排序方式/)
  const unavailable = await panel({ planningStation: station, plans: new Map([['selected', { status: 'ready', features: [], metadata: { straightDistanceMeters: 600 } }]]) })
  assert.ok(unavailable.includes('路线不可使用'))
  assert.ok(unavailable.includes('约 600 m'))
  assert.ok(unavailable.includes('重新规划'))
})

test('推荐卡片底色按所选站点保持，切换站点后仅新卡片处于选中状态', async () => {
  const stations = ['a', 'b'].map(id => ({ properties: { id, name: `站点 ${id}` } }))
  for (const activeStationId of ['a', 'b']) {
    const html = await panel({ stations, activeStationId })
    assert.equal((html.match(/class="recommendation-card active"/g) || []).length, 1)
    const activeCard = html.split('class="recommendation-card active"')[1].split('</button>')[0]
    assert.ok(activeCard.includes(`站点 ${activeStationId}`))
    assert.ok(activeCard.includes('aria-pressed="true"'))
  }
})

test('选中路线单独显示，隐藏其他站点和备选方案，提供返回路线方案按钮', async () => {
  const station = { properties: { id: 'selected', name: '目的站', address: '大学路' } }
  const features = [1, 2, 3].map(id => ({ properties: { routeId: String(id), routeLabel: `路线 ${id}`,
    distanceMeters: id * 1000, durationSeconds: id * 180, tollsYuan: 0, roads: ['大学路'] } }))
  const html = await panel({ stations: [{ properties: { id: 'other', name: '其他充电站' } }],
    planningStation: station, routeFocused: true, selectedRouteId: '2', plans: new Map([['selected', { status: 'ready', features }]]) })
  for (const label of ['目的站', '路线 2', '约 2.0 km', '约 6 分钟', '道路收费 暂无价格', '返回路线方案']) assert.ok(html.includes(label), label)
  assert.doesNotMatch(html, /其他充电站|路线 1|路线 3|推荐排序方式|class="route-option/)
})

test('三种推荐共用直观卡片和充电计划，不要求补参数或确认估算', async () => {
  const { context, features } = JSON.parse(fs.readFileSync(new URL('./fixtures/trip-charging.json', import.meta.url), 'utf8'))
  for (const intent of ['urgent', 'destination', 'economy']) {
    const stations = rankTripStations(features, intent, context)
    const html = await panel({ intent, tripContext: normalizeTripContext(context), stations, destinationInfo: { name: '图书馆' } })
    for (const label of ['快速补能', '目的地补能', '成本优先', '驾车', '车辆与出行设置']) assert.ok(html.includes(label), label)
    assert.doesNotMatch(html, /<form|type="number"/)
    assert.ok(html.includes('#/charging/settings'))
    assert.doesNotMatch(html, /距离优先|综合推荐距离权重/)
    assert.doesNotMatch(html, /充电单价|服务费|停车费|使用成本估算/)
    assert.doesNotMatch(html, /可达性|待确认|保留电量|完善设置|初筛|trip-assessment/)
    assert.ok(html.includes('图书馆'))
  }
  const unknown = await panel({ intent: 'urgent', tripContext: {}, stations: rankTripStations(features, 'urgent', {}) })
  assert.ok(unknown.includes('驾车'))
  assert.doesNotMatch(unknown, /元\/度/)
  assert.doesNotMatch(unknown, /可达性|待确认|完善设置|核对/)
  const withoutPosition = await panel({ intent: 'shopping', tripContext: context, hasLocation: false })
  assert.ok(withoutPosition.includes('定位并推荐'))
})

test('日常面板收起筛选，修改电量按保留电量校验后更新推荐', async () => {
  const tripContext = normalizeTripContext({ currentSoc: 20, targetSoc: 80, reserveSoc: 10 })
  const initial = await panel({ intent: 'urgent', tripContext, chargeType: 'fast', availableOnly: true })
  assert.doesNotMatch(initial, /<details[^>]*\bopen\b|<form/)
  assert.ok(initial.includes('快充 · 仅空闲'))
  assert.ok(initial.includes('修改电量'))
  const editing = await panel({ intent: 'urgent', tripContext }, ({ run, emitted }) => {
    run('editSoc(); currentSoc.value = 35; targetSoc.value = 5; saveSoc()')
    assert.equal(emitted.length, 0)
    assert.equal(run('editingSoc.value'), true)
  })
  assert.ok(editing.includes('目标电量不能低于保留电量 10%'))
  assert.ok(editing.includes('修改本次电量'))
  await panel({ intent: 'urgent', tripContext }, ({ run, emitted }) => {
    run('editSoc(); currentSoc.value = 35; targetSoc.value = 70; saveSoc()')
    assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [['update-trip', { currentSoc: 35, targetSoc: 70 }]])
    assert.equal(run('editingSoc.value'), false)
  })
  await panel({ intent: 'urgent', tripContext }, ({ run, emitted }) => {
    run("editSoc(); currentSoc.value = ''; saveSoc()")
    assert.equal(emitted[0][1].currentSoc, null)
  })
})
