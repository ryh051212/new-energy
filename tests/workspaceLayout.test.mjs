import test from 'node:test'
import assert from 'node:assert/strict'
import { WORKSPACE_LAYOUT_KEY, clampPanelRect, coupledPanelRects, defaultPanelRect, normalizePanelRect, readWorkspaceLayouts, resizePanelRect, restorePanelRect, workspaceDockTarget } from '../src/utils/workspaceLayout.js'

test('恢复父容器的初始布局，车网与双碳分析容器独占工作区，小屏地图与完整分析栏上下排列',()=>{
 const size={width:1400,height:850}
 for(const view of ['grid','carbon'])assert.deepEqual(defaultPanelRect('analysis',view,size),{x:0,y:0,width:1400,height:850})
 for(const view of ['overview','siting','sandbox']){
  const map=defaultPanelRect('map',view,size),panel=defaultPanelRect('analysis',view,size)
  assert.ok(map.x+map.width<panel.x);assert.equal(panel.x+panel.width,size.width)
  assert.equal(map.height,size.height);assert.equal(panel.height,size.height)
 }
 const small={width:304,height:680},map=defaultPanelRect('map','siting',small),panel=defaultPanelRect('analysis','siting',small)
 assert.equal(map.x,0);assert.equal(panel.x,0);assert.ok(map.y+map.height<panel.y);assert.equal(panel.y+panel.height,small.height)
})

test('左右上下分区共同填满工作区，分析栏扩张多少地图就收缩多少，没有覆盖或空洞',()=>{
 const bounds={width:1400,height:850}
 for(const side of ['left','right','top','bottom']){
  const horizontal=['left','right'].includes(side)
  const first=coupledPanelRects(bounds,{side,extent:350}),next=coupledPanelRects(bounds,{side,extent:430})
  const axis=horizontal?'width':'height',cross=horizontal?'height':'width',position=horizontal?'x':'y'
  assert.equal(next.analysis[axis]-first.analysis[axis],80)
  assert.equal(first.map[axis]-next.map[axis],80)
  assert.equal(next.map[cross],bounds[cross]);assert.equal(next.analysis[cross],bounds[cross])
  assert.equal(next.map[axis]+next.analysis[axis]+next.separator[axis],bounds[axis])
  const ordered=[next.map,next.analysis].sort((a,b)=>a[position]-b[position])
  assert.equal(ordered[0][position],0)
  assert.equal(ordered[0][axis]+next.separator[axis],ordered[1][position])
  assert.equal(ordered[1][position]+ordered[1][axis],bounds[axis])
 }
})

test('联动缩放共同遵守地图和分析栏最小尺寸；小屏不溢出；收起任一容器另一容器自动铺满',()=>{
 const size={width:1000,height:700}
 const widest=coupledPanelRects(size,{side:'right',extent:99999})
 assert.equal(widest.map.width,280);assert.equal(widest.analysis.width,708)
 const narrowest=coupledPanelRects(size,{side:'right',extent:-99999})
 assert.equal(narrowest.analysis.width,300);assert.equal(narrowest.map.width,688)
 const small=coupledPanelRects({width:304,height:440},{side:'bottom',extent:9999})
 assert.ok(small.map.height>0&&small.analysis.height>0)
 assert.ok(Math.abs(small.map.height+small.analysis.height+small.separator.height-440)<1e-9)
 const full={x:0,y:0,width:1000,height:700}
 assert.deepEqual(coupledPanelRects(size,{analysisVisible:false}).map,full)
 assert.deepEqual(coupledPanelRects(size,{mapVisible:false}).analysis,full)
 assert.equal(coupledPanelRects(size,{mapVisible:false}).separator,null)
})

test('父容器只在明确的方向目标处切换停靠，保存并恢复停靠方向',()=>{
 const size={width:1400,height:850}
 assert.equal(workspaceDockTarget(30,425,size),'left')
 assert.equal(workspaceDockTarget(1370,425,size),'right')
 assert.equal(workspaceDockTarget(700,30,size),'top')
 assert.equal(workspaceDockTarget(700,820,size),'bottom')
 assert.equal(workspaceDockTarget(700,425,size),'')
 assert.equal(workspaceDockTarget(1100,30,size),'')
 const data={'siting:desktop':{analysis:{x:0,y:0,width:1,height:.4,side:'top'}}}
 assert.equal(readWorkspaceLayouts({getItem:()=>JSON.stringify(data)})['siting:desktop'].analysis.side,'top')
})

test('八方向缩放固定相反边，尊重最小尺寸与可视边界，拖动和缩放不修改原矩形',()=>{
 const rect={x:100,y:100,width:500,height:400},size={width:1000,height:800},minimum={width:280,height:200}
 const original=structuredClone(rect)
 for(const edge of ['n','e','s','w','ne','se','sw','nw']){
  const next=resizePanelRect(rect,edge,40,30,size,minimum)
  if(edge.includes('w'))assert.equal(next.x+next.width,rect.x+rect.width)
  if(edge.includes('n'))assert.equal(next.y+next.height,rect.y+rect.height)
  assert.ok(next.width>=280&&next.height>=200&&next.x>=0&&next.y>=0)
 }
 assert.equal(resizePanelRect(rect,'nw',999,999,size,minimum).width,280)
 assert.deepEqual(clampPanelRect({...rect,x:999,y:999},size),{...rect,x:500,y:400})
 assert.deepEqual(rect,original)
 const small=resizePanelRect(rect,'se',-1000,-1000,{width:200,height:150},minimum)
 assert.deepEqual(small,{x:0,y:0,width:200,height:150})
})

test('布局按工作台和屏幕模式独立保存，窗口尺寸改变后仍可见，坏存储不影响页面',()=>{
 const rect={x:720,y:30,width:600,height:720},size={width:1400,height:850},normalized=normalizePanelRect(rect,size)
 const data={'siting:desktop':{analysis:{...normalized,hidden:false}},'carbon:compact':{analysis:{x:0,y:0,width:1,height:1}},'siting:compact':{bad:{x:0,y:0,width:2,height:1}},'__proto__':{}}
 const stored=readWorkspaceLayouts({getItem:key=>{assert.equal(key,WORKSPACE_LAYOUT_KEY);return JSON.stringify(data)}})
 assert.deepEqual(stored['siting:desktop'].analysis,{...normalized,hidden:false})
 assert.equal(stored['siting:compact'].bad,undefined)
 const resized=restorePanelRect(normalized,{width:900,height:600})
 assert.ok(resized.x+resized.width<=900&&resized.y+resized.height<=600)
 assert.deepEqual(readWorkspaceLayouts({getItem:()=>'{broken'}),{})
 assert.deepEqual(readWorkspaceLayouts({getItem:()=>{throw Error('denied')}}),{})
})
