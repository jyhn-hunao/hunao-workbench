// 聊天档案 —— DSH 引擎插件（2026-11-19）
//
// 定位：把「聊天长期档案」接到 DSH 的推理链上。
//   · 外壳 社交档案.js 负责从 SnowLuma messages.db 全量归档；
//   · 本插件只读同一份 chat-archive.db（写记忆时也写它），给模型五件工具：
//       chat_history_search / chat_quote_lookup / chat_daily_digest /
//       chat_memory_recall / chat_memory_write
//   · 普通闲聊不查档案；agent/pre-step 只在用户话里出现「昨天/上次/谁说过/原话/某天」时
//     注入一小段「去查档案」的提示 + 已沉淀的单聊天记忆（最多 2 条），不整段注入历史。
//
// 失败口径：档案库未初始化 / 工具注册失败 / 查询失败 → 记日志并让模型看到原因；
// 不伪造历史，也不把整段聊天塞进 system prompt。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'chat-archive'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const HISTORY_CUE = /(昨天|前天|上次|上回|之前|以前|说过|原话|谁说过|哪天|某天|几号|记得|回忆|群里聊|聊了些什么|聊天记录|历史)/i

function dshHome() {
  const env = process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || ''
  if (env) return env
  const installed = path.resolve(PLUGIN_DIR, '..', '..', '..', '..')
  const source = path.resolve(PLUGIN_DIR, '..', '..', '引擎数据', '.dsh')
  try {
    if (fs.existsSync(path.join(installed, 'profiles'))) return installed
    if (fs.existsSync(path.join(source, 'profiles'))) return source
  } catch { /* 路径探测失败按安装位置兜底 */ }
  return installed
}

function shellRoot() {
  return path.resolve(dshHome(), '..', '..', '外壳')
}

function statusFile() {
  return path.join(dshHome(), '场景记忆', '_共享记忆', '聊天档案-状态.json')
}

function sessionsFile() {
  return path.join(shellRoot(), 'data', '社交会话.json')
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    return true
  } catch { return false }
}

function serviceOf(ctx, key) {
  if (typeof ctx.get === 'function') {
    const registered = ctx.get(key)
    if (registered !== undefined && registered !== null) return registered
  }
  return ctx[key]
}

function loadArchiveLib() {
  try {
    const req = createRequire(import.meta.url)
    const file = path.join(shellRoot(), '社交档案库.js')
    if (!fs.existsSync(file)) return null
    return req(file)
  } catch {
    return null
  }
}

function openArchive() {
  const lib = loadArchiveLib()
  if (!lib) return { ok: false, error: '聊天档案库没找到：外壳\\社交档案库.js 不存在（先重启工作台让它落库）' }
  const file = lib.dbFile(dshHome())
  try {
    const db = lib.openDb(file)
    return { ok: true, lib, db, file }
  } catch (e) {
    return { ok: false, error: '打开聊天档案库失败：' + String((e && e.message) || e) }
  }
}

function currentSessionId(exec) {
  return String((exec && exec.agent && exec.agent.session && exec.agent.session.id) || '')
}

function currentChat(lib, db, sessionId) {
  if (!sessionId) return null
  try {
    const rows = lib.listChats(db).filter((x) => x.sessionId === sessionId)
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) return { multiple: rows }
  } catch { /* 忽略 */ }
  // 镜像表可能还没刷新：直接读社交会话总表兜底。
  const s = readJson(sessionsFile(), null)
  const sessions = (s && s.sessions) || {}
  const entry = sessions[sessionId]
  if (!entry) return null
  const channel = String(entry.channel || '').toLowerCase()
  if (!channel) return null
  const type = String(entry.chatType || '').toLowerCase() === 'group' ? 'group' : 'private'
  return {
    chatKey: lib.chatKey(channel, type, entry.chatId || ''),
    chatType: type,
    chatId: String(entry.chatId || ''),
    displayName: String(entry.chatTitle || entry.title || entry.chatId || ''),
    messageCount: 0
  }
}

function resolveChat(lib, db, args, sessionId) {
  const a = args || {}
  const input = String(a.chat || a.chatKey || '').trim()
  if (input) return lib.resolveChat(db, input, sessionId)
  const cur = currentChat(lib, db, sessionId)
  if (cur && cur.multiple) return { ok: false, error: '当前 DSH 会话对应多个聊天，请传 chat' }
  if (cur) return { ok: true, chatKey: cur.chatKey }
  return { ok: false, error: '没说哪个聊天，且当前 DSH 会话没有唯一绑定；请传 chat（聊天名或 chat_key）' }
}

function dayArg(v) {
  const s = String(v || '').trim()
  if (!s || s === 'today' || s === '今天') {
    const now = Date.now() + 8 * 3600 * 1000
    return new Date(now).toISOString().slice(0, 10)
  }
  if (s === 'yesterday' || s === '昨天') {
    const now = Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000
    return new Date(now).toISOString().slice(0, 10)
  }
  return s.slice(0, 10)
}

function fmtSearch(value) {
  const v = value || {}
  if (v.ok === false) return '聊天档案查询失败：' + (v.error || '未知原因') + (v.candidates ? '\n候选：' + v.candidates.map((x) => x.chatKey + ' / ' + (x.name || '')).join('；') : '')
  const lines = ['聊天档案 · ' + (v.chatKey || '') + (v.query ? ' · 关键词「' + v.query + '」' : '') + ' · ' + Number(v.count || 0) + ' 条']
  ;(v.matches || []).forEach((m) => {
    lines.push('[' + (m.day || '') + ' ' + (m.time || '') + '] ' + (m.sender || '') + ': ' + (m.text || ''))
    if (m.before && m.before.length) m.before.forEach((x) => lines.push('  ↑ ' + (x.time || '') + ' ' + (x.sender || '') + ': ' + (x.text || '')))
    if (m.after && m.after.length) m.after.forEach((x) => lines.push('  ↓ ' + (x.time || '') + ' ' + (x.sender || '') + ': ' + (x.text || '')))
  })
  if (!v.count) lines.push('没有命中；可换更短的关键词，或先用 chat_daily_digest 看当天完整消息。')
  return lines.join('\n')
}

function fmtQuote(value) {
  const v = value || {}
  if (v.ok === false) return '原话查询失败：' + (v.error || '未知原因')
  const lines = ['聊天档案 · 原话「' + (v.phrase || '') + '」 · ' + Number(v.count || 0) + ' 条']
  ;(v.matches || []).forEach((m) => {
    lines.push('[' + (m.day || '') + ' ' + (m.time || '') + '] ' + (m.sender || '') + ': ' + (m.text || ''))
    if (m.before && m.before.length) m.before.forEach((x) => lines.push('  ↑ ' + (x.time || '') + ' ' + (x.sender || '') + ': ' + (x.text || '')))
  })
  if (!v.count) lines.push('没有找到逐字原话。不要编造；可以说「档案里没找到这句原话」，或换更短的关键词再查。')
  return lines.join('\n')
}

function fmtDaily(value) {
  const v = value || {}
  if (v.ok === false) return '日摘要查询失败：' + (v.error || '未知原因')
  const p = v.page || {}
  const s = (v.stats && v.stats[0]) || {}
  const total = Number(p.total || s.count || 0)
  const lines = [
    '聊天档案 · ' + (v.date || '') + ' · ' + (v.chatKey || '当前聊天') + ' · 共 ' + total + ' 条 · 本页 ' + Number((p.messages || []).length) + ' 条' +
    (p.done ? '（已到末页）' : '（还有下一页，next_cursor=' + p.nextCursor + '）')
  ]
  ;(p.messages || []).forEach((m) => {
    lines.push('[' + (m.time || '') + '] ' + (m.sender || '') + ': ' + (m.text || ''))
  })
  if (p.done) lines.push('全部页面已读完；现在可以基于这些消息做总结。')
  else lines.push('还没读完：继续调用 chat_daily_digest，date 不变，cursor=' + p.nextCursor + '；读完再总结，别只看第一页。')
  return lines.join('\n')
}

function fmtMemories(value) {
  const v = value || {}
  if (v.ok === false) return '聊天记忆读取失败：' + (v.error || '未知原因')
  const list = v.memories || []
  if (!list.length) return '这个聊天还没有沉淀记忆。'
  return ['聊天记忆 · ' + (v.chatKey || '')].concat(list.map((m) => '#' + m.id + ' [' + (m.kind || 'fact') + '] ' + m.text)).join('\n')
}

function renderObject(value) {
  return [{ type: 'text', text: JSON.stringify(value == null ? {} : value, null, 2) }]
}

function toolDefs(lib, db) {
  const out = []
  out.push({
    name: 'chat_history_search',
    description:
      '查这个聊天（微信/QQ 私聊或群聊）的长期档案。只在用户问「昨天/上次/之前/谁说过/某天/聊天记录」时用；普通闲聊不要查。'
      + '\n返回命中消息与上下文；chat 不填时用当前 DSH 会话唯一绑定的聊天。'
      + '\n关键词尽量短；精确找某句原话用 chat_quote_lookup。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', description: '聊天名、chat_key（如 qq:group:123456）或群号/QQ号；不填用当前会话。' },
        query: { type: 'string', description: '关键词或短句。' },
        date: { type: 'string', description: '可选，YYYY-MM-DD 或 昨天/今天。' },
        from: { type: 'string', description: '可选，起始日期 YYYY-MM-DD。' },
        to: { type: 'string', description: '可选，结束日期 YYYY-MM-DD。' },
        sender: { type: 'string', description: '可选，发送人昵称或 QQ 号。' },
        limit: { type: 'number', description: '最多几条，默认 20，最多 100。' },
        context: { type: 'number', description: '每条命中带前后几条上下文，默认 1，最多 5。' }
      },
      required: ['query']
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: fmtSearch(value) }]
    },
    execute: async (args, exec) => {
      const a = args || {}
      const sessionId = currentSessionId(exec)
      const r = resolveChat(lib, db, a, sessionId)
      if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
      const from = a.date ? lib.dateStartMs(dayArg(a.date)) : (a.from ? lib.dateStartMs(dayArg(a.from)) : 0)
      const to = a.date ? lib.dateEndMs(dayArg(a.date)) : (a.to ? lib.dateEndMs(dayArg(a.to)) : 0)
      const rows = lib.searchMessages(db, {
        chatKey: r.chatKey, query: a.query || '', fromMs: from, toMs: to,
        sender: a.sender || '', limit: a.limit, context: a.context === undefined ? 1 : a.context
      })
      return { ok: true, chatKey: r.chatKey, query: a.query || '', date: a.date || '', count: rows.length, matches: rows }
    }
  })

  out.push({
    name: 'chat_quote_lookup',
    description:
      '在聊天档案里按「逐字原话」找某句话（不是语义相似）。用户说「谁说过 xxx」「找原话」「某天那句」时用。'
      + '\n先 short phrase（四到十二个字最好），找不到就换更短的片段；返回原文和上下文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', description: '聊天名或 chat_key；不填用当前会话。' },
        phrase: { type: 'string', description: '要逐字匹配的原文片段。' },
        date: { type: 'string', description: '可选，YYYY-MM-DD 或 昨天/今天。' },
        from: { type: 'string', description: '可选，起始日期。' },
        to: { type: 'string', description: '可选，结束日期。' },
        sender: { type: 'string', description: '可选，发送人昵称或 QQ 号。' },
        limit: { type: 'number', description: '最多几条，默认 10，最多 50。' },
        context: { type: 'number', description: '每条带前后几条上下文，默认 1。' }
      },
      required: ['phrase']
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: fmtQuote(value) }]
    },
    execute: async (args, exec) => {
      const a = args || {}
      const sessionId = currentSessionId(exec)
      const r = resolveChat(lib, db, a, sessionId)
      if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
      const from = a.date ? lib.dateStartMs(dayArg(a.date)) : (a.from ? lib.dateStartMs(dayArg(a.from)) : 0)
      const to = a.date ? lib.dateEndMs(dayArg(a.date)) : (a.to ? lib.dateEndMs(dayArg(a.to)) : 0)
      const rows = lib.quoteLookup(db, {
        chatKey: r.chatKey, phrase: a.phrase || a.query || '', fromMs: from, toMs: to,
        sender: a.sender || '', limit: a.limit, context: a.context === undefined ? 1 : a.context
      })
      return { ok: true, chatKey: r.chatKey, phrase: a.phrase || a.query || '', count: rows.length, matches: rows }
    }
  })

  out.push({
    name: 'chat_daily_digest',
    description:
      '按日期读取聊天档案，分页返回当天消息（每页默认 200 条，最多 300）。'
      + '\n用户问「昨天群里聊了些什么，总结一下」时：先用 date=昨天（或具体日期）调用本工具，'
      + '然后**必须**按 next_cursor 翻到 done=true，读完所有页再总结；不要只看第一页。'
      + '\n不传 chat 时用当前 DSH 会话唯一绑定的聊天；传 chat 可看别的聊天。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', description: '聊天名或 chat_key；不填用当前会话。' },
        date: { type: 'string', description: 'YYYY-MM-DD 或 昨天/今天，默认昨天。' },
        cursor: { type: 'number', description: '上一页返回的 next_cursor，第一页不填。' },
        limit: { type: 'number', description: '每页条数，默认 200，最多 300。' }
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: fmtDaily(value) }]
    },
    execute: async (args, exec) => {
      const a = args || {}
      const sessionId = currentSessionId(exec)
      const r = resolveChat(lib, db, a, sessionId)
      if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
      const day = dayArg(a.date || '昨天')
      const page = lib.dailyPage(db, { day, chatKey: r.chatKey, cursor: a.cursor, limit: a.limit })
      const stats = lib.dailyStats(db, day, r.chatKey)
      return { ok: true, chatKey: r.chatKey, date: day, page, stats }
    }
  })

  out.push({
    name: 'chat_memory_recall',
    description:
      '按需读取这个聊天已经沉淀的长期记忆（不是完整历史原文）。用户问「你记得我之前说过什么」或需要聊天里的偏好/约定时用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', description: '聊天名或 chat_key；不填用当前会话。' },
        query: { type: 'string', description: '可选，按关键词过滤记忆。' },
        limit: { type: 'number', description: '最多几条，默认 5，最多 20。' }
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: fmtMemories(value) }]
    },
    execute: async (args, exec) => {
      const a = args || {}
      const sessionId = currentSessionId(exec)
      const r = resolveChat(lib, db, a, sessionId)
      if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
      return { ok: true, chatKey: r.chatKey, memories: lib.listMemories(db, { chatKey: r.chatKey, query: a.query || '', limit: a.limit }) }
    }
  })

  out.push({
    name: 'chat_memory_write',
    description:
      '把一条「以后还要用」的聊天记忆写进这个聊天的记忆层（不是完整历史，也不是全局人格）。'
      + '\n只在用户明确说「记住」「以后都这样」「我不喜欢/我喜欢」或形成稳定约定时调用；'
      + '\n普通闲聊不要写。text 写一句可执行的事实，不要写成长篇总结；能附上原文消息 id 就附 evidence_ids。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', description: '聊天名或 chat_key；不填用当前会话。' },
        kind: { type: 'string', description: 'fact / preference / decision / relationship 之一。' },
        text: { type: 'string', description: '一句可执行、可复述的记忆。' },
        evidence_ids: { type: 'array', items: { type: 'number' }, description: '可选，支撑这条记忆的档案消息 id。' },
        confidence: { type: 'number', description: '可选，0–1，默认 0.6。' }
      },
      required: ['text']
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value && value.ok ? '已写入聊天记忆 #' + ((value.memory && value.memory.id) || '') : ('写入聊天记忆失败：' + ((value && value.error) || '未知原因')) }]
    },
    execute: async (args, exec) => {
      const a = args || {}
      const sessionId = currentSessionId(exec)
      const r = resolveChat(lib, db, a, sessionId)
      if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
      try {
        const m = lib.addMemory(db, {
          chatKey: r.chatKey, text: a.text || '', kind: a.kind || 'fact',
          evidenceIds: a.evidence_ids || a.evidenceIds || [], confidence: a.confidence
        })
        return { ok: true, chatKey: r.chatKey, memory: m }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }
  })

  return out
}

function buildHint(lib, db, sessionId) {
  const cur = currentChat(lib, db, sessionId)
  if (!cur || cur.multiple) return ''
  const chat = lib.getChat(db, cur.chatKey)
  if (!chat) return ''
  const mem = lib.listMemories(db, { chatKey: cur.chatKey, limit: 2 })
  const lines = [
    '【聊天档案】当前聊天：' + (chat.displayName || chat.chatId || chat.chatKey) +
    '（' + chat.chatKey + '，已归档 ' + Number(chat.messageCount || 0) + ' 条' +
    (chat.firstTs ? '，覆盖 ' + lib.dayOf(chat.firstTs) + ' 至 ' + lib.dayOf(chat.lastTs) : '') + '）。',
    '用户这轮在问历史/回忆：先用 chat_daily_digest（按日期，分页读完再总结）、chat_history_search（关键词）或 chat_quote_lookup（逐字原话）查档案，再回答；不要凭印象编造。',
    '普通闲聊不用查档案。'
  ]
  if (mem.length) {
    lines.push('这个聊天已沉淀的记忆：')
    mem.forEach((m) => lines.push('· [' + (m.kind || 'fact') + '] ' + m.text))
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const mode = (config && config.mode) === 'shadow' ? 'shadow' : 'enforce'
  const turns = new Map()
  let archive = null
  try {
    archive = openArchive()
  } catch (e) {
    archive = { ok: false, error: String((e && e.message) || e) }
  }
  try {
    writeJson(statusFile(), {
      kind: 'mount',
      at: Date.now(),
      mode,
      db: archive && archive.ok ? archive.file : '',
      error: archive && archive.ok ? '' : (archive && archive.error) || ''
    })
  } catch { /* 状态写不进不影响工具 */ }
  try { ctx.logger.info('[chat-archive] 已挂载 mode=' + mode + ' db=' + (archive && archive.file ? 'ready' : 'missing')) } catch { /* logger 不可用 */ }

  // 注册工具：注册失败只记日志，不退化成「假装有历史」。
  try {
    const tools = serviceOf(ctx, 'tools')
    if (!tools || typeof tools.register !== 'function') throw new Error('tools service 不可用')
    if (!archive || !archive.ok) throw new Error(archive ? archive.error : '档案库不可用')
    const defs = toolDefs(archive.lib, archive.db)
    for (const def of defs) {
      try {
        const dispose = tools.register(def)
        if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => dispose, 'chat-archive: ' + def.name)
        }
      } catch (e) {
        try { ctx.logger.warn('[chat-archive] 注册 ' + def.name + ' 失败：' + String((e && e.message) || e)) } catch { /* logger 不可用 */ }
      }
    }
  } catch (e) {
    try { ctx.logger.warn('[chat-archive] 工具注册失败：' + String((e && e.message) || e)) } catch { /* logger 不可用 */ }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    try {
      if (!downstream || downstream.kind !== 'enter') return downstream
      if (!archive || !archive.ok) return downstream
      const messages = payload && payload.messages
      if (!Array.isArray(messages) || !messages.length) return downstream
      const text = userText(messages)
      if (!text || text.includes('【聊天档案】')) return downstream
      if (!HISTORY_CUE.test(text)) return downstream
      const sid = currentSessionId({ agent: payload && payload.agent })
      if (!sid) return downstream
      const turn = payload && payload.turn
      const turnKey = turn === undefined || turn === null ? '' : sid + '#' + String(turn)
      if (turnKey && turns.has(turnKey)) return downstream
      let hint = ''
      try { hint = buildHint(archive.lib, archive.db, sid) } catch { hint = '' }
      if (!hint) return downstream
      if (mode === 'shadow') {
        if (turnKey) { turns.set(turnKey, 1); if (turns.size > 200) turns.delete(turns.keys().next().value) }
        try { ctx.logger.info('[chat-archive] shadow：本应注入 ' + hint.length + ' B') } catch { /* logger 不可用 */ }
        return downstream
      }
      if (turnKey) { turns.set(turnKey, 1); if (turns.size > 200) turns.delete(turns.keys().next().value) }
      const msg = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'chat-archive' },
        content: [{ type: 'text', text: hint }]
      }
      try { ctx.logger.info('[chat-archive] 注入历史提示 ' + hint.length + ' B') } catch { /* logger 不可用 */ }
      return { ...downstream, messages: [...downstream.messages, msg] }
    } catch (e) {
      try { ctx.logger.warn('[chat-archive] 注入失败：' + String((e && e.message) || e)) } catch { /* logger 不可用 */ }
      return downstream
    }
  })
}

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

export const _test = {
  dshHome,
  shellRoot,
  dayArg,
  buildHint,
  HISTORY_CUE
}
