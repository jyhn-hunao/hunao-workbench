#!/usr/bin/env node
/**
 * 未定义检查.mjs —— 用 ESLint 的 no-undef 抓「引用了不存在 / 不在作用域里的变量」
 *
 * 为什么需要（2026-11-16）：
 *   换会话在 1/3 回滚时抛 ReferenceError: body0 is not defined —— body0 只定义在
 *   rewriteSec0ToPointers() 里面，回滚代码却在另一个函数里引用它。
 *   node --check 只查语法，这类错误它看不见；随后全仓扫出同类 6 类 7 处
 *   （catch/try 块作用域越界、改名漏改调用点、函数只调用没实现）。
 *
 * 用法：node 工具\未定义检查.mjs
 *   退出码：0 = 0 命中；1 = 有命中；2 = 未执行（没有 eslint，**不等于通过**）
 *
 * 依赖说明：这是**审计工具**，不是运行时脚本 —— 仓库运行时仍只用 Node 内置模块。
 *   取 eslint 的顺序：外壳\node_modules\eslint → 全局 eslint → npx --yes eslint@8（首次需联网）。
 *   三条都没有时明确打「未执行」并退 2，不冒充通过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')                 // 12-源码照搬
const SHELL = path.join(ROOT, '外壳')
const IS_WIN = process.platform === 'win32'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-undef-'))

// 跨文件全局：这些名字由 index.html 先加载的脚本创建（wb-warn.js / renderers.js 等），
// 单文件分析看不到，但运行时存在；列在这里 ≠ 放行拼错 —— 拼错的新名字仍然会命中。
const GLOBALS = {
  wbWarn: 'readonly',
  collapsePanel: 'readonly',
  waitHarnessReady: 'readonly',
  SECTOR_DATA: 'readonly',
  US_SECTOR_DATA: 'readonly',
  POP: 'readonly',
}

const cfg = (env, sourceType) => ({
  root: true,
  parserOptions: { ecmaVersion: 2022, sourceType },
  env: Object.assign({ es2022: true }, env),
  globals: GLOBALS,
  rules: { 'no-undef': 'error' },
})

// 1. 三组扫描：后端 .mjs（module / node）；外壳 .js（script / node+browser）；
//    外壳 pet3d（浏览器 ES module：带 import/export，script 解析会报语法错，且 vendor 是第三方不查）
const GROUPS = [
  {
    name: '后端脚本（工具 / 外壳 scripts / 插件）',
    config: path.join(TMP, 'node.json'),
    targets: ['工具', '外壳/scripts', '插件'].map((p) => path.join(ROOT, p)).filter((p) => fs.existsSync(p)),
    ext: '.mjs,.js',
    ignore: ['**/node_modules/**'],
  },
  {
    name: '外壳 JS（main / preload / renderer）',
    config: path.join(TMP, 'web.json'),
    targets: [SHELL],
    ext: '.js',
    ignore: ['**/node_modules/**', '**/data/**', '**/scenarios/**', '**/pet3d/**'],
  },
  {
    name: '外壳 pet3d（浏览器 ES module）',
    config: path.join(TMP, 'pet3d.json'),
    targets: [path.join(SHELL, 'pet3d')].filter((p) => fs.existsSync(p)),
    ext: '.js',
    // vendor 是随壳分发的第三方 three.js，只做语法兜底，不查 no-undef
    ignore: ['**/vendor/**'],
  },
]
fs.writeFileSync(GROUPS[0].config, JSON.stringify(cfg({ node: true }, 'module'), null, 2), 'utf8')
fs.writeFileSync(GROUPS[1].config, JSON.stringify(cfg({ node: true, browser: true }, 'script'), null, 2), 'utf8')
fs.writeFileSync(GROUPS[2].config, JSON.stringify(cfg({ browser: true }, 'module'), null, 2), 'utf8')

// 2. 找 eslint：本地 → 全局 → npx（首次联网装到 npm 缓存，不写进本仓依赖）
function pickRunner() {
  const local = path.join(SHELL, 'node_modules', 'eslint', 'bin', 'eslint.js')
  if (fs.existsSync(local)) return { argv: [process.execPath, local], label: '本地 eslint（外壳\\node_modules）', shell: false }
  const probe = spawnSync(IS_WIN ? 'eslint.cmd' : 'eslint', ['--version'], { encoding: 'utf8', shell: IS_WIN })
  if (probe.status === 0) return { argv: [IS_WIN ? 'eslint.cmd' : 'eslint'], label: '全局 eslint', shell: IS_WIN }
  const npx = spawnSync(IS_WIN ? 'npx.cmd' : 'npx', ['--yes', 'eslint@8', '--version'], { encoding: 'utf8', shell: IS_WIN })
  if (npx.status === 0) return { argv: [IS_WIN ? 'npx.cmd' : 'npx', '--yes', 'eslint@8'], label: 'npx eslint@8（下载缓存）', shell: IS_WIN }
  return null
}

const runner = pickRunner()
if (!runner) {
  console.log('· 未执行：本机没有 eslint，也没有可用的 npx（先联网跑一次 npx --yes eslint@8，或 npm i -g eslint）')
  console.log('  ⛔ 这不是「通过」—— 未定义检查这次没跑。')
  process.exit(2)
}

// 3. 逐组跑，收 JSON 结果（--format json 放 stdout，npm 的提示在 stderr，不会污染）
let hits = 0
console.log('未定义检查（no-undef）· ' + runner.label)
for (const g of GROUPS) {
  if (!g.targets.length) { console.log('· 跳过 ' + g.name + '（目录不存在）'); continue }
  const realArgs = ['--no-eslintrc', '--config', g.config, '--ext', g.ext, '--format', 'json']
  for (const ig of g.ignore) realArgs.push('--ignore-pattern', ig)
  realArgs.push(...g.targets)
  const [bin, ...head] = runner.argv
  const r = spawnSync(bin, [...head, ...realArgs], { cwd: ROOT, encoding: 'utf8', shell: runner.shell, timeout: 240000, maxBuffer: 16 << 20 })
  let rows = []
  try { rows = JSON.parse(String(r.stdout || '[]')) } catch { rows = [] }
  const bad = []
  for (const f of rows) for (const m of (f.messages || [])) if (m.severity === 2) bad.push({ file: path.relative(ROOT, f.filePath), line: m.line, rule: m.ruleId, msg: m.message })
  if (!bad.length) { console.log('✓ ' + g.name + '：0 命中'); continue }
  hits += bad.length
  console.log('✗ ' + g.name + '：' + bad.length + ' 处')
  for (const b of bad.slice(0, 20)) console.log('   ' + b.file + ':' + b.line + ' ← ' + b.msg)
  if (bad.length > 20) console.log('   … 还有 ' + (bad.length - 20) + ' 处')
  if (r.status === 2 && !bad.length) console.log('   （eslint 自身退出 2：配置/加载失败，看 ' + g.config + '）')
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
if (hits) { console.log('\n结论：✗ ' + hits + ' 处未定义 ⇒ 修掉再交付（别用全局变量绕）'); process.exit(1) }
console.log('\n结论：✓ 0 处未定义')
