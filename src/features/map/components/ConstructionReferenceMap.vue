<script setup>
import { computed, ref } from 'vue'
import data from '../../../../data/processed/weidu-construction-reference.json'
import { constructionReferenceDrawing, GRADE_LABELS, powerVoltageLabel } from '../models/constructionReference.js'

const drawing = constructionReferenceDrawing(data)
const selected = ref(null)
const showZones = ref(true)
const showTransformers = ref(false)
const priceMode = ref('rent')
const selectedZone = computed(() => selected.value?.grade ? selected.value : null)
const selectedStation = computed(() => selected.value?.coordinates ? selected.value : null)
const unit = computed(() => priceMode.value === 'rent' ? '元/㎡·年' : '元/㎡')
const priceName = computed(() => priceMode.value === 'rent' ? '土地收益租金参考' : '出让基准地价参考')
function zoneValue(zone) {
  return priceMode.value === 'rent' ? zone.annualRentReference : zone.landPriceReference
}
</script>

<template>
  <main class="reference-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">许昌市 · 魏都区</p>
        <h1>地价分区与变电站参考图</h1>
        <p class="subtitle">把场地成本和供电位置放在同一张行政边界图上查看</p>
      </div>
      <a class="back-link" href="./">返回项目地图 ↗</a>
    </header>
    <div class="reference-layout">
      <section class="map-section" aria-label="魏都区建设依据地图">
        <div class="map-controls">
          <label>
            <input v-model="showZones" type="checkbox" />
            显示红色地价分区
          </label>
          <label>
            <input v-model="showTransformers" type="checkbox" />
            显示变压器
          </label>
          <label class="price-select">
            价格口径
            <select v-model="priceMode">
              <option value="rent">年收益租金</option>
              <option value="land">出让基准地价</option>
            </select>
          </label>
        </div>
        <div class="map-scroll" tabindex="0" aria-label="参考地图，窄屏可横向滑动查看">
          <svg
            class="reference-map"
            viewBox="0 0 1000 760"
            role="img"
            aria-labelledby="map-title map-description"
          >
            <title id="map-title">魏都区行政边界、商业用地草案级别与变电站</title>
            <desc id="map-description">黑线为项目魏都区行政边界，红线为2024年商业用地征求意见稿分区的近似数字化范围，蓝色圆点为7条OSM变电站记录。点击分区和点位查看资料。价格为政策参考，实际场租和配变余量待核实。</desc>
            <defs>
              <clipPath id="district-clip">
                <path :d="drawing.boundaryPath" fill-rule="evenodd" />
              </clipPath>
            </defs>
            <rect width="1000" height="760" fill="#ffffff" />
            <g class="map-key" font-size="14" fill="#526174">
              <path d="M32 28H57" stroke="#202936" stroke-width="3" />
              <text x="66" y="33">魏都区边界</text>
              <path d="M206 28H231" stroke="#d94444" stroke-width="2" />
              <text x="240" y="33">地价级别草案边界</text>
              <circle
                cx="465"
                cy="28"
                r="6"
                fill="#1173df"
              />
              <text x="480" y="33">变电站</text>
              <text x="968" y="33" text-anchor="end">{{ priceName }} · {{ unit }}</text>
            </g>
            <path :d="drawing.boundaryPath" fill="#f7f9fc" fill-rule="evenodd" />
            <g v-if="showZones" clip-path="url(#district-clip)">
              <path
                v-for="zone in drawing.zones"
                :key="zone.id"
                :d="zone.path"
                :fill="selected?.id === zone.id ? '#fbd3cf' : '#fff4f1'"
                fill-rule="evenodd"
                stroke="#d94444"
                stroke-width="1.7"
                stroke-linejoin="round"
                class="zone-area"
                role="button"
                tabindex="0"
                :aria-label="`${GRADE_LABELS[zone.grade - 1]}级，${zoneValue(zone)}${unit}，草案范围`"
                @click="selected=zone"
                @keydown.enter="selected=zone"
                @keydown.space.prevent="selected=zone"
              />
              <g
                v-for="zone in drawing.zones"
                :key="`label-${zone.id}`"
                class="zone-label"
                :transform="`translate(${zone.x},${zone.y})`"
                pointer-events="none"
                text-anchor="middle"
                fill="#b72d36"
                font-weight="600"
                font-size="16"
                stroke="#fff"
                stroke-width="4"
                paint-order="stroke"
              >
                <text>{{ GRADE_LABELS[zone.grade-1] }}级 · {{ zoneValue(zone) }}</text>
              </g>
            </g>
            <path
              :d="drawing.boundaryPath"
              fill="none"
              stroke="#202936"
              stroke-width="3.3"
              stroke-linejoin="round"
              fill-rule="evenodd"
              pointer-events="none"
            />
            <g v-if="showTransformers">
              <g
                v-for="station in drawing.transformers"
                :key="station.id"
                :transform="`translate(${station.position.join(',')})`"
                role="button"
                tabindex="0"
                aria-label="变压器，点击查看来源"
                class="station-mark"
                @click="selected=station"
                @keydown.enter="selected=station"
                @keydown.space.prevent="selected=station"
              >
                <circle r="16" fill="transparent" />
                <rect
                  x="-4"
                  y="-4"
                  width="8"
                  height="8"
                  fill="#a66a1c"
                  stroke="#fff"
                  stroke-width="1.5"
                />
              </g>
            </g>
            <g
              v-for="station in drawing.substations"
              :key="station.id"
              :transform="`translate(${station.position.join(',')})`"
              role="button"
              tabindex="0"
              :aria-label="`${station.label} 变电站，${powerVoltageLabel(station.voltage)}`"
              class="station-mark"
              @click="selected=station"
              @keydown.enter="selected=station"
              @keydown.space.prevent="selected=station"
            >
              <circle
                v-if="selected?.id === station.id"
                r="15"
                fill="#1173df"
                fill-opacity=".18"
              />
              <circle r="18" fill="transparent" />
              <circle
                r="7"
                fill="#1173df"
                stroke="#fff"
                stroke-width="2"
              />
              <text
                x="12"
                y="5"
                fill="#075ab7"
                font-weight="600"
                font-size="15"
                stroke="#fff"
                stroke-width="4"
                paint-order="stroke"
              >{{ station.label }}</text>
            </g>
            <g transform="translate(925,82)" fill="#526174">
              <text
                x="0"
                y="0"
                text-anchor="middle"
                font-size="14"
              >N</text>
              <path d="M0 12L-7 35L0 28L7 35Z" />
            </g>
            <g transform="translate(40,704)" fill="#526174" font-size="13">
              <path
                :d="`M0 0V6H${drawing.scaleBarWidth}V0`"
                fill="none"
                stroke="#526174"
                stroke-width="2"
              />
              <text x="0" y="24">0</text>
              <text :x="drawing.scaleBarWidth" y="24" text-anchor="middle">约 1 km</text>
            </g>
            <text
              x="968"
              y="711"
              text-anchor="end"
              fill="#ab343e"
              font-size="13"
            >红线：征求意见稿数字化范围 · 最终级别待核实</text>
            <text
              x="968"
              y="734"
              text-anchor="end"
              fill="#657386"
              font-size="12"
            >原图配准近似位置，仅供区域浏览；未覆盖处保留未知</text>
          </svg>
        </div>
        <p class="map-caption">分区内数字采用右上角所选价格口径。点位使用真实记录坐标；S01–S07 是浏览编号，站名尚未核实。</p>
      </section>
      <aside class="reference-sidebar">
        <section class="detail-panel" aria-live="polite">
          <p class="section-kicker">点击地图查看</p>
          <template v-if="selectedStation">
            <h2>
              {{ selectedStation.label || '变压器' }}
              <span>· {{ selectedStation.name || '名称待核实' }}</span>
            </h2>
            <dl>
              <div>
                <dt>设施类型</dt>
                <dd>{{ selectedStation.kind==='substation' ? '变电站记录' : '变压器记录' }}</dd>
              </div>
              <div>
                <dt>标注电压</dt>
                <dd>{{ powerVoltageLabel(selectedStation.voltage) }}</dd>
              </div>
              <div>
                <dt>额定容量</dt>
                <dd>待核实</dd>
              </div>
              <div>
                <dt>可接入余量</dt>
                <dd>待供电单位核实</dd>
              </div>
              <div>
                <dt>WGS84 坐标</dt>
                <dd>{{ selectedStation.coordinates.map(value=>value.toFixed(6)).join(', ') }}</dd>
              </div>
            </dl>
            <a :href="selectedStation.sourceUrl" target="_blank" rel="noopener noreferrer">查看 OSM 原记录 ↗</a>
          </template>
          <template v-else-if="selectedZone">
            <h2>{{ GRADE_LABELS[selectedZone.grade - 1] }}级商业用地参考</h2>
            <p class="selected-price">
              {{ zoneValue(selectedZone) }}
              <small>{{ unit }}</small>
            </p>
            <p>{{ priceName }}，采用2024年正式公布表。此处分区由征求意见稿图件数字化，最终范围与级别对应关系待核实。</p>
            <p>实际场地租金、租期和是否允许建设充电设施，需按具体场地核实。</p>
          </template>
          <template v-else>
            <h2>蓝点看供电，红线看地价</h2>
            <p>点击蓝色点位查看位置、电压与来源；点击红色分区查看该级别的价格参考。</p>
            <p class="important-note">商业用地价格仅作对照，不自动认定拟建场地的土地用途。</p>
          </template>
        </section>
        <section class="grade-table">
          <h2>
            {{ priceName }}
            <small>{{ unit }}</small>
          </h2>
          <table>
            <thead>
              <tr>
                <th>商业用地级别</th>
                <th>参考值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="zone in drawing.zones" :key="zone.id" :class="{chosen:selected?.id===zone.id}">
                <td>
                  <button @click="selected=zone">{{ GRADE_LABELS[zone.grade-1] }}级</button>
                </td>
                <td>{{ zoneValue(zone) }}</td>
              </tr>
            </tbody>
          </table>
          <p>收益租金标准与场地方实际报价分别记录，不能据此直接计算真实项目回报。</p>
        </section>
        <details class="source-panel">
          <summary>资料来源与精度</summary>
          <ul>
            <li>行政边界：项目数据库 WGS84 只读快照。</li>
            <li>蓝色点位：{{ drawing.substations.length }} 条变电站记录，另有 {{ drawing.transformers.length }} 条变压器记录，OSM 数据基准为2026-07-15；记录可能属于同一场所。</li>
            <li>红线：2024-01-30 商业用地地价图（征求意见稿），按图廓坐标配准并裁剪到魏都区。原图未明示投影，采用 CGCS2000 三度带38假设，仅供近似浏览。</li>
            <li>价格：2024-04-11 正式公布表；没有用草案价格代替正式参考值。</li>
          </ul>
          <a :href="data.metadata.draftSourceUrl" target="_blank" rel="noopener noreferrer">官方草案来源 ↗</a>
          <a :href="data.metadata.originalMap" target="_blank" rel="noopener noreferrer">打开原始分区图 ↗</a>
          <a :href="data.metadata.priceSourceUrl" target="_blank" rel="noopener noreferrer">正式价格表来源 ↗</a>
        </details>
      </aside>
    </div>
    <footer>许昌市自然资源和规划局 · 项目行政边界 · © OpenStreetMap contributors ｜ 建设研究参考，非测绘或接电审批依据</footer>
  </main>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: #eef2f7;
  color: #233248;
  font-family: Inter,"Microsoft YaHei","PingFang SC",sans-serif;
}
button,input,select {
  font: inherit;
}
button,a,input,select {
  touch-action: manipulation;
}
button,a {
  cursor: pointer;
}
button:focus-visible,a:focus-visible,select:focus-visible,[tabindex]:focus-visible {
  outline: 3px solid #78aef5;
  outline-offset: 3px;
}
.reference-page {
  max-width: 1520px;
  margin: auto;
  padding: 32px 36px 20px;
}
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  margin-bottom: 24px;
}
.eyebrow {
  color: #1768d4;
  font-size: 13px;
  letter-spacing: 2px;
  margin: 0 0 9px;
}
h1 {
  font-size: 27px;
  line-height: 1.4;
  margin: 0;
  font-weight: 650;
}
.subtitle {
  color: #728095;
  font-size: 13px;
  margin: 9px 0 0;
}
.back-link {
  font-size: 13px;
  color: #1768d4;
  text-decoration: none;
  white-space: nowrap;
}
.reference-layout {
  display: grid;
  grid-template-columns: minmax(0,1fr) 310px;
  gap: 22px;
  align-items: start;
}
.map-section {
  background: white;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 5px 24px #20355108;
}
.map-controls {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  padding: 18px 22px;
  border-bottom: 1px solid #e9edf3;
  color: #526174;
  font-size: 12px;
}
.map-controls label {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
}
.map-controls input {
  accent-color: #1768d4;
}
.price-select {
  margin-left: auto;
}
.price-select select {
  padding: 6px;
  border: 1px solid #dce3ec;
  border-radius: 6px;
  color: #233248;
  background: white;
}
.reference-map {
  display: block;
  width: 100%;
  height: auto;
  font-family: "Microsoft YaHei","PingFang SC",sans-serif;
}
.map-scroll {
  overflow-x: auto;
}
.zone-area,.station-mark {
  cursor: pointer;
}
.zone-area:hover {
  fill: #fde1db;
}
.station-mark:hover>circle:last-of-type {
  r: 9;
}
.map-caption {
  margin: 0;
  padding: 0 22px 20px;
  color: #728095;
  font-size: 12px;
  line-height: 1.7;
}
.reference-sidebar {
  display: grid;
  gap: 16px;
}
.detail-panel,.grade-table,.source-panel {
  background: #fff;
  padding: 21px;
  border-radius: 13px;
}
.section-kicker {
  margin: 0 0 11px;
  color: #1768d4;
  font-size: 11px;
  letter-spacing: 1px;
}
h2 {
  font-size: 15px;
  line-height: 1.6;
  margin: 0 0 12px;
}
h2 span {
  font-size: 12px;
  font-weight: 400;
}
h2 small {
  display: block;
  color: #728095;
  font-weight: 400;
  font-size: 11px;
}
.reference-sidebar p,.source-panel li {
  font-size: 12px;
  line-height: 1.8;
  color: #6a7789;
}
.reference-sidebar a {
  display: inline-block;
  color: #1768d4;
  font-size: 12px;
  line-height: 1.9;
  text-decoration: none;
}
.reference-sidebar dl {
  margin: 0 0 13px;
  font-size: 12px;
}
.reference-sidebar dl>div {
  display: flex;
  gap: 15px;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid #f0f3f7;
}
.reference-sidebar dt {
  color: #728095;
  flex: none;
}
.reference-sidebar dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}
.reference-sidebar .important-note {
  color: #9a6334;
}
.selected-price {
  font-size: 32px!important;
  color: #b72d36!important;
  margin: 8px 0!important;
  line-height: 1.2!important;
}
.selected-price small {
  display: inline-block;
  font-size: 12px;
  margin-left: 8px;
}
.grade-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.grade-table th {
  font-weight: 400;
  color: #8a96a7;
  padding: 0 0 8px;
  text-align: left;
}
.grade-table th:last-child,.grade-table td:last-child {
  text-align: right;
}
.grade-table td {
  padding: 7px 0;
  border-top: 1px solid #f0f3f7;
  font-variant-numeric: tabular-nums;
}
.grade-table button {
  border: 0;
  background: none;
  color: #b72d36;
  padding: 3px 10px 3px 0;
}
.grade-table .chosen td {
  color: #b72d36;
  font-weight: 600;
}
.grade-table p {
  margin-bottom: 0;
  font-size: 11px;
}
.source-panel {
  padding: 16px 21px;
}
.source-panel summary {
  cursor: pointer;
  font-size: 12px;
}
.source-panel ul {
  padding-left: 16px;
}
.source-panel a {
  display: block;
  margin-top: 7px;
}
footer {
  color: #8b97a7;
  font-size: 11px;
  line-height: 1.8;
  margin-top: 18px;
}
@media(min-width:1500px) {
  .reference-sidebar {
    gap: 18px;
  }
  .map-caption {
    font-size: 13px;
  }
}
@media(max-width:1050px) {
  .reference-page {
    padding: 22px 18px;
  }
  .reference-layout {
    grid-template-columns: minmax(0,1fr) 270px;
    gap: 14px;
  }
  .map-controls {
    gap: 10px;
    padding: 12px;
  }
  .price-select {
    margin-left: 0;
  }
  .detail-panel,.grade-table {
    padding: 16px;
  }
  h1 {
    font-size: 23px;
  }
}
@media(max-width:760px) {
  .reference-map {
    min-width: 740px;
  }
  .reference-page {
    padding: 20px 12px;
  }
  .page-heading {
    align-items: start;
    gap: 10px;
    margin-bottom: 16px;
  }
  h1 {
    font-size: 20px;
  }
  .subtitle {
    font-size: 12px;
  }
  .back-link {
    font-size: 11px;
    margin-top: 8px;
  }
  .reference-layout {
    grid-template-columns: 1fr;
  }
  .reference-sidebar {
    grid-template-columns: 1fr;
  }
  .map-caption {
    font-size: 11px;
    padding: 0 14px 16px;
  }
  .map-controls {
    font-size: 12px;
    gap: 7px 16px;
  }
  .map-controls label {
    min-height: 36px;
  }
  .price-select select {
    font-size: 16px;
    max-width: 155px;
  }
  .reference-map text {
    font-weight: 500;
  }
  .source-panel {
    padding: 16px;
  }
  footer {
    font-size: 10px;
  }
}
</style>
