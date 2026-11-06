import test from 'node:test'
import assert from 'node:assert/strict'
import { apiUrl, apiFetch, ApiError } from '../../src/shared/api/client.js'
import { createAuthClient, requiresLogin } from '../../src/features/auth/models/auth.js'
import { createAuthSession } from '../../src/features/auth/models/authSession.js'
import { resolveRoute } from '../../src/app/navigation.js'

const member = () => ({ authenticated: true, user: { username: 'planner' }, expiresAt: new Date(Date.now() + 60000).toISOString() })
const guest = { authenticated: false, user: null, expiresAt: null }
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function sessionFixture(client) {
  const timers = new Map(), changes = [], expired = []
  const session = createAuthSession(client, { onChange: state => changes.push(state), onExpired: () => expired.push(true),
    schedule: (callback, delay) => { const id = Symbol(); timers.set(id, { callback, delay }); return id }, cancel: id => timers.delete(id) })
  return { session, timers, changes, expired }
}

test('路由别名、查询参数、尾斜线都经过同一认证判断，外部地址不能成为回跳地址', () => {
  for (const path of ['/', '/planning', '/planning/carbon/?x=1', '/forecast', '/ai/', '/monitoring/demand/', '/time-analysis', '/%70lanning/grid']) assert.equal(requiresLogin(path), true, path)
  for (const path of ['/monitoring/stations', '/charging', '/about']) assert.equal(requiresLogin(path), false, path)
  for (const path of ['https://other.example', '//other.example', '/\\other.example', '/%ZZ']) assert.equal(resolveRoute(path), '/')
})

test('统一 API 地址默认同源，支持独立部署地址，始终携带 Cookie', async () => {
  assert.equal(apiUrl('/api/stations'), '/api/stations')
  assert.equal(apiUrl('auth/session', 'https://api.example/api/'), 'https://api.example/api/auth/session')
  assert.equal(apiUrl('/api/hex-grid', 'https://api.example/'), 'https://api.example/api/hex-grid')
  let request
  await apiFetch('stations', { credentials: 'omit' }, async (url, options) => { request = { url, options }; return response({}) })
  assert.equal(request.url, '/api/stations')
  assert.equal(request.options.credentials, 'include')
})

test('登录使用 POST JSON 和同源路径，不把密码放入 URL；服务端错误保留状态码', async () => {
  let request
  const client = createAuthClient(async (url, options) => { request = { url, options }; return response(member()) })
  await client.login('planner', 'test-password')
  assert.equal(request.url, '/api/auth/login')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), { username: 'planner', password: 'test-password' })
  assert.equal(request.options.credentials, 'include')
  await assert.rejects(createAuthClient(async () => response({ detail: '会话无效' }, 401)).authorize(), error => error instanceof ApiError && error.status === 401 && error.message === '会话无效')
})

test('离线、非 JSON 响应、伪造和过期会话不能变成已登录状态', async () => {
  for (const fetcher of [async () => { throw new TypeError('offline') }, async () => ({ ok: true, status: 200, json() { throw new Error('html') } }),
    async () => response({ authenticated: true, user: null }), async () => response({ ...member(), expiresAt: new Date(0).toISOString() })]) {
    await assert.rejects(createAuthClient(fetcher).session(), ApiError)
  }
  assert.deepEqual(await createAuthClient(async () => response(guest)).session(), guest)
})

test('被取消的登录不会继续更新 UI', async () => {
  const controller = new AbortController()
  const client = createAuthClient(async (_url, options) => {
    controller.abort()
    throw options.signal.reason
  })
  await assert.rejects(client.login('planner', 'test-password', { signal: controller.signal }), error => error.name === 'AbortError')
})

test('恢复会话的迟到响应不能覆盖刚完成的登录', async () => {
  const delayed = deferred()
  const { session } = sessionFixture({ session: () => delayed.promise, login: async () => member() })
  const restoring = session.restore()
  await session.login('planner', 'test-password')
  delayed.resolve(guest)
  await restoring
  assert.equal(session.state.user.username, 'planner')
  session.dispose()
})

test('退出期间启动的恢复请求不能在退出后重新登录', async () => {
  const delayed = deferred(), logout = deferred()
  const { session } = sessionFixture({ login: async () => member(), logout: () => logout.promise, session: () => delayed.promise })
  await session.login('planner', 'test-password')
  const leaving = session.logout()
  const restoring = session.restore()
  logout.resolve(guest)
  await leaving
  delayed.resolve(member())
  await restoring
  assert.equal(session.state.user, null)
  session.dispose()
})

test('退出完成后，迟到的登录响应不能恢复用户', async () => {
  const delayed = deferred()
  const { session } = sessionFixture({ login: () => delayed.promise, logout: async () => guest })
  const loggingIn = session.login('planner', 'test-password')
  const result = assert.rejects(loggingIn, error => error.name === 'AbortError')
  await session.logout()
  delayed.resolve(member())
  await result
  assert.equal(session.state.user, null)
})

test('并发校验合并一次请求，401、网络失败和到期都会撤销访问，卸载取消定时器', async () => {
  const delayed = deferred()
  let calls = 0
  const fixture = sessionFixture({ login: async () => member(), authorize: () => { calls++; return delayed.promise } })
  await fixture.session.login('planner', 'test-password')
  assert.equal(fixture.timers.size, 1)
  const first = fixture.session.verify(), second = fixture.session.verify()
  assert.equal(calls, 1)
  delayed.reject(new ApiError('已过期', 401))
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  assert.equal(fixture.session.state.user, null)
  assert.equal(fixture.expired.length, 1)
  assert.equal(fixture.timers.size, 0)
  await fixture.session.login('planner', 'test-password')
  fixture.timers.values().next().value.callback()
  assert.equal(fixture.session.state.user, null)
  await fixture.session.login('planner', 'test-password')
  fixture.session.dispose()
  assert.equal(fixture.timers.size, 0)
  const disconnected = sessionFixture({ login: async () => member(), session: async () => { throw new ApiError('连接失败') } })
  await disconnected.session.login('planner', 'test-password')
  await disconnected.session.restore()
  assert.equal(disconnected.session.state.user, null)
  assert.equal(disconnected.session.state.error, '连接失败')
  disconnected.session.dispose()
})
