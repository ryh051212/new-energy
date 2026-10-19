<script setup>
import { computed } from 'vue'
import { CHARGING_ICONS } from '../utils/chargingIcons.js'

const props = defineProps({ name: { type: String, required: true }, size: { type: [Number, String], default: 20 } })
// 统一 24 网格、线宽 1.8、圆头圆角；充电类型图标为实心字形，走 CHARGING_ICONS。
const paths = {
  lock: ['M6 10h12v11H6z', 'M8 10V6a4 4 0 0 1 8 0v4', 'M12 14v3'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  'eye-off': ['m3 3 18 18', 'M10.6 5.1A12 12 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.1 4', 'M6.1 6.1A21 21 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.9-1.6', 'M10 10a3 3 0 0 0 4 4'],
  'arrow-right': ['M5 12h14', 'm13 6 6 6-6 6'],
  logout: ['M9 4H4v16h5', 'M10 12h11', 'm17 8 4 4-4 4'],
  home: ['m3 10 9-7 9 7', 'M5 9v12h14V9', 'M9 21v-7h6v7'],
  search: ['m21 21-4.3-4.3', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16'],
  compass: ['m3 11 18-8-8 18-2-8-8-2Z'],
  star: ['m12 2 3.1 6.3 7 1-5 4.9 1.2 7-6.3-3.3-6.3 3.3 1.2-7-5-4.9 7-1L12 2Z'],
  chart: ['M4 19V5', 'M4 19h17', 'm7 14 4-4 3 3 6-7'],
  file: ['M6 2h9l4 4v16H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z', 'M14 2v5h5', 'M8 12h8', 'M8 16h8'],
  user: ['M20 21a8 8 0 0 0-16 0', 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7', 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.07-2.85 2.85-.07-.06A1.7 1.7 0 0 0 15 19.4l-.1.02V22h-4v-2.58L10.8 19.4a1.7 1.7 0 0 0-1.88.34l-.07.06L6 16.95l.06-.07A1.7 1.7 0 0 0 6.4 15l-.02-.1H4v-4h2.38l.02-.1a1.7 1.7 0 0 0-.34-1.88L6 8.85 8.85 6l.07.06A1.7 1.7 0 0 0 10.8 6.4l.1-.02V4h4v2.38l.1.02a1.7 1.7 0 0 0 1.88-.34l.07-.06 2.85 2.85-.06.07A1.7 1.7 0 0 0 19.4 10.8l.02.1H22v4h-2.58l-.02.1Z'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20', 'M12 6v6l4 2'],
  car: ['M5 16h14l-1.5-6A2 2 0 0 0 15.6 8H8.4a2 2 0 0 0-1.9 1.5L5 16Z', 'M8 16v2', 'M16 16v2', 'M7 12h10', 'M7 8l1-2h8l1 2'],
  bolt: ['m13 2-9 11h7l-1 9 10-12h-7V2Z'],
  pin: ['M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z', 'M12 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5'],
  layers: ['m12 2 9 5-9 5-9-5 9-5Z', 'm3 12 9 5 9-5', 'm3 17 9 5 9-5'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  boundary: ['M8 3H3v5', 'M16 3h5v5', 'M21 16v5h-5', 'M8 21H3v-5', 'M11 3h2', 'M21 11v2', 'M11 21h2', 'M3 11v2'],
  chevron: ['m6 9 6 6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  locate: ['M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm4.9 14.9 1.4-1.4', 'm17.7 6.3 1.4-1.4'],
  calendar: ['M3 5h18v17H3z', 'M7 2v6', 'M17 2v6', 'M3 10h18'],
  alert: ['M12 2 2 21h20L12 2Z', 'M12 9v4', 'M12 17h.01'],
  close: ['M5 5l14 14', 'M19 5 5 19'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20', 'M12 11v6', 'M12 7h.01'],
  // 双碳评估：叶片
  leaf: ['M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z', 'M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12'],
  // 测距用的直尺
  ruler: ['M21.3 8.7 8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4Z', 'm7.5 10.5 2 2', 'm10.5 7.5 2 2', 'm13.5 4.5 2 2', 'm4.5 13.5 2 2'],
  // 进入全屏（四个角向外展开）
  expand: ['M8 3H5a2 2 0 0 0-2 2v3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M21 16v3a2 2 0 0 1-2 2h-3', 'M3 16v3a2 2 0 0 0 2 2h3'],
  // 退出全屏（四个角向内收拢）
  compress: ['M8 3v3a2 2 0 0 1-2 2H3', 'M16 3v3a2 2 0 0 0 2 2h3', 'M21 16h-3a2 2 0 0 0-2 2v3', 'M3 16h3a2 2 0 0 1 2 2v3'],
  // 六边形网格
  hexagon: ['M21 16.5v-9a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 7.5v9a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z'],
  // 商业设施（楼房）
  building: ['M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z', 'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2', 'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2', 'M10 6h4', 'M10 10h4', 'M10 14h4', 'M10 18h4'],
}
const iconPaths = computed(() => paths[props.name] || paths.info)
const chargingIcon = computed(() => CHARGING_ICONS[props.name])
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="chargingIcon ? 'currentColor' : 'none'"
    :stroke="chargingIcon ? 'none' : 'currentColor'"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    :data-icon="name"
    aria-hidden="true"
  >
    <path v-for="(path, index) in (chargingIcon?.paths || iconPaths)" :key="index" :d="path" :fill-rule="chargingIcon ? 'nonzero' : undefined" />
  </svg>
</template>
