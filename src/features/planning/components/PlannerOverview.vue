<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import UiIcon from '../../../shared/components/UiIcon.vue'
import { summarizePlanningGrid } from '../models/plannerOverview.js'

const props = defineProps({ features: Array, stations: Array, demandPois: Array, loading: Boolean, error: String,
  distribution: { type: Array, default: () => [] }, highlightedCount: [Number, String], selectedId: [Number, String] })
const emit = defineEmits(['focus-grid', 'plan-grid', 'highlight-count', 'grid-overview', 'start-planning','clear-highlight'])
const ready = computed(() => !props.loading && !props.error)
const summary = computed(() => summarizePlanningGrid(ready.value ? props.features : null))
const stationCount = computed(() => ready.value ? props.stations?.length ?? null : null)
const fastCount = computed(() => ready.value && props.stations?.some(f => ['fast', 'regular'].includes(f.properties?.chargeType))
  ? props.stations.filter(f => f.properties?.chargeType === 'fast').length : null)
const poiCount = computed(() => ready.value ? props.demandPois?.length ?? null : null)
const residential = computed(() => props.demandPois?.filter(f => f.properties?.category === 'residential').length ?? 0)
const commercial = computed(() => props.demandPois?.filter(f => f.properties?.category === 'commercial').length ?? 0)
const tabs = [['distribution', '站点分布'], ['quadrants', '供需分区'], ['priorities', '优先关注'], ['notes', '数据说明']]
const activeTab = ref('distribution'), content = ref(null), contentWidth = ref(300), contentHeight = ref(200)
const candidatePage = ref(0), distributionPage = ref(0), notePage = ref(0)
const candidatePageSize = computed(() => Math.max(1, Math.min(5, Math.floor((contentHeight.value - 65) / 56))))
const candidatePages = computed(() => Math.max(1, Math.ceil(summary.value.candidates.length / candidatePageSize.value)))
const candidates = computed(() => summary.value.candidates.slice(candidatePage.value * candidatePageSize.value, (candidatePage.value + 1) * candidatePageSize.value))
const columnPageSize = computed(() => Math.max(3, Math.floor(contentWidth.value / 32)))
const distributionPages = computed(() => Math.max(1, Math.ceil(props.distribution.length / columnPageSize.value)))
const columns = computed(() => props.distribution.slice(distributionPage.value * columnPageSize.value, (distributionPage.value + 1) * columnPageSize.value))
const maximumCount = computed(() => Math.max(1, ...props.distribution.map(row => row.hexCount)))
const notes = [
  { title: '统计范围', text: '站点分布及原供需指数统计全部已记录地点，包括待核实、暂停和不对外开放记录，不代表有效公共供给。道路研究默认排除待核实地点。类型、枪数和功率未知时保留“—”。' },
  { title: '有站网格占比', text: '按格内是否存在站点统计，不代表实际服务覆盖率。道路覆盖与到站时间请切换至“道路分析”计算。' },
  { title: '优先关注依据', text: '按原供需分区筛选高需低供网格，再按需求指数排序。结果用于补点核查，不代表工程可行性评分，具体位置仍需核验。' },
]
watch(candidatePages, pages => { candidatePage.value = Math.min(candidatePage.value, pages - 1) })
watch(distributionPages, pages => { distributionPage.value = Math.min(distributionPage.value, pages - 1) })
watch(() => props.features, () => { candidatePage.value = 0 })
let observer
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (!entry.contentRect.width || !entry.contentRect.height) return
    contentWidth.value = entry.contentRect.width
    contentHeight.value = entry.contentRect.height
  })
  observer.observe(content.value)
})
onBeforeUnmount(() => observer?.disconnect())
function moveTab(event, index) {
  const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!offset && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length
  activeTab.value = tabs[next][0]
  event.currentTarget.parentElement.children[next].focus()
}
</script>

<template>
  <div class="planner-overview">
    <div class="overview-metrics" aria-label="规划关键指标">
      <article><span>站点总数</span><strong>{{ stationCount ?? '—' }}</strong><small>{{ fastCount == null ? '类型待核实' : `快充 ${fastCount} 站` }}</small></article>
      <article><span>有站网格占比</span><strong>{{ summary.occupiedShare == null ? '—' : summary.occupiedShare.toFixed(1) + '%' }}</strong><small>{{ summary.occupied == null ? '网格资料不足' : `${summary.occupied} / ${summary.gridCount} 格有站` }}</small></article>
      <article><span>需求点</span><strong>{{ poiCount ?? '—' }}</strong><small :title="`小区 ${residential} · 商业 ${commercial}`">{{ poiCount == null ? '等待数据' : `小区 ${residential} · 商业 ${commercial}` }}</small></article>
    </div>
    <nav class="overview-stat-tabs" role="tablist" aria-label="供需统计内容"><button v-for="([id, label], index) in tabs" :id="`statistics-${id}-tab`" :key="id" type="button" role="tab" :aria-selected="activeTab === id" :aria-controls="`statistics-${id}-panel`" :tabindex="activeTab === id ? 0 : -1" @click="activeTab = id" @keydown="moveTab($event, index)">{{ label }}</button></nav>
    <div ref="content" class="overview-stat-content" :class="{'overview-content-compact': contentHeight < 210}">
    <section v-show="activeTab === 'distribution'" id="statistics-distribution-panel" class="overview-distribution overview-stat-page" role="tabpanel" aria-labelledby="statistics-distribution-tab" aria-label="站点分布柱状图">
      <div class="overview-section-title"><h2>站点分布</h2><span>网格数量 / 个</span></div>
      <div v-if="distribution.length && ready" class="distribution-chart" role="group" aria-label="按每个网格的站点数量分类">
        <button v-for="item in columns" :key="item.stationCount" :class="['chart-column', {active: highlightedCount === item.stationCount}]" :aria-pressed="highlightedCount === item.stationCount" :aria-label="`每格 ${item.stationCount} 个站：${item.hexCount} 个网格`" :title="`${item.stationCount} 站网格：${item.hexCount} 个`" @click="highlightedCount === item.stationCount ? emit('clear-highlight') : emit('highlight-count',item.stationCount)">
          <span class="bar-count">{{ item.hexCount }}</span><span class="bar-track"><span class="bar-fill" :style="{height:Math.max(2,item.hexCount/maximumCount*100)+'%'}"></span></span><span class="bar-label">{{ item.stationCount }}</span>
        </button>
      </div>
      <p v-else class="overview-empty">{{ loading ? '正在加载…' : '暂无分布数据。' }}</p>
      <div class="overview-chart-footer"><span>每个网格的站点数量 / 个</span><div v-if="distributionPages > 1" class="overview-pagination" aria-label="分布图分页"><button :disabled="distributionPage === 0" aria-label="上一页分布" @click="distributionPage--">‹</button><span>{{ distributionPage + 1 }} / {{ distributionPages }}</span><button :disabled="distributionPage >= distributionPages - 1" aria-label="下一页分布" @click="distributionPage++">›</button></div></div>
      <p v-if="typeof highlightedCount === 'number'" class="overview-chart-selection" role="status">已高亮 {{ distribution.find(item => item.stationCount === highlightedCount)?.hexCount ?? 0 }} 格 · 每格 {{ highlightedCount }} 站<button @click="emit('clear-highlight')">清除高亮</button></p>
      <p v-else class="overview-caption">点击柱子查看地图位置，再次点击清除高亮。</p>
    </section>

    <section v-show="activeTab === 'priorities'" id="statistics-priorities-panel" class="overview-priorities overview-stat-page" role="tabpanel" aria-labelledby="statistics-priorities-tab" aria-label="优先关注区域">
      <div class="overview-section-title"><h2>优先关注</h2><span>高需低供 · 按需求排序</span></div>
      <div v-if="summary.candidates.length" class="candidate-list">
        <article v-for="(feature,index) in candidates" :key="feature.properties.id" :class="{ selected: String(selectedId) === String(feature.properties.id) }">
          <button class="candidate-focus" :aria-label="`定位网格 #${feature.properties.id}`" @click="emit('focus-grid', feature)">
            <span class="candidate-rank">{{ candidatePage * candidatePageSize + index + 1 }}</span>
            <span><b>网格 #{{ feature.properties.id }}</b><small>需求 {{ feature.properties.demandIndex.toFixed(2) }} · {{ feature.properties.stationCount }} 个站点</small></span>
            <UiIcon name="locate" :size="15" />
          </button>
          <button class="candidate-plan" :aria-label="`以网格 #${feature.properties.id} 开始推演`" @click="emit('plan-grid', feature)">推演</button>
        </article>
      </div>
      <p v-else class="overview-empty" role="status">{{ loading ? '正在读取区域数据…' : error ? '数据暂不可用，加载后显示候选区域。' : !summary.gridCount ? '暂无网格资料。' : '暂无符合条件的高需低供网格。' }}</p>
      <div class="overview-list-footer"><span class="overview-caption">建设位置仍需核验。</span><div v-if="candidatePages > 1" class="overview-pagination" aria-label="关注区域分页"><button :disabled="candidatePage === 0" aria-label="上一页区域" @click="candidatePage--">‹</button><span>{{ candidatePage + 1 }} / {{ candidatePages }}</span><button :disabled="candidatePage >= candidatePages - 1" aria-label="下一页区域" @click="candidatePage++">›</button></div></div>
    </section>

    <section v-show="activeTab === 'quadrants'" id="statistics-quadrants-panel" class="overview-quadrants overview-stat-page" role="tabpanel" aria-labelledby="statistics-quadrants-tab">
      <div class="overview-section-title"><h2>供需分区</h2><span>四象限 · {{ summary.gridCount ?? '—' }} 格</span></div>
      <div v-if="summary.gridCount" class="overview-quadrant-bar" aria-label="四象限网格占比">
        <span v-for="item in summary.quadrants" :key="item.id" :style="{width: item.count / summary.gridCount * 100 + '%', background: item.color}" :title="`${item.label} ${item.count} 格`"></span>
        <span v-if="summary.unclassified" :style="{width:summary.unclassified / summary.gridCount * 100 + '%',background:'#e2e8f0'}" :title="`未分类 ${summary.unclassified} 格`"></span>
      </div>
      <div class="overview-quadrant-list">
        <div v-for="item in summary.quadrants" :key="item.id"><span><i :style="{background:item.color}"></i>{{ item.label }}</span><b>{{ item.count ?? '—' }}<small> 格</small></b></div>
      </div>
      <p v-if="summary.unclassified" class="overview-caption">另有 {{ summary.unclassified }} 格尚未分类。</p>
    </section>

    <section v-show="activeTab === 'notes'" id="statistics-notes-panel" class="overview-notes overview-stat-page" role="tabpanel" aria-labelledby="statistics-notes-tab">
      <div class="overview-section-title"><h2>{{ notes[notePage].title }}</h2><div class="overview-pagination" aria-label="说明分页"><button :disabled="notePage === 0" aria-label="上一条说明" @click="notePage--">‹</button><span>{{ notePage + 1 }} / {{ notes.length }}</span><button :disabled="notePage === notes.length - 1" aria-label="下一条说明" @click="notePage++">›</button></div></div><p>{{ notes[notePage].text }}</p>
    </section>
    </div>
    <button class="overview-plan-button" @click="emit('start-planning')"><UiIcon name="plus" :size="16" />进入布局规划<UiIcon name="arrow-right" :size="15" /></button>
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

.planner-overview{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;gap:14px;container-type:size}
.overview-metrics{flex:none;padding:0;border:0;gap:8px}.overview-metrics article{padding:12px 9px;border:1px solid var(--line);border-radius:10px;background:var(--surface-muted)}.overview-metrics span{font-size:10px}.overview-metrics strong{font-size:25px}.overview-metrics small{font-size:9px;line-height:1.5}
.overview-stat-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));flex:none;border-bottom:1px solid var(--line)}.overview-stat-tabs button{min-width:0;padding:9px 0;border:0;border-bottom:2px solid transparent;background:none;color:var(--ink-500);font-size:11px;cursor:pointer;white-space:nowrap}.overview-stat-tabs button[aria-selected=true]{border-bottom-color:var(--brand-600);color:var(--brand-600);font-weight:650}
.overview-stat-content{flex:1;min-height:0;min-width:0;position:relative}.overview-stat-page{height:100%;min-width:0;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;margin:0;padding:0;border:0}.overview-stat-page[style*="display: none"]{display:none}
.overview-section-title{flex:none;margin:0 0 12px}.overview-section-title h2{font-size:12px;margin:0}
.overview-distribution .distribution-chart{height:auto;flex:1;min-height:0;overflow:visible;gap:6px;padding:2px 0 0}.overview-distribution .chart-column{display:flex;flex-direction:column;justify-content:stretch;align-items:center;flex:1 1 0;min-width:0;border:0;padding:0;background:transparent}.overview-distribution .bar-count{height:18px;flex:none;line-height:18px;font-size:10px}.overview-distribution .bar-track{flex:1;height:auto;min-height:0;width:100%;display:flex;align-items:flex-end;justify-content:center}.overview-distribution .bar-label{height:20px;flex:none;line-height:20px}.overview-distribution .bar-fill{min-height:2px}
.overview-chart-footer,.overview-list-footer{display:flex;align-items:center;justify-content:space-between;gap:6px;flex:none;margin-top:7px;color:var(--ink-500);font-size:10px}.overview-pagination{display:flex;align-items:center;gap:7px;flex:none;font-size:10px;color:var(--ink-500)}.overview-pagination button{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--line);border-radius:6px;background:white;color:var(--brand-600);font-size:17px;cursor:pointer}.overview-pagination button:disabled{opacity:.35;cursor:default}
.overview-caption,.overview-chart-selection{flex:none;margin:8px 0 0;line-height:1.6}.overview-chart-selection{display:flex;justify-content:space-between;gap:5px}.overview-chart-selection button{flex:none;padding:0;font-size:10px}.overview-empty{margin:auto 0;padding:0}
.overview-quadrant-bar{flex:none;height:7px;margin:0 0 14px}.overview-quadrant-list{grid-template-columns:1fr;gap:10px}.overview-quadrant-list>div{gap:6px;padding:10px;border:1px solid var(--line);border-radius:8px}.overview-quadrant-list b{white-space:nowrap}
.candidate-list article{padding:5px}.candidate-focus{gap:7px;padding:2px 0}.candidate-focus b{font-size:11px}.candidate-focus small{margin-top:4px;white-space:nowrap}.candidate-focus>svg{flex:none}.candidate-rank{width:18px;height:auto;font-size:10px}.candidate-plan{flex:none;padding:6px 7px}.overview-list-footer .overview-caption{margin:0}.overview-notes p{line-height:1.9;margin:0;overflow-wrap:anywhere}
.overview-plan-button{flex:none;min-height:36px;margin:0;gap:7px;font-size:11px}.overview-plan-button svg:first-child{margin-right:auto}.overview-plan-button svg:last-child{margin-left:auto}
button:focus-visible{outline:2px solid var(--brand-400);outline-offset:-2px}
.overview-content-compact .overview-section-title{display:none}.overview-content-compact .overview-quadrant-bar{margin-bottom:6px}.overview-content-compact .overview-quadrant-list{gap:4px}.overview-content-compact .overview-quadrant-list>div{padding:4px 7px;border:0;background:var(--surface-muted)}.overview-content-compact .overview-quadrants .overview-caption{margin-top:5px;font-size:9px}.overview-content-compact .overview-notes .overview-section-title{display:flex;margin-bottom:6px}.overview-content-compact .overview-notes p{font-size:10px;line-height:1.7}
@container(max-height:380px){.overview-metrics article{padding:7px}.overview-metrics strong{font-size:20px;margin:5px 0 3px}.overview-metrics small{font-size:8px}.overview-stat-tabs button{padding:6px 0;font-size:10px}.overview-plan-button{min-height:29px}.overview-chart-footer{margin-top:3px}.overview-caption,.overview-chart-selection{margin-top:4px;font-size:9px}}
</style>
