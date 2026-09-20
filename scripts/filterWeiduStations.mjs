import fs from 'node:fs'
import path from 'node:path'
import * as turf from '@turf/turf'

const stationsPath = path.resolve(
  'data/processed/stations-gcj02.json'
)

const boundaryPath = path.resolve(
  'public/geojson/weidu.json'
)

const outputPath = path.resolve(
  'data/processed/weidu-stations.json'
)

const stations = JSON.parse(
  fs.readFileSync(stationsPath, 'utf-8')
)

const boundaryData = JSON.parse(
  fs.readFileSync(boundaryPath, 'utf-8')
)
const weidu =
  boundaryData.type === 'FeatureCollection'
    ? boundaryData.features[0]
    : boundaryData

const features = stations.features.filter((station) => {
  return turf.booleanPointInPolygon(
    station,
    weidu
  )
})

const result = {
  type: 'FeatureCollection',
  features,
}

fs.writeFileSync(
  outputPath,
  JSON.stringify(result, null, 2),
  'utf-8'
)

console.log(`全部站点：${stations.features.length}`)
console.log(`魏都区站点：${features.length}`)
console.log(`已生成：${outputPath}`)