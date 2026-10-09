import test from 'node:test'
import assert from 'node:assert/strict'
import { CHARGING_SETTINGS_KEY, readChargingSettings, saveChargingSettings } from '../src/utils/chargingSettings.js'
import { destinationCategory, destinationCatalog, filterDestinations } from '../src/utils/destinations.js'
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } }
const input = { intent: 'destination', profile: { currentSoc: 20, batteryKwh: 60, consumptionKwh: 15, maxChargeKw: 100,
  queueMinutes: 0, stayMinutes: 90, destination: [113.84, 34.04], origin: [113.82, 34.03] },
  destinationInfo: { id: 'custom', name: '图书馆', category: 'education' }, confirmSoc: true }

test('设置再次读取保持车辆、模式、目的地和活动安排；实时起点不持久保存', () => {
  const store = storage()
  assert.equal(saveChargingSettings(input, store, new Date('2026-10-09T01:00:00Z')).ok, true)
  const read = readChargingSettings(store)
  assert.equal(read.profile.currentSoc, 20)
  assert.equal(read.profile.queueMinutes, 0)
  assert.equal(read.profile.stayMinutes, 90)
  assert.equal(read.intent, 'destination')
  assert.equal(read.destinationInfo.name, '图书馆')
  assert.equal(read.destinationInfo.category, 'education')
  assert.deepEqual(read.destinationInfo.coordinates, [113.84, 34.04])
  assert.equal(Object.hasOwn(read.profile, 'origin'), false)
  assert.equal(Object.hasOwn(read.profile, 'shoppingMinutes'), false)
  assert.equal(read.socUpdatedAt, '2026-10-09T01:00:00.000Z')
})
test('修改持久设置生效，切换策略不把旧电量记录冒充新记录', () => {
  const store = storage()
  saveChargingSettings(input, store, new Date('2026-10-09T01:00:00Z'))
  saveChargingSettings({ ...readChargingSettings(store), intent: 'economy' }, store, new Date('2026-10-10T01:00:00Z'))
  let read = readChargingSettings(store)
  assert.equal(read.intent, 'economy')
  assert.equal(read.socUpdatedAt, '2026-10-09T01:00:00.000Z')
  saveChargingSettings({ ...read, profile: { ...read.profile, currentSoc: 35 } }, store, new Date('2026-10-11T01:00:00Z'))
  read = readChargingSettings(store)
  assert.equal(read.profile.currentSoc, 35)
  assert.equal(read.socUpdatedAt, '2026-10-11T01:00:00.000Z')
  assert.equal(read.destinationInfo.name, '图书馆')
})
test('三种推荐始终读取同一份参数，切换模式保留目的地、停留时间和车辆资料', () => {
  const store = storage()
  saveChargingSettings(input, store, new Date('2026-10-09T01:00:00Z'))
  const shared = readChargingSettings(store)
  for (const intent of ['urgent', 'destination', 'economy', 'urgent']) {
    saveChargingSettings({ ...readChargingSettings(store), intent }, store, new Date('2026-10-10T01:00:00Z'))
    const result = readChargingSettings(store)
    assert.equal(result.intent, intent)
    assert.deepEqual(result.profile, shared.profile)
    assert.deepEqual(result.destinationInfo, shared.destinationInfo)
    assert.equal(result.socUpdatedAt, shared.socUpdatedAt)
  }
})
test('损坏、未知版本与禁止存储都有明确结果；无效值不能成为有效车辆参数', () => {
  const store = storage()
  for (const value of ['bad JSON', '[]', '{"version":2}']) {
    store.setItem(CHARGING_SETTINGS_KEY, value)
    const read = readChargingSettings(store)
    assert.ok(read.error)
    assert.equal(read.profile.currentSoc, null)
  }
  store.setItem(CHARGING_SETTINGS_KEY, JSON.stringify({ version: 1, intent: 'shopping', profile: { shoppingMinutes: 45, currentSoc: [], batteryKwh: -1, destination: [181, 34] } }))
  const read = readChargingSettings(store)
  assert.equal(read.intent, 'destination')
  assert.equal(read.profile.stayMinutes, 45)
  assert.equal(read.profile.currentSoc, null)
  assert.equal(read.profile.batteryKwh, null)
  assert.equal(read.destinationInfo, null)
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.ok(readChargingSettings(blocked).error)
  assert.equal(saveChargingSettings(input, blocked).ok, false)
  assert.equal(saveChargingSettings(input, null).ok, false)
})
test('目的地分类基于地点类型；住宅不误判办公，不编造缺失类别的地点', () => {
  assert.equal(destinationCategory({ type: '商务住宅;住宅区;住宅小区' }), 'residential')
  assert.equal(destinationCategory({ type: '商务住宅;写字楼;办公' }), 'work')
  assert.equal(destinationCategory({ type: '餐饮服务;中餐厅' }), 'dining')
  assert.equal(destinationCategory({ type: '医疗保健服务;医院' }), 'health')
  const point = (id, type, coordinates = [113.84,34.04]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { id, name: id, type } })
  const catalog = destinationCatalog([point('商场', '购物服务;商场'), point('小区', '商务住宅;住宅区'), point('小区', '商务住宅;住宅区'), point('无效', '', [200,0])])
  assert.equal(catalog.length, 2)
  assert.equal(filterDestinations(catalog, 'work').length, 0)
  assert.equal(filterDestinations(catalog, 'commerce', '商场').length, 1)
  assert.equal(filterDestinations(catalog, 'residential')[0].name, '小区')
})
