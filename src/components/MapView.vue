<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// 让 Vite 同时打包 MapLibre 处理地图数据的 Worker。
maplibregl.setWorkerUrl(workerUrl);

const mapEl = ref(null);
const weiduStationCount = ref(0);
let map;

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
      const coordinates = station.geometry.coordinates;//經緯度坐標

      // 实例化窗口
      new maplibregl.Popup()
        .setLngLat(coordinates)//把这个坐标传给 Popup，让弹窗显示在该点的位置。
        .setHTML(`
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
      地址：${properties.address || '暂无'}
      <br>
      编码：${properties.id || "未知"}<br>
      类型：${properties.type || "未記錄"}
    </div>
  `)
        .addTo(map);
    });

    const weiduGeoJSON = await boundaryResponse.json();
    const stationsGeoJSON = await stationsResponse.json();//地址传输的json数据
    const weiduStations = stationsGeoJSON.features.filter((station) => {
      return station.properties?.district === "魏都区";
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
  });
});

onBeforeUnmount(() => {
  map?.remove();
});
</script>

<template>
  <div class="map-wrapper">
    <div ref="mapEl" class="map"></div>
    <div class="station-count">
      魏都区充电站：{{ weiduStationCount }} 个
    </div>
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
