import fs from 'node:fs'
import dotenv from 'dotenv'

dotenv.config({
  path: new URL('../.env.local', import.meta.url),
})

const key = process.env.AMAP_KEY

if (!key) {
  throw new Error('没有找到 AMAP_KEY')
}

const outputPath = new URL('../data/raw/amap-stations.json', import.meta.url)

const pageSize = 25
const requestIntervalMs = 1200
const maxRetries = 3

let pageNum = 1
let allPois = []

const sleep = (milliseconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

const fetchPage = async (url, pageNumber) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let data
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`)
        error.retryable = response.status === 429 || response.status >= 500
        throw error
      }
      data = await response.json()
    } catch (error) {
      if (attempt === maxRetries || error.retryable === false) {
        // 不打印可能携带 key 的请求 URL。
        throw new Error(`第 ${pageNumber} 页请求失败，原数据未覆盖`)
      }
      await sleep(2000 * (attempt + 1))
      continue
    }

    if (data.status === '1') {
      if (!Array.isArray(data.pois)) throw new Error('接口返回的 pois 不是数组，原数据未覆盖')
      return data
    }

    if (
      data.infocode !== '10021' ||
      attempt === maxRetries
    ) {
      throw new Error('高德接口请求失败')
    }

    const retryDelayMs = 2000 * (attempt + 1)
    console.warn(
      `第 ${pageNumber} 页触发 QPS 限制，${retryDelayMs / 1000} 秒后重试...`
    )
    await sleep(retryDelayMs)
  }
}

while (true) {
  console.log(`正在获取第 ${pageNum} 页...`)

  const url = new URL(
    'https://restapi.amap.com/v5/place/text'
  )

  url.searchParams.set('key', key)
  url.searchParams.set('keywords', '充电站')
  url.searchParams.set('region', '许昌市')
  url.searchParams.set('city_limit', 'true')
  url.searchParams.set('page_size', pageSize)
  url.searchParams.set('page_num', pageNum)

  const data = await fetchPage(url, pageNum)

  const pois = data.pois ?? []

  console.log(
    `第 ${pageNum} 页获取 ${pois.length} 条`
  )

  allPois.push(...pois)

  if (pois.length < pageSize) {
    break
  }

  pageNum++
  await sleep(requestIntervalMs)

  // 防止无限循环
  if (pageNum > 20) {
    throw new Error('达到 20 页上限，结果可能不完整，原数据未覆盖')
  }
}

const result = {
  source: 'AMap',
  keyword: '充电站',
  region: '许昌市',
  count: allPois.length,
  pois: allPois,
}

fs.mkdirSync(
  new URL('.', outputPath),
  {
    recursive: true,
  }
)

fs.writeFileSync(
  outputPath,
  JSON.stringify(result, null, 2),
  'utf-8'
)

console.log('----------------')
console.log(`共获取 ${allPois.length} 条 POI`)
console.log(`已保存：${outputPath}`)
