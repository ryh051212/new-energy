<script setup>
import { computed } from 'vue'
import { chargingStationFacts } from '../utils/charging.js'
const props = defineProps({ properties: { type: Object, default: () => ({}) }, fit: { type: Object, default: null } })
const facts = computed(() => chargingStationFacts(props.properties, props.fit))
</script>

<template>
  <div class="station-quick-facts">
    <dl>
      <div><dt>{{ facts.distanceLabel }}</dt><dd>{{ facts.distance }}</dd></div>
      <div><dt>到站时间</dt><dd>{{ facts.arrivalTime }}</dd></div>
      <div><dt>充电价格<small v-if="facts.demoPrice"> · 演示</small></dt><dd>{{ facts.price }}</dd></div>
    </dl>
    <p v-if="facts.chargeTime || facts.cost" class="station-charge-estimate">{{ [facts.chargeTime, facts.cost].filter(Boolean).join(' · ') }}</p>
  </div>
</template>

<style scoped>
.station-quick-facts{margin-top:14px}
dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}
dt{font-size:11px;color:var(--ink-500);margin-bottom:6px;line-height:1.5}
dd{font-size:14px;font-weight:700;line-height:1.6;letter-spacing:-.3px;color:var(--ink-900);margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
dt small{font-size:9px;color:#a16207}
.station-charge-estimate{font-size:11px;color:var(--ink-500);line-height:1.6;margin:10px 0 0}
@media(max-width:360px){dl{gap:5px}dd{font-size:12px}dt{font-size:10px}}
</style>
