<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
const props=defineProps({open:Boolean,title:{type:String,default:'提示'},message:String})
const emit=defineEmits(['close'])
const dialog=ref(null)
function sync(){if(props.open && !dialog.value?.open)dialog.value?.showModal();else if(!props.open && dialog.value?.open)dialog.value.close()}
watch(()=>props.open,sync,{flush:'post'});onMounted(sync)
onBeforeUnmount(()=>dialog.value?.close())
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="ui-modal" aria-label="提示对话框" @cancel.prevent="emit('close')" @click="event=>{if(event.target===dialog)emit('close')}">
    <header><h2>{{ title }}</h2><button type="button" aria-label="关闭提示对话框" @click="emit('close')">×</button></header>
    <p>{{ message }}</p><slot /><footer><button class="ui-modal-primary" type="button" autofocus @click="emit('close')">知道了</button></footer>
  </dialog></Teleport>
</template>
<style scoped>
.ui-modal{box-sizing:border-box;width:420px;max-width:calc(100vw - 40px);padding:24px;border:1px solid #ddd;border-radius:13px;background:#fff;color:#303846;box-shadow:0 18px 70px #0003;font-family:inherit}.ui-modal::backdrop{background:#25282d55}.ui-modal header{display:flex;justify-content:space-between;align-items:center;gap:16px}.ui-modal h2{margin:0;font-size:17px}.ui-modal header button{background:none;border:0;color:#737981;font-size:24px;cursor:pointer}.ui-modal p{white-space:pre-line;font-size:13px;line-height:1.9;margin:20px 0;color:#5f6875;overflow-wrap:anywhere}.ui-modal footer{display:flex;justify-content:flex-end}.ui-modal-primary{padding:9px 21px;background:#2865ae;border:0;border-radius:7px;color:white;font-size:12px;cursor:pointer}button:focus-visible{outline:3px solid #94b6eb;outline-offset:2px}
</style>
