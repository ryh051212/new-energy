function simulatedFieldSet(properties = {}) {
  let fields = properties.simulatedFields
  if (typeof fields === 'string') {
    try { fields = JSON.parse(fields) } catch { fields = [] }
  }
  return new Set(Array.isArray(fields) ? fields : [])
}

function openingSchedule(value) {
  const text = String(value || '').trim()
  if (!text || /未知|待核实|按管理方许可|维护状态/.test(text)) return { text: '', limited: false }
  return { text, limited: !/^(00:00-24:00|全天|24\s*小时)$/i.test(text) }
}

// 开放状态定义：运营停用信息优先于公共开放资料；模拟状态必须明确标注为情景值。
export function stationOpenStatus(properties = {}) {
  const status = properties.status
  const schedule = openingSchedule(properties.openingHours)
  const simulated = simulatedFieldSet(properties)

  if (status === 'retired') return { code: 'retired', label: '已停用', note: '站点已退出当前服务范围', hours: '' }
  if (status === 'maintenance') return { code: 'maintenance', label: '维护中', note: '当前记录为维护状态，恢复时间待核实', hours: schedule.text }
  if (status === 'offline') return { code: 'offline', label: '暂不可用', note: '当前记录为离线或暂停状态', hours: schedule.text }
  if (properties.publicAccess === false) return { code: 'restricted', label: '限制使用', note: '非完全公共开放，可能需要车辆、单位或场地许可', hours: schedule.text }

  if (properties.publicAccess === true) {
    if (schedule.limited) return { code: 'limited', label: '限时开放', note: '已有公共开放资料，但不是实时可用性信息', hours: schedule.text }
    return { code: 'public', label: '公开开放', note: '已有公共开放资料，但空闲枪数仍需实时核实', hours: schedule.text }
  }

  if (status === 'active' && simulated.has('status')) {
    return schedule.limited
      ? { code: 'scenario-limited', label: '情景限时开放', note: '开放状态和时间由情景参数补全，尚未现场核实', hours: schedule.text }
      : { code: 'scenario', label: '情景开放', note: '开放状态由情景参数补全，不代表实时运营', hours: schedule.text }
  }

  return { code: 'unverified', label: '开放待核实', note: '站点未停用，但缺少充分的公共开放证据', hours: schedule.text }
}
