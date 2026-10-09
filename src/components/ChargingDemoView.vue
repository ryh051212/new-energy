<script setup>
import { onMounted, ref } from 'vue'
import UiIcon from './UiIcon.vue'
import { chargingDemo } from '../navigation.js'

const redirectFailed = ref(false)

onMounted(() => {
  try {
    // 替换演示入口的历史记录，浏览器后退仍可返回找充电页面。
    window.location.replace(chargingDemo.url)
  } catch {
    redirectFailed.value = true
  }
})
</script>

<template>
  <main class="placeholder-page charging-demo-page" aria-label="虚拟演示">
    <section class="placeholder-card">
      <span class="placeholder-icon"><UiIcon name="compass" :size="34" /></span>
      <span class="placeholder-tag">虚拟演示</span>
      <h1>{{ redirectFailed ? '打开虚拟演示' : '正在打开演示页面' }}</h1>
      <p role="status">{{ redirectFailed ? '请点击下方按钮进入演示页面。' : '即将进入许昌充电站虚拟演示，若未自动跳转，请点击下方按钮。' }}</p>
      <a :href="chargingDemo.url" class="primary-link" rel="noreferrer">打开演示</a>
      <a href="#/charging" class="back-link charging-demo-back">返回找充电</a>
    </section>
  </main>
</template>

<style scoped>
.charging-demo-page{min-height:100dvh;padding:24px 0}
.charging-demo-back{margin-top:18px}
</style>
