import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { filterStations } from '../src/utils/stations.js'
import * as turf from '@turf/turf'
// 文件位置相对于当前脚本，换目录执行时也能找到数据。
const boundaryPath = new URL('../public/geojson/weidu.json', import.meta.url)

const stationsPath = new URL('../public/geojson/stations.json', import.meta.url)
const residentialPath = path.resolve(
  'public/geojson/residential-pois.json'
)
// 商业 POI 文件
const commercialPath = path.resolve(
  'public/geojson/commercial-pois.json'
)

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
// 读取居民小区 GeoJSON
const residentialPois = JSON.parse(
  fs.readFileSync(residentialPath, 'utf-8')
)

// 读取商业设施 GeoJSON
const commercialPois = JSON.parse(
  fs.readFileSync(
    commercialPath,
    'utf-8'
  )
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
// 5. 统计每个网格中的充电站和居民小区
// ==============================

const countedGrid = {
  ...hexGrid,
  features: hexGrid.features.map((hex, index) => {
    const stationsInside = turf.pointsWithinPolygon(
      filteredStations,
      hex
    )

    const residentialInside = turf.pointsWithinPolygon(
      residentialPois,
      hex
    )
    // 找出当前六边形内部的商业 POI
const commercialInside =
  turf.pointsWithinPolygon(
    commercialPois,
    hex
  )

    return {
      ...hex,//“先保留原对象，然后在其上追加新的属性”
      properties: {
        ...hex.properties,
        id: index + 1,
        stationCount: stationsInside.features.length,
        residentialCount: residentialInside.features.length,
        commercialInside:commercialInside.features.length
      },
    }
  }),
}

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
// ======================================
// 数据质量检查：
// 把所有六边形中的居民小区数量加起来
// ======================================
const residentialCountInHex =
  countedGrid.features.reduce(
    (total, hex) => {
      return total + Number(hex.properties.residentialCount || 0)
    },
    0
  )


// 原始居民小区 Point 总数
const originalResidentialCount =
  residentialPois.features.length


console.log(
  '原始居民小区总数：',
  originalResidentialCount
)

console.log(
  '六边形内居民小区总数：',
  residentialCountInHex
)
// ======================================
// 检查商业 POI 是否基本全部进入六边形
// ======================================

const commercialCountInHex =
  hexGrid.features.reduce(
    (total, hex) => {

      return (
        total +
        Number(
          hex.properties
            .commercialCount ?? 0
        )
      )
    },

    0
  )


// 原始商业 POI 总数
const originalCommercialCount =
  commercialPois.features.length


console.log(
  '原始商业POI总数：',
  originalCommercialCount
)

console.log(
  '六边形内商业POI总数：',
  commercialCountInHex
)
