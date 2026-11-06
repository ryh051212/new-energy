import { apiFetch, ApiError } from '../../../shared/api/client.js'

export async function requestLocalSiting(parameters, signal, confirm = false, fetcher = apiFetch) {
  const response = await fetcher('planning/local-candidates' + (confirm ? '/confirm' : ''), {
    method:'POST', signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify(parameters),
  })
  let data
  try { data = await response.json() } catch { throw new ApiError('周边筛选服务返回异常', response.status) }
  if (!response.ok) throw new ApiError(typeof data.detail === 'string' ? data.detail : '周边筛选暂不可用', response.status)
  if (confirm ? data.geometry?.type !== 'Point' : !Array.isArray(data.features) || !data.metadata)
    throw new ApiError('周边筛选结果不完整')
  return data
}
