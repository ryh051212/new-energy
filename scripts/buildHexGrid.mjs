import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { filterStations } from '../src/utils/stations.js'
import * as turf from '@turf/turf'
// 文件位置相对于当前脚本，换目录执行时也能找到数据。
const boundaryPath = new URL('../public/geojson/weidu.json', import.meta.url)

const stationsPath = new URL('../public/geojson/stations.json', import.meta.url)
const residentialPath = new URL('../public/geojson/residential-pois.json', import.meta.url)
// 商业 POI 文件
const commercialPath = new URL('../public/geojson/commercial-pois.json', import.meta.url)

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
  fs.readFileSync(commercialPath, 'utf-8').replace(/^\uFEFF/, '')
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
        commercialCount: commercialInside.features.length
      },
    }
  }),
}

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
  countedGrid.features.reduce(
    (total, hex) => {

      return (
        total +
        Number(
          hex.properties.commercialCount ?? 0
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
// ==========================================
// 2. 找出两类指标各自的最大值、最小值
// 后面 Min-Max 标准化需要使用
// ==========================================

const residentialCounts = countedGrid.features.map(
  (hex) => Number(hex.properties.residentialCount ?? 0)
)
const commercialCounts = countedGrid.features.map(
  (hex) => Number(hex.properties.commercialCount ?? 0)
)

const minResidential = Math.min(...residentialCounts)
const maxResidential = Math.max(...residentialCounts)
const minCommercial = Math.min(...commercialCounts)
const maxCommercial = Math.max(...commercialCounts)
  // ==========================================
// Min-Max 标准化函数
// 把不同数量级的数据统一映射到 0～1
// ==========================================
function minMaxNormalize(
  value,
  min,
  max
) {

  // 如果 max === min，
  // 说明所有六边形的这个指标都完全一样。
  // 此时避免出现除以0。
  if (max === min) {
    return 0
  }

  return (
    (value - min) /
    (max - min)
  )
}
// ==========================================
//供给侧
// 提取所有六边形的充电站数量
// 用于计算供给侧最大值和最小值
// ==========================================
const stationValues =
  countedGrid.features.map(
    hex =>
      Number(
        hex.properties.stationCount ?? 0
      )
  )
  // 供给侧最大、最小值
const minStation =
  Math.min(...stationValues)

const maxStation =
  Math.max(...stationValues)



  //需求侧
  //得到六边形内参数
countedGrid.features.forEach((hex) => {

  const residentialCount =
    Number(
      hex.properties.residentialCount ?? 0
    )

  const commercialCount =
    Number(
      hex.properties.commercialCount ?? 0
    )


  // 居民需求标准化
  const residentialNorm =
    minMaxNormalize(
      residentialCount,
      minResidential,
      maxResidential
    )


  // 商业需求标准化
  const commercialNorm =
    minMaxNormalize(
      commercialCount,
      minCommercial,
      maxCommercial
    )
  // 保存到当前六边形 properties
  hex.properties.residentialNorm =
    residentialNorm

  hex.properties.commercialNorm =
    commercialNorm
})
countedGrid.features.forEach((hex) => {

  const residentialNorm =
    Number(
      hex.properties.residentialNorm ?? 0
    )

  const commercialNorm =
    Number(
      hex.properties.commercialNorm ?? 0
    )
  const stationCount = Number(hex.properties.stationCount ?? 0)
     // ======================================
  // 综合潜在需求指数
  //
  // V1 没有足够依据判断居民和商业谁更重要，
  // 因此暂时采用等权法。
  // ======================================
  const demandIndex =
    0.5 * residentialNorm +
    0.5 * commercialNorm
    
      hex.properties.demandIndex =
    Number(
    demandIndex.toFixed(3)
  )

  const supplyIndex =
    minMaxNormalize(
      stationCount,
      minStation,
      maxStation
    )

  // 保留三位小数，方便查看和后续计算
  hex.properties.supplyIndex =
    Number(
      supplyIndex.toFixed(3)
    )
  // 正值表示需求较高，负值表示供给较高。
  hex.properties.mismatchIndex = Number(
    (hex.properties.demandIndex - hex.properties.supplyIndex).toFixed(3)
  )
})
// ==========================================
// 1. 提取所有六边形的需求和供给指数
// ==========================================

const demandValues =
  countedGrid.features.map(
    hex =>
      Number(
        hex.properties.demandIndex ?? 0
      )
  )

const supplyValues =
  countedGrid.features.map(
    hex =>
      Number(
        hex.properties.supplyIndex ?? 0
      )
  )
  // ==========================================
// 2. 计算研究区平均需求和平均供给
//
// 后面以平均值作为“相对高 / 相对低”的分界线
// ==========================================

const meanDemand =
  demandValues.reduce(
    (sum, value) => sum + value,
    0
  ) / demandValues.length


const meanSupply =
  supplyValues.reduce(
    (sum, value) => sum + value,
    0
  ) / supplyValues.length


console.log(
  '平均 DemandIndex：',
  meanDemand.toFixed(3)
)

console.log(
  '平均 SupplyIndex：',
  meanSupply.toFixed(3)
)
// ==========================================
// 3. 根据需求和供给相对平均水平
//    对每个六边形进行四象限分类
// ==========================================

countedGrid.features.forEach((hex) => {

  const demandIndex =
    Number(
      hex.properties.demandIndex ?? 0
    )

  const supplyIndex =
    Number(
      hex.properties.supplyIndex ?? 0
    )


  // 是否属于相对高需求
  const highDemand =
    demandIndex >= meanDemand

  // 是否属于相对高供给
  const highSupply =
    supplyIndex >= meanSupply


  let supplyDemandType


  if (highDemand && !highSupply) {

    // 高需求 + 低供给
    // 是我们后续重点关注的一类
    supplyDemandType =
      'high-demand-low-supply'

  } else if (
    highDemand &&
    highSupply
  ) {

    // 高需求 + 高供给
    supplyDemandType =
      'high-demand-high-supply'

  } else if (
    !highDemand &&
    highSupply
  ) {

    // 低需求 + 高供给
    supplyDemandType =
      'low-demand-high-supply'

  } else {

    // 低需求 + 低供给
    supplyDemandType =
      'low-demand-low-supply'
  }


  // 把分类结果保存进六边形
  hex.properties.supplyDemandType =
    supplyDemandType
})

 
// 保存包含需求、供给、错配指数和四象限类型的网格。
fs.writeFileSync(outputPath, JSON.stringify(countedGrid, null, 2), 'utf-8')
console.log(`已生成：${fileURLToPath(outputPath)}`)
console.log(
  '充电站网格最小值：',
  minStation
)

console.log(
  '充电站网格最大值：',
  maxStation
)
