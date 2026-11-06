import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlanningRequests,requestRoadPlanning } from '../../src/features/planning/api/roadPlanning.js'
import { functionalZoneModel,applyDemandScenario } from '../../src/features/planning/models/functionalZones.js'

test('planning requests cancel old work and ignore late replies after edits/unmount',async()=>{
  const pending=[]
  const owner=createPlanningRequests((operation,params,signal)=>new Promise(resolve=>pending.push({operation,params,signal,resolve})))
  const first=owner.run('analyze',{thresholdMinutes:5})
  const second=owner.run('analyze',{thresholdMinutes:10})
  assert.equal(pending[0].signal.aborted,true)
  pending[0].resolve({old:true});assert.equal(await first,null)
  pending[1].resolve({current:true});assert.deepEqual(await second,{current:true})
  const last=owner.run('optimize',{});owner.cancel();pending[2].resolve({late:true});assert.equal(await last,null)
})

test('planning response validation keeps server errors and rejects incomplete results',async()=>{
  await assert.rejects(requestRoadPlanning('analyze',{},undefined,async()=>({ok:false,status:404,json:async()=>({detail:'Not Found'})})),error=>error.status===404 && /规划分析接口尚未加载/.test(error.message))
  await assert.rejects(requestRoadPlanning('analyze',{},undefined,async()=>({ok:false,status:409,json:async()=>({detail:'研究数据版本已变化'})})),/版本/)
  await assert.rejects(requestRoadPlanning('analyze',{},undefined,async()=>({ok:true,json:async()=>({})})),/不完整/)
})

test('activity weights use a fixed normalization scale and zero is distinct from missing',()=>{
  const model=functionalZoneModel([{properties:{id:1,populationModelCount:10,workplaceCount:5}},{properties:{id:2,residentialCount:0,workplaceCount:0}},{properties:{id:3}}])
  const normal=applyDemandScenario(model,'weekday-day'),changed=applyDemandScenario(model,'weekday-day',{residential:2})
  assert.equal(changed.scale,normal.scale)
  assert.equal(normal.features[1].properties.scenarioDemandIndex,0)
  assert.equal(normal.features[2].properties.scenarioDemandIndex,null)
  assert.ok(changed.features[0].properties.scenarioDemandIndex>normal.features[0].properties.scenarioDemandIndex)
})
