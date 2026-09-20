# 魏都区充电设施 WebGIS

基于 Vue 3、Vite、MapLibre GL 和 Turf 的地图应用。

项目已整理为单层目录，直接在本 README 所在目录运行，无需再进入同名子目录。

## 运行

首次下载后执行 `npm install`，然后执行 `npm run dev`。
Windows PowerShell 若禁止运行 npm.ps1，使用 `npm.cmd run dev`。

执行 `npm run build` 构建至 `dist/`，执行 `npm run preview` 预览构建结果。

## 目录

- `src/`：页面、组件和样式。
- `public/geojson/`：地图使用的边界和站点数据。
- `data/raw/`：原始数据。
- `data/processed/`：转换及筛选结果。
- `vite.config.js`：开发与构建配置。

整理前的外层依赖与包配置保存在 `.flatten-backup/`，该目录已忽略，不参与运行。

## 更新站点数据

在项目根目录依次执行 `node scripts/convertStations.mjs` 和
`node scripts/filterWeiduStations.mjs`。前者清洗本地原始 POI，后者按边界筛选，
并同时更新处理结果与网页读取的 `public/geojson/stations.json`。
只有需要重新请求高德数据时才执行 `node scripts/fetchAmapStations.mjs`。

地图与数量统计均采用空间范围口径，不再要求 `district` 同时等于“魏都区”。
原始数据未提供可靠的快慢充字段时，`chargeType` 为 `unknown`，显示灰色。

坐标说明：站点来自 GCJ-02；当前边界文件标注 CRS84，但来源尚待核实。
目前没有执行坐标转换，因此空间筛选结果的地理准确性需在确认边界实际坐标系后复核。
`coordSystem` 字段只是标记，不会转换坐标。

运行 `node --test tests/stations.test.mjs` 检查转换与空间筛选逻辑。
