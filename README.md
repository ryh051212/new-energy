# 魏都区充电设施 WebGIS

基于 Vue 3、Vite、MapLibre GL 和 Turf 的地图应用。

首页采用顶部导航、地图控制栏、地图和数据分析栏布局。地图支持站点名称搜索、底图切换、图层开关、网格统计与推荐区域定位。`#/stations`、`#/navigation`、`#/recommendations`、`#/forecast`、`#/about`、`#/login` 和 `#/time-analysis` 是已命名的功能占位路由。

地图右上角有两个工具按钮：**测距**（单击加点、双击结束，面板显示总长度，不到 1 千米按米显示）和**全屏**（隐藏左右两侧属性栏，让地图铺满，再点一次恢复）。搜索框下方的**图层**按钮默认收起，点开后才列出当前还没打开的图层，点一下即可打开；面板底部的**更多**按钮会把专题图层也一起列出来。

前端优先读取本地 FastAPI 站点接口；后端未启动时使用 `public/geojson/stations.json`。当前 52 个站点的 `chargeType` 均为 `unknown`，因此界面不会推测快充/慢充数量；历史时间数据和预测模型尚未接入。

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

`/api/stations`、`/api/hex-grid` 默认返回 WGS84；高德底图可使用 `?coord_system=GCJ-02` 获取原始几何。
现有地图页已显式请求 GCJ-02 站点，与本地 GCJ-02 边界及网格保持一致。

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

在项目根目录依次执行以下三条命令，顺序不能颠倒：

1. `node scripts/convertStations.mjs`：清洗本地原始 POI。
2. `node scripts/filterWeiduStations.mjs`：按边界筛选，并同时更新处理结果与网页读取的
   `public/geojson/stations.json`。
3. `node scripts/buildHexGrid.mjs`：依据上一步的站点重新生成并统计
   `public/geojson/hex-grid.json`。

只有需要重新请求高德数据时才执行 `node scripts/fetchAmapStations.mjs`。

地图与数量统计均采用空间范围口径，不再要求 `district` 同时等于“魏都区”。
原始数据未提供可靠的快慢充字段时，`chargeType` 为 `unknown`，显示灰色。

## 界面结构

界面按“顶部导航 + 左侧地图控制 + 中间地图 + 右侧数据分析 + 底部状态栏”组织，地图浮层与侧栏卡片使用同一套设计令牌（颜色、圆角、阴影、间距），这些令牌集中定义在 `src/style.css` 顶部的 `:root` 中，改一处即可全局生效。

地图浮层包括：搜索框、底图切换、右上工具组（图层切换 / 测距 / 全屏）、快捷图层面板、测距面板、图例、缩放定位按钮和网格详情卡。图例会跟随当前路由切换，只列出地图上真正在显示的图层配色：`/monitoring/supply`、`/monitoring/demand`、`/monitoring/mismatch`、`/planning/problems` 分别显示供给分级、需求分级、供需错配和四象限配色，其余路由显示站点密度热力图。

左侧“地图设置 / 时间选择 / 充电类型 / 专题图层”四个面板都可以点击标题折叠；右侧保留“数据一览、充电设施分布、推荐区域、AI预测”四张卡片。`/charging` 找充电页与首页共用同一套令牌，只是把主色换成表示“可用”的绿色。

新增一个浮层或卡片时，建议直接复用 `style.css` 中已有的 `.side-card`、`.right-card`、`.map-tools`、`.metric` 等类与变量，不要另写一套颜色和圆角。

## 已知未接入的组件

`src/components/map/LayerControl.vue`、`src/components/panels/AnalysisPanel.vue`、`src/components/charts/HexDistributionChart.vue` 三个组件当前没有被任何页面引用（`MapView` 直接实现了等价的图层开关与柱状分布图）。`docs/项目逻辑梳理.md` 和 `package.json` 里的 `echarts` 依赖仍按它们存在来描述。清理或复用这三者需要单独决定，改动前先确认没有其他入口引用。

坐标说明：站点来自 GCJ-02；当前边界文件标注 CRS84，但来源尚待核实。
目前没有执行坐标转换，因此空间筛选结果的地理准确性需在确认边界实际坐标系后复核。
`coordSystem` 字段只是标记，不会转换坐标。

运行 `node --test tests/*.mjs` 检查全部用例（转换、空间筛选、网格计数与 MapView 加载流程）。PowerShell 不会自动展开通配符，也可以逐个文件执行，例如 `node --test tests/mapView.test.mjs`。
