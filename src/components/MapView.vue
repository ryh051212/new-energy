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
const loading = ref(true);
const loadError = ref("");
const gridWarning = ref("");
const gridReady = ref(false);
const controller = new AbortController();
let disposed = false;
let map;
let popup;
let resizeObserver;
const legend = [
  { label: "0", color: "#f1f5f9" }, { label: "1", color: "#bae6fd" },
  { label: "2–3", color: "#7dd3fc" }, { label: "4–5", color: "#38bdf8" },
  { label: "≥6", color: "#0284c7" },
];

onMounted(() => {
  try {
    map = new maplibregl.Map({
      container: mapEl.value,
      center: [113.85, 34.04],
      zoom: 11,
      style: {
        version: 8,
        sources: {
          "weidu": {
            "type": "geojson",
            "data": {
              "type": "FeatureCollection",
              "features": []
            }
          },
          "stations": {
            "type": "geojson",
            "data": {
              "type": "FeatureCollection",
              "features": []
            }
          },
          "hexgrid": {
            "type": "geojson",
            "data": {
              "type": "FeatureCollection",
              "features": []
            }
          }
        },
        // 后面的图层覆盖前面的图层：底面 → 网格 → 区界 → 站点。
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#f8fafc" } },
          { id: "weidu-fill", type: "fill", source: "weidu", paint: { "fill-color": "#e0f2fe", "fill-opacity": 0.35 } },
          { id: "hexgrid-fill", type: "fill", source: "hexgrid", paint: {
            "fill-color": ["step", ["get", "stationCount"], "#f1f5f9", 1, "#bae6fd", 2, "#7dd3fc", 4, "#38bdf8", 6, "#0284c7"],
            "fill-opacity": 0.65,
          } },
          { id: "hexgrid-outline", type: "line", source: "hexgrid", paint: { "line-color": "#94a3b8", "line-width": 0.5 } },
          { id: "weidu-outline", type: "line", source: "weidu", paint: { "line-color": "#0369a1", "line-width": 2 } },
          { id: "stations-circle", type: "circle", source: "stations", paint: {
            "circle-color": ["match", ["get", "chargeType"], "slow", "#2563eb", "fast", "#16a34a", "#6b7280"],
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 13, 6, 16, 9],
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
          } },
        ],
      },
    });
    // 地图加载完成后，先注册点击事件，再读取并显示数据。
    map.on("load", async () => {

      // 1. 点击充电站：直接在这个事件里读取属性、创建弹窗。
      map.on("click", "stations-circle", (e) => {
        const station = e.features?.[0];
        if (!station || !station.geometry) return;
        const properties = station.properties || {};
        const coordinates = station.geometry.coordinates;

        // 先关闭上一个弹窗，避免多个弹窗互相遮挡。
        if (popup) {
          popup.remove();
        }

        // textContent 只显示文字，避免外部数据被当作 HTML 执行。
        const content = document.createElement("div");
        content.className = "station-popup";
        const title = document.createElement("strong");
        title.textContent = properties.name || "充电站";
        content.append(title);

        const rows = [
          ["地址", properties.address],
          ["编码", properties.id],
          ["类型", properties.type],
        ];
        rows.forEach((item) => {
          const label = item[0];
          let value = item[1];
          if (value === null || value === undefined || value === "") {
            value = "暂无";
          }
          const row = document.createElement("div");
          row.textContent = `${label}：${value}`;
          content.append(row);
        });

        popup = new maplibregl.Popup({ maxWidth: "300px" })
          .setLngLat(coordinates)
          .setDOMContent(content)
          .addTo(map);
      });

      // 2. 点击六边形：如果同一位置有站点，让上面的站点事件处理。
      map.on("click", "hexgrid-fill", (e) => {
        const stationsAtClick = map.queryRenderedFeatures(e.point, {
          layers: ["stations-circle"],
        });
        if (stationsAtClick.length > 0) return;
        const hex = e.features?.[0];
        if (!hex) return;
        if (popup) {
          popup.remove();
        }

        const content = document.createElement("div");
        content.className = "station-popup";
        const title = document.createElement("strong");
        title.textContent = `网格 ${hex.properties.id}`;
        content.append(title);
        const row = document.createElement("div");
        row.textContent = `充电站数量：${hex.properties.stationCount}`;
        content.append(row);

        popup = new maplibregl.Popup({ maxWidth: "300px" })
          .setLngLat(e.lngLat)
          .setDOMContent(content)
          .addTo(map);
      });

      // 3. 鼠标经过站点或网格时，显示手形光标。
      map.on("mousemove", (event) => {
        const features = map.queryRenderedFeatures(event.point, { layers: ["stations-circle", "hexgrid-fill"] });
        if (features.length > 0) {
          map.getCanvas().style.cursor = "pointer";
        } else {
          map.getCanvas().style.cursor = "";
        }
      });

      // 可选网格独立加载，网格失败不阻塞站点和边界。
      try {
        // 全部执行完成后进行下一步：魏都区边界数据和充电站数据。
        // 4. 同时请求边界和站点，不再调用自定义读取函数。
        const [boundaryResponse, stationsResponse] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}geojson/weidu.json`, {
            // 退出页面时取消请求；超过 15 秒也停止等待。
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          }),
          fetch(`${import.meta.env.BASE_URL}geojson/stations.json`, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          }),
        ]);
        if (!boundaryResponse.ok || !stationsResponse.ok) {
          throw new Error("地图数据请求失败");
        }
        const boundary = await boundaryResponse.json();
        const stations = await stationsResponse.json();
        if (disposed) return;
        // 5. 逐个站点判断是否在魏都区内，保留符合条件的站点。
        if (!stations || stations.type !== "FeatureCollection" || !Array.isArray(stations.features)) {
          throw new Error("站点文件格式不正确");
        }
        let polygons = [boundary];
        if (boundary && boundary.type === "FeatureCollection") {
          polygons = boundary.features;
        }
        if (!Array.isArray(polygons) || polygons.length === 0) {
          throw new Error("行政区边界不能为空");
        }
        polygons.forEach((polygon) => {
          if (!polygon || !polygon.geometry) {
            throw new Error("行政区边界格式不正确");
          }
          if (polygon.geometry.type !== "Polygon" && polygon.geometry.type !== "MultiPolygon") {
            throw new Error("行政区边界必须是面要素");
          }
        });

        const weiduStations = stations.features.filter((station) => {
          if (!station || !station.geometry || station.geometry.type !== "Point") {
            return false;
          }
          const coordinates = station.geometry.coordinates;
          if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
          if (!Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) return false;
          if (Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return false;

          let inside = false;
          polygons.forEach((polygon) => {
            if (turf.booleanPointInPolygon(station, polygon)) {
              inside = true;
            }
          });
          return inside;
        });
        const filtered = {
          type: "FeatureCollection",
          features: weiduStations,
        };

        // 6. 地图和左上角数量使用同一份筛选结果。
        const bounds = turf.bbox(boundary);
        if (!bounds.every(Number.isFinite)) throw new Error("边界坐标无效");
        map.getSource("weidu").setData(boundary);
        map.getSource("stations").setData(filtered);
        weiduStationCount.value = filtered.features.length;
        loading.value = false;
        map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 60, duration: 0 });
        try {
          // 7. 单独请求网格。这里失败时，已经显示的站点仍然能用。
          const hexResponse = await fetch(`${import.meta.env.BASE_URL}geojson/hex-grid.json`, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          });
          if (!hexResponse.ok) throw new Error("网格请求失败");
          const hexGrid = await hexResponse.json();
          if (disposed) return;
          // 不依赖可能过期的 stationCount，按当前站点重新核算。
          if (!hexGrid || hexGrid.type !== "FeatureCollection" || !Array.isArray(hexGrid.features)) {
            throw new Error("六边形文件格式不正确");
          }

          // 8. 每个站点对应一个计数标记，false 表示还没有计入任何网格。
          const counted = [];
          weiduStations.forEach(() => {
            counted.push(false);
          });
          hexGrid.features.forEach((hex, index) => {
            if (!hex || !hex.geometry) throw new Error("网格格式不正确");
            if (hex.geometry.type !== "Polygon" && hex.geometry.type !== "MultiPolygon") {
              throw new Error("网格必须是面要素");
            }
            const pointsInside = weiduStations.filter((station, stationIndex) => {
              // 共边站点只统计一次，已经统计过的直接跳过。
              if (counted[stationIndex]) return false;
              if (turf.booleanPointInPolygon(station, hex)) {
                counted[stationIndex] = true;
                return true;
              }
              return false;
            });
            if (!hex.properties) {
              hex.properties = {};
            }
            hex.properties.id = index + 1;
            hex.properties.stationCount = pointsInside.length;
          });

          // 9. 如果网格漏掉站点，提示重新生成，避免显示不完整的统计。
          const uncovered = counted.filter((isCounted) => {
            return isCounted === false;
          });
          if (uncovered.length > 0) {
            throw new Error(`有 ${uncovered.length} 个站点未被网格覆盖，请重新生成网格`);
          }
          map.getSource("hexgrid").setData(hexGrid);
          gridReady.value = true;
        } catch (error) {
          if (disposed) return;
          gridWarning.value = "网格统计暂不可用，站点仍可查看";
          console.error(error);
        }
      } catch (error) {
        if (!disposed) {
          loadError.value = "地图数据加载失败，请刷新重试";
          console.error(error);
        }
      } finally {
        if (!disposed) loading.value = false;
      }
    });
    map.on("error", (event) => {
      if (disposed) return;
      console.error(event.error);
      if (event.sourceId === "hexgrid") {
        gridReady.value = false;
        gridWarning.value = "网格统计暂不可用，站点仍可查看";
      } else {
        loadError.value = "地图加载失败，请刷新重试";
        loading.value = false;
      }
    });
    // 容器尺寸改变时，让地图重新适应大小。
    resizeObserver = new ResizeObserver(() => {
      if (!disposed) {
        map.resize();
      }
    });
    resizeObserver.observe(mapEl.value);
  } catch (error) {
    loadError.value = "地图初始化失败，请检查浏览器是否支持 WebGL";
    loading.value = false;
    console.error(error);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  resizeObserver?.disconnect();
  popup?.remove();
  map?.remove();
});
</script>

<template>
  <div class="map-wrapper">
    <div ref="mapEl" class="map" aria-label="魏都区充电站分布地图"></div>
    <div class="station-count" aria-live="polite">
      <span v-if="loadError" role="alert">{{ loadError }}</span>
      <span v-else-if="loading">正在加载站点…</span>
      <template v-else>
        <strong>魏都区充电站：{{ weiduStationCount }} 个</strong>
        <small v-if="gridWarning">{{ gridWarning }}</small>
      </template>
    </div>
    <div v-if="!loading && !loadError" class="legend">
      <template v-if="gridReady">
        <strong>每格充电站数量</strong>
        <div class="legend-items">
          <span v-for="item in legend" :key="item.label"><i :style="{ background: item.color }"></i>{{ item.label }}</span>
        </div>
      </template>
      <div class="legend-items station-types">
        <span><i style="background:#2563eb"></i>慢充</span>
        <span><i style="background:#16a34a"></i>快充</span>
        <span><i style="background:#6b7280"></i>类型未知</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
:global(#app) {
  width: 100%;
  max-width: none;
  border: 0;
  text-align: left;
}
.map-wrapper {
  position: relative;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  min-height: 320px;
  color-scheme: light;
}
.map {
  width: 100%;
  height: 100%;
}
.station-count, .legend {
  position: absolute;
  z-index: 1;
  padding: 10px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 2px 8px rgb(15 23 42 / 12%);
  color: #334155;
  font-size: 13px;
  line-height: 1.6;
  max-width: calc(100% - 32px);
  box-sizing: border-box;
}
.station-count {
  top: 16px;
  left: 16px;
  pointer-events: none;
}
.station-count small {
  display: block;
  color: #92400e;
}
.legend {
  left: 16px;
  bottom: 32px;
  pointer-events: none;
}
.legend strong {
  display: block;
  margin-bottom: 4px;
}
.legend-items {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.legend-items span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend-items i {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1px solid #94a3b8;
}
.station-types {
  margin-top: 6px;
}
.station-types i {
  border-radius: 50%;
  border-color: white;
}
:deep(.station-popup) {
  color: #334155;
  padding: 4px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
:deep(.station-popup strong) {
  display: block;
  color: #0f172a;
  margin-bottom: 6px;
  padding-right: 14px;
}
@media (max-width: 480px) {
  .station-count, .legend {
    left: 10px;
    max-width: calc(100% - 20px);
    font-size: 12px;
  }
}
</style>
