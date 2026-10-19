<script setup>
import UiIcon from './UiIcon.vue'
import TermHint from './TermHint.vue'
import { planningQuadrants } from '../utils/plannerOverview.js'
defineProps({ grid: Object, factors:Object,planned:Boolean })
const emit = defineEmits(['close','plan','add'])
const index = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—'
</script>

<template>
  <div v-if="grid" class="selected-hex planner-grid-detail" @click.stop>
    <button class="selected-close" aria-label="关闭网格详情" @click="emit('close')"><UiIcon name="close" :size="14" /></button>
    <b>网格 #{{ grid.id }}</b>
    <span>{{ planningQuadrants.find(item => item.id === grid.supplyDemandType)?.label || '未分类' }}</span>
    <dl><div><dt><TermHint term="demandIndex" label="需求" /></dt><dd>{{ index(grid.demandIndex) }}</dd></div><div><dt><TermHint term="supplyIndex" label="供给" /></dt><dd>{{ index(grid.supplyIndex) }}</dd></div><div><dt><TermHint term="mismatchIndex" label="失配" /></dt><dd>{{ index(grid.mismatchIndex) }}</dd></div></dl>
    <p>站点 {{ grid.stationCount ?? '—' }} · 小区 {{ grid.residentialCount ?? '—' }} · 商业 {{ grid.commercialCount ?? '—' }}</p>
    <p v-if="factors">快充需求 {{ index(factors.pssFastDemand) }} · 普通 {{ index(factors.pssRegularDemand) }}<br/>五维资料 {{ factors.pssFactorCount }}/5 · 配置能力 {{ factors.pssCapacityKw == null ? '未知' : factors.pssCapacityKw.toFixed(0) }} kW</p>
    <button class="planner-grid-plan" @click="emit('add')">{{ planned ? '已纳入规划 · 点击移除' : '＋ 在此网格模拟建站（1 桩 / 60 kW）' }}</button>
    <button class="planner-grid-plan" @click="emit('plan')">以此网格开始方案推演 →</button>
  </div>
</template>

<style scoped>
.planner-grid-detail{width:250px;gap:5px}.planner-grid-detail>span{font-size:10px;color:var(--ink-500)}.planner-grid-detail dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:6px 0;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.planner-grid-detail dt{font-size:10px;color:var(--ink-500)}.planner-grid-detail dd{margin:5px 0 0;font-size:15px;font-weight:600;color:var(--ink-800);font-variant-numeric:tabular-nums}.planner-grid-detail p{font-size:10px;color:var(--ink-500)}
</style>
