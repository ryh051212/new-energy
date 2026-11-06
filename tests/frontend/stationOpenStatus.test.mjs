import test from 'node:test'
import assert from 'node:assert/strict'
import { stationOpenStatus } from '../../src/features/stations/models/stationOpenStatus.js'

test('明确的运营中断状态优先显示', () => {
  assert.equal(stationOpenStatus({ status:'maintenance', publicAccess:true }).label, '维护中')
  assert.equal(stationOpenStatus({ status:'offline', publicAccess:true }).label, '暂不可用')
})

test('公共开放资料与开放时间共同定义状态', () => {
  assert.equal(stationOpenStatus({ status:'active', publicAccess:true, openingHours:'00:00-24:00' }).label, '公开开放')
  const limited=stationOpenStatus({ status:'active', publicAccess:true, openingHours:'08:00-22:00' })
  assert.equal(limited.label, '限时开放')
  assert.equal(limited.hours, '08:00-22:00')
  assert.equal(stationOpenStatus({ status:'active', publicAccess:false }).label, '限制使用')
})

test('模拟开放状态不能冒充公开核验', () => {
  assert.equal(stationOpenStatus({ status:'active', simulatedFields:['status'], openingHours:'00:00-24:00' }).label, '情景开放')
  assert.equal(stationOpenStatus({ status:'active', simulatedFields:'["status"]', openingHours:'07:00-22:00' }).label, '情景限时开放')
  assert.equal(stationOpenStatus({ status:'active' }).label, '开放待核实')
})
