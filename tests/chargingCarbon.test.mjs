import test from 'node:test'
import assert from 'node:assert/strict'
import { CARBON_INPUT_DEFAULTS, DEFAULT_GASOLINE_CO2_PER_LITRE, estimateChargingCarbon, resolveCarbonFactor, createCarbonRecord, restoreCarbonRecords, restoreCarbonSettings } from '../src/utils/chargingCarbon.js'
const calc = options => estimateChargingCarbon({...CARBON_INPUT_DEFAULTS,...options})

test('默认河南因子与汽油换算有明确单位；按同等里程扣除充电间接排放，不把充电视为零排放',()=>{
  const result=calc({})
  assert.equal(result.factor.year,2023);assert.equal(result.factor.value,.5897)
  assert.equal(result.gridKwh,24);assert.equal(result.batteryKwh,21.6)
  assert.ok(Math.abs(result.distanceKm-144)<1e-10)
  assert.equal(DEFAULT_GASOLINE_CO2_PER_LITRE,2.221059)
  assert.ok(Math.abs(result.electricityCO2Kg-14.1528)<1e-12)
  assert.ok(Math.abs(result.avoidedCO2Kg-9.8346372)<1e-9)
  assert.equal(result.verdict,'reduction')
})
test('输入侧、电池侧及 SOC 方式保持能量换算一致，不能重复计充电损耗',()=>{
  const grid=calc({chargeKwh:40}),battery=calc({energyBasis:'battery',chargeKwh:36})
  const soc=calc({mode:'soc',batteryCapacityKwh:60,startSoc:20,targetSoc:80})
  for(const result of [battery,soc]){
    assert.ok(Math.abs(result.gridKwh-grid.gridKwh)<1e-12)
    assert.ok(Math.abs(result.avoidedCO2Kg-grid.avoidedCO2Kg)<1e-12)
  }
  assert.equal(grid.distanceKm,240)
  assert.ok(Math.abs(grid.avoidedCO2Kg-16.391062)<1e-9)
})
test('高排放情景保留增排负值，零电量为零而非缺资料，零因子只能作为明确自定义情景',()=>{
  const negative=calc({factorId:'custom',customGridFactor:1.5})
  assert.equal(negative.verdict,'increase');assert.ok(negative.avoidedCO2Kg<0)
  const zero=calc({chargeKwh:0})
  assert.equal(zero.avoidedCO2Kg,0);assert.equal(zero.reductionPercent,null)
  const clean=calc({factorId:'custom',customGridFactor:0})
  assert.equal(clean.electricityCO2Kg,0);assert.equal(clean.factor.source,null)
  assert.equal(resolveCarbonFactor({factorId:'china-2023'}).value,.5306)
})
test('空值、超界、逆向 SOC 与不合法能耗不编造有效减排，非官方 ID 不冒充已核实因子',()=>{
  for(const values of [{chargeKwh:''},{chargeKwh:-1},{chargingEfficiency:0},{chargingEfficiency:1.1},{evKwhPer100Km:0},
    {gasolineLitresPer100Km:''},{gasolineKgCO2PerLitre:null},{factorId:'fake'},
    {factorId:'custom',customGridFactor:-.1},{mode:'soc',startSoc:80,targetSoc:20},{mode:'soc',targetSoc:101}]){
    const result=calc(values);assert.equal(result.valid,false,JSON.stringify(values));assert.ok(result.errors.length)
  }
})
test('保存逐次参数快照，当前参数变更不改历史；损坏存储不生成虚假记录',()=>{
  const input={...CARBON_INPUT_DEFAULTS},record=createCarbonRecord(input,'2026-10-16T02:00:00.000Z','sample')
  input.chargeKwh=80;input.factorId='custom';input.customGridFactor=1.5
  assert.equal(estimateChargingCarbon(record.input).gridKwh,24)
  assert.equal(restoreCarbonRecords([record,{...record,methodVersion:'unknown'},{...record,input:{...record.input,chargeKwh:null}}]).length,1)
  assert.deepEqual(restoreCarbonRecords({}),[])
  assert.equal(restoreCarbonSettings({chargingEfficiency:0}).chargingEfficiency,.9)
  assert.equal(createCarbonRecord({...CARBON_INPUT_DEFAULTS,chargeKwh:''}),null)
})
