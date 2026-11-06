import { AMAP_STANDARD_SOURCE } from './basemaps.js'
import { chargingMapColor, chargingMapIcon } from '../../stations/models/chargingIcons.js'
import { facilityPointLayers } from './facilityMapLayers.js'
import { contextMapLayers } from './sitingContextLayers.js'
import { constructionLayers } from './constructionLayers.js'

// 图层顺序决定叠放顺序。每张地图使用独立的 sources/layers 对象。
export function createMapStyle(highlightColor) {
  return {
      version: 8,
      sources: {
        streetTiles: AMAP_STANDARD_SOURCE,
        satelliteTiles: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          attribution: "Tiles © Esri",
        },
        terrainTiles: {
          type: "raster",
          tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenTopoMap contributors",
        },
        // 五类正式业务数据先建立空 Source，地图 load 后统一从 FastAPI 填充。
        weidu: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        stations: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        'osm-roads': {type:'geojson',data:{type:'FeatureCollection',features:[]},attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'},
        population: {type:'geojson',data:{type:'FeatureCollection',features:[]},attribution:'GHS-POP R2023A © European Commission, JRC'},
        'siting-context':{type:'geojson',data:{type:'FeatureCollection',features:[]},attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · 高德地图'},
        hexgrid: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        'temporal-demand': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        'pss-grid': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-spacing': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-blind': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-voronoi': { type:'geojson',data:{type:'FeatureCollection',features:[]} },
        'pss-siting-context': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'siting-selection': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'construction-map': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'local-siting': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'functional-zones': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'planning-impact': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'road-research-grids': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'road-research-places': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'road-research-sites': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'selected-detail-grid': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        'selected-detail-station': {type:'geojson',data:{type:'FeatureCollection',features:[]}},
        residential: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        commercial: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        facilities: { type:'geojson', data:{type:'FeatureCollection',features:[]} },
        measure: {
          // 测距工具画的线，先放一个空数据，用户点击测距后再填内容
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        'facility-proposals': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-removals': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-service': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-places': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-location': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
        'facility-nearby': {
          type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        },
      },

      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#e8f2f4" },
        },
        { id: "street-base", type: "raster", source: "streetTiles" },
        { id: "satellite-base", type: "raster", source: "satelliteTiles", layout: { visibility: "none" } },
        { id: "terrain-base", type: "raster", source: "terrainTiles", layout: { visibility: "none" } },
        {id:'population-fill',type:'fill',source:'population',layout:{visibility:'none'},filter:['!=',['get','populationNorm'],null],paint:{'fill-color':['interpolate',['linear'],['coalesce',['get','populationNorm'],0],0,'#f1eef6',.25,'#bdc9e1',.5,'#74a9cf',1,'#0570b0'],'fill-opacity':.65}},
        {id:'road-research-fill',type:'fill',source:'road-research-grids',paint:{'fill-color':'#e2e8f0','fill-opacity':.66}},
        {id:'road-research-outline',type:'line',source:'road-research-grids',paint:{'line-color':'#fff','line-width':1}},
        {
          id: "weidu-fill",
          type: "fill",
          source: "weidu",
          paint: { "fill-color": "#2563eb", "fill-opacity": 0.045 },
        },
        {
          id: "hexgrid-hitarea",
          type: "fill",
          source: "hexgrid",
          paint: { "fill-color": "#000000", "fill-opacity": 0 },
        },
        {
          // 专门负责显示“当前被图表选中的六边形”
          id: "hexgrid-highlight",

          type: "fill",

          // 仍然使用原来的 hexgrid 数据
          source: "hexgrid",

          // 默认先匹配一个不存在的值
          // 所以页面刚打开的时候什么都不会高亮
          filter: ["==", ["get", "stationCount"], -1],

          paint: {
            // 高亮填充颜色
            "fill-color": highlightColor,

            // 稍微透明，底下的地图仍然能看见
            "fill-opacity": 0.65,
          },
        },
        {
          // 当前时段需求使用独立数据源，基础供需与规划预览不会覆盖它。
          id: "demand-index-fill",

          // 六边形是 Polygon，所以使用 fill
          type: "fill",

          source: "temporal-demand",

          // 默认关闭，避免与其他专题图互相覆盖
          layout: {
            visibility: "none",
          },

          paint: {
            // 固定全局尺度；未知显示灰色，已知零值仍属于最低需求级。
            "fill-color": [
              "case",
              ["==", ["get", "temporalDemandNorm"], null],
              "#cbd5e1",
              ["step", ["coalesce", ["get", "temporalDemandNorm"], 0],
                "#f7fee7", 0.2, "#d9f99d", 0.4, "#bef264", 0.6, "#84cc16", 0.8, "#3f6212"],
            ],

            "fill-opacity": 0.75,

            // 六边形边界
            "fill-outline-color": "#94a3b8",
          },
        },
        {
          // =====================================
          // 供需错配专题图
          // =====================================
          id: "mismatch-fill",

          // 六边形是 Polygon
          type: "fill",

          // mismatchIndex 已经存在 hex-grid.json 中
          source: "hexgrid",

          // 默认关闭，避免和其他专题图叠在一起
          layout: {
            visibility: "none",
          },

          paint: {
            // =====================================
            // 根据 mismatchIndex 连续设色
            //
            // 负值：供给相对高
            // 0附近：需求与供给相对接近
            // 正值：需求相对高
            // =====================================
            "fill-color": [
              "interpolate",

              // 线性渐变
              ["linear"],

              // 读取当前六边形的 mismatchIndex
              // 如果不存在，则按0处理
              ["coalesce", ["get", "mismatchIndex"], 0],

              // -1：供给明显高于需求
              -1,
              "#2166ac",

              // -0.4
              -0.4,
              "#67a9cf",

              // 0：相对接近
              0,
              "#f7f7f7",

              // +0.4
              0.4,
              "#ef8a62",

              // +1：需求明显高于供给
              1,
              "#b2182b",
            ],

            "fill-opacity": 0.78,

            // 六边形轮廓
            "fill-outline-color": "#94a3b8",
          },
        },
        {
          id:'pss-capacity-fill',type:'fill',source:'pss-grid',layout:{visibility:'none'},paint:{'fill-color':['case',['==',['get','pssCapacityKw'],null],'#94a3b8',['interpolate',['linear'],['coalesce',['get','pssCapacityKw'],0],0,'#eff6ff',500,'#93c5fd',2000,'#2563eb',10000,'#172554']],'fill-opacity':.7},
        },
        { id:'functional-zones-fill',type:'fill',source:'functional-zones',layout:{visibility:'none'},paint:{'fill-color':['coalesce',['get','functionalZoneColor'],'#a5afbd'],'fill-opacity':.62} },
        ...constructionLayers().filter(layer => layer.type !== 'symbol'),
        {id:'siting-blocked-fill',type:'fill',source:'siting-selection',filter:['==',['get','sitingGeometry'],'blocked'],paint:{'fill-color':'#94a3b8','fill-opacity':.22}},
        {id:'siting-scope-fill',type:'fill',source:'siting-selection',filter:['==',['get','sitingGeometry'],'scope'],paint:{'fill-color':'#2563eb','fill-opacity':.045}},
        {id:'siting-scope-outline',type:'line',source:'siting-selection',filter:['==',['get','sitingGeometry'],'scope'],paint:{'line-color':'#2563eb','line-width':2,'line-dasharray':[3,2]}},
        {id:'siting-scope-center',type:'circle',source:'siting-selection',filter:['==',['get','sitingGeometry'],'center'],paint:{'circle-color':'#2563eb','circle-radius':5,'circle-stroke-color':'#fff','circle-stroke-width':2}},
        {id:'local-siting-fill',type:'fill',source:'local-siting',filter:['==',['get','localGeometry'],'scope'],paint:{'fill-color':'#3978d0','fill-opacity':.055}},
        {id:'local-siting-outline',type:'line',source:'local-siting',filter:['==',['get','localGeometry'],'scope'],paint:{'line-color':'#3978d0','line-width':2,'line-dasharray':[3,2]}},
        { id:'pss-spacing-fill',type:'fill',source:'pss-spacing',paint:{'fill-color':'#2563eb','fill-opacity':.06} },
        { id:'pss-spacing-line',type:'line',source:'pss-spacing',paint:{'line-color':'#2563eb','line-opacity':.5,'line-width':1,'line-dasharray':[3,2]} },
        { id:'pss-voronoi-line',type:'line',source:'pss-voronoi',paint:{'line-color':'#8b5cf6','line-width':1.3,'line-opacity':.75} },
        { id:'pss-blind-circle',type:'circle',source:'pss-blind',paint:{'circle-color':'#e35b50','circle-radius':5,'circle-stroke-color':'#fff','circle-stroke-width':1.5} },
        {id:'pss-siting-area',type:'fill',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'area'],paint:{'fill-color':'#f59e0b','fill-opacity':.14}},
        {id:'pss-siting-outline',type:'line',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'area'],paint:{'line-color':'#ed8a12','line-width':3}},
        {id:'pss-siting-connection',type:'line',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'connection'],paint:{'line-color':'#3579d4','line-width':2,'line-dasharray':[3,2]}},
        {id:'pss-siting-reference',type:'symbol',source:'pss-siting-context',filter:['==',['get','sitingGeometry'],'reference'],layout:{'icon-image':'siting-station','icon-size':.9,'icon-allow-overlap':true,'icon-ignore-placement':true}},
        {id:'pss-siting-stations',type:'symbol',source:'stations',layout:{visibility:'none','icon-image':'siting-station','icon-size':.65,'icon-allow-overlap':true,'icon-ignore-placement':true}},
        ...contextMapLayers(),
        {id:'osm-roads-line',type:'line',source:'osm-roads',layout:{visibility:'none','line-cap':'round','line-join':'round'},paint:{
          'line-color':['match',['get','highway'],['motorway','motorway_link','trunk','trunk_link','primary','primary_link'],'#d97706',['secondary','secondary_link','tertiary','tertiary_link'],'#3b82a0','#64748b'],
          'line-width':['interpolate',['linear'],['zoom'],10,.7,14,2,18,5],
          'line-opacity':['case',['get','motorVehicleCandidate'],.85,.4],
        }},
        ...facilityPointLayers(),
        { id: 'facility-service-fill', type: 'fill', source: 'facility-service',
          paint: { 'fill-color': '#dfe4e1', 'fill-opacity': 0.72, 'fill-outline-color': '#ffffff' } },
        { id: 'facility-location-fill', type: 'fill', source: 'facility-location',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#2563eb', 'fill-opacity': .07 } },
        { id: 'facility-location-outline', type: 'line', source: 'facility-location',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [3, 2] } },
        { id: 'facility-nearest-line', type: 'line', source: 'facility-nearby',
          filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#00856a', 'line-width': 2.5, 'line-dasharray': [2, 2] } },
        {
          id: "stations-circle",
          type: "circle",
          source: "stations",
          paint: {
            "circle-color": chargingMapColor,
            "circle-radius": 17,
            "circle-opacity": 0.01,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 0,
          },
        },
        {
          // 充电站头上的白色闪电图标
          // 图标本身要在地图 load 时用 addImage 注册，这里只负责引用
          id: "stations-bolt",
          type: "symbol",
          source: "stations",
          layout: {
            "icon-image": chargingMapIcon,
            // 低缩放层级略收小，避免密集城区标记互相压盖；放大后恢复原尺寸
            "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.9, 13, 1, 15, 1.08],
            // 站点挨得近时也照常显示，不参与避让
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        },
        {
          id: "weidu-outline",
          type: "line",
          source: "weidu",
          paint: { "line-color": "#ef4444", "line-width": 2, "line-dasharray": [2, 2] },
        },
        { id: 'facility-proposal-fill', type: 'fill', source: 'facility-proposals',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.16 } },
        { id: 'facility-proposal-outline', type: 'line', source: 'facility-proposals',
          filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#d97706', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } },
        { id: 'facility-proposal-point', type: 'circle', source: 'facility-proposals',
          filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['case', ['coalesce', ['get', 'sandboxSelected'], false], 10, 8], 'circle-color': '#f59e0b', 'circle-stroke-color': ['case', ['coalesce', ['get', 'sandboxSelected'], false], '#2563eb', '#ffffff'], 'circle-stroke-width': 2.5 } },
        { id: 'facility-removal-point', type: 'circle', source: 'facility-removals',
          paint: { 'circle-radius': 9, 'circle-color': '#fee2e2', 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 2.5 } },
        {id:'planning-impact-point',type:'circle',source:'planning-impact',paint:{'circle-radius':6,'circle-stroke-width':2,'circle-stroke-color':'#fff','circle-color':['case',['boolean',['get','lostReach'],false],'#bd5140',['boolean',['get','newlyReachable'],false],'#0b9473',['>=',['coalesce',['get','distanceSaved'],0],1],'#347fd6',['<=',['coalesce',['get','distanceSaved'],0],-1],'#bd5140','#0891b2']}},
        {id:'road-research-site-point',type:'circle',source:'road-research-sites',paint:{'circle-color':'#7560c7','circle-radius':4,'circle-stroke-color':'#fff','circle-stroke-width':1.5}},
        {id:'road-research-place-point',type:'circle',source:'road-research-places',paint:{'circle-radius':6,'circle-stroke-width':2,'circle-stroke-color':'#fff','circle-color':['case',['all',['!', ['get','beforeCovered']],['get','afterCovered']],'#0b9473',['all',['get','beforeCovered'],['!', ['get','afterCovered']]],'#bd5140',['>', ['coalesce',['get','timeSavedSeconds'],0],0],'#347fd6','#bd5140']}},
        { id: 'facility-place-point', type: 'circle', source: 'facility-places',
          paint: { 'circle-radius': 6, 'circle-color': ['get', 'placeColor'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } },
        { id: 'facility-nearby-point', type: 'circle', source: 'facility-nearby',
          filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 20, 'circle-color': '#00856a', 'circle-opacity': .05, 'circle-stroke-color': '#00856a', 'circle-stroke-width': 1.5 } },
        { id: 'facility-location-point', type: 'circle', source: 'facility-location',
          filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 9, 'circle-color': '#2563eb', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } },
        {id:'local-siting-connection',type:'line',source:'local-siting',filter:['==',['get','localGeometry'],'connection'],paint:{'line-color':'#3978d0','line-width':2,'line-dasharray':[2,2]}},
        {id:'local-siting-center',type:'circle',source:'local-siting',filter:['==',['get','localGeometry'],'center'],paint:{'circle-radius':5,'circle-color':'#1d4ed8','circle-stroke-color':'#fff','circle-stroke-width':2}},
        {id:'local-siting-candidate',type:'circle',source:'local-siting',filter:['==',['get','localGeometry'],'candidate'],paint:{'circle-radius':['case',['boolean',['get','selected'],false],12,10],'circle-color':['case',['boolean',['get','selected'],false],'#e79525','#3978d0'],'circle-stroke-color':'#fff','circle-stroke-width':2}},
        {id:'local-siting-number',type:'symbol',source:'local-siting',filter:['==',['get','localGeometry'],'candidate'],layout:{'icon-image':['concat','local-site-', ['to-string',['get','rank']]],'icon-size':.5,'icon-allow-overlap':true,'icon-ignore-placement':true}},
        ...constructionLayers().filter(layer => layer.type === 'symbol'),
        {
          // 测距折线：把用户点过的点依次连起来
          id: "measure-line",
          type: "line",
          source: "measure",
          // 同一个数据源里既有线也有点，这里只画线
          filter: ["==", ["geometry-type"], "LineString"],
          paint: { "line-color": "#f97316", "line-width": 3, "line-dasharray": [2, 1.2] },
        },
        {
          // 测距顶点：每次点击的位置画一个小圆点
          id: "measure-point",
          type: "circle",
          source: "measure",
          // 这里只画点，不画线
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 5,
            "circle-color": "#ffffff",
            "circle-stroke-color": "#f97316",
            "circle-stroke-width": 2.5,
          },
        },
        { id:'selected-detail-grid-fill', type:'fill', source:'selected-detail-grid',
          paint:{'fill-color':'#4f46e5','fill-opacity':.16} },
        { id:'selected-detail-grid-outline', type:'line', source:'selected-detail-grid',
          paint:{'line-color':'#4338ca','line-width':3,'line-opacity':.95} },
        { id:'selected-detail-station-halo', type:'circle', source:'selected-detail-station',
          paint:{'circle-radius':25,'circle-color':'#fff','circle-stroke-color':'#4f46e5','circle-stroke-width':4} },
        { id:'selected-detail-station-symbol', type:'symbol', source:'selected-detail-station',
          layout:{'icon-image':chargingMapIcon,'icon-size':1.25,'icon-allow-overlap':true,'icon-ignore-placement':true} },
      ],
    }
}
