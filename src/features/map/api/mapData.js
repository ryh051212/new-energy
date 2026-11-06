// 五类基础数据并行请求；顺序对应边界、站点、住宅、商业、网格。
export function fetchStudyArea(read) {
  return Promise.all([
    '/api/boundary', '/api/stations', '/api/residential-pois', '/api/commercial-pois', '/api/hex-grid',
  ].map(endpoint => read(endpoint)))
}

// 全部分页成功后才交付，避免将不完整目录发布到地图。
export async function fetchFacilityCatalog(read) {
  const features = []
  let offset = 0, page
  do {
    page = await read(`/api/facility-pois?limit=10000&offset=${offset}`)
    if (page.metadata?.initialized === false) throw new Error('设施目录尚未入库')
    if (page.metadata?.coordSystem !== 'WGS84') throw new Error('设施坐标系不匹配')
    features.push(...page.features)
    offset += page.features.length
    if (page.metadata?.hasMore && (!page.features.length || offset >= 100000)) {
      throw new Error('设施分页未完整返回')
    }
  } while (page.metadata?.hasMore)
  return { type: 'FeatureCollection', features }
}
