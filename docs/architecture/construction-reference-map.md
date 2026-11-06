# 魏都区地价分区与变电站参考图

入口为 `construction-reference.html`，也可在项目「图层管理 → 分析参考」点击「魏都区地价分区与变电站参考图」。该页使用可追溯的本地研究快照，无需登录或启动业务 API；不向数据库写入数据。

## 数据口径

- 黑线：2026-11-01 从项目 `weidu_boundary` 表只读导出的 WGS84 行政边界。不能直接用 `public/geojson/weidu.json` 替代，该原始文件使用 GCJ-02。
- 红线：许昌市政府 2024-01-30 发布的《中心城区城镇土地级别与基准地价更新调整项目成果（征求意见稿）》内商业用地级别图。不是最终核定范围，也不是租赁市场价格分区。
- 分区参考值：2024-04-11 正式公布的商业用地出让基准地价及国有土地收益租金标准。单位分别为元/平方米和元/平方米·年。草案分区与正式级别的最终对应关系尚未核实，页面明确提示；不会据此认定场地用途或计算真实收益。
- 蓝点：现有 OSM 数据中、魏都区边界内的7条变电站记录。按纬度排序编为 S01–S07，编号仅用于浏览，不代替尚未核实的站名。
- 棕色方点：3条变压器记录，默认关闭；可能与变电站属于同一场所。不填写额定容量、实时负荷和可接入余量。

## 配准与精度

原始分区图位于 `public/reference/xuchang-commercial-grades-draft-2024.jpg`，保持官方附件中的原样。原图未明示投影基准，按 CGCS2000 三度带38（EPSG:4526）解释图廓坐标：横向像素88、1286对应38474000、38498000；纵向像素183、1480对应3784000、3758000。该投影解释仍是配准假设。

根据原图填色识别7个商业用地级别，局部多数票与小区域筛选去除文字、道路干扰；随后转换至 WGS84，并与项目行政区边界相交。没有按距离市中心远近、按街道或按网格臆造级别。未识别范围保留空白，不能当作零租金。

栅格数字化和投影假设带来位置误差，仅适合区域浏览。红线不用于宗地归级、工程测量、租赁定价或建设审批。实际建设应核实最终土地级别、权属、场地租金、租期、建设许可与接电条件。

## 执行流程

```text
① 打开 construction-reference.html
  ↓
② construction-reference.js 创建独立 Vue 页面
  ↓
③ ConstructionReferenceMap.vue 读取 weidu-construction-reference.json
  ↓
④ constructionReferenceDrawing() 用同一坐标比例绘制边界、分区、设施
  ↓
⑤ 点击红色分区或蓝色点 → selected 改变 → 右侧显示参考值或设施来源
  ├─ 切换价格口径 → 只更新参考值与单位，不改变分区几何
  └─ 勾选变压器 → 显示独立类型，不增加变电站数量
```

页面没有异步业务请求、监听或定时器；交互状态只保留在本次组件实例，离开页面由 Vue 释放。窄屏仅地图区域允许横向滑动，页面正文正常换行。

## 重建数据

运行环境使用现有后端依赖 `numpy`、`rasterio`、`pyproj`、`shapely`，没有增加前端依赖。先准备明确标记 WGS84 的项目行政边界 GeoJSON，再运行：

```powershell
.\backend\.venv\Scripts\python.exe -X utf8 scripts/data/build-construction-reference.py --image public/reference/xuchang-commercial-grades-draft-2024.jpg --boundary <行政边界WGS84文件>
```

生成 `data/processed/weidu-construction-reference.json`。分区标签放在面内最大内切圆中心，仅用于布局，不移动原始电力点位。

来源：

- [官方草案与图件附件](https://www.xuchang.gov.cn/hdjl/004007/20240130/6ee1e491-a616-4ed8-957b-1eac36ad4214.html)
- [正式基准地价、土地收益租金表](https://zrzyhghj.xuchang.gov.cn/zxgz/014003/20240605/a4c9ad99-9a01-496c-a638-c6bcefc2b8f3.html)
- [OpenStreetMap 署名与许可](https://www.openstreetmap.org/copyright)
