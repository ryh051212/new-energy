import test from 'node:test'
import assert from 'node:assert/strict'
import { adaptivePopupLayout, bindAdaptivePopup } from '../../src/features/map/composables/useAdaptivePopup.js'

test('弹窗随地图层级平滑变宽，并受实际地图尺寸约束', () => {
  const layout = zoom => adaptivePopupLayout({width:1200,height:700,zoom,point:{x:600,y:350}})
  assert.ok(layout(10).width < layout(13).width)
  assert.ok(layout(13).width < layout(16).width)
  const small = adaptivePopupLayout({width:280,height:320,zoom:18,point:{x:140,y:160}})
  assert.ok(small.width <= 256)
  assert.equal(small.anchor,'center')
  assert.ok(small.maxHeight <= 296)
  const tiny = adaptivePopupLayout({width:100,height:90,zoom:20})
  assert.ok(tiny.width < 100)
  assert.ok(tiny.maxHeight < 90)
})

test('中央优先利用侧面空间，靠边自动换向，离开视野时隐藏', () => {
  const layout = point => adaptivePopupLayout({width:1200,height:700,zoom:12,point})
  assert.equal(layout({x:400,y:350}).anchor,'left')
  assert.equal(layout({x:800,y:350}).anchor,'right')
  assert.ok(layout({x:600,y:350}).maxHeight > 600)
  assert.equal(layout({x:600,y:30}).anchor,undefined)
  assert.ok(layout({x:600,y:30}).maxHeight > 600)
  assert.equal(layout({x:-1,y:350}).visible,false)
  assert.equal(layout({x:1201,y:350}).visible,false)
  assert.equal(layout({x:600,y:701}).visible,false)
})

test('窄屏在地图内部偏移，四角都保留边距且不固定到屏幕中央', () => {
  const width=390,height=230
  for(const point of [{x:10,y:10},{x:380,y:10},{x:380,y:220},{x:10,y:220}]){
    const layout=adaptivePopupLayout({width,height,zoom:16,point})
    assert.equal(layout.anchor,'center')
    const left=point.x+layout.offset[0]-layout.width/2,top=point.y+layout.offset[1]-layout.maxHeight/2
    assert.ok(left>=11&&left+layout.width<=width-11)
    assert.ok(top>=11&&top+layout.maxHeight<=height-11)
  }
})

test('缩放、移动、容器和内容变化合并更新，关闭后移除监听并取消迟到回调', () => {
  const listeners = new Map(), frames = new Map(), styles = {}, container = {clientWidth:1000,clientHeight:700}
  let zoom=11, point={x:500,y:350}, lastFrame=0, observer, positions=0
  const map = {getContainer:()=>container,getZoom:()=>zoom,project:()=>point,
    on(event,fn){listeners.set(event,fn)},off(event,fn){if(listeners.get(event)===fn)listeners.delete(event)}}
  const element={style:{}}, popup={options:{},getElement:()=>element,setLngLat(){positions++},setOffset(offset){this.offset=offset},
    on(event,fn){listeners.set('popup:'+event,fn)},off(event,fn){if(listeners.get('popup:'+event)===fn)listeners.delete('popup:'+event)}}
  const content={style:{setProperty(name,value){styles[name]=value}}}
  const dispose=bindAdaptivePopup({map,popup,content,position:[113.8,34],
    requestFrame(fn){frames.set(++lastFrame,fn);return lastFrame},cancelFrame(id){frames.delete(id)},
    Observer:class{constructor(fn){this.fn=fn;observer=this}observe(target){this.target=target}disconnect(){this.disconnected=true}},
  })
  const originalWidth=parseFloat(styles['--grid-popup-width'])
  zoom=15
  listeners.get('zoom')();listeners.get('move')();observer.fn()
  assert.equal(frames.size,1)
  const flush=()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)fn()}
  flush()
  assert.ok(parseFloat(styles['--grid-popup-width'])>originalWidth)
  assert.equal(observer.target,content)
  container.clientWidth=280;point={x:140,y:350};listeners.get('resize')();flush()
  assert.ok(parseFloat(styles['--grid-popup-width'])<=256)
  assert.equal(popup.options.anchor,'center')
  point={x:-10,y:350};listeners.get('move')();flush()
  assert.equal(element.style.visibility,'hidden')
  point={x:140,y:350};listeners.get('move')();flush()
  assert.equal(element.style.visibility,'')
  listeners.get('zoom')()
  const late=[...frames.values()][0],before=positions
  listeners.get('popup:close')()
  assert.equal(frames.size,0)
  assert.equal(listeners.size,0)
  assert.equal(observer.disconnected,true)
  late();dispose()
  assert.equal(positions,before)
})
