<script setup>
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({ label: { type: String, default: '图层管理' }, open: Boolean, loading: Boolean, layers: { type: Array, default: () => [] },
  facilityLoading: Boolean, facilityError: { type: String, default: '' },
  comparisonAvailable: Boolean, comparisonVisible: Boolean, fastOnly: Boolean, hasChargeTypeData: Boolean })
const emit = defineEmits(['toggle', 'close', 'toggle-layer', 'toggle-comparison', 'toggle-fast', 'retry-facilities'])
const topics = computed(() => props.layers.filter(layer => layer.thematic))
const references = computed(() => props.layers.filter(layer => !layer.thematic && layer.section !== 'facility'))
const facilities = computed(() => props.layers.filter(layer => layer.section === 'facility'))
</script>

<template>
  <div class="map-layer-control" @pointerdown.stop @click.stop @keydown.esc.stop.prevent="emit('close')">
    <button class="map-layer-trigger" :class="{ active: open }" aria-label="图层控制" :aria-expanded="open" aria-controls="map-layer-panel" @click="emit('toggle')"><UiIcon name="layers" :size="18" /><span>{{ label }}</span><UiIcon name="chevron" :size="12" /></button>
    <section v-if="open" id="map-layer-panel" class="layer-control-panel" aria-label="地图图层控制">
      <div class="layer-control-heading"><b>图层管理</b><button aria-label="关闭图层控制" @click="emit('close')"><UiIcon name="close" :size="16" /></button></div>
      <p class="layer-control-caption">网格分析专题 · 互斥显示</p>
      <div class="layer-control-grid" role="group" aria-label="供需专题图层">
        <label v-for="layer in topics" :key="layer.id" :class="{ selected: layer.visible }"><input type="checkbox" :checked="layer.visible" :disabled="loading" @change="emit('toggle-layer', { id: layer.id, visible: $event.target.checked })" /><span>{{ layer.label }}</span></label>
        <label v-if="comparisonAvailable" :class="{ selected: comparisonVisible }"><input type="checkbox" :checked="comparisonVisible" @change="emit('toggle-comparison', $event.target.checked)" /><span>方案模拟变化</span></label>
      </div>
      <p class="layer-control-caption">基础数据图层 · 可叠加显示</p>
      <div class="layer-control-grid" role="group" aria-label="参考点位图层">
        <label v-for="layer in references" :key="layer.id" :class="{ selected: layer.visible }"><input type="checkbox" :checked="layer.visible" :disabled="loading" @change="emit('toggle-layer', { id: layer.id, visible: $event.target.checked })" /><span>{{ layer.label }}</span></label>
      </div>
      <template v-if="facilities.length">
        <p class="layer-control-caption">高德设施目录 · 可叠加显示</p>
        <p v-if="facilityLoading" class="layer-control-status" role="status">正在加载设施点位…</p>
        <div v-else-if="facilityError" class="layer-control-status layer-control-error" role="alert"><span>{{ facilityError }}</span><button type="button" @click="emit('retry-facilities')">重试</button></div>
        <div class="layer-control-grid" role="group" aria-label="高德设施图层">
          <label v-for="layer in facilities" :key="layer.id" :class="{ selected: layer.visible, unavailable: layer.disabled }"><input type="checkbox" :checked="layer.visible" :disabled="facilityLoading || layer.disabled" @change="emit('toggle-layer', { id: layer.id, visible: $event.target.checked })" /><span>{{ layer.label }}</span><small class="layer-control-count" :aria-label="layer.count === null ? '数量待加载' : `${layer.count} 个点位`">{{ layer.count ?? '—' }}</small></label>
        </div>
        <p class="layer-control-note">数量为区内已采集记录，非完整名录；尚未现场核验。居住／商业需求样本与设施目录分别展示。</p>
      </template>
      <div class="layer-control-filter" role="group" aria-label="充电站类型筛选"><span>站点类型筛选</span><label><input type="checkbox" :checked="fastOnly" :disabled="!hasChargeTypeData || loading" @change="emit('toggle-fast', $event.target.checked)" />仅显示快充站点</label></div>
      <p class="layer-control-note">统计单元为六边形网格，专题随当前站点数据范围更新。</p>
    </section>
  </div>
</template>

<style scoped>
.map-layer-control{position:relative;flex:none}.map-layer-trigger{display:flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink-700);font-size:12px;box-shadow:var(--shadow-1)}.map-layer-trigger.active{color:var(--brand-600);border-color:var(--brand-200);background:var(--brand-50)}.layer-control-panel{position:absolute;top:52px;right:0;z-index:30;box-sizing:border-box;width:310px;max-width:calc(100vw - 24px);max-height:calc(100dvh - var(--header-h) - 24px);overflow:auto;padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:var(--shadow-2)}.layer-control-heading{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--ink-800)}.layer-control-heading button{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:5px;background:none;color:var(--ink-500)}.layer-control-caption{margin:10px 0 6px;font-size:11px;color:var(--ink-500)}.layer-control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.layer-control-grid label{display:flex;align-items:center;gap:6px;min-width:0;min-height:34px;padding:5px 7px;box-sizing:border-box;border:1px solid var(--line);border-radius:6px;color:var(--ink-600);font-size:11px;line-height:1.4;cursor:pointer}.layer-control-grid label.selected{border-color:var(--brand-200);background:var(--brand-50);color:var(--brand-600)}.layer-control-grid input{flex:none;margin:0;width:14px;height:14px;accent-color:var(--brand-600)}.layer-control-note{margin:9px 0 0;font-size:10px;color:var(--ink-500)}
.layer-control-grid label span{min-width:0;overflow-wrap:anywhere}.layer-control-filter{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);color:var(--ink-500);font-size:11px}.layer-control-filter label{display:flex;align-items:center;gap:6px;min-height:28px;color:var(--ink-600);cursor:pointer}.layer-control-filter input{margin:0;accent-color:var(--brand-600)}
.layer-control-count{flex:none;margin-left:auto;font-size:10px;font-variant-numeric:tabular-nums;color:var(--ink-500)}.layer-control-grid label.unavailable{opacity:.6;cursor:default}.layer-control-status{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;font-size:11px;line-height:1.5;color:var(--ink-500)}.layer-control-error{color:#b45309}.layer-control-status button{flex:none;padding:3px 8px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--brand-600);font-size:11px}
@media(max-width:760px){.map-layer-trigger{padding:0 10px;gap:5px}.layer-control-panel{position:fixed;top:110px;right:12px;width:min(320px,calc(100vw - 24px));padding:10px}.layer-control-grid{gap:4px}.layer-control-grid label{padding:6px;gap:5px;min-height:38px;font-size:11px}.layer-control-grid input{width:13px;height:13px}.layer-control-caption{margin-top:8px}}
</style>
