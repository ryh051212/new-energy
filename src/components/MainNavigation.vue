<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { navigationGroups } from '../navigation.js'
import UiIcon from './UiIcon.vue'

const props = defineProps({ route: { type: String, default: '/' } })
const opened = ref('')
const header = ref(null)
watch(() => props.route, () => { opened.value = '' })
function closeOutside(event) {
  if (!event.target?.closest?.('.nav-group')) opened.value = ''
}
function closeOnEscape(event) {
  if (event.key !== 'Escape' || !opened.value) return
  const button = header.value?.querySelector(`#nav-trigger-${opened.value}`)
  opened.value = ''
  button?.focus()
}
onMounted(() => {
  document.addEventListener('click', closeOutside)
  document.addEventListener('keydown', closeOnEscape)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeOutside)
  document.removeEventListener('keydown', closeOnEscape)
})
</script>

<template>
  <header ref="header" class="topbar site-header">
    <a class="brand" href="#/"><span class="brand-mark"><UiIcon name="car" :size="29" /></span><span class="brand-title">新能源汽车充电供需 <b>WebGIS展示</b></span></a>
    <a class="charging-entry" href="#/charging" aria-label="切换到用户端找充电站" title="切换到用户端找充电" @click="opened = ''"><UiIcon name="bolt" :size="18" /><span>用户端</span></a>
    <nav class="main-nav" aria-label="主导航">
      <a href="#/" :class="['nav-item', { active: route === '/' }]" :aria-current="route === '/' ? 'page' : undefined" @click="opened = ''"><UiIcon name="home" />首页</a>
      <div v-for="group in navigationGroups" :key="group.path" class="nav-group" @focusout="event => { if (!event.currentTarget.contains(event.relatedTarget)) opened = '' }">
        <a v-if="group.direct" :href="'#' + group.path" :class="['nav-item', { active: route === group.path }]" :aria-current="route === group.path ? 'page' : undefined" @click="opened = ''"><UiIcon :name="group.icon" />{{ group.label }}</a>
        <button v-else :id="'nav-trigger-' + group.path.slice(1)" type="button" :class="['nav-item', { active: route.startsWith(group.path + '/') }]" :aria-expanded="opened === group.path.slice(1)" :aria-controls="'nav-dropdown-' + group.path.slice(1)" @click="opened = opened === group.path.slice(1) ? '' : group.path.slice(1)">
          <UiIcon :name="group.icon" />{{ group.label }}<UiIcon name="chevron" :size="14" :class="{ 'nav-chevron-open': opened === group.path.slice(1) }" />
        </button>
        <div v-if="opened === group.path.slice(1)" :id="'nav-dropdown-' + group.path.slice(1)" class="nav-dropdown">
          <span class="nav-dropdown-caption">{{ group.label }}</span>
          <a v-for="child in group.children" :key="child.path" :href="'#' + child.path" :class="['nav-child', { active: route === child.path }]" :aria-current="route === child.path ? 'page' : undefined" @click="opened = ''">{{ child.title }}</a>
        </div>
      </div>
    </nav>
  </header>
</template>
