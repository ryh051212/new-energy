import * as turf from '@turf/turf'
import { validCoordinates } from './stations.js'

// 页面和生成脚本都用这一段统计，保证两边的计算规则一致。
export function countHexStations(grid, stations) {
  if (!grid || grid.type !== 'FeatureCollection' || !Array.isArray(grid.features)) {
    throw new Error('六边形文件格式不正确')
  }
  if (!stations || stations.type !== 'FeatureCollection' || !Array.isArray(stations.features)) {
    throw new Error('站点文件格式不正确')
  }

  // 复制一份数据，后面修改数量不会改变传入的原始网格。
  const result = JSON.parse(JSON.stringify(grid))
  const counted = []
  stations.features.forEach((station) => {
    if (!station || !station.geometry || station.geometry.type !== 'Point') {
      throw new Error('站点必须是点要素')
    }
    if (!validCoordinates(station.geometry.coordinates)) {
      throw new Error('站点坐标无效')
    }
    counted.push(false)
  })

  // 和原来的写法一样：逐个网格筛选站点，再记录数量。
  result.features.forEach((hex, index) => {
    if (!hex || !hex.geometry) {
      throw new Error('六边形文件格式不正确')
    }
    if (hex.geometry.type !== 'Polygon' && hex.geometry.type !== 'MultiPolygon') {
      throw new Error('网格必须是面要素')
    }

    const pointsInside = stations.features.filter((station, stationIndex) => {
      // 共边上的站点可能属于两个网格，已经计数的就跳过。
      if (counted[stationIndex]) {
        return false
      }
      if (turf.booleanPointInPolygon(station, hex)) {
        counted[stationIndex] = true
        return true
      }
      return false
    })

    if (!hex.properties) {
      hex.properties = {}
    }
    hex.properties.id = index + 1
    hex.properties.stationCount = pointsInside.length
  })

  // 检查有没有站点没有落入任何网格。
  const uncovered = counted.filter((isCounted) => {
    return isCounted === false
  })
  if (uncovered.length > 0) {
    throw new Error(`有 ${uncovered.length} 个站点未被网格覆盖，请重新生成网格`)
  }
  return result
}
