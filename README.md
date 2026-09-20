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
- `raw/`：原始数据。
- `vite.config.js`：开发与构建配置。

整理前的外层依赖与包配置保存在 `.flatten-backup/`，该目录已忽略，不参与运行。
