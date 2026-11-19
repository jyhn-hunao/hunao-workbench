// 聊天档案.mjs —— 把 dsh-chat-archive 装进当前 web profile（2026-11-19）
//
// 用法：
//   node 12-源码照搬\工具\聊天档案.mjs --check
//   node 12-源码照搬\工具\聊天档案.mjs --apply
//   node 12-源码照搬\工具\聊天档案.mjs --mode shadow|enforce
//   node 12-源码照搬\工具\聊天档案.mjs --off
// ⚠ 插件在引擎启动时加载：装完/改完必须重启整壳（启动.vbs），不要只重启引擎。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__HERE, '..', '..')
const SRC = path.join(ROOT, '12-源码照搬', '插件', '聊天档案')
const PROFILE = path.join(ROOT, '12-源码照搬', '引擎数据', '.dsh', 'profiles', 'web')
const DEST = path.join(PROFILE, 'node_modules', 'dsh-chat-archive')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const MARK = 'dsh-chat-archive'
const ID = 'chat-archive'
const DB = path.join(ROOT, '12-源码照搬', '引擎数据', '.dsh', '社交档案', 'chat-archive.db')

const argv = process.argv.slice(2)
const modeArg = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : ''
const on = (f) => argv.includes(f)

function patchText() {
  return fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : ''
}

function dbInfo() {
  try {
    const stat = fs.statSync(DB)
    const req = createRequire(import.meta.url)
    const lib = req(path.join(ROOT, '12-源码照搬', '外壳', '社交档案库.js'))
    const db = lib.openDb(DB, { readOnly: true })
    const s = lib.getStatus(db, DB)
    lib.closeDb(db)
    return { exists: true, bytes: stat.size, messages: s.messages, chats: s.chats, firstDay: s.firstDay, lastDay: s.lastDay }
  } catch (e) {
    return { exists: false, error: String((e && e.message) || e) }
  }
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
    db: dbInfo()
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
  console.log('注入模式：' + (s.mode || '—'))
  console.log('档案库：' + (s.db.exists
    ? ('已建 ' + s.db.messages + ' 条 / ' + s.db.chats + ' 个聊天 / ' + (s.db.firstDay || '—') + ' 至 ' + (s.db.lastDay || '—') + ' / ' + Math.round((s.db.bytes || 0) / 1024) + ' KB')
    : ('未建' + (s.db.error ? '（' + s.db.error + '）' : ''))))
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
    '# ---- 2026-11-19 聊天档案：按需查历史原文与单聊天记忆（工具\\聊天档案.mjs 装）----',
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
  const next = text.replace(/\n# ---- 2026-11-19 聊天档案[^\n]*\n- insert:\n    - id: chat-archive\n      name: "dsh-chat-archive"\n      config:\n        mode: \w+\n?/u, '\n')
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
    console.log('· 档案库：' + (dbInfo().exists ? DB : '尚未建（工作台启动后自动建并开始归档）'))
    console.log('⚠ 需要重启整壳才生效：双击 12-源码照搬\\启动.vbs（⛔ 不要只重启引擎）')
    process.exit(0)
  } catch (e) {
    console.error('✗ 安装失败：' + String((e && e.message) || e))
    process.exit(2)
  }
}

console.error('用法：node 12-源码照搬\\工具\\聊天档案.mjs --check | --apply | --mode shadow|enforce | --off')
process.exit(2)
