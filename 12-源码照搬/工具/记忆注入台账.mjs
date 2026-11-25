// 记忆注入台账.mjs —— 查「每个面板注入没注入 / 此刻会注入哪些段」（2026-11-25）
//
// 为什么单独一个脚本：
//   memory-recall.jsonl 一行一轮只记 scene / panel / mode / bytes，正文刻意不落盘（里面有人格卡、
//   §〇 与项目绝对路径）。界面要「一眼看出哪块面板在注入、注入了什么」，只能回到同一份 build
//   逻辑做一次 dry-run —— 这里直接 import 插件源文件，⛔ 不另写一套拼装（两份必然漂移）。
//
// 用法：
//   node 工具\记忆注入台账.mjs                         # 人读台账
//   node 工具\记忆注入台账.mjs --json                  # 机器读（界面「注入台账」抽屉走这条）
//   node 工具\记忆注入台账.mjs 预览 --场景 程序开发 --面板 cd-ai [--词 "上下文"] --json
// ⚠ 只读：不写注入流水、不落盘；预览与真注入同一口径（索引过期会由插件就地自愈）。
// @功能台 {"name":"记忆注入台账","group":"memory","freq":"daily","plain":"每个 AI 面板注入没注入、此刻会注入哪些段（只读，不写任何文件）","why":"jsonl 只有字节数，看不到正文；这里按真实 build 做 dry-run","label":"看台账"}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __HERE = path.dirname(fileURLToPath(import.meta.url))
// 源码版：工具在 <12-源码照搬>\工具；安装版：工具在 resources\工具（DSH_HOME 由壳注入）
const ROOT = path.resolve(__HERE, '..')
const DSH_HOME = process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh')
const SCEN_DIR = path.join(ROOT, '外壳', 'scenarios')
const PLUGIN_SRC = path.join(ROOT, '插件', '记忆回响', 'index.js')
const LOG_FILE = path.join(DSH_HOME, 'logs', 'memory-recall.jsonl')
const PATCH_FILE = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
const PLUGIN_INST = path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-memory-recall', 'index.js')
const SHARED = path.join(DSH_HOME, '场景记忆', '_共享记忆')

const ARGV = process.argv.slice(2)
const AS_JSON = ARGV.includes('--json')
const ACTION = (ARGV[0] && !ARGV[0].startsWith('-')) ? ARGV[0] : '台账'
function argOf(name, def) {
  const i = ARGV.indexOf(name)
  if (i < 0) return def || ''
  const v = ARGV[i + 1]
  return (v == null || v.startsWith('--')) ? (def || '') : String(v)
}

/* ---------------------------- 读真源 ---------------------------- */

/** patch 里 mode + 插件是否装到 profile（与 工具\记忆回响.mjs --check 同一套判据） */
function readPatch() {
  let text = ''
  try { text = fs.readFileSync(PATCH_FILE, 'utf8') } catch { /* 没 patch = 没登记，不假装有 */ }
  const registered = text.includes('dsh-memory-recall')
  const mode = (text.match(/name:\s*["']?dsh-memory-recall["']?[\s\S]*?mode:\s*(\w+)/) || [])[1] || (registered ? 'enforce' : '')
  return { installed: fs.existsSync(PLUGIN_INST), registered, mode }
}

/** 注入流水（一行一轮）。半截行（正在写）只计数，不当成功。 */
function readRows() {
  let raw = ''
  try { raw = fs.readFileSync(LOG_FILE, 'utf8') } catch { return { rows: [], bad: 0 } }
  const rows = []
  let bad = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { bad++ }
  }
  return { rows, bad }
}

/** 场景 JSON 里的会话面板：AI 面板（harness，含未绑定的）+ 任何带 sessionId 的非 AI 面板。
    纯界面面板（git / 搜索 / 文件 / 神经元…）不参与注入，不进台账。 */
function readPanels() {
  const out = []
  let names = []
  try { names = fs.readdirSync(SCEN_DIR).filter((n) => n.toLowerCase().endsWith('.json')) } catch { return out }
  for (const f of names) {
    let j = null
    try { j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8')) } catch { continue }
    const scene = String(j.name || j.id || f.replace(/\.json$/i, ''))
    for (const p of (Array.isArray(j.panels) ? j.panels : [])) {
      if (!p) continue
      // swap 抽屉是「同一格里的另一个常驻会话」（code-dev 的 cd-ai-home），照样注入，不能跳；
      // 纯浮层（right / left / modal：搜索、注入台账自己）才不是常驻会话面板。
      if (p.drawer && p.drawer !== 'swap') continue
      const ai = String(p.type || '') === 'harness'
      if (!ai && !p.sessionId) continue
      out.push({
        kind: 'panel',
        scene,
        panel: String(p.id || ''),
        title: String(p.title || p.id || ''),
        session: String(p.sessionId || ''),
        bound: !!p.sessionId,
        pin: String((p.pinTarget && p.pinTarget[0]) || ''),
        multiProject: !!p.multiProject,
        channel: '',
      })
    }
  }
  return out
}

/** 通道会话（微信 / QQ / 飞书）：不在 scenarios 里，靠 _共享记忆 的映射补归属 */
function readChannels() {
  const out = []
  const seen = new Set()
  const take = (file, channel) => {
    let j = null
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
    const src = (j && j.sessions && typeof j.sessions === 'object') ? j.sessions : (j || {})
    for (const [sid, v] of Object.entries(src)) {
      if (!sid || seen.has(sid) || !v || typeof v !== 'object') continue
      seen.add(sid)
      out.push({
        session: sid,
        scene: String(v.scene || '胡闹的大肥鱼'),
        panel: String(v.panel || ''),
        title: String(v.title || v.chatTitle || sid),
        channel: String(v.channel || channel || ''),
      })
    }
  }
  take(path.join(SHARED, '社交会话.json'), '')
  take(path.join(SHARED, '微信会话.json'), 'wechat')
  return out
}

/* ---------------------------- 聚合 ---------------------------- */

function localDay(iso) {
  const d = new Date(iso)
  if (!d || isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function stamp(iso) {
  const d = new Date(iso)
  if (!d || isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
const TODAY = localDay(new Date().toISOString())

/** 按 scene + panel 聚合流水（jsonl 里没有 sessionId，换会话后仍归同一条面板，这是有意的） */
function groupRows(rows) {
  const map = new Map()
  for (const r of rows) {
    const k = String(r.scene || '') + '\u0000' + String(r.panel || '')
    const g = map.get(k) || { rounds: 0, today: 0, lastIso: '', chars: 0, lastOk: true, lastErr: '', lastMode: '', failed: 0, firstErr: '' }
    g.rounds++
    if (localDay(r.at) === TODAY) g.today++
    if (r.ok === false) {
      g.failed++
      if (!g.firstErr) g.firstErr = String(r.err || '')
    }
    if (String(r.at || '') >= String(g.lastIso || '')) {
      g.lastIso = String(r.at || '')
      g.chars = Number(r.bytes) || 0
      g.lastOk = r.ok !== false
      g.lastErr = String(r.err || '')
      g.lastMode = String(r.mode || '')
    }
    map.set(k, g)
  }
  return map
}

/** 状态口径（界面点色与文案都用这一套，别在渲染层另判）：
    err 最近一轮失败 · ok 今天注入过 · warn 只有历史 · none 有绑定但没记录 · unbound 没绑会话 */
function stateOf(it) {
  if (!it.bound) return 'unbound'
  if (it.failed && !it.lastOk) return 'err'
  if (it.today > 0) return 'ok'
  if (it.rounds > 0) return 'warn'
  return 'none'
}

function buildLedger() {
  const plugin = readPatch()
  const log = readRows()
  const panels = readPanels()
  const g = groupRows(log.rows)
  const items = []

  for (const p of panels) {
    const x = g.get(p.scene + '\u0000' + p.panel) || null
    items.push(Object.assign({}, p, {
      rounds: x ? x.rounds : 0,
      today: x ? x.today : 0,
      lastIso: x ? x.lastIso : '',
      lastAt: x ? stamp(x.lastIso) : '',
      chars: x ? x.chars : 0,
      failed: x ? x.failed : 0,
      lastOk: x ? x.lastOk : true,
      lastMode: x ? x.lastMode : '',
      lastErr: x ? (x.lastErr || x.firstErr || '') : '',
      sessions: p.bound ? 1 : 0,
      titles: [],
    }))
  }

  // 通道会话：同一 scene/panel 的多个聊天会撞成一个 key（jsonl 没有 sessionId），合并展示并附会话数
  const chMap = new Map()
  for (const c of readChannels()) {
    const k = c.scene + '\u0000' + c.panel
    const e = chMap.get(k) || { kind: 'channel', scene: c.scene, panel: c.panel, bound: true, channel: c.channel, pin: '', multiProject: false, sessions: 0, titles: [] }
    e.sessions++
    if (c.title && e.titles.length < 4 && !e.titles.includes(c.title)) e.titles.push(c.title)
    chMap.set(k, e)
  }
  for (const e of chMap.values()) {
    const x = g.get(e.scene + '\u0000' + e.panel) || null
    items.push(Object.assign({}, e, {
      title: e.titles[0] || (e.channel + ' 会话'),
      rounds: x ? x.rounds : 0,
      today: x ? x.today : 0,
      lastIso: x ? x.lastIso : '',
      lastAt: x ? stamp(x.lastIso) : '',
      chars: x ? x.chars : 0,
      failed: x ? x.failed : 0,
      lastOk: x ? x.lastOk : true,
      lastMode: x ? x.lastMode : '',
      lastErr: x ? (x.lastErr || x.firstErr || '') : '',
    }))
  }

  for (const it of items) it.state = stateOf(it)
  // 排序：失败 → 今天注入过 → 有历史 → 绑定但没记录 → 未绑定；同档按最近时间倒序
  const rank = { err: 0, ok: 1, warn: 2, none: 3, unbound: 4 }
  items.sort((a, b) =>
    (rank[a.state] - rank[b.state]) ||
    String(b.lastIso || '').localeCompare(String(a.lastIso || '')) ||
    String(a.scene).localeCompare(String(b.scene)) ||
    String(a.panel).localeCompare(String(b.panel)))

  return {
    ok: true,
    at: new Date().toISOString(),
    home: DSH_HOME,
    log: LOG_FILE,
    plugin,
    totals: {
      rounds: log.rows.length,
      errors: log.rows.filter((r) => r.ok === false).length,
      today: log.rows.filter((r) => localDay(r.at) === TODAY).length,
      panels: items.filter((i) => i.kind === 'panel').length,
      channels: items.filter((i) => i.kind === 'channel').length,
      channelsSessions: items.filter((i) => i.kind === 'channel').reduce((n, i) => n + (i.sessions || 0), 0),
      active: items.filter((i) => i.rounds > 0).length,
      unbound: items.filter((i) => i.state === 'unbound').length,
      badLines: log.bad,
    },
    panels: items,
  }
}

/* ---------------------------- 预览（dry-run） ---------------------------- */

async function runPreview() {
  const scene = argOf('--场景', '')
  if (!scene) throw new Error('预览要指定 --场景（场景名，不是目录名以外的 id）')
  const panel = argOf('--面板', '')
  const query = argOf('--词', '')
  // 插件 dshHome() 先读 env，兜底按「装进 profile」推四级 —— 源码目录布局下对不上，这里显式指定
  process.env.DSH_HOME = DSH_HOME
  if (!fs.existsSync(PLUGIN_SRC)) throw new Error('缺插件源：' + PLUGIN_SRC)
  const mod = await import(pathToFileURL(PLUGIN_SRC).href)
  if (typeof mod.preview !== 'function') throw new Error('插件没有导出 preview ⇒ 先更新 插件\\记忆回响\\index.js')
  const meta = readPanels().filter((p) => p.scene === scene && p.panel === panel)[0] || null
  const hit = {
    scene,
    panel,
    pin: meta ? meta.pin : '',
    multiProject: meta ? meta.multiProject : false,
  }
  const r = mod.preview(hit, query)
  return Object.assign({ ok: true, scene, panel, query, panelTitle: meta ? meta.title : '', pin: hit.pin }, r)
}

/* ---------------------------- 输出 ---------------------------- */

const STATE_TEXT = {
  ok: '今天注入过',
  warn: '只有历史记录',
  err: '最近一轮失败',
  none: '有绑定、没记录',
  unbound: '未绑定会话',
}

function printLedger(d) {
  const t = d.totals
  console.log('记忆回响 · ' + (d.plugin.mode || '未登记') + (d.plugin.installed ? ' · 已装' : ' · 插件文件不在')
    + (d.plugin.registered ? '' : ' · patch 未登记'))
  console.log('累计 ' + t.rounds + ' 轮（失败 ' + t.errors + '）· 今日 ' + t.today + ' 轮 · 有记录 ' + t.active + ' 条'
    + (t.badLines ? ' · 坏行 ' + t.badLines : ''))
  console.log('面板 ' + t.panels + ' 块（未绑定 ' + t.unbound + '）· 通道会话 ' + t.channelsSessions + ' 个（按场景合并 ' + t.channels + ' 条）')
  console.log('日志：' + d.log)
  console.log('')
  for (const it of d.panels) {
    const mark = { ok: '●', warn: '○', err: '✗', none: '·', unbound: '×' }[it.state] || '·'
    const name = it.kind === 'channel'
      ? it.scene + ' / 通道' + (it.channel ? '·' + it.channel : '') + '（' + it.sessions + ' 个会话）'
      : it.scene + ' / ' + (it.panel || '(无面板名)')
    const tail = it.state === 'unbound'
      ? '—— 场景 JSON 里没 sessionId，这轮必然跳过（先换会话或补绑定）'
      : (it.rounds ? (it.rounds + ' 轮 · 今日 ' + it.today + ' · ' + it.lastAt + ' · ' + it.chars + ' 字') : '—— ' + STATE_TEXT[it.state]);
    const sub = (it.kind !== 'channel' && it.title && it.title !== it.panel) ? '「' + it.title + '」  ' : ''
    console.log(mark + ' ' + name + '  ' + sub + tail);
    if (it.lastErr) console.log('    ! ' + it.lastErr);
  }
  console.log('');
  console.log('看某个面板此刻会注入什么：node 工具\\记忆注入台账.mjs 预览 --场景 "程序开发" --面板 "cd-ai" --词 "你这轮说的话"');
}

function printPreview(d) {
  const hasProject = d.parts.some((p) => /^项目记忆/.test(p.title))
  console.log('场景 ' + d.scene + ' · 面板 ' + (d.panel || '—') + (d.panelTitle ? '（' + d.panelTitle + '）' : '')
    + (hasProject ? ' · 项目 ' + d.pin : ' · 不掺项目'))
  console.log('关键词（本轮用户话）：' + (d.query || '—'))
  console.log('共 ' + d.chars + ' 字 / ' + (d.bytes / 1024).toFixed(1) + ' KB'
    + (d.truncated ? ' · ⚠ 已按上限截断（人格 5600 / 业务 4000 字）' : ' · 未截断（人格 5600 / 业务 4000 字）'))
  if (!d.chars) {
    console.log('⇒ 这个面板此刻不会注入：场景记忆里没有 §〇 / 面板交接 / 人格卡 / 项目绑定，插件会退回 next()。')
    return
  }
  console.log('')
  for (const p of d.parts) console.log('  ' + p.label + '  ' + p.chars + ' 字 / ' + p.bytes + ' B')
  console.log('')
  console.log('---------- 以下为会进上下文的全文 ----------')
  console.log(d.text)
}

async function main() {
  if (ACTION === '预览') {
    const r = await runPreview()
    if (AS_JSON) console.log(JSON.stringify(r));
    else printPreview(r);
    return;
  }
  if (ACTION !== '台账') throw new Error('只认「台账」和「预览」两个动作：' + ACTION)
  const d = buildLedger()
  if (AS_JSON) console.log(JSON.stringify(d));
  else printLedger(d);
}

main().catch((e) => {
  const err = String((e && e.message) || e)
  if (AS_JSON) console.log(JSON.stringify({ ok: false, err }))
  else console.error('✗ ' + err)
  process.exit(1)
})
