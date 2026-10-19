// 充电类型字形：快充用闪电、普通充电用插头。
// 同一套字形既用于地图标记（下面用 canvas 画成标记），也用于图例与列表（UiIcon 直接渲染路径），
// 因此路径统一使用 24 × 24 的绘制网格；glyph 记录字形实际包围盒，标记里按包围盒等比缩放，避免瘦长字形缩得太小。
export const CHARGING_ICONS = {
  'charge-fast': {
    paths: ['M13.35 1.6 4 12.9h6.15L9.15 22.4l9.35-11.6h-6.2z'],
    glyph: [4, 1.6, 14.5, 20.8],
    color: '#0f9f6e',
    colorLight: '#3ddc97',
    colorDark: '#067a53',
    label: '快充',
  },
  'charge-regular': {
    // 双插脚、圆角插头与短电线，在小尺寸下保留完整的插头轮廓。
    paths: [
      'M8.2 1.8h3.1v5.2H8.2z',
      'M12.7 1.8h3.1v5.2h-3.1z',
      'M5.2 6.2h13.6v4.6a6.8 6.8 0 0 1-13.6 0V6.2Z',
      'M10.7 16h2.6v2.5a1 1 0 0 0 1 1h2v2.6h-2a3.6 3.6 0 0 1-3.6-3.6Z',
    ],
    glyph: [5.2, 1.8, 13.6, 20.3],
    color: '#2563eb',
    colorLight: '#60a5fa',
    colorDark: '#1e40af',
    label: '普通充电',
  },
}

export const chargingMapIcon = ['match', ['get', 'chargeType'], 'fast', 'charge-fast', 'charge-regular']
export const chargingMapColor = ['match', ['get', 'chargeType'], 'fast', CHARGING_ICONS['charge-fast'].color, CHARGING_ICONS['charge-regular'].color]

// 圆角方牌配短定位角；4 倍绘制保证高分屏下边缘锐利。
const MARKER_RATIO = 4
const MARKER_WIDTH = 32
const MARKER_HEIGHT = 36
const GLYPH_SIZE = 15.5

function markerPath(Path) {
  return new Path('M10 3H22Q28 3 28 9V21Q28 27 22 27H20L17.1 30.4Q16 31.6 14.9 30.4L12 27H10Q4 27 4 21V9Q4 3 10 3Z')
}

// 按字形包围盒等比缩放到 size，并居中绘制。
function paintGlyph(context, icon, Path, size) {
  const [x, y, width, height] = icon.glyph
  const scale = size / Math.max(width, height)
  context.save()
  context.scale(scale, scale)
  context.translate(-x - width / 2, -y - height / 2)
  context.fillStyle = '#ffffff'
  icon.paths.forEach(path => context.fill(new Path(path), 'nonzero'))
  context.restore()
}

function drawMarker(context, icon, Path) {
  const ratio = MARKER_RATIO
  const pin = markerPath(Path)
  context.save()
  context.scale(ratio, ratio)

  // 轻投影与白边使浅色道路、卫星底图上的轮廓同样清楚。
  context.save()
  context.shadowColor = 'rgba(15, 23, 42, .22)'
  context.shadowBlur = 2 * ratio
  context.shadowOffsetY = 1 * ratio
  context.lineJoin = 'round'
  context.strokeStyle = '#ffffff'
  context.lineWidth = 2
  context.fillStyle = icon.color
  context.fill(pin)
  context.stroke(pin)
  context.restore()

  // 纯色主体配大字形，减少装饰，让密集站点的类型更容易辨认。
  context.fillStyle = icon.color
  context.fill(pin)
  context.lineJoin = 'round'
  context.strokeStyle = '#ffffff'
  context.lineWidth = 2
  context.stroke(pin)

  context.translate(MARKER_WIDTH / 2, 15)
  paintGlyph(context, icon, Path, GLYPH_SIZE)
  context.restore()
}

// 使用本地矢量路径同步生成高清地图图标，无需外部字体或图标网络请求。
export function registerChargingIcons(map, dom = globalThis.document, Path = globalThis.Path2D) {
  if (!map?.addImage || !dom || !Path) return
  for (const [id, icon] of Object.entries(CHARGING_ICONS)) {
    if (map.hasImage?.(id)) continue
    const canvas = dom.createElement('canvas')
    canvas.width = MARKER_WIDTH * MARKER_RATIO
    canvas.height = MARKER_HEIGHT * MARKER_RATIO
    const context = canvas.getContext('2d')
    if (!context) continue
    drawMarker(context, icon, Path)
    map.addImage(id, context.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: MARKER_RATIO })
  }
}

export { MARKER_WIDTH, MARKER_HEIGHT }
