<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({ active: Boolean, modelValue: { type: String, default: 'layout' } })
const emit = defineEmits(['update:modelValue'])
const pages = [
  { id: 'layout', title: '选址与布局规划' },
  { id: 'effects', title: '新增效果' },
]
const viewport = ref(null)
const offset = ref(0)
const dragging = ref(false)
const index = computed(() => Math.max(0, pages.findIndex(page => page.id === props.modelValue)))
const trackStyle = computed(() => ({ transform: `translateX(calc(${-index.value * 100}% + ${offset.value}px))` }))
let gesture = null

function turn(next) {
  if (next >= 0 && next < pages.length) emit('update:modelValue', pages[next].id)
}
function start(event) {
  if (!props.active || !event.isPrimary || event.button !== 0 ||
      event.target.closest('button, input, select, textarea, a, summary, [contenteditable], [role="slider"], .road-table')) return
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY }
}
function move(event) {
  if (!gesture || gesture.id !== event.pointerId) return
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
  if (!dragging.value) {
    if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return }
    if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return
    dragging.value = true
    viewport.value.setPointerCapture(event.pointerId)
  }
  event.preventDefault()
  const atEdge = index.value === 0 && dx > 0 || index.value === pages.length - 1 && dx < 0
  const width = viewport.value.clientWidth
  offset.value = Math.max(-width, Math.min(width, atEdge ? dx * .2 : dx))
}
function reset() {
  const id = gesture?.id
  gesture = null
  dragging.value = false
  offset.value = 0
  if (id != null && viewport.value?.hasPointerCapture(id)) viewport.value.releasePointerCapture(id)
}
function end(event) {
  if (!gesture || gesture.id !== event.pointerId) return
  const threshold = Math.min(70, viewport.value.clientWidth * .2)
  if (dragging.value && Math.abs(offset.value) >= threshold) turn(index.value + (offset.value < 0 ? 1 : -1))
  reset()
}
function keyboard(event) {
  if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  turn(index.value + (event.key === 'ArrowRight' ? 1 : -1))
}
watch(() => props.active, reset)
watch(index, async (next, previous) => {
  const outgoing = viewport.value?.querySelector(`[data-page="${pages[previous].id}"]`)
  const moveFocus = outgoing?.contains(document.activeElement)
  reset()
  if (moveFocus) {
    await nextTick()
    viewport.value?.querySelector(`[data-page="${pages[next].id}"]`)?.focus({ preventScroll: true })
  }
})
</script>

<template>
  <section v-show="active" class="planning-pages" aria-label="布局规划翻页" aria-roledescription="轮播">
    <div ref="viewport" class="planning-page-viewport" tabindex="0" aria-label="左右滑动切换规划页面，或使用左右方向键"
      @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="reset" @lostpointercapture="reset"
      @keydown="keyboard" @click.capture="dragging && $event.stopPropagation()" @dragstart.prevent>
      <div class="planning-page-track" :class="{ dragging }" :style="trackStyle">
        <section v-for="(page, i) in pages" :key="page.id" :data-page="page.id" class="planning-page"
          :aria-label="page.title" aria-roledescription="页面" :aria-hidden="index !== i" :inert="index !== i" tabindex="-1">
          <slot :name="page.id" />
        </section>
      </div>
    </div>
    <div v-if="$slots.action" class="planning-page-action"><slot name="action" :page="pages[index].id" /></div>
    <footer class="planning-page-footer">
      <button type="button" aria-label="向左切换至选址与布局规划" title="选址与布局规划" :disabled="index === 0" @click="turn(index - 1)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" /></svg>
      </button>
      <div class="planning-page-position" aria-live="polite" aria-atomic="true">
        <span>{{ pages[index].title }} · {{ index + 1 }} / {{ pages.length }}</span>
        <span class="planning-page-dots" aria-hidden="true"><i v-for="(page, i) in pages" :key="page.id" :class="{ current: index === i }"></i></span>
      </div>
      <button type="button" aria-label="向右切换至新增效果" title="新增效果" :disabled="index === pages.length - 1" @click="turn(index + 1)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
      </button>
    </footer>
  </section>
</template>

<style scoped>
.planning-pages{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%;overflow:hidden}
.planning-page-viewport{flex:1;min-height:0;overflow:hidden;touch-action:pan-y pinch-zoom;outline-offset:-2px}
.planning-page-track{display:flex;width:100%;height:100%;transition:transform .34s cubic-bezier(.22,1,.36,1)}
.planning-page-track.dragging{transition:none;user-select:none;cursor:grabbing}
.planning-page-action{flex:none;background:var(--surface,#fff)}
.planning-page-action:empty{display:none}
.planning-page{flex:0 0 100%;min-width:0;height:100%;box-sizing:border-box;padding:18px 20px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent;outline-offset:-2px}
.planning-page-footer{display:flex;align-items:center;justify-content:space-between;flex:none;gap:8px;padding:10px 14px;border-top:1px solid var(--line);background:var(--surface,#fff)}
.planning-page-footer button{display:grid;place-items:center;flex:none;width:36px;height:36px;padding:8px;border:0;border-radius:7px;background:transparent;color:var(--brand-600);cursor:pointer}
.planning-page-footer button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.planning-page-footer button:hover:enabled{background:var(--brand-50)}
.planning-page-footer button:disabled{opacity:.35;cursor:default}
.planning-page-position{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;color:var(--ink-500);font-size:10px;text-align:center}
.planning-page-dots{display:flex;gap:5px}
.planning-page-dots i{width:5px;height:5px;border-radius:5px;background:var(--line-strong);transition:width .2s,background .2s}
.planning-page-dots i.current{width:16px;background:var(--brand-600)}
.planning-page :deep(.road-study){margin:0;padding:0;border:0;box-shadow:none;background:transparent}
@media(max-width:760px){.planning-page{padding:14px}.planning-page-footer{padding:6px 8px;gap:4px}}
@media(prefers-reduced-motion:reduce){.planning-page-track,.planning-page-dots i{transition:none}}
</style>
