export const navigationGroups = [
  { path: '/charging', label: '找充电', icon: 'search', direct: true, children: [] },
  { path: '/monitoring', label: '供需监测', icon: 'chart', children: [
    { path: '/monitoring/stations', title: '充电站分布', map: true, description: '查看充电站位置与站点密度热力图。' },
    { path: '/monitoring/demand', title: '需求分布', map: true, description: '查看基于居民小区与商业设施计算的潜在需求指数。' },
    { path: '/monitoring/supply', title: '供给能力', map: true, description: '查看每个网格的充电站数量，作为相对供给水平的参考。' },
    { path: '/monitoring/mismatch', title: '供需失配', map: true, description: '查看需求与供给的相对差异，点击网格了解详细指标。' },
  ] },
  { path: '/planning', label: '智能规划', icon: 'compass', children: [
    { path: '/planning/problems', title: '问题区域', map: true, description: '查看供需四象限分类，右侧列出高需求、低供给的重点关注网格。' },
    { path: '/planning/candidates', title: '候选区域', description: '候选区域筛选功能正在建设，将结合供需情况与建设约束筛选区域。' },
    { path: '/planning/suggestions', title: '新建站点建议', description: '新建站点建议功能正在建设，尚未生成具体选址方案。' },
  ] },
  { path: '/city', label: '三维城市', icon: 'building', children: [
    { path: '/city/cesium', title: 'Cesium 可视化', description: 'Cesium 三维场景尚未接入，当前可返回首页查看二维地图。' },
  ] },
  { path: '/ai', label: 'AI分析', icon: 'star', children: [
    { path: '/ai/forecast', title: '需求预测', description: '预测模型与历史时序数据尚未接入。' },
    { path: '/ai/explanation', title: '决策解释', description: 'AI 决策解释功能正在建设，将说明分析依据与规划建议。' },
  ] },
]

export const routePages = Object.fromEntries(navigationGroups.flatMap(group =>
  group.children.map(child => [child.path, { ...child, icon: group.icon, group: group.label }]),
))

const aliases = {
  '/stations': '/charging', '/navigation': '/charging',
  '/recommendations': '/charging', '/forecast': '/ai/forecast',
  '/charging/search': '/charging', '/charging/nearby': '/charging',
  '/charging/filter': '/charging', '/charging/recommended': '/charging', '/charging/details': '/charging',
  ...Object.fromEntries(navigationGroups.filter(group => !group.direct).map(group => [group.path, group.children[0].path])),
}

export function resolveRoute(path) { return aliases[path] || path || '/' }
