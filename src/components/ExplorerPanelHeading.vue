<script setup>
import UiIcon from './UiIcon.vue'
defineProps({ label: String, title: String, description: String, icon: { type: String, default: 'bolt' } })
</script>

<template>
  <header class="explorer-panel-heading">
    <span v-if="label" class="explorer-eyebrow"><UiIcon :name="icon" :size="13" />{{ label }}</span>
    <div class="explorer-panel-title"><h1>{{ title }}</h1><slot /></div>
    <p>{{ description }}</p>
  </header>
</template>
