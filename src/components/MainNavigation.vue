<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import UiIcon from './UiIcon.vue'
import { avatarInitial } from '../utils/auth.js'

const props = defineProps({ route: { type: String, default: '/' }, activePanel: { type: String, default: '' }, plannedCount: { type:Number,default:0 }, user: { type: Object, default: null } })
const emit = defineEmits(['select-panel', 'login', 'logout'])
const menuOpen = ref(false)
const accountOpen = ref(false)
const initial = computed(() => avatarInitial(props.user))
function selectPanel(event, panel) {
  event.preventDefault()
  emit('select-panel', panel)
  menuOpen.value = false
  accountOpen.value = false
}
const header = ref(null)
watch(() => props.route, () => { menuOpen.value = false })
function closeOutside(event) {
  if (!event.target?.closest?.('.explorer-navigation')) menuOpen.value = false
  if (!event.target?.closest?.('.account-control')) accountOpen.value = false
}
function closeOnEscape(event) {
  if (event.key !== 'Escape') return
  if (accountOpen.value) {
    accountOpen.value = false
    header.value?.querySelector('.account-trigger')?.focus()
  }
  if (!menuOpen.value) return
  menuOpen.value = false
  header.value?.querySelector('.explorer-menu-toggle')?.focus()
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
    <a class="brand" href="#/" @click="selectPanel($event, 'map')">
      <span class="brand-mark">
        <!-- 品牌标记：六边形网格 + 闪电，对应「网格化空间分析」的产品内核 -->
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2.3 20.5 7.15v9.7L12 21.7 3.5 16.85v-9.7L12 2.3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" opacity=".9" />
          <path d="M13.7 6.2 8.1 13.1h3.15l-.85 5 5.65-7.1h-3.25l.9-4.8Z" fill="currentColor" />
        </svg>
      </span>
      <span class="brand-title">桩连智图 <span class="brand-badge">规划端</span><small>许昌市魏都区 · 充电设施空间规划</small></span>
    </a>
    <nav class="planner-nav" aria-label="规划工作台">
      <a id="analysis-map-tab" href="#/" :class="{ active: activePanel === 'map' }" :aria-current="activePanel === 'map' ? 'page' : undefined" @click="selectPanel($event, 'map')"><UiIcon name="pin" :size="16" />地图浏览</a>
      <a id="analysis-overview-tab" href="#/planning/overview" :class="{ active: activePanel === 'overview' }" :aria-current="activePanel === 'overview' ? 'page' : undefined" @click="selectPanel($event, 'overview')"><UiIcon name="layers" :size="16" />空间供需<UiIcon v-if="!user" class="nav-lock" name="lock" :size="11" /></a>
      <a id="analysis-siting-tab" href="#/planning/candidates" :class="{ active: activePanel === 'siting' }" :aria-current="activePanel === 'siting' ? 'page' : undefined" @click="selectPanel($event, 'siting')"><UiIcon name="compass" :size="16" />约束选址<UiIcon v-if="!user" class="nav-lock" name="lock" :size="11" /></a>
      <a id="analysis-sandbox-tab" href="#/planning/problems" :class="{ active: activePanel === 'sandbox' }" :aria-current="activePanel === 'sandbox' ? 'page' : undefined" @click="selectPanel($event, 'sandbox')"><UiIcon name="chart" :size="16" />方案推演<UiIcon v-if="!user" class="nav-lock" name="lock" :size="11" /></a>
      <a id="analysis-grid-tab" href="#/planning/grid" :class="{ active: activePanel === 'grid' }" :aria-current="activePanel === 'grid' ? 'page' : undefined" @click="selectPanel($event, 'grid')"><UiIcon name="bolt" :size="16" />车网协同<UiIcon v-if="!user" class="nav-lock" name="lock" :size="11" /></a>
      <a id="analysis-carbon-tab" href="#/planning/carbon" :class="{ active: activePanel === 'carbon' }" :aria-current="activePanel === 'carbon' ? 'page' : undefined" @click="selectPanel($event, 'carbon')"><UiIcon name="leaf" :size="16" />双碳评估<UiIcon v-if="!user" class="nav-lock" name="lock" :size="11" /></a>
    </nav>
    <div class="planner-header-tools">
    <span class="planner-header-note"><i class="header-status-dot" aria-hidden="true"></i><UiIcon name="pin" :size="13" />{{ plannedCount ? '方案新增 ' + plannedCount + ' 站' : '魏都区研究范围' }}</span>
    <div class="header-actions">
    <div class="explorer-navigation">
    <button class="explorer-menu-toggle" aria-label="使用说明" :aria-expanded="menuOpen" aria-controls="planner-help" @click="menuOpen = !menuOpen"><UiIcon name="info" :size="18" /></button>
    <section v-if="menuOpen" id="planner-help" class="planner-help" aria-label="规划操作说明">
      <b>从现状到方案</b>
      <ol><li>空间供需查看现状与间距参考圈。</li><li>约束选址调整权重，核查泊位与配网，再纳入候选。</li><li>方案推演编辑站点，分析服务变化、洛伦兹曲线与投资情景。</li><li>车网协同比较 24 小时负荷与光储调节。</li></ol>
      <p>图层与专题集中在地图左上角。详细分区、统计图和模拟设置可展开查看。</p>
      <p>候选区域是初步线索；模拟结果不替代现场与配电条件核查。</p>
    </section>
    </div>
    <div class="account-control">
      <button class="account-trigger" :aria-label="user ? '用户菜单：' + user.username : '游客，点击登录'" :aria-expanded="user ? accountOpen : undefined" :aria-controls="user ? 'account-menu' : undefined" @click="user ? (accountOpen = !accountOpen, menuOpen = false) : emit('login')">
        <span class="account-avatar" :class="{ 'is-member': user }">{{ initial }}</span><span class="account-copy"><span>{{ user?.username || '游客' }}</span><small>{{ user ? '已登录' : '点击登录' }}</small></span><UiIcon v-if="user" name="chevron" :size="13" />
      </button>
      <section v-if="user && accountOpen" id="account-menu" class="account-menu" aria-label="用户菜单">
        <div class="account-menu-heading"><span class="account-avatar is-member">{{ initial }}</span><span><b>{{ user.username }}</b><small>已登录 · 规划功能已解锁</small></span></div>
        <button @click="accountOpen = false; emit('logout')"><UiIcon name="logout" :size="17" />退出登录</button>
      </section>
    </div>
    </div>
    </div>
  </header>
</template>
