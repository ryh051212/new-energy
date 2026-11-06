import test from 'node:test'
import assert from 'node:assert/strict'
import { equipmentSnapshot, stationEquipmentFacts, appendEquipmentDetails } from '../../src/features/stations/models/stationEquipment.js'
import { stationConfiguration } from '../../src/features/planning/models/facilityDemand.js'
import { configurationTotals } from '../../src/features/planning/models/plannerPss.js'

const equipment = overrides => ({ state:'sourced', pileCount:14, gunCount:28, installedPowerKw:1680,
  maxGunPowerKw:null, complete:true, checkedAt:'2023-07-01T00:00:00Z', sourceDate:'2023-07', basis:'historical_snapshot',
  groups:[{label:'双枪直流设备',unitCount:14,gunsPerUnit:2,gunCount:28,unitPowerKw:120,gunPowerKw:null}],
  sources:[{label:'设备资料',url:'https://example.org/equipment'}], ...overrides })
const station = value => ({ type:'Feature', geometry:{type:'Point',coordinates:[113.83,34.03]},
  properties:{id:'real',totalCount:99,powerKw:180,simulatedFields:['totalCount','powerKw'],chargingEquipment:value} })

test('双枪设备使用额定合计，未知实际配置不回退到演示值', () => {
  const known = station(equipment())
  assert.equal(stationConfiguration(known).capacity,1680)
  assert.equal(stationConfiguration(known).pileCount,14)
  assert.equal(stationConfiguration(known).simulated,false)
  const partial = station(equipment({pileCount:6,gunCount:null,installedPowerKw:null,maxGunPowerKw:250}))
  assert.equal(stationConfiguration(partial).capacity,null)
  const unknown = station({state:'unknown'})
  assert.equal(stationConfiguration(unknown).capacity,null)
  assert.equal(stationConfiguration(unknown).pileCount,null)
  assert.deepEqual(configurationTotals([known,partial,unknown]),{stations:3,known:1,unknown:2,capacityKw:1680,piles:null,simulated:false})
})

test('没有真实设备清单的沙盘和虚拟点位继续使用明确的模拟参数', () => {
  const simulated = {properties:{pileCount:4,powerKw:60,isSynthetic:true}}
  assert.equal(stationConfiguration(simulated).capacity,240)
  assert.equal(stationConfiguration(simulated).simulated,true)
})

test('明确记录的零设备和零容量保留为零，不变成未知', () => {
  const empty=station(equipment({pileCount:0,gunCount:0,installedPowerKw:0}))
  assert.equal(stationConfiguration(empty).capacity,0)
  assert.equal(stationConfiguration(empty).pileCount,0)
  assert.match(stationEquipmentFacts(empty.properties).lines[2],/0 kW/)
})

test('地图嵌套 JSON、无效 JSON 和无效来源不会产生虚假的配置能力', () => {
  assert.equal(equipmentSnapshot({chargingEquipment:JSON.stringify(equipment())}).gunCount,28)
  for(const value of ['broken',null,[],{...equipment(),sources:[{url:'javascript:alert(1)'}]},
    {...equipment(),checkedAt:'2099-01-01T00:00:00Z'}]){
    const item=station(value)
    if(value===null) continue
    assert.equal(stationConfiguration(item).capacity,null)
  }
  assert.equal(equipmentSnapshot({chargingEquipment:equipment({installedPowerKw:Infinity})}).installedPowerKw,null)
})

test('桩、枪、每台设备和每枪功率分别显示，不用峰值填逐枪配置', () => {
  const facts = stationEquipmentFacts(station(equipment()).properties)
  assert.match(facts.lines[0],/14 台.*28 把/)
  assert.match(facts.groups[0].text,/每台设备 120 kW.*每枪功率未公布/)
  assert.match(facts.lines[1],/未知/)
  const tesla = stationEquipmentFacts(station(equipment({pileCount:6,gunCount:null,installedPowerKw:null,maxGunPowerKw:250})).properties)
  assert.match(tesla.lines[1],/最高单枪功率：250 kW/)
  assert.match(tesla.lines[2],/未知/)
})

test('弹窗使用文本节点，来源链接经过协议校验', () => {
  const doc={createElement:tag=>({tag,children:[],append(child){this.children.push(child)}})}
  const content=doc.createElement('div')
  appendEquipmentDetails(content,station(equipment({groups:[{label:'<img src=x onerror=alert(1)>',unitCount:1}]})).properties,doc)
  const details=content.children[0].children.at(-1)
  assert.match(details.children[1].textContent,/<img src=x/)
  const link=details.children.find(item=>item.tag==='a')
  assert.equal(link.href,'https://example.org/equipment')
  assert.equal(link.rel,'noopener noreferrer')
})
