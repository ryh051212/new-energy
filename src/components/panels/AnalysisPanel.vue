<script setup>
import HexDistributionChart from '../charts/HexDistributionChart.vue'
const emit = defineEmits(['selectStationCount'])
defineProps({
  stationCount: {
    type: Number,
    default: 0
  },

  hexCount: {
    type: Number,
    default: 0
  },

  occupiedHexCount: {
    type: Number,
    default: 0
  },

  residentialCount: {
    type: Number,
    default: 0
  },
  commercialCount: {
    type: Number,
    default: 0
  },

  selectedHex: {
    type: Object,
    default: null
  },
  hexDistribution: {
    type: Array,
    default: () => []
  }
})
function handleStationCountSelect(
  stationCount
) {
  console.log(
    'AnalysisPanel 收到：',
    stationCount
  )
  // 组件事件不会自动向上冒泡，需要转发给 MapView。
  emit('selectStationCount', stationCount)
}
</script>

<template>
  <div class="analysis-panel">

    <h3>充电设施分析</h3>

    <div class="stat-item">
      <span>充电站总数</span>
      <strong>{{ stationCount }}</strong>
    </div>

    <div class="stat-item">
      <span>六边形总数</span>
      <strong>{{ hexCount }}</strong>
    </div>

    <div class="stat-item">
      <span>有站网格</span>
      <strong>{{ occupiedHexCount }}</strong>
    </div>

    <div class="stat-item">
      <span>居民小区总数</span>
      <strong>{{ residentialCount }}</strong>
    </div>

    <div class="stat-item">
      <span>商业设施总数</span>
      <strong>{{ commercialCount }}</strong>
    </div>
    <HexDistributionChart 
    :data="hexDistribution" 
     @selectStationCount="handleStationCountSelect"
     
    />
   

    <div
      v-if="selectedHex"
      class="selected-info"
    >
      <h4>当前网格</h4>

      <p>
        编号：
        {{ selectedHex.id }}
      </p>

      <p>
        充电站：
        {{ selectedHex.stationCount }}
      </p>

      <p>
        居民小区：
        {{ selectedHex.residentialCount }}
      </p>

      <p>
        商业设施：
        {{ selectedHex.commercialCount }}
      </p>

      <p>
        综合需求指数：
        {{ selectedHex.demandIndex }}
      </p>
      <p>
        供给指数：
        {{ selectedHex.supplyIndex }}
      </p>
      <p>
        供需错配指数：
        {{ selectedHex.mismatchIndex }}
      </p>
      <p>
        供需类型：
        {{ selectedHex.supplyDemandType }}
      </p>
    </div>

  </div>
</template>

<style scoped>
.analysis-panel {
  position: absolute;

  top: 20px;
  right: 20px;

  z-index: 10;

  width: 300px;
  max-width: calc(100vw - 72px);
  max-height: calc(100vh - 72px);
  overflow-y: auto;

  padding: 16px;

  background: rgba(236, 232, 232, 0.95);

  border-radius: 10px;

  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.15);
}

.analysis-panel h3 {
  margin: 0 0 16px;
}

.stat-item {
  display: flex;
  justify-content: space-between;

  padding: 8px 0;

  border-bottom: 1px solid #e5e7eb;
}

.selected-info {
  margin-top: 18px;
}
</style>
