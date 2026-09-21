<script setup>
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

  selectedHex: {
    type: Object,
    default: null
  }
})
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
    </div>

  </div>
</template>

<style scoped>
.analysis-panel {
  position: absolute;

  top: 20px;
  right: 20px;

  z-index: 10;

  width: 230px;

  padding: 16px;

  background: rgba(255, 255, 255, 0.95);

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