<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from './UiIcon.vue'
import { workspaceContextKey } from '../utils/workspaceLayout.js'
const props=defineProps({panelId:{type:String,required:true},title:{type:String,required:true},view:{type:String,default:'*'},placement:{type:String,default:'auxiliary'},hidden:Boolean,available:{type:Boolean,default:true},minWidth:{type:Number,default:280},minHeight:{type:Number,default:200},map:Boolean})
const workspace=inject(workspaceContextKey,null),body=ref(null)
const panelLabel=computed(()=>props.title.endsWith('面板')?props.title:props.title+'面板')
const unregister=workspace?.register({id:props.panelId,get title(){return props.title},get view(){return props.view},get available(){return props.available},placement:props.placement,hidden:props.hidden,minWidth:props.minWidth,minHeight:props.minHeight})
const geometry=computed(()=>{
  if(!workspace)return {}
  const rect=workspace.rect(props.panelId)
  return {left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px',zIndex:workspace.maximized.value===props.panelId?10000:workspace.order[props.panelId] || 1}
})
let observer
onMounted(()=>{if(workspace&&props.map){observer=new ResizeObserver(()=>workspace.notifyResize(props.panelId));observer.observe(body.value)}})
onBeforeUnmount(()=>{observer?.disconnect();unregister?.()})
defineExpose({open:()=>workspace?.show(props.panelId)})
const edges=computed(()=>workspace?.resizeEdges(props.panelId) || [])
</script>

<template>
  <section v-show="!workspace || workspace.visible(panelId)" :class="{'movable-panel':workspace,'movable-panel-map':map,'panel-maximized':workspace?.maximized.value===panelId}" :style="geometry" :data-panel-id="panelId" :aria-label="panelLabel" @pointerdown.capture="workspace?.focus(panelId)">
    <header v-if="workspace" class="movable-panel-titlebar" tabindex="0" :aria-label="'移动'+panelLabel" title="拖动调整分区；拖到方向提示处切换位置，方向键微调比例" @pointerdown="workspace.begin($event,panelId)" @keydown="workspace.keyboard($event,panelId)" @dblclick.self="workspace.maximize(panelId)">
      <span class="panel-drag-dots" aria-hidden="true">⠿</span><b @dblclick="workspace.maximize(panelId)">{{ title }}</b>
      <span class="movable-panel-actions"><button :aria-label="'最大化或还原'+panelLabel" @click.stop="workspace.maximize(panelId)"><UiIcon :name="workspace.maximized.value===panelId?'compress':'expand'" :size="13" /></button><button :aria-label="'收起'+panelLabel" @click.stop="workspace.hide(panelId)"><UiIcon name="minus" :size="14" /></button></span>
    </header>
    <div ref="body" :class="{'movable-panel-body':workspace}"><slot /></div>
    <template v-if="workspace && workspace.maximized.value!==panelId"><span v-for="edge in edges" :key="edge" :class="['panel-resize-handle','panel-resize-'+edge]" :data-resize="edge" :tabindex="edge==='se'?0:-1" role="button" :aria-label="'调整'+panelLabel+'大小 '+edge" title="拖动调整宽高" @pointerdown="workspace.begin($event,panelId,edge)" @keydown="workspace.keyboard($event,panelId,true)"></span></template>
  </section>
</template>
