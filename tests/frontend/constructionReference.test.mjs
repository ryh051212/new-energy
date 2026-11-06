import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { area, booleanPointInPolygon, point } from '@turf/turf'
import { constructionReferenceDrawing, GRADE_LABELS, powerVoltageLabel } from '../../src/features/map/models/constructionReference.js'

const data = JSON.parse(fs.readFileSync(new URL('../../data/processed/weidu-construction-reference.json', import.meta.url), 'utf8'))

test('参考图保留7条变电站和3条变压器的独立类型与原始坐标，不把浏览编号当作名称', () => {
  const original = structuredClone(data)
  const drawing = constructionReferenceDrawing(data)
  assert.equal(drawing.substations.length, 7)
  assert.equal(drawing.transformers.length, 3)
  for (const station of [...drawing.substations, ...drawing.transformers]) {
    const source = data.power.features.find(feature => feature.properties.id === station.id)
    assert.deepEqual(station.coordinates, source.geometry.coordinates)
    assert.ok(station.position.every(Number.isFinite))
    assert.equal(station.name, source.properties.name)
  }
  assert.deepEqual(data, original)
})

test('价格与草案边界保留不同来源和日期，缺少实际场租与可接入余量时不补值', () => {
  assert.equal(data.metadata.boundaryStatus, 'draft_georeferenced')
  assert.equal(data.metadata.gradeBoundaryDate, '2024-01-30')
  assert.equal(data.metadata.priceTableDate, '2024-04-11')
  assert.deepEqual(data.zones.features.map(zone => zone.properties.annualRentReference), [193, 123, 85, 61, 50, 41, 34])
  assert.deepEqual(data.zones.features.map(zone => zone.properties.landPriceReference), [4350, 3000, 2190, 1680, 1410, 1200, 1050])
  for (const station of data.power.features) assert.equal(station.properties.availableKva, undefined)
  for (const zone of data.zones.features) assert.equal(zone.properties.actualSiteRent, undefined)
})

test('分区标签在本分区内部，数字化区域不扩张成完整行政区或填补未知区', () => {
  const coveredArea = area(data.zones)
  assert.ok(coveredArea < area(data.boundary))
  assert.ok(coveredArea > area(data.boundary) * 0.9)
  for (const zone of data.zones.features) {
    assert.ok(booleanPointInPolygon(point(zone.properties.labelCoordinates), zone))
    assert.ok(data.boundary.features.some(boundary => booleanPointInPolygon(point(zone.properties.labelCoordinates), boundary)))
  }
})

test('拒绝未确认坐标系，电压转换保留多电压和未知信息', () => {
  assert.throws(() => constructionReferenceDrawing({ ...data, metadata: { coordSystem: 'GCJ-02' } }), /WGS84/)
  assert.equal(powerVoltageLabel('220000;110000'), '220 / 110 kV')
  assert.equal(powerVoltageLabel(null), '电压待核实')
  assert.equal(powerVoltageLabel('unknown'), '电压待核实')
})

test('真实页面首次渲染即展示红色分区、7个蓝色编号以及草案和价格单位说明', async () => {
  const source = fs.readFileSync(new URL('../../src/features/map/components/ConstructionReferenceMap.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const compiled = compileScript(descriptor, { id: 'construction-reference-test', inlineTemplate: true, genDefaultAs: 'component' })
  const code = compiled.content
    .replace(/^import\s+\{([^}]+)\}\s+from\s+['"]vue['"];?\s*$/gm, (_, names) => `const {${names.replace(/\bas\b/g, ':')}}=Vue;`)
    .replace(/^import[^\r\n]+\r?\n/gm, '')
  const component = vm.runInNewContext(`${code}\ncomponent`, { Vue, data, constructionReferenceDrawing, GRADE_LABELS, powerVoltageLabel })
  const html = await renderToString(Vue.createSSRApp(component))
  assert.equal((html.match(/>S0[1-7]<\/text>/g) || []).length, 7)
  assert.match(html, /fill="#1173df"/)
  assert.match(html, /stroke="#d94444"/)
  assert.match(html, /征求意见稿/)
  assert.match(html, /元\/㎡·年/)
  assert.match(html, /最终级别待核实/)
})
