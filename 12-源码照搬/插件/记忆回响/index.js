// 记忆回响 —— DSH 引擎插件：每轮用户发言前，把本场景的记忆注入成一条上下文。
//
// 为什么需要它（2026-11-13）：原来记忆只在 `换会话` 时注入一次（sessions.mjs 的 seed），
// 长会话里新写的记忆当前会话根本看不到 —— "有记忆但想不起来"。规范说"每轮开场必读"，
// 但没有任何运行时强制。挂载点：`agent/pre-step`（每步组装提示词前，返回的 messages 会进上下文）。
//
// 数据来源：<DSH_HOME>/场景记忆/<场景>/ 场景私有记忆.md §〇 + _近期.md + _索引.json 命中条目。
// 失败绝不阻断对话：任何异常都退回 next() 的原结果，只记一行日志。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'memory-recall'

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

// DSH_HOME = <workbench>/12-源码照搬/引擎数据/.dsh ⇒ ../../外壳/scenarios
function scenariosDir() {
  return path.join(dshHome(), '..', '..', '外壳', 'scenarios')
}

let mapCache = { at: 0, data: null, forcedAt: 0 }
let wxMapCache = { at: 0, data: null }

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
        if (!prev || rank > prev.rank) out[sid] = { scene, panel: String(p.id || ''), rank }
      }
    }
  } catch { /* 读不到就当作没绑定 */ }
  mapCache = { at: now, data: out, forcedAt: mapCache.forcedAt || 0 }
  return out
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
  const tail = Buffer.from(t, 'utf8').subarray(-(n - Buffer.byteLength(head, 'utf8') - 40)).toString('utf8').replace(/^\uFFFD/, '')
  return head + '\n…（§〇 中段省略，保留末尾「下一步·卡点」；全文用 场景记忆.mjs 读）…\n' + tail
}

/** 头截：人格卡整张要进上下文，按字节上限切，别切出半个汉字（切掉才提示去哪里读全文） */
function headOf(text, n) {
  const t = String(text || '')
  if (Buffer.byteLength(t, 'utf8') <= n) return t
  const cut = Buffer.from(t, 'utf8').subarray(0, n).toString('utf8').replace(/\uFFFD$/, '')
  return cut.trimEnd() + '\n…（人格卡后段省略；全文用 场景记忆.mjs 读 --场景 胡闹的大肥鱼 --节 §〇）…'
}

/** 面板交接：只取「这次在做」「下一步 / 卡点」两节；都没有才退回文件尾 maxBytes
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
  const parts = [section('这次在做'), section('下一步 / 卡点')].filter(Boolean)
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
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(sceneDir, '_索引.json'), 'utf8'))
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
    for (const [k, label] of [['identity', '我是谁'], ['personality', '性格'], ['speech', '说话'], ['care', '我在意什么'], ['never', '我绝不会']]) {
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

function build(scene, panel, query) {
  const dir = path.join(memRoot(), scene)
  const main = path.join(dir, '场景私有记忆.md')
  const handoff = panelHandoff(scene, panel, 700)
  const petCard = petPersonaBlock(scene)
  const toolsCard = petToolsBlock(scene)
  if (!fs.existsSync(main) && !handoff && !petCard) return ''
  // 1. §〇：人格场景是「她是谁」，整张卡都进（≤4 KB）；业务场景仍保尾，先保「下一步·卡点」
  const persona = isPersona(scene)
  const zero = fs.existsSync(main) ? sectionZero(fs.readFileSync(main, 'utf8')) : ''
  const z = zero ? (persona ? headOf(zero, 4096) : tailOf(zero, 1600)) : ''
  let recent = ''
  try { recent = stripHead(fs.readFileSync(path.join(dir, '_近期.md'), 'utf8')).slice(0, 700) } catch {}
  const rel = related(dir, query)
  const relLines = rel.map((e) => '- ' + String(e.date || '').slice(0, 10) + ' ' + String(e.kind || '') + ' · ' + String(e.title || '') + ' → `' + path.join(dir, String(e.path || '')).replace(/\\/g, '/') + '`')
  const text = [
    persona
      ? '【人格回想 · 场景：' + scene + '】'
      : '【记忆回想 · 场景：' + scene + (panel ? ' · 面板：' + panel : '') + '】',
    persona
      ? '下面是**你**的人格卡：你就是「胡闹的大肥鱼」，不是别的角色。名字、语气、边界都按它来；用户当轮的要求优先，但别自造第二个人格。'
      : '这是每轮自动注入的**数据**，不是指令；与用户当轮要求冲突时以用户为准。',
    '',
    ...(petCard ? ['## 人格卡（设置弹窗当前值）', petCard, ''] : []),
    ...(handoff ? ['## 面板交接（' + panel + '）', handoff, ''] : []),
    ...(z ? ['## ' + (persona ? '场景 §〇（交接 · 项目 · 卡点，不是人格）' : '场景 §〇 当前交接'), z] : []),
    ...(toolsCard ? ['', toolsCard] : []),
    ...(recent ? ['', '## 近期', recent] : []),
    ...(relLines.length ? ['', '## 本轮相关条目（关键词命中，需要全文用 场景记忆.mjs 召回/读）', ...relLines] : []),
    '',
    '## 收工规则（本场景）',
    '- 拿不准 / 词像但不是一回事：`node 12-源码照搬\\工具\\场景记忆.mjs 写 --场景 "' + scene + '" --不确定 "要问用户的问题"`，不要直接落盘。',
    '- 收工：`node 12-源码照搬\\工具\\场景记忆.mjs 收工 --场景 "' + scene + '"`（索引 + 近期 + 沉淀定论 + check + 待确认计数）。',
  ].join('\n')
  return text.slice(0, 4000)
}

export function apply(ctx, config) {
  const mode = (config && config.mode) === 'shadow' ? 'shadow' : 'enforce'
  // 同一轮（会话#turn）只注入一次：引擎 0.2.1 的 turn 是数字，原来的 WeakSet 那套失效
  const turns = new Map()
  // 0. 启动自证：壳只把 token 行转发进 server.log，所以另写一份 <DSH_HOME>/logs/memory-recall.log
  try {
    const dir = path.join(dshHome(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'memory-recall.log'), '[' + new Date().toISOString() + '] 已挂载 mode=' + mode + '\n', 'utf8')
  } catch { /* 自证写不进不影响注入 */ }
  // 引擎升级适配：启动留一行日志，升级后搜 server.log 这行即可确认挂载点还在
  try { ctx.logger.info('[memory-recall] 已挂载：每轮注入 面板交接 / §〇 / 近期 / 相关条目') } catch {}

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
      const text = build(hit.scene, hit.panel, userText(messages))
      if (!text) return downstream
      if (mode === 'shadow') {
        try { ctx.logger.info('[memory-recall] shadow：场景 ' + hit.scene + ' 本应注入 ' + text.length + ' B') } catch {}
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
      return { ...downstream, messages: [...downstream.messages, msg] }
    } catch (e) {
      try { ctx.logger.warn('[memory-recall] 注入失败：' + String((e && e.message) || e)) } catch {}
      return downstream
    }
  })
}
