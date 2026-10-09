<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { AMAP_STANDARD_SOURCE, toMapCoordinate, fromMapCoordinate } from '../utils/basemaps.js'
const props = defineProps({ coordinates: { type: Array, default: null } })
const emit = defineEmits(['pick'])
const canvas = ref(null)
const error = ref('')
let map, marker, observer
function mark(value) {
  if (!map || !value) return
  if (!marker) marker = new maplibregl.Marker({ color: '#16a34a' }).setLngLat(toMapCoordinate(value)).addTo(map)
  else marker.setLngLat(toMapCoordinate(value))
}
watch(() => props.coordinates, value => { if (value) { mark(value); map?.easeTo({ center: toMapCoordinate(value) }) } })
onMounted(() => {
  try {
    maplibregl.setWorkerUrl(workerUrl)
    map = new maplibregl.Map({ container: canvas.value, center: toMapCoordinate(props.coordinates || [113.8356, 34.0268]),
      zoom: 13, style: { version: 8, sources: { street: AMAP_STANDARD_SOURCE }, layers: [{ id: 'street', type: 'raster', source: 'street' }] } })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('click', event => {
      const point = fromMapCoordinate([event.lngLat.lng, event.lngLat.lat]).map(value => Number(value.toFixed(6)))
      mark(point); emit('pick', point)
    })
    map.on('load', () => mark(props.coordinates))
    observer = new ResizeObserver(() => map?.resize()); observer.observe(canvas.value)
  } catch { error.value = '地图暂不可用，可使用下面的 WGS84 坐标填写目的地。' }
})
onBeforeUnmount(() => { observer?.disconnect(); marker?.remove(); map?.remove(); map = null })
</script>
<template><div class="destination-picker"><p>点击地图确定目的地位置，可缩放后精确选择建筑入口。</p><div ref="canvas" class="destination-picker-map" aria-label="目的地选点地图"></div><p v-if="error" role="status">{{ error }}</p></div></template>
<style scoped>.destination-picker p{font-size:12px;line-height:1.7;color:var(--ink-500)}.destination-picker-map{height:280px;width:100%;border:1px solid var(--line);border-radius:12px;overflow:hidden}</style>
