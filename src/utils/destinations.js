export const DESTINATION_CATEGORIES = [
  { value: 'all', label: '全部用途' }, { value: 'commerce', label: '购物办事' },
  { value: 'work', label: '办公通勤' }, { value: 'dining', label: '餐饮就餐' },
  { value: 'education', label: '教育学习' }, { value: 'health', label: '医疗健康' },
  { value: 'leisure', label: '休闲文体' }, { value: 'residential', label: '居住生活' },
  { value: 'transport', label: '交通换乘' }, { value: 'other', label: '其他用途' },
]

export function destinationCategory(properties = {}) {
  const type = properties.type || ''
  // 住宅 POI 的前缀是“商务住宅”，不能因此误判为办公区。
  for (const [pattern, category] of [[/住宅区|住宅小区|别墅/, 'residential'], [/购物服务|商场|超级市场|综合市场/, 'commerce'],
    [/餐饮服务/, 'dining'], [/医疗保健|医院|诊所/, 'health'], [/学校|教育|科教文化/, 'education'],
    [/体育|休闲|风景名胜|公园/, 'leisure'], [/公司企业|写字楼|办公/, 'work'], [/交通设施|公交|地铁|火车站/, 'transport']]) {
    if (pattern.test(type)) return category
  }
  return properties.category === 'residential' ? 'residential' : 'other'
}

export function destinationCatalog(places = []) {
  const seen = new Set()
  return places.filter(place => {
    const coords = place.geometry?.coordinates
    return place.geometry?.type === 'Point' && Array.isArray(coords) && coords.length === 2
      && coords.every((value, i) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= (i ? 90 : 180))
  }).map(place => ({ id: String(place.properties.id || `${place.properties.name}|${place.geometry.coordinates}`),
    name: place.properties.name || '未命名地点', address: place.properties.address || '',
    category: destinationCategory(place.properties), coordinates: [...place.geometry.coordinates] }))
    .filter(place => { if (seen.has(place.id)) return false; seen.add(place.id); return true })
}

export function filterDestinations(places, category = 'all', query = '') {
  const search = query.trim().toLowerCase()
  return places.filter(place => (category === 'all' || place.category === category)
    && `${place.name} ${place.address}`.toLowerCase().includes(search))
}

export function normalizeDestinationInfo(value, coordinates) {
  if (!coordinates) return null
  return { id: typeof value?.id === 'string' ? value.id.slice(0, 200) : 'custom',
    name: typeof value?.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 100) : '自选目的地',
    address: typeof value?.address === 'string' ? value.address.slice(0, 200) : '',
    category: DESTINATION_CATEGORIES.some(item => item.value === value?.category && item.value !== 'all') ? value.category : 'other',
    coordinates: [...coordinates] }
}
