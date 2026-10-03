<script setup>
//搜索框函数
async function searchStation() {
  try {
    if (loading.value || !map) return
    searchError.value = ''
    //去掉输入框前后的空格
    const keyword = stationKeyword.value.trim()
    const url = keyword
      ? `http://127.0.0.1:8000/api/stations?name=${encodeURIComponent(keyword)}`
      : 'http://127.0.0.1:8000/api/stations'
    let features
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const geojson = await response.json()
      controller.signal.throwIfAborted()
      features = geojson.features.filter(station =>
        weiduPolygons.some(polygon => turf.booleanPointInPolygon(station, polygon)))
    } catch (error) {
      if (controller.signal.aborted) throw error
      features = allStationFeatures.value.filter(station =>
        !keyword || station.properties?.name?.includes(keyword))
    }
    //获取已经存在的stations数据
    const stations = map.getSource('stations')
    //更新stations数据
    if (stations) {
      stations.setData({
        type: 'FeatureCollection',
        features,
      })
    }
    if (keyword && features.length === 1 && map.flyTo) {
      map.flyTo({ center: features[0].geometry.coordinates, zoom: 14, duration: 600 })
    }
    searchResultCount.value = features.length
  } catch (error) {
    if (!controller.signal.aborted) {
      searchError.value = '搜索充电站失败，请稍后重试'
      console.error('搜索充电站失败：', error)
    }
  }
}
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import UiIcon from "./UiIcon.vue";
// 让 Vite 同时打包 MapLibre 处理地图数据的 Worker。
maplibregl.setWorkerUrl(workerUrl);
const props = defineProps({ activeRoute: { type: String, default: '/' }, page: { type: Object, default: null } });
const searchInput = ref(null);
// 用户输入的充电站名称
const stationKeyword = ref('')
const mapEl = ref(null);
const weiduStationCount = ref(0);
let map;
let popup;
let weiduPolygons = [];
const stationCount = ref(0); //真实的充电桩数量
const allStationFeatures = ref([]);
const searchResultCount = ref(null);
const activeBasemap = ref('street');
const collapsedSections = ref({});
// ==================== 本次新增的界面状态 ====================
// 测距：是否正在测距、已经点过的坐标、是否显示测距结果面板
const measuring = ref(false);
const measurePoints = ref([]);
const measurePanelOpen = ref(false);
// 快捷图层面板：是否展开、是否显示全部图层（含专题图层）
const quickPanelOpen = ref(false);
const showAllLayers = ref(false);
// 全屏：为 true 时隐藏左右两侧属性栏，让地图铺满
const isFullscreen = ref(false);
// 只看快充：勾上以后地图上只留 chargeType 为 fast 的站点
const fastOnly = ref(false);
const fastCount = computed(() => allStationFeatures.value.filter(item => item.properties?.chargeType === 'fast').length);
const slowCount = computed(() => allStationFeatures.value.filter(item => item.properties?.chargeType === 'slow').length);
const unknownCount = computed(() => allStationFeatures.value.filter(item => !['fast', 'slow'].includes(item.properties?.chargeType)).length);
const hasChargeTypeData = computed(() => fastCount.value + slowCount.value > 0);
const coverageRate = computed(() => hexCount.value ? Math.round(occupiedHexCount.value / hexCount.value * 100) : 0);
const priorityHexes = computed(() => (hexData.value?.features || [])
  .filter(item => item.properties?.supplyDemandType === 'high-demand-low-supply')
  .sort((a, b) => Number(b.properties?.demandIndex || 0) - Number(a.properties?.demandIndex || 0))
  .slice(0, 3));

const hexCount = ref(0); // 六边形总数

const occupiedHexCount = ref(0); //至少有一个充电桩的六边形数量
const residentialCount = ref(0); // 居民小区总数
const commercialCount = ref(0); // 网格内商业设施总数

const selectedHex = ref(null); //当前点击的六边形
// 传给统计图表的“站点数-网格数”分布数据。
const hexDistribution = ref([]);
// 保存加载并处理后的六边形 GeoJSON，供统计和供需分类使用。
const hexData = ref(null);
// 地图数据尚未全部加载完成时为 true。
const loading = ref(true);
// 地图主要数据加载失败时显示的错误信息。
const loadError = ref("");
const searchError = ref("");
// 六边形网格单独加载失败时显示的提示信息。
const gridWarning = ref("");
// 组件卸载时用它取消尚未完成的 GeoJSON 请求。
const controller = new AbortController();
// 从 public/geojson 读取指定文件，并解析为 JavaScript 数据。

async function readGeoJSON(filename) {
  const response = await fetch(
    `${import.meta.env.BASE_URL}geojson/${filename}`,
    {
      signal: controller.signal,
    },
  );
  if (!response.ok) throw new Error(`${filename} 加载失败`);
  const data = await response.json();
  controller.signal.throwIfAborted();
  return data;
}

async function readStations() {
  try {
    const response = await fetch("http://127.0.0.1:8000/api/stations", {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("API 暂不可用");
    const data = await response.json();
    controller.signal.throwIfAborted();
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw error;
    return readGeoJSON("stations.json");
  }
}

function popupContent(lines) {
  const content = document.createElement("div");
  lines.forEach((text) => {
    const line = document.createElement("div");
    line.textContent = text;
    content.append(line);
  });
  return content;
}
onMounted(() => {
  map = new maplibregl.Map({
    container: mapEl.value,
    center: [113.85, 34.04],
    zoom: 11,
    // Style 是绘图配置：sources 提供数据，layers 决定怎样显示。
    style: {
      version: 8,
      sources: {
        streetTiles: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors",
        },
        satelliteTiles: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          attribution: "Tiles © Esri",
        },
        terrainTiles: {
          type: "raster",
          tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenTopoMap contributors",
        },
        weidu: {
          type: "geojson",
          data: `${import.meta.env.BASE_URL}geojson/weidu.json`,
        },
        stations: {
          // 充电站要素
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        hexgrid: {
          // 先放一个空数据，统计完每格的站点数量后再显示。
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        residential: {
          type: "geojson",
          // 读取刚才脚本生成的居民小区 GeoJSON
          data: `${import.meta.env.BASE_URL}geojson/residential-pois.json`,
        },
        commercial: {
          type: "geojson",
          // 读取刚刚生成的商业 POI
          data: `${import.meta.env.BASE_URL}geojson/commercial-pois.json`,
        },
        measure: {
          // 测距工具画的线，先放一个空数据，用户点击测距后再填内容
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },

      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#e8f2f4" },
        },
        { id: "street-base", type: "raster", source: "streetTiles" },
        { id: "satellite-base", type: "raster", source: "satelliteTiles", layout: { visibility: "none" } },
        { id: "terrain-base", type: "raster", source: "terrainTiles", layout: { visibility: "none" } },
        {
          id: "weidu-fill",
          type: "fill",
          source: "weidu",
          paint: { "fill-color": "#2563eb", "fill-opacity": 0.045 },
        },
        {
          id: "hexgrid-fill",
          type: "fill",
          source: "hexgrid",
          paint: {
            // 读取下面用 if 判断得到的颜色。
            "fill-color": ["get", "color"],
            "fill-opacity": 0.65,
          },
        },
        {
          // 专门负责显示“当前被图表选中的六边形”
          id: "hexgrid-highlight",

          type: "fill",

          // 仍然使用原来的 hexgrid 数据
          source: "hexgrid",

          // 默认先匹配一个不存在的值
          // 所以页面刚打开的时候什么都不会高亮
          filter: ["==", ["get", "stationCount"], -1],

          paint: {
            // 高亮填充颜色
            "fill-color": "#f63465",

            // 稍微透明，底下的地图仍然能看见
            "fill-opacity": 0.65,
          },
        },
        {
          // 综合潜在充电需求专题图
          id: "demand-index-fill",

          // 六边形是 Polygon，所以使用 fill
          type: "fill",

          // 继续使用统一的六边形 Source
          source: "hexgrid",

          // 默认关闭，避免与其他专题图互相覆盖
          layout: {
            visibility: "none",
          },

          paint: {
            // 根据每个六边形的 demandIndex 进行分级设色
            "fill-color": [
              "step",

              // 读取当前六边形的综合需求指数
              ["get", "demandIndex"],

              // demandIndex < 0.2
              "#f7fee7",

              // >= 0.2
              0.2,
              "#d9f99d",

              // >= 0.4
              0.4,
              "#bef264",

              // >= 0.6
              0.6,
              "#84cc16",

              // >= 0.8
              0.8,
              "#3f6212",
            ],

            "fill-opacity": 0.75,

            // 六边形边界
            "fill-outline-color": "#94a3b8",
          },
        },
        {
          // =====================================
          // 供需错配专题图
          // =====================================
          id: "mismatch-fill",

          // 六边形是 Polygon
          type: "fill",

          // mismatchIndex 已经存在 hex-grid.json 中
          source: "hexgrid",

          // 默认关闭，避免和其他专题图叠在一起
          layout: {
            visibility: "none",
          },

          paint: {
            // =====================================
            // 根据 mismatchIndex 连续设色
            //
            // 负值：供给相对高
            // 0附近：需求与供给相对接近
            // 正值：需求相对高
            // =====================================
            "fill-color": [
              "interpolate",

              // 线性渐变
              ["linear"],

              // 读取当前六边形的 mismatchIndex
              // 如果不存在，则按0处理
              ["coalesce", ["get", "mismatchIndex"], 0],

              // -1：供给明显高于需求
              -1,
              "#2166ac",

              // -0.4
              -0.4,
              "#67a9cf",

              // 0：相对接近
              0,
              "#f7f7f7",

              // +0.4
              0.4,
              "#ef8a62",

              // +1：需求明显高于供给
              1,
              "#b2182b",
            ],

            "fill-opacity": 0.78,

            // 六边形轮廓
            "fill-outline-color": "#94a3b8",
          },
        },
        {
          // =====================================
          // 供需类型四象限专题图
          // =====================================
          id: "supply-demand-type-fill",

          type: "fill",

          // 分类结果仍然存在统一的 hexgrid Source 中
          source: "hexgrid",

          layout: {
            visibility: "none",
          },

          paint: {
            // 根据 supplyDemandType
            // 给四类网格设置不同颜色
            "fill-color": [
              "match",

              ["get", "supplyDemandType"],

              // 高需求 + 低供给
              // 后续重点关注
              "high-demand-low-supply",
              "#dc2626",

              // 高需求 + 高供给
              "high-demand-high-supply",
              "#f59e0b",

              // 低需求 + 高供给
              "low-demand-high-supply",
              "#2563eb",

              // 低需求 + 低供给
              "low-demand-low-supply",
              "#d1d5db",

              // 防止异常数据没有匹配到
              "#ffffff",
            ],

            "fill-opacity": 0.78,

            "fill-outline-color": "#94a3b8",
          },
        },
        {
          id: "hexgrid-outline",
          type: "line",
          source: "hexgrid",
          paint: { "line-color": "#94a3b8", "line-width": 0.5 },
          layout: {
            //隐藏六边形
            visibility: "visible",
          },
        },
        {
          id: "stations-heatmap",
          type: "heatmap",
          source: "stations",
          maxzoom: 16,
          layout: { visibility: "none" },

          paint: {
            "heatmap-weight": 1,

            "heatmap-intensity": [
              "interpolate", //插值计算
              ["linear"], //线性插值
              ["zoom"], //变量
              8,
              0.8,
              14,
              2,
            ],

            "heatmap-color": [
              "interpolate",
              ["linear"],
              ["heatmap-density"],

              0,
              "rgba(0, 0, 255, 0)",
              0.2,
              "rgb(65, 105, 225)",
              0.4,
              "rgb(0, 255, 255)",
              0.6,
              "rgb(255, 255, 0)",
              0.8,
              "rgb(255, 165, 0)",
              1,
              "rgb(255, 0, 0)",
            ],

            "heatmap-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8, //级别
              15, //半径
              14,
              35,
            ],

            "heatmap-opacity": 0.75,
          },
        },

        {
          // 这个名字以后图层控制会使用
          id: "residential-circle",

          // GeoJSON 中是 Point，所以先用 circle 显示
          type: "circle",

          // 使用刚才创建的 residential Source
          source: "residential",

          paint: {
            // 居民小区只作为辅助需求数据，
            // 圆点不要比充电站更加醒目
            "circle-radius": 4,

            "circle-color": "#8b5cf6",

            "circle-opacity": 0.7,

            "circle-stroke-color": "#ffffff",

            "circle-stroke-width": 1,
          },
        },
        {
          // 商业设施点图层
          id: "commercial-circle",

          type: "circle",

          // 对应上面的 commercial Source
          source: "commercial",

          paint: {
            // 商业 POI 和居民小区区分开
            "circle-radius": 4,

            "circle-color": "#f59e0b",

            "circle-opacity": 0.8,

            "circle-stroke-color": "#ffffff",

            "circle-stroke-width": 1,
          },
        },
        {
          // 居民小区潜在需求六边形图层
          id: "residential-demand-fill",

          // 六边形是 Polygon，所以使用 fill
          type: "fill",

          // 继续使用原来的 hexgrid Source
          source: "hexgrid",

          // 默认关闭
          // 避免它和“六边形供给”同时叠在地图上
          layout: {
            visibility: "none",
          },

          paint: {
            // 根据每个六边形的 residentialCount 分级设色
            "fill-color": [
              "step",

              // 从当前六边形 properties 中读取 residentialCount
              ["get", "residentialCount"],

              // 0个居民小区
              "#f8fafc",

              // >= 1
              1,
              "#ede9fe",

              // >= 3
              3,
              "#c4b5fd",

              // >= 5
              5,
              "#8b5cf6",

              // >= 8
              8,
              "#6d28d9",
            ],

            // 让底图仍然能够看见
            "fill-opacity": 0.7,

            // 给每个六边形简单加边界
            // 这样不需要再专门创建一个 outline Layer
            "fill-outline-color": "#94a3b8",
          },
        },
        {
          id: "stations-circle",
          type: "circle",
          source: "stations",
          paint: {
            "circle-color": [
              "match",
              ["get", "chargeType"],
              "slow",
              "#2563eb",
              "fast",
              "#16a34a",
              "#2563eb",
            ],
            "circle-radius": ["match", ["get", "chargeType"], "slow", 9, 7],
            /*if (chargeType === "slow") {
                    radius = 9;
                  } else {
                    radius = 7;
                  }*/
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        },
        {
          // 充电站头上的白色闪电图标
          // 图标本身要在地图 load 时用 addImage 注册，这里只负责引用
          id: "stations-bolt",
          type: "symbol",
          source: "stations",
          layout: {
            "icon-image": "bolt-icon",
            "icon-size": 0.62,
            // 站点挨得近时也照常显示，不参与避让
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        },
        {
          id: "weidu-outline",
          type: "line",
          source: "weidu",
          paint: { "line-color": "#ef4444", "line-width": 2, "line-dasharray": [2, 2] },
        },
        {
          // 测距折线：把用户点过的点依次连起来
          id: "measure-line",
          type: "line",
          source: "measure",
          // 同一个数据源里既有线也有点，这里只画线
          filter: ["==", ["geometry-type"], "LineString"],
          paint: { "line-color": "#f97316", "line-width": 3, "line-dasharray": [2, 1.2] },
        },
        {
          // 测距顶点：每次点击的位置画一个小圆点
          id: "measure-point",
          type: "circle",
          source: "measure",
          // 这里只画点，不画线
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 5,
            "circle-color": "#ffffff",
            "circle-stroke-color": "#f97316",
            "circle-stroke-width": 2.5,
          },
        },
      ],
    },
  });
  map.on("load", async () => {
    try {
      layerGroups.value.forEach((group) =>
        toggleLayer(group.id, group.visible),
      );
      // 地图加载完才有 addImage，闪电图标在这里注册
      registerBoltIcon();
      map.on("click", "residential-circle", (e) => {
        const residential = e.features?.[0];
        if (!residential) return;

        console.log("居民小区：", residential.properties.name);
        console.log("地址：", residential.properties.address);
      });
      //地图和 Style 加载完成以后，再执行里面的代码。
      const [weiduGeoJSON, stationsGeoJSON, residentialGeoJSON] =
        await Promise.all([
          readGeoJSON("weidu.json"),
          readStations(),
          readGeoJSON("residential-pois.json"),
        ]);

      residentialCount.value = residentialGeoJSON?.features?.length ?? 0;
      map.on("click", "stations-circle", (e) => {
        // 测距时点击只用来取点，不弹站点信息
        if (measuring.value) return;
        const station = e.features?.[0];
        if (!station || !station.geometry) return;

        const properties = station.properties || {};
        const coordinates = station.geometry.coordinates; //經緯度坐標

        // 实例化窗口
        if (popup) {
          popup.remove();
        }
        popup = new maplibregl.Popup()
          .setLngLat(coordinates) //把这个坐标传给 Popup，让弹窗显示在该点的位置。
          .setDOMContent(
            popupContent([
              properties.name || "充电站",
              "地址：" + (properties.address || "暂无"),
              "编码：" + (properties.id ?? "未知"),
              "类型：" + (properties.type || "未记录"),
            ]),
          )
          .addTo(map);
      });

      // 根据坐标判断站点是否在魏都区内，和网格统计使用同一批站点。
      let polygons = [weiduGeoJSON];
      if (weiduGeoJSON.type === "FeatureCollection") {
        polygons = weiduGeoJSON.features;
      }
      weiduPolygons = polygons;
      const weiduStations = [];
      for (const station of stationsGeoJSON.features) {
        for (const polygon of polygons) {
          if (turf.booleanPointInPolygon(station, polygon)) {
            weiduStations.push(station);
            break; // 已经在魏都区内，不需要再判断其他区块。
          }
        }
      }
      map.getSource("stations").setData({
        type: "FeatureCollection",
        features: weiduStations,
      });

      weiduStationCount.value = weiduStations.length;
      stationCount.value = weiduStations.length;
      allStationFeatures.value = weiduStations;

      const bbox = turf.bbox(weiduGeoJSON);

      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        {
          padding: 20,
          duration: 0,
        },
      );
      if (map.getZoom && map.zoomTo) map.zoomTo(map.getZoom() + 0.35, { duration: 0 });
      map.on("mouseenter", "weidu-fill", () => {
        setCursor("pointer");
      });

      map.on("mouseleave", "weidu-fill", () => {
        setCursor("");
      });

      // 读取六边形多边形数据。
      let hexGrid;
      try {
        hexGrid = await readGeoJSON("hex-grid.json");
      } catch (error) {
        if (!controller.signal.aborted)
          gridWarning.value = "网格加载失败，请刷新重试";
        return;
      }

      // 先把每个网格的数量清零，再按当前站点重新统计。
      for (let i = 0; i < hexGrid.features.length; i++) {
        const hex = hexGrid.features[i];
        hex.properties.id = i + 1;
        hex.properties.stationCount = 0;
      }
      for (const station of weiduStations) {
        for (const hex of hexGrid.features) {
          if (turf.booleanPointInPolygon(station, hex)) {
            hex.properties.stationCount += 1;
            break; // 站点落在两个网格的共边上时，也只统计一次。
          }
        }
      }

      // 根据数量设置颜色：0、1、2～3、4～5、6 个及以上。
      for (const hex of hexGrid.features) {
        const count = hex.properties.stationCount;
        if (count === 0) {
          hex.properties.color = "#f1f5f9";
        } else if (count === 1) {
          hex.properties.color = "#bae6fd";
        } else if (count <= 3) {
          hex.properties.color = "#7dd3fc";
        } else if (count <= 5) {
          hex.properties.color = "#38bdf8";
        } else {
          hex.properties.color = "#0284c7";
        }
      }
      map.getSource("hexgrid").setData(hexGrid);
      hexData.value = hexGrid;
      loadStatistics(hexGrid);
      commercialCount.value = hexGrid.features.reduce(
        (total, hex) => total + Number(hex.properties.commercialCount ?? 0),
        0,
      );

      map.on("click", (e) => {
        // 测距时点击只用来取点，不再选中网格
        if (measuring.value) return;
        // 站点有自己的弹窗，点击站点时不切换网格。
        const stations = map.queryRenderedFeatures(e.point, {
          layers: ["stations-circle"],
        });
        if (stations.length > 0) return;

        // 各专题图层共用同一份六边形网格数据。
        const hex = map.queryRenderedFeatures(e.point, {
          layers: [
            "supply-demand-type-fill",
            "mismatch-fill",
            "demand-index-fill",
            "residential-demand-fill",
            "hexgrid-fill",
          ],
        })[0];
        if (hex) {
          const properties = hex.properties ?? {};
          const supplyDemandType = {
            "high-demand-low-supply": "高需求、低供给",
            "high-demand-high-supply": "高需求、高供给",
            "low-demand-high-supply": "低需求、高供给",
            "low-demand-low-supply": "低需求、低供给",
          }[properties.supplyDemandType] ?? "未分类";
          selectedHex.value = {
            id: properties.id,
            stationCount: Number(properties.stationCount ?? 0),
            residentialCount: Number(properties.residentialCount ?? 0),
            commercialCount: Number(properties.commercialCount ?? 0),
            demandIndex: Number(properties.demandIndex ?? 0),
            // 标准化后的相对供给水平
            supplyIndex: Number(properties.supplyIndex ?? 0),
            mismatchIndex: Number(properties.mismatchIndex ?? 0),
            supplyDemandType,
          };
          popup?.remove();
          popup = new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setDOMContent(
              popupContent([
                "网格 " + properties.id,
                "充电站数量：" + (properties.stationCount ?? 0),
                "居民小区数量：" + (properties.residentialCount ?? 0),
                "商业设施数量：" + (properties.commercialCount ?? 0),
                "综合需求指数：" + (properties.demandIndex ?? 0),
                "供给指数：" + (properties.supplyIndex ?? 0),
                "供需错配指数：" + (properties.mismatchIndex ?? 0),
                "供需类型：" + supplyDemandType,
              ]),
            )
            .addTo(map);
          return;
        }

        map.setFilter("hexgrid-highlight", ["==", ["get", "stationCount"], -1]);
        selectedHex.value = null;
        popup?.remove(); //组件
        popup = null;
      });
      map.on("mouseenter", "hexgrid-fill", () => {
        setCursor("pointer");
      });
      map.on("mouseleave", "hexgrid-fill", () => {
        setCursor("");
      });
    } catch (error) {
      if (!controller.signal.aborted)
        loadError.value = "地图数据加载失败，请刷新重试";
    } finally {
      loading.value = false;
      if (!controller.signal.aborted) applyRouteView();
    }
    map.on("click", "commercial-circle", (e) => {
      // 用户当前点击的商业 POI
      const feature = e.features?.[0];

      if (!feature) return;

      console.log("商业设施：", feature.properties);

      // 这里不要新建第二套属性面板
      // 把 feature / properties
      // 传给你现有的属性面板状态即可
    });
  });
});

onBeforeUnmount(() => {
  controller.abort();
  popup?.remove();
  map?.remove();
});
function setBasemap(type) {
  if (!map) return;
  activeBasemap.value = type;
  ['street', 'satellite', 'terrain'].forEach(name => {
    if (map.getLayer(`${name}-base`)) map.setLayoutProperty(`${name}-base`, 'visibility', name === type ? 'visible' : 'none');
  });
}
// 用 canvas 临时画一个白色闪电，注册成地图图标，
// 这样 stations-bolt 图层才能用 icon-image: "bolt-icon" 引用它。
function registerBoltIcon() {
  // 单元测试里的假地图没有 addImage，直接跳过
  if (!map || typeof map.addImage !== 'function') return;
  const size = 24; // 图标画布 24×24，闪电居中
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  // 闪电的顶点坐标和 UiIcon 里的 bolt 图标一致
  ctx.beginPath();
  ctx.moveTo(13, 2);
  ctx.lineTo(4, 13);
  ctx.lineTo(11, 13);
  ctx.lineTo(10, 22);
  ctx.lineTo(20, 10);
  ctx.lineTo(13, 10);
  ctx.closePath();
  ctx.fill();
  map.addImage('bolt-icon', ctx.getImageData(0, 0, size, size));
}
// 只看快充：给站点相关的三个图层统一加/去过滤条件
function toggleFastOnly(checked) {
  fastOnly.value = checked;
  // null 表示不加过滤，恢复显示全部站点
  const filter = checked ? ['==', ['get', 'chargeType'], 'fast'] : null;
  ['stations-circle', 'stations-bolt', 'stations-heatmap'].forEach((layerId) => {
    if (map?.getLayer(layerId)) map.setFilter(layerId, filter);
  });
}
function toggleSection(id) {
  collapsedSections.value[id] = !collapsedSections.value[id];
}
function zoomMap(delta) { map?.zoomTo(map.getZoom() + delta, { duration: 350 }); }
function resetView() {
  if (!map) return;
  map.flyTo({ center: [113.8356, 34.0268], zoom: 11.9, duration: 600 });
}
// 全屏：隐藏左右两侧属性栏，再点一次恢复
function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
  // 侧栏隐藏后地图容器会变宽，等浏览器排好版再让地图重新量一次尺寸
  setTimeout(() => map?.resize(), 0);
}
// ===================== 测距工具 =====================
// 设置鼠标指针样式；测距时十字光标优先，不被悬停效果覆盖
function setCursor(cursor) {
  if (measuring.value) return;
  map.getCanvas().style.cursor = cursor;
}
// 双击时浏览器会先发出两次单击，最后两个点几乎重合，这个距离内的点当成同一个点
const MEASURE_DUPLICATE_KM = 0.03; // 约 30 米
// 1 千米 = 1000 米，用来决定面板显示"米"还是"千米"
const METERS_PER_KILOMETER = 1000;

// 把点过的坐标变成地图要画的数据：一条折线 + 每个点一个圆点
function measureFeatures() {
  const points = measurePoints.value;
  const features = [];
  if (points.length > 1) {
    features.push(turf.lineString(points)); // 折线：把点依次连起来
  }
  points.forEach((point) => {
    features.push(turf.point(point)); // 圆点：标出每次点击的位置
  });
  return features;
}

// 计算总长度，单位千米（不到两个点时长度是 0）
function measureKilometers() {
  const points = measurePoints.value;
  if (points.length < 2) return 0;
  return turf.length(turf.lineString(points), { units: "kilometers" });
}

// 面板里显示的长度文字
const measureText = computed(() => {
  const kilometers = measureKilometers();
  // 不到 1 千米用米，读起来更直观
  if (kilometers < 1) return Math.round(kilometers * METERS_PER_KILOMETER) + " 米";
  return kilometers.toFixed(2) + " 千米";
});

// 操作提示，跟着测距进度变化
const measureHint = computed(() => {
  const count = measurePoints.value.length;
  if (measuring.value) {
    return count < 2 ? "在地图上单击起点，双击结束" : "继续单击加点，双击结束";
  }
  return count < 2 ? "点右侧直尺按钮开始测量" : "已完成测量";
});

// 把最新的点和线交给地图显示
function refreshMeasureLayer() {
  map?.getSource("measure")?.setData({
    type: "FeatureCollection",
    features: measureFeatures(),
  });
}

// 单击地图：记录一个点
function addMeasurePoint(event) {
  measurePoints.value = measurePoints.value.concat([event.lngLat.toArray()]);
  refreshMeasureLayer();
}

// 开始测距：进入测距模式，并清掉上一次的结果
function startMeasure() {
  if (!map) return;
  measuring.value = true;
  measurePanelOpen.value = true;
  measurePoints.value = [];
  refreshMeasureLayer();
  map.getCanvas().style.cursor = "crosshair"; // 十字光标提示正在取点
  map.doubleClickZoom.disable(); // 双击要用来结束测距，先关掉双击缩放
  map.on("click", addMeasurePoint);
  map.on("dblclick", finishMeasure);
}

// 结束测距：画好的线保留，只是不再继续加点
function finishMeasure() {
  if (!map) return;
  // 双击会先产生两次单击，去掉那个几乎重合的多余点
  const points = measurePoints.value;
  if (points.length >= 2) {
    const last = points[points.length - 1];
    const before = points[points.length - 2];
    if (turf.distance(before, last, { units: "kilometers" }) < MEASURE_DUPLICATE_KM) {
      measurePoints.value = points.slice(0, -1);
      refreshMeasureLayer();
    }
  }
  measuring.value = false;
  map.getCanvas().style.cursor = "";
  map.doubleClickZoom.enable();
  map.off("click", addMeasurePoint);
  map.off("dblclick", finishMeasure);
}

// 清除：把点过的点全部删掉，回到地图空白状态
function clearMeasure() {
  measurePoints.value = [];
  refreshMeasureLayer();
}

// 关闭测距面板：结束测距并清空画好的线
function closeMeasurePanel() {
  if (measuring.value) finishMeasure();
  clearMeasure();
  measurePanelOpen.value = false;
}

// 右上角直尺按钮：没在测距就开始，正在测距就结束
function toggleMeasure() {
  if (measuring.value) {
    finishMeasure();
  } else {
    startMeasure();
  }
}
function focusHex(feature) {
  if (!map || !feature) return;
  const center = turf.centerOfMass(feature).geometry.coordinates;
  map.flyTo({ center, zoom: Math.max(map.getZoom(), 13), duration: 600 });
  map.setFilter('hexgrid-highlight', ['==', ['get', 'id'], feature.properties.id]);
}
//图层控制模块
const layerGroups = ref([
  {
    id: "boundary", //程序内部名字
    label: "魏都区边界", //显示给用户看的名字

    layerIds: [
      //包含两个maplibre layer
      "weidu-fill",
      "weidu-outline",
    ],

    visible: true,
  },

  {
    id: "stations",
    label: "充电站",

    // 圆点 + 头上的闪电图标一起开关
    layerIds: ["stations-circle", "stations-bolt"],

    visible: true,
  },

  {
    id: "hexgrid",
    label: "六边形供给",

    layerIds: ["hexgrid-fill", "hexgrid-outline"],

    visible: false,
  },

  {
    id: "heatmap",
    label: "密度热力图",

    layerIds: ["stations-heatmap"],

    visible: true,
  },
  {
    id: "residential",

    label: "居民小区",

    // 对应真正的 MapLibre Layer
    layerIds: ["residential-circle"],

    visible: false,
  },
  {
    id: "commercial",

    label: "商业设施",

    // 控制真正的 MapLibre Layer
    layerIds: ["commercial-circle"],

    visible: false,
  },
  {
    // 控制面板内部ID
    id: "residentialDemand",

    // 用户看到的名字
    label: "居民需求分布",

    // 它真正控制的 MapLibre 图层
    layerIds: ["residential-demand-fill"],

    // 默认关闭
    visible: false,
  },
  {
    id: "demandIndex",

    label: "综合需求分布",

    // 注意这里仍然是 Layer ID
    layerIds: ["demand-index-fill"],

    visible: false,
  },
  {
    id: "mismatch",

    label: "供需错配",

    // 控制真正的 MapLibre Layer
    layerIds: ["mismatch-fill"],

    visible: false,
  },
  {
  id: 'supplyDemandType',

  label: '供需四象限地图',

  layerIds: [
    'supply-demand-type-fill'
  ],

  visible: false
}
]);
function highlightHexByStationCount(stationCount) {
  // 先确认高亮图层已经存在
  // 防止地图还没加载完成时调用导致报错
  if (!map.getLayer("hexgrid-highlight")) {
    return;
  }

  console.log("MapView 收到 stationCount：", stationCount);

  // 修改 hexgrid-highlight 的筛选条件
  // 只显示 stationCount 等于用户所选值的六边形
  map.setFilter("hexgrid-highlight", [
    "==",
    ["get", "stationCount"],
    stationCount,
  ]);
}
function toggleLayer(groupId, visible) {
  const group = layerGroups.value.find((item) => item.id === groupId); //检查图层组

  if (!group) return;

  group.layerIds.forEach((layerId) => {
    if (!map.getLayer(layerId)) {
      return;
    } //检查图层组地图图层

    map.setLayoutProperty(
      //隐藏函数
      layerId,
      "visibility",
      visible ? "visible" : "none",
    );
  });

  group.visible = visible;
}
// ---------------- 快捷图层面板（搜索框下方） ----------------
// 常用图层：面板默认只列这几个
function applyRouteView() {
  if (loading.value || !map) return;
  const views = {
    '/': ['boundary', 'stations', 'heatmap'],
    '/monitoring/stations': ['boundary', 'stations', 'heatmap'],
    '/monitoring/demand': ['boundary', 'stations', 'demandIndex'],
    '/monitoring/supply': ['boundary', 'stations', 'hexgrid'],
    '/monitoring/mismatch': ['boundary', 'stations', 'mismatch'],
    '/planning/problems': ['boundary', 'stations', 'supplyDemandType'],
  };
  const visible = views[props.activeRoute] || views['/'];
  layerGroups.value.forEach(group => toggleLayer(group.id, visible.includes(group.id)));
  collapsedSections.value.types = false;
  selectedHex.value = null;
  popup?.remove();
  if (map.getLayer('hexgrid-highlight')) map.setFilter('hexgrid-highlight', ['==', ['get', 'stationCount'], -1]);
}
watch(() => props.activeRoute, applyRouteView);
const QUICK_LAYER_IDS = ["stations", "residential", "commercial", "hexgrid"];
// 每个图层用哪个图标，左侧"地图设置"和快捷面板共用这一张表
const layerIcons = {
  boundary: "layers",
  stations: "pin",
  heatmap: "bolt",
  hexgrid: "hexagon",
  residential: "home",
  commercial: "building",
  residentialDemand: "home",
  demandIndex: "chart",
  mismatch: "alert",
  supplyDemandType: "chart",
};
// 面板里真正列出来的图层：
// 先按"常用 / 更多"挑出候选，再只留下当前是关闭的（已经打开的不用再切换）
const switchableLayers = computed(() => {
  const ids = showAllLayers.value
    ? layerGroups.value.map((item) => item.id)
    : QUICK_LAYER_IDS;
  return layerGroups.value.filter((item) => ids.includes(item.id) && !item.visible);
});
// 点开 / 收起快捷面板
function toggleQuickPanel() {
  if (quickPanelOpen.value) {
    closeQuickPanelFromOutside();
    return;
  }
  quickPanelOpen.value = true;
  // 面板打开期间才监听整个页面：点到面板外面就自动收起
  document.addEventListener("click", closeQuickPanelFromOutside);
}
// 点到面板以外的地方，收起面板
function closeQuickPanelFromOutside() {
  quickPanelOpen.value = false;
  document.removeEventListener("click", closeQuickPanelFromOutside);
}
// 在面板里点一个图层：把它打开（打开后它会从列表里消失）
function showLayer(groupId) {
  toggleLayer(groupId, true);
}
//右侧属性面板
function loadStatistics(hexData) {
  hexCount.value = hexData.features.length;

  occupiedHexCount.value = hexData.features.filter(
    (hex) => hex.properties.stationCount > 0,
  ).length;
  const countMap = {}; //初始化统计图表
  for (const hex of hexData.features) {
    //遍历六边形的相关数据
    const count = Number(hex.properties.stationCount); //得到每一片六边形的充电桩数量
    countMap[count] = (countMap[count] || 0) + 1;
  }
  hexDistribution.value = Object.entries(countMap) //转换为键值对对象
    .map(([stationCount, hexCount]) => ({
      //充电桩数量,这样的六边形的数量
      stationCount: Number(stationCount),
      hexCount,
    }))
    .sort((a, b) => a.stationCount - b.stationCount);
}
//供需类型数据汇总
// ==========================================
// 统计四种供需类型分别有多少个六边形
// ==========================================
const supplyDemandStats = computed(() => {

  // 初始四种类型都从 0 开始
  const result = {
    highDemandLowSupply: 0,
    highDemandHighSupply: 0,
    lowDemandHighSupply: 0,
    lowDemandLowSupply: 0
  }

  // 如果六边形数据还没加载，就先返回全 0
  if (!hexData.value?.features) {
    return result
  }

  hexData.value.features.forEach((feature) => {

    const type =
      feature.properties?.supplyDemandType

    if (type === 'high-demand-low-supply') {
      result.highDemandLowSupply++
    }

    else if (
      type === 'high-demand-high-supply'
    ) {
      result.highDemandHighSupply++
    }

    else if (
      type === 'low-demand-high-supply'
    ) {
      result.lowDemandHighSupply++
    }

    else if (
      type === 'low-demand-low-supply'
    ) {
      result.lowDemandLowSupply++
    }
  })

  return result
})
/*hexData
↓
170个 Feature
↓
读取 supplyDemandType
↓
分类计数
↓
supplyDemandStats */

</script>
<template>
  <div :class="['dashboard',{ 'map-fullscreen': isFullscreen }]">
    <slot name="header" />
    <main class="workspace">
      <aside class="left-sidebar" aria-label="地图控制">
        <section v-if="page" class="side-card route-context"><span>{{ page.group }}</span><h1>{{ page.title }}</h1><p>{{ page.description }}</p></section>
        <section class="side-card">
          <button class="panel-heading" @click="toggleSection('layers')"><span><UiIcon name="settings" />地图设置</span><UiIcon name="chevron" :class="['heading-chevron',{folded:collapsedSections.layers}]" :size="16" /></button>
          <div v-if="!collapsedSections.layers" class="layer-list">
            <label v-for="group in layerGroups.filter(item => ['boundary','stations','heatmap','hexgrid','residential','commercial'].includes(item.id))" :key="group.id" class="layer-row">
              <input type="checkbox" :checked="group.visible" @change="toggleLayer(group.id, $event.target.checked)" />
              <span :class="['layer-symbol',group.id]"><UiIcon :name="layerIcons[group.id] || 'layers'" :size="16" /></span><span>{{ group.label }}</span>
            </label>
          </div>
        </section>
        <section class="side-card">
          <button class="panel-heading" @click="toggleSection('time')"><span><UiIcon name="clock" />时间选择</span><UiIcon name="chevron" :class="['heading-chevron',{folded:collapsedSections.time}]" :size="16" /></button>
          <div v-if="!collapsedSections.time" class="time-content"><div class="segmented"><a class="selected" href="#/time-analysis">今天</a><a href="#/time-analysis">本周</a><a href="#/time-analysis">本月</a></div><a class="date-display" href="#/time-analysis"><span>时间数据待接入</span><UiIcon name="calendar" :size="17" /></a></div>
        </section>
        <section class="side-card">
          <button class="panel-heading" @click="toggleSection('types')"><span><UiIcon name="bolt" />充电类型</span><UiIcon name="chevron" :class="['heading-chevron',{folded:collapsedSections.types}]" :size="16" /></button>
          <div v-if="!collapsedSections.types" class="type-list"><label :class="['layer-row',{muted:!hasChargeTypeData}]"><input type="checkbox" :checked="fastOnly" :disabled="!hasChargeTypeData" @change="toggleFastOnly($event.target.checked)" /><span class="type-dot fast"><UiIcon name="bolt" :size="14" /></span><span>只看快充</span></label><p class="data-note">{{ hasChargeTypeData ? '已标注 ' + fastCount + ' 个快充站' : unknownCount + ' 个站点暂无充电类型，勾选暂不可用' }}</p></div>
        </section>
        <section class="side-card advanced-card"><button class="panel-heading" @click="toggleSection('advanced')"><span><UiIcon name="layers" />专题图层</span><UiIcon name="chevron" :class="['heading-chevron',{folded:collapsedSections.advanced}]" :size="16" /></button><div v-if="!collapsedSections.advanced" class="layer-list"><label v-for="group in layerGroups.filter(item => !['boundary','stations','heatmap','hexgrid','residential','commercial'].includes(item.id))" :key="group.id" class="layer-row"><input type="checkbox" :checked="group.visible" @change="toggleLayer(group.id, $event.target.checked)" /><span class="layer-symbol thematic"><UiIcon :name="layerIcons[group.id] || 'chart'" :size="16" /></span>{{ group.label }}</label></div></section>
      </aside>
      <section class="map-area" aria-label="魏都区充电设施地图">
        <div ref="mapEl" class="map-canvas"></div>
        <form class="map-search" @submit.prevent="searchStation"><UiIcon name="search" :size="21" /><input ref="searchInput" v-model="stationKeyword" aria-label="搜索充电站" placeholder="搜索充电站名称" /><button type="submit" :disabled="loading">搜索</button></form>
        <div v-if="searchResultCount !== null" class="search-feedback" role="status">找到 {{ searchResultCount }} 个站点 <button aria-label="关闭搜索提示" @click="searchResultCount = null"><UiIcon name="close" :size="14" /></button></div>
        <div class="basemap-switch" aria-label="底图切换"><button v-for="item in [{id:'street',label:'标准'},{id:'satellite',label:'卫星'},{id:'terrain',label:'地形'}]" :key="item.id" :class="['basemap-option',item.id,{chosen:activeBasemap===item.id}]" @click="setBasemap(item.id)"><span class="basemap-preview"></span><span>{{ item.label }}</span></button></div>
        <!-- 右上角工具：图层切换、测距、全屏 -->
        <div class="map-tools map-tools-top" aria-label="地图工具"><button :class="{active:quickPanelOpen}" title="图层切换" aria-label="图层切换" :aria-expanded="quickPanelOpen" aria-controls="map-layer-panel" @click.stop="toggleQuickPanel"><UiIcon name="layers" /></button><button :class="{active:measuring}" title="测距" aria-label="测距" @click="toggleMeasure"><UiIcon name="ruler" /></button><button :class="{active:isFullscreen}" :title="isFullscreen ? '退出全屏' : '全屏'" :aria-label="isFullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen"><UiIcon :name="isFullscreen ? 'compress' : 'expand'" /></button></div>
        <!-- 测距面板：显示总长度和操作提示 -->
        <div v-if="measurePanelOpen" class="measure-panel"><button class="selected-close" aria-label="关闭测距面板" @click="closeMeasurePanel"><UiIcon name="close" :size="15" /></button><b>测距</b><span class="measure-value">{{ measureText }}</span><span class="measure-hint">{{ measureHint }}</span><div class="measure-actions"><button v-if="measuring" @click="finishMeasure">结束</button><button @click="clearMeasure">清除</button></div></div>
        <!-- 快捷图层：平时只显示一个按钮，点开才列出还没打开的图层 -->
          <div v-if="quickPanelOpen" id="map-layer-panel" class="quick-panel map-layer-panel" aria-label="地图图层切换" @click.stop>
            <p class="quick-panel-title">点击打开图层</p>
            <button v-for="group in switchableLayers" :key="group.id" class="quick-layer-row" @click="showLayer(group.id)"><span :class="['filter-icon',group.id]"><UiIcon :name="layerIcons[group.id] || 'layers'" :size="18" /></span>{{ group.label }}</button>
            <p v-if="!switchableLayers.length" class="quick-panel-empty">图层已全部打开</p>
            <button class="quick-more" @click="showAllLayers = !showAllLayers"><UiIcon :name="showAllLayers ? 'minus' : 'plus'" :size="15" />{{ showAllLayers ? '收起' : '更多' }}</button>
          </div>
        <div v-if="loadError || gridWarning || searchError" class="load-message" role="alert"><UiIcon name="alert" :size="17" />{{ loadError || gridWarning || searchError }}</div>
        <div class="map-legend"><h3>图例</h3><div><i class="legend-boundary"></i>魏都区边界</div><div><i class="legend-station"></i>充电站（类型待补充）</div><div><i class="legend-heat"></i>站点密度热力图</div><div class="legend-scale-label">站点密度</div><div class="legend-gradient"></div><div class="legend-range"><span>低</span><span>高</span></div></div>
        <div class="map-tools"><button title="放大" aria-label="放大" @click="zoomMap(1)"><UiIcon name="plus" /></button><button title="缩小" aria-label="缩小" @click="zoomMap(-1)"><UiIcon name="minus" /></button><button title="回到魏都区" aria-label="回到魏都区" @click="resetView"><UiIcon name="locate" /></button></div>
        <div v-if="selectedHex" class="selected-hex"><button class="selected-close" aria-label="关闭网格详情" @click="selectedHex = null"><UiIcon name="close" :size="15" /></button><b>网格 #{{ selectedHex.id }}</b><span>充电站 {{ selectedHex.stationCount }} · 小区 {{ selectedHex.residentialCount }} · 商业 {{ selectedHex.commercialCount }}</span><small>{{ selectedHex.supplyDemandType }}</small></div>
      </section>
      <aside class="right-sidebar" aria-label="数据分析">
        <section class="right-card"><div class="right-heading"><span><UiIcon name="chart" />数据一览</span><small>魏都区</small></div><div class="metrics-grid"><div class="metric"><span class="metric-icon green"><UiIcon name="pin" /></span><div><span>站点总数</span><strong>{{ stationCount }}</strong><small>本地站点数据</small></div></div><div class="metric"><span class="metric-icon red"><UiIcon name="bolt" /></span><div><span>快充站</span><strong>{{ hasChargeTypeData ? fastCount : '—' }}</strong><small>{{ fastCount ? '已标注类型' : '暂无类型数据' }}</small></div></div><div class="metric"><span class="metric-icon blue"><UiIcon name="layers" /></span><div><span>网格覆盖率</span><strong>{{ coverageRate }}%</strong><small>{{ occupiedHexCount }} / {{ hexCount }} 个网格</small></div></div></div></section>
        <section class="right-card chart-card"><div class="right-heading"><span><UiIcon name="chart" />充电设施分布</span><small>网格统计</small></div><p class="section-caption">每个网格内的充电站数量</p><div v-if="hexDistribution.length" class="distribution-chart"><button v-for="item in hexDistribution.slice(0,7)" :key="item.stationCount" class="chart-column" :title="item.stationCount + ' 站网格：' + item.hexCount + ' 个'" @click="highlightHexByStationCount(item.stationCount)"><span class="bar-count">{{ item.hexCount }}</span><span class="bar-track"><span class="bar-fill" :style="{height: Math.max(7,item.hexCount / Math.max(...hexDistribution.map(row=>row.hexCount)) * 100) + '%'}"></span></span><span class="bar-label">{{ item.stationCount }}站</span></button></div><p v-else class="empty-state">网格数据加载中…</p></section>
        <section class="right-card recommendation-card"><div class="right-heading"><span><UiIcon name="pin" />推荐区域</span><small>供需分析</small></div><p class="section-caption">优先关注高需求、低供给网格</p><button v-for="(feature,index) in priorityHexes" :key="feature.properties.id" class="recommendation-row" @click="focusHex(feature)"><span :class="['rank','rank-'+(index+1)]">{{ index+1 }}</span><span class="recommendation-text"><strong>魏都区 · 网格 #{{ feature.properties.id }}</strong><small>需求指数 {{ Number(feature.properties.demandIndex || 0).toFixed(2) }} · 现有站点 {{ feature.properties.stationCount }}</small></span><span class="priority-badge">建议关注</span></button><p v-if="!priorityHexes.length" class="empty-state">暂无符合条件的网格</p></section>
        <section class="right-card forecast-card"><div class="right-heading"><span><UiIcon name="chart" />AI预测</span><a href="#/ai/forecast">查看详情</a></div><p>预测模型尚未接入</p><a href="#/ai/forecast" class="forecast-link">了解预测功能 →</a></section>
      </aside>
    </main>
    <footer class="statusbar"><span><UiIcon name="pin" :size="15" />当前位置：许昌市 魏都区</span><span>数据范围：魏都区 · {{ stationCount }} 个站点</span><span class="status-weather"><UiIcon name="sun" :size="17" /> WebGIS 地图服务</span></footer>
  </div>
</template>
