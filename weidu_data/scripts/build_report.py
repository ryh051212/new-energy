"""Regenerate human-readable deliverables and source inventory from actual QA."""
import csv,hashlib,json,re,zipfile
from datetime import datetime,timezone
from pathlib import Path
from pipeline import OUT,read,save,csv_save,now

q=read(OUT/'reports/quality_report.json');pop=read(OUT/'population/population_metadata.json') if (OUT/'population/population_metadata.json').exists() else None
ref={r['id']:r for r in read(OUT/'metadata/reference_sources.json')}
sources=[]
def add(name,source,year,fmt,status,completeness,url,local,license,method,collection='2026-10-27'):
 sources.append(dict(data_name=name,source=source,reference_year=year,format=fmt,acquisition_status=status,completeness=completeness,download_url=url,local_file=local,license=license,access_method=method,collected_at=collection))
add('现有研究区边界','项目 PostGIS / 原始 AreaCity-Polygon','边界版本不明','GeoJSON','已实际获取','几何有效；不是新取得的权威行政勘界成果，面积约90.1093km²','http://127.0.0.1:8000/api/boundary','boundary/weidu_boundary.geojson','原始边界再分发权未核实','优先复用项目WGS84边界并校验')
add('现行法定行政边界','地方自然资源或民政部门','待确认','矢量','需要申请','未取得公开可直接下载的现行官方GeoJSON；现有边界版本与统计口径须核对','https://www.weidu.gov.cn/','', '依提供部门授权','申请现行边界、版本日期、坐标系和使用授权')
ghsl_url=pop['source_url'] if pop else 'https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php'
add('居民人口栅格','EC JRC GHS-POP R2023A','2025预测，R2023A版本','GeoTIFF','已实际获取' if pop else '可下载但尚未获取','每像元估计人数；3角秒；不是2025人口普查实测',ghsl_url,'population/population.tif' if pop else '', 'European Commission reuse with acknowledgement','官方地理瓦片下载、中心点掩膜裁剪、不重采样')
add('WorldPop候选人口栅格','WorldPop R2025A v1','2025模型','GeoTIFF','可下载但尚未获取','已取得官方STAC元数据；全国文件下载中断，.part不得用于分析','https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2025/CHN/v1/100m/constrained/chn_pop_2025_CN_100m_R2025A_v1.tif','','CC-BY-4.0','官方文件可访问，但本次大文件传输未完成')
add('五类城市功能POI','高德官方API原始快照','2026采集快照；对象更新时间未知','GeoJSON','已实际获取',f"{q['pois']['count']}条；五类齐全但受API结果窗口限制，不等于完整名录",'https://lbs.amap.com/api/webservice/guide/api-advanced/search','pois/pois.geojson','高德开发者协议，学术本地使用，再分发权待核实','API合法分页、按来源ID去重、GCJ-02迭代反算、研究区裁剪','2026-10-16 / 2026-10-27')
add('周边道路与节点拓扑','OpenStreetMap Overpass','2026-10-27快照','GeoJSON + JSON','已实际获取',f"{q['roads']['count']}条way；10km周边；保留2条转向限制但尚未应用",'https://overpass-api.de/api/interpreter','roads/roads.geojson; roads/road_network.json','ODbL-1.0','共享OSM节点保留，不把几何交叉自动接通')
add('充电设施地点','高德原始API + 已有逐字段公开证据','2026查询；历史原始记录日期部分未知','GeoJSON','已实际获取',f"247条地点（区内201、周边46）；开放性、枪数和功率大量缺失，不等于已核实公共站名录",'https://lbs.amap.com/api/webservice/guide/api-advanced/search','charging/charging_stations.geojson','高德条款及证据各自版权','剔除240条模拟站点CSV；仅保留来源明确地点与有证据字段')
add('用地与停车设施','OSM既有快照 + 高德停车POI','OSM基准2026-07-15；高德2026-10-16','GeoJSON','已实际获取','172个用地面+225条停车POI；多数容量未知；不是397个独立场地','https://overpass-api.de/api/interpreter','buildings/buildings_parking.geojson','混合ODbL与高德条款','公开真实快照复用、裁剪；保留点面差异')
add('建筑轮廓及用途/规模','OSM建筑查询','当前','GeoJSON','可下载但尚未获取','多次HTTP/TLS/代理失败，未取得真实建筑轮廓；未造假补面','https://overpass-api.de/api/interpreter','','ODbL-1.0','保存失败请求；可从OSM地区提取文件继续处理')
add('河南私人汽车统计','河南省统计局/国家统计局河南调查总队，河南日报载','2025','CSV + 原网页','已实际获取','省级民用汽车2310.69万辆、私人汽车2146.15万辆；不能替代魏都区',ref['henan_2025_statistics']['url'],'metadata/statistical_context.csv','标明统计来源','原文数值核对并记录范围与单位')
add('许昌充电建设公开信息','许昌发改委/住建局','2024及2023–2035规划','CSV + HTML/PDF','已实际获取','年度新增完成量与规划目标分开；不作为魏都区现状总量',ref['xuchang_2024_reply']['url'],'metadata/statistical_context.csv','政府信息，标明来源','下载原文；区分城市与城区、增量与存量、现状与规划')
add('魏都区私人新能源车保有量','尚无核实的区级公开统计','待核实','无','未找到','本次未找到可核实的私人新能源车区级数值，不以省/市/产量/销量冒充','','','需交通管理部门授权','建议向公安交管/统计/充电平台申请区级汇总')
add('私人车工作日/周末时段曲线','Zhan et al.作者Zenodo数据','2020-11至2021-10，论文2025','CSV','已实际获取','192条15分钟状态占比；七个其他城市；不区分公共与私人充电','https://doi.org/10.5281/zenodo.13852045','parameters/time_profiles.csv','数据CC-BY-4.0；论文CC-BY-NC-ND-4.0','作者公开CSV下载并核对MD5；保留车型和日型')
add('功能区活动及公共依赖情景','本项目显式假设','非观测','JSON + CSV','已实际获取','240条活动假设；各绝对需求校准量保持null，不用于冒充观测','','parameters/scenario_params.json; parameters/time_activity_assumptions.csv','用户项目情景参数','从真实数据目录中独立放在parameters，并逐行标记author_scenario_assumption')
csv_save(OUT/'metadata/data_sources.csv',sources)

stats=[]
def stat(id,region,period,indicator,value,unit,basis,source_id,note):stats.append(dict(id=id,geography=region,reference_period=period,indicator=indicator,value=value,unit=unit,basis=basis,source_url=ref[source_id]['url'],note=note))
html=(OUT/'raw/references/henan_2025_statistics.html').read_text(encoding='utf-8',errors='replace')
assert '2310.69' in html and '2146.15' in html
stat('hn_cars','河南省','2025年末','民用汽车',2310.69,'万辆','official_observed_statistic','henan_2025_statistics','包含非私人车辆；不是新能源汽车数')
stat('hn_private','河南省','2025年末','私人汽车',2146.15,'万辆','official_observed_statistic','henan_2025_statistics','全省全部能源私人汽车，不能直接分配成魏都区私人新能源车')
stat('xc_target_stations','许昌市中心城区','2023–2025规划','拟建设充电站/桩群',126,'座','planning_target','xuchang_2024_reply','规划目标，不是2025年底建成清单')
stat('xc_target_chargers','许昌市中心城区','2023–2025规划','拟建设充电桩',5546,'个','planning_target','xuchang_2024_reply','规划桩数，不是枪数或当前可用数')
stat('xc_2024_new_stations','许昌市','2024年度截至8月上旬','该年度已建设完成充电站',87,'个','government_reported_increment','xuchang_2024_construction','年度建设任务完成量，不是全市现状存量')
stat('xc_2024_new_chargers','许昌市','2024年度截至8月上旬','该年度已建设完成充电桩',687,'个','government_reported_increment','xuchang_2024_construction','不要与1181个枪混用')
stat('xc_2024_new_guns','许昌市','2024年度截至8月上旬','该年度已建设完成充电枪',1181,'个','government_reported_increment','xuchang_2024_construction','不要作为魏都区枪总数')
stat('cn_public_2025','全国','2025年12月底','公共充电设施（枪）',471.7,'万个','official_observed_statistic','nea_2025_chargers','全国参考，不是私家车公共充电依赖率')
stat('cn_private_2025','全国','2025年12月底','私人充电设施（枪）',1537.5,'万个','official_observed_statistic','nea_2025_chargers','桩车配比不等于有家充车辆比例')
csv_save(OUT/'metadata/statistical_context.csv',stats)

pop_text=(f"已输出 **{pop['dimensions'][0]} × {pop['dimensions'][1]}** 像元 GeoTIFF，EPSG:4326；研究区中心约 **{pop['resolution_m_at_study_centre'][0]:.1f} × {pop['resolution_m_at_study_centre'][1]:.1f} 米**。有效像元 {pop['valid_cells']} 个，区内 NoData {pop['nodata_inside']} 个，像元估计人数合计约 **{pop['estimated_population_sum']:,.0f}**。这是 GHSL 的2025预测人口，不是人口普查或手机实时人数，且边界像元没有面积比例分摊。" if pop else '人口瓦片尚在下载；此时不发布population.tif，不填充随机数据。')
missing=q['charging']['missing_fields'];net=q['network'];cats=q['pois']['categories']
quality=f'''# 魏都区充电设施规划基础数据：采集与质量报告

生成时间：{now()}。执行日期按北京时间为2026-10-27。原始采集日期与对象更新时间分别记录，不用文件修改日期代替采集日期。

## 第一阶段：核心数据获取与验证

- 边界：复用项目 PostGIS 的 WGS84 研究边界，1个有效面，面积约90.1093平方公里。原始文件标记 AreaCity-Polygon，项目曾按GCJ-02转换；本次没有重新证明原始坐标基准或边界年代。政府简介面积89.3729平方公里，与项目相差约0.82%。因此保留原研究口径，不称其为最新法定勘界，不强行将栅格人口缩放到简介人口数。[政府简介]({ref['weidu_government']['url']})
- 人口：{pop_text} [官方产品说明]({ref['ghsl_metadata']['url']})
- POI：{q['pois']['count']}条，居住{cats['residential']}、工作{cats['work']}、商业{cats['commercial']}、休闲{cats['leisure']}、公共服务{cats['public_service']}。高德原始类别、统一类别、来源ID及日期保留；商业类包含单独标明的餐饮子类，公共服务含学校和停车。POI不是人口、到访或充电次数。
- 道路：本次成功获取{q['roads']['count']}条OSM way，研究区外扩约10km；保留节点、道路类型、方向、通行标签、桥隧和转向限制。完整way可能延伸到查询矩形外，条数不是行政区内道路数量。`roads_within_boundary.geojson`只用于显示；路由应使用完整网络。
- 充电地点：247条真实地图地点，区内201条、周边46条；按来源ID去重。已排除项目内240条模拟站点CSV及演示补全字段。无法由名称推断运营商，也不把地图收录或数据库active标志当作对公众开放的证据。

人口模型的绝对总量存在明显的合理性待核问题：裁剪结果约89.25万人，高于政府简介不同段落约50万/52.5万的人口表述。简介本身的年份/口径混杂，现有边界年代也未确定，因此本次保留来源原值、记录差异，不把模型数称为魏都区官方常住人口，不据此直接计算绝对充电次数。充电地点中另有8条名称带重卡、公交、出租或换电等关键词，已逐条加scope_review_flags；这些只是名称线索，兼容私人乘用车和公共开放性须核实，不能全部作为默认供给。

高德结果存在明确缺口：周边充电查询报告594条，实际下载190个不同ID；政务交通查询报告600条，下载225个ID，之后API返回空页。原始查询结果和逐页日志已保存。本次停止在官方结果窗口，不采用分区查询规避额度；“翻到空页”不代表现实世界完整。既有POI类别同样存在结果窗口和平台收录偏差。

## 第二阶段：空间清洗和质量检查

- 所有正式矢量以WGS84经纬度导出。高德记录由明确GCJ-02输入迭代反算，保留原坐标系字段；OSM原生WGS84不重复转换。迭代往返可逆性检查不是地面控制点精度认证。
- 当前所有已导出矢量：空几何0、无效几何0、来源ID重复0；五类POI区外点0。充电文件的46个区外点是10km周边服务背景，不能作为裁剪错误删除。
- POI在30m内有{q['pois']['nearby_record_pairs_30m']}对邻近记录，充电地点有{q['charging']['nearby_record_pairs_30m']}对；逐对清单见metadata。不同ID、相近位置不一定是同一设施，因此只标疑似共址，不自动合并不同运营商。已完成来源ID去重，跨来源实体去重仍需人工复核。
- 站点属性缺失：运营商{missing['operator']}/247、公众开放状态{missing['public_access']}/247、枪数{missing['gun_count']}/247、全站装机功率{missing['installed_power_kw']}/247、对象更新日期{missing['source_updated_at']}/247。仅2条站点有历史公开核对的桩台数、快充、最高单枪功率和开放时间；证据保留在field_evidence，不能把最高单枪功率乘桩台数作为全站容量。
- 路网包含{net['node_count_input']}个节点、{net['directed_edges_input']}条有向分段边；当前机动车通行情景保留{net['motor_scenario_edges']}条边，弱连通分量{net['weak_components']}个，最大分量节点占{net['largest_weak_component_percent']:.2f}%。强连通分量{net['strong_components']}个，缺失端点0、非正长度边0。没有把平面相交道路自动连通，也未删掉小分量伪造连通。
- {net['turn_restriction_records']}条转向限制和{net['barrier_nodes']}个门禁/障碍节点已保留，尚未进入路径约束。全部{net['access_unspecified_edges_assumed_passable']}条机动车情景边的通行属性未明确，因此“允许通行”是乐观情景假设，不是逐路核实。247个地点中有{net['stations_over_300m_from_node']}个距离最近网络节点超过300m；即使距离较近，也不保证存在可通行车行入口。
- 速度表是按道路等级指定的自主情景参数，不是实时速度或法定限速。原始maxspeed仍保留；后续路由要执行限速上限、时段拥堵敏感性及转向/门禁约束。10km缓冲在80km/h下不足以保证穷尽10分钟路径，边缘地区应扩展到约15km或做缓冲敏感性检验。

## 第三阶段：辅助空间数据与官方统计

建筑/停车目录目前包含172个OSM用地面和225条高德停车POI，共397条记录；**本次建筑轮廓新采集失败，建筑覆盖率未知**，没有用地面冒充建筑物。停车点可能对应同一停车场的多条记录，不能把397视为独立场地数。容量缺失保留null。OSM既有用地快照基准2026-07-15，停车POI采于2026-10-16；本次HTTP、TLS和代理失败请求分别保存，后续可改用地区OSM提取文件。

已下载河南2025统计公报、许昌发改委答复、许昌住建公开PDF及国家能源局资料。`metadata/statistical_context.csv`明确地域、参考时段、单位及统计/增量/规划身份。河南2025年末私人汽车2146.15万辆是全省全部能源私人汽车；许昌2024年建设任务的87站/687桩/1181枪是年度完成量；126站/5546桩是2023–2025规划目标。以上均不能作为魏都区新能源私人车或现有公共枪总量。[河南公报]({ref['henan_2025_statistics']['url']}) [许昌答复]({ref['xuchang_2024_reply']['url']})

本次没有找到可核实的魏都区私人新能源车保有量、分社区家充条件及小时公共充电订单。没有把城市汽车产量、销量、规划值或省级比率改写成区级实际值。

## 第四阶段：文献观测和情景参数

论文作者Zenodo公开了支撑图表CSV，许可CC-BY-4.0。本次下载5个小型CSV并核对档案MD5。来源是2020年11月至2021年10月其他七座城市的车辆汇总；它们不是许昌数据，也不是个人轨迹。[作者数据]({ref['zhan_2025_data']['url']}) [论文及2026更正入口]({ref['zhan_2025']['url']})

- `parameters/time_profiles.csv`：192条外部实测汇总，工作日与周末/节假日各96个15分钟区间，仅保留私人车。原始第96索引为24:00绘图端点，不重复算作一天的第97个区间。行驶、充电和停放三状态比例相加为1。这是时点状态比例，**不是开始充电概率、到达率或公共订单数**；充电包括私人和公共来源。
- 作者数据的私人车日充电次数中位数为0.4667次，不能直接当成0.4667的公共充电概率。原文数值与数据来自外地及较早时期，只作外部先验。
- 行业2022摘要的平均单次25.6kWh、49.3分钟包含混合公共平台用户，可能含营运车辆，未设为魏都区私人车默认值。IEA近75%的私人地点充电是场次占比，不能推成75%魏都区家庭可装家充。[能源局摘要]({ref['nea_2022_behavior']['url']}) [IEA]({ref['iea_2026']['url']})
- `time_activity_assumptions.csv`：240条明确标为author_scenario_assumption的功能区小时活动权重；不是从订单或论文图形虚构提取的观测。`scenario_params.json`的区级车辆数、家充可用率、公共依赖率、日公共充电概率与电量均保持null；默认不启用绝对需求推算。

## 第五阶段：文件、复现和适用性

入口见README；机器质量报告见quality_report.json，来源清单见metadata/data_sources.csv，原始文件和请求日志见raw/及metadata/。包内提供独立GIS辅助函数和真实输入快照，不需修改现有应用数据库。可选PostGIS导入默认dry-run，只有显式--apply才写专用schema。未开发选址优化或输出未经校准的负荷图。

| 研究目标 | 当前判断 | 条件与限制 |
|---|---|---|
| 潜在公共充电需求空间分布 | 可做相对潜力/情景图 | 人口、功能POI可作空间基础；补齐家充条件和区级私人新能源车后才可讨论绝对量；需控制POI采集偏差与人口重复分配 |
| 工作日/周末分时估计 | 可做外部文献迁移情景 | 有真实外部15分钟状态曲线；尚无本地功能区到访或公共订单的小时规律 |
| 10分钟驾车可达性 | 具备路网准备条件，尚不是正式可用路径引擎 | 需处理2条转向限制、门禁、未明确通行、入口、速度及边界敏感性 |
| 公共服务薄弱区域 | 可做假设下的相对薄弱区初筛 | 站点开放性大多未知，需区分已记录地点与已核实公共供给；不能宣布真实需求未满足 |
| 真实充电负荷或设施容量 | 不支持 | 枪数、共享输出、配变容量、实时可用状态、排队/订单及本地车辆规模缺失 |

最值得补充的三项数据：①区级/分社区私人新能源车数量与家充可用性汇总；②运营商公共站点台账（对外开放、逐枪功率、共享功率、入口、开放时间及更新日期）；③匿名化小时公共订单与停车/到访时长，并同步取得道路分时速度或交通调查用于校验。涉及轨迹只申请必要汇总，不以其他城市的曲线代替本地实测。

许可：OSM需保留署名并遵守ODbL；GHSL按欧委会要求署名；作者数据与论文许可证不同；高德API调用授权不等于批量再分发授权；原始边界许可未确认。本次文件为本地学术研究整理，不自动发布或上传第三方。
'''
(OUT/'reports/数据采集与质量报告.md').write_text(quality,encoding='utf-8')

table='\n'.join('| '+' | '.join(str(r[k]).replace('|','/') for k in ['data_name','source','reference_year','format','acquisition_status','completeness','local_file'])+' |' for r in sources)
readme=f'''# 魏都区新能源汽车充电规划基础数据

本次执行日期：2026-10-27（北京时间）。核心文件来自真实空间记录与公开人口模型；自主情景只放在parameters目录。没有把模拟CSV、缺失枪数或假定功率写成实测值。

完整说明：[数据采集与质量报告](reports/数据采集与质量报告.md) · [机器质量检查](reports/quality_report.json) · [来源清单](metadata/data_sources.csv)。

## 文件清单与获取状态

| 数据 | 来源 | 年份/时点 | 格式 | 获取状态 | 完整性 | 本地文件 |
|---|---|---|---|---|---|---|
{table}

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
.\\.venv\\Scripts\\python.exe -m pip install -r scripts/requirements.txt
.\\.venv\\Scripts\\python.exe -X utf8 scripts/pipeline.py core
.\\.venv\\Scripts\\python.exe -X utf8 scripts/pipeline.py osm
.\\.venv\\Scripts\\python.exe -X utf8 scripts/pipeline.py population
.\\.venv\\Scripts\\python.exe -X utf8 scripts/build_parameters.py
.\\.venv\\Scripts\\python.exe -X utf8 scripts/pipeline.py qa
.\\.venv\\Scripts\\python.exe -X utf8 scripts/build_report.py
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

可以作为相对潜在需求、外部文献时段情景和道路覆盖研究的基础；正式公共服务缺口还需核实公共站点、转向/门禁与速度。当前不支持魏都区真实订单、充电峰值负荷或配变容量结论。建筑轮廓仍缺，已取得的172个用地面不能代替建筑。人口裁剪状态：{'完成' if pop else '下载进行中'}。
'''
(OUT/'README.md').write_text(readme,encoding='utf-8')

# No credentials and no huge or incomplete national/tile downloads in the delivery archive.
manifest=[]
for p in sorted(OUT.rglob('*')):
 if not p.is_file() or '__pycache__' in p.parts or p.suffix in ('.part','.zip','.pyc') or p.name=='file_manifest.csv':continue
 if p.parent==OUT/'raw' and p.name.startswith(('GHS_POP_','chn_pop_')):continue
 if p.stat().st_size>50*1024*1024:continue
 manifest.append({'file':p.relative_to(OUT).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
csv_save(OUT/'metadata/file_manifest.csv',manifest)
archive=OUT.parent/'weidu_data_delivery.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for entry in manifest:z.write(OUT/entry['file'],'weidu_data/'+entry['file'])
 z.write(OUT/'metadata/file_manifest.csv','weidu_data/metadata/file_manifest.csv')
print(json.dumps({'report':'reports/数据采集与质量报告.md','source_rows':len(sources),'manifest_files':len(manifest),'archive':str(archive),'archive_bytes':archive.stat().st_size,'population_published':bool(pop)},ensure_ascii=False))
