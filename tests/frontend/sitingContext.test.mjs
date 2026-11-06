import test from 'node:test'
import assert from 'node:assert/strict'
import {polygon,point,lineString} from '@turf/turf'
import {locationContext,capacityDescription,safeReferenceUrl} from '../../src/features/planning/models/sitingContext.js'

test('公开参考按真实几何取最近道路与入口，面内用地保留洞，不改写点位或建设条件',()=>{
  const coordinates=[113.005,34.005]
  const land=polygon([[[113,34],[113.01,34],[113.01,34.01],[113,34.01],[113,34]],[[113.004,34.004],[113.006,34.004],[113.006,34.006],[113.004,34.006],[113.004,34.004]]],{category:'landuse',landuse:'residential'})
  const features=[land,point([113.006,34.005],{category:'entrance',entranceKind:'parking',id:'entry'}),point([113.005,34.005],{category:'entrance',entranceKind:'unspecified',id:'pedestrian'}),point([113.008,34.005],{category:'parking',capacity:524,capacityKind:'design'}),point([113.009,34.005],{category:'power',voltage:'10000'})]
  const roads=[lineString([[113,34.005],[113.02,34.005]],{motorVehicleCandidate:true,motorAccess:'unspecified'}),lineString([[113,34.004],[113.02,34.004]],{motorVehicleCandidate:false})]
  const original=structuredClone({coordinates,features,roads})
  const result=locationContext(coordinates,{features},roads)
  assert.ok(result.road.meters<1,'球面道路线与等纬度图上直线允许亚米差异')
  assert.ok(Math.abs(result.road.anchor.geometry.coordinates[0]-coordinates[0])<1e-6)
  assert.equal(result.landuse.length,0,'用地洞内不能归属该用地')
  assert.equal(result.entrances.length,1,'普通建筑入口不能冒充停车入口')
  assert.equal(result.entrances[0].feature.properties.id,'entry')
  assert.equal(result.parking[0].feature.properties.capacity,524)
  assert.equal(result.availableKva,undefined)
  assert.equal(result.roadAccess,undefined)
  assert.deepEqual({coordinates,features,roads},original)
})

test('历史总泊位与未知数值清楚区分，来源链接不能执行脚本',()=>{
  assert.equal(capacityDescription({capacity:524,capacityKind:'design',capacityDate:'2021-11-18'}),'公开设计规模 524 位（2021年）')
  assert.equal(capacityDescription({capacity:0,capacityKind:'mapped'}),'地图标注总泊位 0 位')
  assert.equal(capacityDescription({capacity:null}),'泊位数未提供')
  assert.equal(safeReferenceUrl('javascript:alert(1)'), '')
  assert.equal(safeReferenceUrl('https://www.openstreetmap.org/node/1'),'https://www.openstreetmap.org/node/1')
  assert.equal(locationContext(null,{features:[]}),null)
})
