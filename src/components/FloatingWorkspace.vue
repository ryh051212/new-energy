<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import { WORKSPACE_LAYOUT_KEY, workspaceContextKey, clampPanelRect, coupledPanelRects, defaultPanelRect, normalizePanelRect, readWorkspaceLayouts, resizePanelRect, restorePanelRect, workspaceDockTarget } from '../utils/workspaceLayout.js'

const props = defineProps({view:{type:String,default:'overview'},fullscreen:Boolean})
const emit = defineEmits(['panel-resize'])
const viewport=ref(null), menuOpen=ref(false), measured=ref(false), size=reactive({width:1200,height:700})
const registry=reactive(new Map()), order=reactive({}), maximized=ref(''), interaction=ref(null)
let saved={}
try { saved=readWorkspaceLayouts(localStorage) } catch { /* Storage is optional. */ }
const layouts=reactive(saved)
const compact=computed(()=>size.width<=(props.view==='siting'?1100:760))
const bounds=computed(()=>({width:size.width,height:size.height}))
const layoutKey=computed(()=>props.view+':'+(compact.value?'compact':'desktop'))
const panels=computed(()=>[...registry.values()].filter(panel=>(panel.view==='*' || panel.view===props.view) && panel.available!==false))
const linked=computed(()=>registry.get('map')?.available!==false && registry.has('map') && registry.has('analysis'))
const side=computed(()=>state('analysis').side || (compact.value?'bottom':'right'))
const dockTarget=ref('')
const opposite={left:'right',right:'left',top:'bottom',bottom:'top'}
const previewSide=computed(()=>dockTarget.value ? (interaction.value?.id==='map'?opposite[dockTarget.value]:dockTarget.value) : '')
const paired=computed(()=>{
  const dock=previewSide.value || side.value,horizontal=['left','right'].includes(dock),layout=state('analysis')
  return coupledPanelRects(bounds.value,{side:dock,extent:previewSide.value ? (horizontal?size.width:size.height)*.38 : horizontal?layout.width*size.width:layout.height*size.height,
    mapVisible:enabled('map'),analysisVisible:enabled('analysis'),mapMinimum:minimum('map'),analysisMinimum:minimum('analysis')})
})
const canPartition=computed(()=>linked.value && enabled('map') && enabled('analysis') && !props.fullscreen && !maximized.value)
const separatorStyle=computed(()=>paired.value.separator ? {left:paired.value.separator.x+'px',top:paired.value.separator.y+'px',width:paired.value.separator.width+'px',height:paired.value.separator.height+'px'} : {})
const sharedEdge=computed(()=>({right:'w',left:'e',bottom:'n',top:'s'}[side.value]))
let observer, sequence=10, resizeFrame, activeTarget

function state(id) {
  if(!measured.value){const panel=registry.get(id);return {...normalizePanelRect(defaultPanelRect(panel?.placement,props.view,bounds.value),bounds.value),hidden:panel?.hidden || false}}
  if (!layouts[layoutKey.value]) layouts[layoutKey.value]={}
  if (!layouts[layoutKey.value][id]) {
    const panel=registry.get(id)
    const rect=defaultPanelRect(panel?.placement,props.view,bounds.value,panels.value.findIndex(item=>item.id===id))
    layouts[layoutKey.value][id]={...normalizePanelRect(rect,bounds.value),hidden:panel?.hidden || false}
  }
  return layouts[layoutKey.value][id]
}
function minimum(id) { const panel=registry.get(id);return {width:panel?.minWidth,height:panel?.minHeight} }
function rect(id) {
  if (maximized.value===id || props.fullscreen && id==='map') return {x:0,y:0,...bounds.value,height:size.height}
  if(linked.value && ['map','analysis'].includes(id))return paired.value[id]
  return restorePanelRect(state(id),bounds.value,minimum(id))
}
function enabled(id) {
  const panel=registry.get(id)
  return !!panel && panel.available!==false && (panel.view==='*' || panel.view===props.view) && !state(id).hidden
}
function visible(id) {return enabled(id) && (!props.fullscreen || id==='map') && (!maximized.value || maximized.value===id)}
function focus(id) { order[id]=++sequence }
function persist() { try { localStorage.setItem(WORKSPACE_LAYOUT_KEY,JSON.stringify(layouts)) } catch { /* Storage is optional. */ } }
function setRect(id,value) { Object.assign(state(id),normalizePanelRect(clampPanelRect(value,bounds.value,minimum(id)),bounds.value)) }
function setPartition(dock,extent) {
  const result=coupledPanelRects(bounds.value,{side:dock,extent,mapMinimum:minimum('map'),analysisMinimum:minimum('analysis')})
  for(const id of ['map','analysis'])Object.assign(state(id),normalizePanelRect(result[id],bounds.value))
  state('analysis').side=dock
}
function adjustPartition(drag,dx,dy) {
  const horizontal=['left','right'].includes(drag.side),delta=horizontal?dx:dy
  const initial=horizontal?drag.analysis.width:drag.analysis.height
  if(!drag.edge){setPartition(drag.side,initial+(['left','top'].includes(drag.side)?delta:-delta));return}
  const growth=horizontal?(drag.edge.includes('w')?-dx:drag.edge.includes('e')?dx:0):(drag.edge.includes('n')?-dy:drag.edge.includes('s')?dy:0)
  setPartition(drag.side,initial+(drag.id==='analysis'?growth:-growth))
}
function resizeEdges() {return linked.value ? !canPartition.value?[]:['left','right'].includes(side.value)?['e','w','ne','se','nw','sw']:['n','s','ne','se','nw','sw'] : ['n','e','s','w','ne','se','sw','nw']}
function show(id) {
  state(id).hidden=false
  focus(id)
  nextTick(()=>viewport.value?.querySelector(`[data-panel-id="${id}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'}))
  persist()
}
function hide(id) { if(maximized.value===id)maximized.value='';state(id).hidden=true;persist() }
function maximize(id) { maximized.value=maximized.value===id?'':id;focus(id);viewport.value?.scrollTo({top:0,left:0}) }
function notifyResize(id) {
  cancelAnimationFrame(resizeFrame)
  resizeFrame=requestAnimationFrame(()=>emit('panel-resize',id))
}
function begin(event,id,edge='') {
  if(event.button!==0 || interaction.value || event.target.closest('button,input,select,a'))return
  event.preventDefault();event.stopPropagation()
  if(maximized.value===id || props.fullscreen)return
  focus(id)
  activeTarget=event.currentTarget
  activeTarget.setPointerCapture?.(event.pointerId)
  interaction.value={id,edge,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,initial:rect(id),linked:canPartition.value,side:side.value,analysis:rect('analysis'),
    key:layoutKey.value,savedMap:{...state('map')},savedAnalysis:{...state('analysis')}}
  window.addEventListener('pointermove',move)
  window.addEventListener('pointerup',end)
  window.addEventListener('pointercancel',cancel)
}
function move(event) {
  const drag=interaction.value
  if(!drag || event.pointerId!==drag.pointerId)return
  const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY
  if(drag.linked){
    const box=viewport.value.getBoundingClientRect()
    dockTarget.value=!drag.edge && Math.hypot(dx,dy)>8 ? workspaceDockTarget(event.clientX-box.left,event.clientY-box.top,bounds.value) : ''
    adjustPartition(drag,dx,dy)
    return
  }
  setRect(drag.id,drag.edge ? resizePanelRect(drag.initial,drag.edge,dx,dy,bounds.value,minimum(drag.id)) : {...drag.initial,x:drag.initial.x+dx,y:drag.initial.y+dy})
}
function cleanup() {
  const pointerId=interaction.value?.pointerId
  interaction.value=null
  dockTarget.value=''
  if(activeTarget?.hasPointerCapture?.(pointerId))activeTarget.releasePointerCapture(pointerId)
  activeTarget=null
  window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',cancel)
}
function end(event) {
  if(event && event.pointerId!==interaction.value?.pointerId)return
  if(previewSide.value){const dock=previewSide.value;setPartition(dock,(['left','right'].includes(dock)?size.width:size.height)*.38)}
  cleanup();persist()
}
function cancel() {
  const drag=interaction.value
  if(drag){if(drag.linked&&layouts[drag.key]){layouts[drag.key].map=drag.savedMap;layouts[drag.key].analysis=drag.savedAnalysis}else setRect(drag.id,drag.initial)}
  cleanup()
}
function keyboard(event,id,resize=false,edge='') {
  if(event.target!==event.currentTarget || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return
  event.preventDefault();focus(id)
  if(maximized.value===id || props.fullscreen)return
  const step=event.altKey?1:10,dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0
  if(canPartition.value){adjustPartition({id,side:side.value,analysis:rect('analysis'),edge:resize || event.shiftKey ? edge || 'se' : ''},dx,dy);persist();return}
  const current=rect(id)
  setRect(id,resize || event.shiftKey ? resizePanelRect(current,'se',dx,dy,bounds.value,minimum(id)) : {...current,x:current.x+dx,y:current.y+dy})
  persist()
}
function escape(event) { if(event.key==='Escape'){if(interaction.value)cancel();else if(maximized.value)maximized.value='';menuOpen.value=false} }
function reset() { cancel();delete layouts[layoutKey.value];maximized.value='';menuOpen.value=false;viewport.value?.scrollTo({top:0,left:0});persist() }
function outside(event) { if(!event.target.closest('.workspace-panel-menu'))menuOpen.value=false }
watch(()=>props.view,()=>{cancel();menuOpen.value=false;maximized.value='';nextTick(()=>viewport.value?.scrollTo({top:0,left:0}))})
provide(workspaceContextKey,{register(panel){registry.set(panel.id,panel);return ()=>registry.delete(panel.id)},rect,visible,focus,show,hide,maximize,begin,keyboard,resizeEdges,notifyResize,order,maximized,interaction})
onMounted(()=>{
  observer=new ResizeObserver(entries=>{const box=entries[0].contentRect;if(box.width>0&&box.height>0){size.width=box.width;size.height=box.height;measured.value=true}})
  observer.observe(viewport.value)
  document.addEventListener('keydown',escape);document.addEventListener('pointerdown',outside)
})
onBeforeUnmount(()=>{cancel();observer?.disconnect();cancelAnimationFrame(resizeFrame);document.removeEventListener('keydown',escape);document.removeEventListener('pointerdown',outside)})
</script>

<template>
  <main class="workspace map-workspace floating-workspace" :class="{'workspace-interacting':interaction}">
    <div class="workspace-layout-toolbar">
      <span class="workspace-layout-label"><UiIcon name="layers" :size="15" />联动布局</span>
      <span class="workspace-layout-help">拖分隔线调整比例 · 拖标题栏调整分区，地图自动填满剩余空间</span>
      <div class="workspace-panel-menu">
        <button aria-label="管理工作台面板" :aria-expanded="menuOpen" @click.stop="menuOpen=!menuOpen"><UiIcon name="menu" :size="14" />面板 <UiIcon name="chevron" :size="12" /></button>
        <div v-if="menuOpen" class="workspace-panel-list" aria-label="工作台面板列表">
          <label v-for="panel in panels" :key="panel.id"><input type="checkbox" :checked="!state(panel.id).hidden" @change="$event.target.checked ? show(panel.id) : hide(panel.id)" />{{ panel.title }}<button :aria-label="'定位'+panel.title+(panel.title.endsWith('面板')?'':'面板')" @click="show(panel.id)"><UiIcon name="locate" :size="13" /></button></label>
        </div>
      </div>
      <button class="workspace-reset-layout" @click="reset"><UiIcon name="boundary" :size="14" />恢复布局</button>
    </div>
    <div ref="viewport" class="workspace-layout-viewport">
      <div class="workspace-layout-canvas" :style="{height:bounds.height+'px'}">
        <slot />
        <div v-if="canPartition" class="workspace-divider" :class="['left','right'].includes(side)?'divider-vertical':'divider-horizontal'" :style="separatorStyle" role="separator" tabindex="0" aria-label="调整地图与分析面板比例" :aria-orientation="['left','right'].includes(side)?'vertical':'horizontal'" :aria-valuenow="Math.round((['left','right'].includes(side)?paired.analysis.width/size.width:paired.analysis.height/size.height)*100)" @pointerdown="begin($event,'analysis',sharedEdge)" @keydown="keyboard($event,'analysis',true,sharedEdge)"><i></i></div>
        <div v-if="interaction?.linked && !interaction.edge" class="workspace-dock-guides" aria-hidden="true"><span v-for="dock in ['left','right','top','bottom']" :key="dock" :class="['workspace-dock-'+dock,{active:dockTarget===dock}]">{{ interaction.id==='map'?'地图':'分析面板' }}移至{{ {left:'左侧',right:'右侧',top:'上方',bottom:'下方'}[dock] }}</span></div>
      </div>
    </div>
  </main>
</template>
