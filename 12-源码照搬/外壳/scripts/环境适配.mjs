#!/usr/bin/env node
// 环境适配.mjs —— 跨机器移植的就地自愈（2026-11-12 新增）
//
// 为什么需要它：工作台里有四类「本机值」不随 git 走 —— ①场景 json / 项目.json 里的绝对路径
//   ②profiles/web 里的私有插件落位 ③6 条会话 id ④端口占用。换一台机器 clone 完，这四样都要在
//   新机器上就地重算；手工改一处漏三处，且漏了不报错（面板只是空白或指向不存在的目录）。
//
// 用法：
//   node 外壳\scripts\环境适配.mjs              = --check（只读；有 ✗ 就退出码 1）
//   node 外壳\scripts\环境适配.mjs --apply     重算路径 + 插件落位 + 写 机器配置.json（幂等，可反复跑）
//   node 外壳\scripts\环境适配.mjs --rotate    额外：对钉空的面板跑 换会话.mjs <面板id> --go
//                                              ⚠ 会**归档旧会话**，只在确认旧会话不要了才加这个参数
//   node 外壳\scripts\环境适配.mjs --json      机器可读输出（给别的脚本用）
//
// 四步（每步都先判存在性，再按 --apply 决定改不改）：
//   1. 机器配置      本机值只写一处：引擎数据\.dsh\机器配置.json（不入库）
//   2. 路径对齐      场景 json 的 homeFolders / drives / repo，项目.json 的 paths / memory*
//   3. 插件落位      插件\<包名>  →  profiles\web\node_modules\<包名>（junction，可重建）
//   4. 会话与端口    会话 id 在本机是否存在（离线读 storages，不需要 GUI 在跑）；端口是否被占
//
// 边界：⛔ 不动 引擎\ 内部；⛔ 不动仓库外的项目路径（如另一个项目的目录），只报告；
//       ⛔ 不自动改端口（自动顺延最容易连到别人的引擎，一律报错停下）。

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// 1. 位置与口径（与 工具\环境.mjs 同源，避免两套根）
//    ⛔ 必须用 fileURLToPath：本仓路径含中文，new URL().pathname 会变成 %E6%BA%90… 导致路径全错
const HERE = path.dirname(fileURLToPath(import.meta.url))    // 外壳\scripts
// 工作台根允许环境变量覆盖：一是多实例并存，二是可以在临时树上试跑（不碰真配置）
const PROJECT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', '..')   // 12-源码照搬
const SHELL = path.join(PROJECT, '外壳')
const REPO = path.resolve(PROJECT, '..')                // 仓库根
const DSH_HOME = process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || path.join(PROJECT, '引擎数据', '.dsh')
const SCEN_DIR = path.join(SHELL, 'scenarios')
const MACHINE_FILE = process.env.DSH_MACHINE_FILE || path.join(DSH_HOME, '机器配置.json')
const PROFILE = path.join(DSH_HOME, 'profiles', 'web')
const PLUG_DIR = path.join(PROJECT, '插件')
const PROJ_JSON = path.join(DSH_HOME, '场景记忆', '_共享记忆', '项目.json')
const ENGINE_DIR = path.join(PROJECT, '引擎')

const ARG = process.argv.slice(2)
const APPLY = ARG.includes('--apply')
const ROTATE = ARG.includes('--rotate')
const JSON_OUT = ARG.includes('--json')

// 2. 结果收集与输出（level: fail 影响退出码；warn / info 只提示）
const rows = []
const add = (name, level, detail) => rows.push({ name, level, detail: detail || '' })

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
// 保留原文件缩进与换行，避免一次自愈把整个 json 重排成大 diff
function writeJsonKeepShape(p, obj, before) {
  const indent = (() => {
    const m = /\n([ \t]+)"/.exec(before || '')
    return m ? m[1] : '  '
  })()
  const eol = (before || '').includes('\r\n') ? '\r\n' : '\n'
  const text = JSON.stringify(obj, null, indent).replace(/\n/g, eol) + eol
  fs.writeFileSync(p, text, 'utf8')
}
function backup(p) {
  const bak = p + '.' + Date.now() + '.bak.json'
  try { fs.copyFileSync(p, bak) } catch { /* 备份失败就不写 */ return '' }
  return bak
}

// 3. 机器配置：缺的字段补上，用户自定义的字段一律保留
function buildMachine() {
  const old = readJson(MACHINE_FILE) || {}
  const scen = readJson(path.join(SCEN_DIR, 'code-dev.json')) || {}
  const homeFolders = ((scen.panels || []).find((p) => p && p.homeFolders) || {}).homeFolders || []
  const codeRoot = homeFolders[0] && fs.existsSync(homeFolders[0]) ? homeFolders[0] : path.dirname(path.dirname(REPO))
  const projects = {}
  for (const p of (readJson(PROJ_JSON) || {}).projects || []) {
    if (p && p.name && p.paths && p.paths[0]) projects[p.name] = p.paths[0]
  }
  let nodeExe = old.nodeExe || ''
  if (!nodeExe) { try { nodeExe = process.execPath } catch { /* 留空 */ } }
  return {
    workbenchRoot: PROJECT,
    repoRoot: REPO,
    codeRoot,
    ports: old.ports || { dsh: 3083, site: 31238, preview: 31240, webAi: 31239 },
    nodeExe,
    engineVersion: readJson(path.join(ENGINE_DIR, 'package.json'))?.version || '',
    projects,
  }
}
function stepMachine() {
  const want = buildMachine()
  const have = readJson(MACHINE_FILE)
  if (!have) {
    add('机器配置', APPLY ? 'ok' : 'fail', APPLY ? '已生成 ' + MACHINE_FILE : '缺 ' + MACHINE_FILE + '（跑 --apply 生成）')
  } else {
    const drift = ['workbenchRoot', 'repoRoot', 'codeRoot', 'nodeExe', 'engineVersion'].filter((k) => have[k] !== want[k])
    add('机器配置', drift.length ? (APPLY ? 'ok' : 'warn') : 'ok', drift.length ? (APPLY ? '已对齐：' + drift.join('、') : '与本机不一致：' + drift.join('、')) : '与本机一致')
  }
  if (APPLY) {
    const merged = { ...want, ...(have || {}), ports: (have && have.ports) || want.ports, projects: { ...want.projects, ...((have && have.projects) || {}) } }
    writeJsonKeepShape(MACHINE_FILE, merged, have ? fs.readFileSync(MACHINE_FILE, 'utf8') : '')
  }
  return want
}

// 4. 路径重写的两个小工具（只服务 git 面板的 repo 字段与项目登记表）
const DRIVE = /^[A-Za-z]:$/
const repoName = path.basename(REPO)
// ⛔ 必须排除备份：sessions.mjs 换会话会留 <场景>.<时间戳>.bak.json，它们也以 .json 结尾，
//    当成场景加载会把同一面板数成两份（实测 6 个面板被数成 8 条）
const isScen = (x) => x.endsWith('.json') && !/\.bak\.json$/i.test(x)

function rewrite(p) {
  const norm = String(p).replace(/\//g, '\\')
  const lower = norm.toLowerCase()
  const name = repoName.toLowerCase()
  // ① 路径里带仓库目录名：把它之前的部分整体换成当前仓库根（换盘符 / 换父目录都能吃）
  const at = lower.indexOf('\\' + name + '\\')
  if (at >= 0) return REPO + norm.slice(at + 1 + name.length)
  if (lower === name || lower.endsWith('\\' + name)) return REPO
  // ② 光一个盘符且该盘不存在：换成仓库所在盘
  if (DRIVE.test(norm) && !fs.existsSync(norm + '\\')) return path.parse(REPO).root.replace(/\\$/, '')
  return ''
}

// 5. 路径：按面板语义重算（homeFolders 归代码根、drives 归仓库盘、repo 归仓库根）。
//    ⛔ 不用「整棵 json 替换字符串」：homeFolders 这类值里没有仓库名，靠猜永远猜不到该换成什么。
function stepPaths(m) {
  const codeRoot = m.codeRoot
  const repoDrive = path.parse(REPO).root.replace(/\\$/, '')
  let missing = 0, rewritten = 0, outside = 0

  // 1. 场景 json：三个字段各按语义处理
  for (const f of fs.readdirSync(SCEN_DIR).filter(isScen)) {
    const p = path.join(SCEN_DIR, f)
    const raw = fs.readFileSync(p, 'utf8')
    const obj = readJson(p)
    if (!obj) { add(f, 'fail', 'JSON 解析失败'); continue }
    let dirty = false
    for (const panel of obj.panels || []) {
      // view：homeFolders = 代码根
      if (Array.isArray(panel.homeFolders) && panel.homeFolders.some((x) => !fs.existsSync(x))) {
        missing += panel.homeFolders.filter((x) => !fs.existsSync(x)).length
        if (!JSON_OUT) console.log('✗ ' + f + ' ' + panel.id + '.homeFolders → ' + panel.homeFolders.join('、') + ' 不存在')
        if (APPLY) { panel.homeFolders = [codeRoot]; dirty = true; rewritten++ }
      }
      // file：drives = 盘符
      if (Array.isArray(panel.drives) && panel.drives.some((d) => !fs.existsSync(d + '\\'))) {
        missing += panel.drives.filter((d) => !fs.existsSync(d + '\\')).length
        if (!JSON_OUT) console.log('✗ ' + f + ' ' + panel.id + '.drives → ' + panel.drives.join('、') + ' 不存在')
        if (APPLY) { panel.drives = [repoDrive]; dirty = true; rewritten++ }
      }
      // git：repo = 仓库根（先按仓库名重算，推不出来就用当前仓库根）
      if (panel.repo && !fs.existsSync(panel.repo)) {
        missing++
        const next = rewrite(panel.repo) || REPO
        if (!JSON_OUT) console.log('✗ ' + f + ' ' + panel.id + '.repo → ' + panel.repo + ' 不存在')
        if (APPLY) { panel.repo = next; dirty = true; rewritten++ }
      }
    }
    if (APPLY && dirty) { backup(p); writeJsonKeepShape(p, obj, raw) }
  }

  // 2. 项目登记表：只有「本仓项目」能自动重算；别的项目在不在只有你知道
  if (fs.existsSync(PROJ_JSON)) {
    const raw = fs.readFileSync(PROJ_JSON, 'utf8')
    const reg = readJson(PROJ_JSON)
    let dirty = false
    for (const proj of (reg && reg.projects) || []) {
      const isMe = proj.name === repoName
      for (const k of ['paths', 'memoryRoot', 'memory', 'memoryIndex']) {
        const v = Array.isArray(proj[k]) ? proj[k] : proj[k] ? [proj[k]] : []
        const bad = v.filter((x) => !fs.existsSync(x))
        if (!bad.length) continue
        if (k === 'memoryIndex') {                 // 记忆索引由工具再生，缺了不算错
          if (!JSON_OUT) console.log('· 项目.json ' + proj.name + '.memoryIndex 本机没有（可再生，不算错）')
          if (APPLY && isMe) { proj[k] = path.join(REPO, 'memory', '_索引.json'); dirty = true }
          continue
        }
        if (!isMe) {
          outside += bad.length
          if (!JSON_OUT) console.log('△ 项目.json ' + proj.name + '.' + k + ' → ' + bad.join('、') + ' 不存在（仓库外，需人工确认）')
          continue
        }
        missing += bad.length
        if (!JSON_OUT) console.log('✗ 项目.json ' + proj.name + '.' + k + ' → ' + bad.join('、') + ' 不存在')
        if (!APPLY) continue
        if (k === 'paths') proj[k] = [REPO]
        else if (k === 'memoryRoot') proj[k] = REPO
        else proj[k] = path.join(PROJECT, '引擎数据', '.dsh', '场景记忆', proj.owner || '', '项目记忆', (proj.name || '') + '.md')
        dirty = true; rewritten++
      }
    }
    if (APPLY && dirty) { backup(PROJ_JSON); writeJsonKeepShape(PROJ_JSON, reg, raw) }
  }

  add('路径对齐', missing ? (APPLY ? 'ok' : 'fail') : 'ok',
    (missing ? (APPLY ? '已重写 ' + rewritten + ' 处' : missing + ' 处本机不存在（跑 --apply）') : '全部命中本机') +
      (outside ? '；' + outside + ' 处仓库外路径不存在（需人工确认）' : ''))
}

// 5. 插件落位：插件\<包名> → profiles\web\node_modules\<包名>
function stepPlugins() {
  if (!fs.existsSync(PLUG_DIR)) { add('插件落位', 'info', '没有 插件\\ 目录，跳过'); return }
  if (!fs.existsSync(PROFILE)) { add('插件落位', 'warn', 'profile 不存在（引擎还没装？）：' + PROFILE); return }
  const nm = path.join(PROFILE, 'node_modules')
  if (!fs.existsSync(nm)) { add('插件落位', 'warn', 'node_modules 不存在（先在本目录 pnpm install）'); return }
  const seen = []
  for (const d of fs.readdirSync(PLUG_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const pkg = readJson(path.join(PLUG_DIR, d.name, 'package.json'))
    if (!pkg || !pkg.name) { add('插件 ' + d.name, 'warn', '没有可用的 package.json（缺 name）'); continue }
    const target = path.join(nm, pkg.name)
    if (fs.existsSync(target)) { seen.push(pkg.name + ' ✓'); continue }
    if (APPLY) {
      try {
        fs.symlinkSync(path.join(PLUG_DIR, d.name), target, process.platform === 'win32' ? 'junction' : 'dir')
        seen.push(pkg.name + ' 已落位')
      } catch (e) {
        seen.push(pkg.name + ' 落位失败：' + e.message + '（退路：手工把 插件\\' + d.name + ' 复制到 ' + target + '）')
      }
    } else seen.push(pkg.name + ' ✗ 未落位')
  }
  const bad = seen.filter((s) => /✗|失败/.test(s)).length
  add('插件落位', bad ? 'fail' : 'ok', seen.join('；'))
}

// 6. bundle 可解析：profile 声明的每个 bundle 要么在 profile 的 node_modules，要么在引擎的
function stepBundles() {
  const prof = readJson(path.join(PROFILE, 'package.json'))
  const bundles = ((prof || {}).dsh || {}).profile?.bundles || []
  if (!bundles.length) { add('bundle 可解析', 'warn', 'profile package.json 里没有 bundles'); return }
  const dirs = [path.join(PROFILE, 'node_modules'), path.join(ENGINE_DIR, 'node_modules')]
  const miss = bundles.filter((b) => !dirs.some((d) => fs.existsSync(path.join(d, b))))
  add('bundle 可解析', miss.length ? 'fail' : 'ok', miss.length ? '解析不到：' + miss.join('、') + '（私有包装回 插件\\ 后跑 --apply）' : bundles.length + ' 个全部可解析')
}

// 7. 会话：离线扫 sessions\<cwd编码>\<会话id>\（不需要 GUI 在跑），再补 storages 的每会话缓存
function sessionIds() {
  const ids = new Set()
  const base = path.join(DSH_HOME, 'sessions')
  try {
    for (const ws of fs.readdirSync(base)) {
      for (const id of fs.readdirSync(path.join(base, ws))) ids.add(id)
    }
  } catch { /* 还没有会话目录 */ }
  const cacheDir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
  try {
    for (const f of fs.readdirSync(cacheDir)) { ids.add(f); ids.add(f.replace(/\.[^.]+$/, '')) }
  } catch { /* 没有缓存目录 */ }
  return ids
}
function stepSessions(ids) {
  const scen = fs.readdirSync(SCEN_DIR).filter(isScen).map((f) => ({ f, ...(readJson(path.join(SCEN_DIR, f)) || {}) }))
  const panels = []
  for (const sc of scen) for (const p of sc.panels || []) {
    if (p && p.type === 'harness' && p.sessionId && p.sessionId !== '__待填__') panels.push({ file: sc.f, id: p.id, sid: p.sessionId, title: p.sessionTitle })
  }
  if (!panels.length) { add('会话绑定', 'info', '没有需要校验的 AI 面板'); return }
  const bad = panels.filter((p) => !ids.has(p.sid))
  add('会话绑定', bad.length ? 'fail' : 'ok',
    bad.length
      ? bad.length + '/' + panels.length + ' 条钉的会话在本机不存在：' + bad.map((p) => p.id).join('、') + (ROTATE ? '（正在按 --rotate 重建）' : '（跑 --rotate 重建，或逐个 换会话.mjs <面板id> --go）')
      : panels.length + '/' + panels.length + ' 条全部命中本机会话')
  if (ROTATE && bad.length) {
    for (const p of bad) {
      try {
        execFileSync(process.execPath, [path.join(HERE, '换会话.mjs'), p.id, '--go'], { cwd: SHELL, stdio: 'inherit' })
        add('重建 ' + p.id, 'ok', '已换新会话')
      } catch (e) {
        add('重建 ' + p.id, 'fail', '失败：' + (e.message || '').split('\n')[0])
      }
    }
  }
}

// 8. 端口：只探活不修改（自动顺延会连到别人的引擎）
async function stepPorts(m) {
  const ports = m.ports || {}
  const busy = []
  for (const [name, p] of Object.entries(ports)) {
    await new Promise((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port: Number(p) })
      s.setTimeout(400)
      s.once('connect', () => { busy.push(name + ':' + p); s.destroy(); resolve() })
      s.once('timeout', () => { s.destroy(); resolve() })
      s.once('error', () => resolve())
    })
  }
  add('端口', 'info', busy.length ? '已占用：' + busy.join('、') + '（工作台在跑属正常；换机器后若被别的程序占，改 机器配置.json 与 启动.vbs）' : '全部空闲')
}

// 9. 主流程
async function main() {
  if (!JSON_OUT) console.log('环境适配 · ' + (APPLY ? '--apply' : '--check') + '\n  工作台：' + PROJECT + '\n  机器配置：' + MACHINE_FILE + '\n')
  const m = stepMachine()
  stepPaths(m)
  stepPlugins()
  stepBundles()
  stepSessions(sessionIds())
  await stepPorts(m)

  const fails = rows.filter((r) => r.level === 'fail')
  if (JSON_OUT) { console.log(JSON.stringify({ ok: !fails.length, rows }, null, 2)); process.exit(fails.length ? 1 : 0) }
  for (const r of rows) console.log((r.level === 'fail' ? '✗ ' : r.level === 'warn' ? '△ ' : '· ') + r.name + (r.detail ? ' — ' + r.detail : ''))
  console.log('')
  console.log(fails.length ? '⛔ ' + fails.length + ' 项未通过' + (APPLY ? '（部分需要人工处理，见上面文案）' : '；修法：加 --apply（会话重建再加 --rotate）') : '✅ 环境适配通过')
  process.exit(fails.length ? 1 : 0)
}
main()
