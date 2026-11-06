<script setup>
import {
  ref,
  onMounted,
  onUnmounted,
  watch
} from 'vue'

import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import {
  GridComponent,
  TitleComponent,
  TooltipComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  GridComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer
])
const emit = defineEmits(['selectStationCount'])//传输给父组件

function handleBarClick(params) {
  const item = props.data[params.dataIndex]

  if (!item) return

  console.log(
    '用户点击的 stationCount：',
    item.stationCount
  )
  emit('selectStationCount', item.stationCount)
}
const props = defineProps({//子组件接收父组件传输的数据
  data: {
    type: Array,
    default: () => []
  }
})

const chartRef = ref(null)//创建响应式对象

let chart = null

function handleResize() {
  chart?.resize()
}

function renderChart() {
  if (!chart) return

  const option = {//柱状图的样式
    title: {
      text: '网格充电站数量分布',
      left: 'center',
      textStyle: {
        fontSize: 14
      }
    },

    tooltip: {//鼠标悬停提示
      trigger: 'axis'//以横坐标为触发范围
    },
    grid: { left: 45, right: 15, top: 65, bottom: 55 },

    xAxis: {
      type: 'category',
      data: props.data.map(
        item => `${item.stationCount}个`
      ),
      name: '网格内站点数',
      nameLocation: 'middle',
      nameGap: 30
    },

    yAxis: {
      type: 'value',
      name: '网格数量'
    },

    series: [
      {
        type: 'bar',

        data: props.data.map(
          item => item.hexCount
        )
      }
    ]
  }

  chart.setOption(option)
}

onMounted(() => {
  chart = echarts.init(chartRef.value)

  chart.on(
    'click',
    handleBarClick//内部传入参数
  )

  renderChart()
  window.addEventListener(
    'resize',
    handleResize
  )
})


watch(
  () => props.data,
  () => {
    renderChart()//一旦数据变化,重新渲染函数
  },
  {
    deep: true//属性变化也重新渲染
  }
)

onUnmounted(() => {
  window.removeEventListener(
    'resize',//移除窗口 resize 事件监听
    handleResize
  )

  chart?.dispose()//销毁 ECharts 图表实例
  chart = null
})
</script>

<template>
  <div
    ref="chartRef"
    class="chart"
  ></div>
</template>

<style scoped>
.chart {
  width: 100%;
  height: 260px;
}
</style>
