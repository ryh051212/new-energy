import { apiFetch, ApiError } from '../../../shared/api/client.js'

export async function requestRoadPlanning(operation, parameters, signal, fetcher = apiFetch) {
  const response = await fetcher('planning/' + operation, { method:'POST', signal,
    headers:{'Content-Type':'application/json'}, body:JSON.stringify(parameters) })
  if (response.status === 404) throw new ApiError('规划分析接口尚未加载，请重启后端服务后重试', 404)
  let data
  try { data = await response.json() } catch { throw new ApiError('规划服务返回异常', response.status) }
  if (!response.ok) throw new ApiError(typeof data.detail === 'string' ? data.detail : '规划参数无效或服务暂不可用', response.status)
  if (operation === 'experiments' ? !Array.isArray(data.rows) : !data.grids?.features || !data.before || !data.after) throw new ApiError('规划结果不完整')
  return data
}

// One owner per component: parameter edits and unmount both cancel stale responses.
export function createPlanningRequests(request = requestRoadPlanning) {
  let controller, revision = 0
  return {
    cancel() { revision++; controller?.abort() },
    async run(operation, parameters) {
      controller?.abort()
      controller = new AbortController()
      const current = ++revision
      const data = await request(operation, parameters, controller.signal)
      return current === revision && !controller.signal.aborted ? data : null
    },
  }
}
