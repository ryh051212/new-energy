<script setup>
import {computed} from 'vue'
import {apiUrl} from '../../../shared/api/client.js'
import {locationContext,landuseLabel,referenceSourceLabel,referenceDistance,capacityDescription,safeReferenceUrl} from '../models/sitingContext.js'
const props=defineProps({data:Object,roads:{type:Array,default:()=>[]},coordinates:Array,loading:Boolean,error:String,catalog:Boolean})
const emit=defineEmits(['retry','focus'])
const context=computed(()=>locationContext(props.coordinates,props.data,props.roads))
const metadata=computed(()=>props.data?.metadata)
const focus=row=>emit('focus',row.anchor)
const source=row=>safeReferenceUrl(row.feature.properties.capacitySourceUrl || row.feature.properties.sourceUrl)
const name=(row,fallback)=>row.feature.properties.name || fallback
const documentUrl=doc=>/^\/api\/siting-context\/documents\/[a-z-]+$/.test(doc.url || '')?apiUrl(doc.url):''
</script>

<template>
  <section class="siting-reference-panel" :aria-label="catalog?'公开选址数据与来源':'当前点位公开参考'">
    <header><b>{{ catalog?'公开选址数据':'位置参考' }}</b><small>辅助初筛</small></header>
    <p v-if="loading" class="reference-note" role="status">正在加载公开参考数据…</p>
    <p v-else-if="error" class="reference-error" role="alert">{{ error }} <button @click="emit('retry')">重试</button></p>
    <template v-if="catalog && metadata">
      <p class="reference-note">已接入 {{ metadata.categoryCounts.landuse || 0 }} 个用地要素、{{ metadata.categoryCounts.entrance || 0 }} 条入口记录、{{ metadata.categoryCounts.power || 0 }} 处电力设施。OSM 基准：{{ metadata.osmBaseTimestamp?.slice(0,10) || '未知' }}。</p>
      <p class="reference-note">停车记录可能来自多个来源，数量不代表独立场地总数。</p>
      <div class="reference-documents"><a v-for="doc in metadata.documents" :key="doc.id" :href="documentUrl(doc)" target="_blank" rel="noopener">{{ doc.title }} <small>{{ doc.publishedAt }} · {{ doc.kind }}</small></a></div>
      <div class="reference-documents"><a v-for="link in metadata.sourceLinks" :key="link.url" :href="safeReferenceUrl(link.url)" target="_blank" rel="noopener">{{ link.title }}<small>{{ link.note }}</small></a></div>
      <p class="reference-note">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · 高德地图 · 许昌公开项目资料</p>
    </template>
    <template v-else-if="!catalog && context">
      <article><b>道路与入口</b><div v-if="context.road" class="reference-row"><button @click="focus(context.road)">{{ name(context.road,'未命名道路') }}</button><span>{{ referenceDistance(context.road.meters) }}</span></div><p v-else class="reference-note">附近道路参考尚未载入</p><p v-if="context.road" class="reference-note">{{ ({allowed:'已标注允许通行',restricted:'已标注限制通行',unspecified:'未明确标注机动车通行权限'})[context.road.feature.properties.motorAccess] || '通行条件待核查' }}；距离为到道路线的直线距离。</p><div v-for="row in context.entrances" :key="row.feature.properties.id" class="reference-row"><button @click="focus(row)">{{ name(row,'已标注停车入口') }}</button><span>{{ referenceDistance(row.meters) }}</span></div><small>入口记录不等于场地已获准建站。</small></article>
      <article><b>用地映射</b><div v-for="feature in context.landuse.slice(0,3)" :key="feature.properties.id" class="reference-row"><span>{{ feature.properties.category==='water'?'水域':landuseLabel(feature.properties.landuse) }}</span><a :href="safeReferenceUrl(feature.properties.sourceUrl)" target="_blank" rel="noopener">OSM 来源</a></div><p v-if="!context.landuse.length" class="reference-note">此处没有已载入的用地映射</p><small>用途映射不代表土地权属或建设许可。</small></article>
      <article><b>附近停车资源</b><div v-for="row in context.parking" :key="row.feature.properties.id" class="reference-parking"><div class="reference-row"><button @click="focus(row)">{{ name(row,'未命名停车设施') }}</button><span>{{ referenceDistance(row.meters) }}</span></div><p>{{ capacityDescription(row.feature.properties) }} <a :href="source(row)" target="_blank" rel="noopener">{{ referenceSourceLabel(row.feature) }} / 来源</a></p></div><p v-if="!context.parking.length" class="reference-note">没有已载入的停车记录</p><small>总泊位不等于可增设充电桩泊位，也不是实时空位。</small></article>
      <article><b>电力设施参考</b><div v-for="row in context.power" :key="row.feature.properties.id" class="reference-row"><button @click="focus(row)">{{ name(row,'已标注电力设施') }}</button><span>{{ referenceDistance(row.meters) }}</span></div><small>仅有设备位置，配变可用余量未提供。</small></article>
    </template>
  </section>
</template>

<style scoped>
.siting-reference-panel{margin:14px 0;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--surface);font-size:11px;color:var(--ink-600)}header{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--ink-800)}header small{font-size:10px;color:var(--ink-400)}article{padding:11px 0;border-bottom:1px solid var(--line)}article:last-child{border:0;padding-bottom:0}article>b{display:block;font-size:11px;margin-bottom:7px}article>small{display:block;line-height:1.7;color:var(--ink-400);font-size:10px;margin-top:6px}.reference-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin:6px 0;line-height:1.6}.reference-row button{border:0;background:none;padding:0;text-align:left;color:var(--brand-600);font-size:11px;overflow-wrap:anywhere}.reference-row>span:last-child{flex:none;font-variant-numeric:tabular-nums;font-size:10px}.reference-note{font-size:10px;color:var(--ink-500);line-height:1.8;margin:7px 0}.reference-parking p{font-size:10px;line-height:1.7;margin:2px 0 9px;color:var(--ink-500)}a{color:var(--brand-600);font-size:10px}.reference-error{line-height:1.8;color:#b45309}.reference-error button{border:0;background:none;color:var(--brand-600);cursor:pointer}.reference-documents{display:grid;gap:8px;margin-top:12px}.reference-documents>a{padding:8px;border:1px solid var(--line);border-radius:6px;text-decoration:none;font-size:11px}.reference-documents small{display:block;font-size:10px;color:var(--ink-500);line-height:1.7;margin-top:4px}
</style>
