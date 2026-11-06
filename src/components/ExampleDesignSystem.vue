<template>
  <div class="example-dashboard">
    <!-- 顶部导航栏 -->
    <header class="navbar">
      <div class="flex items-center gap-4">
        <h1 class="text-xl font-semibold text-primary">魏都充电设施</h1>
        <nav class="flex gap-1">
          <button class="nav-item nav-item-active">
            监控
          </button>
          <button class="nav-item">
            分析
          </button>
          <button class="nav-item">
            规划
          </button>
        </nav>
      </div>
      <div class="flex items-center gap-3">
        <button class="btn btn-ghost btn-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
        </button>
        <button class="btn btn-primary btn-sm">
          登录
        </button>
      </div>
    </header>

    <!-- 主内容区 -->
    <div class="layout-three-column">
      <!-- 左侧边栏 -->
      <aside class="sidebar sidebar-left">
        <div class="sidebar-header">
          <h2 class="text-base font-semibold">图层控制</h2>
        </div>
        <div class="sidebar-content">
          <div class="stack stack-2">
            <div class="form-checkbox">
              <input type="checkbox" id="layer1" checked>
              <label for="layer1">充电站点</label>
            </div>
            <div class="form-checkbox">
              <input type="checkbox" id="layer2" checked>
              <label for="layer2">居民区</label>
            </div>
            <div class="form-checkbox">
              <input type="checkbox" id="layer3">
              <label for="layer3">商业区</label>
            </div>
          </div>
        </div>
      </aside>

      <!-- 主内容 -->
      <main class="flex flex-col gap-3">
        <!-- 指标卡片组 -->
        <div class="grid grid-cols-4 gap-3">
          <div class="metric-card">
            <div class="metric-label">总站点数</div>
            <div class="metric-value">156</div>
            <div class="metric-change metric-change-positive">
              ↑ 12% 较上月
            </div>
          </div>

          <div class="metric-card">
            <div class="metric-label">快充站点</div>
            <div class="metric-value">89</div>
            <div class="metric-change metric-change-positive">
              ↑ 8% 较上月
            </div>
          </div>

          <div class="metric-card">
            <div class="metric-label">普通充电</div>
            <div class="metric-value">67</div>
            <div class="metric-change metric-change-neutral">
              → 0% 较上月
            </div>
          </div>

          <div class="metric-card">
            <div class="metric-label">覆盖率</div>
            <div class="metric-value">87%</div>
            <div class="metric-change metric-change-positive">
              ↑ 5% 较上月
            </div>
          </div>
        </div>

        <!-- 地图容器 -->
        <div class="card" style="flex: 1; min-height: 400px;">
          <div class="card-body p-0">
            <div class="map-container">
              <!-- MapLibre GL 地图将在这里渲染 -->
              <div class="flex items-center justify-center h-full text-secondary">
                地图容器
              </div>
            </div>
          </div>
        </div>
      </main>

      <!-- 右侧边栏 -->
      <aside class="sidebar sidebar-right">
        <div class="sidebar-header">
          <h2 class="text-base font-semibold">站点详情</h2>
        </div>
        <div class="sidebar-content">
          <!-- 信息面板 -->
          <div class="panel">
            <div class="panel-header">
              <h3 class="panel-title text-sm">许昌充电站</h3>
              <span class="badge badge-success">运营中</span>
            </div>
            <div class="panel-body panel-body-compact">
              <div class="stack stack-3">
                <div>
                  <div class="text-xs text-secondary">地址</div>
                  <div class="text-sm">魏都区七一路123号</div>
                </div>
                <div>
                  <div class="text-xs text-secondary">充电桩数量</div>
                  <div class="text-sm">12 个</div>
                </div>
                <div>
                  <div class="text-xs text-secondary">可用状态</div>
                  <div class="text-sm">
                    <span class="status-dot status-dot-success"></span>
                    8 个可用
                  </div>
                </div>
              </div>
            </div>
            <div class="panel-footer">
              <button class="btn btn-primary btn-sm w-full">
                查看详情
              </button>
            </div>
          </div>

          <!-- 最近活动 -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title text-sm">最近活动</h3>
            </div>
            <div class="card-body card-body-compact">
              <div class="data-list">
                <div class="data-list-item">
                  <div class="flex-1">
                    <div class="text-sm">新增充电站</div>
                    <div class="text-xs text-secondary">2 小时前</div>
                  </div>
                  <span class="badge badge-success">新增</span>
                </div>
                <div class="data-list-item">
                  <div class="flex-1">
                    <div class="text-sm">设备维护</div>
                    <div class="text-xs text-secondary">5 小时前</div>
                  </div>
                  <span class="badge badge-warning">维护</span>
                </div>
                <div class="data-list-item">
                  <div class="flex-1">
                    <div class="text-sm">数据更新</div>
                    <div class="text-xs text-secondary">1 天前</div>
                  </div>
                  <span class="badge badge-neutral">更新</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
// 这是一个示例组件，展示如何使用新的设计系统
// 实际使用时，请根据需要引入必要的逻辑和数据
</script>

<style scoped>
/*
  示例组件样式
  注意：大部分样式已经通过 class 定义，这里只需要少量自定义样式
*/

.example-dashboard {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--bg-page);
}

.map-container {
  width: 100%;
  height: 100%;
  min-height: 400px;
  background: var(--neutral-100);
  border-radius: var(--radius-lg);
}

/* 响应式调整 */
@media (max-width: 768px) {
  .grid-cols-4 {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
