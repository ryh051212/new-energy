import { DEFAULT_TRIP, normalizeTripContext } from './tripCharging.js'
import { normalizeDestinationInfo } from './destinations.js'

export const CHARGING_SETTINGS_KEY = 'weidu-ev.charging-settings.v1'
export const normalizeIntent = value => value === 'shopping' ? 'destination'
  : ['urgent', 'destination', 'economy'].includes(value) ? value : 'urgent'
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
function browserStorage() { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }
function normalizeSettings(value = {}) {
  const context = normalizeTripContext(value.profile || {})
  const profile = Object.fromEntries(Object.keys(DEFAULT_TRIP).filter(key => !['origin', 'shoppingMinutes'].includes(key)).map(key => [key, context[key]]))
  return { version: 1, intent: normalizeIntent(value.intent), profile,
    destinationInfo: normalizeDestinationInfo(value.destinationInfo, profile.destination), savedAt: date(value.savedAt), socUpdatedAt: date(value.socUpdatedAt) }
}
export function readChargingSettings(storage = browserStorage()) {
  try {
    const raw = storage?.getItem(CHARGING_SETTINGS_KEY)
    if (!raw) return { ...normalizeSettings(), error: storage ? '' : '当前浏览器无法读取长期设置。' }
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('Invalid settings')
    return { ...normalizeSettings(value), error: '' }
  } catch { return { ...normalizeSettings(), error: '已保存的设置无法读取，请在设置中核对并重新保存。' } }
}
export function saveChargingSettings(input, storage = browserStorage(), now = new Date()) {
  try {
    if (!storage) throw new Error('Storage unavailable')
    const previous = readChargingSettings(storage)
    const settings = normalizeSettings(input)
    settings.savedAt = now.toISOString()
    settings.socUpdatedAt = settings.profile.currentSoc === null ? null : input.confirmSoc || previous.profile.currentSoc !== settings.profile.currentSoc
      ? settings.savedAt : previous.socUpdatedAt || settings.savedAt
    storage.setItem(CHARGING_SETTINGS_KEY, JSON.stringify(settings))
    return { ok: true, settings: { ...settings, error: '' } }
  } catch { return { ok: false, error: '设置未能长期保存，请检查浏览器的网站存储权限后重试。当前填写内容仍在页面中。' } }
}
