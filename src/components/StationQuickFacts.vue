<script setup>
import { computed } from 'vue'
import { chargingStationFacts } from '../utils/charging.js'
const props = defineProps({ properties: { type: Object, default: () => ({}) }, fit: { type: Object, default: null }, context: { type: Object, default: () => ({}) }, now: { type: Number, default: () => Date.now() }, compact: Boolean })
const facts = computed(() => chargingStationFacts(props.properties, props.fit, props.context, props.now))
</script>

<template>
  <div class="station-quick-facts" :class="{ compact }">
    <template v-if="compact"><p class="station-compact-route">{{ facts.routeUsable ? '驾车 ' + facts.routeSummary : facts.routeSummary }}</p><p v-if="facts.compatibility.prohibited" class="station-compact-prohibited">禁止充电 · 不符合本车需求</p></template>
    <template v-else>
    <section class="station-information-states" aria-label="站点信息状态">
      <h3>站点信息状态</h3>
      <ul>
        <li v-for="item in facts.informationStates" :key="item.key" :data-information-field="item.key" :data-information-state="item.state">
          <div class="station-information-heading"><b>{{ item.title }}</b><span class="information-state-badge" :class="item.state">{{ item.label }}</span></div>
          <p>{{ item.value }}</p>
          <details><summary>核对说明<span v-if="item.sources.length">与来源</span></summary><small>{{ item.detail }}</small><small v-if="item.checkedTime">资料核对 {{ item.checkedTime }}（未现场核验）</small><div class="station-information-links"><a v-for="source in item.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.label }}</a></div></details>
        </li>
      </ul>
    </section>
    <dl aria-label="站点决策信息，按重要性排序">
      <div class="station-route-fact"><dt>驾车</dt><dd><strong>{{ facts.routeSummary }}</strong><small>{{ facts.routeNote }}</small><small v-if="facts.straightDistance">{{ facts.straightDistance }}</small>
        <section v-if="facts.accessGuide" class="station-access-guide" aria-label="入口与到桩说明">
          <b>入口与到桩</b><span>{{ facts.accessGuide.location }}</span><span>{{ facts.accessGuide.entrance }}</span><small>{{ facts.accessGuide.evidenceLabel }}</small>
          <small v-if="!facts.routeUsable && !facts.accessGuide.routingEntrance">入口坐标未核验，路线仍以站点定位为终点</small>
          <details><summary>进场说明与来源</summary><p>{{ facts.accessGuide.directions }}</p><small>{{ facts.accessGuide.notice }}</small><small>{{ facts.accessGuide.sourceLabel }}</small><small v-if="facts.accessGuide.reviewedTime">资料整理 {{ facts.accessGuide.reviewedTime }}（非现场核验时间）</small><div class="station-access-links"><a v-if="facts.accessGuide.sourceUrl" :href="facts.accessGuide.sourceUrl" target="_blank" rel="noopener noreferrer">查看来源</a><a v-if="facts.accessGuide.amapUrl && facts.accessGuide.amapUrl !== facts.accessGuide.sourceUrl" :href="facts.accessGuide.amapUrl" target="_blank" rel="noopener noreferrer">在高德查看</a></div></details>
        </section>
      </dd></div>
      <div class="station-compatibility-fact" :class="{ prohibited: facts.compatibility.prohibited }"><dt>适配</dt><dd><strong>{{ facts.compatibility.currentType }}</strong><span>{{ facts.compatibility.status }}</span><small>{{ facts.compatibility.note }}</small></dd></div>
      <div class="station-price-fact"><dt>费用</dt><dd><strong>充电单价 {{ facts.price }}</strong><small v-if="facts.feeState.state === 'simulated'" class="demo-note">模拟费用，不作为实际报价</small><small>电费 {{ facts.electricityPrice }} · 服务费 {{ facts.servicePrice }}</small><small>停车费 {{ facts.parkingFee }}</small><small v-if="facts.cost">{{ facts.cost }}</small><small v-else>使用总成本暂无法估算</small></dd></div>
      <div class="station-availability-fact"><dt>排队</dt><dd><strong>{{ facts.availability.status }}</strong><small v-if="facts.availabilityState === 'simulated'" class="demo-note">空闲数量为模拟数据，实际空闲状态未知</small><small>{{ facts.availability.note }}</small><small>{{ facts.availability.updatedAt ? (facts.availability.hasRealtime ? '状态更新 ' : '最近记录 ') + facts.availability.updatedAt : '状态更新时间未知' }}</small></dd></div>
      <div class="station-trust-fact"><dt>核验</dt><dd><span>{{ facts.source }}</span><small>{{ facts.verifiedAt === '核验时间未知' ? facts.verifiedAt : '核验时间 ' + facts.verifiedAt }}</small><small v-if="facts.dataNote" class="demo-note">{{ facts.dataNote }}</small></dd></div>
    </dl>
    </template>
    <p v-if="!compact && facts.chargeTime" class="station-charge-estimate">{{ facts.chargeTime }}（估算）</p>
  </div>
</template>

<style scoped>
.station-quick-facts{margin-top:12px}
.station-information-states{margin-bottom:12px;padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-muted)}.station-information-states h3{margin:0 0 8px;font-size:12px;color:var(--ink-800)}.station-information-states ul{display:grid;gap:8px;list-style:none;margin:0;padding:0}.station-information-states li+li{padding-top:8px;border-top:1px solid var(--line)}.station-information-heading{display:flex;align-items:center;gap:8px;font-size:11px}.information-state-badge{padding:1px 6px;border-radius:4px;font-size:10px;background:var(--surface);color:var(--ink-500)}.information-state-badge.known{background:var(--ok-50);color:var(--ok-600)}.information-state-badge.simulated{background:#fffbeb;color:#92400e}.station-information-states p{margin:4px 0;font-size:11px;line-height:1.7;overflow-wrap:anywhere}.station-information-states details{font-size:10px;color:var(--ink-500);line-height:1.7}.station-information-states summary{cursor:pointer;color:var(--brand-600)}.station-information-states small{display:block;overflow-wrap:anywhere;margin-top:4px}.station-information-links{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:4px}.station-information-links a{color:var(--brand-600);text-decoration:underline;overflow-wrap:anywhere}
.station-quick-facts.compact{margin-top:9px}.station-compact-route{font-size:11px;line-height:1.7;color:var(--ink-600);margin:0}.station-compact-prohibited{font-size:11px;line-height:1.7;color:#b91c1c;font-weight:650;margin:4px 0 0}
dl{display:grid;gap:9px;margin:0}dl>div{display:grid;grid-template-columns:32px minmax(0,1fr);gap:8px;padding-top:9px;border-top:1px solid var(--line)}
dt{font-size:11px;color:var(--ink-500);line-height:1.7}
dd{font-size:12px;line-height:1.7;color:var(--ink-800);margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}dd strong,dd span,dd small{display:block}dd strong{font-size:12px;font-weight:650}dd small{font-size:10px;color:var(--ink-500);line-height:1.7;margin-top:2px}
.station-route-fact strong{font-size:14px;color:var(--ink-900)}.prohibited dd span{color:#b91c1c;font-weight:700}.demo-note{color:#a16207}
.station-access-guide{margin-top:8px;padding:9px 10px;background:var(--brand-50);border-radius:7px;font-size:11px}.station-access-guide>b{display:block;font-size:11px;color:var(--brand-600);margin-bottom:3px}.station-access-guide>span{font-size:11px}.station-access-guide details{margin-top:5px}.station-access-guide summary{cursor:pointer;color:var(--brand-600);font-size:10px}.station-access-guide p{font-size:11px;line-height:1.7;margin:6px 0}.station-access-links{display:flex;flex-wrap:wrap;gap:12px;margin-top:5px}.station-access-links a{color:var(--brand-600);font-size:10px;text-decoration:underline}
.station-charge-estimate{font-size:11px;color:var(--ink-500);line-height:1.6;margin:10px 0 0}
@media(max-width:360px){dl>div{grid-template-columns:28px minmax(0,1fr);gap:6px}}
</style>
