import { ref } from 'vue'
import { toMapCoordinate } from '../config/basemaps.js'

// 每次调用创建独立实例；由 MapView 在卸载前调用清理方法。
export function useMapLocation({ getMap, activeBasemap, signal, Marker, platform = globalThis, getOffset = () => [0,0], onNotice = () => {}, onLocated = () => {} }) {
  let userMarker = null

  let userLocation = null

  const locating = ref(false);

  const locationError = ref('');

  function locateUser(forSimulation = false) {
    const map = getMap()
    if (!map || locating.value || signal.aborted) return
    locationError.value = ''
    onNotice()
    if (platform.isSecureContext === false) {
      locationError.value = '请通过 HTTPS 或 localhost 打开页面后使用定位'
      return
    }
    if (!platform.navigator.geolocation) {
      locationError.value = '当前浏览器不支持定位'
      return
    }
  
    locating.value = true
    try {
      platform.navigator.geolocation.getCurrentPosition(
        (position) => {
          if (signal.aborted) return
          locating.value = false
          // 浏览器获得的是 WGS84，显示时再转换成当前底图坐标。
          const { longitude, latitude } = position.coords
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
            locationFailed({ code: 2 })
            return
          }
          userLocation = [longitude, latitude]
          const coordinate = toMapCoordinate(userLocation, activeBasemap.value)
          if (!userMarker) userMarker = new Marker().setLngLat(coordinate).addTo(map)
          else userMarker.setLngLat(coordinate)
          map.flyTo({ center: coordinate, zoom: 15, offset: getOffset() })
          onLocated(userLocation, forSimulation)
        },
        locationFailed,
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      )
    } catch (error) {
      locationFailed(error)
    }
  }

  function locationFailed(error) {
    if (signal.aborted) return
    locating.value = false
    locationError.value = error.code === 1 || error.name === 'SecurityError'
      ? '请在浏览器中允许位置权限，再点击定位'
      : error.code === 3 ? '定位超时，请重新点击定位' : '暂时无法定位，请稍后重试'
  }

  function updateLocationMarker(basemap) { if (userLocation) userMarker?.setLngLat(toMapCoordinate(userLocation, basemap)) }

  function disposeLocation() { locating.value = false; userMarker?.remove() }

  return { locating, locationError, locateUser, locationFailed, getUserLocation: () => userLocation, updateLocationMarker, disposeLocation }
}
