// 请求版本保证登录、退出、过期之后，旧的会话请求不能覆盖新状态。
export function createAuthSession(client, { onChange = () => {}, onExpired = () => {},
  now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let state = { user: null, expiresAt: null, ready: false, error: '' }
  let version = 0, timer, disposed = false
  const pending = new Map()

  function publish(session, error = '') {
    if (disposed) return
    cancel(timer)
    const expires = Date.parse(session?.expiresAt)
    const valid = session?.authenticated && session.user && expires > now()
    state = { user: valid ? session.user : null, expiresAt: valid ? session.expiresAt : null, ready: true, error }
    onChange(state)
    if (valid) timer = schedule(() => invalidate(true), Math.min(expires - now(), 2 ** 31 - 1))
  }

  function invalidate(expired = false) {
    const hadUser = !!state.user
    version++
    publish(null)
    if (expired && hadUser) onExpired()
  }

  async function check(authorize = false) {
    const key = `${version}:${authorize}`
    if (pending.has(key)) return pending.get(key)
    const started = version
    const promise = (async () => {
      try {
        const session = await client[authorize ? 'authorize' : 'session']()
        if (disposed || started !== version) return false
        const wasAuthenticated = !!state.user
        publish(session)
        if (!state.user) version++
        if (wasAuthenticated && !state.user) onExpired()
        return !!state.user
      } catch (error) {
        if (disposed || started !== version) return false
        const wasAuthenticated = !!state.user
        version++
        publish(null, error.status === 401 ? '' : error.message)
        if (wasAuthenticated) onExpired()
        return false
      } finally { pending.delete(key) }
    })()
    pending.set(key, promise)
    return promise
  }

  async function authenticate(action, options) {
      const started = ++version
      const session = await action()
      if (disposed || started !== version || options?.signal?.aborted) throw new DOMException('登录已取消', 'AbortError')
      if (!session.authenticated) throw new Error('登录状态无效，请重新登录')
      version++
      publish(session)
      return session
  }
  return {
    get state() { return state },
    restore: () => check(), verify: () => check(true), invalidate,
    login: (username,password,options)=>authenticate(()=>client.login(username,password,options),options),
    quickLogin: options=>authenticate(()=>client.quickLogin(options),options),
    async logout() {
      const started = ++version
      await client.logout()
      if (!disposed && started === version) { version++; publish(null) }
    },
    dispose() { disposed = true; version++; cancel(timer); pending.clear() },
  }
}
