<script setup>
import { computed, ref, nextTick, useId, watch, onBeforeUnmount } from 'vue'
import UiIcon from './UiIcon.vue'
import { analysisTerms } from '../utils/analysisTerms.js'

const props = defineProps({ term: { type: String, required: true }, label: String, iconOnly: Boolean })
const definition = computed(() => analysisTerms[props.term])
const label = computed(() => props.label || definition.value?.title || props.term)
const trigger = ref(null), bubble = ref(null), open = ref(false), pinned = ref(false)
const tooltipId = 'term-' + useId()
const position = ref({ left: '8px', top: '8px' })
let closeTimer

async function show() {
  clearTimeout(closeTimer)
  if (!definition.value) return
  document.dispatchEvent(new CustomEvent('analysis-term-open', { detail: tooltipId }))
  open.value = true
  await nextTick()
  if (!open.value || !trigger.value || !bubble.value) return
  const anchor = trigger.value.getBoundingClientRect(), box = bubble.value.getBoundingClientRect()
  const left = Math.max(8, Math.min(innerWidth - box.width - 8, anchor.left + anchor.width / 2 - box.width / 2))
  const top = anchor.bottom + box.height + 8 <= innerHeight - 8 ? anchor.bottom + 8 : Math.max(8, anchor.top - box.height - 8)
  position.value = { left: left + 'px', top: top + 'px' }
}
function close() { clearTimeout(closeTimer); open.value = false; pinned.value = false }
function cancelClose() { clearTimeout(closeTimer) }
function hoverShow() { if (window.matchMedia('(hover: hover)').matches) show() }
function otherTooltip(event) { if (event.detail !== tooltipId) close() }
function leave() {
  closeTimer = setTimeout(() => {
    if (!pinned.value && !trigger.value?.contains(document.activeElement)) close()
  }, 160)
}
function toggle() { if (pinned.value) close(); else { pinned.value = true; show() } }
function outside(event) { if (!trigger.value?.contains(event.target) && !bubble.value?.contains(event.target)) close() }
function keydown(event) { if (event.key === 'Escape') { event.stopPropagation(); close() } }
function scroll(event) {
  if (bubble.value?.contains(event.target) || !trigger.value) return
  const anchor = trigger.value.getBoundingClientRect()
  let upper = 0, lower = innerHeight
  for (let parent = trigger.value.parentElement; parent; parent = parent.parentElement) {
    if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue
    const rect = parent.getBoundingClientRect()
    upper = Math.max(upper, rect.top); lower = Math.min(lower, rect.bottom)
  }
  if (anchor.bottom <= upper || anchor.top >= lower) close()
  else show()
}
watch(open, value => {
  const method = value ? 'addEventListener' : 'removeEventListener'
  document[method]('pointerdown', outside)
  document[method]('keydown', keydown, true)
  document[method]('analysis-term-open', otherTooltip)
  window[method]('scroll', scroll, true)
  window[method]('resize', close)
}, { flush: 'sync' })
onBeforeUnmount(() => {
  clearTimeout(closeTimer)
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('analysis-term-open', otherTooltip)
  window.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <span ref="trigger" class="term-hint" :data-term="term" @mouseenter="hoverShow" @mouseleave="leave" @focusout="close">
    <span v-if="!iconOnly" class="term-label">{{ label }}</span>
    <button v-if="definition" type="button" class="term-trigger" :aria-label="'解释：' + label" :aria-expanded="open" :aria-describedby="open ? tooltipId : undefined" @focus="show" @click.stop="toggle"><UiIcon name="info" :size="13" /></button>
    <Teleport to="body">
      <div v-if="open && definition" :id="tooltipId" ref="bubble" role="tooltip" class="term-tooltip" :style="position" @mouseenter="cancelClose" @mouseleave="leave">
        <strong>{{ definition.title }}</strong><p>{{ definition.meaning }}</p><p v-if="definition.detail">{{ definition.detail }}</p><small v-if="definition.note">{{ definition.note }}</small>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.term-hint{display:inline-flex;align-items:center;gap:4px;max-width:100%;vertical-align:baseline;color:inherit;font:inherit}.term-label{border-bottom:1px dotted var(--ink-400,#81948d);cursor:help}.term-trigger{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ink-500,#657b72);cursor:help;line-height:1}.term-trigger:hover,.term-trigger[aria-expanded=true]{background:var(--brand-50,#e9f5ef);color:var(--brand-600,#00856a)}.term-trigger:focus-visible{outline:2px solid var(--brand-500,#00856a);outline-offset:2px}.term-tooltip{position:fixed;z-index:3000;box-sizing:border-box;width:286px;max-width:calc(100vw - 16px);padding:13px 15px;border:1px solid var(--brand-200,#bcdbce);border-radius:12px;background:var(--surface,#fff);color:var(--ink-700,#344c41);box-shadow:0 8px 28px #193b2926;text-align:left;font-weight:400;line-height:1.7;overflow-wrap:anywhere}.term-tooltip strong{font-size:13px;color:var(--brand-700,#006e58)}.term-tooltip p{font-size:12px;margin:7px 0}.term-tooltip small{display:block;padding-top:8px;margin-top:8px;border-top:1px solid var(--line,#e0eae4);font-size:11px;color:var(--ink-500,#657b72)}
@media(pointer:coarse){.term-trigger{width:28px;height:28px}}
</style>
