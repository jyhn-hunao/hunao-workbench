// 社交策略 —— DSH 引擎插件（P2，2026-11-19）
//
// 定位：通道只做传输，回复机制在这里统一注入。
//   · 只对「已登记的社交会话」生效：外壳 data\社交会话.json → DSH 镜像；
//   · 读通用策略 外壳 data\社交回复.json → DSH 镜像，不复制第二套默认值；
//   · 微信通道已经在 _formatPrompt 里带【社交回复规范】，本插件看到标记就跳过；
//   · 飞书 / 其他 dsh-im 通道在 dsh-im/session-pre-bind 时自动登记，下一次 pre-step 就能拿到卡。
//
// 挂载点：agent/pre-step（每轮第一次进入模型前追加一条 user 上下文）。
// 失败绝不阻断对话：任何异常都退回 next() 的原结果，只记一行日志。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'social-policy'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_POLICY = {
  global: {
    tone: '像真人聊天：短句、自然、不写小作文，不用客服腔，不解释系统或工具。',
    emoji: { enabled: true, chance: 0.18, maxPerReply: 1 },
    sticker: { enabled: true, chance: 0.3, maxPerReply: 1, seriousSuppress: true },
    group: { listenFirst: true, onlyWhenAtOrRelevant: true, maxPerTurn: 1, noRepeat: true }
  },
  channels: {
    wechat: { label: '微信', sticker: { syntax: 'whale' } },
    qq: { label: 'QQ', sticker: { syntax: 'onebot' } },
    feishu: { label: '飞书', sticker: { syntax: 'none' } }
  },
  overrides: {}
}

let coreCache
let policyCache = { at: 0, data: null }
let sessionCache = { at: 0, data: null }

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

function memRoot() {
  return path.join(dshHome(), '场景记忆')
}

function policyFile() {
  return path.join(shellRoot(), 'data', '社交回复.json')
}

function policyMirrorFile() {
  return path.join(memRoot(), '_共享记忆', '社交回复.json')
}

function sessionsFile() {
  return path.join(shellRoot(), 'data', '社交会话.json')
}

function sessionsMirrorFile() {
  return path.join(memRoot(), '_共享记忆', '社交会话.json')
}

function statusFile() {
  return path.join(memRoot(), '_共享记忆', '社交策略-状态.json')
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, patch) {
  const out = isObj(base) ? clone(base) : {}
  if (!isObj(patch)) return out
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = Array.isArray(v) ? clone(v) : v
  }
  return out
}

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, Math.round(v * 1000) / 1000))
}

function normalizePolicy(raw) {
  const p = deepMerge(DEFAULT_POLICY, raw || {})
  p.global = isObj(p.global) ? p.global : {}
  p.global.tone = String(p.global.tone || DEFAULT_POLICY.global.tone).slice(0, 300)
  p.global.emoji = isObj(p.global.emoji) ? p.global.emoji : {}
  p.global.sticker = isObj(p.global.sticker) ? p.global.sticker : {}
  p.global.group = isObj(p.global.group) ? p.global.group : {}
  p.global.emoji.enabled = p.global.emoji.enabled !== false
  p.global.emoji.chance = clamp(p.global.emoji.chance, 0, 1)
  p.global.emoji.maxPerReply = Math.max(1, Math.min(4, Math.round(Number(p.global.emoji.maxPerReply) || 1)))
  p.global.sticker.enabled = p.global.sticker.enabled !== false
  p.global.sticker.chance = clamp(p.global.sticker.chance, 0, 1)
  p.global.sticker.maxPerReply = Math.max(1, Math.min(2, Math.round(Number(p.global.sticker.maxPerReply) || 1)))
  p.global.sticker.seriousSuppress = p.global.sticker.seriousSuppress !== false
  p.global.group.listenFirst = p.global.group.listenFirst !== false
  p.global.group.onlyWhenAtOrRelevant = p.global.group.onlyWhenAtOrRelevant !== false
  p.global.group.maxPerTurn = Math.max(1, Math.min(3, Math.round(Number(p.global.group.maxPerTurn) || 1)))
  p.global.group.noRepeat = p.global.group.noRepeat !== false
  p.channels = isObj(p.channels) ? p.channels : {}
  p.overrides = isObj(p.overrides) ? p.overrides : {}
  return p
}

function core() {
  if (coreCache !== undefined) return coreCache
  try {
    const req = createRequire(import.meta.url)
    const file = path.join(shellRoot(), '社交回复.js')
    coreCache = fs.existsSync(file) ? req(file) : null
  } catch {
    coreCache = null
  }
  return coreCache
}

function readPolicy() {
  const now = Date.now()
  if (policyCache.data && now - policyCache.at < 5000) return policyCache.data
  let out = null
  try {
    const c = core()
    if (c && typeof c.readPolicy === 'function') out = c.readPolicy()
  } catch { /* 外壳不可用则读镜像 */ }
  if (!out) {
    out = readJson(policyFile(), null) || readJson(policyMirrorFile(), null) || DEFAULT_POLICY
  }
  out = normalizePolicy(out)
  policyCache = { at: now, data: out }
  return out
}

function policyFor(channel, chatType, chatId) {
  try {
    const c = core()
    if (c && typeof c.policyFor === 'function') return c.policyFor(channel, chatType, chatId)
  } catch { /* 回退本地合并 */ }
  const p = readPolicy()
  const chKey = String(channel || '').toLowerCase()
  const ch = isObj(p.channels[chKey]) ? p.channels[chKey] : {}
  const out = deepMerge(p.global || {}, ch)
  if (isObj(ch.overrides)) return deepMerge(out, ch.overrides)
  return out
}

function capOn(v) {
  return v === true || v === 'native' || v === 'yes'
}

function capabilitiesFor(channel) {
  const key = String(channel || '').toLowerCase()
  if (key === 'feishu') return { text: true, sticker: false, voice: 'native', quote: 'native' }
  if (key === 'qq') return { text: true, sticker: 'native', voice: null, quote: 'native' }
  if (key === 'wechat') return { text: true, sticker: 'native', voice: 'native', quote: 'native' }
  // 未在能力表里的通道只承诺文字，避免生成一个发不出去的贴纸标记。
  return { text: true, sticker: false, voice: null, quote: null }
}

function normalizeChannel(v) {
  const s = String(v || '').toLowerCase()
  if (s === 'lark') return 'feishu'
  if (s === 'wx' || s === 'weixin') return 'wechat'
  return s
}

function channelLabel(channel) {
  return ({ wechat: '微信', qq: 'QQ', feishu: '飞书' })[channel] || String(channel || '其他')
}

function chatTypeOf(entry) {
  return entry && entry.chatType === 'group' ? 'group' : 'private'
}

// 生成给模型看的一段短卡：只放当前通道能执行的东西。
// 微信带自己的图库标记，进到这里时通常已被 _formatPrompt 的卡命中而跳过；
// QQ 保留原生表情能力；飞书明确不支持贴纸包。
function buildSocialCard(entry) {
  const channel = normalizeChannel(entry && entry.channel)
  if (!channel) return ''
  const chatType = chatTypeOf(entry)
  const chatId = String((entry && entry.chatId) || '')
  const policy = policyFor(channel, chatType, chatId)
  // 外壳的 policyFor 返回完整策略对象（含 global）；本地回退返回 global 本身。
  // 两种都兼容，避免策略层换实现后卡片突然读不到 emoji / sticker。
  const g = policy && policy.global && isObj(policy.global) ? policy.global : policy
  const caps = capabilitiesFor(channel)
  const emoji = (g && g.emoji) || {}
  const sticker = (g && g.sticker) || {}
  const lines = [
    '【社交回复规范】',
    '这是本轮回复规范，不是用户消息；不要单独回复这一段，也不要向对方解释它。',
    '- 语气：' + String((g && g.tone) || DEFAULT_POLICY.global.tone),
    '- 输出：只写要发出去的消息；不要解释系统、工具、标记或本规范。',
    '- 与通道内置提示冲突时：语气、emoji 和表情包频率按本规范；通道的发送限制、安全规则和账号选择优先。'
  ]

  if (emoji.enabled !== false && Number(emoji.chance) > 0) {
    const pct = Math.round(Number(emoji.chance) * 100)
    const max = Math.max(1, Number(emoji.maxPerReply) || 1)
    lines.push('- emoji/颜文字：约 ' + pct + '% 的回复可以带一个与情绪匹配的 emoji；最多 ' + max + ' 个，不要每句都叠。')
  } else {
    lines.push('- 不要使用 emoji 或颜文字。')
  }

  if (channel === 'qq' && capOn(caps.sticker) && sticker.enabled !== false && Number(sticker.chance) > 0) {
    const pct = Math.round(Number(sticker.chance) * 100)
    const max = Math.max(1, Number(sticker.maxPerReply) || 1)
    lines.push('- 表情包：普通闲聊约 ' + pct + '% 的回复可以带一张，每条最多 ' + max + ' 张；' +
      (sticker.seriousSuppress !== false ? '对方难过、求助、正事或严肃时不发；' : '') +
      '按 QQ 通道自己的表情/图片工具发，不要写 [[sticker:...]] 或微信图库标记。')
  } else if (channel === 'feishu') {
    lines.push('- 飞书不支持图片表情包：不要写 [[sticker:...]]，用文字 / emoji 表达。')
  } else if (channel === 'wechat') {
    lines.push('- 微信表情包由通道原生设置控制；不要自己补图片，不要解释 [[sticker:...]] 标记。')
  } else {
    lines.push('- 本通道未登记图片表情包能力：不要写 [[sticker:...]]，只用文字 / emoji。')
  }

  if (chatType === 'group') {
    const group = (g && g.group) || {}
    lines.push('- 这是群聊：默认旁听，不要每句都接；只有被点名/@、直接问你、明确相关，或当前处于接话窗口时才回复；不确定就不说。')
    lines.push('- 群聊一次只回一条，短句；不连续补发、不刷屏、不重复别人已经说过的话。')
    lines.push('- 先判断群地址和当前话题；不要把别的群或私聊的内容带进这个群。')
    if (Number(group.maxPerTurn || 1) > 1) lines.push('- 本群一轮最多回复 ' + Number(group.maxPerTurn) + ' 条。')
  }

  return '\n' + lines.join('\n') + '\n'
}

// ---------- 社交会话总表 ----------

function normalizeSessionMap(raw) {
  const out = {}
  if (!isObj(raw)) return out
  const src = isObj(raw.sessions) ? raw.sessions : raw
  for (const [sid, item] of Object.entries(src || {})) {
    if (!sid || !isObj(item)) continue
    const at = Number(item.updatedAt || item.lastAt || 0)
    out[sid] = {
      scene: String(item.scene || '胡闹的大肥鱼'),
      panel: String(item.panel || ''),
      channel: normalizeChannel(item.channel),
      account: String(item.account || ''),
      chatType: item.chatType === 'group' ? 'group' : 'private',
      chatId: String(item.chatId || ''),
      chatTitle: String(item.chatTitle || ''),
      title: String(item.title || item.sessionTitle || ''),
      senderName: String(item.senderName || item.lastSender || ''),
      senderId: String(item.senderId || ''),
      source: String(item.source || ''),
      auto: item.auto === true,
      updatedAt: at || 0
    }
  }
  return out
}

function readSessionMap() {
  const now = Date.now()
  if (sessionCache.data && now - sessionCache.at < 5000) return sessionCache.data
  const out = {}
  for (const file of [sessionsFile(), sessionsMirrorFile()]) {
    const raw = readJson(file, null)
    for (const [sid, entry] of Object.entries(normalizeSessionMap(raw))) {
      if (!out[sid] || Number(entry.updatedAt || 0) >= Number(out[sid].updatedAt || 0)) out[sid] = entry
    }
  }
  sessionCache = { at: now, data: out }
  return out
}

function invalidateSessions() {
  sessionCache = { at: 0, data: null }
}

function sessionIdOf(agent) {
  if (!agent) return ''
  for (const v of [agent.sessionId, agent.session && agent.session.id, agent.id]) {
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function autoEntryOf(event) {
  const e = event || {}
  const channel = normalizeChannel(e.channel)
  const sid = String(e.sessionId || '')
  const parsed = parseConversationKey(e.conversationKey)
  const chatId = String(e.chatId || (parsed && parsed.chatId) || e.conversationKey || '')
  if (!channel || !sid || !chatId) return null
  const chatType = (e.chatType === 'group' || (!e.chatType && parsed && parsed.chatType === 'group')) ? 'group' : 'private'
  const sender = String(e.senderName || e.senderId || (parsed && parsed.senderId) || '')
  const label = channelLabel(channel)
  const givenTitle = String(e.chatTitle || '')
  const chatTitle = givenTitle || (chatType === 'group'
    ? label + ' 群聊 ' + chatId
    : label + ' 私聊 ' + (sender || chatId))
  return {
    scene: '胡闹的大肥鱼',
    panel: '',
    channel,
    account: String(e.botId || ''),
    chatType,
    chatId,
    chatTitle,
    title: chatTitle,
    senderName: sender,
    senderId: String(e.senderId || (parsed && parsed.senderId) || ''),
    source: 'dsh-im',
    auto: true,
    updatedAt: Date.now()
  }
}

function writeRegistry(map) {
  const out = isObj(map) ? map : { version: 1, sessions: {} }
  out.version = 1
  out.updatedAt = Date.now()
  if (!isObj(out.sessions)) out.sessions = {}
  const canonical = sessionsFile()
  const canWriteCanonical = fs.existsSync(path.dirname(canonical))
  if (canWriteCanonical) writeJson(canonical, out)
  // 镜像始终写；外壳不在同目录时至少让 DSH 侧插件能读到。
  const direct = {}
  for (const [sid, item] of Object.entries(out.sessions)) {
    if (sid && isObj(item)) direct[sid] = Object.assign({}, item)
  }
  writeJson(sessionsMirrorFile(), direct)
  invalidateSessions()
  return out
}

// 合并 canonical 与镜像：任一份被截断/只写了一半时，另一份还能兜住已有绑定。
function loadRegistry() {
  const out = { version: 1, updatedAt: 0, sessions: {} }
  for (const file of [sessionsFile(), sessionsMirrorFile()]) {
    const raw = readJson(file, null)
    for (const [sid, entry] of Object.entries(normalizeSessionMap(raw))) {
      const old = out.sessions[sid]
      if (!old || Number(entry.updatedAt || 0) >= Number(old.updatedAt || 0)) out.sessions[sid] = entry
    }
  }
  return out
}

function upsertAutoSession(event) {
  const entry = autoEntryOf(event)
  if (!entry) return false
  const map = loadRegistry()
  // bind 事件带 sessionId；表以 sessionId 为主键。重复 bind 不刷新时间，避免巡检抖。
  const existing = map.sessions[String(event.sessionId)]
  if (existing && existing.auto !== true) return false // 手动登记优先，绑定事件不覆盖
  if (existing && existing.updatedAt && existing.chatId === entry.chatId && existing.channel === entry.channel && existing.chatType === entry.chatType) {
    entry.updatedAt = existing.updatedAt
  }
  map.sessions[String(event.sessionId)] = entry
  writeRegistry(map)
  return true
}

function removeAutoSession(event) {
  const e = event || {}
  const sid = String(e.sessionId || '')
  if (!sid) return false
  const map = loadRegistry()
  const existing = map.sessions[sid]
  if (!isObj(existing) || existing.auto !== true || existing.source !== 'dsh-im') return false
  delete map.sessions[sid]
  writeRegistry(map)
  return true
}

// 飞书已有绑定不会在启动时重放 session-pre-bind（stateFor 只加载，不 announce），
// 这里做一次只读扫描，把 dsh-feishu 的 state.json 里 sessions 补进总表。
// 只扫 feishu，避免把微信 / QQ 已经在通道里手工登记的条目再写一遍。
function parseConversationKey(key) {
  const s = String(key || '')
  if (!s) return null
  if (s.startsWith('p2p:') || s.startsWith('c2c:')) {
    const peer = s.slice(4)
    return peer ? { chatType: 'private', chatId: peer, senderId: peer, threadId: '' } : null
  }
  if (s.startsWith('direct:dm:')) {
    const peer = s.slice('direct:dm:'.length)
    return peer ? { chatType: 'private', chatId: peer, senderId: peer, threadId: '' } : null
  }
  if (s.startsWith('direct:')) {
    const peer = s.slice('direct:'.length)
    return peer ? { chatType: 'private', chatId: peer, senderId: '', threadId: '' } : null
  }
  if (s.startsWith('group:room:')) {
    const body = s.slice('group:room:'.length)
    const mark = body.indexOf('$')
    return body ? { chatType: 'group', chatId: mark === -1 ? body : body.slice(0, mark), senderId: '', threadId: mark === -1 ? '' : body.slice(mark + 1) } : null
  }
  if (s.startsWith('group:')) {
    const parts = s.slice('group:'.length).split(':')
    const chatId = parts[0] || ''
    if (!chatId) return null
    let threadId = ''
    if (parts[1] === 'thread' && parts[2]) threadId = parts[2]
    else if (parts[1] && parts[1] !== 'thread') threadId = parts[1]
    return { chatType: 'group', chatId, senderId: '', threadId }
  }
  return null
}

function scanFeishuBindings() {
  const integrations = path.join(dshHome(), 'integrations')
  const root = path.join(integrations, 'dsh-feishu', 'bots')
  if (!fs.existsSync(root)) return { scanned: 0, added: 0 }
  let scanned = 0
  let added = 0
  const current = readSessionMap()
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const state = readJson(path.join(root, dirent.name, 'state.json'), null)
    if (!isObj(state) || !isObj(state.sessions)) continue
    for (const [conversationKey, sessionId] of Object.entries(state.sessions)) {
      if (typeof sessionId !== 'string' || !sessionId) continue
      const parsed = parseConversationKey(conversationKey)
      if (!parsed) continue
      scanned += 1
      const existing = current[sessionId]
      if (existing && existing.auto !== true) continue // 手动登记优先，不覆盖
      const author = isObj(state.authors) && isObj(state.authors[conversationKey]) ? state.authors[conversationKey] : {}
      const senderId = String(author.senderId || parsed.senderId || '')
      const senderName = String(author.senderName || '')
      if (upsertAutoSession({
        channel: 'feishu',
        sessionId,
        chatType: parsed.chatType,
        chatId: parsed.chatId,
        threadId: parsed.threadId,
        senderId,
        senderName,
        botId: dirent.name
      })) added += 1
    }
  }
  return { scanned, added }
}

// ---------- 状态 / 注入 ----------

function writeStatus(kind, extra) {
  const x = extra || {}
  writeJson(statusFile(), {
    kind: String(kind || ''),
    at: Date.now(),
    mode: String(x.mode || ''),
    sessionId: String(x.sessionId || ''),
    channel: String(x.channel || ''),
    chatType: String(x.chatType || ''),
    chatId: String(x.chatId || ''),
    title: String(x.title || ''),
    chars: Number(x.chars || 0)
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

export function apply(ctx, config) {
  const mode = (config && config.mode) === 'shadow' ? 'shadow' : 'enforce'
  const turns = new Map()

  try { writeStatus('mount', { mode }) } catch { /* 状态写不进不影响注入 */ }
  try { ctx.logger.info('[social-policy] 已挂载 mode=' + mode + '；只对已登记社交会话注入') } catch { /* 引擎 logger 可能不可用 */ }
  try {
    const scan = scanFeishuBindings()
    if (scan.scanned > 0) {
      try { ctx.logger.info('[social-policy] 扫描飞书已有绑定 ' + scan.scanned + ' 条，新增登记 ' + scan.added + ' 条') } catch { /* logger 不可用 */ }
    }
  } catch (e) {
    try { ctx.logger.warn('[social-policy] 扫描飞书已有绑定失败：' + String((e && e.message) || e)) } catch { /* logger 不可用 */ }
  }

  const onBind = (event) => {
    try {
      const ok = upsertAutoSession(event)
      if (ok) {
        try {
          ctx.logger.info('[social-policy] 自动登记 ' + String(event.channel || '') + ' ' +
            String(event.chatType || '') + ' ' + String(event.chatId || '') + ' → ' + String(event.sessionId || ''))
        } catch { /* logger 不可用 */ }
        writeStatus('bind', {
          channel: event.channel,
          chatType: event.chatType,
          chatId: event.chatId,
          sessionId: event.sessionId,
          title: (event.senderName || '') + (event.chatId ? ' ' + event.chatId : '')
        })
      }
    } catch (e) {
      try { ctx.logger.warn('[social-policy] 自动登记失败：' + String((e && e.message) || e)) } catch { /* logger 不可用 */ }
    }
  }

  const onUnbind = (event) => {
    try {
      if (removeAutoSession(event)) {
        try { ctx.logger.info('[social-policy] 解除自动登记 ' + String(event.sessionId || '')) } catch { /* logger 不可用 */ }
        writeStatus('unbind', {
          channel: event.channel,
          chatType: event.chatType,
          chatId: event.chatId,
          sessionId: event.sessionId
        })
      }
    } catch (e) {
      try { ctx.logger.warn('[social-policy] 解除登记失败：' + String((e && e.message) || e)) } catch { /* logger 不可用 */ }
    }
  }

  // dsh-im 在会话真正绑定前发这个事件；先登记，首轮 pre-step 才能拿到卡。
  try { ctx.on('dsh-im/session-pre-bind', onBind) } catch { /* 老版本 dsh-im 没有这个事件 */ }
  try { ctx.on('dsh-im/session-unbind', onUnbind) } catch { /* 老版本 dsh-im 没有这个事件 */ }

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    try {
      if (!downstream || downstream.kind !== 'enter') return downstream
      const messages = payload && payload.messages
      if (!Array.isArray(messages) || !messages.length) return downstream
      // 微信通道已经在 _formatPrompt 里带卡；看到标记就说明这一轮已注入过。
      if (userText(messages).includes('【社交回复规范】')) return downstream
      const sid = sessionIdOf(payload && payload.agent)
      if (!sid) return downstream
      const entry = readSessionMap()[sid]
      if (!entry || !entry.channel) return downstream

      const turn = payload && payload.turn
      const turnKey = turn === undefined || turn === null ? '' : sid + '#' + String(turn)
      if (turnKey && turns.has(turnKey)) return downstream

      const text = buildSocialCard(entry)
      if (!text) return downstream
      if (mode === 'shadow') {
        if (turnKey) {
          turns.set(turnKey, 1)
          if (turns.size > 200) turns.delete(turns.keys().next().value)
        }
        writeStatus('shadow', {
          mode,
          sessionId: sid,
          channel: entry.channel,
          chatType: entry.chatType,
          chatId: entry.chatId,
          title: entry.title,
          chars: text.length
        })
        try { ctx.logger.info('[social-policy] shadow：本应注入 ' + entry.channel + ' ' + entry.chatType + ' ' + entry.chatId + ' ' + text.length + ' B') } catch { /* logger 不可用 */ }
        return downstream
      }

      const msg = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'social-policy' },
        content: [{ type: 'text', text }]
      }
      if (turnKey) {
        turns.set(turnKey, 1)
        if (turns.size > 200) turns.delete(turns.keys().next().value)
      }
      writeStatus('inject', {
        mode,
        sessionId: sid,
        channel: entry.channel,
        chatType: entry.chatType,
        chatId: entry.chatId,
        title: entry.title,
        chars: text.length
      })
      try { ctx.logger.info('[social-policy] 注入 ' + entry.channel + ' ' + entry.chatType + ' ' + entry.chatId + '（' + text.length + ' B）') } catch { /* logger 不可用 */ }
      return { ...downstream, messages: [...downstream.messages, msg] }
    } catch (e) {
      try { ctx.logger.warn('[social-policy] 注入失败：' + String((e && e.message) || e)) } catch { /* logger 不可用 */ }
      return downstream
    }
  })
}

export const _test = {
  dshHome,
  buildSocialCard,
  autoEntryOf,
  normalizeChannel,
  normalizeSessionMap,
  readSessionMap,
  upsertAutoSession,
  removeAutoSession,
  parseConversationKey,
  scanFeishuBindings
}
