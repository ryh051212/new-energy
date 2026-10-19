export const chargingDemo = {
  path: '/charging/demo',
}

export const navigationGroups = [
  { path: '/monitoring', label: '供需监测', icon: 'chart', children: [
    { path: '/monitoring/stations', title: '充电站分布', map: true, description: '查看充电站点的空间分布与充电类型。' },
    { path: '/monitoring/demand', title: '需求分布', map: true, description: '查看基于居民小区与商业设施计算的潜在需求指数。' },
    { path: '/monitoring/supply', title: '供给能力', map: true, description: '查看每个网格的充电站数量，作为相对供给水平的参考。' },
    { path: '/monitoring/mismatch', title: '供需失配', map: true, description: '查看需求与供给的相对差异，点击网格了解详细指标。' },
  ] },
  { path: '/planning', label: '智能规划', icon: 'compass', children: [
    { path: '/planning/overview', title: '空间供需', map: true, description: '查看供需分布、网格统计与优先关注区域。' },
    { path: '/planning/problems', title: '问题区域', map: true, description: '对比供需四象限，在沙盘中探索新增站点方案。' },
    { path: '/planning/candidates', title: '优先关注区域', map: true, description: '筛选高需低供网格，按需求排序并定位查看。' },
    { path: '/planning/suggestions', title: '布局推演', map: true, description: '在地图调整站点配置，比较模拟前后的服务变化。' },
    { path: '/planning/grid', title: '车网协同', map: true, description: '按站点配置与情景参数比较逐时负荷、光伏和储能调节。' },
    { path: '/planning/carbon', title: '双碳评估', map: true, description: '按单次充电量与车辆能耗，比较同等里程的汽油燃烧和充电电力二氧化碳排放。' },
  ] },
  { path: '/city', label: '三维城市', icon: 'building', children: [
    { path: '/city/cesium', title: 'Cesium 可视化', description: 'Cesium 三维场景尚未接入，当前可返回首页查看二维地图。' },
  ] },
]

export const aiAnalysisGroup = {
  path: '/ai', label: 'AI分析', icon: 'star', children: [
    { path: '/ai/forecast', title: '需求预测', description: '预测模型与历史时序数据尚未接入。' },
    { path: '/ai/explanation', title: '决策解释', description: 'AI 决策解释功能正在建设，将说明分析依据与规划建议。' },
  ],
}

// 次要及建设中页面收在更多导航内，旧分析地址继续保留。
const pageGroups = [...navigationGroups, aiAnalysisGroup]
export const routePages = Object.fromEntries(pageGroups.flatMap(group =>
  group.children.map(child => [child.path, { ...child, icon: group.icon, group: group.label }]),
))

const aliases = {
  '/forecast': '/ai/forecast',
  ...Object.fromEntries(pageGroups.filter(group => !group.direct).map(group => [group.path, group.children[0].path])),
}

export function resolveRoute(path) {
  // Retired driver URLs, including saved bookmarks, return to the planner.
  if (/^\/(?:charging|charing)(?:\/|$)/.test(path || '') || ['/stations', '/navigation', '/recommendations'].includes(path)) return '/'
  return aliases[path] || path || '/'
}
