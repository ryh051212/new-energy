export const analysisPanelRoutes = {
  map: '/', overview: '/planning/overview', siting: '/planning/candidates',
  sandbox: '/planning/problems', grid: '/planning/grid', carbon: '/planning/carbon',
}

export function requiresLogin(path) {
  return /^\/(?:planning|ai)(?:\/|$)/.test(path)
    || /^\/monitoring\/(?!stations(?:\/|$))/.test(path)
    || path === '/time-analysis'
}

export function avatarInitial(user) {
  return user?.username ? Array.from(user.username.trim())[0]?.toLocaleUpperCase() || '游' : '游'
}

export function createAuthClient(fetcher = globalThis.fetch, hostname = globalThis.location?.hostname) {
  const base = `http://${hostname === 'localhost' ? 'localhost' : '127.0.0.1'}:8000/api/auth`
  async function request(path, body) {
    let response
    try {
      response = await fetcher(`${base}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
    } catch {
      throw new Error('暂时无法连接登录服务，请稍后重试')
    }
    const data = await response.json()
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '登录信息无效，请检查后重试')
    return data
  }
  return { session: () => request('session'), login: (username, password) => request('login', { username, password }), logout: () => request('logout', {}) }
}
