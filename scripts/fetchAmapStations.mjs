import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

dotenv.config({
  path: '.env.local',
})

const key = process.env.AMAP_KEY

if (!key) {
  throw new Error('没有找到 AMAP_KEY')
}

const outputPath = path.resolve(
  'data/raw/amap-stations.json'
)

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
    const response = await fetch(url)
    const data = await response.json()

    if (data.status === '1') {
      return data
    }

    if (
      data.infocode !== '10021' ||
      attempt === maxRetries
    ) {
      console.error(data)
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
    break
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
  path.dirname(outputPath),
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