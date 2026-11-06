import { bbox, lineString } from '@turf/turf'
import { toMapCoordinate, toMapGeoJSON } from '../config/basemaps.js'

// 只处理选址地图表现：编号、最近站连线、范围定位与 Marker 释放。
// 候选计算和规划草稿由 planning 模块持有，通过 getState 读取当前快照。
export function useSitingMap({ getMap, getState, signal, Marker, document,
  onCandidate, onStation, onSelection, closePopup, getPadding }) {
  let markers = []

  function clearSitingMarkers() {
    markers.forEach(marker => marker.remove())
    markers = []
  }

  function refreshSitingMap() {
    const map = getMap()
    if (!map || signal.aborted || !map.getSource('pss-siting-context')) return
    clearSitingMarkers()
    const { enabled, selected, rows, basemap, stationsVisible, loading } = getState()
    const features = enabled && selected
      ? [{ ...selected.feature, properties: { ...selected.feature.properties, sitingGeometry: 'area' } }] : []
    if (enabled && selected?.nearestStation && stationsVisible) {
      features.push(lineString([selected.location.geometry.coordinates, selected.nearestStation.geometry.coordinates], { sitingGeometry: 'connection' }))
      features.push({ ...selected.nearestStation, properties: { ...selected.nearestStation.properties, sitingGeometry: 'reference' } })
    }
    map.getSource('pss-siting-context').setData(toMapGeoJSON({ type: 'FeatureCollection', features }, basemap))
    if (map.getLayer('pss-siting-stations')) {
      map.setLayoutProperty('pss-siting-stations', 'visibility', 'none')
    }
    if (!enabled || loading) return
    for (const row of rows) {
      const button = document.createElement('button')
      button.className = 'siting-candidate-marker' + (row.id === selected?.id ? ' selected' : '')
      button.type = 'button'
      button.setAttribute('aria-label', '地图候选 ' + row.rank + '：' + row.areaName)
      button.setAttribute('data-candidate-id', row.id)
      button.title = row.areaName + ' · ' + (row.score == null ? '资料不足' : row.score.toFixed(2) + ' 分')
      const rank = document.createElement('span')
      rank.textContent = String(row.rank)
      button.append(rank)
      button.addEventListener('pointerdown', event => event.stopPropagation())
      button.addEventListener('click', event => { event.stopPropagation(); onCandidate(row.id) })
      markers.push(new Marker({ element: button, anchor: 'center' })
        .setLngLat(toMapCoordinate(row.location.geometry.coordinates, basemap)).addTo(map))
    }
    if (selected?.nearestStation && stationsVisible) {
      const station = selected.nearestStation, label = document.createElement('button')
      label.type = 'button'
      label.className = 'siting-reference-marker'
      label.textContent = '最近已有站 · ' + (station.properties.name || '未命名站点')
      label.title = station.properties.address || station.properties.name
      label.addEventListener('pointerdown', event => event.stopPropagation())
      label.addEventListener('click', event => { event.stopPropagation(); onStation(toMapGeoJSON(station, basemap)) })
      const onRight = station.geometry.coordinates[0] >= selected.location.geometry.coordinates[0]
      markers.push(new Marker({ element: label, anchor: onRight ? 'right' : 'left', offset: [onRight ? -12 : 12, -14] })
        .setLngLat(toMapCoordinate(station.geometry.coordinates, basemap)).addTo(map))
    }
  }

  function showSitingOverview() {
    const map = getMap(), { rows, basemap } = getState()
    if (!map || signal.aborted || !rows.length) return
    closePopup()
    const features = rows.map(row => row.feature)
    map.fitBounds(bbox(toMapGeoJSON({ type: 'FeatureCollection', features }, basemap)), { padding: getPadding(), maxZoom: 14, duration: 500 })
  }

  function focusSitingGrid(feature) {
    const map = getMap()
    if (!map || !feature || signal.aborted) return
    const id = String(feature.properties.id)
    onSelection(id)
    const { rows, basemap } = getState(), row = rows.find(item => item.id === id)
    if (!row) return
    closePopup()
    const features = [row.feature, ...(row.nearestStation ? [row.nearestStation] : [])]
    map.fitBounds(bbox(toMapGeoJSON({ type: 'FeatureCollection', features }, basemap)), { padding: getPadding(), maxZoom: 15, duration: 500 })
    refreshSitingMap()
  }

  return { clearSitingMarkers, refreshSitingMap, showSitingOverview, focusSitingGrid }
}
