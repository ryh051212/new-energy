import config from '../../data/managed/facility-categories.json' with { type: 'json' }

const colors = {
  parking: '#2563eb', office: '#475569', industrial_park: '#9a3412', hospital: '#dc2626',
  school: '#7c3aed', park: '#15803d', mall: '#db2777', supermarket: '#d97706',
  residential: '#6366f1', company: '#0f766e', leisure: '#0891b2', restaurant: '#ea580c',
}

export const FACILITY_MAP_LAYERS = config.categories.map(category => ({
  id: `facility-${category.id}`, category: category.id, label: `${category.name} POI`,
  section: 'facility', color: colors[category.id] || '#64748b',
  layerIds: [`facility-${category.id}-circle`], visible: false,
}))

export function facilityPointLayers() {
  return FACILITY_MAP_LAYERS.map(layer => ({
    id: layer.layerIds[0], type: 'circle', source: 'facilities',
    filter: ['in', layer.category, ['get', 'categories']],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': layer.color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 6],
      'circle-opacity': .9, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.3,
    },
  }))
}

export function facilityPopupLines(feature) {
  const properties = feature.properties || {}
  let categories = properties.categories
  try { if (typeof categories === 'string') categories = JSON.parse(categories) } catch { categories = [] }
  if (!Array.isArray(categories)) categories = []
  const names = categories.map(id => config.categories.find(category => category.id === id)?.name).filter(Boolean)
  return [properties.name || '未命名设施', '设施类别：' + (names.join('、') || '待核查'),
    '地址：' + (properties.address || '暂无记录'), '来源：高德地图 POI · 地图记录',
    '采集时间：' + (properties.fetchedAt || '未知'), '核验状态：尚未现场核验',
    ...(categories.includes('parking') ? ['可用泊位、收费及公共开放条件：待核查'] : []),
  ]
}
