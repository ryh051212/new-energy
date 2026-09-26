//抓取居民点数据
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

// 读取项目根目录中的 .env.local
// 里面已经有你之前使用的高德 Web Service Key
dotenv.config({
  path: new URL('../.env.local', import.meta.url),
})

// 从环境变量中拿高德 Key
const key = process.env.AMAP_KEY

// 如果没拿到 Key，就直接停止程序
// 避免后面请求半天才发现问题
if (!key) {
  throw new Error('没有找到 AMAP_KEY')
}

// 魏都区行政区划代码
const REGION = '411002'

// 高德 POI 分类：住宅小区
// 集中写在这里，后面分类码变化也方便修改
const RESIDENTIAL_TYPE = '120302'
const pageSize = 25
const requestIntervalMs = 2000
const maxRetries = 3

const sleep = (milliseconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

// 创建高德 POI 2.0 查询地址
// 请求高德的某一页 POI
// pageNum 由外面传进来，例如 1、2、3……
async function fetchPage(pageNum) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const url = new URL(
      'https://restapi.amap.com/v5/place/text'
    )

    // 高德 Web Service Key
    url.searchParams.set('key', key)

    // 查询住宅小区
    url.searchParams.set(
      'types',
      RESIDENTIAL_TYPE
    )

    // 限制在魏都区
    url.searchParams.set(
      'region',
      REGION
    )

    // 严格限制搜索区域
    url.searchParams.set(
      'city_limit',
      'true'
    )

    // 高德 Web Service POI 2.0 单页最多 25 条
    url.searchParams.set(
      'page_size',
      String(pageSize)
    )

    // 当前查询第几页
    url.searchParams.set(
      'page_num',
      String(pageNum)
    )

    try {
      // 发起请求
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      })

      // HTTP 本身请求失败时直接报错
      if (!response.ok) {
        const error = new Error(`HTTP请求失败：${response.status}`)
        error.retryable = response.status === 429 || response.status >= 500
        throw error
      }

      const data = await response.json()

      // 高德接口业务状态检查
      if (data.status === '1') {
        return data.pois ?? []
      }

      if (
        data.infocode !== '10021' ||
        attempt === maxRetries
      ) {
        console.error(data)
        throw new Error(`高德第 ${pageNum} 页请求失败`)
      }

      const retryDelayMs = 2000 * (attempt + 1)
      console.warn(
        `第 ${pageNum} 页触发 QPS 限制，${retryDelayMs / 1000} 秒后重试...`
      )
      await sleep(retryDelayMs)
    } catch (error) {
      if (attempt === maxRetries || error.retryable === false) {
        throw error
      }

      const retryDelayMs = 2000 * (attempt + 1)
      console.warn(
        `第 ${pageNum} 页请求异常，${retryDelayMs / 1000} 秒后重试...`
      )
      await sleep(retryDelayMs)
    }
  }

  throw new Error(`高德第 ${pageNum} 页重试后仍失败`)
}
//循环获取所有页码
// 用于保存所有分页请求回来的 POI
let allPois = []

// 从第一页开始
let pageNum = 1

while (pageNum <= 20) {
  console.log(
    `正在获取第 ${pageNum} 页...`
  )

  // 请求当前页
  const pois =
    await fetchPage(pageNum)

  console.log(
    `第 ${pageNum} 页：${pois.length} 条`
  )

  // 把当前页的数据追加到总数组
  // ...pois 会把数组中的元素展开
  allPois.push(...pois)

  // 如果这一页已经不足25条，
  // 说明正常情况下后面没有更多结果了
  if (pois.length < pageSize) {
    break
  }

  // 下一轮请求下一页
  pageNum++
  await sleep(requestIntervalMs)
}
//去除重复
// 使用 POI id 去重
//POI id 唯一编号
// Map 的 key 不能重复，因此相同 id 最终只保留一条
const uniquePois = Array.from(
  new Map(
    allPois.map(
      poi => [
        poi.id,
        poi
      ]
    )
  ).values()
)

console.log(
  `分页共获取：${allPois.length} 条`
)

console.log(
  `去重后：${uniquePois.length} 条`
)

// 转换为 GeoJSON 类型
// 高德返回的 POI 数组
const features = uniquePois
  .map((poi) => {
    // 没坐标的记录不能生成 Point
    if (!poi.location) {
      return null
    }

    // 高德 location:
    // "113.xxx,34.xxx"
    // 转成数字数组
    const [lng, lat] =
      poi.location
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
        typecode:
          poi.typecode ?? '',
        address:
          poi.address ?? '',

        // 我们自己定义的需求分类
        category: 'residential',

        // 高德返回坐标为 GCJ-02
        coordSystem: 'GCJ-02'
      },

      geometry: {
        type: 'Point',

        coordinates: [
          lng,
          lat
        ]
      }
    }
  })

  // 移除前面产生的 null
  .filter(Boolean)

  // 把前面 return null 的异常记录过滤掉
  .filter(Boolean)

  const geojson = {
  type: 'FeatureCollection',

  features
}
//保存数据
const outputPath = new URL('../public/geojson/residential-pois.json', import.meta.url)

// 确保文件夹存在
fs.mkdirSync(
  new URL('.', outputPath),
  {
    recursive: true,
  }
)

// 写入 GeoJSON 文件
fs.writeFileSync(
  outputPath,
  JSON.stringify(
    geojson,
    null,
    2
  ),
  'utf-8'
)

console.log(
  `已生成 ${features.length} 个居民小区 POI`
)