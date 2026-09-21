<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import LayerControl
  from './map/LayerControl.vue'
// 让 Vite 同时打包 MapLibre 处理地图数据的 Worker。
maplibregl.setWorkerUrl(workerUrl);

const mapEl = ref(null);
const weiduStationCount = ref(0);
let map;
let popup;

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
          id: "hexgrid-outline",
          type: "line",
          source: "hexgrid",
          paint: { "line-color": "#94a3b8", "line-width": 0.5 },
          layout: {
            //隐藏六边形
            visibility: "none",
          },
        },
        {
          id: "stations-heatmap",
          type: "heatmap",
          source: "stations",
          maxzoom: 16,

          paint: {
            "heatmap-weight": 1,

            "heatmap-intensity": [
              "interpolate",//插值计算
              ["linear"],//线性插值
              ["zoom"],//变量
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
              8,//级别
              15,//半径
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
    //地图和 Style 加载完成以后，再执行里面的代码。
    const [boundaryResponse, stationsResponse] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}geojson/weidu.json`),
      fetch(`${import.meta.env.BASE_URL}geojson/stations.json`),
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
        .setHTML(
          `
    <div style="
      padding: 12px 14px;
      background: #ffffff;
      border-radius: 10px;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
      border: 1px solid #e5e7eb;
      color: purple;
      font-size: 14px;
      line-height: 1.7;
    ">
      <div style="font-size:15px; font-weight:700; color:pink; margin-bottom:6px;">
        ${properties.name || "充电站"}
      </div>
      地址：${properties.address || "暂无"}
      <br>
      编码：${properties.id || "未知"}<br>
      类型：${properties.type || "未記錄"}
    </div>
  `,
        )
        .addTo(map);
    });

    const weiduGeoJSON = await boundaryResponse.json(); //边界数据
    const stationsGeoJSON = await stationsResponse.json(); //地址传输充电桩的json数据
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
    console.log(`当前魏都区充电站数量：${weiduStationCount.value}`);

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
    map.on("click", "weidu-fill", (e) => {
      //给魏都区加点击事件

      console.log(e.features[0].properties);
    });
    map.on("mouseenter", "weidu-fill", () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", "weidu-fill", () => {
      map.getCanvas().style.cursor = "";
    });

    // 读取六边形多边形数据。
    const hexResponse = await fetch(
      `${import.meta.env.BASE_URL}geojson/hex-grid.json`,
    );
    const hexGrid = await hexResponse.json();

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

    map.on("click", "hexgrid-fill", (e) => {
      // 点到充电站时，只显示站点弹窗，不再弹出网格信息。
      const stations = map.queryRenderedFeatures(e.point, {
        layers: ["stations-circle"],
      });
      if (stations.length > 0) return;

      const hex = e.features[0];
      if (popup) {
        popup.remove();
      }
      popup = new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `
          <div style="padding: 12px; color: #334155; line-height: 1.7;">
            <strong>网格 ${hex.properties.id}</strong><br>
            充电站数量：${hex.properties.stationCount}
          </div>
        `,
        )
        .addTo(map);
    });
    map.on("mouseenter", "hexgrid-fill", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "hexgrid-fill", () => {
      map.getCanvas().style.cursor = "";
    });
  });
});

onBeforeUnmount(() => {
  map?.remove();
});
//图层控制模块
const layerGroups = ref([
  {
    id: 'boundary',//程序内部名字
    label: '魏都区边界',//显示给用户看的名字

    layerIds: [//包含两个maplibre layer
      'weidu-fill',
      'weidu-outline'
    ],

    visible: true
  },

  {
    id: 'stations',
    label: '充电站',

    layerIds: [
      'stations-circle'
    ],

    visible: true
  },

  {
    id: 'hexgrid',
    label: '六边形供给',

    layerIds: [
      'hexgrid-fill',
      'hexgrid-outline'
    ],

    visible: true
  },

  {
    id: 'heatmap',
    label: '密度热力图',

    layerIds: [
      'stations-heatmap'
    ],

    visible: false
  }
])
function toggleLayer(groupId, visible) {

  const group =
    layerGroups.value.find(
      item => item.id === groupId
    )

  if (!group) return

  group.layerIds.forEach((layerId) => {

    if (!map.getLayer(layerId)) {
      return
    }

    map.setLayoutProperty(//隐藏函数
      layerId,
      'visibility',
      visible
        ? 'visible'
        : 'none'
    )
  })

  group.visible = visible
}
</script>

<template>
  <div class="map-wrapper">
    <div ref="mapEl" class="map"></div>
    <div class="station-count">魏都区充电站：{{ weiduStationCount }} 个</div>
    <LayerControl
      :layers="layerGroups"
      @toggle="toggleLayer"
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
</style>
