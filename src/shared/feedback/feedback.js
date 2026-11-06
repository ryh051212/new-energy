import { reactive } from 'vue'

export const feedback=reactive({modal:null,toast:null,confirmation:null})
let toastTimer, resolveConfirmation
export function showError(message,title='操作未完成'){
  feedback.modal={title,message:String(message || '请稍后重试')}
}
export function showToast(message){
  clearTimeout(toastTimer)
  feedback.toast={message,id:Date.now()}
  toastTimer=setTimeout(()=>{feedback.toast=null},3500)
}
export function settleConfirmation(accepted){
  const resolve=resolveConfirmation;resolveConfirmation=undefined
  feedback.confirmation=null;resolve?.(accepted)
}
export function confirmAction(message,anchor){
  settleConfirmation(false)
  const rect=anchor?.getBoundingClientRect?.()
  feedback.confirmation={message,left:rect?.left ?? anchor?.clientX ?? globalThis.innerWidth/2,
    top:rect?.bottom ?? anchor?.clientY ?? globalThis.innerHeight/2}
  return new Promise(resolve=>{resolveConfirmation=resolve})
}
export function clearFeedback(){clearTimeout(toastTimer);feedback.toast=null;feedback.modal=null;settleConfirmation(false)}
