<script setup>
import { computed, ref } from 'vue'
import { ACTIVITY_TYPES } from '../models/functionalZones.js'
import { ACTIVITY_WEIGHT, CHARGING_START_PERCENT, PUBLIC_CHARGING_Q } from '../models/chargingStartScenario.js'

const props = defineProps({ temporal: { type:Object, required:true }, selection: { type:Object, required:true }, compact:Boolean })
const compare = ref(false)
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const curve = computed(() => props.temporal.series?.[props.selection.scenario]?.[props.selection.day] || [])
const current = computed(() => curve.value[props.selection.hour] || {})
const strength = value => !valid(value) ? null : props.temporal.scale > 0 ? value / props.temporal.scale * 100 : 0
const number = (value, digits=1) => valid(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits:digits, maximumFractionDigits:digits }) : '—'
const display = computed(() => strength(current.value.demandIndex))
const contributions = computed(() => ACTIVITY_TYPES.map(activity => {
  const value = current.value.contributions?.[activity.id]
  return { ...activity, label:activity.id === 'residential' ? '居住人口' : activity.label,
    value, share:valid(current.value.demandIndex) && current.value.demandIndex > 0 && valid(value) ? value / current.value.demandIndex * 100 : null,
    intensity:props.temporal.intensity?.[activity.id], q:PUBLIC_CHARGING_Q[props.selection.scenario]?.[activity.id],
    percent:CHARGING_START_PERCENT[activity.id]?.[props.selection.day]?.[props.selection.hour] }
}))
const dominant = computed(() => [...contributions.value].filter(row=>valid(row.value) && row.value>0).sort((a,b)=>b.value-a.value)[0])
const y = value => 142 - (strength(value) ?? 0) / 100 * 112
const bars = computed(() => curve.value.map((point, hour) => {
  let base=0
  return { hour, segments:ACTIVITY_TYPES.map(activity => {
    const value=point.contributions?.[activity.id]
    const bottom=base; base += valid(value) ? value : 0
    return { id:activity.id, color:activity.color, y:y(base), height:Math.max(0,y(bottom)-y(base)) }
  }) }
}))
const scenarios = [{id:'low',label:'低',dash:'3 3'}, {id:'medium',label:'中',dash:''}, {id:'high',label:'高',dash:'7 3'}]
const comparison = computed(() => scenarios.map(scenario => ({ ...scenario,
  points:(props.temporal.series?.[scenario.id]?.[props.selection.day] || []).map((point,hour)=>`${42+(hour+.5)/24*304},${y(point.demandIndex)}`).join(' ') })))
const medium = computed(() => props.temporal.series?.medium?.[props.selection.day]?.[props.selection.hour]?.demandIndex)
const change = computed(() => valid(current.value.demandIndex) && medium.value>0 ? (current.value.demandIndex / medium.value - 1)*100 : null)
</script>

<template>
  <section class="temporal-chart" :class="{compact}" aria-label="分时相对需求与贡献">
    <div class="temporal-current" aria-live="polite"><span>当前相对需求</span><strong>{{ temporal.available ? number(display) : '资料不足' }}</strong><small>共同峰值＝100</small></div>
    <p class="temporal-cause">{{ !temporal.available ? '资料不完整，不能计算完整需求。' : dominant ? `主要来源：${dominant.label} · 贡献 ${number(dominant.share)}%` : '已知需求为零，暂无活动贡献。' }}</p>
    <svg viewBox="0 0 360 178" role="img" :aria-label="`${selection.day === 'weekday' ? '工作日' : '周末'}24小时需求组成，纵轴为固定共同尺度`">
      <text x="42" y="14">相对需求强度</text>
      <g v-for="tick in [0,50,100]" :key="tick"><path :d="`M42 ${142-tick*1.12}H346`" stroke="#e2e8f0" /><text x="34" :y="146-tick*1.12" text-anchor="end">{{ tick }}</text></g>
      <template v-if="temporal.available"><g v-for="bar in bars" :key="bar.hour"><rect v-for="segment in bar.segments" :key="segment.id" :x="42+bar.hour/24*304+1" :y="segment.y" :width="304/24-2" :height="segment.height" :fill="segment.color" :opacity="bar.hour===selection.hour ? 1 : .7" /></g>
      <g v-if="compare"><polyline v-for="line in comparison" :key="line.id" :points="line.points" fill="none" stroke="#334155" :stroke-width="line.id==='medium'?2:1.5" :stroke-dasharray="line.dash" /></g>
      <path :d="`M${42+(selection.hour+.5)/24*304} 25V145`" stroke="#334155" stroke-width="1" />
      </template>
      <text v-else x="190" y="87" text-anchor="middle">等待完整资料</text>
      <text v-for="tick in [0,8,16,23]" :key="tick" :x="42+(tick+.5)/24*304" y="158" text-anchor="middle">{{ tick }}</text><text x="346" y="175" text-anchor="end">时间（小时）</text>
    </svg>
    <div class="temporal-chart-key"><span v-for="row in contributions" :key="row.id"><i :style="{background:row.color}"></i>{{ row.label }}</span></div>
    <label class="temporal-compare"><input v-model="compare" type="checkbox" :disabled="!temporal.available" />比较低／中／高公共倾向</label>
    <p v-if="compare" class="temporal-note">总需求线：低 ··· ／ 中 ━ ／ 高 ┄；情景比较，不是置信区间。<template v-if="change!=null">当前较中情景 {{ change>0?'+':change<0?'−':'' }}{{ number(Math.abs(change)) }}%。</template></p>
    <div class="temporal-contributions" aria-label="当前小时五类贡献占比"><div v-for="row in contributions" :key="row.id"><span><i :style="{background:row.color}"></i>{{ row.label }}</span><div class="temporal-share-track"><i :style="{background:row.color,width:`${row.share??0}%`}"></i></div><b>{{ row.share==null ? (current.demandIndex===0?'无贡献':'—') : number(row.share)+'%' }}</b></div></div>
    <p v-if="!temporal.available" class="temporal-note">缺少：{{ temporal.missing.map(id=>ACTIVITY_TYPES.find(row=>row.id===id)?.label || id).join('、') || '网格资料' }}。未知不作为零计算。</p>
    <details class="temporal-method"><summary>为什么得到这个结果？</summary>
      <p>每类贡献＝空间强度 × 公共倾向系数 × 小时开始占比 ÷ 100 × {{ ACTIVITY_WEIGHT }}。五类相加得到原始指数 {{ number(current.demandIndex,5) }}。</p>
      <div v-for="row in contributions" :key="row.id" class="temporal-method-row"><b>{{ row.label }}</b><span>{{ number(row.intensity,3) }} × {{ number(row.q,2) }} × {{ number(row.percent,0) }}% × {{ ACTIVITY_WEIGHT }} → {{ number(row.value,5) }}</span></div>
      <p>空间基础：居住使用 GHSL 模型人口密度，其他类别使用采集 POI 密度；按各类全区 P95 标准化，上限为 1。人口未做本地统计校准，POI 不代表实际到访量。</p>
      <p>公共倾向系数和时间曲线为情景假设；系数可大于 1，不是公共充电概率。“公共服务”活动类别与公共充电倾向不同，站点是否对外开放属于供给属性。</p>
      <p>工作日／周末各类曲线均合计 100%，目前只改变日内分布；固定其他参数时，全天累计指数相同。开始时间曲线不代表充电占用或功率负荷。</p>
      <p>100 表示当前完整研究区全部时段与情景的共同峰值，切换地点、小时和情景不重新拉伸；数据版本更新后基准可能变化。指数不是车辆数、订单数或需求满足率。</p>
      <p v-if="Object.values(temporal.benchmarks).some(row=>row.coverage==='insufficient')">部分稀疏类别的全区 P95 为零，使用非零样本 P95 作参考；已知零值仍为零。</p>
    </details>
  </section>
</template>

<style scoped>
.temporal-chart{min-width:0;color:var(--ink-700,#334155);font-size:12px}.temporal-current{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}.temporal-current strong{font-size:28px;color:var(--ink-900,#172033);font-variant-numeric:tabular-nums}.temporal-current small{font-size:10px;color:var(--ink-500,#64748b)}.temporal-cause{margin:4px 0 8px;color:var(--ink-500,#64748b);font-size:11px;line-height:1.6}
.temporal-chart svg{display:block;width:100%;height:auto}.temporal-chart svg text{font-size:11px;fill:#64748b}.temporal-chart-key{display:flex;flex-wrap:wrap;gap:5px 10px;margin:4px 0 9px;font-size:10px}.temporal-chart-key span,.temporal-contributions span{display:flex;align-items:center;gap:5px}.temporal-chart-key i,.temporal-contributions span i{width:8px;height:8px;flex:none;border-radius:2px}
.temporal-compare{display:flex;align-items:center;gap:5px;font-size:11px;margin:8px 0}.temporal-compare input{accent-color:var(--brand-600,#4f46e5)}.temporal-contributions{display:grid;gap:7px;margin:12px 0}.temporal-contributions>div{display:grid;grid-template-columns:75px minmax(0,1fr) 51px;gap:7px;align-items:center;font-size:11px}.temporal-contributions b{text-align:right;font-weight:500;font-variant-numeric:tabular-nums}.temporal-share-track{height:6px;background:#eef2f7;border-radius:4px;overflow:hidden}.temporal-share-track>i{display:block;height:100%}
.temporal-method{margin-top:12px;border-top:1px solid var(--line,#e2e8f0);padding-top:10px;font-size:11px}.temporal-method summary{cursor:pointer;color:var(--brand-600,#4f46e5)}.temporal-method p,.temporal-note{font-size:11px;line-height:1.8;color:var(--ink-500,#64748b);margin:8px 0}.temporal-method-row{display:grid;gap:3px;margin:8px 0;padding:7px;background:var(--surface-muted,#f8fafc);border-radius:6px;overflow-wrap:anywhere}.temporal-method-row b{font-weight:500}.compact .temporal-current strong{font-size:23px}
</style>
