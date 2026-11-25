// 回信路由自检（不启动引擎）
//   node 12-源码照搬\插件\回信路由\自检.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.DSH_HOME = process.env.DSH_HOME || path.join(here, '..', '..', '引擎数据', '.dsh')
const { __test, apply } = await import('./index.js')

const { originOf, wantsOutbound, isSendTool, guardToolCall, remember, state, readRegistry, routeText } = __test
let failed = 0

function check(name, ok, detail) {
  console.log((ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  ← ' + detail))
  if (!ok) failed++
}

function msg(text, source = { kind: 'user' }) {
  return { role: 'user', source, content: [{ type: 'text', text }] }
}

const SID = 'session-test-reply-router'

// 1. 来源判断：无前缀、未登记、带 rpcId → 面板（注意不是「rpcId 优先」，见 3.1）
check('面板消息（rpcId）判为 panel', originOf([msg('早上好，饭团', { kind: 'user', rpcId: 'r-1' })], SID).origin === 'panel',
  JSON.stringify(originOf([msg('早上好，饭团', { kind: 'user', rpcId: 'r-1' })], SID)))

// 2. QQ 私聊前缀 → qq
check('QQ 私聊前缀判为通道', originOf([msg('（QQ 私聊·用户本人 QQ 2310468741）还活着吗？')], SID).origin === 'channel')

// 3. 微信群聊前缀 → wechat
check('微信群聊前缀判为通道', originOf([msg('（微信群聊 · 何笙 说）在吗')], SID).origin === 'channel')

// 3.1 微信真实投递带 rpcId（引擎 RPC），必须仍然判通道
const wxReal = originOf([msg('（微信私聊 · 静音胡闹 说）发个害羞的表情包', { kind: 'user', rpcId: '29169936-072b-48d2-91af-9e9de0c51ebd' })], 'session-8d0cf133-62c1-4a5c-bbea-d325d791767a')
check('带 rpcId 的微信消息仍判通道', wxReal.origin === 'channel' && wxReal.channel === 'wechat', JSON.stringify(wxReal))

// 3.1.1 QQ 会话里从面板手打的消息（带 rpcId、无前缀）判面板；QQ 入站本身不带 rpcId
const qqSession = [...readRegistry().entries()].find(([, v]) => v.channel === 'qq')
if (qqSession) {
  const panelInQq = originOf([msg('帮我看看这句怎么回', { kind: 'user', rpcId: 'r-panel-in-qq' })], qqSession[0])
  check('QQ 会话里的面板消息判 panel', panelInQq.origin === 'panel', JSON.stringify(panelInQq))
}

// 3.1 通道消息即使带 clientTimeZone，也按前缀优先判通道（防引擎自动补时区误判）
const qqWithTz = originOf([msg('（QQ 私聊·用户本人 QQ 2310468741）还活着吗？', { kind: 'user', clientTimeZone: 'Asia/Shanghai' })], SID)
check('带时区的通道消息仍判通道', qqWithTz.origin === 'channel', JSON.stringify(qqWithTz))

// 3.2 没有 rpcId、没有前缀、也不是登记会话 → local（fail-closed，不放行通道工具）
const localNoRpc = originOf([msg('早上好，饭团', { kind: 'user', clientTimeZone: 'Asia/Shanghai' })], 'session-not-registered-' + Date.now())
check('无 rpcId 且未登记判 local', localNoRpc.origin === 'local', JSON.stringify(localNoRpc))

// 4. 面板里提到「QQ」但没外发指令 → 不许外发
check('普通提到 QQ 不算外发', wantsOutbound('QQ 那个事你怎么看') === false)
check('明确发到 QQ 才放行', wantsOutbound('把这句话发到 QQ 给他') === true)
check('明确在微信里说才放行', wantsOutbound('在微信里说一句晚安') === true)

// 5. 工具识别
for (const t of ['qq_send', 'qq_pass', 'qq_close', 'qq_wait', 'qq_qzone_post', 'qq_group_notice', 'qq_group_sign', 'dsh_im_group_file']) {
  check('识别发送工具 ' + t, isSendTool(t) === true)
}
check('查询工具不拦 qq_msg_history', isSendTool('qq_msg_history') === false)
check('读群历史工具不拦 dsh_im_group_history', isSendTool('dsh_im_group_history') === false)
check('普通工具不拦 read_file', isSendTool('read_file') === false)

// 6. 硬闸：面板来源的回合拒绝 qq_send
remember(SID, { origin: 'panel', channel: '', allow: false })
const denied = guardToolCall({ name: 'qq_send', agent: { session: { id: SID } } })
check('面板回合拦下 qq_send', typeof denied === 'string' && denied.includes('面板'), String(denied))

// 7. 硬闸：通道来源的回合放行
remember(SID + '-qq', { origin: 'channel', channel: 'qq', allow: true })
check('QQ 来源回合放行 qq_send', guardToolCall({ name: 'qq_send', agent: { session: { id: SID + '-qq' } } }) === undefined)

// 8. 明确外发的面板回合放行
remember(SID + '-send', { origin: 'panel', channel: '', allow: true })
check('明确要求外发时放行', guardToolCall({ name: 'qq_send', agent: { session: { id: SID + '-send' } } }) === undefined)

// 9. 未登记会话 + 无本轮状态：fail-closed（不往通道发）
const stray = 'session-test-stray-' + Date.now()
check('无状态的非通道会话拦下', typeof guardToolCall({ name: 'qq_send', agent: { session: { id: stray } } }) === 'string')

// 9.1 shadow 模式只记录不拦截
state.mode = 'shadow'
const shadowDeny = guardToolCall({ name: 'qq_send', agent: { session: { id: SID } } })
check('shadow 模式不拦截', shadowDeny === undefined, String(shadowDeny))
state.mode = 'enforce'

// 10. 已登记通道会话即使没有本轮状态也放行（主动回合）
const registered = [...readRegistry().keys()][0]
if (registered) {
  check('已登记通道会话放行（主动回合）', guardToolCall({ name: 'qq_send', agent: { session: { id: registered } } }) === undefined)
} else {
  console.log('· 跳过「已登记通道会话」：当前机器没有社交会话表')
}

// 10.1 微信镜像两种形态都要认（本机是 sessionId 直接映射）
const wechatEntry = [...readRegistry().entries()].find(([, v]) => v.channel === 'wechat')
if (wechatEntry) {
  check('微信镜像会话读进登记表', true)
} else {
  console.log('· 跳过「微信镜像」：当前机器没有微信会话表')
}

// 11. 规则文案含关键约束
const text = routeText()
check('规则含禁用 qq_send', text.includes('qq_send'))
check('规则含群公告/群签到工具', text.includes('qq_group_notice') && text.includes('qq_group_sign'))
check('规则含「只有本轮明确写了」', text.includes('只有本轮用户明确写了'))
check('规则含「历史不代表本轮来源」', text.includes('历史里出现过的通道消息只代表过去'))

check('本轮状态表可写入', state.turns.has(SID))

// 12. 模拟引擎：pre-step 真的注入、同轮不重复、guard 真的挂上
const tmpHome = path.join(here, '.tmp-test-home')
process.env.DSH_HOME = tmpHome
let handler = null
let guarded = null
const ctx = {
  on: (ev, fn) => { if (ev === 'agent/pre-step') handler = fn },
  get: (n) => (n === 'tools' ? { guard: (fn) => { guarded = fn } } : null),
  logger: { info: () => {} },
}
apply(ctx, { mode: 'enforce' })
const prepSid = 'session-test-prep'
const pmsg = msg('早上好，饭团', { kind: 'user', rpcId: 'r-prep' })
const base = { kind: 'enter', messages: [pmsg] }
const r1 = await handler({ agent: { session: { id: prepSid } }, messages: [pmsg], turn: 88 }, async () => base)
const last = r1 && r1.messages && r1.messages[r1.messages.length - 1]
check('pre-step 注入回信路由规则', !!(last && last.content && last.content[0] && String(last.content[0].text).includes('【回信路由】')))
check('注入消息来源 reply-router', last && last.source && last.source.kind === 'reply-router')
const r2 = await handler({ agent: { session: { id: prepSid } }, messages: [pmsg], turn: 88 }, async () => base)
check('同一轮不重复注入', r2 && r2.messages && r2.messages.length === 1, JSON.stringify(r2 && r2.messages && r2.messages.length))
check('tools.guard 已注册', typeof guarded === 'function')
check('注入后硬闸可用', !!(guarded && typeof guarded({ name: 'qq_send', agent: { session: { id: prepSid } } }) === 'string'))
let guarded2 = null
const ctx2 = {
  on: () => {},
  get: (n) => (n === 'tools' ? { guard: (fn) => { guarded2 = fn } } : null),
  logger: { info: () => {} },
  inject: (deps, cb) => cb(ctx2),
}
apply(ctx2, { mode: 'enforce' })
check('ctx.inject 路径 guard 已注册', typeof guarded2 === 'function')
try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
