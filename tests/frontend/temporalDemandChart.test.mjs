import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { ACTIVITY_TYPES } from '../../src/features/planning/models/functionalZones.js'
import { ACTIVITY_WEIGHT, CHARGING_START_PERCENT, PUBLIC_CHARGING_Q } from '../../src/features/planning/models/chargingStartScenario.js'

const source=fs.readFileSync(new URL('../../src/features/planning/components/TemporalDemandChart.vue',import.meta.url),'utf8')
const {descriptor}=parse(source)
const compiled=compileScript(descriptor,{id:'temporal-chart-test',inlineTemplate:true,genDefaultAs:'component'})
const code=compiled.content.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]vue['"];?\s*$/gm,(_,names)=>'const {'+names.replace(/\bas\b/g,':')+'}=Vue;')
  .replace(/^import[^\r\n]+\r?\n/gm,'')
const component=vm.runInNewContext(code+'\ncomponent',{Vue,ACTIVITY_TYPES,ACTIVITY_WEIGHT,CHARGING_START_PERCENT,PUBLIC_CHARGING_Q})
const selection={day:'weekday',scenario:'medium',hour:8}
const temporal=values=>{
  const total=Object.values(values).every(v=>v!=null)?Object.values(values).reduce((sum,v)=>sum+v,0):null
  return {available:total!=null,scale:.1,missing:total==null?['work']:[],benchmarks:{},intensity:{},
    series:{medium:{weekday:Array.from({length:24},(_,hour)=>({hour,demandIndex:total,contributions:values}))}}}
}
const render=props=>renderToString(Vue.createSSRApp(component,props))

test('真实图表按总贡献展示占比，共同尺度与原始指数分开解释',async()=>{
  const html=await render({selection,temporal:temporal({residential:.02,work:.01,shopping:.01,leisure:0,public:0})})
  assert.match(html,/>40\.0<\/strong>/)
  assert.match(html,/主要来源：居住人口 · 贡献 50\.0%/)
  assert.equal((html.match(/>25\.0%<\/b>/g)||[]).length,2)
  assert.match(html,/原始指数 0\.04000/)
  assert.match(html,/不是公共充电概率/)
  assert.match(html,/全天累计指数相同/)
})

test('零需求不绘制虚假最小贡献，资料缺失不输出部分需求总分或百分比',async()=>{
  const values={residential:0,work:0,shopping:0,leisure:0,public:0}
  const zero=await render({selection,temporal:{...temporal(values),scale:0}})
  assert.match(zero,/已知需求为零/)
  assert.equal((zero.match(/>无贡献<\/b>/g)||[]).length,5)
  const missing=await render({selection,temporal:temporal({...values,residential:.02,work:null})})
  assert.match(missing,/资料不足/)
  assert.match(missing,/未知不作为零计算/)
  assert.doesNotMatch(missing,/主要来源：|>100\.0%<\/b>/)
})
