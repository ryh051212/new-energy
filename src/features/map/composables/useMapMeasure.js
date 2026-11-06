import { ref, computed } from 'vue'
import * as turf from '@turf/turf'
import { toMapGeoJSON, fromMapCoordinate } from '../config/basemaps.js'

// 每次调用创建独立实例；由 MapView 在卸载前调用清理方法。
export function useMapMeasure({ getMap, activeBasemap, closeMapPanels }) {
  const measuring = ref(false), measurePoints = ref([]), measurePanelOpen = ref(false)

  const MEASURE_DUPLICATE_KM = 0.03;

  const METERS_PER_KILOMETER = 1000;

  const measureText = computed(() => {
    const kilometers = measureKilometers();
    // 不到 1 千米用米，读起来更直观
    if (kilometers < 1) return Math.round(kilometers * METERS_PER_KILOMETER) + " 米";
    return kilometers.toFixed(2) + " 千米";
  });

  const measureHint = computed(() => {
    const count = measurePoints.value.length;
    if (measuring.value) {
      return count < 2 ? "在地图上单击起点，双击结束" : "继续单击加点，双击结束";
    }
    return count < 2 ? "点右侧直尺按钮开始测量" : "已完成测量";
  });

  function measureFeatures() {
    const map = getMap();
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

  function measureKilometers() {
    const map = getMap();
    const points = measurePoints.value;
    if (points.length < 2) return 0;
    return turf.length(turf.lineString(points), { units: "kilometers" });
  }

  function refreshMeasureLayer() {
    const map = getMap();
    map?.getSource("measure")?.setData(toMapGeoJSON({
      type: "FeatureCollection",
      features: measureFeatures(),
    }, activeBasemap.value));
  }

  function addMeasurePoint(event) {
    const map = getMap();
    measurePoints.value = measurePoints.value.concat([fromMapCoordinate(event.lngLat.toArray(), activeBasemap.value)]);
    refreshMeasureLayer();
  }

  function startMeasure() {
    const map = getMap();
    if (!map) return;
    closeMapPanels(false);
    measuring.value = true;
    measurePanelOpen.value = true;
    measurePoints.value = [];
    refreshMeasureLayer();
    map.getCanvas().style.cursor = "crosshair"; // 十字光标提示正在取点
    map.doubleClickZoom.disable(); // 双击要用来结束测距，先关掉双击缩放
    map.on("click", addMeasurePoint);
    map.on("dblclick", finishMeasure);
  }

  function finishMeasure() {
    const map = getMap();
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

  function clearMeasure() {
    const map = getMap();
    measurePoints.value = [];
    refreshMeasureLayer();
  }

  function closeMeasurePanel() {
    const map = getMap();
    if (measuring.value) finishMeasure();
    clearMeasure();
    measurePanelOpen.value = false;
  }

  function toggleMeasure() {
    const map = getMap();
    if (measuring.value) {
      finishMeasure();
    } else {
      startMeasure();
    }
  }

  function disposeMeasure() { if (measuring.value) finishMeasure() }

  return { measuring, measurePoints, measurePanelOpen, measureText, measureHint, measureFeatures, measureKilometers, refreshMeasureLayer, addMeasurePoint, startMeasure, finishMeasure, clearMeasure, closeMeasurePanel, toggleMeasure, disposeMeasure }
}
