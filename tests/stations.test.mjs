import test from 'node:test'
import assert from 'node:assert/strict'
import { convertPois, filterStations } from '../src/utils/stations.js'

const polygon = x => ({ type: 'Feature', properties: {}, geometry: {
  type: 'Polygon', coordinates: [[[x,0],[x+1,0],[x+1,1],[x,1],[x,0]]]
} })
const point = (x,y,district = '') => ({ type: 'Feature', properties: { district },
  geometry: { type: 'Point', coordinates: [x,y] } })

test('转换保留无 ID 站点，重复 ID 保留最后一个有效记录', () => {
  const result = convertPois([
    { location: '113,34', name: 'A' }, { location: '114,34', name: 'B' },
    { id: 'x', location: '113,34' }, { id: 'x', location: '114,35' },
    { id: 'x', location: 'bad' }
  ])
  assert.equal(result.features.length, 3)
  assert.deepEqual(result.features[2].geometry.coordinates, [114,35])
  assert.equal(result.features[0].properties.chargeType, 'unknown')
})
test('转换拒绝空坐标、越界坐标、错误维数和非字符串', () => {
  const values = [',34', '113,', '181,34', '113,91', 'NaN,34', '1,2,3', []]
  assert.equal(convertPois(values.map(location => ({ location }))).features.length, 0)
})
test('空间筛选遍历全部边界，包含边界点，不依赖 district 字段', () => {
  const result = filterStations({ type: 'FeatureCollection', features: [
    point(.5,.5,'其他区'), point(2.5,.5), point(1,.5), point(8,8,'魏都区')
  ] }, { type: 'FeatureCollection', features: [polygon(0),polygon(2)] })
  assert.equal(result.features.length, 3)
})
test('支持 MultiPolygon，排除洞内点，允许零结果', () => {
  const shell = polygon(0).geometry.coordinates[0]
  const hole = [[.2,.2],[.8,.2],[.8,.8],[.2,.8],[.2,.2]]
  const boundary = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[shell,hole]] } }
  const result = filterStations({ type: 'FeatureCollection', features: [point(.5,.5)] }, boundary)
  assert.equal(result.features.length, 0)
  assert.throws(() => filterStations({}, boundary))
  assert.throws(() => filterStations({type:'FeatureCollection',features:[]}, {type:'FeatureCollection',features:[]}))
})
