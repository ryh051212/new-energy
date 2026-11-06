# 魏都区新能源汽车充电规划基础数据

本次执行日期：2026-10-27（北京时间）。核心文件来自真实空间记录与公开人口模型；自主情景只放在parameters目录。没有把模拟CSV、缺失枪数或假定功率写成实测值。

完整说明：[数据采集与质量报告](reports/数据采集与质量报告.md) · [机器质量检查](reports/quality_report.json) · [来源清单](metadata/data_sources.csv)。

## 文件清单与获取状态

| 数据 | 来源 | 年份/时点 | 格式 | 获取状态 | 完整性 | 本地文件 |
|---|---|---|---|---|---|---|
| 现有研究区边界 | 项目 PostGIS / 原始 AreaCity-Polygon | 边界版本不明 | GeoJSON | 已实际获取 | 几何有效；不是新取得的权威行政勘界成果，面积约90.1093km² | boundary/weidu_boundary.geojson |
| 现行法定行政边界 | 地方自然资源或民政部门 | 待确认 | 矢量 | 需要申请 | 未取得公开可直接下载的现行官方GeoJSON；现有边界版本与统计口径须核对 |  |
| 居民人口栅格 | EC JRC GHS-POP R2023A | 2025预测，R2023A版本 | GeoTIFF | 已实际获取 | 每像元估计人数；3角秒；不是2025人口普查实测 | population/population.tif |
| WorldPop候选人口栅格 | WorldPop R2025A v1 | 2025模型 | GeoTIFF | 可下载但尚未获取 | 已取得官方STAC元数据；全国文件下载中断，.part不得用于分析 |  |
| 五类城市功能POI | 高德官方API原始快照 | 2026采集快照；对象更新时间未知 | GeoJSON | 已实际获取 | 1993条；五类齐全但受API结果窗口限制，不等于完整名录 | pois/pois.geojson |
| 周边道路与节点拓扑 | OpenStreetMap Overpass | 2026-10-27快照 | GeoJSON + JSON | 已实际获取 | 2987条way；10km周边；保留2条转向限制但尚未应用 | roads/roads.geojson; roads/road_network.json |
| 充电设施地点 | 高德原始API + 已有逐字段公开证据 | 2026查询；历史原始记录日期部分未知 | GeoJSON | 已实际获取 | 247条地点（区内201、周边46）；开放性、枪数和功率大量缺失，不等于已核实公共站名录 | charging/charging_stations.geojson |
| 用地与停车设施 | OSM既有快照 + 高德停车POI | OSM基准2026-07-15；高德2026-10-16 | GeoJSON | 已实际获取 | 172个用地面+225条停车POI；多数容量未知；不是397个独立场地 | buildings/buildings_parking.geojson |
| 建筑轮廓及用途/规模 | OSM建筑查询 | 当前 | GeoJSON | 可下载但尚未获取 | 多次HTTP/TLS/代理失败，未取得真实建筑轮廓；未造假补面 |  |
| 河南私人汽车统计 | 河南省统计局/国家统计局河南调查总队，河南日报载 | 2025 | CSV + 原网页 | 已实际获取 | 省级民用汽车2310.69万辆、私人汽车2146.15万辆；不能替代魏都区 | metadata/statistical_context.csv |
| 许昌充电建设公开信息 | 许昌发改委/住建局 | 2024及2023–2035规划 | CSV + HTML/PDF | 已实际获取 | 年度新增完成量与规划目标分开；不作为魏都区现状总量 | metadata/statistical_context.csv |
| 魏都区私人新能源车保有量 | 尚无核实的区级公开统计 | 待核实 | 无 | 未找到 | 本次未找到可核实的私人新能源车区级数值，不以省/市/产量/销量冒充 |  |
| 私人车工作日/周末时段曲线 | Zhan et al.作者Zenodo数据 | 2020-11至2021-10，论文2025 | CSV | 已实际获取 | 192条15分钟状态占比；七个其他城市；不区分公共与私人充电 | parameters/time_profiles.csv |
| 功能区活动及公共依赖情景 | 本项目显式假设 | 非观测 | JSON + CSV | 已实际获取 | 240条活动假设；各绝对需求校准量保持null，不用于冒充观测 | parameters/scenario_params.json; parameters/time_activity_assumptions.csv |

每条来源的可访问URL、获取方法、许可和采集日期在data_sources.csv。API快照日期与对象更新时间不等价。原始下载中的.part是失败或进行中文件，不进入正式数据和分发包。

## 执行流程

```text
① core：复用WGS84边界 → 校验几何 → 原始高德记录转坐标、去重、裁剪 → 排除模拟字段
↓
② amap / osm：官方API正常分页 → 保留原始响应和请求元数据
   ├─ 成功：发布经过检查的真实记录
   └─ 配额/授权/网络失败：保留失败状态与旧真实快照，不生成模拟替代物
↓
③ population：下载GHSL官方2025地理瓦片 → 检查实际范围和CRS → 裁剪GeoTIFF，不插值人数
↓
④ build_parameters：作者数据校验 → 提取私人车日型曲线 → 自主活动假设另存并标记
↓
⑤ qa → build_report：几何/缺失/邻近重复/拓扑检查 → 来源CSV、报告、校验和及轻量ZIP
```

## Windows / Python 3.12 复现

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements.txt
.\.venv\Scripts\python.exe -X utf8 scripts/pipeline.py core
.\.venv\Scripts\python.exe -X utf8 scripts/pipeline.py osm
.\.venv\Scripts\python.exe -X utf8 scripts/pipeline.py population
.\.venv\Scripts\python.exe -X utf8 scripts/build_parameters.py
.\.venv\Scripts\python.exe -X utf8 scripts/pipeline.py qa
.\.venv\Scripts\python.exe -X utf8 scripts/build_report.py
```

包内raw/input_snapshots提供既有真实输入，raw/project_boundary_wgs84.json使core可离线复用。新高德补采另执行`pipeline.py amap`，从项目根目录`.env.local`、`backend/.env.local`或环境读取`AMAP_WEB_KEY` / `AMAP_KEY`。密钥不在数据包内；需在高德开发平台申请Web服务Key并确认配额/使用许可。遇到拒绝立即停止，不进行绕过。欲重采已有完整快照，请先另存旧快照并使用新输出目录，避免无意覆盖研究版本。

`pipeline.py population`默认采用GHSL R6_C30官方瓦片，本次替代传输失败的WorldPop。原始全国/大瓦片不放进轻量ZIP；重新执行可能下载约337MiB。`fetch_references.py`下载公开原文，`fetch_literature_data.py`下载作者CSV；登录、403或脚本壳页面不等于已取得报告全文。

## 字段和项目接入

矢量均为GeoJSON FeatureCollection，WGS84/EPSG:4326，MapLibre可直接读取。POI有`name/raw_category/category/categories/source/source_id/source_url/collected_at/source_updated_at/original_crs/crs`。充电地点有`operator/public_access/gun_count/charger_unit_count/charge_type/max_gun_power_kw/installed_power_kw/opening_hours/inside_boundary/field_evidence`，未知为JSON null，不能显示成0。

`population.tif`的单位为每像元估计人数，不是密度；2025是预测期。标准MapLibre GeoJSON源不能直接渲染GeoTIFF，人口需预先制栅格瓦片、转成经审查的汇总网格，或由栅格服务提供。不要把人口栅格乘POI数量当作真实订单。

`roads.geojson`保留周边完整way，`road_network.json`保留OSM节点ID与有向边，`roads_within_boundary.geojson`只作行政区显示。道路速度、通行未知和容量假设单独记录；`road_network_scenario.json`仍明确`routingReady=false`，防止误当实时导航。

可选PostGIS接入：

```powershell
py -3.12 scripts/import_postgis.py
# 上行只检查本地文件，不连接数据库。
# 确认目标库后，通过环境设置WEIDU_PG_DSN，再显式执行：
py -3.12 scripts/import_postgis.py --apply
```

导入只写`weidu_planning_baseline`专用schema，保存完整properties JSONB与geometry(4326)，可由Django GeoDjango或其他API读取；本次没有执行数据库写入，也不修改Vue页面、现有业务表或算法。高德与未知授权边界不要未经许可直接公开分发。

## 快速结论

可以作为相对潜在需求、外部文献时段情景和道路覆盖研究的基础；正式公共服务缺口还需核实公共站点、转向/门禁与速度。当前不支持魏都区真实订单、充电峰值负荷或配变容量结论。建筑轮廓仍缺，已取得的172个用地面不能代替建筑。人口裁剪状态：完成。
