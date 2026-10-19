import { ref, watch, onScopeDispose } from 'vue'
import { validDrivingRoutes } from '../utils/cityStations.js'

// A new origin invalidates every previous route, including late uncancellable responses.
export function useCityRoutes(origin,stations,fetcher=(...args)=>fetch(...args)) {
  const routes=ref(new Map()),running=ref(false)
  let generation=0,debounce,disposed=false
  const controllers=new Set()
  function cancel() {generation++;clearTimeout(debounce);controllers.forEach(c=>c.abort());controllers.clear();running.value=false}
  async function run(onlyId=null) {
    cancel()
    const version=generation,center=[...origin.value]
    const pool=stations.value.filter(f=>!onlyId||String(f.properties.id)===onlyId)
    if(!onlyId)routes.value=new Map()
    const write=(id,state)=>{if(!disposed&&version===generation)routes.value=new Map(routes.value).set(id,state)}
    for(const f of pool)write(String(f.properties.id),{status:'loading',routes:[]})
    running.value=!!pool.length
    let index=0
    async function worker() {
      while(index<pool.length&&!disposed&&version===generation) {
        const station=pool[index++],id=String(station.properties.id),controller=new AbortController()
        controllers.add(controller)
        const timeout=setTimeout(()=>controller.abort(),10000)
        try {
          const params=new URLSearchParams({lng:center[0],lat:center[1]})
          const response=await fetcher(`http://127.0.0.1:8000/api/stations/${encodeURIComponent(id)}/routes?${params}`,{signal:controller.signal})
          if(!response.ok)throw new Error('Route unavailable')
          const data=await response.json(),valid=validDrivingRoutes(data)
          write(id,{status:valid.length?'ready':'unavailable',routes:valid,origin:center})
        } catch {write(id,{status:'unavailable',routes:[],origin:center})}
        finally {clearTimeout(timeout);controllers.delete(controller)}
      }
    }
    await Promise.all(Array.from({length:Math.min(3,pool.length)},worker))
    if(!disposed&&version===generation)running.value=false
  }
  watch([origin,stations],()=>{cancel();routes.value=new Map();debounce=setTimeout(()=>run(),350)},{immediate:true})
  onScopeDispose(()=>{disposed=true;cancel()})
  return {routes,running,refresh:()=>run()}
}
