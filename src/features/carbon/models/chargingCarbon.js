export const CARBON_METHOD_VERSION = 'operational-co2-v1'
export const CARBON_SOURCES = {
  electricity: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf',
  explanation: 'https://www.mee.gov.cn/ywdt/zbft/202601/t20260105_1139911.shtml',
  gasoline: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/201511/W020190905506438255108.pdf#page=66',
  policy: 'https://www.ndrc.gov.cn/xxgk/jd/jd/202607/t20260709_1406391_ext.html',
}
export const ELECTRICITY_CO2_FACTORS = Object.freeze([
  { id: 'henan-2023', name: '河南省 · 2023 年', value: .5897, year: 2023 },
  { id: 'china-2023', name: '全国平均 · 2023 年', value: .5306, year: 2023 },
  { id: 'central-2023', name: '华中区域 · 2023 年', value: .5271, year: 2023 },
])
// Derived, not a separately published per-litre national factor. The density is a reference assumption.
export const DEFAULT_GASOLINE_CO2_PER_LITRE = Number((44.8 * .0189 * .98 * (44 / 12) * .73).toFixed(6))
export const CARBON_INPUT_DEFAULTS = Object.freeze({ mode:'energy', energyBasis:'grid', chargeKwh:24, batteryCapacityKwh:60,
  startSoc:20, targetSoc:80, chargingEfficiency:.9, evKwhPer100Km:15, gasolineLitresPer100Km:7.5,
  gasolineKgCO2PerLitre:DEFAULT_GASOLINE_CO2_PER_LITRE, factorId:'henan-2023', customGridFactor:.5897 })
const finite = value => typeof value === 'number' && Number.isFinite(value)

export function resolveCarbonFactor(input) {
  if (input.factorId === 'custom') return { id:'custom', name:'自定义情景因子', value:input.customGridFactor, year:null, source:null }
  const factor = ELECTRICITY_CO2_FACTORS.find(item => item.id === input.factorId)
  return factor ? { ...factor,source:CARBON_SOURCES.electricity } : null
}

export function estimateChargingCarbon(input) {
  const errors = [], factor = resolveCarbonFactor(input)
  if (!['energy','soc'].includes(input.mode)) errors.push('请选择充电量或电量百分比方式')
  if (!finite(input.chargingEfficiency) || input.chargingEfficiency <= 0 || input.chargingEfficiency > 1) errors.push('充电效率需大于 0 且不超过 1')
  if (!finite(input.evKwhPer100Km) || input.evKwhPer100Km <= 0) errors.push('电池侧百公里电耗须大于零')
  if (!finite(input.gasolineLitresPer100Km) || input.gasolineLitresPer100Km <= 0) errors.push('对照汽油车百公里油耗须大于零')
  if (!finite(input.gasolineKgCO2PerLitre) || input.gasolineKgCO2PerLitre <= 0) errors.push('汽油燃烧排放系数须大于零')
  if (!factor || !finite(factor.value) || factor.value < 0) errors.push('请选择有效电力因子或填写非负自定义值')
  if (input.mode === 'soc') {
    if (!finite(input.batteryCapacityKwh) || input.batteryCapacityKwh <= 0) errors.push('可用电池容量须大于零')
    if (![input.startSoc,input.targetSoc].every(value => finite(value) && value >= 0 && value <= 100) || input.targetSoc < input.startSoc) errors.push('电量百分比需在 0～100，目标不低于起始值')
  } else if (!finite(input.chargeKwh) || input.chargeKwh < 0 || !['grid','battery'].includes(input.energyBasis)) errors.push('请填写非负充电量并选择电量口径')
  if (errors.length) return { valid:false,errors }
  let gridKwh, batteryKwh
  if (input.mode === 'soc') {
    batteryKwh = input.batteryCapacityKwh * (input.targetSoc-input.startSoc)/100
    gridKwh = batteryKwh/input.chargingEfficiency
  } else if (input.energyBasis === 'battery') {
    batteryKwh = input.chargeKwh; gridKwh = batteryKwh/input.chargingEfficiency
  } else { gridKwh = input.chargeKwh; batteryKwh = gridKwh*input.chargingEfficiency }
  const distanceKm = batteryKwh/input.evKwhPer100Km*100
  const gasolineLitres = distanceKm/100*input.gasolineLitresPer100Km
  const gasolineCO2Kg = gasolineLitres*input.gasolineKgCO2PerLitre
  const electricityCO2Kg = gridKwh*factor.value
  const avoidedCO2Kg = gasolineCO2Kg-electricityCO2Kg
  return { valid:true,errors:[],methodVersion:CARBON_METHOD_VERSION,factor,gridKwh,batteryKwh,distanceKm,gasolineLitres,
    gasolineCO2Kg,electricityCO2Kg,avoidedCO2Kg,reductionPercent:gasolineCO2Kg>0 ? avoidedCO2Kg/gasolineCO2Kg*100 : null,
    avoidedKgPerGridKwh:gridKwh>0 ? avoidedCO2Kg/gridKwh : null,
    breakEvenGridFactor:gridKwh>0 ? gasolineCO2Kg/gridKwh : null,
    verdict:Math.abs(avoidedCO2Kg)<1e-9 ? 'neutral' : avoidedCO2Kg>0 ? 'reduction' : 'increase' }
}

export function restoreCarbonSettings(value) {
  const next = { ...CARBON_INPUT_DEFAULTS }
  if (!value || typeof value !== 'object') return next
  for (const key of Object.keys(next)) if (Object.hasOwn(value,key)) next[key] = value[key]
  return estimateChargingCarbon(next).valid ? next : { ...CARBON_INPUT_DEFAULTS }
}

export function createCarbonRecord(input, createdAt = new Date().toISOString(), id = globalThis.crypto?.randomUUID?.() || String(Date.now())) {
  const snapshot = Object.fromEntries(Object.keys(CARBON_INPUT_DEFAULTS).map(key => [key,input[key]]))
  if (!estimateChargingCarbon(snapshot).valid || !Number.isFinite(Date.parse(createdAt))) return null
  return { id,createdAt,methodVersion:CARBON_METHOD_VERSION,input:snapshot }
}

export function restoreCarbonRecords(value) {
  if (!Array.isArray(value)) return []
  return value.filter(row => row?.methodVersion === CARBON_METHOD_VERSION && typeof row.id === 'string' && Number.isFinite(Date.parse(row.createdAt))
    && row.input && estimateChargingCarbon(row.input).valid).slice(0,100)
}
