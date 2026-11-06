// 车主决策只使用明确提供的字段；快充/普通充电不能推断直流/交流。
export const LIVE_AVAILABILITY_MAX_AGE_MS = 5 * 60 * 1000
export const knownNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
export function isDemoField(properties, ...fields) {
  return properties.isSynthetic === true || (Array.isArray(properties.simulatedFields) && properties.simulatedFields.some(field => fields.includes(field)))
}
export function timestamp(value) {
  // 不将无时区时间、数据库入库时间或空值冒充现场核验时间。
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
}
export function formatInformationTime(value) {
  if (timestamp(value) === null) return ''
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
}
export function chargingCompatibility(properties = {}, context = {}) {
  const supplied = properties.chargingCurrentTypes
  // 类型列表必须完整且有效，含未知类型时不能断言“不支持”。
  const types = !isDemoField(properties, 'chargingCurrentTypes') && Array.isArray(supplied) && supplied.length
    && supplied.every(type => ['DC', 'AC'].includes(type)) ? [...new Set(supplied)] : []
  const requirement = ['DC', 'AC', 'either'].includes(context.chargingRequirement) ? context.chargingRequirement : null
  const explicitMismatch = !isDemoField(properties, 'vehicleCompatible') && properties.vehicleCompatible === false
  const unmatchedPartial = !!requirement && requirement !== 'either' && types.length > 0
    && !types.includes(requirement) && properties.chargingCurrentTypesComplete === false
  const mismatch = explicitMismatch || (!!requirement && types.length > 0 && requirement !== 'either'
    && !types.includes(requirement) && !unmatchedPartial)
  const currentType = types.length ? types.map(type => type === 'DC' ? '直流 DC' : '交流 AC').join(' / ') : '直流／交流未知'
  const requirementLabel = requirement === 'DC' ? '本车需要直流' : requirement === 'AC' ? '本车需要交流' : requirement === 'either' ? '本车直流、交流均可' : '本车充电需求未设置'
  return { types, requirement, currentType, requirementLabel, prohibited: mismatch,
    status: mismatch ? '禁止充电 · 不符合本车需求' : !requirement || !types.length || unmatchedPartial ? '适配未知' : '充电类型符合需求',
    note: mismatch ? requirementLabel : !requirement ? '请在车辆设置中确认本车需求' : !types.length ? requirementLabel
      : properties.chargingCurrentTypesComplete === false ? '仅核对已列类型，其他类型及本车接口适配仍需确认' : '接口适配未核验',
  }
}
export function stationAvailability(properties = {}, now = Date.now()) {
  const updated = timestamp(properties.availabilityUpdatedAt)
  const expires = timestamp(properties.availabilityExpiresAt)
  const hasRealtime = properties.availabilityIsRealtime === true && knownNumber(properties.availableCount)
    && Number.isInteger(properties.availableCount) && updated !== null && updated <= now
    && now - updated <= LIVE_AVAILABILITY_MAX_AGE_MS
    && (properties.availabilityExpiresAt == null || (expires !== null && expires > now))
    && !isDemoField(properties, 'availableCount', 'availabilityIsRealtime', 'availabilityUpdatedAt', 'availabilityExpiresAt')
  const waitingKnown = hasRealtime && knownNumber(properties.estimatedWaitMinutes) && !isDemoField(properties, 'estimatedWaitMinutes')
  return { hasRealtime, availableCount: hasRealtime ? properties.availableCount : null,
    status: hasRealtime ? `空闲 ${properties.availableCount} 个` : '没有实时数据',
    updatedAt: updated !== null && !isDemoField(properties, 'availabilityUpdatedAt') ? formatInformationTime(properties.availabilityUpdatedAt) : '',
    note: waitingKnown ? `运营方预计等待 ${Math.ceil(properties.estimatedWaitMinutes)} 分钟`
      : hasRealtime ? properties.availableCount > 0 ? '空闲数量不等于无需排队' : '当前无空闲桩，等待时间未知' : '无法判断是否需要排队',
  }
}
export function stationPrice(properties = {}, field) {
  const dependent = field === 'pricePerKwh' ? ['pricePerKwh', 'electricityPrice', 'servicePrice'] : [field]
  return knownNumber(properties[field]) && properties[field] > 0 && !isDemoField(properties, ...dependent) ? properties[field] : null
}
export function routeTollText(value) {
  return knownNumber(value) && value > 0 ? `道路收费 ${value} 元` : '道路收费 暂无价格'
}

const stateLabels = { known: '已知', unknown: '未知', simulated: '模拟' }
const present = value => typeof value === 'string' ? !!value.trim()
  : typeof value === 'number' ? Number.isFinite(value) && value >= 0
    : Array.isArray(value) ? value.length > 0 : typeof value === 'boolean'
export function safeInformationSource(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}
export function informationState(properties, field, value = properties[field], now = Date.now(), dependencies = []) {
  const evidence = properties.fieldVerification?.[field]
  const sources = (Array.isArray(evidence?.sources) ? evidence.sources : [])
    .map(source => ({ label: (source.label || '核对来源') + (source.method === 'search_snapshot' ? '（检索快照）' : ''), url: safeInformationSource(source.url) })).filter(source => source.url)
  const checked = timestamp(evidence?.checkedAt)
  const validEvidence = evidence?.state === 'known' && checked !== null && checked <= now && sources.length > 0
  const state = !present(value) ? 'unknown' : isDemoField(properties, field, ...dependencies) ? 'simulated'
    : evidence && !validEvidence ? 'unknown' : 'known'
  return { state, label: stateLabels[state], sources, note: evidence?.note || '',
    checkedTime: checked !== null && checked <= now ? formatInformationTime(evidence.checkedAt) : '',
    archivedValue: evidence?.archivedValue || '' }
}

export function stationInformationStates(properties = {}, now = Date.now()) {
  const location = informationState(properties, 'locationDescription', properties.locationDescription || properties.address, now, ['address'])
  const opening = informationState(properties, 'openingHours', properties.openingHours, now)
  const entrance = informationState(properties, 'entranceDescription', properties.entranceDescription, now)
  const type = informationState(properties, 'chargeType', ['fast', 'regular'].includes(properties.chargeType) ? properties.chargeType : null, now)
  const currents = chargingCompatibility(properties).types
  const policy = informationState(properties, 'accessPolicy', properties.accessPolicy, now)
  const suffix = item => item.state === 'simulated' ? '（模拟）' : ''
  return [
    { key: 'location', title: '位置', ...location, value: location.state === 'unknown'
      ? location.archivedValue ? `存档位置：${location.archivedValue}` : properties.address ? `记录地址：${properties.address}` : '位置未知'
      : (properties.locationDescription || properties.address) + suffix(location),
      detail: location.note || '地图使用记录点位；当前位置及坐标准确性尚未现场核验。' },
    { key: 'opening', title: '开放情况', ...opening, value: opening.state === 'unknown' ? '开放时间未知' : properties.openingHours + suffix(opening),
      detail: [opening.note, policy.state === 'known' ? properties.accessPolicy : '允许车辆及进场限制未知', '实时运营状态未知'].filter(Boolean).join('；'),
      sources: [...opening.sources, ...policy.sources].filter((source, index, all) => all.findIndex(item => item.url === source.url) === index) },
    { key: 'entrance', title: '入口', ...entrance, value: entrance.state === 'unknown' ? entrance.archivedValue ? `存档：${entrance.archivedValue}` : '车行入口未知' : properties.entranceDescription + suffix(entrance),
      detail: entrance.note || '车行入口坐标未核验；路线仍以站点定位为终点。' },
    { key: 'chargeType', title: '充电类型', ...type, value: [type.state === 'unknown' ? '快充／普通充电未知'
      : (properties.chargeType === 'fast' ? '快充' : '普通充电') + suffix(type),
      currents.length ? currents.map(current => current === 'DC' ? '直流 DC' : '交流 AC').join(' / ') : '直流／交流未知'].join(' · '),
      detail: [type.note, properties.chargingCurrentTypesComplete === false ? '已列电流类型经过资料交叉核对，其他类型未知' : '车辆接口适配需另行确认'].filter(Boolean).join('；'),
      sources: [...type.sources, ...informationState(properties, 'chargingCurrentTypes', properties.chargingCurrentTypes, now).sources]
        .filter((source, index, all) => all.findIndex(item => item.url === source.url) === index) },
  ]
}
