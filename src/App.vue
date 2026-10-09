<script setup>
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import MapView from './components/MapView.vue'
import ChargingView from './components/ChargingView.vue'
import ChargingDemoView from './components/ChargingDemoView.vue'
import ChargingSettingsView from './components/ChargingSettingsView.vue'
import MainNavigation from './components/MainNavigation.vue'
import UiIcon from './components/UiIcon.vue'
import { chargingDemo, routePages, resolveRoute } from './navigation.js'

const route = ref(resolveRoute(window.location.hash.slice(1)))
const utilityPages = {
  '/about': { title: '项目说明', icon: 'file', description: '本项目展示许昌市魏都区新能源汽车充电设施与供需分析。' },
  '/login': { title: '登录', icon: 'user', description: '账号系统正在建设。' },
  '/time-analysis': { title: '时间分析', icon: 'clock', description: '当前数据未包含历史时序，时间分析功能正在建设。' },
}
const page = computed(() => routePages[route.value] || utilityPages[route.value])
function syncRoute() {
  const raw = window.location.hash.slice(1)
  route.value = resolveRoute(raw)
  if (raw && raw !== route.value) window.history.replaceState(null, '', '#' + route.value)
}
syncRoute()
onMounted(() => window.addEventListener('hashchange', syncRoute))
onBeforeUnmount(() => window.removeEventListener('hashchange', syncRoute))
</script>

<template>
  <ChargingView v-if="route === '/charging'" />
  <ChargingSettingsView v-else-if="route === '/charging/settings'" />
  <ChargingDemoView v-else-if="route === chargingDemo.path" />
  <MapView v-else-if="route === '/' || page?.map" :active-route="route" :page="page">
    <template #header><MainNavigation :route="route" /></template>
  </MapView>
  <main v-else class="placeholder-page">
    <MainNavigation :route="route" />
    <section class="placeholder-card" v-if="page"><span class="placeholder-icon"><UiIcon :name="page.icon" :size="34" /></span><span class="placeholder-tag">{{ page.group ? page.group + ' · 功能建设中' : '功能建设中' }}</span><h1>{{ page.title }}</h1><p>{{ page.description }}</p><a href="#/" class="primary-link">返回地图首页</a></section>
    <section class="placeholder-card" v-else><span class="placeholder-icon"><UiIcon name="info" :size="34" /></span><h1>页面未找到</h1><p>这个地址暂时没有对应页面。</p><a href="#/" class="primary-link">返回地图首页</a></section>
  </main>
</template>
