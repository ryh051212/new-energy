<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
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

const selectedHex = ref(null); //当前点击的六边形
const hexDistribution = ref([]);
const loading = ref(true);
const loadError = ref("");
const gridWarning = ref("");
const controller = new AbortController();
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
          id: "weidu-outline",
          type: "line",
          source: "weidu",
          paint: { "line-color": "#0369a1", "line-width": 2 },
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
      ],
    },
  });
  map.on("load", async () => {
    try {
      layerGroups.value.forEach((group) =>
        toggleLayer(group.id, group.visible),
      );
      //地图和 Style 加载完成以后，再执行里面的代码。
      const [weiduGeoJSON, stationsGeoJSON] = await Promise.all([
        readGeoJSON("weidu.json"),
        readGeoJSON("stations.json"),
      ]);
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
      loadStatistics(hexGrid);

      map.on("click", "hexgrid-fill", (e) => {
        // 点到充电站时，只显示站点弹窗，不再弹出网格信息。
        const stations = map.queryRenderedFeatures(e.point, {
          /*/e.point 是鼠标点击位置的屏幕坐标。

  queryRenderedFeatures 用来查询这个位置当前是否渲染了 stations-circle 图层中的充电站。 */
          layers: ["stations-circle"],
        });
        if (stations.length > 0) return;

        const hex = e.features[0];
        selectedHex.value = {
          id: hex.properties.id,
          stationCount: Number(hex.properties.stationCount),
        };
        if (popup) {
          popup.remove();
        } //如果地图上已经有旧弹窗，就先删除，防止多个弹窗同时存在。
        popup = new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setDOMContent(
            popupContent([
              "网格 " + hex.properties.id,
              "充电站数量：" + hex.properties.stationCount,
            ]),
          )
          .addTo(map);
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

    visible: true,
  },

  {
    id: "heatmap",
    label: "密度热力图",

    layerIds: ["stations-heatmap"],

    visible: false,
  },
]);
function highlightHexByStationCount(stationCount) {
  // 先确认高亮图层已经存在
  // 防止地图还没加载完成时调用导致报错
  if (!map.getLayer('hexgrid-highlight')) {
    return
  }

  console.log(
    'MapView 收到 stationCount：',
    stationCount
  )

  // 修改 hexgrid-highlight 的筛选条件
  // 只显示 stationCount 等于用户所选值的六边形
  map.setFilter(
    'hexgrid-highlight',
    [
      '==',
      ['get', 'stationCount'],
      stationCount
    ]
  )
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
      :selected-hex="selectedHex"
      :hex-distribution="hexDistribution"
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
