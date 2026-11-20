// 社交策略.mjs —— 把 dsh-social-policy 装进当前 web profile（P2，2026-11-19）
//
// 为什么不手改 profile：引擎升级会整目录替换，安装/回退要能一条命令重来。
// 用法：
//   node 12-源码照搬\工具\社交策略.mjs --check
//   node 12-源码照搬\工具\社交策略.mjs --apply
//   node 12-源码照搬\工具\社交策略.mjs --mode shadow|enforce
//   node 12-源码照搬\工具\社交策略.mjs --off
// ⚠ 插件在引擎启动时加载：装完/改完必须重启整壳（启动.vbs），不要只重启引擎。
// --check 读插件文件、patch 与 logs\social-policy.jsonl，显示模式 / 策略镜像 /
// 已注入轮数（shadow / inject / 失败）与最近一条渠道，不另存影子状态。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__HERE, '..', '..')
const SRC = path.join(ROOT, '12-源码照搬', '插件', '社交策略')
const PROFILE = path.join(ROOT, '12-源码照搬', '引擎数据', '.dsh', 'profiles', 'web')
const DEST = path.join(PROFILE, 'node_modules', 'dsh-social-policy')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const POLICY = path.join(ROOT, '12-源码照搬', '外壳', 'data', '社交回复.json')
const POLICY_MIRROR = path.join(ROOT, '12-源码照搬', '引擎数据', '.dsh', '场景记忆', '_共享记忆', '社交回复.json')
const INJECT_LOG = path.join(ROOT, '12-源码照搬', '引擎数据', '.dsh', 'logs', 'social-policy.jsonl')
const MARK = 'dsh-social-policy'
const ID = 'social-policy'

const argv = process.argv.slice(2)
const modeArg = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : ''
const on = (f) => argv.includes(f)

function patchText() {
  return fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : ''
}

function injectSummary() {
  let lines = 0, errors = 0, last = null
  const kinds = {}
  try {
    const rows = fs.readFileSync(INJECT_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    lines = rows.length
    for (const row of rows.slice(-500)) {
      try {
        const j = JSON.parse(row)
        const k = String(j.kind || '')
        kinds[k] = (kinds[k] || 0) + 1
        if (j.err) errors++
        last = j
      } catch { /* 单行坏不影响整份统计 */ }
    }
  } catch { /* 还没有日志 = 还没注入过 */ }
  return {
    path: INJECT_LOG,
    lines: lines,
    errors: errors,
    kinds: kinds,
    last: last ? {
      at: last.at, kind: last.kind, mode: last.mode, channel: last.channel,
      chatType: last.chatType, chatId: last.chatId, chars: last.chars
    } : null,
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
    policyMirror: fs.existsSync(POLICY_MIRROR),
    inject: injectSummary(),
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
  console.log('策略镜像：' + (s.policyMirror ? '已生成' : '未生成（打开/保存回复风格后生成）'))
  const inj = s.inject || {}
  if (inj.lines) {
    console.log('注入记录：' + inj.lines + ' 轮（shadow ' + (inj.kinds.shadow || 0) + ' / inject ' + (inj.kinds.inject || 0) + (inj.errors ? ' / 失败 ' + inj.errors : '') + '） · 最近 ' + (inj.last ? (inj.last.at + ' · ' + (inj.last.channel || '—') + ' · ' + (inj.last.chars || 0) + ' B') : '—'))
  } else {
    console.log('注入记录：还没有（重启整壳后产生；每轮只记渠道/会话/字节）')
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
    '# ---- 2026-11-19 社交策略：给已登记的社交会话注入回复卡（工具\\社交策略.mjs 装）----',
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
  const next = text.replace(/\n# ---- 2026-11-19 社交策略[^\n]*\n- insert:\n    - id: social-policy\n      name: "dsh-social-policy"\n      config:\n        mode: \w+\n?/u, '\n')
  fs.writeFileSync(PATCH, next, 'utf8')
  return true
}

function copyPlugin() {
  if (!fs.existsSync(path.join(SRC, 'index.js'))) {
    throw new Error('插件源不存在：' + SRC)
  }
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.mkdirSync(DEST, { recursive: true })
  for (const f of fs.readdirSync(SRC)) {
    if (f === '自检.mjs') continue
    fs.copyFileSync(path.join(SRC, f), path.join(DEST, f))
  }
}

function writePolicyMirror() {
  try {
    if (!fs.existsSync(POLICY)) return false
    fs.mkdirSync(path.dirname(POLICY_MIRROR), { recursive: true })
    fs.copyFileSync(POLICY, POLICY_MIRROR)
    return true
  } catch (e) {
    console.error('策略镜像写入失败：' + String((e && e.message) || e))
    return false
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
    const mirrored = writePolicyMirror()
    console.log('✓ 已装：' + DEST)
    console.log('✓ 已登记 cordis.patch.yml（mode=' + (modeArg === 'shadow' ? 'shadow' : 'enforce') + '）')
    console.log((mirrored ? '✓' : '·') + ' 策略镜像：' + POLICY_MIRROR)
    console.log('⚠ 需要重启整壳才生效：双击 12-源码照搬\\启动.vbs（⛔ 不要只重启引擎）')
    process.exit(0)
  } catch (e) {
    console.error('✗ 安装失败：' + String((e && e.message) || e))
    process.exit(2)
  }
}

console.error('用法：node 12-源码照搬\\工具\\社交策略.mjs --check | --apply | --mode shadow|enforce | --off')
process.exit(2)
