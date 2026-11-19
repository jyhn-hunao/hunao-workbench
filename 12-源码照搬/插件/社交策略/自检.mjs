// 自检：不启动引擎，只验策略卡与绑定事件字段。
// 跑法：node 12-源码照搬\插件\社交策略\自检.mjs
import assert from 'node:assert/strict'
import { _test } from './index.js'

const {
  buildSocialCard,
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

console.log('✓ 社交策略自检通过：QQ 群聊卡 / 飞书卡 / dsh-im 自动登记字段')
