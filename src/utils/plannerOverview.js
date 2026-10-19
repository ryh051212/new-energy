import { facilityCandidates } from './facilityLayout.js'

export const planningQuadrants = [
  { id: 'high-demand-low-supply', label: '需求较高 · 站点较少', color: '#dc2626' },
  { id: 'high-demand-high-supply', label: '需求较高 · 站点较多', color: '#f59e0b' },
  { id: 'low-demand-high-supply', label: '需求较低 · 站点较多', color: '#2563eb' },
  { id: 'low-demand-low-supply', label: '需求较低 · 站点较少', color: '#d1d5db' },
]

// Empty/unavailable grids are not evidence of zero coverage. Unknown categories
// retain their own share rather than being redistributed into the four quadrants.
export function summarizePlanningGrid(features) {
  const grid = Array.isArray(features) ? features : []
  const hasGrid = grid.length > 0
  const knownCounts = hasGrid && grid.every(f => Number.isInteger(f.properties?.stationCount) && f.properties.stationCount >= 0)
  const occupied = knownCounts ? grid.filter(f => f.properties.stationCount > 0).length : null
  const quadrants = planningQuadrants.map(item => ({ ...item,
    count: hasGrid ? grid.filter(f => f.properties?.supplyDemandType === item.id).length : null,
  }))
  return { gridCount: hasGrid ? grid.length : null, occupied,
    occupiedShare: occupied == null ? null : occupied / grid.length * 100,
    quadrants, unclassified: hasGrid ? grid.length - quadrants.reduce((sum, item) => sum + item.count, 0) : null,
    candidates: facilityCandidates(grid),
  }
}
