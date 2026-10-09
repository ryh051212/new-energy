# 魏都区充电设施 WebGIS

## 许昌充电站数据维护

数据库现保留 52 个原有 POI，补充 240 个**虚拟演示站点**。其中 120 个模拟点位于
魏都区现有边界和网格内，其余 120 个分布在城区东、北、南、西的模拟分区。
模拟分区不代表正式行政区划，位置和地址不对应真实设施。名称、数据来源和页面提示均标注虚拟。
首页仍分析魏都区的 172 个站点；“找充电”页从数据库接口读取全部 292 个站点。
数量为 2026-10-05 的初始化结果，后续导入会更新。

52 个原有真实地点已补齐演示桩数、空闲数量、功率、费用、运营商及营业时间等属性，
名称、地址和坐标保持原样，`isSynthetic=false`。`simulatedFields` 逐字段标记补全值，
前端详情会注明“属性含演示补全”；这些属性不代表实测运营数据。
真实地点在 `data/managed/existing-stations-enriched.csv` 中单独维护，导入命令与虚拟站点 CSV 相同。
将演示值替换为实测值后，从 `simulatedFields` JSON 数组移除相应字段；全部替换后填写 `[]`，
并更新 `observedAt`、`dataSource` 和 `datasetId`。同一 ID 导入会更新原记录。

直接修改 `data/managed/xuchang-stations.csv`，保存为 **CSV UTF-8**。
`data/templates/stations-template.csv` 提供同样的空白表头供真实数据使用。
原始 `public/geojson/stations.json` 保持原样；CSV 导入数据库后，由 API 返回正式数据。

| 字段 | 填写规则 |
| --- | --- |
| `id` | 唯一且稳定；相同 ID 更新原记录，不追加。新真实站建议使用自己的业务 ID |
| `name`, `address`, `city`, `district` | 名称、地址、城市及区县；名称和城市必填 |
| `longitude`, `latitude`, `coordSystem` | 经度、纬度；必须明确填写 `WGS84` 或 `GCJ-02`，入库统一转换为 WGS84 |
| `operator`, `siteType`, `openingHours` | 运营商、停车场/社区等场景、营业时间 |
| `chargeType` | 仅 `fast`（快充）/ `regular`（普通充电）；同时包含两种桩时填 `fast`，桩数分别记录 |
| `totalCount`, `fastCount`, `regularCount` | 总桩数、快充桩数、普通充电桩数；已知时两类桩数之和＝总数 |
| `availableCount`, `powerKw` | 采集时空闲桩数、站内单桩最大额定功率 kW；均非实时推测 |
| `electricityPrice`, `servicePrice`, `parkingFee` | 电费和服务费为元/kWh，停车费为元/小时；接口另返回两项充电费用的合计 |
| `status` | `active` 运营中、`maintenance` 维护中、`offline` 离线、`retired` 停用；停用记录保留但不展示或计入网格 |
| `isSynthetic`, `dataSource`, `datasetId` | 虚拟填 `true,synthetic,xuchang-demo-v1`；真实填 `false`、具体来源及新批次名，例如 `field-survey,xuchang-real-2027` |
| `observedAt`, `notes` | 数据采集时刻（例如 `2027-01-01T09:00:00+08:00`）及备注 |
| `simulatedFields` | 演示补全属性的 JSON 数组，例如 `["powerKw","availableCount"]`；实测字段应从数组移除，无补全字段填 `[]` |

数字未知请留空，真实的零填 `0`，不要填“暂无”或虚构数值。虚拟站点不会覆盖原有非虚拟记录。
Excel 中 ID 列按文本处理，保持表头不变。文件里删掉一行不会删除数据库记录；要停用站点，把 `status` 改为 `retired`。
导入是该行的完整替换，空白可选属性会清为未知。CSV 外的站点全部保留。
旧 CSV 的 `slow` 和 `slowCount` 可兼容导入，但导出及页面统一使用 `regular` 和 `regularCount`；不接受第三种充电类型。

在项目根目录执行：

```powershell
# 先校验和试运行，结束后数据库回滚
.\backend\.venv\Scripts\python.exe -m backend.station_catalog data/managed/xuchang-stations.csv
# 备份后正式写入；重复执行按 ID 更新，不会重复增加站点
.\backend\.venv\Scripts\python.exe -m backend.station_catalog data/managed/xuchang-stations.csv --apply
# 导出所有当前记录到新文件（包含原有 POI），方便一起维护
.\backend\.venv\Scripts\python.exe -m backend.station_catalog --export data/managed/stations-current.csv
```

拿到真实数据后，填写模板并保存为 `data/managed/real-stations.csv`，将 `isSynthetic` 设为 `false`，
填写实际来源和新的 `datasetId`。保留同一 ID 可以逐条把模拟记录替换成实测记录；
使用新的真实业务 ID 可以新增真实站点。全部真实数据准备好后，可以一次导入并停用本演示批次：

```powershell
.\backend\.venv\Scripts\python.exe -m backend.station_catalog data/managed/real-stations.csv --retire-demo
.\backend\.venv\Scripts\python.exe -m backend.station_catalog data/managed/real-stations.csv --retire-demo --apply
```

`--retire-demo` 仅接受全部标为真实数据的非空文件，仅停用 `xuchang-demo-v1` 的虚拟记录。
导入及魏都区网格重算在同一事务完成，任何校验或空间归属失败都回滚。
正式同步前自动备份到 `backend/backups/`，导入报告默认写入 `docs/station-import-latest.json`，
数据库 `station_imports` 保存导入批次日志。修改数据文件后必须重新运行导入才会同步数据库。
代码更新后重新启动后端，之后刷新页面即可读取新数据；不需要重新构建地图数据文件。
API 支持 `?include_synthetic=false` 排除虚拟站点，`?scope=weidu` 限定研究范围。

```powershell
# 启动后端（项目根目录）
.\backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload
# 验证重复导入、真实替换、坐标、HTTP 与网格统计；测试修改全部回滚
.\backend\.venv\Scripts\python.exe -m tests.check_station_catalog_live
```

基于 Vue 3、Vite、MapLibre GL 和 Turf 的地图应用。

首页采用顶部导航、地图控制栏、地图和数据分析栏布局。地图支持站点名称搜索、底图切换、图层开关、网格统计与推荐区域定位。`#/stations`、`#/navigation`、`#/recommendations`、`#/forecast`、`#/about`、`#/login` 和 `#/time-analysis` 是已命名的功能占位路由。

地图右上角有两个工具按钮：**测距**（单击加点、双击结束，面板显示总长度，不到 1 千米按米显示）和**全屏**（隐藏左右两侧属性栏，让地图铺满，再点一次恢复）。搜索框下方的**图层**按钮默认收起，点开后才列出当前还没打开的图层，点一下即可打开；面板底部的**更多**按钮会把专题图层也一起列出来。

地图与找充电页均读取本地 FastAPI 站点接口；后端未启动时显示加载错误。原有 52 个 POI 的 `chargeType` 保持 `unknown`，新增虚拟站点提供明确标注的模拟属性；历史时间数据和预测模型尚未接入。

项目已整理为单层目录，直接在本 README 所在目录运行，无需再进入同名子目录。

## 运行

首次下载后执行 `npm install`，然后执行 `npm run dev`。
Windows PowerShell 若禁止运行 npm.ps1，使用 `npm.cmd run dev`。

若前端需要从 PostgreSQL 读取充电站，先在 `backend/` 安装依赖并配置密码：

```powershell
cd backend
python -m pip install -r requirements.txt
Copy-Item .env.example .env.local
# 编辑 .env.local，将 DB_PASSWORD 设为本机 postgres 用户的实际密码
python -m uvicorn main:app --reload
```

后端默认连接本机 `5433` 端口的 `nev_webgis` 数据库。密码也可以写在项目根目录现有的 `.env.local` 中；读取顺序为进程环境变量、`backend/.env.local`、项目根目录 `.env.local`。
这些 `.env.local` 文件已被 Git 忽略，不要将密码提交到仓库。配置后重新启动后端。

`GET /api/stations/recommended?lng=113.8356&lat=34.0268&limit=5` 接收用户的 WGS84 坐标，
先按当前搜索、距离范围和可选条件取得全部合格站点，以 PostGIS
`ST_Distance(geom::geography, 用户位置::geography)` 的米制直线距离及费用进行初筛，
按所选模式取约 10 个候选站（`max(limit*2,10)`，最多 20 个），再逐个请求高德驾车路线。
经济及综合模式从整个筛选范围选候选，避免只在最近站点中比较费用。
高德成功时返回驾车距离和时间；超时、限额、异常响应或未配置
`AMAP_WEB_KEY` 时，保留该站并使用直线距离降级。停用站点不参与推荐。
候选站计算路线后再次按所选模式排序；`distanceSource` 为 `amap_driving` 或 `postgis_straight`，
`isFallback` 标记降级，`straightDistanceMeters` 始终保留。降级结果的 `drivingDistanceMeters`
和 `drivingDurationSeconds` 为 `null`，展示时应标注“直线距离估算”，不推算驾车时间。
每个 Feature 的 `properties.distanceType` 明确区分 `driving`（驾车道路距离）和 `straight`（直线距离），
`distanceLabel` 分别为“驾车距离”和“直线距离（降级估算）”。用户端真实定位后读取推荐结果，
站点详情同步显示距离类型、数值和醒目的“降级估算”标记；驾车结果同时列出直线距离和预计时间。
推荐接口本身不可用时，页面保留本地直线距离并标记降级；重新定位会取消旧请求并清除旧位置的距离。
`metadata.fallbackCount` 为最终返回结果中的降级站点数。前端现有距离缓冲区使用真实定位和直线半径，
无需依赖高德路线接口；`ST_Distance` 计算距离需要已有用户坐标，不能替代定位。
可执行 `.\backend\.venv\Scripts\python.exe -m unittest tests.test_backend -v -b` 验证成功、部分失败及全部降级，
执行 `.\backend\.venv\Scripts\python.exe -m tests.check_recommended_api_live` 只读验证真实 PostGIS 和 HTTP；后者不会请求高德。

进入用户端自动请求真实定位；成功后以附近视野（zoom 14，已选范围时适配范围）居中，米制比例尺随缩放更新，
地图右侧显示推荐面板，最多返回 5 个站点；定位失败提示重试，不使用虚拟坐标。
搜索框旁的“虚拟演示”进入 `#/charging/demo`，直接跳转到[外部演示页面](https://xuchang-ev-sandbox-a119.business-tea-6566.chatgpt.site/)；
使用顶层跳转避免外站的内嵌限制，浏览器后退返回用户端。该入口不附带用户坐标，演示路由不加载本地定位或推荐接口。
点击卡片定位到该站并打开详情。
面板关闭后可通过地图工具栏的星形按钮重新打开。小屏幕选择站点后先收起推荐面板、展示站点详情，点击“去这里”再打开路线面板。
快充、普通充电和仅空闲均为可选条件，默认关闭；改变它们、距离范围、搜索词或排序偏好会重新请求，
取消旧请求并忽略迟到响应。范围仍是直线半径，与道路行驶距离分别展示。

车主端推荐卡片与站点详情统一展示距离、到站时间和每度电价格；已知时补充预计充电时长与费用。
到站时间采用实际驾车路线时间，直线距离仍标为“直线距离”，没有路线或价格时显示“暂无”。
页面不要求逐项确认估算参数。推荐面板可直接修改当前与目标电量，更新结果并保存记录。
快速补能、目的地补能、成本优先共用同一个浏览器设置记录与出行参数；切换按钮仅改变排序，不打开表单。
搜索框下方的“充电设置”进入共用设置页，不再选择推荐模式。车辆信息填齐后默认收起，
目的地、活动时长和步行范围在共用的“目的地与停留”中保存，等待时间与估算参数收在“更多设置”。
地点用途分类、地图选点与手动坐标默认收起。车辆参数初始留空，不代填电量、容量、电耗或车辆充电功率。

| 本次需求 | 排序依据 |
| --- | --- |
| 快速补能（默认） | 到站电量保留值、行驶＋等待＋补到目标的总时间 |
| 目的地补能 | 所选目的地、是否能在停留内补够、单程步行距离 |
| 成本优先 | 充电＋停车＋额外绕行的总成本 |

到站电量按实际驾车距离和填写的百公里电耗计算，低于保留电量的站点排除；
仅有直线距离时最多判断其能耗下界，不能确认可达。维护、离线、明确不兼容的站点也不推荐。
默认目标 80%、保留 10%、平均功率系数 0.8、效率 0.9 是可调估算假设，车辆与桩功率取较小值。
没有实际充电曲线或实时排队数据，排队留空时总时间待确认，输入 0 表示车主假设无需等待。
在店购物时长默认 60 分钟；步行采用直线距离与 80 米/分钟的假设，不能替代实际步行路线。
开始充电后，在店购物和往返步行期间都持续补电，排队另计；停车计费时长为排队＋购物＋往返步行。
补电到目标即停止；未补够也会说明预计离开电量。
停车费用按记录的每小时价格与停留时间估算，未纳入未记录的优惠、封顶规则。
省钱模式使用起点→站点、站点→终点、起点→终点三段实际道路距离计算额外绕行，
道路费用用经站点与直接前往终点的收费差额。去站能耗已计入目标补电量，绕行能耗只计未包含的部分，避免重复计费。
费用或路线缺失则整趟成本待确认，只展示已知费用；缺失值不按零处理。
前后端使用相同估算与排序规则，接口失效时仍按本次条件初筛，不能回退到不满足保留电量的最近站。
切换需求、目的地或车辆参数会取消旧推荐并退出旧路线视图；点击地图空白仍只隐藏站点详情。

推荐接口的新增参数：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `distance` | `distance` 距离优先、`economy` 经济优先、`balanced` 综合推荐 |
| `distance_weight` | `0.5` | 综合距离权重 0～1，费用权重为 `1-distance_weight` |
| `radius_km` | `0` | 直线半径，0 不限，最多 50 km；使用 PostGIS geography `ST_DWithin` |
| `charge_type` | 空字符串 | 不限制，或 `fast` / `regular` |
| `available_only` | `false` | 开启时仅保留 `availableCount > 0` |
| `name` | 空字符串 | 站名或地址包含搜索词 |
| `intent` | 空字符串 | `urgent` / `shopping` / `economy`；车主端默认传 `urgent`，空字符串兼容旧模式 |
| `trip_context` | 空字符串 | JSON：车辆参数、目标、排队假设、停留、WGS84 终点及估算系数；允许部分缺失，非法格式/范围返回 422 |

以下距离／费用权重逻辑仅用于未传 `intent` 的兼容接口；车主端采用上面的出行模式。
兼容经济指标为 `pricePerKwh = electricityPrice + servicePrice`，单位元/kWh，不含停车费。
零费用是有效数据；缺失费用在经济模式及有费用权重的综合模式中排在已知费用之后，不当作免费。
综合采用当前待排序集合的 Min-Max 标准化距离与费用：
`score = 100 * (1 - distance_weight * normalizedDistance - (1-distance_weight) * normalizedPrice)`；
相同数值归一化为 0，缺失费用按最大费用成本处理。同分优先更近的站点。
初筛使用整个范围，路线完成后在候选集合中重排，所以是控制第三方调用量的候选推荐，
并非对范围内所有站点完成算路后的全局最优解。综合分仅用于当前条件下的相对排序。

排序交互参考[高德周边搜索的距离/综合排序](https://lbs.amap.com/api/webservice/guide/api-advanced/search)
与[比亚迪充电站页面的综合/距离/价格优先和可选筛选](https://www.byd.com/cn/charge-station)。
公开页面未提供可直接复用的综合数值权重，距离与费用各 50% 是本项目可调整默认值，非高德官方权重。
GeoJSON 保留全部站点属性及 `simulatedFields`，增加 `rankingMode`、`rankingReason`、`recommendationScore`；
元数据增加 `mode`、`weights`、`eligibleCount`。演示费用和降级距离在卡片中明确标记。
推荐接口本身失效时使用当前站点数据在前端按相同规则降级排序，并提供重试；正常返回空结果时显示空状态。

出行响应的站点属性增加 `tripFit`，包含可达性、时间、购物匹配、费用明细与 `missing` 待确认项；
元数据增加 `intent`、`excludedCount`，明确为估算。候选筛选先遍历完整池，再为至多 10～20 个候选算路，
新模式最多并发 4 个候选，省钱模式额外查询直达与去终点的道路段，仍是候选推荐而非全局最优保证。

执行 `node --test tests/charging.test.mjs tests/chargingView.test.mjs tests/chargingRecommendations.test.mjs tests/tripCharging.test.mjs` 验证用户端交互和渲染，
执行 `.\backend\.venv\Scripts\python.exe -m unittest tests.test_backend tests.test_recommendations tests.test_trip_charging -v -b` 验证候选、费用及出行估算边界。

通过地图、搜索或推荐列表选择充电站时，先定位到站点并展示详情；点击“去这里”后才加载该站点最多 3 条驾车路线。
尚未定位时，“去这里”先获取真实起点；切换站点会取消旧规划意图和待返回请求。
路线面板单独显示目的站及备选路线，展示距离、预计时间、道路收费和主要道路。选择一条后进入路线详情，地图仅显示该路线。
点击“返回”先恢复该站点的备选路线，再次返回推荐站点列表；返回方案复用缓存，返回列表清除路线图形。
同一位置同一站点复用已完成的路线；重新定位清除缓存并重算所选站点，切换站点取消旧请求。

`GET /api/stations/{station_id}/routes?lng=113.8356&lat=34.0268` 读取该站点的 PostGIS 几何及米制直线距离，
按[高德驾车规划 2.0](https://lbs.amap.com/api/webservice/guide/api/newroute) 的策略 `32` 和
`show_fields=cost,polyline` 请求真实方案。结果为 WGS84 `FeatureCollection`，每个 Feature 是 `LineString`，
属性包含 `routeId`、`routeLabel`、`distanceMeters`、`durationSeconds`、`tollsYuan`、`roads` 及原有距离来源标记。
高德的 GCJ-02 路段先反算为 WGS84，前端显示时再随底图转换。跳过无效路线、去除重复方案并最多返回三条，
只有一条有效方案时按实际数量展示。路线面板单独展示道路收费；出行省钱模式计入增量道路收费，兼容单价排序保持原逻辑。
高德不可用时 `features=[]`，元数据保留 `straightDistanceMeters`、`distanceSource=postgis_straight`、
`isFallback=true` 和说明；前端显示“路线不可用 · 降级估算”，提供重试，不把两点连线冒充道路路线。
不存在或停用的站点返回 404。路线接口本身失效时保留本地直线距离估算。

主界面进入时自动请求浏览器真实定位，成功后标记当前位置并居中；数据加载不会覆盖已定位视野。
密度热力图默认关闭；开启时隐藏充电站图标及对应图例，关闭后按充电站开关恢复显示。
定位失败保留研究区视图，提示允许位置权限或通过定位按钮重试。
用户端点击空白处只隐藏站点详情，推荐面板、路线、筛选及站点选中状态保留；小屏收起详情后恢复推荐列表。
分析地图点击非功能区域时收起临时浮层（搜索记录、图层、边界、测距结果、地图弹窗及提示）。
点击窗体、工具或控件内部保持交互，固定侧栏、地图图例和已选筛选值保留；正在测距时地图取点保留测距面板。
用户端返回推荐列表或切换站点时取消旧路线请求并清除路线图形；隐藏详情会取消尚待定位的规划意图。
地图站点底色与推荐卡片选中底色独立于窗体开关，点击空白或关闭详情后保持，选择下一个充电站时才切换。
执行 `.\backend\.venv\Scripts\python.exe -m unittest tests.test_route_planning -v -b` 验证路线解析、真实几何、备选去重和降级契约。

### 数据库导入与核查

更新现有网格分析结果，在项目根目录执行：

```powershell
python -m backend.import_hex_grid
python -m backend.audit_database --output docs/database-audit-20261004.json
```

网格导入按 GeoJSON 的稳定 `id` 更新，重复运行不会追加重复网格；保留文件中不存在的数据库记录。
输入的数量、标准化指数、供需指数和四象限分类会在写入前检查，数据库更新在同一个事务中完成。
`residentialNorm`、`commercialNorm` 两个字段也会入库，并通过 `/api/hex-grid` 返回。
五张表的主几何列 `geom` 已正式切换为 EPSG:4326，`geom_wgs84` 保存转换结果，
`geom_gcj02` 保留原始 GCJ-02 几何（SRID 0）。三张点表的 `lng`、`lat` 与 WGS84 主列一致。
导入脚本仍读取项目中原始 GCJ-02 GeoJSON，会自动转换并同步保存两种坐标，避免二次转换或写回 SRID 0。

2026-10-04 实测：52 个充电站、225 个居民小区 POI、200 个商业 POI、170 个网格及 1 个研究区边界。
其中 1 个居民小区 POI 位于研究区外，已排除在供需统计之外，原记录仍保留。
另 1 个区内小区 `B0FFL4CBQ0` 距离最近的第 167 格约 3.985 米，处于原网格边缘缺口。
重算采用明确的 5 米近邻归属容差，仅对区内但未被网格覆盖的点生效；超过 5 米会报错并回滚。
共边点只归入一个网格（ID 最小者），区内小区统计总数为 224。
五张业务表的几何均有效，均有 GiST 空间索引，详见 [迁移后核查结果](docs/database-audit-after-4326.json)。
本次更新前的完整 PostgreSQL 备份保存在 `backend/backups/`，该目录已被 Git 忽略。
本次已执行用户指定的五步：批量转换、坐标验证、空间关系验证、正式切换 EPSG:4326、重新计算供需指标。
分享链接未能读取，执行依据为用户提供的五步流程与现有项目算法，完整证据见 [正式迁移报告](docs/database-migration-4326.json)。
回转误差验证检查的是转换算法的一致性，并不代表经过实测控制点校准的绝对定位精度。

迁移执行与检查命令：

```powershell
# 默认试运行后回滚；已迁移的数据库会识别记录并跳过，避免二次偏移。
python -m backend.spatial_migration --output docs/database-migration-check.json
python -m backend.audit_database --output docs/database-audit-after-4326.json
# 手工查看 SQL 检查项：在 pgAdmin 执行 backend/verify_database.sql。
```

供需重算基于转换后的 PostGIS 几何：站点数及两类 POI 数量做 Min-Max 标准化，
需求为小区和商业标准化值各占 0.5，供给为站点数标准化值，错配为需求减供给；
供需指数保留三位小数，四象限以各自全区平均值划分。
坐标实际逐顶点转换完成后才标记 4326；[ST_SetSRID 文档](https://postgis.net/docs/ST_SetSRID.html)说明仅设置 SRID 不会转换坐标。

`/api/stations`、`/api/hex-grid` 返回 WGS84。地图页的站点、边界、网格和需求 POI 统一读取数据库接口，使用相同坐标系；站点 CSV 导入支持显式指定 WGS84 或 GCJ-02。分析地图和用户端默认使用高德标准底图，前端仅在显示时将业务几何、搜索定位和真实定位标记转换为 GCJ-02；空间统计、距离计算及数据库仍使用 WGS84。切换到卫星或地形底图时，显示坐标同步还原。

执行 `npm run build` 构建至 `dist/`，执行 `npm run preview` 预览构建结果。

## 目录

- `src/`：页面、组件和样式。
- `public/geojson/`：地图使用的边界、站点和六边形网格数据。
- `data/raw/`：原始数据。
- `data/processed/`：转换及筛选结果。
- `scripts/`：离线数据管线。
- `docs/项目逻辑梳理.md`：数据流、运行时逻辑与已知问题的完整说明。
- `vite.config.js`：开发与构建配置。

整理前的外层依赖与包配置保存在 `.flatten-backup/`，该目录已忽略，不参与运行。

## 更新数据

当前数据库站点维护使用本文开头的 CSV 导入流程。下面三条命令仅处理历史本地 POI 与 GeoJSON，不会同步本次新增属性或数据库：

1. `node scripts/convertStations.mjs`：清洗本地原始 POI。
2. `node scripts/filterWeiduStations.mjs`：按边界筛选，并同时更新处理结果与网页读取的
   `public/geojson/stations.json`。
3. `node scripts/buildHexGrid.mjs`：依据上一步的站点重新生成并统计
   `public/geojson/hex-grid.json`。

只有需要重新请求高德数据时才执行 `node scripts/fetchAmapStations.mjs`。

地图与数量统计均采用空间范围口径，不再要求 `district` 同时等于“魏都区”。
充电类型统一为快充 `fast` 与普通充电 `regular`，分别使用绿色实心闪电和蓝色圆润插头。
原有地点缺失的类型及运营属性已演示补全；字段来源通过 `simulatedFields` 保留，实测数据可按 ID 替换。

## 界面结构

界面按“顶部导航 + 左侧地图控制 + 中间地图 + 右侧数据分析 + 底部状态栏”组织，地图浮层与侧栏卡片使用同一套设计令牌（颜色、圆角、阴影、间距），这些令牌集中定义在 `src/style.css` 顶部的 `:root` 中，改一处即可全局生效。

地图浮层包括：搜索框、底图切换、右上工具组（图层切换 / 测距 / 全屏）、快捷图层面板、测距面板、图例、缩放定位按钮和网格详情卡。图例会跟随当前路由切换，只列出地图上真正在显示的图层配色：`/monitoring/supply`、`/monitoring/demand`、`/monitoring/mismatch`、`/planning/problems` 分别显示供给分级、需求分级、供需错配和四象限配色，其余路由显示站点密度热力图。

左侧“地图设置 / 时间选择 / 充电类型 / 专题图层”四个面板都可以点击标题折叠；右侧保留“数据一览、充电设施分布、推荐区域、AI预测”四张卡片。`/charging` 找充电页与首页共用同一套令牌，只是把主色换成表示“可用”的绿色。

新增一个浮层或卡片时，建议直接复用 `style.css` 中已有的 `.side-card`、`.right-card`、`.map-tools`、`.metric` 等类与变量，不要另写一套颜色和圆角。

## 已知未接入的组件

`src/components/map/LayerControl.vue`、`src/components/panels/AnalysisPanel.vue`、`src/components/charts/HexDistributionChart.vue` 三个组件当前没有被任何页面引用（`MapView` 直接实现了等价的图层开关与柱状分布图）。`docs/项目逻辑梳理.md` 和 `package.json` 里的 `echarts` 依赖仍按它们存在来描述。清理或复用这三者需要单独决定，改动前先确认没有其他入口引用。

坐标说明：历史原始 GeoJSON 使用 GCJ-02，数据库正式几何已转换为 WGS84 / EPSG:4326。CSV 导入会依据 `coordSystem` 实际转换坐标；虚拟站点位置仅供演示，不代表实测设施位置。

运行 `node --test tests/*.mjs` 检查全部用例（转换、空间筛选、网格计数与 MapView 加载流程）。PowerShell 不会自动展开通配符，也可以逐个文件执行，例如 `node --test tests/mapView.test.mjs`。
