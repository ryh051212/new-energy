<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import UiModal from './UiModal.vue'
import { feedback, settleConfirmation, clearFeedback } from '../feedback/feedback.js'
const popconfirm=ref(null)
const position=computed(()=>({left:Math.max(12,Math.min(feedback.confirmation?.left || 12,(globalThis.innerWidth || 1024)-292))+'px',
  top:Math.max(12,Math.min((feedback.confirmation?.top || 12)+10,(globalThis.innerHeight || 768)-170))+'px'}))
watch(()=>feedback.confirmation,value=>{if(value && !popconfirm.value.open)popconfirm.value.showModal();else if(!value && popconfirm.value.open)popconfirm.value.close()},{flush:'post'})
onBeforeUnmount(clearFeedback)
</script>
<template>
  <UiModal :open="!!feedback.modal" :title="feedback.modal?.title" :message="feedback.modal?.message" @close="feedback.modal=null" />
  <Teleport to="body">
    <Transition name="ui-toast"><div v-if="feedback.toast" :key="feedback.toast.id" class="ui-toast" role="status"><i>✓</i><span>{{ feedback.toast.message }}</span><button type="button" aria-label="关闭成功提示" @click="feedback.toast=null">×</button></div></Transition>
    <dialog ref="popconfirm" class="ui-popconfirm" :style="position" aria-label="删除确认" @cancel.prevent="settleConfirmation(false)" @click="event=>{if(event.target===popconfirm)settleConfirmation(false)}">
      <p>{{ feedback.confirmation?.message }}</p><div><button type="button" autofocus @click="settleConfirmation(false)">取消</button><button type="button" class="ui-popconfirm-danger" @click="settleConfirmation(true)">确认删除</button></div>
    </dialog>
  </Teleport>
</template>
<style scoped>
.ui-toast{position:fixed;top:22px;left:50%;translate:-50% 0;z-index:60000;display:flex;align-items:center;gap:10px;width:max-content;max-width:calc(100vw - 40px);box-sizing:border-box;padding:12px 16px;border:1px solid #dce4dc;border-radius:9px;background:white;box-shadow:0 5px 25px #0002;color:#35443b;font-size:13px}.ui-toast i{display:grid;place-items:center;background:#edf8f0;color:#329356;width:21px;height:21px;border-radius:50%;font-style:normal}.ui-toast button{margin-left:10px;background:none;border:0;font-size:18px;color:#858c88;cursor:pointer}.ui-toast-enter-active,.ui-toast-leave-active{transition:opacity .18s,transform .18s}.ui-toast-enter-from,.ui-toast-leave-to{opacity:0;transform:translateY(-10px)}.ui-popconfirm{position:fixed;margin:0;box-sizing:border-box;width:280px;max-width:calc(100vw - 24px);padding:17px;border:1px solid #ddd;border-radius:9px;box-shadow:0 8px 30px #0003;font-family:inherit;color:#444}.ui-popconfirm::backdrop{background:transparent}.ui-popconfirm p{margin:0 0 16px;font-size:12px;line-height:1.7}.ui-popconfirm>div{display:flex;justify-content:flex-end;gap:8px}.ui-popconfirm button{padding:6px 12px;border:1px solid #ddd;border-radius:5px;background:white;font-size:11px;cursor:pointer}.ui-popconfirm button.ui-popconfirm-danger{background:#c44442;border-color:#c44442;color:white}
</style>
