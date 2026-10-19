<script setup>
import { onMounted, onBeforeUnmount, ref, computed, nextTick } from 'vue'
import MapView from './components/MapView.vue'
import MainNavigation from './components/MainNavigation.vue'
import UiIcon from './components/UiIcon.vue'
import LoginDialog from './components/LoginDialog.vue'
import { routePages, resolveRoute } from './navigation.js'
import { analysisPanelRoutes, createAuthClient, requiresLogin } from './utils/auth.js'

function currentPath() {
  return window.location.hash.slice(1) || (/^\/(?:charging|charing)(?:\/|$)/.test(window.location.pathname || '') ? window.location.pathname : '')
}
const route = ref('/')
const user = ref(null), loginOpen = ref(false), loginReason = ref(''), sessionReady = ref(false), authMessage = ref('')
const auth = createAuthClient()
let pendingAction, expiryTimer, initialSession
const utilityPages = {
  '/about': { title: '项目说明', icon: 'file', description: '本项目展示许昌市魏都区新能源汽车充电设施与供需分析。' },
  '/time-analysis': { title: '时间分析', icon: 'clock', description: '当前数据未包含历史时序，时间分析功能正在建设。' },
}
const page = computed(() => routePages[route.value] || utilityPages[route.value])
function navigate(path, replace = false) {
  route.value = path
  if (currentPath() !== path) window.history[replace ? 'replaceState' : 'pushState'](null, '', '#' + path)
}
function applySession(session) {
  user.value = session.authenticated ? session.user : null
  clearTimeout(expiryTimer)
  if (user.value && session.expiresAt) {
    expiryTimer = setTimeout(() => { user.value = null; navigate('/', true) }, Math.max(0, Date.parse(session.expiresAt) - Date.now()))
  }
}
async function restoreSession() {
  try {
    const session = await auth.session()
    applySession(session)
    if (!user.value && requiresLogin(route.value)) navigate('/', true)
  } catch { /* A disconnected login service must not block the public map. */ }
  finally { sessionReady.value = true }
}
async function requireLogin(request = {}) {
  if (!sessionReady.value && initialSession) await initialSession
  if (user.value) { request.run?.(); return }
  pendingAction = request.run
  loginReason.value = request.label || ''
  loginOpen.value = true
}
function closeLogin() {
  loginOpen.value = false
  loginReason.value = ''
  pendingAction = undefined
}
async function loggedIn(session) {
  const resume = pendingAction
  applySession(session)
  closeLogin()
  await nextTick()
  if (resume) resume()
  else navigate(analysisPanelRoutes.overview)
}
async function logout() {
  try {
    applySession(await auth.logout())
    closeLogin()
    navigate('/', true)
  } catch (error) { authMessage.value = error.message }
}
function selectPanel(panel) {
  const path = analysisPanelRoutes[panel] || '/'
  if (panel === 'map') navigate(path)
  else requireLogin({ label: routePages[path]?.title, run: () => navigate(path) })
}
function syncRoute() {
  if (!sessionReady.value) return
  const raw = currentPath()
  const next = resolveRoute(raw)
  if (next === '/login') {
    navigate('/', true)
    requireLogin()
  } else if (requiresLogin(next) && !user.value) {
    navigate('/', true)
    requireLogin({ label: routePages[next]?.title || utilityPages[next]?.title || '空间分析', run: () => navigate(next) })
  } else navigate(next, true)
}
onMounted(() => {
  initialSession = restoreSession().then(syncRoute)
  window.addEventListener('hashchange', syncRoute)
  window.addEventListener('focus', restoreSession)
})
onBeforeUnmount(() => {
  clearTimeout(expiryTimer)
  window.removeEventListener('hashchange', syncRoute)
  window.removeEventListener('focus', restoreSession)
})
</script>

<template>
  <div class="app-content" :inert="loginOpen" :aria-hidden="loginOpen ? true : undefined">
  <MapView v-if="route === '/' || page?.map" :active-route="route" :page="page" :authenticated="!!user" @require-login="requireLogin">
    <template #header="{ panel, selectPanel: selectMapPanel, plannedCount }"><MainNavigation :route="route" :active-panel="panel" :planned-count="plannedCount" :user="user" @select-panel="selectMapPanel" @login="requireLogin()" @logout="logout" /></template>
  </MapView>
  <main v-else class="placeholder-page">
    <MainNavigation :route="route" :user="user" @select-panel="selectPanel" @login="requireLogin()" @logout="logout" />
    <section class="placeholder-card" v-if="page"><span class="placeholder-icon"><UiIcon :name="page.icon" :size="34" /></span><span class="placeholder-tag">{{ page.group ? page.group + ' · 功能建设中' : '功能建设中' }}</span><h1>{{ page.title }}</h1><p>{{ page.description }}</p><a href="#/" class="primary-link">返回地图首页</a></section>
    <section class="placeholder-card" v-else><span class="placeholder-icon"><UiIcon name="info" :size="34" /></span><h1>页面未找到</h1><p>这个地址暂时没有对应页面。</p><a href="#/" class="primary-link">返回地图首页</a></section>
  </main>
  </div>
  <p v-if="authMessage" class="auth-status" role="alert">{{ authMessage }}<button aria-label="关闭提示" @click="authMessage = ''">×</button></p>
  <LoginDialog v-if="loginOpen" :reason="loginReason" :authenticate="auth.login" @close="closeLogin" @success="loggedIn" />
</template>
