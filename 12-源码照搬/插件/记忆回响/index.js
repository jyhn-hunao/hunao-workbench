// 记忆回响 —— DSH 引擎插件：每轮用户发言前，把本场景的记忆注入成一条上下文。
//
// 为什么需要它（2026-11-13）：原来记忆只在 `换会话` 时注入一次（sessions.mjs 的 seed），
// 长会话里新写的记忆当前会话根本看不到 —— "有记忆但想不起来"。规范说"每轮开场必读"，
// 但没有任何运行时强制。挂载点：`agent/pre-step`（每步组装提示词前，返回的 messages 会进上下文）。
//
// 数据来源：<DSH_HOME>/场景记忆/<场景>/ 场景私有记忆.md §〇 + _近期.md + _索引.json 命中条目；
//           面板绑定了当前项目时，再读 <项目根>\memory\_索引.json 与项目薄卡（2026-11-20 自动项目召回）。
// 失败绝不阻断对话：任何异常都退回 next() 的原结果，只记一行日志。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'memory-recall'

/** 自检 / 回归时置 1：只算注入文本，不写启动日志、注入流水与项目召回流水 */
const NO_LOG = !!process.env.DSH_MEMORY_RECALL_NO_LOG

/** 人格场景：§〇 就是人格卡，必须整张进上下文（≤4 KB），不走「保尾截断」 */
const PERSONA_SCENES = new Set(['胡闹的大肥鱼', 'pet'])
function isPersona(scene) {
  return PERSONA_SCENES.has(String(scene || ''))
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || ''
  if (fromEnv) return fromEnv
  // 兜底：插件装在 <DSH_HOME>/profiles/<profile>/node_modules/dsh-memory-recall ⇒ 向上四级就是 DSH_HOME
  try { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..') } catch { return '' }
}

function memRoot() {
  return path.join(dshHome(), '场景记忆')
}

// 每轮注入留一条机器可读记录（2026-11-20）：
//   原来只有 server.log / 启动自证一行，界面看不到「这一轮到底注入了什么、多少字节」。
//   只记场景/面板/模式/字节，不记正文（正文里可能有人格卡与项目信息）。
function noteInject(hit, mode, bytes, err) {
  if (NO_LOG) return
  try {
    const dir = path.join(dshHome(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const rec = {
      at: new Date().toISOString(),
      scene: (hit && hit.scene) || '',
      panel: (hit && hit.panel) || '',
      mode: mode,
      bytes: bytes || 0,
      ok: !err,
    }
    if (err) rec.err = String((err && err.message) || err).slice(0, 120)
    fs.appendFileSync(path.join(dir, 'memory-recall.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
  } catch { /* 记录写不进不影响注入 */ }
}

// DSH_HOME = <workbench>/12-源码照搬/引擎数据/.dsh ⇒ ../../外壳/scenarios
function scenariosDir() {
  return path.join(dshHome(), '..', '..', '外壳', 'scenarios')
}

let mapCache = { at: 0, data: null, forcedAt: 0 }
let wxMapCache = { at: 0, data: null }
let socialMapCache = { at: 0, data: null }
let projRegCache = { at: 0, data: [] }
const projIdxCache = new Map()

/** 通用社交会话总表（微信 / QQ / 飞书共用）：
    外壳写 <DSH_HOME>/场景记忆/_共享记忆/社交会话.json，结构是 sessionId -> {scene,panel,channel,...}。
    这是通道无关的归属源；旧微信映射继续兜底，升级前已建的会话不会丢人格。 */
function socialSessionMap() {
  const now = Date.now()
  if (socialMapCache.data && now - socialMapCache.at < 5000) return socialMapCache.data
  const out = {}
  try {
    const f = path.join(memRoot(), '_共享记忆', '社交会话.json')
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      const src = j && j.sessions && typeof j.sessions === 'object' ? j.sessions : (j || {})
      for (const [sid, v] of Object.entries(src)) {
        if (!sid || !v || typeof v !== 'object') continue
        out[sid] = {
          scene: String(v.scene || '胡闹的大肥鱼'),
          panel: String(v.panel || '')
        }
      }
    }
  } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[memory-recall] read social session map failed', e)
  }
  socialMapCache = { at: now, data: out }
  return out
}

/** 微信通道按聊天动态建的会话不写在 scenarios/*.json 里；外壳把映射写到
    <DSH_HOME>/场景记忆/_共享记忆/微信会话.json。这里 5 秒读一次，给这些会话补上
    人格场景归属，否则新群/新私聊会变成没有「胡闹的大肥鱼」人格卡的通用 agent。 */
function wxSessionMap() {
  const now = Date.now()
  if (wxMapCache.data && now - wxMapCache.at < 5000) return wxMapCache.data
  const out = {}
  try {
    const f = path.join(memRoot(), '_共享记忆', '微信会话.json')
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      for (const [sid, v] of Object.entries(j || {})) {
        if (!sid || !v || typeof v !== 'object') continue
        out[sid] = {
          scene: String(v.scene || '胡闹的大肥鱼'),
          panel: String(v.panel || ''),
          wx: true
        }
      }
    }
  } catch { /* 文件还没写 / 正在写：本轮按无映射走，下一轮再读 */ }
  wxMapCache = { at: now, data: out }
  return out
}

/** 同一条会话挂多个面板时的归属优先级：AI 对话面板 > 业务看板 > 只读流转 / 通道卡
    「胡闹的大肥鱼」既是 pet-ai（harness），又挂在社交的 so-msg（msgflow）上；
    不排优先级就按文件名顺序被 social 覆盖，注入的是社交 §〇 而不是人格卡 */
function panelRank(p) {
  const t = String((p && p.type) || '')
  if (t === 'harness') return 3
  if (t === 'msgflow' || t === 'chan') return 1
  return 2
}

/** sessionId → { scene, panel }；scenario JSON 是唯一真源，缓存 30 秒
//  force=true 立即重建：换会话刚建好的 id 可能还不在 30 秒缓存里（见 sceneOf） */
function sessionMap(force) {
  const now = Date.now()
  if (!force && mapCache.data && now - mapCache.at < 30000) return mapCache.data
  const out = {}
  try {
    for (const f of fs.readdirSync(scenariosDir()).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(scenariosDir(), f), 'utf8'))
      const scene = String(j.name || j.id || f.replace(/\.json$/, ''))
      for (const p of j.panels || []) {
        if (!p || !p.sessionId) continue
        const sid = String(p.sessionId)
        const rank = panelRank(p)
        const prev = out[sid]
        if (!prev || rank > prev.rank) out[sid] = { scene, panel: String(p.id || ''), rank, pin: String((p.pinTarget && p.pinTarget[0]) || ''), multiProject: !!p.multiProject }
      }
    }
  } catch { /* 读不到就当作没绑定 */ }
  mapCache = { at: now, data: out, forcedAt: mapCache.forcedAt || 0 }
  return out
}

/* --------------------- 项目记忆自动召回（2026-11-20） ---------------------
   场景层已经每轮注入，但项目层原来只靠模型自觉跑 `记忆.mjs recall`：
   mlw 35 篇 82.6 KB，2026-11-20 体检时 `memory\_召回.log` 根本不存在 ——
   记忆一直在写，却从没被按需读。这里把「读项目记忆」变成每轮的硬动作：
   面板 pinTarget 首项 → _共享记忆\项目.json → 项目根\memory，
   薄卡当前状态必带，索引命中最多 3 条（只给指针，不灌全文）。 */

/** 项目登记表：<DSH_HOME>/场景记忆/_共享记忆/项目.json（缓存 5 秒，换项目能很快跟上） */
function projectRegistry() {
  const now = Date.now()
  if (projRegCache.data && now - projRegCache.at < 5000) return projRegCache.data
  let list = []
  try {
    const j = JSON.parse(fs.readFileSync(path.join(memRoot(), '_共享记忆', '项目.json'), 'utf8'))
    list = Array.isArray(j.projects) ? j.projects : []
  } catch { list = [] }
  projRegCache = { at: now, data: list }
  return list
}

/** 面板 → 当前项目：pinTarget 首项按名字/别名匹配；不唯一、没登记 memoryRoot、没索引都不猜 */
function projectOf(hit) {
  const pin = String((hit && hit.pin) || '').trim()
  if (!pin) return null
  const matches = projectRegistry().filter((p) => {
    if (!p || !p.memoryRoot) return false
    const names = [String(p.name || '')].concat(Array.isArray(p.aliases) ? p.aliases.map(String) : [])
    return names.includes(pin)
  })
  if (matches.length !== 1) return null
  const p = matches[0]
  const mem = path.join(String(p.memoryRoot), 'memory')
  if (!fs.existsSync(path.join(mem, '_索引.json'))) return null
  return { name: String(p.name || pin), root: String(p.memoryRoot), mem, card: String(p.memory || '') }
}

/** 多项目管理面板：不绑单一项目，但每轮给它一份「可派发的项目名单」；
    只列 name / aliases，路径与记忆根仍以项目注册表为准，不复制整张表。 */
function projectRegistryBlock() {
  const list = projectRegistry()
  if (!list.length) return ''
  const lines = ['## 项目注册表（多项目管理 · 派发前先认名字）']
  for (const p of list.slice(0, 8)) {
    const name = String(p.name || '').trim()
    if (!name) continue
    const aliases = (Array.isArray(p.aliases) ? p.aliases : []).map(String).filter(Boolean)
    lines.push('- ' + name + (aliases.length ? '（别名：' + aliases.join('、') + '）' : ''))
  }
  lines.push('（完整路径 / 记忆根见 `' + path.join(memRoot(), '_共享记忆', '项目.json').replace(/\\/g, '/') + '`；只认 name / aliases，不猜目录名）')
  return lines.join('\n')
}

/** 项目索引比任一正文 .md 旧 = 过期（新增/编辑的记忆没进索引，召回会漏、会喂旧正文） */
function projectIndexStale(mem, idxMtime) {
  try {
    const walk = (dir) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
      for (const e of entries) {
        if (e.name === 'archive' || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (walk(p)) return true; continue }
        if (!e.name.endsWith('.md')) continue
        if (e.name === 'README.md' || e.name === 'MEMORY_INDEX.md') continue
        try { if (fs.statSync(p).mtimeMs > idxMtime) return true } catch { /* 读到半截不算过期 */ }
      }
      return false
    }
    return walk(mem)
  } catch { return false }
}

/** 项目索引按 mtime+size 缓存：mlw 35 篇约 109 KB，不能每轮重读重解析。
//  2026-11-24 自愈：索引过期就当场重建（记忆全自动，不许等手动 index）。 */
function projectIndex(project) {
  const file = path.join(project.mem, '_索引.json')
  // 与 scenariosDir() 同一套约定：DSH_HOME/../../ 即 12-源码照搬（开发布局）
  const tool = path.join(dshHome(), '..', '..', '工具', '记忆.mjs')
  const rebuild = () => {
    try {
      spawnSync(process.execPath || 'node', [tool, 'index', '--project', String(project.root || '')], { timeout: 20000, windowsHide: true, stdio: 'ignore' })
    } catch { /* 自愈失败退回旧索引，绝不阻断对话 */ }
  }
  let st
  try { st = fs.statSync(file) } catch { rebuild(); try { st = fs.statSync(file) } catch { return [] } }
  if (st && projectIndexStale(project.mem, st.mtimeMs)) {
    rebuild()
    try { st = fs.statSync(file) } catch { /* 保留旧 st，下面仍用旧索引兜底 */ }
  }
  const cur = projIdxCache.get(file)
  if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) return cur.docs
  let docs = []
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    docs = Array.isArray(j.docs) ? j.docs : []
  } catch { docs = [] }
  if (projIdxCache.size > 20) projIdxCache.clear()
  projIdxCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, docs })
  return docs
}

/** 场景索引比任一被索引的 .md 旧 = 过期。被索引范围：KINDS 类目 + 记忆/ + 定论/ + 归档/；
//  场景私有记忆 / 身份卡 / 场景画像 / _文件索引 / _近期 / 面板交接 不进索引，故不参与判断。 */
function sceneIndexStale(sceneDir, idxMtime) {
  const skipDir = new Set(['面板交接'])
  const skipFile = new Set(['场景私有记忆.md', '身份卡.md', '场景画像.md', '_文件索引.md', '_近期.md', 'README.md'])
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
    for (const e of entries) {
      if (e.name.startsWith('.') || skipDir.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (walk(p)) return true; continue }
      if (!e.name.endsWith('.md')) continue
      if (skipFile.has(e.name)) continue
      try { if (fs.statSync(p).mtimeMs > idxMtime) return true } catch { /* 读到半截不算 */ }
    }
    return false
  }
  return walk(sceneDir)
}

/** 与 工具\记忆.mjs 的 tokenize 同口径：中文二字词 + 英文/数字词 */
function projGrams(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  for (const w of s.match(/[a-z0-9][a-z0-9_.\-/]{1,}/g) || []) out.add(w)
  return [...out]
}

/** 项目 _词表.json 的同义词扩展；空词表就等同不扩（不阻断召回） */
function expandProjTokens(tokens, project) {
  const out = new Set(tokens)
  let lex = {}
  try { lex = JSON.parse(fs.readFileSync(path.join(project.mem, '_词表.json'), 'utf8')) || {} } catch { lex = {} }
  for (const t of tokens) {
    const v = lex[t]
    if (Array.isArray(v)) v.forEach((x) => projGrams(x).forEach((y) => out.add(y)))
    for (const [k, arr] of Object.entries(lex)) {
      if (Array.isArray(arr) && arr.some((x) => String(x).toLowerCase().includes(t))) projGrams(k).forEach((y) => out.add(y))
    }
  }
  return [...out]
}

const PROJ_WEIGHT = { title: 5, tags: 4, headings: 3, description: 2, body: 1 }

function scoreProjectDoc(doc, tokens) {
  const fields = {
    title: String(doc.title || '').toLowerCase(),
    tags: (Array.isArray(doc.tags) ? doc.tags.join(' ') : '').toLowerCase(),
    headings: (Array.isArray(doc.headings) ? doc.headings.join(' ') : '').toLowerCase(),
    description: String(doc.description || '').toLowerCase(),
    body: String(doc.body || '').toLowerCase(),
  }
  let score = 0
  let hit = 0
  let titleHit = false
  for (const t of tokens) {
    let any = false
    for (const [name, hay] of Object.entries(fields)) {
      let c = 0
      let i = hay.indexOf(t)
      while (i >= 0) { c++; i = hay.indexOf(t, i + t.length) }
      if (!c) continue
      any = true
      score += c * PROJ_WEIGHT[name]
      if (name === 'title') titleHit = true
    }
    if (any) hit++
  }
  if (!hit) return null
  return { score, hit, titleHit }
}

/** 只收「标题命中」或「≥2 个词同现」且分数 ≥2 的条目，压掉一个通用二字词造成的噪声 */
function projectRecall(project, query, limit = 3) {
  const docs = projectIndex(project)
  if (!docs.length || !String(query || '').trim()) return { total: docs.length, hits: [] }
  const tokens = expandProjTokens(projGrams(query), project)
  if (!tokens.length) return { total: docs.length, hits: [] }
  const hits = []
  for (const doc of docs) {
    const s = scoreProjectDoc(doc, tokens)
    if (!s || !(s.titleHit || s.hit >= 2) || s.score < 2) continue
    hits.push({ doc, score: s.score })
  }
  hits.sort((a, b) => b.score - a.score || String(b.doc.date || '').localeCompare(String(a.doc.date || '')))
  return { total: docs.length, hits: hits.slice(0, limit) }
}

/** 项目薄卡的「当前状态」最多 3 行、260 字：每轮都有个落脚点，但别把薄卡整张灌进去 */
function projectStatus(project, maxChars = 260) {
  let raw = ''
  try { raw = fs.readFileSync(project.card, 'utf8') } catch { return '' }
  const i = raw.indexOf('## 当前状态')
  if (i < 0) return ''
  const j = raw.indexOf('\n## ', i + 5)
  const body = raw.slice(i, j > 0 ? j : undefined).replace(/^##[^\r\n]*\r?\n+/, '').trim()
  return body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join('\n').slice(0, maxChars)
}

/** 自动召回也记流水（auto=1）：体检的「召回活性」从此反映真实读取，不再只认手动命令 */
function logProjectRecall(project, q, hits, total, top) {
  if (NO_LOG) return
  try {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const at = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    const one = (s) => String(s || '').replace(/[\r\n|]/g, ' ').slice(0, 60)
    const line = [at, project.name, 'q="' + one(q) + '"', 'hit=' + hits + '/' + total, 'filtered=0',
      'top=' + (top.slice(0, 3).map((x) => String(x).replace(/\\/g, '/')).join(',') || '-'), 'auto=1'].join(' | ')
    const file = path.join(project.mem, '_召回.log')
    fs.appendFileSync(file, line + '\n', 'utf8')
    // 每轮一条会涨；超过 60 KB 只留最近 300 行，够体检看日期与命中
    const st = fs.statSync(file)
    if (st.size > 60 * 1024) {
      const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      if (rows.length > 300) fs.writeFileSync(file, rows.slice(-300).join('\n') + '\n', 'utf8')
    }
  } catch { /* 流水写不进不影响注入 */ }
}

/** 项目块：薄卡当前状态（必带）+ 本轮命中条目（只给指针，不灌全文）
 *  路径相对项目根（面板会话 cwd = 项目根），比三条绝对路径省一半字符。 */
function projectBlock(project, query) {
  const status = projectStatus(project)
  const { total, hits } = projectRecall(project, query)
  logProjectRecall(project, query, hits.length, total, hits.map((h) => String(h.doc.path || '')))
  if (!status && !hits.length) return ''
  const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''))
  const lines = ['## 项目记忆（自动召回 · ' + project.name + '，根：' + String(project.root).replace(/\\/g, '/') + '）']
  if (status) lines.push('**当前状态**', status)
  if (hits.length) {
    lines.push('', '**本轮相关条目**（标题即结论；路径相对项目根）')
    hits.forEach((h) => {
      const d = h.doc
      lines.push('- ' + String(d.date || '').slice(0, 10) + ' ' + String(d.category || '') + ' · ' + cut(d.title, 56)
        + ' → `memory/' + String(d.path || '').replace(/\\/g, '/') + '`')
    })
  } else {
    lines.push('', '（本轮没有够格的项目记忆条目；要细节再用 `记忆.mjs recall`）')
  }
  return lines.join('\n')
}

/** 会话 id：引擎 0.2.1 起 Agent 上没有 sessionId，改挂在 agent.session.id（agent.id 兜底） */
function sessionIdOf(agent) {
  if (!agent) return ''
  for (const v of [agent.sessionId, agent.session && agent.session.id, agent.id]) {
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function sceneOf(agent) {
  const sid = sessionIdOf(agent)
  if (!sid) return null
  const hit = sessionMap()[sid]
  if (hit) return hit
  // 通用社交总表优先：微信 / QQ / 飞书都从这一张表补人格归属；旧微信映射兜底。
  const social = socialSessionMap()[sid]
  if (social) return social
  const wx = wxSessionMap()[sid]
  if (wx) return wx
  // 换会话刚建好时 scenario JSON 已回写，但本对象可能还停在 30 秒缓存里 ⇒ 强制重建一次。
  // 未绑定面板的会话（临时会话/闲谈）也走这里，最多 5 秒重建一次，避免每个工具步都读盘。
  const now = Date.now()
  if (now - mapCache.forcedAt > 5000) {
    mapCache.forcedAt = now
    return sessionMap(true)[sid] || null
  }
  return null
}

/** 去掉派生文件头（`# 标题`、`>` 说明行），只留正文 */
function stripHead(text) {
  const lines = String(text || '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && (!lines[i].trim() || /^[#>]/.test(lines[i].trim()))) i++
  return lines.slice(i).join('\n').trim()
}

/** 近期只注入未完成事项：长期/对话摘要由 related 按需命中，避免每轮重复。
 *  文件本身仍保留完整内容，工具和「读」还能查；这里只收窄注入面。 */
function compactRecent(text) {
  const t = stripHead(text)
  const i = t.indexOf('## 答应没办')
  return i >= 0 ? t.slice(i).trim() : ''
}

/** 取 §〇：从 `## §〇` 到下一个同级标题；没有就退回文件前 1.2 KB */
function sectionZero(text) {
  const i = text.indexOf('## §〇')
  if (i < 0) return stripHead(text).slice(0, 1200)
  const j = text.indexOf('\n## ', i + 5)
  const body = text.slice(i, j > 0 ? j : undefined).trim()
  return body.replace(/^##\s*§〇[^\r\n]*\r?\n+/, '')
}

/** §〇 截断保尾（2026-11-14）：「下一步·卡点」在 §〇 末尾，头截会把最要紧的先截掉 */
function tailOf(text, n) {
  const t = String(text || '')
  if (Buffer.byteLength(t, 'utf8') <= n) return t
  const head = Buffer.from(t, 'utf8').subarray(0, 120).toString('utf8').replace(/\uFFFD$/, '')
  const tail = Buffer.from(t, 'utf8').subarray(-(n - Buffer.byteLength(head, 'utf8') - 40)).toString('utf8').replace(/^\uFFFD+/, '')
  return head + '\n…（§〇 中段省略，保留末尾「下一步·卡点」；全文用 场景记忆.mjs 读）…\n' + tail
}

/** 头截：人格卡整张要进上下文，按字节上限切，别切出半个汉字（切掉才提示去哪里读全文） */
function headOf(text, n) {
  const t = String(text || '')
  if (Buffer.byteLength(t, 'utf8') <= n) return t
  const cut = Buffer.from(t, 'utf8').subarray(0, n).toString('utf8').replace(/\uFFFD+$/, '')
  return cut.trimEnd() + '\n…（人格卡后段省略；全文用 场景记忆.mjs 读 --场景 胡闹的大肥鱼 --节 §〇）…'
}

/** 面板交接：取「面板职责」「这次在做」「下一步 / 卡点」三节；都没有才退回文件尾 maxBytes
//  换会话不再往会话里塞开场消息（2026-11-17）⇒ 交接改由本插件每轮注入。
//  不整篇灌：全文常带「记忆联动」一串绝对路径，每轮占预算但没有当轮价值。 */
function panelHandoff(scene, panel, maxBytes = 700) {
  if (!panel) return ''
  const p = path.join(memRoot(), scene, '面板交接', String(panel) + '.md')
  let raw = ''
  try { raw = fs.readFileSync(p, 'utf8') } catch { return '' }
  const section = (name) => {
    const i = raw.indexOf('## ' + name)
    if (i < 0) return ''
    const j = raw.indexOf('\n## ', i + 5)
    return raw.slice(i, j > 0 ? j : undefined).trim()
  }
  const parts = [section('面板职责'), section('这次在做'), section('下一步 / 卡点')].filter(Boolean)
  const body = parts.length ? parts.join('\n\n') : tailOf(stripHead(raw), maxBytes)
  return body.replace(/^## /gm, '### ').slice(0, maxBytes)
}

/** 用户这轮说的话（兼容 content 是字符串或 [{type:'text',text}]） */
function userText(messages) {
  const parts = []
  for (const m of messages || []) {
    if (!m || (m.role && m.role !== 'user')) continue
    const c = m.content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) c.forEach((x) => { if (x && x.type === 'text' && x.text) parts.push(String(x.text)) })
  }
  return parts.join('\n')
}

function grams(s) {
  const out = new Set()
  for (const r of String(s || '').toLowerCase().match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < r.length - 1; i++) out.add(r.slice(i, i + 2))
  }
  for (const w of String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) || []) out.add(w)
  return out
}

/** 从 _索引.json 里挑和本轮问题最相关的 3 条：先标题/标签，没命中再退回正文前 2 KB
//  2026-11-14：归档条目与 expires 已过的条目不参与注入——半记得的不主动喂，过期的该失效 */
function related(sceneDir, query, limit = 3) {
  const today = new Date().toISOString().slice(0, 10)
  const usable = (e) => String(e.kind) !== '归档' && (!e.expires || String(e.expires) >= today)
  // 2026-11-24 自愈：场景索引过期先重建再召回（与项目记忆同一条「全自动」口径）
  const idxFile = path.join(sceneDir, '_索引.json')
  let idxMtime = 0
  try { idxMtime = fs.statSync(idxFile).mtimeMs } catch { /* 没有索引，下面尝试重建 */ }
  if (!idxMtime || sceneIndexStale(sceneDir, idxMtime)) {
    try {
      const tool = path.join(dshHome(), '..', '..', '工具', '场景记忆.mjs')
      spawnSync(process.execPath || 'node', [tool, '索引', '--场景', path.basename(sceneDir)], { timeout: 20000, windowsHide: true, stdio: 'ignore' })
    } catch { /* 自愈失败退回旧索引，绝不阻断对话 */ }
  }
  try {
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'))
    const list = Array.isArray(idx.entries) ? idx.entries : []
    const q = grams(query)
    if (!q.size) return []
    const byTitle = list.map((e) => {
      if (!usable(e)) return { e: null, hit: 0 }
      const t = grams(String(e.title || '') + ' ' + (e.tags || []).join(' '))
      let hit = 0
      q.forEach((g) => { if (t.has(g)) hit++ })
      return { e, hit }
    }).filter((x) => x.e && x.hit > 0).sort((a, b) => b.hit - a.hit).slice(0, limit)
    if (byTitle.length) return byTitle.map((x) => x.e)
    // 标题没命中：正文前 2 KB 兜底（只在没有标题命中时做，别每轮读全量）
    const out = []
    for (const e of list.slice(0, 60)) {
      if (!usable(e)) continue
      let txt = ''
      try { txt = fs.readFileSync(path.join(sceneDir, String(e.path || '')), 'utf8').slice(0, 2000) } catch { continue }
      let hit = 0
      q.forEach((g) => { if (txt.includes(g)) hit++ })
      if (hit >= 2) out.push({ e, hit })
    }
    return out.sort((a, b) => b.hit - a.hit).slice(0, limit).map((x) => x.e)
  } catch { return [] }
}

/** 设置弹窗的当前值：设置.json 覆盖 设置.默认.json（与 桌宠设置.js 同一套口径，插件不另存） */
function petSettingsOf() {
  const shell = path.resolve(dshHome(), '..', '..', '外壳')
  const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {} } catch { return {} } }
  return { def: rd(path.join(shell, 'pet', '设置.默认.json')), cur: rd(path.join(shell, 'data', 'pet', '设置.json')) }
}

/** 主动度 → 人话（设置里存 low / normal / high，模型看要能直接照做） */
const PROACTIVE_TEXT = {
  low: '少吭声 —— 只答不说，没被问就不主动开口',
  normal: '有事才说 —— 该提醒就提醒，不闲聊',
  high: '会主动找你 —— 想到就说，仍受免打扰约束'
}

/** 她怎么自称：名字（selfName）和场景定位（name）分开，定位用于记忆目录/会话归属，名字进开口。 */
function petSelfName(scene) {
  try {
    if (!isPersona(scene)) return ''
    const { def, cur } = petSettingsOf()
    const a = def.persona || {}, b = cur.persona || {}
    if (String(b.name || a.name || '') !== String(scene)) return ''
    return String(b.selfName || a.selfName || b.name || a.name || scene).trim()
  } catch { return '' }
}

/** 设置弹窗里的「人格卡五块」：identity / personality / speech / care / never（另加主动度）
//  2026-11-18：这四块原来只在换会话的 seed 里用，而 seed 默认已关 ⇒ 面板上改了等于白改；改成每轮注入才真生效
//  同日补：原卡只有「我是谁 / 说话 / 在意 / 绝不」，没有「性格」这一维 —— 脾气、喜恶、遇事先怎么反应没人写，人格自然立不住 */
function petPersonaBlock(scene) {
  try {
    if (!isPersona(scene)) return ''
    const { def, cur } = petSettingsOf()
    const a = def.persona || {}, b = cur.persona || {}
    if (String(b.name || a.name || '') !== String(scene)) return ''
    const out = []
    for (const [k, label] of [['identity', '我是谁'], ['personality', '性格'], ['speech', '说话'], ['reactions', '遇到消息先怎么接'], ['counterExamples', '不要这样回'], ['care', '我在意什么'], ['never', '我绝不会']]) {
      const v = String(b[k] || a[k] || '').trim()
      if (v) out.push('【' + label + '】' + v)
    }
    const pr = String(b.proactive || a.proactive || '').trim()
    if (pr) out.push('【主动度】' + (PROACTIVE_TEXT[pr] || pr))
    return out.length ? '（与下面 §〇 冲突时以这一段为准）\n' + out.join('\n') : ''
  } catch { return '' }
}

const PET_TOOL_LABEL = {
  scene_memory_read: '读场景记忆（只读）', memory_recall: '翻项目记忆', memory_write: '写记忆',
  dispatch: '派活给别的场景', receipt: '回收执', file_read: '读本地文件',
  shell: '跑命令行', git_push: '推送代码', http_post: '对外发请求'
}

/** 能力边界：派活由壳层硬拦（桌宠.mjs 白名单），其余项是口径（引擎里的工具壳拦不住，别装成硬门） */
function petToolsBlock(scene) {
  try {
    if (!isPersona(scene)) return ''
    const { def, cur } = petSettingsOf()
    const t = Object.assign({}, def.tools || {}, cur.tools || {})
    const label = (id) => PET_TOOL_LABEL[id] || String(id)
    const allow = (t.allow || []).map(label)
    const deny = (t.deny || []).map(label)
    if (!allow.length && !deny.length) return ''
    return '### 能力边界（设置弹窗）\n- 允许：' + (allow.length ? allow.join('、') : '（无）') +
      '\n- 永远不做：' + (deny.length ? deny.join('、') : '（无）') +
      '\n- 「派活给别的场景」是壳层硬门，其余靠你按这条口径自律'
  } catch { return '' }
}

/** 预算溢出时不要硬切尾巴：人格卡、能力边界在头，收工规则在尾，先保这三头。
 *  业务场景当前约 2–3 KB；只有面板交接/近期/项目条目突然变长时才会走到这里。 */
function fitText(text, maxChars = 4000) {
  const t = String(text || '')
  if (t.length <= maxChars) return t
  const notice = '\n…（中段省略：优先保留人格卡、能力边界与收工规则）…\n'
  const tailChars = Math.min(360, Math.max(0, maxChars - notice.length - 200))
  const headChars = Math.max(0, maxChars - notice.length - tailChars)
  let head = t.slice(0, headChars)
  const headCut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('。'))
  if (headCut >= Math.floor(headChars * 0.7)) head = head.slice(0, headCut + 1)
  let tail = tailChars > 0 ? t.slice(-tailChars) : ''
  const tailStart = Math.max(tail.indexOf('\n'), tail.indexOf('。'))
  if (tailStart > 0 && tailStart < Math.floor(tailChars * 0.3)) tail = tail.slice(tailStart + 1)
  return head + notice + tail
}

/** 手有什么（2026-11-25）：大脑要知道每双手能干什么、现在怎么干。
 *  数据源 = 外壳\data\场景能力.json（`场景能力.mjs 生成` 从 外壳\场景能力.js 的 MECHANISMS 同步）；
 *  每轮只列「场景 · 一句机制」，本轮消息命中某场景关键词再展开该场景全部机制。 */
/** 场景能力目录：优先读 `外壳\data\场景能力.json`（本机派生、gitignore 掉了）；
 *  换机器 / 安装版首次没有这个文件，就退回读 `scenarios\_场景能力.md`（随 git 走、格式固定），
 *  别让「手有什么」整块静默消失。 */
function capIndex(shell) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(shell, 'data', '场景能力.json'), 'utf8'))
    if (j && (j.scenes || []).length) return j.scenes
  } catch (e) { /* 落 md 兜底 */ }
  try {
    const txt = fs.readFileSync(path.join(shell, 'scenarios', '_场景能力.md'), 'utf8')
    const out = []
    const cells = (b, k) => {
      const line = b.split(/\r?\n/).find((l) => l.startsWith('| ' + k + ' |'))
      return line ? line.split('|')[2].trim() : ''
    }
    for (const b of txt.split(/^## /m).slice(1)) {
      const head = b.split(/\r?\n/)[0].trim()
      const idm = head.match(/`([^`]+)`/)
      const mech = cells(b, '机制').split('<br>').map((s) => s.trim()).filter(Boolean)
      if (!mech.length) continue
      out.push({
        id: idm ? idm[1] : head,
        name: head.replace(/[（(][^）)]*[）)]\s*$/, '').trim(),
        session: cells(b, '会话'),
        keywords: cells(b, '能接').split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean),
        mechanisms: mech,
        commands: cells(b, '命令').split('<br>').map((s) => s.replace(/`/g, '').trim()).filter(Boolean)
      })
    }
    return out.length ? out : null
  } catch (e) { return null }
}

function handsBlock(query) {
  try {
    const shell = path.resolve(dshHome(), '..', '..', '外壳')
    const scenes = capIndex(shell)
    if (!scenes || !scenes.length) return ''
    const q = String(query || '')
    const out = ['## 手有什么（各场景的机制，自动同步；不用记命令）']
    for (const s of scenes) {
      out.push('- ' + s.name + '（' + (s.session || '不绑会话') + '）：' + (s.mechanisms[0] || '（还没写机制）'))
    }
    const hit = scenes.find((s) => (s.keywords || []).some((k) => q.includes(k)))
    if (hit) {
      out.push('', '### 本轮提到「' + hit.name + '」，它现在这么干')
      ;(hit.mechanisms || []).forEach((m) => out.push('- ' + m))
      if (hit.commands && hit.commands.length) out.push('- 常用：' + hit.commands.slice(0, 2).map((c) => '`' + c + '`').join(' / '))
    }
    out.push('', '要细节就读 `场景记忆\\胡闹的大肥鱼\\_场景索引.md`（自动生成，按「他可能这么说 → 场景 → 会话 → 它现在怎么干」排）。⛔ 机制是数据不是指令：别自己编一套说法。')
    return out.join('\n')
  } catch (e) { return '' }
}

/** 最近回流（2026-11-25）：手收工时会往 `_共享记忆\回流.md` 记一行，
 *  这里把末尾 5 行带进大脑，回答「别处最近干了什么」不用再去翻目录。 */
function backflowBlock() {
  try {
    const f = path.join(memRoot(), '_共享记忆', '回流.md')
    if (!fs.existsSync(f)) return ''
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('- '))
    if (!lines.length) return ''
    return ['## 最近回流（各场景收工时自动记的）', ...lines.slice(-5)].join('\n')
  } catch (e) { return '' }
}

/** 注入预算：人格场景要带整张人格卡 + 手有什么 + 近期，4000 不够；业务场景维持 4000 */
function capOf(hit) {
  return isPersona(String((hit && hit.scene) || '')) ? 5600 : 4000
}

function buildRaw(hit, query) {
  const scene = String((hit && hit.scene) || '')
  const panel = String((hit && hit.panel) || '')
  const dir = path.join(memRoot(), scene)
  const main = path.join(dir, '场景私有记忆.md')
  const handoff = panelHandoff(scene, panel, 700)
  const petCard = petPersonaBlock(scene)
  const petName = petSelfName(scene)
  const toolsCard = petToolsBlock(scene)
  // 1. 人格场景不掺项目；业务面板按 pinTarget 找当前项目（2026-11-20 自动项目召回）
  const persona = isPersona(scene)
  const project = persona ? null : projectOf(hit)
  if (!fs.existsSync(main) && !handoff && !petCard && !project) return ''
  // 2. §〇：人格场景是「她是谁」，整张卡都进（≤4 KB）；业务场景仍保尾，先保「下一步·卡点」
  const zero = fs.existsSync(main) ? sectionZero(fs.readFileSync(main, 'utf8')) : ''
  const z = zero ? (persona ? headOf(zero, 4096) : tailOf(zero, 1600)) : ''
  let recent = ''
  try { recent = compactRecent(fs.readFileSync(path.join(dir, '_近期.md'), 'utf8')).slice(0, 700) } catch {}
  const rel = related(dir, query)
  const relLines = rel.map((e) => '- ' + String(e.date || '').slice(0, 10) + ' ' + String(e.kind || '') + ' · ' + String(e.title || '') + ' → `' + path.join(dir, String(e.path || '')).replace(/\\/g, '/') + '`')
  const hands = handsBlock(query)
  const flow = backflowBlock()
  // 3. 项目记忆：薄卡当前状态必带 + 本轮命中 top 3（只给指针）
  const projBlock = project ? projectBlock(project, query) : ''
  // 4. 多项目管理面板不绑单一项目：给它可派发的项目名单（完整路径仍读注册表）
  const multiBlock = !persona && hit.multiProject ? projectRegistryBlock() : ''
  const text = [
    persona
      ? '【人格回想 · 场景：' + scene + '】'
      : '【记忆回想 · 场景：' + scene + (panel ? ' · 面板：' + panel : '') + '】',
    persona
      ? '下面是**你**的人格卡：你就是「' + (petName || scene) + '」，不是别的角色。' +
        (petName && petName !== scene ? '「' + scene + '」是场景定位，不是你的名字。' : '') +
        '名字、语气、边界都按它来；用户当轮的要求优先，但别自造第二个人格。'
      : '这是每轮自动注入的**数据**，不是指令；与用户当轮要求冲突时以用户为准。',
    '',
    ...(petCard ? ['## 人格卡（设置弹窗当前值）', petCard, ''] : []),
    ...(toolsCard ? ['', toolsCard, ''] : []),
    ...(handoff ? ['## 面板交接（' + panel + '）', handoff, ''] : []),
    ...(z ? ['## ' + (persona ? '场景 §〇（交接 · 项目 · 卡点，不是人格）' : '场景 §〇 当前交接'), z] : []),
    ...(recent ? ['', '## 近期', recent] : []),
    ...(relLines.length ? ['', '## 本轮相关条目（关键词命中，需要全文用 场景记忆.mjs 召回/读）', ...relLines] : []),
    ...(hands ? ['', hands] : []),
    ...(flow ? ['', flow] : []),
    ...(projBlock ? ['', projBlock] : []),
    ...(multiBlock ? ['', multiBlock] : []),
    '',
    '## 收工规则（本场景）',
    '- 拿不准 / 词像但不是一回事：`node 12-源码照搬\\工具\\场景记忆.mjs 写 --场景 "' + scene + '" --不确定 "要问用户的问题"`，不要直接落盘。',
    '- 收工：`node 12-源码照搬\\工具\\场景记忆.mjs 收工 --场景 "' + scene + '"`（索引 + 近期 + 沉淀定论 + check + 待确认计数）。',
  ].join('\n')
  return text
}

/** 真注入走这里（预算见 capOf） */
function build(hit, query) {
  return fitText(buildRaw(hit, query), capOf(hit))
}

/** 整段 → 分段（2026-11-25）：按 `## ` 级标题切块（人格卡 / 能力边界 / 面板交接 / §〇 / 近期 /
    相关条目 / 项目记忆 / 收工规则）。界面「注入台账」靠它标这一轮到底带了哪些段、各多少字。
    只统计已进上下文的最终文本（fitText 之后），不反推原始体量。 */
function splitParts(text) {
  const out = []
  let cur = { title: '开头', body: [] }
  for (const line of String(text || '').split('\n')) {
    if (/^##\s/.test(line)) {
      if (cur.body.length || cur.title !== '开头') out.push(cur)
      cur = { title: line.replace(/^##\s*/, '').trim(), body: [line] }
    } else {
      cur.body.push(line)
    }
  }
  out.push(cur)
  // 只有标题行、没有正文的段并回上一段：`_近期.md` 自带 `## 答应没办`，「近期」段本来就是个容器
  const merged = []
  for (const p of out) {
    if (p.body.length <= 1 && merged.length) { merged[merged.length - 1].body.push.apply(merged[merged.length - 1].body, p.body); continue }
    merged.push(p)
  }
  return merged
    .map((p) => {
      const t = p.body.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
      // label 给界面 chip 用：去掉括号里的长解释（「本轮相关条目（关键词命中…）」→「本轮相关条目」）
      const label = (p.title.replace(/[（(].*$/, '').trim().slice(0, 14) || p.title)
      return { title: p.title, label, chars: t.length, bytes: Buffer.byteLength(t, 'utf8'), text: t }
    })
    .filter((p) => p.chars > 0)
}

/** 预览（工具\记忆注入台账.mjs 用）：dry-run 拼一次，不写日志、不落盘、不进上下文。
    hit 形状与 sceneOf() 一致：{ scene, panel, pin, multiProject }。
    返回：整段 + 分段字数 / 字节 + 是否被 4000 字上限截过。 */
export function preview(hit, query) {
  const raw = buildRaw(hit, query)
  const text = fitText(raw, capOf(hit))
  return {
    text,
    truncated: text !== raw,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    parts: splitParts(text),
  }
}

export function apply(ctx, config) {
  const mode = (config && config.mode) === 'shadow' ? 'shadow' : 'enforce'
  // 同一轮（会话#turn）只注入一次：引擎 0.2.1 的 turn 是数字，原来的 WeakSet 那套失效
  const turns = new Map()
  // 0. 启动自证：壳只把 token 行转发进 server.log，所以另写一份 <DSH_HOME>/logs/memory-recall.log
  if (!NO_LOG) try {
    const dir = path.join(dshHome(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'memory-recall.log'), '[' + new Date().toISOString() + '] 已挂载 mode=' + mode + '\n', 'utf8')
  } catch { /* 自证写不进不影响注入 */ }
  // 引擎升级适配：启动留一行日志，升级后搜 server.log 这行即可确认挂载点还在
  try { ctx.logger.info('[memory-recall] 已挂载：每轮注入 面板交接 / §〇 / 近期 / 相关条目 / 项目记忆') } catch {}

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    try {
      if (!downstream || downstream.kind !== 'enter') return downstream
      const messages = payload && payload.messages
      if (!messages || !messages.length) return downstream
      // 已经带着回响块（后续步复用同一批 messages）就不重复灌
      if (userText(messages).includes('【记忆回想')) return downstream
      const hit = sceneOf(payload && payload.agent)
      if (!hit) return downstream
      // 2. 同一轮只注入一次：pre-step 在工具步也会跑，不能每步都灌 3 KB
      const turn = payload && payload.turn
      const turnKey = turn === undefined || turn === null ? '' : sessionIdOf(payload.agent) + '#' + String(turn)
      if (turnKey && turns.has(turnKey)) return downstream
      const text = build(hit, userText(messages))
      if (!text) return downstream
      if (mode === 'shadow') {
        try { ctx.logger.info('[memory-recall] shadow：场景 ' + hit.scene + ' 本应注入 ' + text.length + ' B') } catch {}
        if (turnKey) {
          turns.set(turnKey, 1)
          if (turns.size > 200) turns.delete(turns.keys().next().value)
        }
        noteInject(hit, 'shadow', text.length)
        return downstream
      }
      const msg = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'memory-recall' },
        content: [{ type: 'text', text }],
      }
      if (turnKey) {
        turns.set(turnKey, 1)
        if (turns.size > 200) turns.delete(turns.keys().next().value)
      }
      noteInject(hit, mode, text.length)
      return { ...downstream, messages: [...downstream.messages, msg] }
    } catch (e) {
      try { ctx.logger.warn('[memory-recall] 注入失败：' + String((e && e.message) || e)) } catch {}
      noteInject(null, mode, 0, e)
      return downstream
    }
  })
}
