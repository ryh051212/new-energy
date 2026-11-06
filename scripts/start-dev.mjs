import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
const python = path.join(root, process.platform === 'win32'
  ? 'backend/.venv/Scripts/python.exe'
  : 'backend/.venv/bin/python')
const children = []
let stopping = false

// 两个服务属于同一次启动，退出或启动失败时一起释放。
function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill()
}

function start(command, args, name) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  children.push(child)
  child.on('error', error => {
    console.error(`${name}启动失败：${error.message}`)
    stop(1)
  })
  child.on('exit', code => {
    if (stopping) return
    console.error(`${name}已退出。`)
    stop(code || 1)
  })
  return child
}

async function main() {
  if (!fs.existsSync(python) || !fs.existsSync(path.join(root, 'node_modules/vite/bin/vite.js'))) {
    throw new Error('请先按 README 的协作启动说明安装前后端依赖。')
  }
  if (!fs.existsSync(path.join(root, 'backend/.env.local'))) {
    throw new Error('请先复制 backend/.env.example 为 backend/.env.local，填写本机数据库与登录配置。')
  }

  // 后端验证端口归属及数据库连通后再打开网页，避免只看到空页面。
  for (const port of [8000, 5173]) {
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(new Error(`端口 ${port} 已被占用，请关闭旧服务后重试。`)))
      server.listen(port, '127.0.0.1', () => server.close(resolve))
    })
  }

  const backend = start(python, ['-m', 'uvicorn', 'backend.api.main:app', '--host', '127.0.0.1', '--port', '8000'], '后端')
  for (let attempt = 0; attempt < 60; attempt++) {
    if (stopping || backend.exitCode !== null) return
    let ready = false
    try {
      const response = await fetch('http://127.0.0.1:8000/api/boundary', {
        signal: AbortSignal.timeout(1000),
      })
      const data = response.ok ? await response.json() : null
      ready = data?.features?.length > 0
    } catch {
      // 服务导入和数据库连接尚未完成时，短暂等待后重试。
    }
    if (stopping) return
    if (ready) {
      start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort', '--open'], '前端')
      console.log('网站地址：http://127.0.0.1:5173；按 Ctrl+C 同时停止前后端。')
      return
    }
    await setTimeout(500)
  }
  throw new Error('后端未就绪：请检查 backend/.env.local、PostgreSQL 服务及数据库初始化步骤。')
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
if (process.platform === 'win32') process.on('SIGBREAK', () => stop())
main().catch(error => {
  console.error(error.message)
  stop(1)
})
