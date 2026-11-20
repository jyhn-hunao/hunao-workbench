// @功能台 {"name":"社交状态","group":"社交","freq":"按需","plain":"查/改对每个人的熟悉度与好感、她自己当前的情绪；可预览模型下一轮会看到的卡。","why":"关系与情绪是社交表达的分层状态，必须可观测可配置，不能让模型黑盒打分。","label":"关系与情绪"}
//
// 社交状态.mjs —— 关系与情绪的命令行入口（2026-11-20）
//
// 用法：
//   node 12-源码照搬\工具\社交状态.mjs check
//   node 12-源码照搬\工具\社交状态.mjs 建档 --all
//   node 12-源码照搬\工具\社交状态.mjs 巡检
//   node 12-源码照搬\工具\社交状态.mjs 设 --聊天 qq:group:123 --人 何笙 --熟悉 63 --好感 14 --标签 "爱开玩笑|夜猫子"
//   node 12-源码照搬\工具\社交状态.mjs 设 --聊天 qq:group:123 --人 静音胡闹 --称呼 胡闹 --身份 主人 --熟悉 100 --好感 100
//   node 12-源码照搬\工具\社交状态.mjs 设 --聊天 qq:group:123 --人 何笙 --解锁 --熟悉底 60 --好感底 60
//   node 12-源码照搬\工具\社交状态.mjs 重置 --聊天 qq:group:123 --人 何笙 [--硬]
//   node 12-源码照搬\工具\社交状态.mjs 情绪 --设 烦躁 --强度 38 --原因 "被连着催了两次"
//   node 12-源码照搬\工具\社交状态.mjs 情绪 --平静
//   node 12-源码照搬\工具\社交状态.mjs 预览 --聊天 qq:group:123 --说话人 何笙
//   node 12-源码照搬\工具\社交状态.mjs 自检
//
// 口径：真源在 外壳\data\社交关系.json / 社交情绪.json；镜像在 DSH_HOME\场景记忆\_共享记忆\。
// 命令行只读写真源，不直接改镜像；写完由模块统一同步。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHELL_DIR = path.resolve(HERE, '..', '外壳')
const req = createRequire(import.meta.url)
const state = req(path.join(SHELL_DIR, '社交状态.js'))

const argv = process.argv.slice(2)
const cmd = String(argv[0] || 'check')

function has(name) {
  return argv.indexOf('--' + name) >= 0
}

function arg(name, dflt) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = argv[i + 1]
  return v === undefined || v.indexOf('--') === 0 ? true : v
}

function out(v) {
  if (has('json')) console.log(JSON.stringify(v, null, 2))
  else console.log(v)
}

function fail(msg, code) {
  console.error('失败：' + msg)
  process.exit(code === undefined ? 1 : code)
}

function need(name) {
  const v = arg(name, '')
  if (!v || v === true) fail('缺 --' + name)
  return String(v)
}

function fmtStage(s) {
  return s ? (s.label + '（熟悉 ' + s.familiarity + ' / 好感 ' + (s.affinity >= 0 ? '+' : '') + s.affinity + '）') : '无档位'
}

function cmdCheck() {
  const info = state.inspect()
  if (has('json')) return out(info)
  const cfg = info.config
  console.log('关系与情绪 · 当前状态')
  console.log('  真源：' + info.paths.relations)
  console.log('  情绪：' + info.paths.mood)
  console.log('  镜像：' + info.paths.mirror)
  console.log('  人数 ' + info.people.length + ' / 聊天 ' + info.chats.length +
    ' / 注入 ' + (cfg.inject ? '开' : '关') + ' / 模型事件 ' + (cfg.modelNotesEnabled ? '开' : '关'))
  console.log('  初始值：新人熟悉 ' + cfg.privateFamiliarity + ' / 好感 ' + cfg.privateAffinity +
    '；主人熟悉 ' + cfg.ownerFamiliarity + ' / 好感 ' + cfg.ownerAffinity +
    '（称呼「' + cfg.ownerPreferredName + '」/ 身份「' + cfg.ownerRole + '」）')
  console.log('  心情：' + info.mood.label + '（强度 ' + info.mood.intensity + '/100' +
    (info.mood.remainingMin ? '，约 ' + info.mood.remainingMin + ' 分钟后回平静' : '') + '）' +
    (info.mood.cause ? '；原因：' + info.mood.cause : ''))
  console.log('  档位分布：')
  for (const s of info.stages) {
    const n = info.people.filter((p) => p.stage.key === s.key).length
    if (n) console.log('    ' + s.label + '：' + n)
  }
  console.log('  聊天：')
  for (const c of info.chats) {
    console.log('    ' + c.label + ' · ' + c.count + ' 人 · 平均熟悉 ' + c.averageFamiliarity + ' / 好感 ' + c.averageAffinity)
  }
  if (info.recentCards.length) {
    console.log('  最近注入：')
    for (const r of info.recentCards.slice(0, 5)) {
      console.log('    ' + r.at + ' · ' + r.channel + ' ' + r.chatType + ' ' + r.chatId +
        ' · ' + (r.people || 0) + ' 人 · ' + (r.mood || '无情绪') + ' · ' + (r.relationChars || 0) + ' B')
    }
  }
  const b = info.moodBase
  console.log('  情绪基线：' + b.label + ' 强度 ' + b.baseIntensity + ' 半衰期 ' + b.halfLife + ' 分钟')
}

function cmdSeed() {
  const chatKey = arg('聊天', '')
  const r = state.seedFromArchive({ chatKey: chatKey === true ? '' : String(chatKey || ''), hard: has('硬') })
  if (!r.ok) fail(r.error)
  out('建档完成：' + r.chats + ' 个聊天 / ' + r.people + ' 人（新增 ' + r.created + '）')
}

function cmdPatrol() {
  const r = state.patrol()
  out('巡检完成：' + (r.seed && r.seed.ok
    ? ('档案 ' + r.seed.chats + ' 个聊天 / ' + r.seed.people + ' 人')
    : ('档案跳过：' + ((r.seed && r.seed.error) || '未知'))) +
    '；心情 ' + r.mood.label + '（' + r.mood.intensity + '/100）')
}

function cmdSet() {
  const chatKey = need('聊天')
  const name = need('人')
  const patch = { chatKey, name }
  if (has('熟悉')) patch.familiarity = Number(arg('熟悉', 0))
  if (has('好感')) patch.affinity = Number(arg('好感', 0))
  if (has('熟悉底')) patch.familiarityBase = Number(arg('熟悉底', 60))
  if (has('好感底')) patch.affinityBase = Number(arg('好感底', 60))
  if (has('称呼')) patch.preferredName = String(arg('称呼', ''))
  if (has('身份')) patch.role = String(arg('身份', ''))
  if (has('别名')) patch.aliases = String(arg('别名', ''))
  if (has('标签')) patch.tags = String(arg('标签', ''))
  if (has('备注')) patch.note = String(arg('备注', ''))
  if (has('解锁')) {
    patch.familiarity = null
    patch.affinity = null
  }
  const r = state.savePerson(patch)
  if (!r.ok) fail(r.error)
  out('已写：' + r.person.name + ' · ' + fmtStage(r.stage) +
    '；熟悉基础 ' + r.person.familiarityBase + ' / 好感基础 ' + r.person.affinityBase +
    (r.person.manual.familiarity !== null || r.person.manual.affinity !== null ? '（已手动锁定）' : ''))
}

function cmdReset() {
  const chatKey = need('聊天')
  const name = need('人')
  const r = state.resetPerson({ chatKey, name, hard: has('硬') })
  if (!r.ok) fail(r.error)
  out(has('硬') ? '已删除档案：' + name : '已重置为默认：' + name)
}

function fmtPlan(p) {
  const plan = p || {}
  return '文字' + (Number(plan.maxChars) ? '≤' + Number(plan.maxChars) + '字' : '不限') +
    ' / 句子' + (Number(plan.maxSentences) ? '≤' + Number(plan.maxSentences) + '句' : '不限') +
    ' / emoji×' + Number(plan.emojiFactor || 0) +
    ' / 贴纸×' + Number(plan.stickerFactor || 0) +
    ' / 语音×' + Number(plan.voiceFactor || 0) +
    ' / 群接话×' + Number(plan.groupFactor || 0) +
    ' / ' + (plan.stickerAllowed === false ? '不发贴纸' : '可发贴纸') +
    ' / ' + (plan.voiceAllowed === false ? '不发语音' : '可发语音')
}

function cmdMood() {
  if (has('平静')) {
    const r = state.resetMood()
    if (!r.ok) fail(r.error)
    return out('心情已回平静')
  }
  if (!has('设')) {
    const info = state.inspect()
    return out('当前心情：' + info.mood.label + '（' + info.mood.intensity + '/100' +
      (info.mood.remainingMin ? '，约 ' + info.mood.remainingMin + ' 分钟后回平静' : '') + '）' +
      (info.mood.cause ? '；原因：' + info.mood.cause : '') +
      '\n本轮联动：' + fmtPlan(info.moodPlan))
  }
  const r = state.setMood({ label: String(arg('设', '')), intensity: Number(arg('强度', 40)), cause: String(arg('原因', '')) })
  if (!r.ok) fail(r.error)
  out('已设心情：' + r.mood.label + '（' + r.mood.intensity + '/100，约 ' + r.mood.remainingMin + ' 分钟后回平静）' +
    (r.mood.cause ? '；原因：' + r.mood.cause : '') +
    '\n本轮联动：' + fmtPlan(state.inspect().moodPlan))
}

function cmdPreview() {
  const chatKey = need('聊天')
  const parsed = state.parseChatKey(chatKey)
  if (!parsed) fail('聊天键格式应为 channel:chatType:chatId，例 qq:group:123')
  const r = state.preview({
    channel: parsed.channel,
    chatType: parsed.chatType,
    chatId: parsed.chatId,
    senderName: String(arg('说话人', '')),
    text: String(arg('文本', ''))
  })
  if (!r.ok) fail(r.error)
  console.log('--- 注入预览（' + r.chars + ' B）---')
  console.log('本轮联动：' + fmtPlan(r.moodPlan))
  console.log(r.text || '（这一轮不会注入关系段：没数据或开关关着）')
}

function assert(ok, name, detail) {
  if (ok) { console.log('  ✓ ' + name); return true }
  console.log('  ✗ ' + name + (detail ? '：' + detail : ''))
  return false
}

function cmdSelfCheck() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'social-state-'))
  const dsh = path.join(tmp, 'dsh')
  let clock = Date.parse('2026-11-20T10:00:00+08:00')
  const st = state.createStore({ dataDir: tmp, dshHome: dsh, now: () => clock })
  const chat = 'qq:group:100'
  const pchat = 'wechat:private:alice'
  let pass = 0
  let total = 0
  function T(name, fn) {
    total += 1
    try { if (assert(fn(), name)) pass += 1 } catch (e) { assert(false, name, String((e && e.message) || e)) }
  }

  // 1. 空文件 → 默认值，不报错
  T('空文件按默认值运行', () => {
    const r = st.readRelations()
    return !!r.config && Object.keys(r.people).length === 0 && r.config.affinityDailyCap === 6
  })

  // 2. 建档：41 条 / 6 天 → 熟悉度 20.5 + 18 = 38.5
  T('档案公式：41 条 ×0.5 + 6 天 ×3 = 38.5', () => {
    const r = st.readRelations()
    const p = st.ensurePerson(r, { chatKey: chat, channel: 'qq', chatType: 'group', chatId: '100', senderId: 'he', senderName: '何笙' })
    p.stats.messages = 41
    p.stats.days = 6
    p.stats.lastAt = clock
    p.familiarityBase = 41 * r.config.familiarityMsgWeight + 6 * r.config.familiarityDayWeight
    st.writeRelations(r)
    const s = st.stageOf(st.readRelations().people[state.personKeyOf(chat, 'he', '何笙')], r.config, clock)
    return Math.abs(s.familiarity - 38.5) < 0.1 && s.label === '认识'
  })

  // 3. 单次 +5 被夹到 +3
  T('单次好感 +5 夹到 +3', () => {
    const r = st.applyNote({ channel: 'qq', chatType: 'group', chatId: '100', person: '何笙', kind: '好感+', delta: 5, reason: '记得口味', source: 'model' })
    return r.ok && r.delta === 3
  })

  // 4. 单日 +10 夹到 +6（先把基础值归零，避免受上一条 +3 影响）
  T('单日好感上限 +6', () => {
    const rel = st.readRelations()
    const p = rel.people[state.personKeyOf(chat, 'he', '何笙')]
    p.affinityBase = 0
    p.manual.affinity = null
    p.events = []
    st.writeRelations(rel)
    st.applyNote({ channel: 'qq', chatType: 'group', chatId: '100', person: '何笙', kind: '好感+', delta: 3, reason: '第二次', source: 'model' })
    const before = st.findPerson(st.readRelations(), chat, '何笙').person.affinityBase
    const r = st.applyNote({ channel: 'qq', chatType: 'group', chatId: '100', person: '何笙', kind: '好感+', delta: 3, reason: '第三次', source: 'model' })
    const after = st.findPerson(st.readRelations(), chat, '何笙').person.affinityBase
    return before === 3 && r.ok && r.delta === 3 && after === 6
  })

  // 5. 30 天无互动 → 好感向 0 移动 2
  T('好感 30 天衰减 2', () => {
    const r = st.readRelations()
    const p = r.people[state.personKeyOf(chat, 'he', '何笙')]
    p.affinityBase = 10
    p.manual.affinity = null
    p.stats.lastAt = clock - 31 * 86400000
    st.writeRelations(r)
    return st.effectiveAffinity(st.readRelations().people[state.personKeyOf(chat, 'he', '何笙')], r.config, clock) === 8
  })

  // 6. 60 天无互动 → 熟悉度 -3，且不低于 floor
  T('熟悉度 60 天衰减 3、守住 floor', () => {
    const r = st.readRelations()
    const p = r.people[state.personKeyOf(chat, 'he', '何笙')]
    p.familiarityBase = 12
    p.manual.familiarity = null
    p.stats.lastAt = clock - 61 * 86400000
    st.writeRelations(r)
    const eff = st.effectiveFamiliarity(st.readRelations().people[state.personKeyOf(chat, 'he', '何笙')], r.config, clock)
    return eff === 10
  })

  // 7. 滞回：58 仍算「熟」，54 才掉档
  T('档位滞回：58 保留熟、54 掉档', () => {
    const r = st.readRelations()
    const p = r.people[state.personKeyOf(chat, 'he', '何笙')]
    p.familiarityBase = 58
    p.stats.lastAt = clock
    p.lastStage = 'close'
    st.writeRelations(r)
    const a = st.stageOf(p, r.config, clock).key
    p.familiarityBase = 54
    st.writeRelations(r)
    const b = st.stageOf(st.readRelations().people[state.personKeyOf(chat, 'he', '何笙')], r.config, clock).key
    return a === 'close' && b === 'friend'
  })

  // 8. 群名单不串聊天
  T('群名单只出现本聊天的人', () => {
    const r = st.readRelations()
    st.ensurePerson(r, { chatKey: pchat, channel: 'wechat', chatType: 'private', chatId: 'alice', senderName: '小A' })
    r.people[state.personKeyOf(pchat, '', '小A')].familiarityBase = 60
    st.writeRelations(r)
    const txt = st.relationFragment({ channel: 'qq', chatType: 'group', chatId: '100' })
    return txt.indexOf('小A') < 0 && txt.indexOf('何笙') >= 0
  })

  // 9. 当前说话人不在前 10 也强制入列
  T('当前说话人强制进入名单', () => {
    const r = st.readRelations()
    for (let i = 1; i <= 11; i++) {
      const p = st.ensurePerson(r, { chatKey: chat, channel: 'qq', chatType: 'group', chatId: '100', senderId: 'u' + i, senderName: '群友' + i })
      p.familiarityBase = 100
      p.stats.lastAt = clock
    }
    const sp = r.people[state.personKeyOf(chat, 'u12', '说话人')]
    const p = st.ensurePerson(r, { chatKey: chat, channel: 'qq', chatType: 'group', chatId: '100', senderId: 'u12', senderName: '说话人' })
    p.familiarityBase = 0
    p.stats.lastAt = clock
    r.config.groupRosterLimit = 10
    st.writeRelations(r)
    const txt = st.relationFragment({ channel: 'qq', chatType: 'group', chatId: '100', senderName: '说话人' })
    const rosterCount = txt.split(/\r?\n/).filter((line) => line.indexOf('· ') === 0).length
    const ok = txt.indexOf('说话人') >= 0 && rosterCount <= 10
    if (!ok) console.log('    [调试] ' + JSON.stringify(txt))
    return ok
  })

  // 10. 情绪 38 → 90 分钟 ≈ 19 → 再 90 分钟 <10 回平静
  T('情绪半衰期 90 分钟', () => {
    st.setMood({ label: '烦躁', intensity: 38, cause: '被连着催' })
    const a = st.effectiveMood(st.readMood(), st.readRelations().config, clock)
    clock += 90 * 60000
    const b = st.effectiveMood(st.readMood(), st.readRelations().config, clock)
    clock += 90 * 60000
    const c = st.effectiveMood(st.readMood(), st.readRelations().config, clock)
    return a.intensity === 38 && Math.abs(b.intensity - 19) < 0.2 && c.intensity < 10 && c.visible === false
  })

  // 11. 情绪强度 8 → 卡里不出现情绪行
  T('情绪低于阈值不注入', () => {
    st.setMood({ label: '低落', intensity: 8 })
    const txt = st.relationFragment({ channel: 'qq', chatType: 'group', chatId: '100' })
    return txt.indexOf('心情：') < 0
  })

  // 12. 手动锁定好感 → 自动事件只记账不改值
  T('手动锁定好感优先', () => {
    const r = st.readRelations()
    const key = state.personKeyOf(chat, 'u2', '群友2')
    r.people[key].manual.affinity = 20
    st.writeRelations(r)
    const x = st.applyNote({ channel: 'qq', chatType: 'group', chatId: '100', person: '群友2', kind: '好感+', delta: 3, reason: '被夸', source: 'model' })
    const p = st.readRelations().people[key]
    return x.ok && x.applied === false && p.affinityBase === r.people[key].affinityBase && p.manual.affinity === 20
  })

  // 13. 严重负向锁 24h，正向事件不能立刻抵消
  T('严重负向锁定期拒绝正向抵消', () => {
    const key = state.personKeyOf(chat, 'u3', '群友3')
    const x = st.applyNote({ channel: 'qq', chatType: 'group', chatId: '100', person: '群友3', kind: '严重-', delta: -10, reason: '人身攻击', source: 'model' })
    const y = st.applyNote({ channel: 'qq', chatType: 'group', chatId: '100', person: '群友3', kind: '好感+', delta: 3, reason: '道歉', source: 'model' })
    return x.ok && x.applied === true && y.ok && y.applied === false
  })

  // 14. 群接话系数可配置
  T('群接话系数按档位可配', () => {
    st.saveConfig({ groupBiasEnabled: true, groupBias: { close: 1.4 } })
    const r = st.readRelations()
    const p = r.people[state.personKeyOf(chat, 'u2', '群友2')]
    p.familiarityBase = 70
    p.affinityBase = 20
    p.manual.familiarity = null
    p.manual.affinity = null
    p.stats.lastAt = clock
    st.writeRelations(r)
    const info = st.groupBiasInfo({ channel: 'qq', chatType: 'group', chatId: '100', person: '群友2' })
    return info.bias === 1.4
  })

  // 15. 预览卡有字数、可复现
  T('预览卡给出字数', () => {
    const r = st.preview({ channel: 'qq', chatType: 'group', chatId: '100', senderName: '说话人' })
    return r.ok && r.chars === r.text.length && r.chars > 0
  })

  // 16. 手动建档：没有档案库也能给某个人建档，且立刻出现在聊天索引里
  T('手动建档进入聊天索引', () => {
    const r = st.savePerson({ chatKey: 'qq:group:200', name: '手动的人', affinity: 20, tags: '新|测试' })
    const rel = st.readRelations()
    return r.ok && r.person.name === '手动的人' && r.person.manual.affinity === 20 &&
      !!rel.chats['qq:group:200'] && rel.chats['qq:group:200'].members.some((m) => m.name === '手动的人')
  })

  // 17. 情绪联动：表里的字/句/系数直接变成通道可执行参数，且不会放宽通道上限
  T('情绪联动表生成通道参数', () => {
    const cfg = st.readRelations().config
    const plan = st.moodPlan({ visible: true, label: '烦躁', intensity: 50 }, cfg, { maxChars: 60, maxSentences: 2 })
    return plan.maxChars === 18 && plan.maxSentences === 1 &&
      plan.stickerAllowed === false && plan.voiceAllowed === false && plan.groupFactor === 0.6
  })

  // 18. 用户口径：新人初始值 60/60，但 manual 仍为空，之后能继续自动变
  T('新人初始值 60 / 60（不是永久锁定）', () => {
    const r = st.savePerson({ chatKey: 'qq:group:300', name: '新人甲' })
    return r.ok && r.stage.familiarity === 60 && r.stage.affinity === 60 &&
      r.person.manual.familiarity === null && r.person.manual.affinity === null
  })

  // 19. 主人例外：100/100，称呼「胡闹」，身份「主人」
  T('主人档案 100 / 100 且称呼胡闹', () => {
    const r = st.savePerson({ chatKey: 'qq:group:300', name: '静音胡闹' })
    return r.ok && r.stage.familiarity === 100 && r.stage.affinity === 100 &&
      r.person.preferredName === '胡闹' && r.person.role === '主人'
  })

  // 20. 称呼真的进卡：名单用「胡闹（主人）」，并明确不要叫原显示名
  T('关系卡按胡闹称呼主人', () => {
    const txt = st.relationFragment({
      channel: 'qq', chatType: 'group', chatId: '300', senderId: '', senderName: '静音胡闹'
    })
    return txt.indexOf('胡闹（主人）') >= 0 && txt.indexOf('不要叫') >= 0
  })

  console.log('\n自检：' + pass + '/' + total + ' 通过')
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(pass === total ? 0 : 1)
}

try {
  if (cmd === 'check' || cmd === 'status') cmdCheck()
  else if (cmd === '建档' || cmd === 'seed') cmdSeed()
  else if (cmd === '巡检' || cmd === 'patrol') cmdPatrol()
  else if (cmd === '设' || cmd === 'set') cmdSet()
  else if (cmd === '重置' || cmd === 'reset') cmdReset()
  else if (cmd === '情绪' || cmd === 'mood') cmdMood()
  else if (cmd === '预览' || cmd === 'preview') cmdPreview()
  else if (cmd === '自检' || cmd === 'selfcheck') cmdSelfCheck()
  else fail('不认识的命令：' + cmd + '\n可用：check / 建档 / 巡检 / 设 / 重置 / 情绪 / 预览 / 自检')
} catch (e) {
  fail(String((e && e.stack) || e))
}
