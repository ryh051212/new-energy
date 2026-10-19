<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({ reason: { type: String, default: '' }, authenticate: { type: Function, required: true } })
const emit = defineEmits(['close', 'success'])
const dialog = ref(null), usernameInput = ref(null)
const username = ref(''), password = ref(''), visiblePassword = ref(false), submitting = ref(false), error = ref('')
let previousFocus, previousOverflow, active = true

function close() { emit('close') }
async function submit() {
  if (submitting.value) return
  error.value = ''
  if (!username.value.trim() || !password.value) { error.value = '请输入用户名和密码'; return }
  submitting.value = true
  try {
    const session = await props.authenticate(username.value.trim(), password.value)
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
        <form class="auth-form" aria-label="账号登录" @submit.prevent="submit">
          <label for="login-username">用户名</label>
          <div class="auth-input"><UiIcon name="user" :size="18" /><input id="login-username" ref="usernameInput" v-model="username" name="username" autocomplete="username" placeholder="请输入用户名" maxlength="80" required :disabled="submitting" :aria-invalid="!!error" @input="error = ''" /></div>
          <label for="login-password">密码</label>
          <div class="auth-input"><UiIcon name="lock" :size="18" /><input id="login-password" v-model="password" name="password" :type="visiblePassword ? 'text' : 'password'" autocomplete="current-password" placeholder="请输入密码" maxlength="256" required :disabled="submitting" :aria-invalid="!!error" :aria-describedby="error ? 'login-error' : undefined" @input="error = ''" /><button type="button" :aria-label="visiblePassword ? '隐藏密码' : '显示密码'" :aria-pressed="visiblePassword" @click="visiblePassword = !visiblePassword"><UiIcon :name="visiblePassword ? 'eye-off' : 'eye'" :size="18" /></button></div>
          <p v-if="error" id="login-error" class="auth-error" role="alert"><UiIcon name="alert" :size="15" />{{ error }}</p>
          <button class="auth-submit" type="submit" :disabled="submitting" :aria-busy="submitting">{{ submitting ? '正在登录…' : '登录' }}<UiIcon v-if="!submitting" name="arrow-right" :size="18" /></button>
        </form>
        <div class="auth-account-hint"><UiIcon name="info" :size="15" /><span>默认账号 <b>admin</b><i>·</i>密码 <b>123456</b></span></div>
        <button class="auth-guest" @click="close">暂不登录，继续浏览地图 <span aria-hidden="true">→</span></button>
      </section>
    </div>
  </Teleport>
</template>
