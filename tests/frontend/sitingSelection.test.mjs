import test from 'node:test'
import assert from 'node:assert/strict'
import { polygon } from '@turf/turf'
import { assessSitingLocation, featuresInSitingScope } from '../../src/features/planning/models/sitingSelection.js'

const box = (id,x,properties={}) => polygon([[[x,34],[x+.004,34],[x+.004,34.004],[x,34.004],[x,34]]],{id,...properties})
const boundary = polygon([[[113,33.9],[114,33.9],[114,34.2],[113,34.2],[113,33.9]]])
const features = [box('open',113.8),box('blocked',113.804,{sitePermission:false}),box('far',113.818)]

test('未选区不生成候选范围，500 m 与 2 km 只包含局部网格且不修改输入',()=>{
  assert.deepEqual(featuresInSitingScope(features,null),[])
  const selection={center:[113.802,34.002],radiusMeters:500}
  assert.deepEqual(featuresInSitingScope(features,selection).map(feature=>feature.properties.id),['open','blocked'])
  assert.deepEqual(featuresInSitingScope(features,{...selection,radiusMeters:2000}).map(feature=>feature.properties.id),['open','blocked','far'])
  assert.deepEqual(featuresInSitingScope(features,{...selection,radiusMeters:NaN}),[])
  assert.equal(features.length,3)
})

test('区外、边界洞、无网格和已标注禁建的位置不可选，未知建设资料保留待核查',()=>{
  const options={boundary,features}
  assert.equal(assessSitingLocation([113.802,34.002],options).allowed,true)
  assert.equal(assessSitingLocation([113.806,34.002],options).allowed,false)
  assert.equal(assessSitingLocation([114.1,34.002],options).allowed,false)
  assert.equal(assessSitingLocation([113.9,34.002],options).allowed,false)
  assert.equal(assessSitingLocation([NaN,34],options).allowed,false)
  assert.equal(assessSitingLocation([113.802,34.002],{}).allowed,false)
  const withHole=polygon([...boundary.geometry.coordinates,[[113.801,34.001],[113.803,34.001],[113.803,34.003],[113.801,34.003],[113.801,34.001]]])
  assert.equal(assessSitingLocation([113.802,34.002],{...options,boundary:withHole}).allowed,false)
})

test('场地、道路、消防和显式禁建属性均阻止选择，补充资料可覆盖原核查值',()=>{
  for(const [key,value] of [['sitePermission',false],['roadAccess',false],['fireSafety',false],['buildable',false],['constructionAllowed',false],['noBuild',true]]){
    const result=assessSitingLocation([113.802,34.002],{boundary,features,factors:{open:{[key]:value}}})
    assert.equal(result.allowed,false,key)
    assert.ok(result.reason)
  }
  assert.equal(assessSitingLocation([113.806,34.002],{boundary,features,factors:{blocked:{sitePermission:true}}}).allowed,true)
  assert.equal(assessSitingLocation([113.804,34.002],{boundary,features}).allowed,false,'共边不能绕过禁建网格')
})
