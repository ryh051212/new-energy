export const WORKSPACE_LAYOUT_KEY = 'weidu-workspace-layouts-v2'
export const workspaceContextKey = Symbol('workspace-layout')
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max))

export function clampPanelRect(rect, bounds, minimum = {}) {
  const width = clamp(rect.width, Math.min(minimum.width || 260, bounds.width), bounds.width)
  const height = clamp(rect.height, Math.min(minimum.height || 180, bounds.height), bounds.height)
  return { x: clamp(rect.x, 0, bounds.width - width), y: clamp(rect.y, 0, bounds.height - height), width, height }
}

export function resizePanelRect(rect, edge, dx, dy, bounds, minimum = {}) {
  const minWidth = Math.min(minimum.width || 260, bounds.width), minHeight = Math.min(minimum.height || 180, bounds.height)
  let {x,y,width,height} = rect
  if (edge.includes('e')) width = clamp(width + dx, minWidth, bounds.width - x)
  if (edge.includes('s')) height = clamp(height + dy, minHeight, bounds.height - y)
  if (edge.includes('w')) { x = clamp(rect.x + dx, 0, rect.x + rect.width - minWidth); width = rect.x + rect.width - x }
  if (edge.includes('n')) { y = clamp(rect.y + dy, 0, rect.y + rect.height - minHeight); height = rect.y + rect.height - y }
  return clampPanelRect({x,y,width,height}, bounds, minimum)
}

export function defaultPanelRect(placement, view, size, index = 0) {
  const {width:w,height:h} = size
  if(placement==='analysis' && ['grid','carbon'].includes(view)) return {x:0,y:0,width:w,height:h}
  if (w <= (view==='siting'?1100:760)) {
    const mapHeight=Math.max(250,(h-10)*.52)
    return clampPanelRect(placement==='map' ? {x:0,y:0,width:w,height:mapHeight} : {x:0,y:mapHeight+10,width:w,height:h-mapHeight-10},size,{height:180})
  }
  const rail=view==='siting'?Math.max(590,w*.524):w<=1100?320:380,gap=12,mapWidth=w-rail-gap
  if(placement==='map')return {x:0,y:0,width:mapWidth,height:h}
  return {x:mapWidth+gap,y:0,width:rail,height:h}
}

export function normalizePanelRect(rect, size) {
  return {x:rect.x/size.width,y:rect.y/size.height,width:rect.width/size.width,height:rect.height/size.height}
}

export function restorePanelRect(rect, size, minimum) {
  return clampPanelRect({x:rect.x*size.width,y:rect.y*size.height,width:rect.width*size.width,height:rect.height*size.height},size,minimum)
}

export function readWorkspaceLayouts(storage) {
  try {
    const data = JSON.parse(storage.getItem(WORKSPACE_LAYOUT_KEY) || '{}'), result = {}
    for (const [key,panels] of Object.entries(data)) {
      if (!/^(overview|siting|sandbox|grid|carbon):(compact|desktop)$/.test(key) || !panels || typeof panels !== 'object') continue
      result[key] = {}
      for (const [id,panel] of Object.entries(panels)) {
        if (!/^[a-z][a-z0-9-]*$/.test(id) || !panel || !['x','y','width','height'].every(field=>typeof panel[field] === 'number' && Number.isFinite(panel[field]) && panel[field]>=0 && panel[field]<=1) || panel.width===0 || panel.height===0) continue
        result[key][id] = {x:panel.x,y:panel.y,width:panel.width,height:panel.height,hidden:panel.hidden===true,
          ...(['left','right','top','bottom'].includes(panel.side)?{side:panel.side}:{})}
      }
    }
    return result
  } catch { return {} }
}

// The map and the whole analysis container share one partition. Neither can leave a hole or overlap the other.
export function coupledPanelRects(bounds, {side='right',extent,mapVisible=true,analysisVisible=true,gap=12,mapMinimum={},analysisMinimum={}}={}) {
  const full={x:0,y:0,width:bounds.width,height:bounds.height},empty={x:0,y:0,width:0,height:0}
  if(!mapVisible || !analysisVisible)return {map:mapVisible?full:empty,analysis:analysisVisible?full:empty,separator:null}
  const horizontal=['left','right'].includes(side),length=horizontal?bounds.width:bounds.height
  const spacing=Math.min(gap,Math.max(0,length-2)),available=length-spacing
  let minMap=horizontal?(mapMinimum.width || 280):(mapMinimum.height || 250)
  let minAnalysis=horizontal?(analysisMinimum.width || 300):(analysisMinimum.height || 220)
  const scale=Math.min(1,available/(minMap+minAnalysis))
  minMap*=scale;minAnalysis*=scale
  const analysisLength=clamp(Number.isFinite(extent)?extent:available*.45,minAnalysis,available-minMap),mapLength=available-analysisLength
  const analysisFirst=['left','top'].includes(side)
  const aStart=analysisFirst?0:mapLength+spacing,mStart=analysisFirst?analysisLength+spacing:0,split=analysisFirst?analysisLength:mapLength
  return horizontal ? {
    analysis:{x:aStart,y:0,width:analysisLength,height:bounds.height},map:{x:mStart,y:0,width:mapLength,height:bounds.height},
    separator:{x:split,y:0,width:spacing,height:bounds.height},
  } : {
    analysis:{x:0,y:aStart,width:bounds.width,height:analysisLength},map:{x:0,y:mStart,width:bounds.width,height:mapLength},
    separator:{x:0,y:split,width:bounds.width,height:spacing},
  }
}

export function workspaceDockTarget(x,y,bounds) {
  const width=Math.min(84,bounds.width*.22),height=Math.min(66,bounds.height*.18),inset=10
  const zones={left:{x:inset,y:(bounds.height-height)/2},right:{x:bounds.width-inset-width,y:(bounds.height-height)/2},
    top:{x:(bounds.width-width)/2,y:inset},bottom:{x:(bounds.width-width)/2,y:bounds.height-inset-height}}
  return Object.entries(zones).find(([,zone])=>x>=zone.x&&x<=zone.x+width&&y>=zone.y&&y<=zone.y+height)?.[0] || ''
}
