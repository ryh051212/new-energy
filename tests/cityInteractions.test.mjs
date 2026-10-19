import test from 'node:test'
import assert from 'node:assert/strict'
import { createAngelCity } from '../src/utils/angelCity.js'
import { createBuildingInteraction } from '../src/utils/cityInteractions.js'

test('picking any part highlights the whole building, and hover exit preserves its selection',()=>{
  const city=createAngelCity(),states=new Map()
  const map={setFeatureState({source,id},state){const key=`${source}/${id}`;states.set(key,{...states.get(key),...state})}}
  const interaction=createBuildingInteraction(map,city)
  const [a,b]=city.buildings.features.filter(f=>f.properties.base===0).map(f=>f.properties.buildingId)
  interaction.hover(a);interaction.select(a);interaction.hover(null)
  const parts=[...city.buildings.features,...city.bands.features].filter(f=>f.properties.buildingId===a)
  assert.ok(parts.length>3)
  assert.equal(states.size,parts.length)
  for(const state of states.values())assert.deepEqual(state,{hover:false,selected:true})
  interaction.hover(b)
  const selected=[...states.values()].filter(s=>s.selected)
  assert.equal(selected.length,parts.length)
  interaction.select(b)
  for(const feature of parts){
    const source=feature.properties.id.includes('-band-')?'bands':'buildings'
    assert.equal(states.get(`${source}/${feature.properties.id}`).selected,false)
  }
  interaction.clear()
  assert.ok([...states.values()].every(s=>!s.selected&&!s.hover))
})
test('stable part identifiers do not collide, repeated hover avoids updates, and unknown picks clear state safely',()=>{
  const city=createAngelCity(),calls=[]
  for(const source of ['buildings','bands']) {
    assert.equal(new Set(city[source].features.map(f=>f.properties.id)).size,city[source].features.length)
  }
  const interaction=createBuildingInteraction({setFeatureState:(...args)=>calls.push(args)},city)
  const id=city.buildings.features[0].properties.buildingId
  interaction.hover(id);const count=calls.length
  interaction.hover(id);assert.equal(calls.length,count)
  interaction.hover('removed-building');assert.equal(calls.length,count*2)
  assert.ok(calls.slice(count).every(([,state])=>state.hover===false))
  interaction.clear();assert.equal(calls.length,count*2)
})
