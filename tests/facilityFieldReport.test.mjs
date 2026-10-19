import test from 'node:test'
import assert from 'node:assert/strict'
import { facilityReviewCsv } from '../src/utils/facilityFieldReport.js'

test('核查清单保留命名地点与已记录站点，未知留空，排除代表点和虚拟站，转义文本与公式', () => {
  const feature = properties => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [113, 34] }, properties })
  const csv = facilityReviewCsv({ evaluation: {
    locations: { features: [feature({ name: '=不应执行', address: '测试,"地址"', locationStatus: 'improved', beforeMatch: null, afterMatch: 5, category: 'residential' }),
      feature({ name: '代表点', fallback: true })] },
    stationReview: { features: [feature({ name: '真实站', reviewStatus: 'unknown', capacitySimulated: true }), feature({ name: '虚拟站', isSynthetic: true })] },
  } })
  assert.ok(csv.startsWith('\uFEFF'))
  assert.equal(csv.split('\r\n').length, 3)
  assert.ok(csv.includes("\"'=不应执行\""))
  assert.ok(csv.includes('"测试,""地址"""'))
  assert.ok(csv.includes('能力资料不足'))
  assert.ok(csv.includes('能力含演示参数'))
  assert.ok(!csv.includes('代表点'))
  assert.ok(!csv.includes('虚拟站'))
})
