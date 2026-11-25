// @功能台 {"name":"回信路由","group":"社交","freq":"按需","plain":"装/查回信路由闸门：面板来的消息只在面板回，通道发送工具只放行通道来源。","why":"通道工具全局注册，人格主会话历史里有通道消息，模型会把面板对话当成 QQ 聊天直接发出去。","label":"回信路由"}
// 回信路由.mjs —— 把 dsh-reply-router 装进当前 web profile（2026-11-24）
//
// 为什么单独装：通道工具（qq_send 等）是全局注册的，人格主会话里历史通道消息一多，
// 模型就会在面板对话里直接调 qq_send 发到 QQ。插件按本轮消息来源做硬闸：
// 面板来的消息只能在面板回，通道来的消息才放行通道工具。
//
// 用法：
//   node 12-源码照搬\工具\回信路由.mjs --check
//   node 12-源码照搬\工具\回信路由.mjs --apply
//   node 12-源码照搬\工具\回信路由.mjs --mode shadow|enforce
//   node 12-源码照搬\工具\回信路由.mjs --off
// ⚠ 插件在引擎启动时加载：装完/改完必须重启整壳（启动.vbs），不要只重启引擎。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || path.join(__HERE, '..', '引擎数据', '.dsh')
const SRC = path.join(__HERE, '..', '插件', '回信路由')
const PROFILE = path.join(DSH_HOME, 'profiles', 'web')
const DEST = path.join(PROFILE, 'node_modules', 'dsh-reply-router')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const LOG = path.join(DSH_HOME, 'logs', 'reply-router.jsonl')
const MARK = 'dsh-reply-router'
const ID = 'reply-router'

const argv = process.argv.slice(2)
const modeArg = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : ''
const on = (f) => argv.includes(f)

function patchText() {
  return fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : ''
}

function logSummary() {
  const out = { lines: 0, kinds: {}, errors: 0, last: null }
  try {
    const rows = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    out.lines = rows.length
    for (const row of rows.slice(-500)) {
      try {
        const j = JSON.parse(row)
        const k = String(j.kind || '')
        out.kinds[k] = (out.kinds[k] || 0) + 1
        if (k === 'error') out.errors++
        out.last = j
      } catch { /* 单行坏不影响整份统计 */ }
    }
  } catch { /* 还没日志 = 还没跑过 */ }
  return out
}

function statusInfo() {
  const installed = fs.existsSync(path.join(DEST, 'index.js'))
  const text = patchText()
  const registered = text.includes('name: "' + MARK + '"')
  const m = (text.match(new RegExp('name: "' + MARK + '"[\\s\\S]*?mode: (\\w+)')) || [])[1] || ''
  return {
    at: Date.now(),
    installed,
    registered,
    mode: m || (registered ? 'enforce' : null),
    pluginPath: DEST,
    patch: PATCH,
    log: logSummary(),
  }
}

function status() {
  const s = statusInfo()
  if (argv.includes('--json')) {
    console.log(JSON.stringify(s, null, 0))
    return s.installed && s.registered
  }
  console.log('插件文件：' + (s.installed ? '已装 ' + DEST : '未装'))
  console.log('patch 登记：' + (s.registered ? '已登记' : '未登记'))
  console.log('拦截模式：' + (s.mode || '—'))
  const lg = s.log || {}
  if (lg.lines) {
    console.log('运行记录：' + lg.lines + ' 条（inject ' + (lg.kinds.inject || 0) + ' / deny ' + (lg.kinds.deny || 0) + ' / shadow ' + (lg.kinds.shadow || 0) + (lg.errors ? ' / 失败 ' + lg.errors : '') + '） · 最近 ' + (lg.last ? (lg.last.at + ' · ' + lg.last.kind + (lg.last.tool ? ' · ' + lg.last.tool : '')) : '—'))
  } else {
    console.log('运行记录：还没有（重启整壳后产生）')
  }
  console.log('profile：' + PROFILE)
  return s.installed && s.registered
}

function ensurePatch(m) {
  let text = patchText()
  if (text.includes('name: "' + MARK + '"')) {
    text = text.replace(new RegExp('(name: "' + MARK + '"[\\s\\S]*?mode: )\\w+'), '$1' + m)
    fs.writeFileSync(PATCH, text, 'utf8')
    return
  }
  const block = [
    '',
    '# ---- 2026-11-24 回信路由：面板来的消息只能在面板回，通道工具只放行通道来源（工具\\回信路由.mjs 装）----',
    '- insert:',
    '    - id: ' + ID,
    '      name: "' + MARK + '"',
    '      config:',
    '        mode: ' + m,
    '',
  ].join('\n')
  fs.writeFileSync(PATCH, text.replace(/\s*$/u, '\n') + block, 'utf8')
}

function removePatch() {
  const text = patchText()
  if (!text.includes('name: "' + MARK + '"')) return false
  const next = text.replace(/\n# ---- 2026-11-24 回信路由[^\n]*\n- insert:\n    - id: reply-router\n      name: "dsh-reply-router"\n      config:\n        mode: \w+\n?/u, '\n')
  fs.writeFileSync(PATCH, next, 'utf8')
  return true
}

function copyPlugin() {
  if (!fs.existsSync(path.join(SRC, 'index.js'))) throw new Error('插件源不存在：' + SRC)
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.mkdirSync(DEST, { recursive: true })
  for (const f of fs.readdirSync(SRC)) {
    if (f === '自检.mjs') continue
    fs.copyFileSync(path.join(SRC, f), path.join(DEST, f))
  }
}

if (on('--check') || !argv.length) process.exit(status() ? 0 : 1)

if (on('--off')) {
  const removed = removePatch()
  console.log(removed ? '✓ 已从 patch 摘除（重启整壳后不再加载；插件文件保留）' : '· patch 里本来就没有 ' + MARK)
  process.exit(0)
}

if (on('--mode')) {
  if (!['shadow', 'enforce'].includes(modeArg)) {
    console.error('✗ --mode 只认 shadow / enforce')
    process.exit(2)
  }
  if (!patchText().includes('name: "' + MARK + '"')) {
    console.error('✗ 还没装（先 --apply）')
    process.exit(2)
  }
  ensurePatch(modeArg)
  console.log('✓ 模式已改为 ' + modeArg + '（重启整壳后生效）')
  process.exit(0)
}

if (on('--apply')) {
  try {
    copyPlugin()
    ensurePatch(modeArg === 'shadow' ? 'shadow' : 'enforce')
    console.log('✓ 已装：' + DEST)
    console.log('✓ 已登记 cordis.patch.yml（mode=' + (modeArg === 'shadow' ? 'shadow' : 'enforce') + '）')
    console.log('⚠ 需要重启整壳才生效：双击 12-源码照搬\\启动.vbs（⛔ 不要只重启引擎）')
    process.exit(0)
  } catch (e) {
    console.error('✗ 安装失败：' + String((e && e.message) || e))
    process.exit(2)
  }
}

console.error('用法：node 12-源码照搬\\工具\\回信路由.mjs --check | --apply | --mode shadow|enforce | --off')
process.exit(2)
