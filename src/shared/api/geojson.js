import { apiFetch } from './client.js'

// 统一校验与取消处理，调用者决定错误如何展示。
export async function readGeoJSON(endpoint, { signal, fetcher = apiFetch } = {}) {
  const response = await fetcher(endpoint, { signal })
  if (!response.ok) throw new Error(`${endpoint} 加载失败：HTTP ${response.status}`)
  const data = await response.json()
  signal?.throwIfAborted()
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error(`${endpoint} 返回的数据不是标准 FeatureCollection`)
  }
  return data
}
