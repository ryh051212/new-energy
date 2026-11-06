<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
const props=defineProps({open:Boolean,title:String,label:{type:String,default:'周边区域选择抽屉'},closeLabel:{type:String,default:'关闭周边选址抽屉'},eyebrow:{type:String,default:'布局规划'}})
const emit=defineEmits(['close'])
const drawer=ref(null),closeButton=ref(null)
let returnFocus=null
function show(){
  if(drawer.value?.open)return
  returnFocus=document.activeElement
  drawer.value?.show()
  nextTick(()=>{if(props.open&&drawer.value?.open)closeButton.value?.focus({preventScroll:true})})
}
function close(){
  const other=Array.from(document.querySelectorAll('dialog[open]')).find(element=>element!==drawer.value&&!element.inert)
  drawer.value?.close()
  if(other){if(!other.contains(document.activeElement))other.querySelector('button')?.focus({preventScroll:true})}
  else if(returnFocus?.isConnected&&!returnFocus.closest('[inert]')&&returnFocus.getClientRects().length)returnFocus.focus({preventScroll:true})
  returnFocus=null
}
onMounted(()=>{if(props.open)show()})
onBeforeUnmount(close)
</script>
<template>
  <Teleport to="body"><Transition name="ui-drawer-slide" @before-enter="show" @after-leave="close"><dialog v-show="open" ref="drawer" class="ui-drawer" :aria-label="label" :inert="!open" @cancel.prevent="emit('close')" @keydown.esc.stop.prevent="emit('close')">
    <header><div><small>{{ eyebrow }}</small><h2>{{ title }}</h2></div><button ref="closeButton" type="button" :aria-label="closeLabel" @click="emit('close')">×</button></header>
    <div class="ui-drawer-body"><slot /></div>
  </dialog></Transition></Teleport>
</template>
<style scoped>
.ui-drawer{z-index:51000;position:fixed;inset:12px 12px 12px auto;margin:0;box-sizing:border-box;width:420px;max-width:calc(100vw - 24px);height:calc(100dvh - 24px);max-height:calc(100dvh - 24px);padding:0;border:1px solid #ffffffdb;border-radius:18px;background:rgba(245,249,255,.88);backdrop-filter:blur(26px) saturate(145%);-webkit-backdrop-filter:blur(26px) saturate(145%);color:var(--ink-800,#333);box-shadow:-12px 0 40px #253c6026,inset 0 1px 0 #fff;font-family:inherit}.ui-drawer::backdrop{background:#24242435}.ui-drawer>header{display:flex;justify-content:space-between;align-items:center;gap:15px;padding:22px 24px;border-bottom:1px solid #c7d3e44d;background:linear-gradient(130deg,#ffffff9c,#eef4ff45)}.ui-drawer h2{font-size:18px;margin:6px 0 0}.ui-drawer small{font-size:10px;color:var(--ink-400,#888);letter-spacing:.1em}.ui-drawer>header button{background:none;border:0;color:var(--ink-500,#666);font-size:26px;cursor:pointer;padding:5px}.ui-drawer-body{height:calc(100% - 100px);box-sizing:border-box;overflow:auto;padding:4px 20px 24px;overscroll-behavior:contain}.ui-drawer-slide-enter-active{transition:transform .38s cubic-bezier(.22,1,.36,1),opacity .28s ease}.ui-drawer-slide-leave-active{transition:transform .26s ease,opacity .2s ease;pointer-events:none}.ui-drawer-slide-enter-from,.ui-drawer-slide-leave-to{transform:translateX(44px);opacity:0}@supports not (backdrop-filter:blur(1px)){.ui-drawer{background:#f5f8fd}}@media(prefers-reduced-motion:reduce){.ui-drawer-slide-enter-active,.ui-drawer-slide-leave-active{transition:none}}
.ui-drawer{display:flex;flex-direction:column;border-radius:24px;background:rgba(248,250,255,.98);border-color:#e2e8f3}.ui-drawer>header{flex:none;padding:20px 22px;border-radius:24px 24px 0 0}.ui-drawer>header button{display:grid;place-items:center;flex:none;width:36px;height:36px;padding:0;border-radius:11px;background:#ffffff94;line-height:1}.ui-drawer>header button:hover{background:#fff}.ui-drawer>header button:focus-visible{outline:2px solid var(--brand-400,#818cf8);outline-offset:2px}.ui-drawer-body{flex:1;min-height:0;height:auto;padding:4px 18px 24px}
@media(max-width:420px){.ui-drawer{inset:8px 8px 8px auto;max-width:calc(100vw - 16px);height:calc(100dvh - 16px);max-height:calc(100dvh - 16px);border-radius:20px}.ui-drawer>header{padding:17px 16px;border-radius:20px 20px 0 0}.ui-drawer h2{font-size:17px}.ui-drawer-body{padding:4px 14px 20px}}
</style>
