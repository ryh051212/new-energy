<script setup>
import { stationMetric } from '../utils/charging.js'
import { isDestinationIntent } from '../utils/tripCharging.js'
defineProps({ fit: Object, targetSoc: Number, compact: Boolean, destinationName: { type: String, default: '目的地' } })
const minutes = value => value == null ? '待确认' : `约 ${Math.ceil(value)} 分钟`
const money = value => value == null ? '待确认' : `约 ${value.toFixed(2)} 元`
</script>
<template>
  <div v-if="fit" class="trip-assessment" :class="{ compact }">
    <p class="trip-reachability" :class="{ warning: fit.safety !== 'reachable' || fit.excluded }">{{ fit.safety === 'unreachable' ? '低于保留电量，不建议前往' : fit.excluded ? '不符合本次出行条件' : fit.safety === 'reachable' ? '按路线估算可达' : '可达性待确认' }}<span v-if="fit.arrivalSoc != null && fit.arrivalSoc >= 0"> · 到站约 {{ fit.arrivalSoc }}%</span></p>
    <template v-if="fit.intent === 'urgent'">
      <strong class="trip-main">{{ fit.totalMinutes == null ? '总时间待确认' : minutes(fit.totalMinutes) }}<small>{{ compact ? '总时间 · ' : '' }}{{ targetSoc == null ? '补到目标电量后离开' : `补到 ${targetSoc}% 后离开` }}</small></strong>
      <p v-if="!compact">行驶 {{ minutes(fit.driveMinutes) }} · 等待 {{ minutes(fit.queueMinutes) }} · 补电 {{ minutes(fit.chargeMinutes) }}</p>
    </template>
    <template v-else-if="isDestinationIntent(fit.intent)">
      <strong class="trip-main">{{ fit.walkMeters == null ? '目的地距离待确认' : `距${destinationName || '目的地'}约 ${Math.round(fit.walkMeters)} 米` }}<small>单程直线距离 · 步行路线待确认</small></strong>
      <p>{{ fit.meetsTarget === true ? `停留内预计可补到 ${targetSoc}%` : fit.meetsTarget === false ? `停留内预计仅到 ${fit.projectedSoc}%，未达目标` : '停留内能否补够电待确认' }}</p>
      <p v-if="!compact">活动和往返步行期间可充 {{ minutes(fit.windowMinutes) }} · 排队另计 {{ minutes(fit.queueMinutes) }} · 预计补入 {{ stationMetric(fit.stayChargedEnergyKwh, ' kWh') }}<br />预计停车 {{ minutes(fit.parkingMinutes) }} · 停车费用 {{ money(fit.parkingCost) }}</p>
    </template>
    <template v-else>
      <strong class="trip-main">{{ fit.totalCost == null ? '补能成本待确认' : money(fit.totalCost) }}<small>{{ fit.totalCost == null ? [fit.chargeCost, fit.parkingCost, fit.detourCost].every(value => value == null) ? '费用明细待确认' : `已知费用约 ${fit.knownCost.toFixed(2)} 元，非总价` : '目标补电 + 停车 + 额外绕行' }}</small></strong>
      <p v-if="!compact">充电 {{ money(fit.chargeCost) }} · 停车 {{ money(fit.parkingCost) }} · 绕行 {{ money(fit.detourCost) }}</p>
      <p v-if="!compact">电费 {{ money(fit.electricityCost) }} · 服务费 {{ money(fit.serviceCost) }}<br />额外绕行 {{ stationMetric(fit.extraKm, ' km') }} · 额外能耗 {{ money(fit.extraEnergyCost) }} · 增量道路收费 {{ money(fit.extraTolls) }}</p>
    </template>
    <p v-if="!compact && fit.missing.length" class="trip-missing">待确认：{{ fit.missing.join('、') }}</p>
    <small class="trip-estimate" :title="fit.missing.length ? '待确认：' + fit.missing.join('、') : undefined">{{ fit.hasDemoInputs ? '含演示属性 · ' : '' }}{{ compact ? '估算' : '按填写参数估算' }}{{ compact && fit.missing.length ? ' · 部分信息待确认' : '' }}{{ !compact && fit.queueSource === 'user' ? ' · 排队采用你的假设' : '' }}</small>
  </div>
</template>
<style scoped>
.trip-assessment{padding:11px;margin:10px 0 0;border-radius:9px;background:var(--ok-50);color:var(--ink-700)}.trip-assessment p{font-size:11px;line-height:1.7;margin:6px 0;overflow-wrap:anywhere}.trip-assessment .trip-reachability{color:var(--ok-600);font-weight:600}.trip-assessment .warning,.trip-assessment .trip-missing{color:#92400e}.trip-main{display:block;font-size:16px;color:var(--ink-900);line-height:1.7}.trip-main small{display:block;color:var(--ink-500);font-size:10px;font-weight:400}.trip-estimate{display:block;font-size:10px;color:var(--ink-500);line-height:1.7}.compact .trip-main{font-size:14px}.compact .trip-main small{display:inline;margin-left:8px}.compact .trip-reachability{margin:0 0 4px}.compact .trip-estimate{margin-top:3px}.compact{padding:8px}
</style>
