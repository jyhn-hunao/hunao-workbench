// 回信路由（dsh-reply-router）
//
// 解决的问题：通道工具（尤其 QQ 的 qq_send）是全局注册的，工具描述写着
// 「正文永远停在会话里，只有调了这个工具消息才会出去」。人格主会话里还留着
// 历史通道消息，模型会把工作台面板里的对话当成 QQ 聊天，直接 qq_send 发出去，
// 面板这一轮正文反而是空的 —— 用户看到的就是「在对话框说话，回复却跑社交通道」。
//
// 本插件把「消息从哪来、就回哪去」做成硬闸：
//   1) agent/pre-step：按本轮真实用户消息判断来源（面板 rpcId / 通道前缀 / 已登记通道会话）；
//      面板来源就追加一条【回信路由】规则，告诉模型正文就是回复、通道工具禁用。
//   2) tools.guard：每轮缓存来源结论；面板来源的回合里，通道发送类工具一律拒绝执行。
//      通道来源的回合照常放行，不影响 QQ / 微信 / 飞书的正常回信。
//   3) 只有用户在本轮明确写「发到 QQ / 发到微信 / 发到飞书」时，才允许外发。
//
// 挂载点：agent/pre-step + tools.guard（都是引擎公开扩展点，不改通道插件源码）。
// 日志：<DSH_HOME>/logs/reply-router.jsonl（kind=route/inject/shadow/deny/error）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'reply-router'

const ROUTE_MARK = '【回信路由】'
// 只拦「会改变外部世界」的通道工具；查询/预览类（qq_msg_history / qq_emoji_search 等）不拦。
const SEND_TOOLS = new Set([
  'qq_send',
  'qq_pass',
  'qq_close',
  'qq_wait',
  'qq_qzone_post',
  'qq_group_notice',
  'qq_group_sign',
  'dsh_im_group_file',
])
const SEND_PREFIX = /^(feishu_|wechat_|wecom_)/i

// 通道消息正文前缀（各通道自己注入的，和面板消息最稳的区分之一）
const PREFIX_RULES = [
  { re: /（\s*QQ\s*(私聊|群)/i, channel: 'qq' },
  { re: /（\s*微信\s*(私聊|群聊)/, channel: 'wechat' },
  { re: /（\s*(企业微信|企微)/, channel: 'wecom' },
  { re: /（\s*飞书|【\s*飞书|[\[【]\s*飞书/, channel: 'feishu' },
]

// 用户在面板里明确要求外发才算放行；普通聊天里出现「微信」两个字不算。
const OUTBOUND_RULES = [
  /(发到|发去|发给|发在)\s*(QQ|qq|微信|飞书|企业微信|企微)/,
  /(在|用)\s*(QQ|qq|微信|飞书|企业微信|企微)\s*(里|上|中|那边)?\s*(发|说|回)/,
  /(QQ|qq|微信|飞书|企业微信|企微)\s*(那边|里|上)?\s*(发|说)一?[条句]/,
]

const state = {
  mode: 'enforce',
  turns: new Map(),      // sessionId -> { origin, channel, allow, at }
  registry: { at: 0, map: null },
}

function dshHome() {
  const env = String(process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || '').trim()
  if (env) return env
  // 安装位：<home>/profiles/web/node_modules/dsh-reply-router/index.js
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
}

function pluginHome() {
  try { return dshHome() } catch { return '' }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function log(kind, data) {
  try {
    const home = pluginHome()
    if (!home) return
    const dir = path.join(home, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const row = { at: new Date().toISOString(), kind, ...data }
    fs.appendFileSync(path.join(dir, 'reply-router.jsonl'), JSON.stringify(row) + '\n', 'utf8')
  } catch { /* 日志失败不能影响对话 */ }
}

// 已登记的社交会话（QQ 路由 / 微信映射 / 飞书 auto 登记）→ sessionId
function readRegistry() {
  const now = Date.now()
  if (state.registry.map && now - state.registry.at < 5000) return state.registry.map
  const map = new Map()
  const mem = path.join(pluginHome(), '场景记忆', '_共享记忆')

  const social = readJson(path.join(mem, '社交会话.json'))
  const sessions = isObj(social) && isObj(social.sessions) ? social.sessions : (isObj(social) ? social : {})
  for (const [sid, v] of Object.entries(sessions)) {
    if (!isObj(v) || (!v.channel && !v.chatType)) continue
    map.set(String(sid), {
      channel: String(v.channel || ''),
      chatType: String(v.chatType || ''),
      chatId: String(v.chatId || ''),
    })
  }

  const wechat = readJson(path.join(mem, '微信会话.json'))
  // 两种形态都认：{chats:{key:{sessionId}}} 与「sessionId 直接映射」
  const chats = isObj(wechat) && isObj(wechat.chats) ? wechat.chats : (isObj(wechat) ? wechat : {})
  for (const [key, v] of Object.entries(chats)) {
    if (!isObj(v)) continue
    const sid = String(v.sessionId || key)
    if (!v.sessionId && !sid.startsWith('session-')) continue
    map.set(sid, {
      channel: 'wechat',
      chatType: String(v.chatType || v.kind || ''),
      chatId: String(v.chatId || key),
    })
  }

  const qq = readJson(path.join(os.homedir(), '.dsh', 'qq-bridge.config.json'))
  const routes = isObj(qq) && isObj(qq.routes) ? qq.routes : {}
  for (const kind of ['private', 'group']) {
    const rows = isObj(routes[kind]) ? routes[kind] : {}
    for (const [id, v] of Object.entries(rows)) {
      if (!isObj(v) || !v.sessionId) continue
      map.set(String(v.sessionId), { channel: 'qq', chatType: kind, chatId: String(id) })
    }
  }

  state.registry = { at: now, map }
  return map
}

function sessionIdOf(agent) {
  if (!agent) return ''
  const sid = agent.session && agent.session.id
  return String(sid || agent.sessionId || '')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && b.type === 'text' ? String(b.text || '') : ''))
    .join('')
}

function isRealUser(m) {
  if (!m || m.role !== 'user') return false
  const kind = m.source && m.source.kind
  if (kind && !['user', 'client', 'console', 'unknown'].includes(kind)) return false
  return !textOf(m.content).includes(ROUTE_MARK)
}

function channelFromText(text) {
  for (const rule of PREFIX_RULES) if (rule.re.test(text)) return rule.channel
  return ''
}

function originOf(messages, sid) {
  const users = messages.filter(isRealUser)
  const last = users[users.length - 1]
  const reg = readRegistry().get(sid)
  if (!last) return { origin: reg ? 'channel' : 'unknown', channel: reg ? reg.channel : '', text: '' }

  const src = last.source || {}
  const text = textOf(last.content).trim()
  // 优先级：通道前缀 > 已登记通道会话 > rpcId > local。
  // 为什么不能「有 rpcId 就判面板」：微信通道的 _callSession 走引擎 RPC，
  // 投进会话的用户消息也带 rpcId（实测 2026-11-24）；只看 rpcId 会把微信正常回信误拦。
  // QQ 的入站消息不带 rpcId，所以「QQ 会话 + 带 rpcId」可以安全地判成面板里手打的。
  const byPrefix = channelFromText(text)
  if (byPrefix) return { origin: 'channel', channel: byPrefix, text }
  if (reg) {
    if (reg.channel === 'qq' && src.rpcId) return { origin: 'panel', channel: '', text }
    return { origin: 'channel', channel: reg.channel, text }
  }
  if (src.rpcId) return { origin: 'panel', channel: '', text }
  return { origin: 'local', channel: '', text }
}

function wantsOutbound(text) {
  const t = String(text || '')
  return OUTBOUND_RULES.some((re) => re.test(t))
}

function remember(sid, info) {
  if (!sid) return
  state.turns.set(sid, { ...info, at: Date.now() })
  if (state.turns.size > 500) state.turns.delete(state.turns.keys().next().value)
}

function isSendTool(toolName) {
  const n = String(toolName || '')
  return SEND_TOOLS.has(n) || SEND_PREFIX.test(n)
}

function routeText() {
  return [
    ROUTE_MARK + '本轮消息来自工作台面板（来源=对话框），不是 QQ / 微信 / 飞书通道。',
    '· 回复直接写成正文留在本会话；不要调用 qq_send / qq_pass / qq_close / qq_wait / qq_qzone_post / qq_group_notice / qq_group_sign / dsh_im_group_file 等通道工具，也不要往任何通道发。',
    '· qq_send 描述里的「正文永远停在会话里」只适用于 QQ 自己的会话；这里是工作台面板，正文会直接显示给用户。',
    '· 本会话历史里出现过的通道消息只代表过去，不代表本轮来源。',
    '· 只有本轮用户明确写了「发到 QQ / 发到微信 / 发到飞书」时，才允许用对应通道工具发出去。',
    '（这是系统给的回复路由规则，不是用户的话，不要复述。）',
  ].join('\n')
}

// 硬闸：面板来源的回合，通道发送类工具一律拒绝；通道来源照常放行。
function guardToolCall(exec) {
  try {
    const tool = String((exec && exec.name) || '')
    if (!isSendTool(tool)) return undefined
    const sid = sessionIdOf(exec && exec.agent)
    if (!sid) return undefined

    const turn = state.turns.get(sid)
    if (turn && turn.allow) return undefined
    if (!turn && readRegistry().has(sid)) return undefined // 老回合/主动回合：已登记通道会话放行

    if (state.mode === 'shadow') {
      log('shadow', { sessionId: sid, tool, origin: turn ? turn.origin : 'unknown', action: 'would-deny' })
      return undefined
    }

    log('deny', {
      sessionId: sid,
      tool,
      origin: turn ? turn.origin : 'unknown',
      channel: turn ? turn.channel : '',
    })
    return '本轮消息来自工作台面板（不是社交通道），' + tool
      + ' 已拦下：请直接把要回的话写成正文留在当前对话里。'
      + '只有用户本轮明确写了「发到 QQ / 发到微信 / 发到飞书」时才允许外发。'
  } catch { return undefined }
}

export function apply(ctx, config) {
  const mode = String((config && config.mode) || 'enforce') === 'shadow' ? 'shadow' : 'enforce'
  state.mode = mode
  const seenTurns = new Map() // 同一轮只注入一次：pre-step 在每个工具步都会跑
  const markSeen = (k) => {
    if (!k) return
    seenTurns.set(k, 1)
    if (seenTurns.size > 500) seenTurns.delete(seenTurns.keys().next().value)
  }
  log('mount', { mode })

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    try {
      if (!downstream || downstream.kind !== 'enter') return downstream
      const messages = payload && payload.messages
      if (!Array.isArray(messages) || !messages.length) return downstream
      const sid = sessionIdOf(payload && payload.agent)
      if (!sid) return downstream
      const turn = payload && payload.turn
      const turnKey = turn === undefined || turn === null ? '' : sid + '#' + String(turn)
      if (turnKey && seenTurns.has(turnKey)) return downstream

      const where = originOf(messages, sid)
      const allow = where.origin === 'channel' || wantsOutbound(where.text)
      remember(sid, { origin: where.origin, channel: where.channel, allow })

      // 通道来源：社交策略插件已经负责这一轮的语气/关系卡，这里不再插话。
      if (where.origin === 'channel' || where.origin === 'unknown') {
        log('route', { sessionId: sid, origin: where.origin, channel: where.channel, allow, action: 'skip' })
        markSeen(turnKey)
        return downstream
      }

      // 同一轮只追加一次（社会策略/记忆回响也可能在 messages 里留标记）。
      const already = downstream.messages.some((m) => textOf(m && m.content).includes(ROUTE_MARK))
      if (already) {
        markSeen(turnKey)
        return downstream
      }
      if (mode === 'shadow') {
        log('shadow', { sessionId: sid, origin: where.origin, channel: where.channel, allow })
        markSeen(turnKey)
        return downstream
      }

      const msg = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'reply-router' },
        content: [{ type: 'text', text: routeText() }],
      }
      markSeen(turnKey)
      log('inject', { sessionId: sid, origin: where.origin, allow })
      try { ctx.logger.info('[reply-router] 面板来源，已注入回信路由规则 session=' + sid) } catch { /* logger 不可用 */ }
      return { ...downstream, messages: [...downstream.messages, msg] }
    } catch (e) {
      log('error', { sessionId: sessionIdOf(payload && payload.agent), error: String((e && e.message) || e) })
      return downstream
    }
  })

  // 5. 挂硬闸：tools 服务可能比本插件晚就绪（2026-11-24 实测 dump-config 早载会拿不到），
  //    用 ctx.inject 等待服务；服务重建时回调会重新跑，不靠一次 ctx.get 定生死。
  const registerGuard = (c) => {
    try {
      const tools = c.get('tools')
      if (tools && typeof tools.guard === 'function') {
        tools.guard(guardToolCall)
        log('guard', { registered: true })
      } else {
        log('guard', { registered: false, reason: 'tools.guard 不可用' })
      }
    } catch (e) {
      log('error', { stage: 'guard', error: String((e && e.message) || e) })
    }
  }
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['tools'], (sub) => { registerGuard(sub) }) } catch (e) {
      log('error', { stage: 'guard-inject', error: String((e && e.message) || e) })
      registerGuard(ctx)
    }
  } else {
    registerGuard(ctx)
  }
}

// 自检用：不挂在引擎里也能验证判断逻辑
export const __test = { originOf, wantsOutbound, isSendTool, guardToolCall, remember, state, readRegistry, routeText }
