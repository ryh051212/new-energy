<script setup>
import { computed } from 'vue'
import { ACTIVITY_TYPES, DEMAND_SCENARIOS, FUNCTIONAL_ZONES, demandScenario } from '../models/functionalZones.js'
const props = defineProps({ scenarioId: { type:String, default:'weekday-day' }, mapMode: { type:String, default:'zones' },
  features: { type:Array, default:()=>[] }, disabled:Boolean })
const emit = defineEmits(['scenario-change', 'map-mode-change'])
const current = computed(() => demandScenario(props.scenarioId))
const counts = computed(() => Object.fromEntries(FUNCTIONAL_ZONES.map(zone => [zone.id,
  props.features.filter(feature => feature.properties.functionalZone === zone.id).length])))
const partial = computed(() => props.features.filter(feature => feature.properties.activityCompleteness < 5).length)
</script>

<template>
  <section class="pss-card demand-scenarios" aria-label="功能分区与时间场景">
    <div class="pss-card-heading"><div><span class="pss-eyebrow">先看功能区，再看何时需要充电</span><h3>功能分区与时间场景</h3></div></div>
    <div class="demand-scenario-tabs" role="group" aria-label="需求时间场景">
      <button v-for="scene in DEMAND_SCENARIOS" :key="scene.id" :aria-pressed="scenarioId===scene.id" :class="{active:scenarioId===scene.id}" :disabled="disabled" @click="emit('scenario-change',scene.id)">{{ scene.label }}</button>
    </div>
    <p class="pss-note" role="status">当前：{{ current.label }}。{{ scenarioId==='weekday-day' ? '工作与公共服务活动更活跃，居住活动较弱。' : scenarioId==='weekday-night' ? '居住需求上升，购物与休闲活动增强，工作活动减弱。' : '购物与休闲更活跃，居住保持一定需求，工作活动减弱。' }}切换后同步更新地图、评分和补点收益。</p>
    <div class="demand-map-modes" role="group" aria-label="选址地图着色">
      <button :class="{active:mapMode==='zones'}" :aria-pressed="mapMode==='zones'" @click="emit('map-mode-change','zones')">功能区分布</button>
      <button :class="{active:mapMode==='demand'}" :aria-pressed="mapMode==='demand'" @click="emit('map-mode-change','demand')">当前场景需求</button>
      <button :class="{active:mapMode==='base'}" :aria-pressed="mapMode==='base'" @click="emit('map-mode-change','base')">基础专题图层</button>
    </div>
    <div class="demand-zone-summary"><span v-for="zone in FUNCTIONAL_ZONES" :key="zone.id"><i :style="{background:zone.color}"></i>{{ zone.label }} <b>{{ counts[zone.id] }}</b></span></div>
    <details class="demand-coefficients"><summary>查看活动系数与分区依据</summary>
      <div class="pss-table-wrap"><table class="pss-table"><thead><tr><th>活动类型</th><th v-for="scene in DEMAND_SCENARIOS" :key="scene.id">{{ scene.label }}</th></tr></thead><tbody><tr v-for="activity in ACTIVITY_TYPES" :key="activity.id"><th>{{ activity.label }}</th><td v-for="scene in DEMAND_SCENARIOS" :key="scene.id" :class="{active:scene.id===scenarioId}">{{ scene.coefficients[activity.id].toFixed(2) }}</td></tr></tbody></table></div>
      <p class="pss-note">居住活动使用网格 GHSL 模型人口；工作、购物、休闲及公共服务仍使用对应 POI 数量。每类分别除以全区该类最大值，再按情景系数计算相对需求；人口缺失不以住宅 POI 替代。功能分区仅供情景参考，尚未结合用地边界或现场核验。</p>
      <p class="pss-note">情景需求 = Σ（各类标准化数量 × 当前活动系数）÷ 全区最大基础活动总强度。三个场景共用同一尺度，不在切换时重新拉伸。系数采用本次设定；缺失类别仅计算已知部分，{{ partial }} 个网格的五类资料不完整。需求为相对指数，不能换算为车辆数或订单。</p>
    </details>
  </section>
</template>
