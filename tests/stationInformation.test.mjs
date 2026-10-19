import test from 'node:test'
import assert from 'node:assert/strict'
import { chargingCompatibility, stationAvailability, stationPrice, LIVE_AVAILABILITY_MAX_AGE_MS, stationInformationStates, informationState } from '../src/utils/stationInformation.js'
import { chargingStationFacts, selectChargingStations } from '../src/utils/charging.js'
import { normalizeTripContext, rankTripStations } from '../src/utils/tripCharging.js'
import fs from 'node:fs'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'

const now = Date.parse('2026-10-09T10:00:00+08:00')
const live = { availableCount: 2, availabilityIsRealtime: true, availabilityUpdatedAt: '2026-10-09T09:59:00+08:00' }
const route = { distanceType: 'driving', distanceSource: 'amap_driving', isFallback: false, drivingDistanceMeters: 2400, drivingDurationSeconds: 300 }

test('逐字段区分已知、未知和模拟；空值及无效核对记录不能伪装成已知', () => {
  assert.equal(informationState({ openingHours: '全天' }, 'openingHours').state, 'known')
  assert.equal(informationState({ openingHours: '全天', simulatedFields: ['openingHours'] }, 'openingHours').state, 'simulated')
  assert.equal(informationState({ openingHours: null, isSynthetic: true }, 'openingHours').state, 'unknown')
  for (const evidence of [{ state: 'unknown' }, { state: 'known', checkedAt: '2099-01-01T00:00:00Z', sources: [{ url: 'https://www.tesla.cn' }] },
    { state: 'known', checkedAt: '2026-10-09T09:00:00+08:00', sources: [{ url: 'javascript:alert(1)' }] }]) {
    assert.equal(informationState({ openingHours: '全天', fieldVerification: { openingHours: evidence } }, 'openingHours', '全天', now).state, 'unknown')
  }
  const simulated = stationInformationStates({ address: '模拟地址', chargeType: 'fast', openingHours: '全天', isSynthetic: true })
  assert.equal(simulated.find(item => item.key === 'chargeType').state, 'simulated')
  assert.match(simulated.find(item => item.key === 'chargeType').value, /模拟.*直流／交流未知/)
})

test('两处官方示范站的四项信息有来源，四处存档保留未知和模拟，公开核对不冒充实时或现场', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../data/managed/station-verification.json', import.meta.url), 'utf8'))
  for (const id of Object.keys(catalog.stations)) {
    const record = catalog.stations[id]
    const properties = { address: '原地址', chargeType: 'fast', openingHours: '全天',
      availableCount: 9, electricityPrice: .8, servicePrice: .2, pricePerKwh: 1,
      simulatedFields: ['chargeType', 'openingHours', 'availableCount', 'electricityPrice', 'servicePrice'], fieldVerification: {} }
    for (const [key, item] of Object.entries(record.fields)) {
      properties.fieldVerification[key] = { ...item, sources: item.sources.map(source => catalog.sources[source]) }
      if (item.state === 'known') { properties[key] = item.value; properties.simulatedFields = properties.simulatedFields.filter(field => field !== key) }
    }
    const rows = stationInformationStates(properties)
    if (id === 'B0FFJ5K41S' || id === 'B0I1NS8N4O') {
      assert.ok(rows.every(item => item.state === 'known' && item.sources.length > 0))
      assert.match(rows.find(item => item.key === 'opening').detail, /实时运营状态未知/)
      assert.match(rows.find(item => item.key === 'chargeType').value, /直流 DC/)
      assert.equal(chargingCompatibility(properties, { chargingRequirement: 'AC' }).prohibited, false)
      assert.equal(chargingCompatibility(properties, { chargingRequirement: 'AC' }).status, '适配未知')
    } else {
      assert.deepEqual(rows.map(item => item.state), ['unknown', 'simulated', 'unknown', 'simulated'])
      assert.match(rows[0].value, /存档位置/)
    }
    const facts = chargingStationFacts(properties)
    assert.equal(facts.verifiedAt, '核验时间未知')
    assert.equal(facts.availability.status, '没有实时数据')
    assert.equal(facts.availabilityState, 'simulated')
    assert.equal(facts.feeState.state, 'simulated')
  }
})
test('只有明确驾车来源和完整指标能显示驾车时间；直线及旧标签不能冒充路线', () => {
  assert.equal(chargingStationFacts(route).routeSummary, '约 2.4 km · 约 5 分钟')
  for (const change of [{ distanceSource: undefined }, { isFallback: undefined }, { isFallback: true }, { drivingDistanceMeters: null }, { drivingDurationSeconds: null }]) {
    assert.equal(chargingStationFacts({ ...route, ...change }).routeSummary, '路线不可使用')
  }
  const straight = chargingStationFacts({ distanceType: 'straight', distanceMeters: 500, drivingDurationSeconds: 1 })
  assert.equal(straight.arrivalTime, '驾车时间未知')
  assert.match(straight.straightDistance, /非驾车距离/)
})
test('快充和功率不推断直流；需求未知不判断适配；明确不匹配禁止且不进入推荐', () => {
  for (const p of [{ chargeType: 'fast', powerKw: 350 }, { chargingCurrentTypes: ['DC'], simulatedFields: ['chargingCurrentTypes'] }, { chargingCurrentTypes: ['DC', 'unknown'] }]) {
    const result = chargingCompatibility(p, { chargingRequirement: 'AC' })
    assert.equal(result.currentType, '直流／交流未知')
    assert.equal(result.prohibited, false)
    assert.equal(result.status, '适配未知')
  }
  assert.equal(chargingCompatibility({ chargingCurrentTypes: ['DC'] }).status, '适配未知')
  assert.equal(chargingCompatibility({ chargingCurrentTypes: ['DC'] }, { chargingRequirement: 'AC' }).prohibited, true)
  assert.equal(chargingCompatibility({ vehicleCompatible: false }).prohibited, true)
  const compatible = chargingCompatibility({ chargingCurrentTypes: ['AC', 'DC'] }, { chargingRequirement: 'DC' })
  assert.equal(compatible.status, '充电类型符合需求')
  assert.equal(compatible.note, '接口适配未核验')
  assert.equal(normalizeTripContext({ chargingRequirement: 'fast' }).chargingRequirement, null)
  assert.equal(normalizeTripContext({ chargingRequirement: 'DC' }).chargingRequirement, 'DC')
  const station = { properties: { chargingCurrentTypes: ['AC'] } }
  assert.deepEqual(rankTripStations([station], 'urgent', { chargingRequirement: 'DC' }), [])
})
test('零价、未知和演示价格均不显示免费或总成本；已知收费可以估算，缺项不作合计', () => {
  for (const value of [undefined, null, '', 0, -1, NaN]) assert.equal(stationPrice({ parkingFee: value }, 'parkingFee'), null)
  const prices = { electricityPrice: .8, servicePrice: .2, pricePerKwh: 1, parkingFee: 3 }
  for (const p of [{ ...prices, isSynthetic: true }, { ...prices, simulatedFields: ['electricityPrice', 'parkingFee'] }]) {
    const facts = chargingStationFacts({ ...route, ...p }, { totalCost: 42, chargeCost: 40 })
    assert.equal(facts.price, '暂无价格')
    assert.equal(facts.parkingFee, '暂无价格')
    assert.equal(facts.cost, '')
  }
  const fit = { totalCost: 42, chargeCost: 40 }
  assert.match(chargingStationFacts({ ...route, ...prices }, fit).cost, /使用成本估算 42/)
  assert.match(chargingStationFacts({ ...route, ...prices, parkingFee: 0 }, fit).cost, /不含停车/)
  assert.equal(chargingStationFacts({ ...route, ...prices }, { ...fit, hasDemoInputs: true }).cost, '')
  assert.equal(chargingStationFacts({ pricePerKwh: 0 }).price, '暂无价格')
  assert.equal(chargingStationFacts({ pricePerKwh: .001 }).price, '不足 0.01 元/度')
})
test('实时空闲需显式实时标记、有效更新时间且未过期；模拟、历史、未来值不能用于空闲筛选', () => {
  assert.equal(stationAvailability(live, now).hasRealtime, true)
  for (const change of [{ availabilityIsRealtime: undefined }, { availabilityUpdatedAt: undefined }, { availabilityUpdatedAt: '2026-10-09T10:00:00' },
    { availabilityUpdatedAt: '2026-10-09T10:01:00+08:00' }, { isSynthetic: true }, { simulatedFields: ['availableCount'] },
    { availabilityExpiresAt: '2026-10-09T09:59:30+08:00' }, { availableCount: null }]) {
    const p = { ...live, ...change }
    assert.equal(stationAvailability(p, now).status, '没有实时数据')
    assert.deepEqual(selectChargingStations([{ properties: p }], { available: true, now }), [])
  }
  assert.equal(stationAvailability(live, now + LIVE_AVAILABILITY_MAX_AGE_MS).status, '没有实时数据')
  assert.match(stationAvailability(live, now).note, /不等于无需排队/)
  assert.match(stationAvailability({ ...live, availableCount: 0 }, now).note, /等待时间未知/)
  assert.equal(stationAvailability({ ...live, estimatedWaitMinutes: 7 }, now).note, '运营方预计等待 7 分钟')
  assert.equal(selectChargingStations([{ properties: live }], { available: true, now }).length, 1)
})
test('不把采集时间和入库时间当核验；缺失来源和核验时间直接说明，虚拟站不能伪装核验', () => {
  const p = { updatedAt: '2026-10-09T09:00:00+08:00', observedAt: '2026-10-08T09:00:00+08:00' }
  assert.equal(chargingStationFacts(p).source, '数据来源未知')
  assert.equal(chargingStationFacts(p).verifiedAt, '核验时间未知')
  const actual = chargingStationFacts({ ...p, dataSource: '运营方接口', verifiedAt: p.updatedAt })
  assert.equal(actual.source, '运营方接口')
  assert.match(actual.verifiedAt, /2026\/10\/09 09:00/)
  const demo = chargingStationFacts({ ...p, dataSource: '运营方接口', verifiedAt: p.updatedAt, isSynthetic: true })
  assert.equal(demo.source, '虚拟演示数据')
  assert.equal(demo.verifiedAt, '核验时间未知')
  assert.equal(chargingStationFacts({ verifiedAt: '2099-01-01T00:00:00Z' }).verifiedAt, '核验时间未知')
})

test('完整站点弹窗按五项决策优先级展示；侧栏概要不展开费用和可信度', async () => {
  const source = fs.readFileSync(new URL('../src/components/StationQuickFacts.vue', import.meta.url), 'utf8')
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
  const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
  const facts = chargingStationFacts({ pricePerKwh: 0, availableCount: 20 })
  const html = await renderToString(Vue.createSSRApp({ render, setup: () => ({ facts, compact: false }) }))
  const positions = ['驾车', '适配', '费用', '排队', '核验'].map(label => html.indexOf(`<dt>${label}</dt>`))
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])))
  for (const label of ['路线不可使用', '暂无价格', '没有实时数据', '数据来源未知', '核验时间未知']) assert.ok(html.includes(label))
  assert.doesNotMatch(html, /0\.00 元|空闲 20/)
  const compact = await renderToString(Vue.createSSRApp({ render, setup: () => ({ facts, compact: true }) }))
  assert.ok(compact.includes('路线不可使用'))
  assert.doesNotMatch(compact, /<dl|暂无价格|没有实时数据|核验时间/)
})

test('入口说明只在弹窗展示，公开资料核对不冒充现场核验，也不改变充电状态', async () => {
  const guides = JSON.parse(fs.readFileSync(new URL('../data/managed/station-access-guides.json', import.meta.url), 'utf8')).guides
  const accessGuide = guides.B0FFJ5K41S
  const facts = chargingStationFacts({ ...route, accessGuide, simulatedFields: ['electricityPrice'], pricePerKwh: 1 })
  assert.match(facts.routeNote, /入口坐标未核验|车库内路段未计入/)
  assert.equal(facts.accessGuide.location, '中原国际饭店地下停车场 B1（负一层）')
  assert.equal(facts.verifiedAt, '核验时间未知')
  assert.equal(facts.availability.status, '没有实时数据')
  assert.equal(facts.price, '暂无价格')
  const source = fs.readFileSync(new URL('../src/components/StationQuickFacts.vue', import.meta.url), 'utf8')
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
  const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
  const html = await renderToString(Vue.createSSRApp({ render, setup: () => ({ facts, compact: false }) }))
  for (const label of ['入口与到桩', '建安大道', '负一层', '尚未现场核验', '进场说明与来源', '非现场核验时间', '在高德查看']) assert.ok(html.includes(label), label)
  const compact = await renderToString(Vue.createSSRApp({ render, setup: () => ({ facts, compact: true }) }))
  assert.doesNotMatch(compact, /入口与到桩|建安大道|负一层|进场说明/)
  assert.equal(chargingStationFacts({ accessGuide, isSynthetic: true }).accessGuide, null)
  const unsafe = chargingStationFacts({ accessGuide: { ...accessGuide, sourceUrl: 'javascript:alert(1)', amapUrl: 'https://evil.example.com/amap.com' } })
  assert.equal(unsafe.accessGuide.sourceUrl, '')
  assert.equal(unsafe.accessGuide.amapUrl, '')
  assert.match(chargingStationFacts({ ...route, accessGuide, routeDestinationKind: 'vehicle_entrance' }).routeNote, /驾车至车行入口/)
})
