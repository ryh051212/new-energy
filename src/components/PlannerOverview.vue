<script setup>
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'
import TermHint from './TermHint.vue'
import { summarizePlanningGrid } from '../utils/plannerOverview.js'

const props = defineProps({ features: Array, stations: Array, demandPois: Array, loading: Boolean, error: String,
  distribution: { type: Array, default: () => [] }, highlightedCount: [Number, String], selectedId: [Number, String] })
const emit = defineEmits(['focus-grid', 'plan-grid', 'highlight-count', 'grid-overview', 'show-quadrants', 'start-planning','clear-highlight'])
const ready = computed(() => !props.loading && !props.error)
const summary = computed(() => summarizePlanningGrid(ready.value ? props.features : null))
const stationCount = computed(() => ready.value ? props.stations?.length ?? null : null)
const fastCount = computed(() => ready.value && props.stations?.some(f => ['fast', 'regular'].includes(f.properties?.chargeType))
  ? props.stations.filter(f => f.properties?.chargeType === 'fast').length : null)
const poiCount = computed(() => ready.value ? props.demandPois?.length ?? null : null)
const residential = computed(() => props.demandPois?.filter(f => f.properties?.category === 'residential').length ?? 0)
const commercial = computed(() => props.demandPois?.filter(f => f.properties?.category === 'commercial').length ?? 0)
</script>

<template>
  <div class="planner-overview">
    <div class="overview-metrics" aria-label="规划关键指标">
      <article><span>站点总数</span><strong>{{ stationCount ?? '—' }}</strong><small>{{ fastCount == null ? '类型待核实' : `快充 ${fastCount} 站` }}</small></article>
      <article><span>有站网格占比</span><strong>{{ summary.occupiedShare == null ? '—' : summary.occupiedShare.toFixed(1) + '%' }}</strong><small>{{ summary.occupied == null ? '网格资料不足' : `${summary.occupied} / ${summary.gridCount} 格有站` }}</small></article>
      <article><span>需求点</span><strong>{{ poiCount ?? '—' }}</strong><small :title="`小区 ${residential} · 商业 ${commercial}`">{{ poiCount == null ? '等待数据' : `小区 ${residential} · 商业 ${commercial}` }}</small></article>
    </div>
    <section class="overview-distribution" aria-label="站点分布柱状图">
      <div class="overview-section-title"><h2>站点分布</h2><span>网格数量 / 个</span></div>
      <div v-if="distribution.length && ready" class="distribution-chart" role="group" aria-label="按每个网格的站点数量分类">
        <button v-for="item in distribution" :key="item.stationCount" :class="['chart-column', {active: highlightedCount === item.stationCount}]" :aria-pressed="highlightedCount === item.stationCount" :aria-label="`每格 ${item.stationCount} 个站：${item.hexCount} 个网格`" :title="`${item.stationCount} 站网格：${item.hexCount} 个`" @click="highlightedCount === item.stationCount ? emit('clear-highlight') : emit('highlight-count',item.stationCount)">
          <span class="bar-count">{{ item.hexCount }}</span><span class="bar-track"><span class="bar-fill" :style="{height:Math.max(2,item.hexCount/Math.max(...distribution.map(row=>row.hexCount))*100)+'%'}"></span></span><span class="bar-label">{{ item.stationCount }}</span>
        </button>
      </div>
      <p v-else class="overview-empty">{{ loading ? '正在加载…' : '暂无分布数据。' }}</p>
      <p class="overview-chart-axis">每个网格的站点数量 / 个</p>
      <p v-if="typeof highlightedCount === 'number'" class="overview-chart-selection" role="status">已高亮 {{ distribution.find(item => item.stationCount === highlightedCount)?.hexCount ?? 0 }} 个网格：每格 {{ highlightedCount }} 个站点。<button @click="emit('clear-highlight')">清除高亮</button></p>
      <p v-else class="overview-caption">点击柱子查看地图位置，再次点击清除高亮。</p>
    </section>

    <section class="overview-priorities" aria-label="优先关注区域">
      <div class="overview-section-title"><h2>优先关注</h2><span>高需低供 · 按需求排序</span></div>
      <div v-if="summary.candidates.length" class="candidate-list">
        <article v-for="(feature,index) in summary.candidates" :key="feature.properties.id" :class="{ selected: String(selectedId) === String(feature.properties.id) }">
          <button class="candidate-focus" :aria-label="`定位网格 #${feature.properties.id}`" @click="emit('focus-grid', feature)">
            <span class="candidate-rank">{{ index + 1 }}</span>
            <span><b>网格 #{{ feature.properties.id }}</b><small>需求 {{ feature.properties.demandIndex.toFixed(2) }} · {{ feature.properties.stationCount }} 个站点</small></span>
            <UiIcon name="locate" :size="15" />
          </button>
          <button class="candidate-plan" :aria-label="`以网格 #${feature.properties.id} 开始推演`" @click="emit('plan-grid', feature)">推演</button>
        </article>
      </div>
      <p v-else class="overview-empty" role="status">{{ loading ? '正在读取区域数据…' : error ? '数据暂不可用，加载后显示候选区域。' : !summary.gridCount ? '暂无网格资料。' : '暂无符合条件的高需低供网格。' }}</p>
      <p class="overview-caption">作为补点核查线索，具体建设位置仍需核验。</p>
    </section>

    <details class="overview-details">
      <summary><span>供需分区</span><small>四象限统计</small></summary>
      <div v-if="summary.gridCount" class="overview-quadrant-bar" aria-label="四象限网格占比">
        <span v-for="item in summary.quadrants" :key="item.id" :style="{width: item.count / summary.gridCount * 100 + '%', background: item.color}" :title="`${item.label} ${item.count} 格`"></span>
        <span v-if="summary.unclassified" :style="{width:summary.unclassified / summary.gridCount * 100 + '%',background:'#e2e8f0'}" :title="`未分类 ${summary.unclassified} 格`"></span>
      </div>
      <div class="overview-quadrant-list">
        <div v-for="item in summary.quadrants" :key="item.id"><span><i :style="{background:item.color}"></i>{{ item.label }}</span><b>{{ item.count ?? '—' }}<small> 格</small></b></div>
      </div>
      <p v-if="summary.unclassified" class="overview-caption">另有 {{ summary.unclassified }} 格尚未分类。</p>
      <button class="overview-text-button" :disabled="!summary.gridCount" @click="emit('show-quadrants')">在地图查看分区 <UiIcon name="layers" :size="14" /></button>
    </details>

    <details class="overview-details overview-notes">
      <summary><span>数据与方法</span><UiIcon name="info" :size="14" /></summary>
      <p>有站网格占比仅表示格内是否有站，不代表实际服务覆盖率。需求点为区内居民小区与商业地点。</p>
      <p>候选区域按<TermHint term="quadrant" label="高需低供" />筛选、按<TermHint term="demandIndex" />排序，不代表工程可行性评分。</p>
      <p>站点可能包含演示数据；布局推演可选择已记录点位或包含演示点位。数据缺失显示“—”。</p>
    </details>
    <button class="overview-plan-button" @click="emit('start-planning')"><UiIcon name="plus" :size="16" />自由布局推演</button>
  </div>
</template>

<style scoped>
.overview-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:0 0 20px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
.overview-distribution{padding:18px 0;border-bottom:1px solid var(--line)}
.overview-distribution .distribution-chart{display:flex;align-items:stretch;gap:8px;height:168px;overflow-x:auto;padding:4px 2px 0;border-bottom:1px solid var(--line-strong)}
.overview-distribution .chart-column{display:grid;grid-template-rows:20px 108px 22px;align-content:start;justify-items:center;flex:1 0 27px;min-width:27px;cursor:pointer}
.overview-distribution .bar-track{height:108px;flex:none}
.overview-distribution .bar-fill{background:#5b8dec;width:min(24px,78%)}
.overview-distribution .bar-count{font-size:11px;line-height:16px;color:var(--ink-600);margin:0;padding:0}
.overview-distribution .bar-label{font-size:10px;line-height:22px;padding:0}
.overview-distribution .chart-column.active{background:var(--brand-50)}
.overview-distribution .chart-column:focus-visible{outline:2px solid var(--brand-600);outline-offset:-2px}
.overview-chart-axis{font-size:10px;text-align:center;color:var(--ink-500);margin:9px 0 0}
.overview-chart-selection{font-size:11px;line-height:1.8;color:var(--brand-600);margin:9px 0 0}
.overview-chart-selection button{border:0;padding:0 0 0 5px;color:var(--brand-600);background:none;cursor:pointer;text-decoration:underline}
.overview-metrics article{min-width:0}.overview-metrics span{display:block;font-size:11px;color:var(--ink-500)}.overview-metrics strong{display:block;margin:8px 0 5px;font-size:24px;line-height:1.1;font-weight:650;letter-spacing:-.7px;color:var(--ink-900)}.overview-metrics small{display:block;font-size:9px;color:var(--ink-400);line-height:1.6;overflow-wrap:anywhere}
.overview-priorities{margin:20px 0}.overview-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.overview-section-title h2{font-size:13px;font-weight:650}.overview-section-title>span{font-size:10px;color:var(--ink-500)}
.candidate-list{display:grid;gap:6px}.candidate-list article{display:flex;align-items:center;gap:4px;padding:7px;border:1px solid var(--line);border-radius:9px}.candidate-list article.selected{border-color:var(--brand-200);background:var(--brand-50)}.candidate-focus{display:flex;align-items:center;gap:9px;flex:1;min-width:0;padding:3px 0;border:0;background:transparent;text-align:left}.candidate-focus>span:nth-child(2){flex:1;min-width:0}.candidate-focus b{display:block;font-size:12px;color:var(--ink-800);overflow-wrap:anywhere}.candidate-focus small{display:block;font-size:10px;color:var(--ink-500);margin-top:5px}.candidate-focus>svg{color:var(--ink-400)}.candidate-rank{display:grid;place-items:center;flex:none;width:22px;height:26px;color:var(--ink-400);font-size:11px}.candidate-plan{border:0;border-left:1px solid var(--line);border-radius:0;background:none;color:var(--brand-600);font-size:11px;padding:6px 8px}.candidate-focus:hover b,.candidate-focus:hover>svg{color:var(--brand-600)}.candidate-plan:hover{background:var(--brand-50)}
.overview-caption{font-size:10px;line-height:1.7;color:var(--ink-500);margin:10px 0 0}.overview-empty{padding:14px 0;font-size:11px;line-height:1.8;color:var(--ink-500)}
.overview-details{border-top:1px solid var(--line);padding:0 0 2px}.overview-details summary{display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;list-style:none;font-size:12px;color:var(--ink-700)}.overview-details summary::-webkit-details-marker{display:none}.overview-details summary::after{content:'＋';color:var(--ink-400);margin-left:3px}.overview-details[open] summary::after{content:'−'}.overview-details summary>span{flex:1}.overview-details summary>small{font-size:10px;color:var(--ink-400)}.overview-details summary>svg{color:var(--ink-400)}.overview-details[open]{padding-bottom:12px}.overview-details[open] summary{color:var(--brand-600)}
.overview-quadrant-bar{display:flex;height:6px;overflow:hidden;border-radius:4px;margin:4px 0 14px}.overview-quadrant-list{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}.overview-quadrant-list>div{display:flex;justify-content:space-between;align-items:center;font-size:11px}.overview-quadrant-list span{display:flex;align-items:center;gap:5px;color:var(--ink-500)}.overview-quadrant-list i{width:6px;height:6px;border-radius:50%}.overview-quadrant-list b{font-size:12px;font-variant-numeric:tabular-nums}.overview-quadrant-list small{color:var(--ink-400);font-size:10px;font-weight:400}.overview-text-button{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:10px 0 0;border:0;background:none;color:var(--brand-600);font-size:11px}.overview-text-button:disabled{opacity:.5}.overview-notes p{font-size:11px;line-height:1.9;color:var(--ink-500);margin:0 0 8px}.overview-plan-button{display:flex;justify-content:center;align-items:center;gap:7px;width:100%;margin-top:16px;min-height:38px;border:1px solid var(--brand-200);border-radius:8px;background:var(--brand-50);color:var(--brand-600);font-size:12px}.overview-plan-button:hover{background:var(--brand-100)}.chart-column.active .bar-fill{background:var(--brand-600)}
@media(max-width:1100px){.overview-metrics{gap:8px}.overview-metrics strong{font-size:22px}}
</style>
