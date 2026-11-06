<script setup>
import { onMounted, onBeforeUnmount, ref, computed, nextTick, watch } from 'vue'
import FeedbackHost from './shared/components/FeedbackHost.vue'
import { showError, showToast } from './shared/feedback/feedback.js'
import MapView from './features/map/MapView.vue'
import MainNavigation from './shared/layout/MainNavigation.vue'
import UiIcon from './shared/components/UiIcon.vue'
import LoginDialog from './features/auth/components/LoginDialog.vue'
import { routePages, resolveRoute } from './app/navigation.js'
import { analysisPanelRoutes, createAuthClient, requiresLogin } from './features/auth/models/auth.js'
import { createAuthSession } from './features/auth/models/authSession.js'

function currentPath() {
  return window.location.hash.slice(1) || window.location.pathname || '/'
}
const route = ref('/monitoring/stations')
const user = ref(null), loginOpen = ref(false), loginReason = ref(''), sessionReady = ref(false), authMessage = ref('')
watch(authMessage,message=>{if(message)showError(message,'账号提示')})
let pendingAction, initialSession, heartbeat, navigationVersion = 0, active = true
const AUTH_SYNC_KEY = 'weidu-auth-change'
const authClient=createAuthClient(),quickLoginEnabled=ref(false)
const auth = createAuthSession(authClient, {
  onChange(session) {
    user.value = session.user
    sessionReady.value = session.ready
    authMessage.value = session.error
  },
  onExpired: sessionExpired,
})
const utilityPages = {
  '/about': { title: '项目说明', icon: 'file', description: '本项目展示许昌市魏都区新能源汽车充电设施与供需分析。' },
  '/time-analysis': { title: '时间分析', icon: 'clock', description: '当前数据未包含历史时序，时间分析功能正在建设。' },
}
const page = computed(() => routePages[route.value] || utilityPages[route.value])
function navigate(path, replace = false) {
  route.value = path
  if (currentPath() !== path) window.history[replace ? 'replaceState' : 'pushState'](null, '', import.meta.env.BASE_URL + '#' + path)
}
function broadcast(type) {
  try { localStorage.setItem(AUTH_SYNC_KEY, JSON.stringify({ type, at: Date.now(), nonce: Math.random() })) } catch { /* 会话不依赖本地存储权限。 */ }
}
function sessionExpired() {
  const destination = route.value
  navigate('/monitoring/stations', true)
  if (requiresLogin(destination)) {
    pendingAction = { path: destination }
    loginReason.value = routePages[destination]?.title || '空间分析'
    loginOpen.value = true
  }
  authMessage.value = '登录已失效，请重新登录'
}
async function requireLogin(request = {}) {
  const requestVersion = ++navigationVersion
  if (!sessionReady.value && initialSession) await initialSession
  if (user.value && await auth.verify()) {
    if (active && requestVersion === navigationVersion) {
      if (request.path) navigate(request.path)
      await nextTick()
      if (active && requestVersion === navigationVersion) request.run?.()
    }
    return
  }
  if (!active || requestVersion !== navigationVersion) return
  pendingAction = request
  loginReason.value = request.label || ''
  loginOpen.value = true
}
function closeLogin() {
  loginOpen.value = false
  loginReason.value = ''
  pendingAction = undefined
}
async function loggedIn() {
  const resume = pendingAction
  closeLogin()
  showToast('登录成功，欢迎回来')
  navigationVersion++
  navigate(resume?.path || analysisPanelRoutes.overview)
  await nextTick()
  if (active) resume?.run?.()
  broadcast('login')
}
async function logout() {
  navigationVersion++
  try {
    await auth.logout()
    if (!active) return
    closeLogin()
    navigate('/monitoring/stations', true)
    broadcast('logout')
  } catch (error) { authMessage.value = error.message }
}
function selectPanel(panel) {
  const path = analysisPanelRoutes[panel] || analysisPanelRoutes.overview
  guardRoute(path)
}
async function guardRoute(path, replace = false) {
  const requestVersion = ++navigationVersion
  const next = resolveRoute(path)
  if (!sessionReady.value && initialSession) await initialSession
  if (!active || requestVersion !== navigationVersion) return
  if (next === '/login') {
    navigate('/monitoring/stations', true)
    requireLogin()
    return
  }
  if (requiresLogin(next)) {
    const allowed = await auth.verify()
    if (!active || requestVersion !== navigationVersion) return
    if (allowed) { closeLogin(); navigate(next, replace); return }
    navigate('/monitoring/stations', true)
    pendingAction = { path: next }
    loginReason.value = routePages[next]?.title || utilityPages[next]?.title || '空间分析'
    loginOpen.value = true
    return
  }
  closeLogin()
  navigate(next, replace)
}
function syncRoute() { return guardRoute(currentPath(), true) }
function restoreSession() { return auth.restore() }
function unauthorized() { auth.invalidate(true) }
function visible() { if (document.visibilityState === 'visible') restoreSession() }
async function syncSession(event) {
  if (event.key !== AUTH_SYNC_KEY || !event.newValue) return
  let message
  try { message = JSON.parse(event.newValue) } catch { return }
  if (message.type === 'logout') {
    navigationVersion++
    auth.invalidate()
    closeLogin()
    navigate('/monitoring/stations', true)
  } else if (message.type === 'login') {
    await restoreSession()
    if (user.value && loginOpen.value) loggedIn()
  }
}
onMounted(() => {
  authClient.quickLoginAvailable().then(available=>{if(active)quickLoginEnabled.value=available}).catch(()=>{})
  initialSession = restoreSession().then(syncRoute)
  window.addEventListener('hashchange', syncRoute)
  window.addEventListener('focus', restoreSession)
  window.addEventListener('storage', syncSession)
  window.addEventListener('weidu:unauthorized', unauthorized)
  document.addEventListener('visibilitychange', visible)
  heartbeat = setInterval(() => { if (user.value) visible() }, 60000)
})
onBeforeUnmount(() => {
  active = false
  navigationVersion++
  clearInterval(heartbeat)
  auth.dispose()
  window.removeEventListener('hashchange', syncRoute)
  window.removeEventListener('focus', restoreSession)
  window.removeEventListener('storage', syncSession)
  window.removeEventListener('weidu:unauthorized', unauthorized)
  document.removeEventListener('visibilitychange', visible)
})
</script>

<template>
  <div class="app-content" :inert="loginOpen" :aria-hidden="loginOpen ? true : undefined">
  <MapView v-if="page?.map" :active-route="route" :page="page" :authenticated="!!user" @require-login="requireLogin" @select-panel="selectPanel">
    <template #header="{ panel, plannedCount }"><MainNavigation :route="route" :active-panel="panel" :planned-count="plannedCount" :user="user" @select-panel="selectPanel" @login="requireLogin()" @logout="logout" /></template>
  </MapView>
  <main v-else class="placeholder-page">
    <MainNavigation :route="route" :user="user" @select-panel="selectPanel" @login="requireLogin()" @logout="logout" />
    <section class="placeholder-card" v-if="page"><span class="placeholder-icon"><UiIcon :name="page.icon" :size="34" /></span><span class="placeholder-tag">{{ page.group ? page.group + ' · 功能建设中' : '功能建设中' }}</span><h1>{{ page.title }}</h1><p>{{ page.description }}</p><a href="#/planning/overview" class="primary-link">返回空间供需</a></section>
    <section class="placeholder-card" v-else><span class="placeholder-icon"><UiIcon name="info" :size="34" /></span><h1>页面未找到</h1><p>这个地址暂时没有对应页面。</p><a href="#/planning/overview" class="primary-link">返回空间供需</a></section>
  </main>
  </div>
  <FeedbackHost />
  <LoginDialog v-if="loginOpen" :reason="loginReason" :authenticate="auth.login" :quick-authenticate="quickLoginEnabled ? auth.quickLogin : undefined" @close="closeLogin" @success="loggedIn" />
</template>
