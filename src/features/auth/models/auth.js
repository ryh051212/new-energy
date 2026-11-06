import { apiFetch, ApiError } from '../../../shared/api/client.js'
import { resolveRoute } from '../../../app/navigation.js'

export const analysisPanelRoutes = {
  overview: '/planning/overview', siting: '/planning/suggestions',
  sandbox: '/planning/suggestions', grid: '/planning/grid', carbon: '/planning/carbon',
}

export function requiresLogin(path) {
  path = resolveRoute(path)
  return /^\/(?:planning|ai)(?:\/|$)/.test(path)
    || /^\/monitoring\/(?!stations(?:\/|$))/.test(path)
    || path === '/time-analysis'
}

export function avatarInitial(user) {
  return user?.username ? Array.from(user.username.trim())[0]?.toLocaleUpperCase() || '游' : '游'
}

export function createAuthClient(fetcher = globalThis.fetch) {
  async function request(path, body, options = {}) {
    let response
    try {
      response = await apiFetch(`auth/${path}`, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      }, fetcher)
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new ApiError('暂时无法连接登录服务，请稍后重试')
    }
    let data
    try { data = await response.json() } catch {
      throw new ApiError('登录服务返回异常，请稍后重试', response.status)
    }
    if (!response.ok) throw new ApiError(typeof data.detail === 'string' ? data.detail : '登录信息无效，请检查后重试', response.status)
    if (typeof data?.authenticated !== 'boolean' || (data.authenticated && (
      typeof data.user?.username !== 'string' || !data.user.username.trim() ||
      !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()
    ))) throw new ApiError('登录状态无效，请重新登录')
    return data
  }
  return {
    session: () => request('session'), authorize: () => request('authorize'),
    login: (username, password, options) => request('login', { username, password }, options),
    quickLogin: options => request('quick-login', {}, options),
    async quickLoginAvailable(){
      const response=await apiFetch('auth/quick-login/availability',{cache:'no-store'},fetcher)
      if(!response.ok)return false
      return (await response.json()).available===true
    },
    logout: () => request('logout', {}),
  }
}

