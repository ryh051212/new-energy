import { apiFetch } from '../../../shared/api/client.js'
import { validCoordinates } from '../../stations/models/stations.js'

/** 实验 5：API 坐标始终为 WGS84，底图显示转换交给地图调用者。 */
export async function searchPois(query, { signal, fetcher = apiFetch } = {}) {
  const response = await fetcher('/api/pois?q=' + encodeURIComponent(query.trim()), { signal })
  if (!response.ok) throw new Error(`POI 搜索失败：HTTP ${response.status}`)
  const rows = await response.json()
  signal?.throwIfAborted()
  if (!Array.isArray(rows)) throw new Error('POI 搜索结果格式不正确')
  return rows.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string'
    && row.name.trim() && row.coordSystem === 'WGS84' && validCoordinates(row.coordinates))
    .map(row => ({ type: 'Feature', geometry: { type: 'Point', coordinates: row.coordinates },
      properties: { ...row, id: row.sourceId || row.id, searchId: row.id } }))
}
