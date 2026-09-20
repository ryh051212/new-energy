import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { convertPois } from '../src/utils/stations.js'

const inputPath = new URL('../data/raw/amap-stations.json', import.meta.url)
const outputPath = new URL('../data/processed/stations-gcj02.json', import.meta.url)
const rawData = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const geojson = convertPois(rawData.pois)
fs.mkdirSync(new URL('.', outputPath), { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(geojson, null, 2), 'utf8')
console.log(`原始 POI：${rawData.pois.length}，有效站点：${geojson.features.length}`)
console.log(`已生成：${fileURLToPath(outputPath)}`)
