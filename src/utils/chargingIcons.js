// 成套充电桩图形：快充以闪电区分，普通充电以充电枪和插座区分。
export const CHARGING_ICONS = {
  'charge-fast': { paths: ['M6 3h7a2 2 0 0 1 2 2v15h1v2H3v-2h1V5a2 2 0 0 1 2-2Zm1 2v4h5V5H7Zm3.4 6-3.8 5h2.6L8.7 20l4-5.4h-2.6l.3-3.6Z', 'm20 6-4 6h2.5l-.5 5 4-7h-2.5L20 6Z'], color: '#16a34a', label: '快充' },
  'charge-regular': { paths: ['M6 3h7a2 2 0 0 1 2 2v15h1v2H3v-2h1V5a2 2 0 0 1 2-2Zm1 2v4h5V5H7Zm2.5 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z', 'M16 5.2 20.8 10c.8.8 1.2 1.9 1.2 3v4a3 3 0 0 1-6 0v-3h-1v-2h1a2 2 0 0 1 2 2v3a1 1 0 0 0 2 0v-4h-1a2 2 0 0 1-2-2V9l-2.4-2.4L16 5.2Z'], color: '#2563eb', label: '普通充电' },
}

export const chargingMapIcon = ['match', ['get', 'chargeType'], 'fast', 'charge-fast', 'charge-regular']
export const chargingMapColor = ['match', ['get', 'chargeType'], 'fast', CHARGING_ICONS['charge-fast'].color, CHARGING_ICONS['charge-regular'].color]

// 使用本地矢量路径同步生成高清地图图标，无需外部字体或图标网络请求。
export function registerChargingIcons(map, dom = globalThis.document, Path = globalThis.Path2D) {
  if (!map?.addImage || !dom || !Path) return
  for (const [id, icon] of Object.entries(CHARGING_ICONS)) {
    if (map.hasImage?.(id)) continue
    const canvas = dom.createElement('canvas')
    canvas.width = canvas.height = 96
    const context = canvas.getContext('2d')
    if (!context) continue
    const badge = new Path('M26 6H70a20 20 0 0 1 20 20v44a20 20 0 0 1-20 20H26A20 20 0 0 1 6 70V26A20 20 0 0 1 26 6Z')
    context.shadowColor = 'rgba(15, 35, 60, .28)'
    context.shadowBlur = 5
    context.shadowOffsetY = 3
    context.fillStyle = icon.color
    context.fill(badge)
    context.shadowColor = 'transparent'
    context.strokeStyle = '#ffffff'
    context.lineWidth = 5
    context.stroke(badge)
    context.translate(17, 15)
    context.scale(62 / 24, 62 / 24)
    context.fillStyle = '#ffffff'
    icon.paths.forEach(path => context.fill(new Path(path), 'evenodd'))
    map.addImage(id, context.getImageData(0, 0, 96, 96), { pixelRatio: 3 })
  }
}
