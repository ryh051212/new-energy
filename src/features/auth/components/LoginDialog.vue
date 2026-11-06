<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from '../../../shared/components/UiIcon.vue'
import { loginValidation, USERNAME_HINT, PASSWORD_HINT } from '../models/loginPolicy.js'

const props = defineProps({ reason: { type: String, default: '' }, authenticate: { type: Function, required: true },quickAuthenticate:Function })
const emit = defineEmits(['close', 'success'])
const dialog = ref(null), usernameInput = ref(null)
const username = ref(''), password = ref(''), visiblePassword = ref(false), submitting = ref(false), error = ref('')
const invalidField=ref('')
const usernameValid=computed(()=>/^[A-Za-z]{1,8}$/.test(username.value.trim()))
const passwordValid=computed(()=>!loginValidation('admin',password.value))
let previousFocus, previousOverflow, active = true
const controller = new AbortController()

function close() { emit('close') }
async function quickLogin(){
  if(submitting.value || !props.quickAuthenticate)return
  error.value='';invalidField.value='';submitting.value=true
  try{
    const session=await props.quickAuthenticate({signal:controller.signal})
    if(active)emit('success',session)
  }catch(cause){if(active)error.value=cause.message || '一键登录失败，请重试'}
  finally{if(active)submitting.value=false}
}
async function submit() {
  if (submitting.value) return
  error.value = ''
  const invalid=loginValidation(username.value.trim(),password.value)
  if(invalid){error.value=invalid.message;invalidField.value=invalid.field;return}
  invalidField.value=''
  submitting.value = true
  try {
    const session = await props.authenticate(username.value.trim(), password.value, { signal: controller.signal })
    if (active) emit('success', session)
  } catch (cause) {
    if (active) error.value = cause.message || '登录失败，请重试'
  } finally {
    if (active) submitting.value = false
  }
}
function keyboard(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const controls = [...dialog.value.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href]')]
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => {
  previousFocus = document.activeElement
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  await nextTick()
  usernameInput.value?.focus()
})
onBeforeUnmount(() => {
  active = false
  controller.abort()
  password.value = ''
  document.body.style.overflow = previousOverflow
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="auth-overlay" @click.self="close" @keydown="keyboard">
      <section ref="dialog" class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title" aria-describedby="login-description">
        <button class="auth-close" aria-label="关闭登录窗口" @click="close"><UiIcon name="close" :size="19" /></button>
        <span class="auth-brand-mark"><UiIcon name="layers" :size="29" /></span>
        <span class="auth-eyebrow">桩连智图 · 空间规划工作台</span>
        <h1 id="login-title">{{ reason ? '登录后，继续探索' : '欢迎回来' }}</h1>
        <p id="login-description" class="auth-description">{{ reason ? `使用「${reason}」需要登录，地图浏览始终向你开放。` : '登录账号，使用空间分析与充电设施规划功能。' }}</p>
        <form class="auth-form" aria-label="账号登录" novalidate @submit.prevent="submit">
          <label for="login-username">用户名</label>
          <div class="auth-field-tooltip"><div class="auth-input"><UiIcon name="user" :size="18" /><input id="login-username" ref="usernameInput" v-model="username" name="username" autocomplete="username" placeholder="最多 8 个英文字母" maxlength="8" pattern="[A-Za-z]{1,8}" required :disabled="submitting" :aria-invalid="!!username && !usernameValid || invalidField==='username'" aria-describedby="username-tooltip username-feedback" @input="error = '';invalidField=''" /></div><span id="username-tooltip" role="tooltip">{{ USERNAME_HINT }}</span><p id="username-feedback" v-if="username || invalidField==='username'" class="auth-field-feedback" :class="usernameValid ? 'is-valid' : 'is-invalid'" aria-live="polite">{{ usernameValid ? '✓ 用户名格式通过' : USERNAME_HINT }}</p></div>
          <label for="login-password">密码</label>
          <div class="auth-field-tooltip"><div class="auth-input"><UiIcon name="lock" :size="18" /><input id="login-password" v-model="password" name="password" :type="visiblePassword ? 'text' : 'password'" autocomplete="current-password" placeholder="至少 8 位，包含字母和数字" minlength="8" maxlength="256" required :disabled="submitting" :aria-invalid="!!password && !passwordValid || invalidField==='password'" aria-describedby="password-tooltip password-feedback" @input="error = '';invalidField=''" /><button type="button" :aria-label="visiblePassword ? '隐藏密码' : '显示密码'" :aria-pressed="visiblePassword" @click="visiblePassword = !visiblePassword"><UiIcon :name="visiblePassword ? 'eye-off' : 'eye'" :size="18" /></button></div><span id="password-tooltip" role="tooltip">{{ PASSWORD_HINT }}</span><p id="password-feedback" v-if="password || invalidField==='password'" class="auth-field-feedback" :class="passwordValid ? 'is-valid' : 'is-invalid'" aria-live="polite">{{ passwordValid ? '✓ 密码格式通过' : PASSWORD_HINT }}</p></div>
          <p v-if="error && !invalidField" id="login-error" class="auth-error" role="alert">{{ error }}</p>
          <button class="auth-submit" type="submit" :disabled="submitting" :aria-busy="submitting">{{ submitting ? '正在登录…' : '登录' }}<UiIcon v-if="!submitting" name="arrow-right" :size="18" /></button>
        </form>
        <button v-if="quickAuthenticate" class="auth-quick-login" type="button" :disabled="submitting" @click="quickLogin"><UiIcon name="user" :size="16" />管理员一键登录<small>仅本机可用</small></button>
        <div class="auth-account-hint"><UiIcon name="lock" :size="15" /><span>使用管理员配置的账号登录</span></div>
        <button class="auth-guest" @click="close">暂不登录，继续浏览地图 <span aria-hidden="true">→</span></button>
      </section>
    </div>
  </Teleport>
</template>
