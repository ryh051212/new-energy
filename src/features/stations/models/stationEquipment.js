import { safeInformationSource, timestamp } from './stationInformation.js'

const count = value => Number.isInteger(value) && value >= 0 ? value : null
const power = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
const capacity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const unknown = () => ({ state: 'unknown', pileCount: null, gunCount: null, installedPowerKw: null,
  maxGunPowerKw: null, groups: [], sources: [], note: '枪数、逐枪功率和全站额定功率尚待补充。' })

// MapLibre 查询结果会将嵌套对象序列化为字符串；搜索接口则返回原始对象。
export function equipmentSnapshot(properties = {}) {
  if (properties.chargingEquipment == null) return null
  let equipment = properties.chargingEquipment
  if (typeof equipment === 'string') {
    try { equipment = JSON.parse(equipment) } catch { return unknown() }
  }
  if (!equipment || typeof equipment !== 'object') return unknown()
  const sources = (Array.isArray(equipment.sources) ? equipment.sources : []).flatMap(source => {
    const url = safeInformationSource(source?.url)
    return url ? [{ ...source, url }] : []
  })
  const checked = timestamp(equipment.checkedAt)
  if (equipment.state !== 'sourced' || !sources.length || checked === null || checked > Date.now()) return unknown()
  return { ...equipment, pileCount: count(equipment.pileCount), gunCount: count(equipment.gunCount),
    installedPowerKw: capacity(equipment.installedPowerKw), maxGunPowerKw: power(equipment.maxGunPowerKw),
    groups: Array.isArray(equipment.groups) ? equipment.groups : [], sources }
}

export function stationEquipmentFacts(properties = {}) {
  const equipment = equipmentSnapshot(properties)
  if (!equipment) return { available: false, lines: [], groups: [], sources: [] }
  const number = (value, unit) => value === null ? '未知' : `${value} ${unit}`
  const label = equipment.state !== 'sourced' ? '待补充' : equipment.basis?.startsWith('historical') ? '历史公开配置'
    : equipment.basis === 'conflicting_reports' ? '资料存在差异' : equipment.basis === 'directory_only' ? '目录线索'
    : equipment.basis === 'unconfirmed_archive' ? '历史线索待复核' : '公开资料'
  const groups = equipment.groups.map(group => {
    const units = count(group.unitCount), guns = count(group.gunCount), unitPower = power(group.unitPowerKw), gunPower = power(group.gunPowerKw)
    const text = [String(group.label || '设备'), units === null ? '设备数未知' : `${units} 台`,
      guns === null ? '枪数未知' : `${guns} 把枪`, unitPower === null ? '' : `每台设备 ${unitPower} kW`,
      gunPower === null ? '每枪功率未公布' : `每枪标称 ${gunPower} kW`,
      power(group.ratedCurrentA) === null ? '' : `额定电流 ${group.ratedCurrentA} A`].filter(Boolean).join(' · ')
    return { text, note: group.note || '' }
  })
  return { available: true, label, ...equipment, groups,
    lines: [`充电终端（桩）：${number(equipment.pileCount, '台')} · 充电枪：${number(equipment.gunCount, '把')}`,
      `站内最高单枪功率：${number(equipment.maxGunPowerKw, 'kW')}`,
      `设备额定输出合计：${number(equipment.installedPowerKw, 'kW')}`] }
}

export function appendEquipmentDetails(content, properties, doc = globalThis.document, { showSources = true } = {}) {
  const facts = stationEquipmentFacts(properties)
  if (!facts.available) return
  const section = doc.createElement('section')
  section.className = 'station-equipment-facts'
  const add = (parent, tag, text) => { const node = doc.createElement(tag); node.textContent = text; parent.append(node); return node }
  add(section, 'strong', `设备配置 · ${facts.label}`)
  facts.lines.forEach(line => add(section, 'p', line))
  const details = doc.createElement('details')
  add(details, 'summary', showSources ? '设备明细与来源' : '设备明细')
  facts.groups.forEach(group => { add(details, 'p', group.text); if (showSources && group.note) add(details, 'small', group.note) })
  if (showSources) {
    if (facts.sourceDate) add(details, 'small', `资料时期：${facts.sourceDate}`)
    if (facts.checkedAt) add(details, 'small', `资料核对：${facts.checkedAt.slice(0, 10)}（未现场核验）`)
    add(details, 'small', facts.note)
    add(details, 'small', '设备额定合计不等于配变容量或实时可用功率；单枪峰值不代表每枪同时输出。')
    for (const source of facts.sources) {
      const link = add(details, 'a', (source.label || '资料来源') + (source.method === 'search_snapshot' ? '（检索存档）' : ''))
      link.href = source.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
  }
  section.append(details)
  content.append(section)
}
