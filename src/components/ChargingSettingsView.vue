<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import UiIcon from './UiIcon.vue'
import ChargingSettingsForm from './ChargingSettingsForm.vue'
import { normalizeChargingPoint } from '../utils/charging.js'
import { readChargingSettings, saveChargingSettings } from '../utils/chargingSettings.js'
const settings = readChargingSettings()
const places = ref([])
const loadNotice = ref('')
const error = ref(settings.error)
const saving = ref(false)
const controller = new AbortController()
let disposed = false
function save(input) {
  saving.value = true
  const result = saveChargingSettings(input)
  saving.value = false
  if (!result.ok) { error.value = result.error; return }
  error.value = ''; window.location.hash = '/charging'
}
onMounted(async () => {
  const results = await Promise.allSettled(['residential-pois.json', 'commercial-pois.json'].map(async file => {
    const response = await fetch(`${import.meta.env.BASE_URL}geojson/${file}`, { signal: controller.signal })
    if (!response.ok) throw new Error('POI unavailable')
    const data = await response.json()
    return (data.features || []).map(normalizeChargingPoint)
  }))
  if (disposed) return
  places.value = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  if (results.some(result => result.status === 'rejected')) loadNotice.value = '部分地点数据暂未加载，可使用地图选点。'
})
onBeforeUnmount(() => { disposed = true; controller.abort() })
</script>
<template>
  <main class="charging-settings-page" aria-label="车辆与出行设置页面">
    <header class="settings-page-header"><a href="#/charging" aria-label="返回车主端"><UiIcon name="chevron" :size="20" /></a><div><small>车主端</small><h1>充电设置</h1></div><span><UiIcon name="settings" :size="18" />自动记住你的选择</span></header>
    <div class="settings-page-content">
      <div class="settings-intro"><p>快速补能、目的地补能、成本优先，共用以下设置。</p></div>
      <p v-if="error" class="settings-page-error" role="alert">{{ error }}</p><p v-if="loadNotice" class="settings-load-notice" role="status">{{ loadNotice }}</p>
      <ChargingSettingsForm :context="settings.profile" :intent="settings.intent" :destination-info="settings.destinationInfo" :places="places" @save="save" />
      <p class="settings-storage-note">设置保存在当前浏览器，换设备或清除网站数据后需重新填写。</p>
    </div>
    <footer class="settings-page-footer"><a href="#/charging">返回地图</a><button type="submit" form="charging-settings-form" :disabled="saving">{{ saving ? '正在保存…' : '保存并返回' }}<UiIcon name="chevron" :size="16" /></button></footer>
  </main>
</template>
<style scoped>
.charging-settings-page{min-height:100dvh;background:var(--surface-muted);color:var(--ink-900);padding-bottom:108px}.settings-page-header{display:flex;align-items:center;gap:16px;padding:22px max(24px,calc((100vw - 760px)/2));border-bottom:1px solid var(--line);background:var(--surface)}.settings-page-header>a{display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--line);border-radius:12px;color:var(--ink-600);flex:none}.settings-page-header>a svg{transform:rotate(90deg)}.settings-page-header>div{flex:1}.settings-page-header small{font-size:11px;color:var(--ink-500)}h1{font-size:23px;letter-spacing:-.5px;margin:4px 0 0}.settings-page-header>span{display:flex;gap:7px;align-items:center;color:var(--ok-600);font-size:12px;white-space:nowrap}.settings-page-content{width:min(760px,calc(100% - 48px));margin:22px auto 0}.settings-intro{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:18px}.settings-intro b{font-size:16px}.settings-intro p{font-size:13px;color:var(--ink-500);line-height:1.8;max-width:650px;margin:0}.settings-intro>small{font-size:11px;color:var(--ink-500);white-space:nowrap;padding-top:4px}.settings-page-error{font-size:13px;padding:14px;color:#b91c1c;background:#fef2f2;border-radius:10px;line-height:1.7}.settings-load-notice,.settings-storage-note{font-size:12px;line-height:1.8;color:var(--ink-500)}.settings-storage-note{margin:20px 0}.settings-page-footer{position:fixed;bottom:0;left:0;right:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:17px max(24px,calc((100vw - 760px)/2));padding-bottom:max(17px,env(safe-area-inset-bottom));background:rgba(255,255,255,.97);border-top:1px solid var(--line);box-shadow:0 -3px 14px rgba(15,43,80,.04)}.settings-page-footer>a{font-size:13px;color:var(--ink-500)}.settings-page-footer button{display:flex;align-items:center;gap:15px;border:0;background:var(--ok-600);border-radius:10px;padding:13px 20px;font-size:13px;font-weight:600;color:white}.settings-page-footer button svg{transform:rotate(-90deg)}.settings-page-footer button:disabled{opacity:.5}.settings-page-footer button:focus-visible,.settings-page-header>a:focus-visible{outline:2px solid var(--ok-500);outline-offset:3px}
@media(max-width:760px){.settings-page-header{padding:17px 16px;gap:10px}.settings-page-header>span{display:none}h1{font-size:20px}.settings-page-content{width:calc(100% - 28px);margin-top:20px}.settings-intro{display:block}.settings-intro>small{display:block;margin-top:12px}.settings-page-footer{padding:14px 16px;padding-bottom:max(14px,env(safe-area-inset-bottom))}}
</style>
