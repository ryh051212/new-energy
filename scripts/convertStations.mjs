import fs from 'node:fs'
import path from 'node:path'
//输入原始geojsoN文件
const inputPath = path.resolve(
  'data/raw/amap-stations.json'
)
//输出文件
const outputPath = path.resolve(
  'data/processed/stations-gcj02.json'
)

// 读取原始文件
const rawText = fs.readFileSync(inputPath, 'utf-8')
//转换为jsoN格式
const rawData = JSON.parse(rawText)

// 高德POI数组
const pois = rawData.pois ?? []

console.log(`原始POI数量：${pois.length}`)
//真实poi点位很容易重复 根据每个 POI 的 id 去重。
const uniquePois=Array.from(
  new Map(
    //转换为键值对对象
    pois.map((poi)=>[
      poi.id,
      poi,
    ])
  ).values()
)

// 转换成 Feature
const features = uniquePois
  .map((poi) => {
    if (!poi.location) {
      return null
    }

    const [lng, lat] = poi.location
      .split(',')
      .map(Number)

    // 排除异常坐标
    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat)
    ) {
      return null
    }

    return {
      type: 'Feature',

      properties: {
        id: poi.id ?? '',
        name: poi.name ?? '',
        type: poi.type ?? '',
        address: poi.address ?? '',
        district: poi.adname ?? '',
        city: poi.cityname ?? '',
        coordSystem: 'GCJ-02',
      },

      geometry: {
        type: 'Point',

        coordinates: [
          lng,
          lat,
        ],
      },
    }
  })
  .filter(Boolean)

// FeatureCollection
const geojson = {
  type: 'FeatureCollection',
  features,
}

// 输出
fs.mkdirSync(
  path.dirname(outputPath),
  {
    recursive: true,
  }
)

fs.writeFileSync(
  outputPath,
  JSON.stringify(
    geojson,
    null,
    
  ),
  'utf-8'
)

console.log(
  `有效POI数量：${features.length}`
)

console.log(
  `已生成：${outputPath}`
)