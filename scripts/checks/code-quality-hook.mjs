import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceSnapshot, runChecks, writeJson } from './code-quality.mjs'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

export function handleStop(input, root = projectRoot) {
  if (input.hook_event_name !== 'Stop') return {}

  const statePath = path.join(root, '.code-quality/state.json')
  let previous = {}
  if (fs.existsSync(statePath)) {
    try {
      previous = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } catch {
      // 本地缓存损坏时重新验证源码，不把缓存错误当作通过。
      previous = {}
    }
  }

  const files = sourceSnapshot(root)
  const changedFiles = [...new Set([...Object.keys(previous.files || {}), ...Object.keys(files)])]
    .filter(name => previous.files?.[name] !== files[name])
  if (!changedFiles.length && previous.passed) return {}

  const report = runChecks(root, changedFiles)
  writeJson(statePath, { files, passed: report.passed })

  // Stop 续轮最多请求一次，避免环境故障或已有失败使会话无限自我续写。
  if (input.stop_hook_active) {
    if (report.passed) return {}
    return { systemMessage: '代码检查仍有失败，请如实告知用户，并查看 .code-quality/report.json；本轮不再自动续写。' }
  }

  const failedChecks = report.checks.filter(check => !check.passed).map(check => check.name)
  const reason = [
    '本轮代码已变更，请完成一次收尾复查再回复用户。',
    '阅读 AGENTS.md 和 .code-quality/report.json，只检查实际变更；展开复杂表达式、保持命名清晰、中文注释，保留接口、公式、缺失值语义、异步取消与资源清理。',
    report.passed ? '自动检查已通过；发现可安全改善的可读性问题就直接修正，否则无需改动。' : `检查失败：${failedChecks.join('、')}。定位并修复本轮问题，区分已有失败或环境限制，不降低检查标准。`,
    '修改后运行 npm run quality，并简要汇报完整文件位置、修改原因、验证结果和兼容性风险；不要无限循环复查。',
  ].join('\n')
  return { decision: 'block', reason }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'))
    console.log(JSON.stringify(handleStop(input)))
  } catch (error) {
    // 输出遵循 Stop 的 JSON 协议，执行错误也不能伪装为静默成功。
    console.log(JSON.stringify({ systemMessage: `代码收尾 hook 执行失败：${error.message}` }))
    process.exitCode = 1
  }
}
