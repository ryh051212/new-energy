<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// 让 Vite 同时打包 MapLibre 处理地图数据的 Worker。
maplibregl.setWorkerUrl(workerUrl);

const mapEl = ref(null);
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
    const response = await fetch(
      `${import.meta.env.BASE_URL}geojson/weidu.json`,
    );
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
      类型：${properties.chargeType || "未知"}<br>
      充电枪数量：${properties.guns || "未記錄"}
    </div>
  `)
        .addTo(map);
    });

    const weiduGeoJSON = await response.json();

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
  <div ref="mapEl" class="map"></div>
</template>

<style scoped>
.map {
  width: 100%;
  height: 70vh;
  min-height: 400px;
  text-align: left;
}
</style>
