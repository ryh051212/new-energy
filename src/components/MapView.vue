<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import AnalysisPanel from "./panels/AnalysisPanel.vue";
import LayerControl from "./map/LayerControl.vue";
// 让 Vite 同时打包 MapLibre 处理地图数据的 Worker。
maplibregl.setWorkerUrl(workerUrl);

const mapEl = ref(null);
const weiduStationCount = ref(0);
let map;
let popup;
const stationCount = ref(0); //真实的充电桩数量

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
        weidu: {
          type: "geojson",
          data: `${import.meta.env.BASE_URL}geojson/weidu.json`,
        },
        stations: {
          // 充电站要素
          type: "geojson",
          data: `${import.meta.env.BASE_URL}geojson/stations.json`,
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
      },

      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#f1f5f9" },
        },
        {
          id: "weidu-fill",
          type: "fill",
          source: "weidu",
          paint: { "fill-color": "#38bdf8", "fill-opacity": 0.4 },
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
              "#6b7280",
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
          id: "weidu-outline",
          type: "line",
          source: "weidu",
          paint: { "line-color": "#0369a1", "line-width": 2 },
        },
      ],
    },
  });
  map.on("load", async () => {
    try {
      layerGroups.value.forEach((group) =>
        toggleLayer(group.id, group.visible),
      );
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
          readGeoJSON("stations.json"),
          readGeoJSON("residential-pois.json"),
        ]);

      residentialCount.value = residentialGeoJSON?.features?.length ?? 0;
      map.on("click", "stations-circle", (e) => {
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

      const bbox = turf.bbox(weiduGeoJSON);

      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        {
          padding: 50,
        },
      );
      map.on("mouseenter", "weidu-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "weidu-fill", () => {
        map.getCanvas().style.cursor = "";
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
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "hexgrid-fill", () => {
        map.getCanvas().style.cursor = "";
      });
    } catch (error) {
      if (!controller.signal.aborted)
        loadError.value = "地图数据加载失败，请刷新重试";
    } finally {
      loading.value = false;
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

    layerIds: ["stations-circle"],

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

    visible: false,
  },
  {
    id: "residential",

    label: "居民小区",

    // 对应真正的 MapLibre Layer
    layerIds: ["residential-circle"],

    visible: true,
  },
  {
    id: "commercial",

    label: "商业设施",

    // 控制真正的 MapLibre Layer
    layerIds: ["commercial-circle"],

    visible: true,
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

  visible: true
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
  <div class="map-wrapper">
    <div ref="mapEl" class="map"></div>
    <div class="station-count">魏都区充电站：{{ weiduStationCount }} 个</div>
    <LayerControl :layers="layerGroups" @toggle="toggleLayer" />
    <div v-if="loadError || gridWarning" class="load-message" role="alert">
      {{ loadError || gridWarning }}
    </div>
    <AnalysisPanel
      :station-count="stationCount"
      :hex-count="hexCount"
      :occupied-hex-count="occupiedHexCount"
      :residential-count="residentialCount"
      :commercial-count="commercialCount"
      :selected-hex="selectedHex"
      :hex-distribution="hexDistribution"
      :supply-demand-stats="supplyDemandStats"
      @selectStationCount="highlightHexByStationCount"
    />
  </div>
</template>

<style scoped>
.map-wrapper {
  position: relative;
  width: 100%;
  height: 100vh;
}

.map {
  width: 100%;
  height: 100vh;
  min-height: 400px;
  text-align: left;
}

.station-count {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 1;
  padding: 8px 12px;
  border-radius: 6px;
  background: #ffffff;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18);
  color: #0f172a;
  font-size: 14px;
  font-weight: 600;
}
.load-message {
  position: absolute;
  bottom: 20px;
  left: 16px;
  padding: 10px;
  background: white;
  color: #b91c1c;
  z-index: 10;
}
</style>
