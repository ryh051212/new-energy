import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { countHexStations } from '../src/utils/hexGrid.js'

const collection = features => ({ type: 'FeatureCollection', features })
const point = coordinates => ({ type: 'Feature', geometry: { type: 'Point', coordinates } })
const box = x => ({ type: 'Feature', properties: { stationCount: 99 }, geometry: {
  type: 'Polygon', coordinates: [[[x,0],[x+1,0],[x+1,1],[x,1],[x,0]]]
} })
test('共边点只计一次，重新计算旧统计值且不修改原数据', () => {
  const grid = collection([box(0),box(1)])
  const result = countHexStations(grid, collection([point([1,.5]),point([1.5,.5])]))
  assert.deepEqual(result.features.map(hex => hex.properties.stationCount), [1,1])
  assert.equal(grid.features[0].properties.stationCount, 99)
})
test('未覆盖站点明确报错，零站点清空旧计数', () => {
  const grid = collection([box(0)])
  assert.throws(() => countHexStations(grid, collection([point([5,5])])), /1/)
  assert.equal(countHexStations(grid, collection([])).features[0].properties.stationCount, 0)
})
test('实际数据的网格累计数量等于当前站点数量', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../public/geojson/${name}.json`, import.meta.url), 'utf8'))
  const stations = read('stations')
  const counted = countHexStations(read('hex-grid'), stations)
  assert.equal(counted.features.reduce((sum, hex) => sum + hex.properties.stationCount, 0), stations.features.length)
})
