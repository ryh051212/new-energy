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

坐标说明：站点来自 GCJ-02；当前边界文件标注 CRS84，但来源尚待核实。
目前没有执行坐标转换，因此空间筛选结果的地理准确性需在确认边界实际坐标系后复核。
`coordSystem` 字段只是标记，不会转换坐标。

运行 `node --test tests/` 检查全部用例（转换、空间筛选、网格计数与 MapView 加载流程）。
