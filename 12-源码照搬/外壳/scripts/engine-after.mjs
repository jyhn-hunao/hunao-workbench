// engine-after.mjs —— 引擎升级后的接线核对（只读，不启服务、不改配置）
// 为什么要有：壳是围绕引擎的**内部实现**做的（patch 覆盖项 / 插件落点 / 会话目录 / 产物入口）。
//   上游一改，壳不会崩，但会**静默降级**：工具没挂上、插件不生效、面板空白，而"引擎起来了"看着像成功。
// 判据：全部只读；有 ✗ 就退出 1（check-gui 的第 11 项直接复用本脚本，输出行首 ✓/✗/! 就是它的判据）。
//
// 用法：node 12-源码照搬\外壳\scripts\engine-after.mjs [--json]
//   --json：给机器读（含每项 ok/warn/fail 与证据），人看不便。
// 前置：引擎目录与工作台同级（引擎\）；DSH_CUSTOMER_HOME 没设时按 引擎数据\.dsh 认。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nodeExe as pickNode } from '../../工具/环境.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))          // 外壳\scripts
const SHELL = path.dirname(HERE)                                   // 外壳
const ROOT = path.dirname(SHELL)                                   // 12-源码照搬
const ENGINE = path.join(ROOT, '引擎')
const DSH_HOME = process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh')
const PROFILE = path.join(DSH_HOME, 'profiles', 'web')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')

const rows = []
const ok = (t) => rows.push({ level: 'ok', text: t })
const warn = (t) => rows.push({ level: 'warn', text: t })
const bad = (t) => rows.push({ level: 'fail', text: t })
const exists = (p) => { try { return fs.existsSync(p) } catch (e) { return false } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

// 0. 用哪个 node 跑 dump-config：与 自检.mjs / main.js 同口径（机器配置.json 的 nodeExe 优先），
//    别让"PATH 里的低版本 node"把 dump-config 的结论与 Node 判断一起带偏（2026-11-14 踩过一次）。
let NODE = process.execPath
let NODE_NOTE = '本进程'
try {
  const n = pickNode()
  if (n && exists(n)) { NODE = n; NODE_NOTE = '机器配置 nodeExe' }
} catch (e) {
  NODE_NOTE = '按 机器配置 取 node 失败（' + ((e && e.message) || e) + '）→ 退回本进程'
}
const nodeVer = (() => { const r = spawnSync(NODE, ['-v'], { encoding: 'utf8' }); return String(r.stdout || '').trim().replace(/^v/, '') })()

// 1. 引擎目录与版本
if (!exists(ENGINE)) {
  bad('引擎目录不在：' + ENGINE + '（换机器后先把 引擎\ 放回与 外壳\ 同级）')
} else {
  const pkg = readJson(path.join(ENGINE, 'package.json'))
  if (pkg && pkg.version) ok('引擎目录在位，版本 ' + pkg.version)
  else bad('引擎 package.json 缺失或读不出 version')
}

// 2. CLI 入口（壳启动计划里两套布局都认，缺一套就是兜底失效）
const cliBuilt = path.join(ENGINE, 'lib', 'bin.js')                  // 打包版
const cliSource = path.join(ENGINE, 'apps', 'cli', 'lib', 'bin.js')  // 源码版
if (exists(cliBuilt)) ok('CLI 入口：打包版 引擎\\lib\\bin.js 在位')
else if (exists(cliSource)) ok('CLI 入口：源码版 引擎\\apps\\cli\\lib\\bin.js 在位')
else bad('两套 CLI 入口都不在（引擎包没解全）')

// 3. 上游锚点（壳直接依赖的包；少一个就说明包结构变了，要看 doc\引擎升级与版本兼容清单.md §一）
const ANCHORS = ['dsh-base', 'dsh-web-app', 'dsh-session', 'dsh-client-ui-cordis', 'dsh-app-boot']
{
  const nm = path.join(ENGINE, 'node_modules', '@deepseek-ai')
  const missing = ANCHORS.filter((n) => !exists(path.join(nm, n)))
  if (!missing.length) ok('上游锚点 ' + ANCHORS.length + ' 个都在（' + ANCHORS.join(' / ') + '）')
  else bad('上游锚点缺失：' + missing.join(' / ') + ' → 包结构变了，先看兼容清单 §一 再改壳')
}

// 4. 数据目录（会话 / 场景记忆 / patch 都在这份 home 下；换机器后最容易指错）
if (!exists(DSH_HOME)) bad('引擎 home 不在：' + DSH_HOME)
else {
  const need = [['sessions', '会话目录'], ['场景记忆', '场景记忆目录'], [path.join('profiles', 'web', 'cordis.patch.yml'), 'web profile 的 cordis.patch.yml']]
  const miss = need.filter(([p]) => !exists(path.join(DSH_HOME, p)))
  if (!miss.length) ok('引擎 home 结构齐全（sessions / 场景记忆 / profiles\\web\\cordis.patch.yml）')
  else bad('引擎 home 缺：' + miss.map((x) => x[1]).join(' / '))
}

// 5. 私有插件接线：源在 12-源码照搬\插件\，装到 profiles\web\node_modules\，再在 patch 里登记
//    ⚠ 三种状态要分开看（判据不同）：
//      装了 + 登记了 = 生效（✓）；装了但没登记 = 用户自己关掉了（! 提醒，不是故障）；
//      登记了但没装 = 启动时会报加载失败（✗）；两者都没有 = 从没装过（! 提醒）。
{
  const srcDir = path.join(ROOT, '插件')
  const instDir = path.join(PROFILE, 'node_modules')
  if (!exists(srcDir)) warn('没有 插件\\ 目录（私有插件一个都没带）')
  else {
    const dirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    const wired = []
    const off = []
    const broken = []
    const absent = []
    const notPkg = []
    for (const d of dirs) {
      const pj = readJson(path.join(srcDir, d.name, 'package.json'))
      if (!pj || !pj.name) { notPkg.push(d.name); continue }
      const installed = exists(path.join(instDir, pj.name))
      const inPatch = exists(PATCH) && fs.readFileSync(PATCH, 'utf8').includes(pj.name)
      if (installed && inPatch) wired.push(pj.name)
      else if (installed && !inPatch) off.push(pj.name)
      else if (!installed && inPatch) broken.push(pj.name)
      else absent.push(pj.name)
    }
    if (wired.length) ok('私有插件已接线：' + wired.join(' / '))
    if (broken.length) bad('patch 登记了但没装（启动会报加载失败）：' + broken.join(' / '))
    for (const n of off) warn('已安装但未登记（当前是关的，要开跑 工具\\守卫开关.mjs --on 之类）：' + n)
    if (absent.length) warn('没装也没登记（未启用）：' + absent.join(' / '))
    // 没有 package.json 的目录多半是"只读调研"，不算失败（2026-11-14 实测 社交通道 就是这种）
    if (notPkg.length) warn('这些目录没有 package.json（当文档看，不算插件）：' + notPkg.join(' / '))
  }
}

// 6. patch 覆盖项是否真的命中（升级后最典型的静默降级：写了 id 但引擎里没有这个 entry）
//    判据：dump-config 输出里的 `patch: entry "…" not found` 行数必须为 0。
{
  const cli = exists(cliBuilt) ? cliBuilt : cliSource
  if (!exists(cli)) warn('没有 CLI 入口，跳过 patch 命中核对')
  else {
    const r = spawnSync(NODE, [cli, 'web', '--dump-config'], {
      cwd: ENGINE, encoding: 'utf8', timeout: 120000,
      env: Object.assign({}, process.env, { DSH_HOME }),
    })
    const out = String(r.stdout || '') + String(r.stderr || '')
    if (r.error || r.status === null) warn('dump-config 没跑起来（' + ((r.error && r.error.message) || '超时') + '），patch 命中未核')
    else {
      const notFound = out.split(/\r?\n/).filter((l) => /not found/i.test(l)).map((l) => l.trim())
      if (r.status !== 0) bad('dump-config 退出码 ' + r.status + '（引擎配置树本身就起不来）')
      else if (notFound.length) {
        bad('patch 有 ' + notFound.length + ' 条没命中（写了 id 但引擎里没有这个 entry）')
        for (const l of notFound.slice(0, 8)) rows.push({ level: 'note', text: l })
      } else ok('patch 覆盖项全部命中（not found = 0；dump-config 返回 ' + out.split(/\r?\n/).length + ' 行）')
    }
  }
}

// 7. 适配版本：壳里写死的"已验证引擎版本"必须与真引擎一致，否则顶栏会转琥珀色（那是提醒，不是故障）
{
  const rj = path.join(SHELL, 'renderer', 'renderers.js')
  let adapted = ''
  try { adapted = (fs.readFileSync(rj, 'utf8').match(/var\s+ADAPTED_ENGINE\s*=\s*'([^']+)'/) || [])[1] || '' } catch (e) { adapted = '' }
  const pkg = readJson(path.join(ENGINE, 'package.json'))
  const real = (pkg && pkg.version) || '?'
  if (!adapted) bad('renderer\\renderers.js 里没有 ADAPTED_ENGINE（升级后就没人对账了）')
  else if (adapted === real) ok('适配版本一致：' + adapted)
  else {
    warn('适配版本不一致：壳写的是 ' + adapted + '，引擎实际 ' + real
      + ' ⇒ 同批改四处（引擎\\package.json、外壳\\package.json、renderers.js 的 ADAPTED_ENGINE、12-源码照搬\\README.md）')
  }
}

// 8. Node 版本（引擎要 >=24.9；用低版本跑 dump-config 得到的结论不可信）
{
  const major = Number(String(nodeVer).split('.')[0])
  const minor = Number(String(nodeVer).split('.')[1])
  if (!nodeVer) warn('取不到 node 版本（' + NODE + '）')
  else if (major >= 25 || (major === 24 && minor >= 9)) ok('Node ' + nodeVer + '（来源：' + NODE_NOTE + '；满足引擎 >=24.9 <25）')
  else warn('Node ' + nodeVer + '（来源：' + NODE_NOTE + '）不在 >=24.9 <25 区间 ⇒ 在 机器配置.json 里指一个 24.x 的 nodeExe')
}

// ---- 输出 ----
if (process.argv.includes('--json')) {
  const fails = rows.filter((r) => r.level === 'fail').length
  console.log(JSON.stringify({ ok: fails === 0, fails, warnings: rows.filter((r) => r.level === 'warn').length, rows }, null, 2))
  process.exit(fails === 0 ? 0 : 1)
}
for (const r of rows) {
  const mark = r.level === 'ok' ? '✓' : r.level === 'fail' ? '✗' : r.level === 'warn' ? '!' : '   '
  console.log(mark + ' ' + r.text)
}
const fails = rows.filter((r) => r.level === 'fail').length
const warns = rows.filter((r) => r.level === 'warn').length
if (fails) console.log('\n✗ ' + fails + ' 项需要处理（warning ' + warns + '）')
process.exit(fails === 0 ? 0 : 1)
