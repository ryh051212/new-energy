import { reactive, computed, watch } from 'vue'
import { restoreCarbonSettings, estimateChargingCarbon } from '../utils/chargingCarbon.js'
let saved
try { saved = JSON.parse(globalThis.localStorage?.getItem('weidu-carbon-settings-v1') || 'null') } catch { /* Optional local preferences. */ }
const settings = reactive(restoreCarbonSettings(saved))
watch(settings,value => {
  if (!estimateChargingCarbon(value).valid) return
  try { globalThis.localStorage?.setItem('weidu-carbon-settings-v1',JSON.stringify(value)) } catch { /* Calculation does not require storage. */ }
},{deep:true})
export function useChargingCarbon() {
  return { settings,estimate:computed(() => estimateChargingCarbon(settings)) }
}
