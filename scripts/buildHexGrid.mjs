import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { countHexStations } from '../src/utils/hexGrid.js'
import { filterStations } from '../src/utils/stations.js'
import * as turf from '@turf/turf'
// 文件位置相对于当前脚本，换目录执行时也能找到数据。
const boundaryPath = new URL('../public/geojson/weidu.json', import.meta.url)

const stationsPath = new URL('../public/geojson/stations.json', import.meta.url)

const outputPath = new URL('../public/geojson/hex-grid.json', import.meta.url)

// ==============================
// 1. 读取数据
// ==============================
//读取边界数据
const boundaryData = JSON.parse(
  fs.readFileSync(boundaryPath, 'utf-8')
)
//读取充电桩数据
const stations = JSON.parse(
  fs.readFileSync(stationsPath, 'utf-8')
)

// ==============================
// 2. 获取魏都区 Polygon
// ==============================

// 保留所有边界要素，避免遗漏分离的行政区块。
const filteredStations = filterStations(stations, boundaryData)
let weidu = boundaryData
if (boundaryData.type === 'FeatureCollection') {
  if (boundaryData.features.length === 1) {
    weidu = boundaryData.features[0]
  } else {
    // 多个行政区块先合并，避免只统计第一个区块。
    weidu = turf.union(boundaryData)
  }
}

console.log(
  `充电站数量：${stations.features.length}`
)

// ==============================
// 3. 获取魏都区 bbox
// ==============================

const bbox = turf.bbox(weidu)

console.log('魏都区 bbox：', bbox)

// ==============================
// 4. 创建六边形网格
// ==============================

const hexGrid = turf.hexGrid(
  bbox,

  // 六边形边长：0.5 km
  0.5,

  {//单位
    units: 'kilometers',

    // 只生成魏都区范围相关网格
    mask: weidu,
  }
)


console.log(
  `生成六边形：${hexGrid.features.length}`
)

// ==============================
// 5. 统计每个网格中的充电站
// ==============================

// 只统计范围内站点，每个站点最多计入一个网格；遗漏时停止写入。
const countedGrid = countHexStations(hexGrid, filteredStations)

// ==============================
// 6. 保存结果
// ==============================

/*第一个参数：文件路径
第二个参数：要写入的内容
第三个参数：文件编码*/
fs.writeFileSync(
  outputPath,

  JSON.stringify(
    countedGrid,
    null,
    2
  ),

  'utf-8'
)

console.log(
  `已生成：${fileURLToPath(outputPath)}`
)
