#!/usr/bin/env node
// 引擎更新检查.mjs —— 只读回答一个问题：本地 DSH 引擎要不要升级、升之前本机缺不缺条件
//
// 为什么需要它：引擎是**整目录外部依赖**（AGENTS.md §2 / 12-源码照搬/.gitignore 第 29–30 行），
//   升级 = 停引擎 → 整目录替换 → 私有插件重新落位 → 自检 → 不对就回退。
//   这条链原来只能靠人偶尔想起来看一眼，「什么时候该升」没有落点。本脚本只负责**判断**：
//   ① 本地 package.json 的 version vs npm 上游 dist-tags；② 上游 engines.node 与本机 Node 是否相容；
//   ③ 升级必须停机，所以顺带看一眼 DSH 端口是否还被占着。
//   ⛔ 它不下载、不替换、不改任何配置；写盘只有 --notify 一个状态文件。
//
// 用法：
//   node 12-源码照搬\工具\引擎更新检查.mjs              # 人读输出（默认 latest 渠道）
//   node 12-源码照搬\工具\引擎更新检查.mjs --json       # 机器可读
//   node 12-源码照搬\工具\引擎更新检查.mjs --notify     # 另写 引擎数据\.dsh\引擎更新提示.json（给顶栏/定时任务读）
//   node 12-源码照搬\工具\引擎更新检查.mjs --channel next   # 也可 alpha / latest / next
//   node 12-源码照搬\工具\引擎更新检查.mjs --mirror     # 先走 registry.npmmirror.com（npm 官方连不上时）
//   node 12-源码照搬\工具\引擎更新检查.mjs --offline    # 不联网，只回放上次 --notify 的结果
//
// 退出码：0 已是最新 / 1 有新版本 / 2 检查失败（连不上或不合法响应）
//   ⛔ 断网 ≠ 已最新：失败必须返回 2，不许静默当成没事（AGENTS.md §5「不静默兜底」）

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WORKBENCH_ROOT, dshHome, port } from './环境.mjs'

// 1. 参数与路径（本机值一律从 环境.mjs 取，不写盘符/端口字面量）
const ARG = process.argv.slice(2)
const CHANNEL = (() => {
  const i = ARG.indexOf('--channel')
  return i >= 0 && ARG[i + 1] ? ARG[i + 1] : 'latest'
})()
const JSON_OUT = ARG.includes('--json')
const NOTIFY = ARG.includes('--notify')
const MIRROR = ARG.includes('--mirror')
const OFFLINE = ARG.includes('--offline')

const PKG_NAME = '@deepseek-ai/dsh'
const ENGINE_PKG = path.join(WORKBENCH_ROOT, '引擎', 'package.json')
const STATE_FILE = path.join(dshHome(), '引擎更新提示.json')
const MACHINE_FILE = path.join(dshHome(), '机器配置.json')
const PLUG_DIR = path.join(WORKBENCH_ROOT, '插件')

// 2. 版本比较（semver 的够用版：major.minor.patch + 可选 prerelease）
//    rc.1 < rc.2 < rc.3 < 0.2.2 正式版；数字段按数值比，字母段按字典序
function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
  if (!m) return null
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] }
}
function cmpVer(a, b) {
  const A = parseVer(a)
  const B = parseVer(b)
  if (!A || !B) return 0
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) return A.core[i] > B.core[i] ? 1 : -1
  }
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1                 // 正式版 > 同号预发布
  if (!B.pre.length) return -1
  const n = Math.max(A.pre.length, B.pre.length)
  for (let i = 0; i < n; i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) { if (+x !== +y) return +x > +y ? 1 : -1 } else if (xn) return -1
    else if (yn) return 1
    else if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

// 3. 本地版本：以 引擎\package.json 为准（环境.mjs 里同一口径），读不到就说读不到
function readLocal() {
  try {
    const j = JSON.parse(fs.readFileSync(ENGINE_PKG, 'utf8'))
    return { version: String(j.version || ''), pkg: ENGINE_PKG }
  } catch (e) {
    return { version: '', pkg: ENGINE_PKG, error: e.message }
  }
}

// 4. 上游：只取 dist-tags 与目标渠道的 engines，不下载 tarball
async function readRemote() {
  const regs = MIRROR
    ? ['https://registry.npmmirror.com']
    : ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
  let lastErr = ''
  for (const base of regs) {
    try {
      const r = await fetch(base + '/' + encodeURIComponent(PKG_NAME), { signal: AbortSignal.timeout(15000) })
      if (!r.ok) { lastErr = base + ' HTTP ' + r.status; continue }
      const j = await r.json()
      if (!j || !j['dist-tags']) { lastErr = base + ' 响应没有 dist-tags'; continue }
      const tag = j['dist-tags'][CHANNEL] || j['dist-tags'].latest
      const ver = j.versions && j.versions[tag]
      return {
        registry: base,
        tags: j['dist-tags'],
        tag,
        engines: (ver && ver.engines) || null,
        url: 'https://www.npmjs.com/package/' + PKG_NAME,
      }
    } catch (e) {
      lastErr = base + ' ' + (e && e.message ? e.message : String(e))
    }
  }
  return { error: lastErr || '未知错误' }
}

// 5. Node 相容性：上游 engines.node 目前只有 ">=x.y.z" 这一种写法；别的写法一律标「需人工确认」
//    curVersion 传「工作台实际在用的 node」——脚本自己是被哪个 node 跑起来的不重要
function nodeCheck(engines, curVersion) {
  const need = engines && engines.node ? String(engines.node) : ''
  const cur = String(curVersion || process.versions.node)
  if (!need) return { need: '', ok: true, note: '上游未声明 engines.node' }
  const m = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(need)
  if (!m) return { need, ok: false, note: '上游写法不是 >=x.y.z，需人工确认' }
  const [ma, mi, pa] = [+m[1], +m[2], +m[3]]
  const [cma, cmi, cpa] = cur.split('.').map(Number)
  const ok = cma > ma || (cma === ma && (cmi > mi || (cmi === mi && cpa >= pa)))
  return { need, ok, note: ok ? '满足（' + cur + '）' : '不满足（当前 ' + cur + '）⇒ 装完直接起不来' }
}

// 6. 工作台实际用的 Node：main.js 是按 PATH 找 node 的，所以读 机器配置.json 里记的 nodeExe
function workbenchNode() {
  let exe = ''
  try { exe = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')).nodeExe || '' } catch { /* 没有就跳过 */ }
  if (!exe || !fs.existsSync(exe)) return { exe: '', version: '', source: '未记录 nodeExe' }
  try {
    const v = execFileSync(exe, ['-v'], { encoding: 'utf8', timeout: 5000 }).trim()
    return { exe, version: v.replace(/^v/, ''), source: '机器配置.json' }
  } catch (e) {
    return { exe, version: '', source: '执行失败：' + (e.message || '').split('\n')[0] }
  }
}

// 7. 私有插件：升级整目录替换后，profiles\web\node_modules 里的落位会一起没，必须重跑 环境适配.mjs --apply
function privatePlugins() {
  try {
    return fs.readdirSync(PLUG_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try { return JSON.parse(fs.readFileSync(path.join(PLUG_DIR, d.name, 'package.json'), 'utf8')).name || '' } catch { return '' }
      })
      .filter(Boolean)
  } catch { return [] }
}

// 8. 端口：升级必须停引擎，端口还被占着就只能等
function portBusy(p) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: p })
    s.setTimeout(800)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('timeout', () => { s.destroy(); resolve(false) })
    s.once('error', () => resolve(false))
  })
}

// 9. 主流程
async function main() {
  const local = readLocal()
  if (!local.version) {
    const msg = '读不到本地引擎版本：' + (local.error || '') + '（' + local.pkg + '）'
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    else console.error('✗ ' + msg)
    process.exit(2)
  }

  if (OFFLINE) {
    const st = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null } })()
    if (!st) {
      if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: '没有上次的检查结果：' + STATE_FILE }, null, 2))
      else console.error('✗ 没有上次的检查结果（先跑一次不带 --offline 的）')
      process.exit(2)
    }
    console.log(JSON_OUT ? JSON.stringify(st, null, 2) : '上次检查（' + st.checkedAt + '）：本地 ' + st.localVersion + ' / 上游 ' + st.remoteVersion + (st.hasUpdate ? ' ⇒ 有新版本' : ' ⇒ 已最新'))
    process.exit(st.hasUpdate ? 1 : 0)
  }

  const remote = await readRemote()
  if (remote.error) {
    const msg = '查不到上游版本：' + remote.error + '（换 --mirror 再试，或确认能连 npm）'
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg, localVersion: local.version }, null, 2))
    else console.error('✗ ' + msg)
    process.exit(2)
  }

  const hasUpdate = cmpVer(remote.tag, local.version) > 0
  const wn = workbenchNode()
  const nodeForCheck = wn.version || process.versions.node
  // 用工作台自己的 Node 复核（脚本可能是被别的 node 跑的，结论要以引擎实际那个为准）
  const nodeVerdict = nodeCheck(remote.engines, nodeForCheck)

  const dshPort = port('dsh')
  const busy = await portBusy(dshPort)
  const plugs = privatePlugins()

  const state = {
    checkedAt: new Date().toISOString(),
    channel: CHANNEL,
    registry: remote.registry,
    localVersion: local.version,
    remoteVersion: remote.tag,
    tags: remote.tags,
    hasUpdate,
    enginesNode: nodeVerdict.need,
    workbenchNode: nodeForCheck,
    nodeOk: nodeVerdict.ok,
    nodeNote: nodeVerdict.note,
    port: dshPort,
    portBusy: busy,
    privatePlugins: plugs,
    upgradeDoc: 'doc\\引擎升级与版本兼容清单.md',
  }
  if (NOTIFY) {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8')
    } catch (e) {
      if (!JSON_OUT) console.error('△ 状态文件写失败：' + e.message)
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(state, null, 2))
    process.exit(hasUpdate ? 1 : 0)
  }

  const lines = [
    '引擎版本检查 · ' + (hasUpdate ? '有新版本' : '已是最新'),
    '  本地      ' + local.version + '  ← ' + path.relative(WORKBENCH_ROOT, local.pkg),
    '  上游 ' + CHANNEL + '  ' + remote.tag + '  ← ' + remote.registry,
    '  全部渠道  ' + Object.keys(remote.tags).map((k) => k + '=' + remote.tags[k]).join(' / '),
    '',
    '升级前条件',
    '  Node      ' + nodeVerdict.note + (nodeVerdict.need ? '（上游要求 ' + nodeVerdict.need + '）' : ''),
    '  DSH 端口  ' + (busy ? dshPort + ' 还被占着 ⇒ 先退出工作台（升级要停机）' : dshPort + ' 空闲 ⇒ 可以先停引擎再换目录'),
    '  私有插件  ' + (plugs.length ? plugs.join('、') + ' ⇒ 换目录后要跑 环境适配.mjs --apply 重新落位' : '无'),
  ]
  if (hasUpdate) {
    lines.push('')
    lines.push('下一步')
    lines.push('  1. 读 doc\\引擎升级与版本兼容清单.md 的「升级 SOP」')
    lines.push('  2. 备份 引擎数据\\.dsh（会话/凭据在这里，换引擎目录不该动它们）')
    lines.push('  3. 停引擎 → 整目录替换 引擎\\ → 环境适配.mjs --apply → 自检.mjs → dump-config 验收')
  }
  console.log(lines.join('\n'))
  process.exit(hasUpdate ? 1 : 0)
}

main()
