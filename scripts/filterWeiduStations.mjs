import fs from 'node:fs'
import { filterStations } from '../src/utils/stations.js'

const read = relative => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'))
const stations = read('../data/processed/stations-gcj02.json')
const boundary = read('../public/geojson/weidu.json')
const result = filterStations(stations, boundary)
// 网页和处理结果使用同一份空间筛选数据。
const content = JSON.stringify(result, null, 2)
for (const relative of ['../data/processed/weidu-stations.json', '../public/geojson/stations.json']) {
  const output = new URL(relative, import.meta.url)
  fs.mkdirSync(new URL('.', output), { recursive: true })
  fs.writeFileSync(output, content, 'utf8')
}
console.log(`全部站点：${stations.features.length}，空间筛选后：${result.features.length}；已同步网页数据`)
