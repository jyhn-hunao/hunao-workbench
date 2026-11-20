// 自检：不启动引擎，只验策略卡与绑定事件字段。
// 跑法：node 12-源码照搬\插件\社交策略\自检.mjs
import assert from 'node:assert/strict'
import { _test } from './index.js'

const {
  buildSocialCard,
  buildSocialCardWithMeta,
  noteToolDef,
  registerNoteTool,
  autoEntryOf,
  normalizeChannel,
} = _test

assert.equal(normalizeChannel('lark'), 'feishu')
assert.equal(normalizeChannel('weixin'), 'wechat')
assert.equal(normalizeChannel('QQ'), 'qq')

const qq = {
  channel: 'qq',
  chatType: 'group',
  chatId: '123456789',
  chatTitle: 'QQ 群聊 123456789',
  title: 'QQ 群聊 123456789'
}
const qqCard = buildSocialCard(qq)
assert.match(qqCard, /【社交回复规范】/)
assert.match(qqCard, /群聊/)
assert.match(qqCard, /默认旁听/)
assert.match(qqCard, /不刷屏/)
assert.match(qqCard, /QQ 通道自己的表情/)
assert.doesNotMatch(qqCard, /飞书不支持/)

const fs = {
  channel: 'feishu',
  chatType: 'private',
  chatId: 'oc_xxx',
  chatTitle: '飞书 私聊 张三',
  title: '飞书 私聊 张三'
}
const fsCard = buildSocialCard(fs)
assert.match(fsCard, /飞书不支持图片表情包/)
assert.doesNotMatch(fsCard, /\[\[sticker:开心\]\]/)
assert.doesNotMatch(fsCard, /\[\[sticker:傲娇\]\]/)

const bind = autoEntryOf({
  channel: 'lark',
  sessionId: 'session-test-feishu',
  chatType: 'group',
  chatId: 'oc_group_1',
  conversationKey: 'group:oc_group_1',
  senderName: '张三',
  senderId: 'ou_xxx',
  botId: 'bot-1'
})
assert.equal(bind.channel, 'feishu')
assert.equal(bind.chatType, 'group')
assert.equal(bind.chatId, 'oc_group_1')
assert.equal(bind.source, 'dsh-im')
assert.equal(bind.auto, true)
assert.equal(bind.account, 'bot-1')

assert.equal(autoEntryOf({ channel: 'feishu', chatId: 'oc_x' }), null)

// 关系卡：没有档案时不能把整张卡弄没；有 social_note 工具定义，参数齐全。
const emptyGroup = Object.assign({}, qq, { chatId: 'no-people-yet' })
const built = buildSocialCardWithMeta(emptyGroup, '（现在，路人 说：在吗）')
assert.match(built.text, /【社交回复规范】/)
assert.equal(built.relation.people, 0)
assert.equal(typeof built.relation.chars, 'number')
const def = noteToolDef()
assert.equal(def.name, 'social_note')
assert.deepEqual(def.parameters.required, ['kind', 'reason'])
assert.ok(def.parameters.properties.kind.enum.includes('好感+'))
assert.ok(def.parameters.properties.kind.enum.includes('情绪'))
assert.equal(typeof def.execute, 'function')

// 情绪联动表：数据面能被插件只读调用；烦躁时字更短、贴纸/语音直接关。
const st = _test.socialStateCore()
assert.equal(typeof st.moodPlan, 'function')
const plan = st.moodPlan({ visible: true, label: '烦躁', intensity: 50 }, st.DEFAULT_CONFIG, {})
assert.equal(plan.maxChars, 18)
assert.equal(plan.maxSentences, 1)
assert.equal(plan.stickerAllowed, false)
assert.equal(plan.voiceAllowed, false)
assert.equal(plan.groupFactor, 0.6)

// 注册链路：tools.register 收到定义，effect 能拿到 dispose；不启动引擎。
let registered = null
const fakeCtx = {
  tools: { register: (d) => { registered = d; return () => { registered = null } } },
  effect: () => {}
}
registerNoteTool(fakeCtx)
assert.equal(registered && registered.name, 'social_note')

console.log('✓ 社交策略自检通过：QQ 群聊卡 / 飞书卡 / dsh-im 自动登记字段 / 关系卡空数据降级 / social_note 参数与注册')
