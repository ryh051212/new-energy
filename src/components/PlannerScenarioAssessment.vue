<script setup>
import { computed, reactive } from 'vue'
import { planningEconomics, configurationTotals, downloadPlanningCsv } from '../utils/plannerPss.js'
import { useChargingCarbon } from '../composables/useChargingCarbon.js'
import { estimateChargingCarbon } from '../utils/chargingCarbon.js'
const props = defineProps({ points: { type: Array, default: () => [] }, result: Object, dirty: Boolean })
const settings = reactive({ utilization: .2, sessionKwh: 24, fastUnitWan: 8, regularUnitWan: .5, siteWan: 10, marginYuan: .3, annualOpexWan: 2 })
const { settings:carbonSettings } = useChargingCarbon()
const sessionCarbon = computed(() => estimateChargingCarbon({...carbonSettings,mode:'energy',energyBasis:'grid',chargeKwh:settings.sessionKwh}))
const dailyCarbon = computed(() => estimateChargingCarbon({...carbonSettings,mode:'energy',energyBasis:'grid',chargeKwh:economics.value?.dailyKwh}))
const economics = computed(() => planningEconomics(props.points, settings)), totals = computed(() => configurationTotals(props.points))
const fields = [{ key:'utilization',label:'功率利用率（0～1）',step:.01,max:1 },{ key:'sessionKwh',label:'单车次输入侧电量 kWh',step:1 },{ key:'fastUnitWan',label:'快充单桩成本 万元',step:.1 },{ key:'regularUnitWan',label:'普通单桩成本 万元',step:.1 },{ key:'siteWan',label:'每站土建及接电 万元',step:1 },{ key:'marginYuan',label:'单位电量毛利 元/kWh',step:.01 },{ key:'annualOpexWan',label:'每站年运维 万元',step:.1 }]
const diagnostics = computed(() => !props.dirty ? props.result?.diagnostics : null)
const curve = points => points?.length ? points.map(([x,y]) => `${35+x*225},${245-y*215}`).join(' ') : ''
const fmt = (value,digits=1) => value == null ? '—' : value.toFixed(digits)
function exportReport() {
  const rows = [['新增站点',props.points.length,'站'],['新增桩数',totals.value.piles,'桩'],['新增配置能力',totals.value.capacityKw,'kW'],
    ...Object.entries(settings).map(([key,value]) => [key,value,'情景参数']), ...Object.entries(economics.value || {}).map(([key,value]) => [key,value,'情景估算']),
    ['beforeGini',diagnostics.value?.before.inequality,'需求加权可达服务'],['afterGini',diagnostics.value?.after.inequality,'需求加权可达服务'],
    ['singleSessionAvoidedCO2Kg',sessionCarbon.value.valid ? sessionCarbon.value.avoidedCO2Kg : null,'相同里程汽油对照；使用阶段CO2'],
    ['dailyAvoidedCO2Kg',dailyCarbon.value.valid ? dailyCarbon.value.avoidedCO2Kg : null,'新增站点计量侧供电情景'],
    ['gridFactor',sessionCarbon.value.factor?.value,'kgCO2/kWh'],['gridFactorSource',sessionCarbon.value.factor?.source || '自定义情景',''],
    ...Object.entries(carbonSettings).map(([key,value]) => ['carbon.'+key,value,'单次充电减排模型参数'])]
  downloadPlanningCsv('魏都区-方案评估.csv',['指标','数值','口径'],rows)
}
</script>
<template>
  <section class="pss-scenario" aria-label="洛伦兹与投资情景评估">
    <div class="pss-card-heading"><h3>洛伦兹公平性评估</h3><button @click="exportReport">导出评估</button></div>
    <p v-if="!diagnostics" class="pss-note">{{ dirty && result ? '方案已修改，重新分析后更新曲线。' : '分析方案后，按同一批需求位置比较可达服务的分配。' }}</p>
    <template v-else><svg class="pss-lorenz" viewBox="0 0 290 280" role="img" aria-label="模拟前后需求加权可达服务洛伦兹曲线"><path d="M35 30V245H260" fill="none" stroke="#cbd5e1"/><path d="M35 245L260 30" stroke="#94a3b8" stroke-dasharray="5 4"/><polyline :points="curve(diagnostics.before.lorenz)" fill="none" stroke="#dc5c65" stroke-width="2.5"/><polyline :points="curve(diagnostics.after.lorenz)" fill="none" stroke="#10a781" stroke-width="2.5"/><text x="36" y="17">累计可达服务份额</text><text x="115" y="269">累计需求权重</text><text x="15" y="250">0</text><text x="237" y="259">100%</text><text x="6" y="35">100%</text></svg><div class="pss-curve-key"><span class="pss-before">模拟前 {{ fmt(diagnostics.before.inequality,3) }}</span><span class="pss-after">模拟后 {{ fmt(diagnostics.after.inequality,3) }}</span></div><p class="pss-note">按未截断可达服务从低到高排序；横轴为 POI / 网格估计点的需求权重，非实测人口。全部无已知服务时基尼系数与曲线保持未知。</p></template>
    <details class="pss-economics" open><summary>投资、服务量与环境效益情景</summary><p class="pss-note">以下默认值均为可编辑假设，只测算新增站点，不计现有站收入和移除补偿。</p><div class="pss-kpis pss-kpis-compact"><article><span>新增配置能力</span><strong>{{ fmt(totals.capacityKw,0) }}<small> kW</small></strong></article><article><span>投资概算</span><strong>{{ fmt(economics?.capexWan) }}<small> 万元</small></strong></article><article><span>日均服务量估算</span><strong>{{ fmt(economics?.dailySessions,0) }}<small> 车次</small></strong></article><article><span>静态回收期</span><strong>{{ fmt(economics?.paybackYears) }}<small> 年</small></strong></article></div><p class="pss-note">日供电量 {{ fmt(economics?.dailyKwh,0) }} kWh · 年净经营现金流 {{ fmt(economics?.annualNetWan) }} 万元 · 年净减排情景 {{ fmt(dailyCarbon.valid ? dailyCarbon.avoidedCO2Kg * 365 / 1000 : null) }} 吨。净现金流不大于零时不显示回收年限。</p><div class="pss-input-grid"><label v-for="field in fields" :key="field.key" class="pss-field">{{ field.label }}<input v-model.number="settings[field.key]" type="number" min="0" :max="field.max" :step="field.step" /></label></div><p v-if="!economics" class="pss-alert" role="alert">请补全有效参数；利用率需在 0～1，单车次电量须大于零。</p></details>
    <section class="pss-scenario-carbon" aria-label="方案充电减排联动"><h3>每车次与方案减排</h3><p class="pss-note">沿用“双碳评估”中的车辆、效率与电力因子；每车次按本方案设定的 {{ settings.sessionKwh }} kWh 输入侧电量估算。</p><div class="pss-kpis pss-kpis-compact"><article><span>每次净减排</span><strong>{{ fmt(sessionCarbon.valid ? sessionCarbon.avoidedCO2Kg : null,2) }}<small> kg CO₂</small></strong></article><article><span>方案日净减排</span><strong>{{ fmt(dailyCarbon.valid ? dailyCarbon.avoidedCO2Kg : null,1) }}<small> kg CO₂</small></strong></article></div><p class="pss-note">{{ sessionCarbon.factor?.name || '因子待填写' }} · 使用阶段同等里程对照，保留增排结果。未接入实际充电订单，日、年结果依赖假设利用率。</p><a class="pss-source-link" href="#/planning/carbon">打开双碳评估与逐次记录 →</a></section>
  </section>
</template>
