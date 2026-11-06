import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const candidates = process.platform === 'win32'
  ? ['backend/.venv/Scripts/python.exe', 'backend/venv312/Scripts/python.exe', '.venv/Scripts/python.exe']
  : ['backend/.venv/bin/python', '.venv/bin/python']
const local = candidates.find(candidate => fs.existsSync(path.join(root, candidate)))
let python = process.platform === 'win32' ? 'python' : 'python3'
if (local) python = path.join(root, local)

// 兼顾既有回归测试与新基础数据测试；一个目录失败后仍检查另一个目录。
let exitCode = 0
for (const directory of ['tests/backend', 'backend/tests']) {
  if (!fs.existsSync(path.join(root, directory))) continue
  const result = spawnSync(python, [
    '-X', 'utf8', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py', '-q', '-b',
  ], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) exitCode = result.status ?? 1
}
process.exitCode = exitCode
