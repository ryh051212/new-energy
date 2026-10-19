<script setup>
import { computed } from 'vue'
import { stationCurrentFacts } from '../utils/cityStations.js'
const props=defineProps({properties:{type:Object,required:true},now:{type:Number,required:true},snapshot:Object,compact:Boolean})
const facts=computed(()=>stationCurrentFacts(props.properties,props.now))
</script>
<template>
  <section class="city-current-facts" :class="{compact}" aria-label="当前站点数据">
    <div class="city-facts-title"><b>站点当前数据</b><span :class="{live:facts.availability.hasRealtime}">{{ facts.availability.hasRealtime?'实时空闲':'空闲状态未知' }}</span></div>
    <dl><div><dt>空闲状态</dt><dd>{{ facts.availability.status }}</dd></div><div><dt>充电价格</dt><dd>{{ facts.priceText }}</dd></div><div><dt>单桩功率</dt><dd>{{ facts.powerText }}</dd></div><div><dt>充电桩数</dt><dd>{{ facts.countText }}</dd></div></dl>
    <template v-if="!compact"><p>{{ facts.currentType }} · {{ facts.opening }}</p><p>电费 {{ facts.electricity===null?'未知':facts.electricity+' 元/度' }} · 服务费 {{ facts.service===null?'未知':facts.service+' 元/度' }}</p><p>停车费 {{ facts.parking===null?'未知':facts.parking+' 元/小时' }}</p></template>
    <small>{{ facts.availability.updatedAt?'最近状态更新 '+facts.availability.updatedAt:'尚无运营方实时状态' }}</small>
    <small v-if="facts.hasAssumedFields">补全或模拟属性不作为真实价格、功率或空闲状态。</small>
    <div v-if="snapshot" class="city-snapshot"><b>场景模拟</b><span>充电 {{ snapshot.charging }} 辆</span><span>空闲 {{ snapshot.free }} 桩</span><span>排队 {{ snapshot.waiting }} 辆</span><small>车辆与空闲桩随模拟时钟变化，非现场实况。</small></div>
  </section>
</template>
