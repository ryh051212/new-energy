<script setup >
import{ref,onMounted}from'vue'
import maplibregl from 'maplibre-gl'
import maplibregl from 'maplibre-gl'
 const mapEl=ref(null)//当前无值，定义为空
 //app挂载
 onMounted(()=>{
  new maplibregl.Map({
    container:mapElm.value,
    style:'',
    center:[113.85,34.04],
    zoom:11
  })
 })


</script>
<template>
  <div ref="mapEl" class="map"></div>
</template>