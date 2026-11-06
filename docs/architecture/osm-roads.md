# 魏都区 OSM 道路数据

地图的「图层管理 → 分析参考 → OSM 道路」按需读取本地快照。默认关闭，与充电站、POI 和供需专题叠加；切换高德底图时只转换显示坐标，原文件始终为 WGS84。道路不会改变手动新增点位的坐标。

2026-10-23 采集：1,487 条 OSM way、9,081 个节点、15,075 条有向分段边。采集范围取 `/api/boundary` 的真实研究区外包矩形，再向外扩展约 2 km；相交道路保留完整 way，避免边界截断造成网络断裂。因此数据并非严格裁切的行政区道路总量。当前完整道路线长合计约 1,448.34 km（含步行等非机动车道路及周边道路）。

## 数据文件与接口

| 文件 | 用途 | GET 接口 |
| --- | --- | --- |
| `data/raw/osm-roads-overpass.json` | 原始 Overpass 响应，包含原始标签及版本信息 | 不直接公开 |
| `data/processed/weidu-osm-roads.geojson` | 道路线与来源、坐标系、采集时间、分类统计 | `/api/osm-roads` |
| 同一文件的 metadata | 范围、日期、许可、质量状态 | `/api/osm-roads/metadata` |
| `data/processed/weidu-osm-road-network.json` | 节点、有向边、原始转向限制关系 | `/api/osm-roads/network` |

道路线保留 `osmId`、`nodeIds`、`highway`、`name`、`oneway`、`direction`、`lanes`、`maxspeed`、`surface`、`width`、`access`、`motor_vehicle`、`motorcar`、`bridge`、`tunnel`、`layer`、`junction`，以及完整原始 `tags`。缺失值保留未知；原始限速和宽度不擅自转换为已知通行时间。

拓扑只连接共享 OSM node ID 的道路。两条线在画面上交叉，不等于它们连通，桥梁和隧道不会因为几何相交被自动接通。边长按 WGS84 球面距离计算，单行线按方向生成边，反向单行 `-1` 保留反向。道路级别属于机动车候选且没有明确禁止时，`motorVehicleCandidate` 才为真；这仍不代表公众可通行。`motorAccess` 区分允许、限制、禁止与未知，具体交通方式标签优先于通用 `access`。

## 更新

在项目根目录、后端启动后运行：

```powershell
& .\backend\.venv\Scripts\python.exe -X utf8 -m backend.fetch_osm_roads
```

可用 `--boundary <GeoJSON路径>` 离线提供研究区边界，`--margin-km 2` 调整周边范围，`--endpoint` 指定其他公开 Overpass 实例。一次顺序请求获取道路和相关信息，不在页面操作中反复调用公共服务。校验失败或 Overpass 超时不会覆盖旧快照；接口按文件修改时间更新缓存。

## 后续分析边界

现在可用于道路邻近、道路等级统计与拓扑分析的数据准备。没有把现有方案效果中的直线距离换成驾车距离。当前 `routingReady=false`、`turnRestrictionsApplied=false`：尚未实现车辆规则、条件通行、闸门/私有道路策略、转向限制执行、道路匹配和道路权重；不能直接宣称可实际驾车导航。此次查询没有返回转向限制关系，也不代表当地不存在限制。OSM 缺失标签不等于没有限制，数据覆盖也不代表完整道路清单。

数据来源：[OpenStreetMap / Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)。许可：[ODbL 与署名要求](https://www.openstreetmap.org/copyright)，地图与元数据均保留 © OpenStreetMap contributors。

## 选址参考联动

`backend/siting_context.py` 将 OSM 补充要素、高德停车记录及按 ID 核对的公开项目规模转换为 `/api/siting-context`。地图默认关闭参考图层，在布局规划中自动加载参考数据以供选点查看；加载失败独立提示并可重试，不阻塞站点或更改草稿。图层开关与供需专题独立，底图转换只影响显示坐标。

`src/features/planning/models/sitingContext.js` 在选中新增站点后按原坐标计算道路线距离、最近停车入口、最近停车设施、最近电力设施及点所在用地面；水域多面和洞保留真实几何。道路距离是到线的球面距离，其他距离是到记录点的直线距离，均不等于驾车可达性；普通 `entrance=yes` 不当作机动车停车入口。高德按明确类型码区分停车设施与入口，避免将停车入口当作独立停车场。

原始补充数据：`data/raw/osm-siting-elements-overpass.json`；标准化数据：`data/processed/weidu-siting-context.geojson`；官方证据配置：`data/managed/siting-public-evidence.json`。官方设计车位只附在指定 ID 且名称一致的停车场，使用 `capacity/capacityKind/capacityDate/capacitySourceUrl` 表示，不填入用于约束评价的 `parkingSpaces`。OSM 电压标签不转换为 `availableKva`，用地映射不写入 `sitePermission`，道路邻近不写入 `roadAccess`。资料本身与建设判断保持可区分。

规划 JPG 经原图核对后本地保存，通过 `/api/siting-context/documents/parking-roadside` 与 `/api/siting-context/documents/parking-offroad` 读取；接口只接受固定图件 ID。设置中的来源目录同时提供规划公示、消防办理资料和国网公开容量页面链接，不自动操作外部验证或登录。
