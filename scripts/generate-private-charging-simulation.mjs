import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { booleanPointInPolygon, centroid, distance, point } from '@turf/turf'

const root = process.cwd()
const outputDir = path.join(root, 'outputs', 'private-charging-simulation-v1')
const managedDir = path.join(root, 'data', 'managed', 'scenario-v1')
fs.mkdirSync(outputDir, { recursive: true })
fs.mkdirSync(managedDir, { recursive: true })

const VERSION = 'weidu-private-charging-scenario-v1.0-20261028'
const householdSize = 2.7

const scenarios = [
  {
    scenario_id: 'low_public_demand',
    scenario_label: '低公共充电需求',
    public_demand_level: '低',
    ev_household_penetration: 0.11,
    fixed_parking_share: 0.72,
    private_install_success_share: 0.82,
    public_charging_dependence_share: 0.22,
    private_charging_probability_per_day: 0.30,
    mean_energy_per_session_kwh: 18,
    ac7_share: 0.92,
    ac11_share: 0.08,
    public_demand_multiplier: 0.72,
    interpretation: '私人充电条件较好：固定车位和报装成功率较高，公共充电依赖较低。',
  },
  {
    scenario_id: 'base',
    scenario_label: '中等公共充电需求',
    public_demand_level: '中',
    ev_household_penetration: 0.14,
    fixed_parking_share: 0.55,
    private_install_success_share: 0.65,
    public_charging_dependence_share: 0.42,
    private_charging_probability_per_day: 0.33,
    mean_energy_per_session_kwh: 20,
    ac7_share: 0.85,
    ac11_share: 0.15,
    public_demand_multiplier: 1,
    interpretation: '私人充电条件中等，作为主分析基准。',
  },
  {
    scenario_id: 'high_public_demand',
    scenario_label: '高公共充电需求',
    public_demand_level: '高',
    ev_household_penetration: 0.17,
    fixed_parking_share: 0.36,
    private_install_success_share: 0.45,
    public_charging_dependence_share: 0.65,
    private_charging_probability_per_day: 0.36,
    mean_energy_per_session_kwh: 22,
    ac7_share: 0.78,
    ac11_share: 0.22,
    public_demand_multiplier: 1.32,
    interpretation: '新能源汽车家庭比例较高，但固定车位与报装条件受限，公共充电依赖显著提高。',
  },
].map((row) => ({
  ...row,
  parameter_nature: '研究者设定的敏感性情景，不是魏都区实测概率',
  evidence_level: '低至中；方向受政策与文献约束，具体数值待本地调查校准',
  simulation_version: VERSION,
}))

const sceneQ = {
  low_public_demand: {
    population: 0.55,
    work: 0.70,
    shopping: 0.80,
    leisure: 0.72,
    public_service_transport: 0.78,
  },
  base: {
    population: 0.80,
    work: 0.95,
    shopping: 1.10,
    leisure: 0.90,
    public_service_transport: 1.00,
  },
  high_public_demand: {
    population: 1.20,
    work: 1.25,
    shopping: 1.45,
    leisure: 1.20,
    public_service_transport: 1.30,
  },
}

const sceneLabels = {
  population: '人口（替代原居住POI）',
  work: '工作',
  shopping: '商业',
  leisure: '休闲',
  public_service_transport: '公共服务/交通',
}

const weekdayProfile = [2, 1, 1, 1, 1, 1, 1, 2, 3, 3, 3, 3, 4, 3, 3, 3, 4, 6, 9, 11, 11, 10, 8, 6]
const weekendProfile = [2, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4, 5, 5, 5, 5, 5, 6, 8, 10, 10, 9, 7, 5]

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
const residential = readJson('public/geojson/residential-pois.json')
const hexGrid = readJson('public/geojson/hex-grid.json')
const populationGrid = readJson('data/processed/planning-baseline/population-grid.geojson')
const populationByGrid = new Map(populationGrid.features.map((feature) => [Number(feature.properties.id), feature.properties]))

const random01 = (key) => {
  const hash = crypto.createHash('sha256').update(`${VERSION}|${key}`).digest()
  return hash.readUInt32BE(0) / 0xffffffff
}

const round = (value, digits = 3) => Number(Number(value).toFixed(digits))
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const hexCentroids = hexGrid.features.map((feature) => ({
  feature,
  center: centroid(feature),
}))

const assignedPoints = residential.features.map((feature) => {
  let matched = hexGrid.features.find((hex) => booleanPointInPolygon(feature, hex))
  let assignmentMethod = 'point_in_polygon'
  if (!matched) {
    matched = hexCentroids
      .map(({ feature: hex, center }) => ({ hex, km: distance(feature, center) }))
      .sort((a, b) => a.km - b.km)[0].hex
    assignmentMethod = 'nearest_hex_centroid_fallback'
  }
  return { feature, gridId: Number(matched.properties.id), assignmentMethod }
})

const countsByGrid = new Map()
for (const item of assignedPoints) {
  countsByGrid.set(item.gridId, (countsByGrid.get(item.gridId) || 0) + 1)
}

const residentialGridPopulations = [...countsByGrid.keys()]
  .map((id) => Number(populationByGrid.get(id)?.populationModelCount))
  .filter((value) => Number.isFinite(value) && value > 0)
  .sort((a, b) => a - b)
const medianPopulation = residentialGridPopulations[Math.floor(residentialGridPopulations.length / 2)]

const siteSizeFactor = (name = '') => {
  if (/家属院|家属区|家属楼|散居|宿舍/.test(name)) return 0.72
  if (/公寓|大厦|广场/.test(name)) return 0.86
  if (/花园|绿洲|新城|名苑|小区|家园|府|湾|城/.test(name)) return 1.12
  return 1
}

const weightsByGrid = new Map()
for (const item of assignedPoints) {
  const props = item.feature.properties
  const weight = siteSizeFactor(props.name) * (0.82 + random01(`${props.id}|population_weight`) * 0.36)
  if (!weightsByGrid.has(item.gridId)) weightsByGrid.set(item.gridId, new Map())
  weightsByGrid.get(item.gridId).set(props.id, weight)
}

const rows = assignedPoints.map((item) => {
  const { feature, gridId, assignmentMethod } = item
  const props = feature.properties
  const [lon, lat] = feature.geometry.coordinates
  const populationProps = populationByGrid.get(gridId) || {}
  const rawPopulation = Number(populationProps.populationModelCount)
  const effectiveGridPopulation = Number.isFinite(rawPopulation) && rawPopulation > 0 ? rawPopulation : medianPopulation
  const populationFillMethod = Number.isFinite(rawPopulation) && rawPopulation > 0
    ? 'population_model_grid_value'
    : 'fallback_median_of_residential_grids'
  const weightMap = weightsByGrid.get(gridId)
  const totalWeight = [...weightMap.values()].reduce((sum, value) => sum + value, 0)
  const allocationWeight = weightMap.get(props.id)
  const allocatedPopulation = effectiveGridPopulation * allocationWeight / totalWeight
  const householdProxy = Math.max(1, Math.round(allocatedPopulation / householdSize))
  const localParkingFactor = round(0.76 + random01(`${props.id}|parking`) * 0.48, 4)
  const localInstallFactor = round(0.86 + random01(`${props.id}|install`) * 0.28, 4)
  const managementMode = random01(`${props.id}|management`) < 0.22
    ? 'property_centralized_or_unified_service'
    : 'resident_self_owned'
  const orderedChargingSupport = random01(`${props.id}|ordered`) < 0.38 ? 'simulated_supported' : 'unknown_or_not_simulated'
  const installationCost = Math.round((4200 + random01(`${props.id}|cost`) * 4800) / 100) * 100

  const scenarioValues = {}
  for (const scenario of scenarios) {
    const localFixedShare = clamp(scenario.fixed_parking_share * localParkingFactor, 0.12, 0.90)
    const localInstallShare = clamp(scenario.private_install_success_share * localInstallFactor, 0.18, 0.96)
    const expectedChargers = householdProxy * scenario.ev_household_penetration * localFixedShare * localInstallShare
    const chargerCount = Math.max(0, Math.round(expectedChargers))
    const ac11Count = Math.round(chargerCount * scenario.ac11_share)
    const ac7Count = chargerCount - ac11Count
    const capacityKw = ac7Count * 7 + ac11Count * 11
    const sessions = chargerCount * scenario.private_charging_probability_per_day
    const dailyEnergy = sessions * scenario.mean_energy_per_session_kwh
    scenarioValues[scenario.scenario_id] = {
      localFixedShare,
      localInstallShare,
      chargerCount,
      ac7Count,
      ac11Count,
      capacityKw,
      sessions,
      dailyEnergy,
    }
  }

  const low = scenarioValues.low_public_demand
  const base = scenarioValues.base
  const high = scenarioValues.high_public_demand
  return {
    residential_poi_id: props.id,
    residential_name: props.name,
    address: props.address || '',
    lon_gcj02: lon,
    lat_gcj02: lat,
    coord_system: props.coordSystem || 'GCJ-02',
    original_poi_type: props.type || '',
    grid_id: gridId,
    grid_assignment_method: assignmentMethod,
    residential_poi_count_in_grid: countsByGrid.get(gridId),
    population_model_count_grid: Number.isFinite(rawPopulation) ? round(rawPopulation, 3) : '',
    population_used_grid: round(effectiveGridPopulation, 3),
    population_fill_method: populationFillMethod,
    population_year: populationProps.populationYear ?? 2025,
    population_is_projection: populationProps.populationIsProjection ?? true,
    population_calibrated: populationProps.populationCalibrated ?? false,
    allocation_weight: round(allocationWeight, 4),
    allocated_population_proxy: round(allocatedPopulation, 2),
    household_size_scenario: householdSize,
    household_proxy: householdProxy,
    local_fixed_parking_factor: localParkingFactor,
    local_install_factor: localInstallFactor,
    access_type: 'private_resident_authorized_only',
    public_open_status: 'not_open_to_public',
    authorized_open_hours: '00:00-24:00_for_authorized_owner',
    charger_ownership_mode: managementMode,
    ordered_charging_support: orderedChargingSupport,
    simulated_avg_installation_cost_cny: installationCost,
    service_fee_cny_per_kwh: 0,
    electricity_price_note: '居民自用充电设施电价，未采集魏都区逐户账单，不填具体电价',
    private_charger_count_low_public_demand: low.chargerCount,
    ac7_count_low_public_demand: low.ac7Count,
    ac11_count_low_public_demand: low.ac11Count,
    site_capacity_kw_low_public_demand: low.capacityKw,
    daily_private_sessions_low_public_demand: round(low.sessions, 2),
    daily_private_energy_kwh_low_public_demand: round(low.dailyEnergy, 2),
    private_charger_count_base: base.chargerCount,
    ac7_count_base: base.ac7Count,
    ac11_count_base: base.ac11Count,
    site_capacity_kw_base: base.capacityKw,
    daily_private_sessions_base: round(base.sessions, 2),
    daily_private_energy_kwh_base: round(base.dailyEnergy, 2),
    private_charger_count_high_public_demand: high.chargerCount,
    ac7_count_high_public_demand: high.ac7Count,
    ac11_count_high_public_demand: high.ac11Count,
    site_capacity_kw_high_public_demand: high.capacityKw,
    daily_private_sessions_high_public_demand: round(high.sessions, 2),
    daily_private_energy_kwh_high_public_demand: round(high.dailyEnergy, 2),
    spatial_variation_method: '住宅POI权重+固定SHA-256种子局地车位/报装因子；不形成连续同值片区',
    numeric_value_basis: '人口投影栅格分配+政策/论文方向约束+研究者敏感性参数',
    uncertainty_level: 'high',
    data_nature: '模拟情景（住宅POI名称、地址、坐标为原始采集字段）',
    simulation_version: VERSION,
  }
}).sort((a, b) => a.grid_id - b.grid_id || a.residential_name.localeCompare(b.residential_name, 'zh-CN'))

const qRows = []
for (const scenario of scenarios) {
  for (const [sceneId, qValue] of Object.entries(sceneQ[scenario.scenario_id])) {
    qRows.push({
      scenario_id: scenario.scenario_id,
      scenario_label: scenario.scenario_label,
      scene_id: sceneId,
      scene_label: sceneLabels[sceneId],
      weight_wk: 0.2,
      redesigned_qk: qValue,
      public_demand_multiplier: scenario.public_demand_multiplier,
      public_charging_dependence_share: scenario.public_charging_dependence_share,
      design_logic: 'Q_k随公共充电依赖增强而提高；商业场景保留较高的目的地充电倾向，人口项替代原居住POI计数。',
      parameter_nature: '探索性相对系数，不是实际充电概率',
      simulation_version: VERSION,
    })
  }
}

const profileRows = [
  ['weekday', '工作日', weekdayProfile],
  ['weekend', '周末', weekendProfile],
].map(([dayType, dayLabel, values]) => {
  const row = {
    profile_id: `private_home_${dayType}_v0.1`,
    charging_location: 'private_home',
    day_type: dayType,
    day_type_label: dayLabel,
    unit: 'percent_of_daily_private_charging_start_events',
  }
  values.forEach((value, hour) => { row[`H${String(hour).padStart(2, '0')}`] = value })
  row.row_sum_percent = values.reduce((sum, value) => sum + value, 0)
  row.profile_nature = '文献规律约束的初始情景曲线；非魏都区实测；各情景共用归一化形状，情景差异由总量参数控制'
  row.simulation_version = VERSION
  return row
})

const sourceRows = [
  {
    source_id: 'SRC-01',
    title: '国家能源局发布2025年12月全国电动汽车充电设施数据',
    organization: '国家能源局',
    year: 2026,
    url: 'https://www.nea.gov.cn/20260121/da0f536fbafe4545820a2f64465e773b/c.html',
    used_for: '说明私人充电设施已成为全国充电基础设施主体之一；不直接下推为魏都区数量',
    evidence_type: '国家统计背景',
  },
  {
    source_id: 'SRC-02',
    title: '电动汽车充电设施服务能力“三年倍增”行动方案（2025—2027年）',
    organization: '国家发展改革委等部门',
    year: 2025,
    url: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202510/P020251015595398499456.pdf',
    used_for: '约束固定车位、私人桩比例和既有小区改造的情景方向',
    evidence_type: '国家政策',
  },
  {
    source_id: 'SRC-03',
    title: '响水县居民住宅小区和公共建筑电动汽车充电基础设施建设管理办法',
    organization: '响水县人民政府',
    year: 2022,
    url: 'https://www.xiangshui.gov.cn/art/2022/5/29/art_34192_4115477.html',
    used_for: '私人自用桩7kW和固定车位/安装接入条件的技术情景参考；不是魏都区地方标准',
    evidence_type: '地方政府公开规范',
  },
  {
    source_id: 'SRC-04',
    title: 'Insights into Household Electric Vehicle Charging Behavior: Analysis and Predictive Modeling',
    organization: 'Energies',
    year: 2024,
    url: 'https://doi.org/10.3390/en17040925',
    used_for: '家庭充电开始时间晚间上升、约17时附近出现峰值的曲线方向',
    evidence_type: '同行评议论文（外地样本）',
  },
  {
    source_id: 'SRC-05',
    title: 'Hourly charging profiles for electric vehicles and their effect on the aggregated consumption profile in Denmark',
    organization: 'International Journal of Electrical Power & Energy Systems',
    year: 2021,
    url: 'https://doi.org/10.1016/j.ijepes.2021.106900',
    used_for: '家庭充电晚间/夜间峰值及工作日与周末差异的方向性约束',
    evidence_type: '同行评议论文（丹麦样本）',
  },
  {
    source_id: 'SRC-06',
    title: 'Electric Vehicle User Behavior: An Analysis of Charging Station Utilization in Canada',
    organization: 'Energies',
    year: 2023,
    url: 'https://doi.org/10.3390/en16041592',
    used_for: '住宅充电主要在傍晚至次日早晨占用的方向性约束',
    evidence_type: '同行评议论文（加拿大样本）',
  },
  {
    source_id: 'SRC-07',
    title: '魏都区项目住宅POI与2025人口投影六边形',
    organization: '本项目已有数据',
    year: 2025,
    url: 'local://public/geojson/residential-pois.json;local://data/processed/planning-baseline/population-grid.geojson',
    used_for: '保留住宅名称和坐标，并分配人口投影代理量',
    evidence_type: '项目空间输入；人口未做本地总量校准',
  },
]

const csvEscape = (value) => {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const writeCsv = (filePath, data) => {
  const headers = Object.keys(data[0])
  const text = [headers.join(','), ...data.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\r\n')
  fs.writeFileSync(filePath, `\uFEFF${text}`, 'utf8')
}

const outputs = [
  ['07_私人充电设施模拟属性.csv', rows],
  ['08_私人充电低中高情景参数_重设计.csv', scenarios],
  ['09_公共需求Qk参数_重设计.csv', qRows],
  ['10_私人充电24小时开始分布_百分比.csv', profileRows],
  ['11_私人充电模拟来源与方法.csv', sourceRows],
]

for (const [filename, data] of outputs) {
  writeCsv(path.join(outputDir, filename), data)
  writeCsv(path.join(managedDir, filename), data)
}

const summary = {
  simulation_version: VERSION,
  generated_at: new Date().toISOString(),
  residential_anchor_count: rows.length,
  source_coordinate_system: 'GCJ-02',
  nearest_hex_fallback_count: rows.filter((row) => row.grid_assignment_method !== 'point_in_polygon').length,
  population_fallback_count: rows.filter((row) => row.population_fill_method !== 'population_model_grid_value').length,
  scenario_totals: Object.fromEntries(scenarios.map((scenario) => {
    const suffix = scenario.scenario_id === 'base' ? 'base' : scenario.scenario_id
    return [scenario.scenario_id, {
      private_chargers: rows.reduce((sum, row) => sum + Number(row[`private_charger_count_${suffix}`]), 0),
      installed_capacity_kw: rows.reduce((sum, row) => sum + Number(row[`site_capacity_kw_${suffix}`]), 0),
      daily_private_sessions: round(rows.reduce((sum, row) => sum + Number(row[`daily_private_sessions_${suffix}`]), 0), 2),
      daily_private_energy_kwh: round(rows.reduce((sum, row) => sum + Number(row[`daily_private_energy_kwh_${suffix}`]), 0), 2),
    }]
  })),
  warnings: [
    '所有私人充电数量、功率、费用、利用率均为模拟情景，不是实测或逐户登记数据。',
    '每一行表示住宅POI关联的私人充电设施聚合量，不代表精确住户门牌或单个私人充电站。',
    '人口为2025年投影栅格且未用魏都区统计总量校准，只适合相对空间分析。',
    '低/中/高指公共充电需求水平：低公共需求对应更好的私人充电条件，高公共需求对应更差的私人充电条件。',
  ],
}
fs.writeFileSync(path.join(outputDir, 'private_charging_simulation_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

const readme = [
  '# 魏都区私人充电设施模拟数据 v1',
  '',
  '## 数据性质',
  '',
  `- 住宅锚点：${rows.length} 个，名称、地址与 GCJ-02 坐标取自项目原始住宅 POI，不做移动。`,
  '- 单行含义：住宅 POI 对应小区或居住设施内的私人充电设施聚合量，不是精确到户的位置。',
  '- 所有私人桩数量、功率、费用、次数和电量均为情景模拟，不能写成魏都区实测数据。',
  '- 人口输入为 2025 年人口投影栅格，未做本地统计总量校准，只适合相对空间分析。',
  '',
  '## 方法摘要',
  '',
  '住宅POI匹配六边形grid_id → 六边形人口按住宅权重守恒分配 → 分配人口除以2.7得到家庭代理量 → 家庭代理量 × EV家庭比例 × 固定车位率 × 报装成功率 → 私人桩模拟数量。',
  '',
  '私人桩再按 7 kW/11 kW 比例计算装机容量，并按每日充电概率和单次电量计算日均次数与电量。',
  '',
  '## 情景方向',
  '',
  '- 低公共需求：私人固定车位与报装条件较好，公共充电依赖较低。',
  '- 中等公共需求：基准情景。',
  '- 高公共需求：新能源汽车家庭比例可能更高，但固定车位和报装条件受限，公共充电依赖较高。',
  '',
  '低、中、高指公共充电需求，不是私人桩数量。低公共需求情景的私人桩数量应高于中等情景；高公共需求情景的私人桩数量应最低。',
  '',
  '## 空间差异与复现',
  '',
  '局地车位与报装因子使用住宅 POI 编号、模拟版本和固定 SHA-256 种子生成。相同版本重复运行结果一致，不同住宅点保留差异，避免整片连续同值。该方法不代表真实抽样。',
  '',
  '重新生成数据：node scripts/generate-private-charging-simulation.mjs',
  '',
  '完整方法见：docs/reports/魏都区私人充电设施模拟方法与情景参数说明_v1.md。',
  '',
].join('\n')
fs.writeFileSync(path.join(outputDir, 'README.md'), readme, 'utf8')

console.log(JSON.stringify(summary, null, 2))
