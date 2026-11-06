import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const errors = []
function filesIn(relative) {
  const files = []
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
  for (const entry of entries) {
    const name = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) {
      files.push(...filesIn(name))
    } else if (/\.(vue|js|mjs|css)$/.test(name)) {
      files.push(name)
    }
  }
  return files
}
let checked = 0
for (const file of ['src', 'tests/frontend', 'scripts'].flatMap(filesIn)) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const references = [...text.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"]+)\1/g)]
  for (const match of references) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2].split('?')[0]))
    checked++
    if (!fs.existsSync(path.join(root, target))) errors.push(`${file}: unresolved import ${match[2]}`)
    if ((file.startsWith('src/features/') || file === 'src/App.vue') && target.startsWith('src/legacy/')) {
      errors.push(`${file}: active application imports archived code ${target}`)
    }
  }
  // 动态测试文件路径只检查首次插值之前的固定前缀。
  for (const match of text.matchAll(/new URL\(\s*(['"`])(\.{1,2}\/.*?)\1\s*,\s*import\.meta\.url/gs)) {
    const relative = match[2].split('${')[0]
    const target = path.resolve(root, path.dirname(file), relative)
    checked++
    if (!fs.existsSync(target)) errors.push(`${file}: unresolved URL prefix ${relative}`)
  }
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`PASS ${checked} relative imports and file URL references; active code does not import legacy pages.`)
}
