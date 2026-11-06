import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { point, polygon } from '@turf/turf'
import { searchPois } from '../../src/features/map/api/poiSearch.js'
import { useStationSearch } from '../../src/features/map/composables/useStationSearch.js'

const boundary = polygon([[[113,33],[115,33],[115,35],[113,35],[113,33]]])
const row = (id, name = '图书馆', coordinates = [113.83,34.04]) => ({ id:'facility_pois:'+id,sourceId:id,name,
  coordinates,category:'school',source:'facility_pois',coordSystem:'WGS84' })
const response = rows => ({ ok:true, json:async()=>rows })
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(fetcher = async()=>response([row('a')])) {
  let now=0, sequence=0
  const jobs=new Map(), calls=[], selections=[], notices=[], storage=new Map(), listeners=new Map()
  const timers={setTimeout(callback,delay){const id=++sequence;jobs.set(id,{callback,at:now+delay});return id},
    clearTimeout(id){jobs.delete(id)},async advance(ms){now+=ms;for(const [id,job]of [...jobs])if(job.at<=now){jobs.delete(id);job.callback()}await flush()}}
  const controller=new AbortController(), stations=[point([113.83,34.04],{id:'local',name:'已加载图书馆'})]
  const state=useStationSearch({getMap:()=>({fitBounds(){}}),getBoundary:()=>[boundary],getStations:()=>stations,
    activeBasemap:ref('street'),loading:ref(false),signal:controller.signal,quickPanelOpen:ref(false),boundaryPanelOpen:ref(false),
    closeMapPanels(){},closeMapPanelsOnEscape(){},onSelect:feature=>selections.push(feature),onNotice:()=>notices.push(true),
    fetcher:(url,options)=>{calls.push({url,signal:options.signal});return fetcher(url,options)},timers,
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    document:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name)}}})
  return {state,timers,jobs,calls,selections,stations,notices,listeners,controller}
}

test('API 单独封装名称参数与 WGS84 坐标，拒绝错误响应和无效坐标',async()=>{
  let url
  const result=await searchPois(' 图书 & A ',{fetcher:async value=>{url=value;return response([row('a'),row('bad','错误',[200,34]),{...row('gcj'),coordSystem:'GCJ-02'}])}})
  assert.equal(url,'/api/pois?q='+encodeURIComponent('图书 & A'))
  assert.equal(result.length,1)
  assert.deepEqual(result[0].geometry.coordinates,[113.83,34.04])
  assert.equal(result[0].properties.searchId,'facility_pois:a')
  await assert.rejects(searchPois('词',{fetcher:async()=>response({features:[]})}),/格式/)
})

test('连续输入在 300 毫秒后只查询最终关键词，自动建议不会擅自定位',async()=>{
  const f=fixture(),s=f.state
  s.stationKeyword.value='图';s.schedulePoiSearch()
  await f.timers.advance(200)
  s.stationKeyword.value='图书';s.schedulePoiSearch()
  await f.timers.advance(299)
  assert.equal(f.calls.length,0)
  assert.equal(s.searchPending.value,true)
  await f.timers.advance(1)
  assert.equal(f.calls.length,1)
  assert.ok(f.calls[0].url.endsWith(encodeURIComponent('图书')))
  assert.equal(s.matchingStations.value.length,1)
  assert.equal(s.searchPending.value,false)
  assert.equal(f.selections.length,0)
  s.disposeSearch()
})

test('中文输入法组词期间不发请求，完成组词后再防抖',async()=>{
  const f=fixture(),s=f.state
  s.startSearchComposition();s.stationKeyword.value='tu';s.schedulePoiSearch({isComposing:true})
  await f.timers.advance(1000)
  assert.equal(f.calls.length,0)
  s.finishSearchComposition({target:{value:'图书馆'}})
  await f.timers.advance(300)
  assert.equal(f.calls.length,1)
  assert.equal(s.matchingStations.value[0].properties.name,'图书馆')
  s.disposeSearch()
})

test('旧请求即使晚到也不覆盖新结果，清空和关闭会取消请求且不重开面板',async()=>{
  const pending=[],f=fixture(()=>new Promise(resolve=>pending.push(resolve))),s=f.state
  s.stationKeyword.value='旧';const old=s.searchStation({suggestions:true})
  s.stationKeyword.value='新';const current=s.searchStation({suggestions:true})
  assert.equal(f.calls[0].signal.aborted,true)
  pending[1](response([row('new','新地点')]))
  await current
  pending[0](response([row('old','旧地点')]))
  await old
  assert.equal(s.matchingStations.value[0].properties.name,'新地点')
  s.stationKeyword.value='清空';const cleared=s.searchStation({suggestions:true})
  s.clearSearch();assert.equal(f.calls[2].signal.aborted,true)
  pending[2](response([row('late')]))
  await cleared
  assert.equal(s.matchingStations.value.length,0)
  assert.equal(s.searchPanelOpen.value,false)
  s.stationKeyword.value='关闭';const closed=s.searchStation({suggestions:true})
  s.closeSearchPanel();pending[3](response([row('late')]))
  await closed
  assert.equal(s.searchPanelOpen.value,false)
  assert.equal(s.searchPending.value,false)
  s.disposeSearch()
})

test('同名不同 ID 的建议可用键盘选择，定位成功提示和历史保留，原始地图数据不变',async()=>{
  const f=fixture(async()=>response([row('a'),row('b')])),s=f.state,original=JSON.stringify(f.stations)
  s.stationKeyword.value='图书';await s.searchStation({suggestions:true})
  const key=value=>s.handleSearchKeydown({key:value,preventDefault(){}})
  key('ArrowDown');key('ArrowDown');key('Enter')
  assert.equal(f.selections[0].properties.searchId,'facility_pois:b')
  assert.equal(s.searchSelectionMessage.value,'地图已定位至：图书馆')
  assert.equal(s.searchPanelOpen.value,false)
  assert.equal(s.stationKeyword.value,'')
  assert.equal(s.searchHistory.value[0],'图书馆')
  assert.equal(JSON.stringify(f.stations),original)
  s.disposeSearch()
})

test('无结果明确为空；接口失败降级到已载入数据并提示来源，缺坐标不能定位',async()=>{
  const empty=fixture(async()=>response([])),s=empty.state
  s.stationKeyword.value='不存在';await s.searchStation({suggestions:true})
  assert.equal(s.searchResultCount.value,0)
  assert.equal(s.searchError.value,'')
  const failed=fixture(async()=>{throw Error('offline')}),f=failed.state
  f.stationKeyword.value='图书';await f.searchStation({suggestions:true})
  assert.match(f.searchError.value,/已加载数据/)
  assert.equal(f.matchingStations.value.length,1)
  f.selectSearchStation({geometry:{type:'Point',coordinates:[NaN,34]},properties:{name:'错误'}})
  assert.equal(failed.selections.length,0)
  s.disposeSearch();f.disposeSearch()
})

test('卸载清除防抖与事件监听，待处理请求和迟到响应不再更新界面',async()=>{
  const f=fixture(),s=f.state
  s.stationKeyword.value='图书';s.schedulePoiSearch()
  s.disposeSearch()
  await f.timers.advance(300)
  assert.equal(f.calls.length,0)
  assert.equal(f.jobs.size,0)
  assert.equal(f.listeners.size,0)
  assert.equal(s.searchPending.value,false)
})
