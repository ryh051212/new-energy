import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

// 由 Git 列出源码，兼顾未暂存、未跟踪和删除文件，不扫描虚拟环境与数据交付包。
export function sourceSnapshot(root) {
  const result = spawnSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'src', 'backend', 'tests', 'scripts', 'package.json', 'package-lock.json',
    'vite.config.js', 'AGENTS.md', '.codex/hooks.json',
  ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`无法读取 Git 源码清单：${result.error?.message || result.stderr}`)
  }

  const files = {}
  const names = [...new Set(result.stdout.split('\0').filter(Boolean))].sort()
  for (const name of names) {
    if (!/\.(js|mjs|cjs|vue|css|py|sql|json)$/.test(name) && name !== 'AGENTS.md') continue
    const absolute = path.join(root, name)
    files[name] = fs.existsSync(absolute)
      ? createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
      : 'deleted'
  }
  return files
}

// 报告先写到临时文件再替换，避免中途退出留下半份 JSON。
export function writeJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(temporary, destination)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

export function runChecks(root, changedFiles) {
  const frontendTests = fs.readdirSync(path.join(root, 'tests/frontend'))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => `tests/frontend/${name}`)
  const tasks = [
    { name: '项目结构', args: ['scripts/checks/check-structure.mjs'] },
    { name: '前端测试', args: ['--test', ...frontendTests] },
    { name: '生产构建', args: ['node_modules/vite/bin/vite.js', 'build'] },
    { name: '后端测试', args: ['scripts/checks/test-backend.mjs'] },
  ]
  const toolingDirectory = path.join(root, 'tests/tooling')
  if (fs.existsSync(toolingDirectory)) {
    const toolingTests = fs.readdirSync(toolingDirectory)
      .filter(name => name.endsWith('.test.mjs'))
      .sort()
      .map(name => `tests/tooling/${name}`)
    if (toolingTests.length) tasks.push({ name: 'Hook 流程测试', args: ['--test', ...toolingTests] })
  }
  const checks = []
  for (const task of tasks) {
    const started = Date.now()
    const result = spawnSync(process.execPath, task.args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n')
    checks.push({
      name: task.name,
      passed: !result.error && result.status === 0,
      exitCode: result.status,
      durationMs: Date.now() - started,
      output,
    })
  }

  const report = {
    checkedAt: new Date().toISOString(),
    passed: checks.every(check => check.passed),
    changedFiles,
    checks,
    review: '自动检查不能判断全部可读性与业务语义；请按 AGENTS.md 复查实际改动。',
  }
  writeJson(path.join(root, '.code-quality/report.json'), report)
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = runChecks(projectRoot, Object.keys(sourceSnapshot(projectRoot)))
    for (const check of report.checks) {
      console.log(`${check.passed ? '通过' : '失败'}：${check.name}`)
      if (!check.passed) console.error(check.output.slice(-8000))
    }
    console.log('检查报告：.code-quality/report.json')
    process.exitCode = report.passed ? 0 : 1
  } catch (error) {
    console.error(`代码检查未完成：${error.message}`)
    process.exitCode = 1
  }
}
