<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { apiFetch } from '../../../shared/api/client.js'
const emit=defineEmits(['show-population'])
const tab=ref('population'),day=ref('weekday'),metadata=ref(null),profiles=ref(null),loading=ref(false),error=ref('')
let controller
async function load(){
  controller?.abort();controller=new AbortController();loading.value=true;error.value=''
  try{
    const responses=await Promise.all(['/api/planning-data/metadata','/api/planning-data/time-profiles'].map(url=>apiFetch(url,{signal:controller.signal})))
    if(responses.some(r=>!r.ok))throw new Error('基础数据暂不可用')
    const [info,time]=await Promise.all(responses.map(r=>r.json()))
    if(controller.signal.aborted)return
    metadata.value=info;profiles.value=time
  }catch(failure){if(failure.name!=='AbortError')error.value='基础数据读取失败，请重试。'}
  finally{if(!controller.signal.aborted)loading.value=false}
}
onMounted(load)
onBeforeUnmount(()=>controller?.abort())
const population=computed(()=>metadata.value?.population)
const curve=computed(()=>profiles.value?.profiles.filter(r=>r.day_type===day.value)||[])
const maximum=computed(()=>Math.max(.01,...(profiles.value?.profiles||[]).map(r=>r.charging_ratio)))
const points=computed(()=>curve.value.map((r,i)=>`${30+i/95*290},${116-r.charging_ratio/maximum.value*92}`).join(' '))
const populationLabel=computed(()=>population.value ? (population.value.estimated_population_sum/10000).toFixed(2)+'万' : '—')
</script>

<template>
  <section class="baseline-panel" aria-label="规划基础数据">
    <nav class="baseline-tabs" aria-label="基础数据内容"><button v-for="[id,label] in [['population','模型人口'],['time','分时曲线'],['sources','数据来源']]" :key="id" :aria-pressed="tab===id" @click="tab=id">{{ label }}</button></nav>
    <p v-if="loading" role="status">正在读取已接入资料…</p><div v-else-if="error" role="alert"><p>{{ error }}</p><button @click="load">重试</button></div>
    <template v-else-if="metadata">
      <div v-show="tab==='population'" class="baseline-page baseline-population">
        <div class="baseline-metrics"><article><span>研究区模型人口</span><strong>{{ populationLabel }}</strong><small>GHSL 2025 预测 · 非普查值</small></article><article><span>人口栅格</span><strong>77 × 92<small>米</small></strong><small>研究区中心近似分辨率</small></article></div>
        <p class="baseline-note">已裁剪到研究区并汇总到网格。单位为每像元估计人数，保留原值，未按“50万人”强行校准。</p>
        <p class="baseline-caution">与政府简介人口口径存在明显差异，目前用于查看空间分布，不直接换算公共充电次数。</p>
        <p v-if="population.unassignedPixels" class="baseline-note">既有网格边缘尚有 {{ population.unassignedPixels }} 个人口像元未归属，未强行分配。</p>
        <button class="baseline-map-action" @click="emit('show-population')">在地图查看模型人口分布 →</button>
      </div>
      <div v-show="tab==='time'" class="baseline-page baseline-time">
        <div class="baseline-day" role="group" aria-label="文献曲线日型"><button :aria-pressed="day==='weekday'" @click="day='weekday'">工作日</button><button :aria-pressed="day==='weekend_holiday'" @click="day='weekend_holiday'">周末 / 节假日</button></div>
        <div class="baseline-chart-title"><b>私人车处于充电状态的比例</b><span>每15分钟</span></div>
        <svg class="baseline-time-chart" viewBox="0 0 340 144" role="img" :aria-label="`${day==='weekday'?'工作日':'周末及节假日'}外部私人车充电状态曲线`"><path d="M30 20V116H320" fill="none" stroke="#dce3ee"/><path d="M30 70H320" stroke="#e8edf5" stroke-dasharray="3 4"/><polyline :points="points" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linejoin="round"/><text x="2" y="25">{{ (maximum*100).toFixed(0) }}%</text><text x="12" y="118">0</text><text x="25" y="136">0时</text><text x="165" y="136">12时</text><text x="303" y="136">24时</text></svg>
        <p class="baseline-note">作者公开数据：2020—2021年其他七座城市的私人车汇总，192个区间。<a href="https://doi.org/10.5281/zenodo.13852045" target="_blank" rel="noopener">查看来源</a></p>
        <p class="baseline-caution">含私人和公共地点充电。这是时点状态比例，不是魏都区公共订单、充电概率或负荷。</p>
      </div>
      <div v-show="tab==='sources'" class="baseline-page">
        <div class="baseline-source-counts"><div><span>五类功能 POI</span><b>{{ metadata.counts.pois.toLocaleString() }} 条</b></div><div><span>真实充电地点</span><b>{{ metadata.stationScope.inside_boundary }} 区内 / {{ metadata.counts.charging-metadata.stationScope.inside_boundary }} 周边</b></div><div><span>OSM 道路</span><b>{{ metadata.counts.roads.toLocaleString() }} 条</b></div><div><span>新增演示补全</span><b>0 条</b></div></div>
        <p class="baseline-note">2026年采集快照。POI和充电地点受接口结果窗口限制，并非完整名录；地点收录不代表公共开放或当前可用。</p>
        <p class="baseline-caution">未知枪数、功率与可用数量均保持未知。建筑轮廓仍缺失，用地与停车记录作为参考。</p>
        <a class="baseline-source-link" href="/api/planning-data/sources" target="_blank" rel="noopener">查看完整数据来源与获取状态 →</a>
      </div>
    </template>
  </section>
</template>

<style scoped>
.baseline-panel{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;color:var(--ink-600);font-size:11px;container-type:size}.baseline-tabs{display:flex;flex:none;gap:5px}.baseline-tabs button{flex:1;min-width:0;padding:7px 2px;border:1px solid var(--line);border-radius:7px;background:white;color:var(--ink-500);font-size:11px;cursor:pointer}.baseline-tabs button[aria-pressed=true]{border-color:var(--brand-200);background:var(--brand-50);color:var(--brand-600)}.baseline-page{display:flex;flex:1;flex-direction:column;gap:12px;min-height:0}.baseline-page[style*="display: none"]{display:none}.baseline-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.baseline-metrics article{padding:12px 9px;border:1px solid var(--line);border-radius:10px;background:var(--surface-muted)}.baseline-metrics span,.baseline-metrics small{display:block;font-size:9px;color:var(--ink-500);line-height:1.5}.baseline-metrics strong{display:block;font-size:22px;margin:8px 0;color:var(--ink-800);font-variant-numeric:tabular-nums}.baseline-metrics strong small{display:inline;font-size:9px;margin-left:4px}.baseline-note,.baseline-caution{font-size:11px;line-height:1.8;margin:0}.baseline-caution{padding:10px;border-radius:8px;background:#fff8eb;color:#95651e}.baseline-map-action{margin-top:auto;padding:10px;border:1px solid var(--brand-200);border-radius:8px;background:var(--brand-50);color:var(--brand-600);font-size:11px;cursor:pointer}.baseline-day{display:flex;gap:6px}.baseline-day button{flex:1;border:1px solid var(--line);border-radius:7px;padding:7px 2px;font-size:10px;color:var(--ink-500);background:white;cursor:pointer}.baseline-day button[aria-pressed=true]{background:var(--brand-50);border-color:var(--brand-200);color:var(--brand-600)}.baseline-chart-title{display:flex;justify-content:space-between;font-size:10px;gap:5px}.baseline-chart-title span{color:var(--ink-400);flex:none}.baseline-time-chart{display:block;width:100%;flex:1;min-height:0;max-height:260px}.baseline-time-chart text{font-size:10px;fill:#8491a7}.baseline-source-counts{display:grid;gap:10px}.baseline-source-counts>div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--line);padding-bottom:10px}.baseline-source-counts b{font-size:11px;color:var(--ink-800)}.baseline-note a,.baseline-source-link{color:var(--brand-600)}button:focus-visible{outline:2px solid var(--brand-400);outline-offset:2px}
@container(max-height:380px){.baseline-page{gap:7px}.baseline-metrics article{padding:7px}.baseline-metrics strong{font-size:18px;margin:5px 0}.baseline-note,.baseline-caution{font-size:9px;line-height:1.6}.baseline-caution{padding:7px}.baseline-map-action{padding:7px}.baseline-source-counts{gap:6px}.baseline-source-counts>div{padding-bottom:6px;font-size:10px}}
</style>
