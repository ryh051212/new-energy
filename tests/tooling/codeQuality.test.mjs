import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { sourceSnapshot, runChecks } from '../../scripts/checks/code-quality.mjs'
import { handleStop } from '../../scripts/checks/code-quality-hook.mjs'

function fixture(context, buildExitCode = 0) {
  const temporaryDirectory = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'weidu-quality-test-'))
  context.after(() => {
    // 只清理本测试在临时目录内创建的独立项目。
    assert.equal(path.dirname(root), temporaryDirectory)
    assert.ok(path.basename(root).startsWith('weidu-quality-test-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const files = {
    '.gitignore': '.code-quality/\nnode_modules/\n',
    'package.json': '{"type":"module"}',
    'src/sample.js': 'export const value = 1\n',
    'tests/frontend/smoke.test.mjs': "import test from 'node:test'; test('正常执行', () => {})\n",
    'scripts/checks/check-structure.mjs': 'process.exit(0)\n',
    'scripts/checks/test-backend.mjs': 'process.exit(0)\n',
    'node_modules/vite/bin/vite.js': `process.exit(${buildExitCode})\n`,
  }
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(root, name)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, content)
  }
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true })
  assert.equal(initialized.status, 0)
  return root
}

test('源码快照识别未跟踪修改和删除，不把本地报告与数据作为源码', context => {
  const root = fixture(context)
  const first = sourceSnapshot(root)
  fs.writeFileSync(path.join(root, 'src/sample.js'), 'export const value = 2\n')
  assert.notEqual(sourceSnapshot(root)['src/sample.js'], first['src/sample.js'])
  const staged = spawnSync('git', ['add', 'src/sample.js'], { cwd: root, windowsHide: true })
  assert.equal(staged.status, 0)
  fs.unlinkSync(path.join(root, 'src/sample.js'))
  assert.equal(sourceSnapshot(root)['src/sample.js'], 'deleted')
  fs.mkdirSync(path.join(root, '.code-quality'))
  fs.writeFileSync(path.join(root, '.code-quality/report.json'), '{}')
  assert.deepEqual(Object.keys(sourceSnapshot(root)).filter(name => name.startsWith('.code-quality')), [])
})

test('代码变化触发检查和一次复查，未变代码不重写报告', context => {
  const root = fixture(context)
  const first = handleStop({ hook_event_name: 'Stop', stop_hook_active: false }, root)
  assert.equal(first.decision, 'block')
  assert.match(first.reason, /AGENTS.md/)
  const reportPath = path.join(root, '.code-quality/report.json')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.passed, true)
  assert.equal(report.checks.length, 4)
  assert.ok(report.changedFiles.includes('src/sample.js'))
  const originalReport = fs.readFileSync(reportPath, 'utf8')
  assert.deepEqual(handleStop({ hook_event_name: 'Stop', stop_hook_active: true }, root), {})
  assert.equal(fs.readFileSync(reportPath, 'utf8'), originalReport)

  fs.writeFileSync(path.join(root, 'src/sample.js'), 'export const value = 3\n')
  assert.equal(handleStop({ hook_event_name: 'Stop' }, root).decision, 'block')
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')).changedFiles, ['src/sample.js'])
})

test('构建失败保留完整失败记录，续轮不无限触发 Stop', context => {
  const root = fixture(context, 1)
  const result = handleStop({ hook_event_name: 'Stop', stop_hook_active: true }, root)
  assert.equal(result.decision, undefined)
  assert.match(result.systemMessage, /仍有失败/)
  const report = JSON.parse(fs.readFileSync(path.join(root, '.code-quality/report.json'), 'utf8'))
  assert.equal(report.passed, false)
  assert.equal(report.checks.find(check => check.name === '生产构建').exitCode, 1)
  assert.equal(report.checks.find(check => check.name === '后端测试').passed, true)
})

test('缓存损坏重新检查；非 Stop 事件不创建文件', context => {
  const root = fixture(context)
  assert.deepEqual(handleStop({ hook_event_name: 'PostToolUse' }, root), {})
  assert.equal(fs.existsSync(path.join(root, '.code-quality')), false)
  fs.mkdirSync(path.join(root, '.code-quality'))
  fs.writeFileSync(path.join(root, '.code-quality/state.json'), '损坏的缓存')
  assert.equal(handleStop({ hook_event_name: 'Stop' }, root).decision, 'block')
})

test('手动检查每次都会运行并汇总所有检查', context => {
  const root = fixture(context)
  const report = runChecks(root, ['src/sample.js'])
  assert.equal(report.passed, true)
  assert.ok(report.checks.every(check => check.exitCode === 0))
})
