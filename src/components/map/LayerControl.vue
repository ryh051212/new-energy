<script setup>//父组件传数据给子组件
defineProps({
  layers: {
    type: Array,
    required: true
  }
})

const emit = defineEmits(['toggle'])//声明子组件可以向父组件发送哪些自定义事件。
</script>

<template>
  <div class="layer-control">

    <h3>图层管理器</h3>

    <label
      v-for="layer in layers"
      :key="layer.id"
      class="layer-item"
    >
      <input
        type="checkbox"
        :checked="layer.visible"
        @change="
          emit(
            'toggle',//事件
            layer.id,//标识
            $event.target.checked//是否选择
          )
        "
      >

      <span>{{ layer.label }}</span>
    </label>

  </div>
</template>

<style scoped>
.layer-control {
  /* 放在地图上方，并避开左上角的站点数量。 */
  position: absolute;
  top: 72px;
  left: 16px;
  z-index: 10;
  width: 190px;

  padding: 16px;

  background: rgba(224, 217, 217, 0.95);
  color: #334155;

  border-radius: 10px;

  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.15);
}

.layer-control h3 {
  margin:
    0
    0
    12px;

  font-size: 16px;
}

.layer-item {
  display: flex;

  align-items: center;

  gap: 8px;

  margin-bottom: 10px;

  cursor: pointer;
}
</style>
