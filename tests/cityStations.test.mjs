import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref, nextTick } from 'vue'
import { ANGEL_CENTER, offsetPoint, nearbyModelStations, stationModel, simulateCharging } from '../src/utils/angelCity.js'
import { stationSnapshot, createStationModels, stationCurrentFacts, assessCityReachability, validDrivingRoutes, createLocalCity } from '../src/utils/cityStations.js'
import { useCityRoutes } from '../src/composables/useCityRoutes.js'
const point=(id,coordinates=ANGEL_CENTER,properties={})=>({type:'Feature',geometry:{type:'Point',coordinates},properties:{id,name:id,coordSystem:'WGS84',...properties}})
const route=(meters=2000)=>({type:'Feature',geometry:{type:'LineString',coordinates:[ANGEL_CENTER,offsetPoint(1000,0)]},properties:{drivingDistanceMeters:meters,drivingDurationSeconds:300,distanceSource:'amap_driving',distanceType:'driving',isFallback:false}})
const data=routes=>({type:'FeatureCollection',features:routes})

test('custom vehicle origin changes nearby stations, sorting and simulation distance',()=>{
  const moved=offsetPoint(4000,0),a=point('near-angel'),b=point('near-car',moved)
  assert.deepEqual(nearbyModelStations([a,b],800).map(f=>f.properties.id),['near-angel'])
  assert.deepEqual(nearbyModelStations([a,b],800,moved).map(f=>f.properties.id),['near-car'])
  assert.equal(stationModel(b,{}, {},moved).distance,0)
  assert.ok(stationModel(a,{}, {},moved).distance>3900)
})
test('charging vehicles occupy actual simulated slots and disappear on completion; no live cars inferred',()=>{
  const model=stationModel(point('a',ANGEL_CENTER,{pileCount:4,powerKw:60,availableCount:0}))
  const result=simulateCharging([model],{arrivals:30,duration:120})
  const initial=stationSnapshot(model,result,0),mid=stationSnapshot(model,result,30)
  assert.equal(initial.charging,0);assert.equal(initial.free,4)
  assert.ok(mid.charging>0);assert.equal(mid.charging+mid.free,4)
  assert.equal(new Set(mid.occupiedSlots).size,mid.charging)
  const scene=createStationModels([model],result,30)
  assert.equal(scene.vehicles.features.length,mid.charging*2)
  assert.equal(createStationModels([model],result,0).vehicles.features.length,0)
  assert.equal(stationSnapshot(model,result,10000).charging,0)
  for(const f of scene.vehicles.features){assert.equal(f.properties.stationId,'a');assert.ok(mid.occupiedSlots.includes(f.properties.slot))}
  const disabled={...model,enabled:false}
  assert.equal(stationSnapshot(disabled,simulateCharging([disabled]),30).free,0)
})
test('price and power do not promote demo fields to real facts; live availability expires',()=>{
  const now=Date.parse('2026-10-11T08:00:00Z')
  const properties={pileCount:12,powerKw:120,pricePerKwh:1.25,availableCount:4,availabilityIsRealtime:true,availabilityUpdatedAt:new Date(now-60000).toISOString()}
  const facts=stationCurrentFacts(properties,now)
  assert.equal(facts.priceText,'1.25 元/度');assert.equal(facts.powerText,'120 kW');assert.equal(facts.availability.availableCount,4)
  assert.equal(stationCurrentFacts(properties,now+300000).availability.hasRealtime,false)
  const demo=stationCurrentFacts({...properties,simulatedFields:['powerKw','pricePerKwh','availableCount']},now)
  assert.equal(demo.price,null);assert.equal(demo.power,null);assert.equal(demo.availability.hasRealtime,false)
  assert.equal(stationCurrentFacts({electricityPrice:.8,servicePrice:.3}).price,1.1)
  assert.equal(stationCurrentFacts({pricePerKwh:0}).price,0)
  assert.equal(stationCurrentFacts({pricePerKwh:1.1,electricityPrice:.8,servicePrice:.3,simulatedFields:['electricityPrice']}).price,null)
  assert.equal(stationCurrentFacts({}).powerText,'功率未知')
})
test('reachability requires driving evidence and vehicle inputs; low battery and access restrictions take precedence',()=>{
  const feature=point('a',offsetPoint(1000,0)),profile={batteryKwh:60,currentSoc:40,consumptionKwh:18,reserveSoc:10}
  const unknown=assessCityReachability(feature,ANGEL_CENTER,profile)
  assert.equal(unknown.status,'unknown');assert.equal(unknown.driving,false)
  const ready=assessCityReachability(feature,ANGEL_CENTER,profile,{status:'ready',routes:[route()]})
  assert.equal(ready.status,'reachable');assert.equal(ready.arrivalSoc,39.4)
  assert.equal(assessCityReachability(feature,ANGEL_CENTER,{...profile,currentSoc:10},{routes:[route()]}).status,'unreachable')
  assert.equal(assessCityReachability(feature,ANGEL_CENTER,{}, {routes:[route()]}).status,'unknown')
  assert.equal(assessCityReachability(point('closed',ANGEL_CENTER,{status:'closed'}),ANGEL_CENTER,profile,{routes:[route()]}).status,'blocked')
  assert.equal(assessCityReachability(point('AC',ANGEL_CENTER,{chargingCurrentTypes:['AC']}),ANGEL_CENTER,{...profile,chargingRequirement:'DC'},{routes:[route()]}).status,'blocked')
  assert.equal(validDrivingRoutes(data([{...route(),properties:{...route().properties,isFallback:true}}])).length,0)
  assert.equal(validDrivingRoutes(data([{...route(),geometry:{type:'LineString',coordinates:[[NaN,34],ANGEL_CENTER]}}])).length,0)
})
test('custom scenery never moves the named TianShi landmark; station plots clear synthetic buildings',()=>{
  const scene=createLocalCity(offsetPoint(4000,0))
  assert.equal(scene.buildings.features.some(f=>f.properties.kind==='mall'),false)
  assert.equal(scene.bands.features.some(f=>['building-0','building-2'].includes(f.properties.buildingId)),false)
  assert.ok(scene.roads.features.every(f=>f.properties.name.includes('示意')))
  const normal=createLocalCity(ANGEL_CENTER),body=normal.buildings.features.find(f=>f.properties.kind==='residential')
  const ring=body.geometry.coordinates[0],center=[0,1].map(i=>(ring[0][i]+ring[2][i])/2)
  assert.ok(!createLocalCity(ANGEL_CENTER,[point('lot',center)]).buildings.features.some(f=>f.properties.buildingId===body.properties.buildingId))
})
test('origin switch aborts older requests and ignores late responses; route requests use at most three workers',async()=>{
  const origin=ref([...ANGEL_CENTER]),stations=ref(Array.from({length:5},(_,i)=>point(String(i))))
  const requests=[],scope=effectScope()
  const service=scope.run(()=>useCityRoutes(origin,stations,(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}))))
  const first=service.refresh()
  assert.equal(requests.length,3)
  stations.value=[point('new')];origin.value=offsetPoint(5000,0);await nextTick()
  assert.ok(requests.every(r=>r.options.signal.aborted))
  const second=service.refresh();assert.equal(requests.length,4)
  for(const old of requests.slice(0,3))old.resolve({ok:true,json:async()=>data([route()])})
  await first
  assert.deepEqual([...service.routes.value.keys()],['new'])
  assert.equal(service.routes.value.get('new').status,'loading')
  requests[3].resolve({ok:true,json:async()=>data([route(3000)])});await second
  assert.equal(service.routes.value.get('new').routes[0].properties.drivingDistanceMeters,3000)
  assert.ok(requests[3].url.includes(new URLSearchParams({lng:origin.value[0],lat:origin.value[1]}).toString()))
  assert.equal(service.running.value,false)
  scope.stop()
})
