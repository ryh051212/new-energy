// CSS 像素跟随地图层级平滑变化，同时给内容和地图边缘留出空间。
export function adaptivePopupLayout({ width, height, zoom = 11, point }) {
  const inset = Math.min(12, Math.max(0, Math.min(width, height) / 12))
  const preferred = 288 * 2 ** ((zoom - 11) * .12)
  const availableWidth = Math.max(0, width - inset * 2 - 2)
  const popupWidth = Math.min(Math.max(232, preferred), availableWidth, width < 600 ? availableWidth : width * .65)
  const x = Math.max(0, Math.min(width, point?.x ?? width / 2))
  const y = Math.max(0, Math.min(height, point?.y ?? height / 2))
  const verticalHeight = Math.max(y, height - y) - inset - 24
  const sideHeight = 2 * Math.min(y - inset, height - y - inset) - 2
  const sideFits = Math.max(x, width - x) >= popupWidth + inset + 16
  const compact = width < 600 || height < 320
  let anchor
  let availableHeight = verticalHeight
  if (compact) {
    anchor = 'center'
    availableHeight = height - inset * 2 - 2
  } else if (sideFits && sideHeight > verticalHeight) {
    anchor = width - x >= x ? 'left' : 'right'
    availableHeight = sideHeight
  }
  const maxHeight = Math.max(0, availableHeight)
  // 矮窄地图在地图内部展开，仍以选中位置为锚点，仅对靠边位置做偏移。
  let offset = 6
  if (compact) {
    offset = [
      Math.max(popupWidth / 2 + inset, Math.min(width - popupWidth / 2 - inset, x)) - x,
      Math.max(maxHeight / 2 + inset, Math.min(height - maxHeight / 2 - inset, y)) - y,
    ]
  }
  const visible = !point || point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height
  return { width: Math.floor(popupWidth), maxHeight: Math.floor(maxHeight), visible, anchor, offset }
}

export function bindAdaptivePopup({ map, popup, content, position,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? (callback => setTimeout(callback, 0)),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) ?? clearTimeout,
  Observer = globalThis.ResizeObserver,
}) {
  const container = map.getContainer?.()
  if (!container) return () => {}
  let frame
  let disposed = false
  function update() {
    frame = undefined
    if (disposed) return
    const layout = adaptivePopupLayout({
      width: container.clientWidth,
      height: container.clientHeight,
      zoom: map.getZoom(),
      point: map.project(position),
    })
    content.style.setProperty('--grid-popup-width', `${layout.width}px`)
    content.style.setProperty('--grid-popup-max-height', `${layout.maxHeight}px`)
    const element = popup.getElement()
    if (element) element.style.visibility = layout.visible ? '' : 'hidden'
    popup.options.anchor = layout.anchor
    popup.setOffset(layout.offset)
    // 让 MapLibre 按更新后的实际尺寸重新选择锚点，不缩放文字、不移动选中位置。
    popup.setLngLat(position)
  }
  function schedule() {
    if (disposed || frame !== undefined) return
    frame = requestFrame(update)
  }
  function dispose() {
    if (disposed) return
    disposed = true
    if (frame !== undefined) cancelFrame(frame)
    for (const event of ['zoom', 'move', 'resize']) map.off(event, schedule)
    observer?.disconnect()
    popup.off?.('close', dispose)
  }
  const observer = Observer ? new Observer(schedule) : null
  observer?.observe(content)
  for (const event of ['zoom', 'move', 'resize']) map.on(event, schedule)
  popup.on?.('close', dispose)
  update()
  return dispose
}
