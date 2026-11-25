'use strict'
// 社交状态.js —— 关系与情绪的数据面（2026-11-20）
//
// 定位：把「对每个人的好感」和「她自己此刻的情绪」做成可观测的一层，
//       只影响表达（句子长短 / 主动度 / 玩笑尺度 / 称呼 / emoji 概率 / 群接话概率），
//       不改事实、边界、安全规则和人格底线。
//
// 两条硬口径：
//   1. 关系是慢变量（按人，熟悉度 + 好感），情绪是快变量（按她自己，带半衰期）；
//      三条曲线的参数全在 config.curves，但 2026-11-24 起由 DEFAULT_CONFIG 固定成标准，
//      面板只读，不再让人手动加减分 / 调曲线。
//   2. 所有变化都要能追溯：事件带 source / reason / evidence，面板能看到，CLI 能查。
//
// 数据（唯一真源在 外壳\data\，镜像给 DSH 插件读）：
//   外壳\data\社交关系.json                 people + chats + config
//   外壳\data\社交情绪.json                 mood + events
//   <DSH_HOME>\场景记忆\_共享记忆\社交关系.json
//   <DSH_HOME>\场景记忆\_共享记忆\社交情绪.json
//   <DSH_HOME>\logs\social-state.jsonl      每次改分 / 每轮注入的机器可读记录
//
// 失败口径：文件坏 / 镜像写不进 / 档案库读不到 → 返回可读的 error，注入层按「没数据」跳过，
//          绝不阻断消息；不伪造关系，也不把默认生人写成熟人。

const fs = require('fs')
const path = require('path')

const DATA_DIR = process.env.DSH_SHELL_DATA || path.join(__dirname, 'data')
const REL_FILE = path.join(DATA_DIR, '社交关系.json')
const MOOD_FILE = path.join(DATA_DIR, '社交情绪.json')
const SESSIONS_FILE = path.join(DATA_DIR, '社交会话.json')
// 取 home 必须等到真正调用时再读 env：main.js 顶部的 require 早于它写回 DSH_HOME，
// 在模块加载时算成常量，安装版就会退回 resources\引擎数据（另一份数据目录）。
function defaultDshHome() {
  return process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || path.join(__dirname, '..', '引擎数据', '.dsh')
}

// 情绪联动表：每个标签对回复表达的影响，全部可观测；2026-11-24 起由 DEFAULT_MOOD_EFFECTS 固定。
// maxChars / maxSentences 为 0 表示不额外限制；系数 1 表示不改变原通道概率。
const DEFAULT_MOOD_EFFECTS = {
  平静: { maxChars: 60, maxSentences: 2, emojiFactor: 1, stickerFactor: 1, voiceFactor: 1, groupFactor: 1 },
  开心: { maxChars: 70, maxSentences: 2, emojiFactor: 1.2, stickerFactor: 1, voiceFactor: 1.1, groupFactor: 1.1 },
  兴奋: { maxChars: 70, maxSentences: 2, emojiFactor: 1.3, stickerFactor: 1, voiceFactor: 1.2, groupFactor: 1.2 },
  得意: { maxChars: 65, maxSentences: 2, emojiFactor: 1.1, stickerFactor: 1, voiceFactor: 1.1, groupFactor: 1.1 },
  低落: { maxChars: 24, maxSentences: 1, emojiFactor: 0, stickerFactor: 0, voiceFactor: 0, groupFactor: 0.7 },
  委屈: { maxChars: 22, maxSentences: 1, emojiFactor: 0, stickerFactor: 0, voiceFactor: 0, groupFactor: 0.7 },
  烦躁: { maxChars: 18, maxSentences: 1, emojiFactor: 0, stickerFactor: 0, voiceFactor: 0, groupFactor: 0.6 },
  疲惫: { maxChars: 20, maxSentences: 1, emojiFactor: 0, stickerFactor: 0, voiceFactor: 0.3, groupFactor: 0.6 },
  心虚: { maxChars: 30, maxSentences: 1, emojiFactor: 0.5, stickerFactor: 0.5, voiceFactor: 0.8, groupFactor: 0.8 }
}

// 所有默认值都进 DEFAULT_CONFIG；2026-11-24 起分数 / 曲线 / 联动表是固定标准，面板只读。
const DEFAULT_CONFIG = {
  version: 3,
  enabled: true,
  inject: true,
  modelNotesEnabled: true,
  // 注入
  groupRosterLimit: 10,
  cardMaxChars: 600,
  // 初始值：只给「新建档案」用作起点，之后仍按熟悉度公式 / 好感事件 / 衰减继续变。
  // 60 是用户指定的新人初始值；主人档案由 owner* 单独覆盖，不跟随这个初始值。
  privateAffinity: 60,
  groupAffinity: 60,
  privateFamiliarity: 60,
  groupFamiliarity: 60,
  // 主人：称呼与初始值都可改；默认按这两个别名认人，避免把「静音胡闹」叫出口。
  ownerAliases: ['静音胡闹', '胡闹'],
  ownerSenderIds: [],
  ownerPreferredName: '胡闹',
  ownerRole: '主人',
  ownerFamiliarity: 100,
  ownerAffinity: 100,
  // 熟悉度：由档案统计折算，公式完全可见
  familiarityMsgWeight: 0.5,
  familiarityDayWeight: 3,
  seedMinMessages: 2,
  // 档位阈值：熟悉度到多少算「认识 / 普通朋友 / 熟 / 自己人」；滞回点防止在边界来回跳
  stageKnown: 20,
  stageFriend: 40,
  stageClose: 70,
  stageInner: 80,
  stageCloseAffinity: 10,
  stageInnerAffinity: 30,
  stageHysteresis: 5,
  // 好感：只由事件改，带单次 / 单日上限；曲线负责非对称增益与自然回落
  affinityEventMax: 3,
  affinityDailyCap: 6,
  affinitySevereMax: 10,
  // 三条曲线：唯一参数块，函数只读这里
  curves: {
    familiarity: {
      gainScale: 40,
      dailyGainCap: 4,
      graceDays: 21,
      decayHalfLifeDays: 120,
      floor: 20
    },
    affinity: {
      positiveDiminish: 0.5,
      negativeAmplify: 0.5,
      graceDays: 14,
      positiveHalfLifeDays: 180,
      negativeHalfLifeDays: 240,
      repairPenaltyHours: 72,
      repairEfficiency: 0.5
    },
    mood: {
      halfLifeMin: 90,
      visible: 15,
      switchMargin: 0.6,
      positiveMax: 60,
      negativeMax: 70,
      eventMax: 8,
      dailyCap: 20
    }
  },
  moodEffects: DEFAULT_MOOD_EFFECTS,
  // 群接话：只做小幅加权，界面能看到每个档位的系数
  groupBiasEnabled: true,
  groupBiasMin: 0.5,
  groupBiasMax: 1.5,
  groupBias: {
    hate: 0.5,
    cold: 0.8,
    stranger: 0.6,
    known: 1,
    friend: 1.1,
    close: 1.3,
    inner: 1.5
  }
}

// 2026-11-24：以下字段是关系与情绪的固定标准，只由代码定义。
// 面板不提供输入框；normalizeConfig 每次读盘都会把文件里的旧值重置回 DEFAULT_CONFIG，
// 避免出现「面板一套、CLI 一套、文件第三套」的口径。
const STANDARD_LOCKED_KEYS = [
  'privateAffinity', 'groupAffinity', 'privateFamiliarity', 'groupFamiliarity',
  'ownerFamiliarity', 'ownerAffinity',
  'familiarityMsgWeight', 'familiarityDayWeight', 'seedMinMessages',
  'stageKnown', 'stageFriend', 'stageClose', 'stageInner',
  'stageCloseAffinity', 'stageInnerAffinity', 'stageHysteresis',
  'affinityEventMax', 'affinityDailyCap', 'affinitySevereMax',
  'groupBiasEnabled', 'groupBiasMin', 'groupBiasMax'
]

function applyStandard(c) {
  for (const key of STANDARD_LOCKED_KEYS) {
    const v = DEFAULT_CONFIG[key]
    c[key] = isObj(v) || Array.isArray(v) ? clone(v) : v
  }
  c.curves = normalizeCurves(DEFAULT_CONFIG.curves)
  c.moodEffects = normalizeMoodEffects(DEFAULT_CONFIG.moodEffects)
  c.groupBias = clone(DEFAULT_CONFIG.groupBias)
  c.version = 3
  return c
}

const STAGES = [
  { key: 'hate', label: '反感', min: -999, max: -30, fam: false },
  { key: 'cold', label: '有芥蒂', min: -29, max: -1, fam: false },
  { key: 'stranger', label: '生人', min: 0, max: 19, fam: true },
  { key: 'known', label: '认识', min: 20, max: 39, fam: true },
  { key: 'friend', label: '普通朋友', min: 40, max: 59, fam: true },
  { key: 'close', label: '熟', min: 60, max: 79, fam: true },
  { key: 'inner', label: '自己人', min: 80, max: 100, fam: true }
]

const FAM_BANDS = [
  { key: 'stranger', label: '生人', min: 0, max: 19 },
  { key: 'known', label: '认识', min: 20, max: 39 },
  { key: 'friend', label: '普通朋友', min: 40, max: 59 },
  { key: 'close', label: '熟', min: 60, max: 79 },
  { key: 'inner', label: '自己人', min: 80, max: 100 }
]

const STAGE_GUIDE = {
  hate: '只回必要信息，1 句；不主动、不接玩笑；不讽刺、不阴阳、不翻旧账。',
  cold: '礼貌但短，1 句；不主动找话，不接玩笑；不假装亲热。',
  stranger: '1 句，客气；不追问私事、不用昵称；他问正事就答。',
  known: '1–2 句；被问才多接一句；可轻度接梗。',
  friend: '1–2 句；可以接梗；偶尔主动一句。',
  close: '1–2 句；可以损一句，不用客气；别拿雷点开玩笑。',
  inner: '1–2 句；可以主动关心、记得细节；不替对方做主。'
}

// 情绪事件标准分：模型只报标签，分数按这张表折算。
// 2026-11-24 起不再让模型 / 面板自由填数字；单次仍受 curves.mood.eventMax 约束。
const MOOD_STANDARD_DELTA = {
  平静: 0,
  开心: 4,
  兴奋: 8,
  得意: 3,
  低落: -4,
  委屈: -6,
  烦躁: -6,
  疲惫: -4,
  心虚: -3
}

// 情绪白名单：label / 正负倾向 / 精神头；不允许模型自由造词。
const MOOD_LABELS = {
  平静: { valence: 0, energy: 0.35 },
  开心: { valence: 0.6, energy: 0.55 },
  兴奋: { valence: 0.8, energy: 0.75 },
  得意: { valence: 0.5, energy: 0.6 },
  低落: { valence: -0.5, energy: 0.25 },
  委屈: { valence: -0.6, energy: 0.2 },
  烦躁: { valence: -0.5, energy: 0.6 },
  疲惫: { valence: -0.2, energy: 0.15 },
  心虚: { valence: -0.2, energy: 0.4 }
}

// 每个标签一张表达表；文件里缺字段就按默认补齐，标准值不接受面板写入。
function normalizeMoodEffects(raw) {
  const out = {}
  for (const label of Object.keys(MOOD_LABELS)) {
    const def = DEFAULT_MOOD_EFFECTS[label] || DEFAULT_MOOD_EFFECTS['平静']
    const src = isObj(raw) && isObj(raw[label]) ? raw[label] : {}
    out[label] = {
      maxChars: clampInt(src.maxChars, 0, 300, def.maxChars),
      maxSentences: clampInt(src.maxSentences, 0, 10, def.maxSentences),
      emojiFactor: clamp(src.emojiFactor === undefined ? def.emojiFactor : src.emojiFactor, 0, 2),
      stickerFactor: clamp(src.stickerFactor === undefined ? def.stickerFactor : src.stickerFactor, 0, 2),
      voiceFactor: clamp(src.voiceFactor === undefined ? def.voiceFactor : src.voiceFactor, 0, 2),
      groupFactor: clamp(src.groupFactor === undefined ? def.groupFactor : src.groupFactor, 0, 2)
    }
  }
  return out
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, Math.round(v * 1000) / 1000))
}

function clampInt(n, lo, hi, dflt) {
  const v = Number(n)
  if (!Number.isFinite(v)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
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

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  try { fs.renameSync(tmp, file) } catch {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    try { fs.unlinkSync(tmp) } catch { /* 临时文件清不掉不影响主流程 */ }
  }
}

function normalizeChannel(v) {
  const s = String(v || '').toLowerCase()
  if (s === 'lark') return 'feishu'
  if (s === 'wx' || s === 'weixin') return 'wechat'
  return s
}

function channelLabel(channel) {
  return ({ wechat: '微信', qq: 'QQ', feishu: '飞书' })[normalizeChannel(channel)] || String(channel || '其他')
}

function chatKeyOf(info) {
  const a = info || {}
  if (a.chatKey) return String(a.chatKey)
  const channel = normalizeChannel(a.channel)
  const type = String(a.chatType || '').toLowerCase() === 'group' ? 'group' : 'private'
  const id = String(a.chatId || '')
  return channel && id ? channel + ':' + type + ':' + id : ''
}

function parseChatKey(key) {
  const m = /^([^:]+):(private|group):(.*)$/.exec(String(key || ''))
  if (!m) return null
  return { channel: normalizeChannel(m[1]), chatType: m[2], chatId: m[3], chatKey: String(key) }
}

function cleanName(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

function cleanText(v, max) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max || 200)
}

function normName(v) {
  return cleanName(v).toLowerCase()
}

function personSenderKey(senderId, name) {
  const id = String(senderId || '').trim()
  if (id) return 'id:' + id.slice(0, 80)
  const n = normName(name)
  return n ? 'name:' + n : ''
}

function personKeyOf(chatKey, senderId, name) {
  const sk = personSenderKey(senderId, name)
  return sk ? String(chatKey) + '#' + sk : ''
}

function chatPartOfPersonKey(key) {
  const s = String(key || '')
  const i = s.lastIndexOf('#')
  return i > 0 ? s.slice(0, i) : s
}

function localDay(ts) {
  const n = Number(ts) || 0
  if (!n) return ''
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function nowIso() {
  return new Date().toISOString()
}

// ---------- 配置 / 数据规范化 ----------

function normalizeCurves(raw) {
  const src = isObj(raw) ? raw : {}
  const fam = isObj(src.familiarity) ? src.familiarity : {}
  const aff = isObj(src.affinity) ? src.affinity : {}
  const mood = isObj(src.mood) ? src.mood : {}
  return {
    familiarity: {
      gainScale: clamp(fam.gainScale === undefined ? 40 : fam.gainScale, 1, 500),
      dailyGainCap: clamp(fam.dailyGainCap === undefined ? 4 : fam.dailyGainCap, 0, 50),
      graceDays: clampInt(fam.graceDays === undefined ? 21 : fam.graceDays, 0, 3650, 21),
      decayHalfLifeDays: clampInt(fam.decayHalfLifeDays === undefined ? 120 : fam.decayHalfLifeDays, 1, 3650, 120),
      floor: clamp(fam.floor === undefined ? 20 : fam.floor, 0, 100)
    },
    affinity: {
      positiveDiminish: clamp(aff.positiveDiminish === undefined ? 0.5 : aff.positiveDiminish, 0, 1),
      negativeAmplify: clamp(aff.negativeAmplify === undefined ? 0.5 : aff.negativeAmplify, 0, 2),
      graceDays: clampInt(aff.graceDays === undefined ? 14 : aff.graceDays, 0, 3650, 14),
      positiveHalfLifeDays: clampInt(aff.positiveHalfLifeDays === undefined ? 180 : aff.positiveHalfLifeDays, 1, 3650, 180),
      negativeHalfLifeDays: clampInt(aff.negativeHalfLifeDays === undefined ? 240 : aff.negativeHalfLifeDays, 1, 3650, 240),
      repairPenaltyHours: clampInt(aff.repairPenaltyHours === undefined ? 72 : aff.repairPenaltyHours, 0, 720, 72),
      repairEfficiency: clamp(aff.repairEfficiency === undefined ? 0.5 : aff.repairEfficiency, 0, 1)
    },
    mood: {
      halfLifeMin: clamp(mood.halfLifeMin === undefined ? 90 : mood.halfLifeMin, 5, 1440),
      visible: clamp(mood.visible === undefined ? 15 : mood.visible, 0, 100),
      switchMargin: clamp(mood.switchMargin === undefined ? 0.6 : mood.switchMargin, 0, 1),
      positiveMax: clamp(mood.positiveMax === undefined ? 60 : mood.positiveMax, 0, 100),
      negativeMax: clamp(mood.negativeMax === undefined ? 70 : mood.negativeMax, 0, 100),
      eventMax: clamp(mood.eventMax === undefined ? 8 : mood.eventMax, 0, 30),
      dailyCap: clamp(mood.dailyCap === undefined ? 20 : mood.dailyCap, 0, 200)
    }
  }
}

function normalizeConfig(raw) {
  const c = deepMerge(DEFAULT_CONFIG, raw || {})
  c.version = 3
  c.enabled = c.enabled !== false
  c.inject = c.inject !== false
  c.modelNotesEnabled = c.modelNotesEnabled !== false
  c.groupRosterLimit = clampInt(c.groupRosterLimit, 1, 30, 10)
  c.cardMaxChars = clampInt(c.cardMaxChars, 120, 1200, 600)
  c.privateAffinity = clamp(c.privateAffinity, -100, 100)
  c.groupAffinity = clamp(c.groupAffinity, -100, 100)
  c.privateFamiliarity = clamp(c.privateFamiliarity, 0, 100)
  c.groupFamiliarity = clamp(c.groupFamiliarity, 0, 100)
  c.ownerAliases = Array.isArray(c.ownerAliases)
    ? c.ownerAliases.map(cleanName).filter(Boolean).slice(0, 12)
    : String(c.ownerAliases || '').split(/[|,，]/).map(cleanName).filter(Boolean).slice(0, 12)
  c.ownerSenderIds = Array.isArray(c.ownerSenderIds)
    ? c.ownerSenderIds.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
    : String(c.ownerSenderIds || '').split(/[|,，]/).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
  c.ownerPreferredName = cleanName(c.ownerPreferredName || '胡闹') || '胡闹'
  c.ownerRole = cleanText(c.ownerRole || '主人', 12) || '主人'
  c.ownerFamiliarity = clamp(c.ownerFamiliarity, 0, 100)
  c.ownerAffinity = clamp(c.ownerAffinity, -100, 100)
  c.familiarityMsgWeight = clamp(c.familiarityMsgWeight, 0, 10)
  c.familiarityDayWeight = clamp(c.familiarityDayWeight, 0, 30)
  c.seedMinMessages = clampInt(c.seedMinMessages, 1, 200, 2)
  c.stageKnown = clampInt(c.stageKnown, 1, 99, 20)
  c.stageFriend = clampInt(c.stageFriend, c.stageKnown + 1, 99, Math.max(40, c.stageKnown + 1))
  c.stageClose = clampInt(c.stageClose, c.stageFriend + 1, 100, Math.max(60, c.stageFriend + 1))
  c.stageInner = clampInt(c.stageInner, c.stageClose + 1, 100, Math.max(80, c.stageClose + 1))
  c.stageCloseAffinity = clampInt(c.stageCloseAffinity, 0, 100, 10)
  c.stageInnerAffinity = clampInt(c.stageInnerAffinity, c.stageCloseAffinity, 100, Math.max(30, c.stageCloseAffinity))
  c.stageHysteresis = clampInt(c.stageHysteresis, 0, 20, 5)
  c.curves = normalizeCurves(c.curves)
  c.curves.familiarity.floor = Math.min(c.curves.familiarity.floor, c.stageKnown)
  c.affinityEventMax = clamp(c.affinityEventMax, 0, 20)
  c.affinityDailyCap = clamp(c.affinityDailyCap, 0, 100)
  c.affinitySevereMax = clamp(c.affinitySevereMax, 0, 100)
  c.moodEffects = normalizeMoodEffects(c.moodEffects)
  c.groupBiasEnabled = c.groupBiasEnabled !== false
  c.groupBiasMin = clamp(c.groupBiasMin, 0, 5)
  c.groupBiasMax = clamp(c.groupBiasMax, 0, 5)
  c.groupBias = isObj(c.groupBias) ? c.groupBias : {}
  for (const s of STAGES) {
    c.groupBias[s.key] = clamp(c.groupBias[s.key] === undefined ? 1 : c.groupBias[s.key], c.groupBiasMin, c.groupBiasMax)
  }
  // 旧字段只做一次性迁移入口，不再参与计算；写回时清掉，避免两个真源。
  delete c.familiarityDecayDays
  delete c.familiarityDecayStep
  delete c.familiarityFloor
  delete c.affinityDecayDays
  delete c.affinityDecayStep
  delete c.moodHalfLife
  delete c.moodVisibleThreshold
  delete c.moodPositiveMax
  delete c.moodNegativeMax
  delete c.moodEventMax
  delete c.moodDailyCap
  // 标准是唯一口径：面板 / CLI 写进来的分数、曲线、联动表都在这里被重置。
  applyStandard(c)
  c.curves.familiarity.floor = Math.min(c.curves.familiarity.floor, c.stageKnown)
  return c
}

function normalizeEvents(list) {
  if (!Array.isArray(list)) return []
  return list.filter(isObj).map((e) => ({
    at: Number(e.at) || 0,
    kind: cleanText(e.kind, 20),
    delta: Number(e.delta) || 0,
    reason: cleanText(e.reason, 160),
    evidence: cleanText(e.evidence, 200),
    source: String(e.source || 'auto').slice(0, 12),
    applied: e.applied !== false
  })).slice(-30)
}

function normalizeNotes(list) {
  if (!Array.isArray(list)) return []
  return list.filter(isObj).map((n) => ({
    at: Number(n.at) || 0,
    kind: cleanText(n.kind || '备注', 12),
    text: cleanText(n.text, 200),
    source: String(n.source || 'manual').slice(0, 12)
  })).filter((n) => n.text).slice(-20)
}

// 主人识别：别名或 senderId 命中都算；只用于初始值 / 称呼 / 提示词，不改变安全规则。
function isOwnerProfile(name, senderId, config) {
  const c = config || {}
  const n = cleanName(name).toLowerCase()
  const aliases = (Array.isArray(c.ownerAliases) ? c.ownerAliases : []).map(cleanName).filter(Boolean).map((x) => x.toLowerCase())
  const ids = (Array.isArray(c.ownerSenderIds) ? c.ownerSenderIds : []).map((x) => String(x || '').trim()).filter(Boolean)
  if (n && aliases.indexOf(n) >= 0) return true
  if (senderId && ids.indexOf(String(senderId)) >= 0) return true
  return false
}

function displayNameOf(p) {
  const x = p || {}
  return cleanName(x.preferredName || x.name || x.senderId || '无名') || '无名'
}

function normalizeStats(raw) {
  const s = isObj(raw) ? raw : {}
  return {
    messages: Math.max(0, Math.round(Number(s.messages) || 0)),
    days: Math.max(0, Math.round(Number(s.days) || 0)),
    mentions: Math.max(0, Math.round(Number(s.mentions) || 0)),
    replies: Math.max(0, Math.round(Number(s.replies) || 0)),
    firstAt: Number(s.firstAt) || 0,
    lastAt: Number(s.lastAt) || 0
  }
}

function normalizePerson(key, raw, config) {
  const p = isObj(raw) ? raw : {}
  const chatKey = String(p.chatKey || chatPartOfPersonKey(key))
  const parsed = parseChatKey(chatKey) || { channel: '', chatType: 'private', chatId: '' }
  const manual = isObj(p.manual) ? p.manual : {}
  const baseFam = numOrNull(p.familiarityBase)
  const baseAff = numOrNull(p.affinityBase)
  const group = parsed.chatType === 'group'
  const owner = isOwnerProfile(p.name || p.senderName || '', p.senderId || '', config)
  const stats = normalizeStats(p.stats)
  const famAt = Number(p.familiarityAt) || stats.lastAt || Number(p.updatedAt) || 0
  const affAt = Number(p.affinityAt) || stats.lastAt || Number(p.updatedAt) || 0
  return {
    chatKey,
    channel: normalizeChannel(p.channel || parsed.channel),
    chatType: parsed.chatType === 'group' ? 'group' : 'private',
    chatId: String(p.chatId || parsed.chatId),
    senderId: String(p.senderId || ''),
    name: cleanName(p.name || p.senderName || ''),
    preferredName: cleanName(p.preferredName || (owner ? config.ownerPreferredName : '')),
    role: cleanText(p.role || (owner ? config.ownerRole : ''), 12),
    aliases: Array.isArray(p.aliases) ? p.aliases.map(cleanName).filter(Boolean).slice(0, 8) : [],
    familiarityBase: clamp(baseFam === null ? (numOrNull(p.familiarity) === null ? (group ? config.groupFamiliarity : config.privateFamiliarity) : p.familiarity) : baseFam, 0, 100),
    affinityBase: clamp(baseAff === null ? (numOrNull(p.affinity) === null ? (group ? config.groupAffinity : config.privateAffinity) : p.affinity) : baseAff, -100, 100),
    manual: {
      familiarity: numOrNull(manual.familiarity),
      affinity: numOrNull(manual.affinity)
    },
    tags: Array.isArray(p.tags) ? p.tags.map((t) => cleanText(t, 16)).filter(Boolean).slice(0, 8) : [],
    notes: normalizeNotes(p.notes),
    stats,
    events: normalizeEvents(p.events),
    lastStage: String(p.lastStage || ''),
    lockUntil: Number(p.lockUntil) || 0,
    repairUntil: Number(p.repairUntil) || 0,
    familiarityAt: famAt,
    affinityAt: affAt,
    familiarityGainDay: String(p.familiarityGainDay || ''),
    familiarityGainToday: clamp(p.familiarityGainToday || 0, 0, 100),
    familiaritySeeded: p.familiaritySeeded === true,
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Date.now()
  }
}

function normalizeRelations(raw) {
  const src = isObj(raw) ? raw : {}
  const config = normalizeConfig(src.config)
  const out = { version: 3, updatedAt: Number(src.updatedAt) || 0, config, people: {}, chats: {} }
  for (const [key, item] of Object.entries(isObj(src.people) ? src.people : {})) {
    if (!key || !isObj(item)) continue
    out.people[String(key)] = normalizePerson(key, item, config)
  }
  // chats 是 people 的派生索引，读的时候也重建，避免手改 / 旧文件只剩 people 时面板显示 0 个聊天。
  out.chats = buildChatsMap(out.people)
  return out
}

// chats 索引：只存指针 + 快照，渲染和插件都不用全表扫；people 是唯一真源。
function buildChatsMap(people) {
  const out = {}
  for (const [key, p] of Object.entries(people || {})) {
    const chatKey = p.chatKey || chatPartOfPersonKey(key)
    if (!chatKey) continue
    if (!out[chatKey]) out[chatKey] = { members: [], rosterUpdatedAt: Date.now() }
    out[chatKey].members.push({
      key,
      name: p.name || p.senderId || '',
      familiarity: p.familiarityBase,
      affinity: p.affinityBase,
      lastAt: p.stats.lastAt
    })
  }
  for (const chat of Object.values(out)) {
    chat.members.sort((a, b) => (Number(b.familiarity) - Number(a.familiarity)) || (Number(b.affinity) - Number(a.affinity)))
  }
  return out
}

function normalizeMood(raw) {
  const src = isObj(raw) ? raw : {}
  const m = isObj(src.mood) ? src.mood : {}
  const label = MOOD_LABELS[String(m.label || '')] ? String(m.label) : '平静'
  const conf = MOOD_LABELS[label]
  return {
    version: 3,
    updatedAt: Number(src.updatedAt) || 0,
    mood: {
      label,
      baseIntensity: clamp(m.baseIntensity === undefined ? (m.intensity || 0) : m.baseIntensity, 0, 100),
      valence: Number.isFinite(Number(m.valence)) ? clamp(m.valence, -1, 1) : conf.valence,
      energy: Number.isFinite(Number(m.energy)) ? clamp(m.energy, 0, 1) : conf.energy,
      cause: cleanText(m.cause, 160),
      source: String(m.source || '').slice(0, 12),
      since: Number(m.since) || 0,
      until: Number(m.until) || 0,
      halfLife: clamp(m.halfLife || 90, 5, 1440)
    },
    events: normalizeEvents(src.events),
    perChat: isObj(src.perChat) ? src.perChat : {}
  }
}

// ---------- 关系 / 情绪的有效值 ----------

function curveOf(config, name) {
  const c = (config && config.curves) || {}
  const fallback = (DEFAULT_CONFIG.curves && DEFAULT_CONFIG.curves[name]) || {}
  return Object.assign({}, fallback, isObj(c[name]) ? c[name] : {})
}

// 熟悉度曲线：先饱和上升，再 21 天宽限后指数回落，floor 只防掉成生人。
function effectiveFamiliarity(p, config, now) {
  const manual = p && p.manual ? p.manual.familiarity : null
  if (manual !== null && manual !== undefined) return clamp(manual, 0, 100)
  const base = clamp(p && p.familiarityBase, 0, 100)
  const curve = curveOf(config, 'familiarity')
  const floor = clamp(curve.floor, 0, 100)
  const last = Number((p && p.familiarityAt) || (p && p.stats && p.stats.lastAt) || 0)
  if (!last || base <= floor) return base
  const days = Math.max(0, (Number(now || Date.now()) - last) / 86400000)
  if (days <= curve.graceDays) return base
  const remain = base - floor
  const decayed = floor + remain * Math.pow(2, -(days - curve.graceDays) / Math.max(1, curve.decayHalfLifeDays))
  return clamp(decayed, floor, 100)
}

// 好感曲线：自然回落只向 0 走，正负半衰期分开；不穿 0。
function effectiveAffinity(p, config, now) {
  const manual = p && p.manual ? p.manual.affinity : null
  if (manual !== null && manual !== undefined) return clamp(manual, -100, 100)
  const base = clamp(p && p.affinityBase, -100, 100)
  const curve = curveOf(config, 'affinity')
  const last = Number((p && p.affinityAt) || (p && p.stats && p.stats.lastAt) || 0)
  if (!last || base === 0) return base
  const days = Math.max(0, (Number(now || Date.now()) - last) / 86400000)
  if (days <= curve.graceDays) return base
  const halfLife = base > 0 ? curve.positiveHalfLifeDays : curve.negativeHalfLifeDays
  const decayed = base * Math.pow(2, -(days - curve.graceDays) / Math.max(1, halfLife))
  return clamp(decayed, -100, 100)
}

// 熟悉度单次增量：d = 消息权重×新增消息 + 互动日权重×新增互动日；100 是天花板，越近越难涨。
function familiarityGain(current, dose, config, room) {
  const curve = curveOf(config, 'familiarity')
  const d = Math.max(0, Number(dose) || 0)
  if (d <= 0) return 0
  const cap = clamp(curve.dailyGainCap, 0, 50)
  const roomToday = Math.max(0, Math.min(100, Number(room === undefined ? cap : room)))
  if (roomToday <= 0) return 0
  const base = clamp(current, 0, 100)
  const raw = (100 - base) * (1 - Math.exp(-d / Math.max(1, curve.gainScale)))
  return clamp(Math.min(raw, roomToday, cap), 0, 100)
}

// 好感非对称增益：越高越难涨、越高越容易跌；严重负向固定从重。
function affinityStep(current, delta, config, kind) {
  const curve = curveOf(config, 'affinity')
  const d = Number(delta) || 0
  if (!d) return 0
  const cur = clamp(current, -100, 100)
  if (kind === 'severe') return d
  if (d > 0) return d * (1 - curve.positiveDiminish * Math.max(cur, 0) / 100)
  return d * (1 + curve.negativeAmplify * Math.max(cur, 0) / 100)
}

function famThreshold(i, config) {
  return [0, config.stageKnown, config.stageFriend, config.stageClose, config.stageInner][i] || 0
}

function famBandIndex(fam, config) {
  for (let i = FAM_BANDS.length - 1; i >= 0; i--) {
    if (fam >= famThreshold(i, config)) return i
  }
  return 0
}

function stageOf(p, config, now) {
  config = normalizeConfig(config || {})
  const familiarity = effectiveFamiliarity(p, config, now)
  const affinity = effectiveAffinity(p, config, now)
  let key = ''
  let gated = false
  if (affinity <= -30) key = 'hate'
  else if (affinity < 0) key = 'cold'
  else {
    let idx = famBandIndex(familiarity, config)
    if (idx >= 4 && affinity < config.stageInnerAffinity) { idx = 3; gated = true }
    else if (idx >= 3 && affinity < config.stageCloseAffinity) { idx = 2; gated = true }
    const prevIdx = FAM_BANDS.findIndex((b) => b.key === p.lastStage)
    // 手动锁定的值直接按当前数值定档，不被滞回卡在旧档；滞回只用于自动涨落。
    const manualLocked = !!(p.manual && (p.manual.familiarity !== null || p.manual.affinity !== null))
    if (!gated && !manualLocked && prevIdx >= 0) {
      const hyst = Number(config.stageHysteresis) || 0
      if (idx > prevIdx && familiarity < famThreshold(idx, config) + hyst) idx = prevIdx
      else if (idx < prevIdx && familiarity > famThreshold(prevIdx, config) - hyst) idx = prevIdx
    }
    key = FAM_BANDS[idx].key
  }
  const meta = STAGES.find((s) => s.key === key) || STAGES[2]
  return {
    key: meta.key,
    label: meta.label,
    familiarity: Math.round(familiarity * 10) / 10,
    affinity: Math.round(affinity * 10) / 10,
    rawFamiliarity: p.familiarityBase,
    rawAffinity: p.affinityBase,
    manual: p.manual,
    decayed: {
      familiarity: Math.max(0, Math.round((p.familiarityBase - familiarity) * 10) / 10),
      affinity: Math.abs(Math.round((p.affinityBase - affinity) * 10) / 10)
    }
  }
}

function moodUntil(mood, config, now) {
  const curve = curveOf(config, 'mood')
  const base = clamp(mood.baseIntensity, 0, 100)
  const threshold = Math.max(1, Number(curve.visible) || 15)
  if (base <= threshold) return 0
  const half = clamp(mood.halfLife || curve.halfLifeMin, 5, 1440)
  const minutes = half * Math.log2(base / threshold)
  return Number(now || Date.now()) + minutes * 60000
}

function effectiveMood(mood, config, now) {
  const curve = curveOf(config, 'mood')
  const m = mood && mood.mood ? mood.mood : {}
  const half = clamp(m.halfLife || curve.halfLifeMin, 5, 1440)
  const since = Number(m.since) || 0
  const elapsed = since ? Math.max(0, (Number(now || Date.now()) - since) / 60000) : 0
  const base = clamp(m.baseIntensity, 0, 100)
  const intensity = base > 0 ? base * Math.pow(0.5, elapsed / half) : 0
  const visible = intensity >= Number(curve.visible || 15)
  const label = visible && MOOD_LABELS[m.label] ? m.label : '平静'
  const meta = MOOD_LABELS[label] || MOOD_LABELS['平静']
  const until = moodUntil({ baseIntensity: intensity, halfLife: half, label }, config, now)
  return {
    label,
    intensity: Math.round(intensity * 10) / 10,
    baseIntensity: base,
    valence: visible ? Number(m.valence !== undefined ? m.valence : meta.valence) : 0,
    energy: visible ? Number(m.energy !== undefined ? m.energy : meta.energy) : meta.energy,
    cause: cleanText(m.cause, 160),
    source: m.source || '',
    since,
    until,
    halfLife: half,
    remainingMin: until ? Math.max(0, Math.round((until - Number(now || Date.now())) / 60000)) : 0,
    visible
  }
}

// 未来曲线：只按锚点 + 目标时间算，不跑后台 tick；面板和 CLI 都用同一套。
function forecastCurves(p, config, now, days) {
  const pts = Array.isArray(days) && days.length ? days : [0, 1, 7, 30, 90]
  const at = Number(now || Date.now())
  return pts.map((d) => {
    const t = at + Number(d) * 86400000
    const stage = stageOf(p, config, t)
    return {
      days: Number(d),
      at: t,
      familiarity: stage.familiarity,
      affinity: stage.affinity,
      stage: stage.key,
      stageLabel: stage.label
    }
  })
}

function forecastMood(moodData, config, now, days) {
  const pts = Array.isArray(days) && days.length ? days : [0, 1, 7, 30, 90]
  const at = Number(now || Date.now())
  return pts.map((d) => {
    const t = at + Number(d) * 86400000
    const eff = effectiveMood(moodData, config, t)
    return { days: Number(d), at: t, label: eff.label, intensity: eff.intensity, visible: eff.visible }
  })
}

// 把当前情绪折算成各通道能直接执行的表达参数。
// limits.maxChars / maxSentences 是通道自己的硬上限；情绪表只在这个上限内再收，不会放宽。
function moodPlan(moodEff, config, limits) {
  const cfg = isObj(config) ? config : {}
  const l = isObj(limits) ? limits : {}
  const source = isObj(moodEff) ? moodEff : {}
  const label = source.visible && MOOD_LABELS[source.label] ? source.label : '平静'
  const table = isObj(cfg.moodEffects) ? cfg.moodEffects : DEFAULT_MOOD_EFFECTS
  const effect = isObj(table[label]) ? table[label] : (DEFAULT_MOOD_EFFECTS[label] || DEFAULT_MOOD_EFFECTS['平静'])
  const channelMax = clampInt(l.maxChars, 0, 300, 0)
  const channelSentences = clampInt(l.maxSentences, 0, 10, 0)
  const moodMax = clampInt(effect.maxChars, 0, 300, 0)
  const moodSentences = clampInt(effect.maxSentences, 0, 10, 0)
  const maxChars = channelMax > 0 && moodMax > 0 ? Math.min(channelMax, moodMax) : (channelMax || moodMax)
  const maxSentences = channelSentences > 0 && moodSentences > 0 ? Math.min(channelSentences, moodSentences) : (channelSentences || moodSentences)
  const emojiFactor = clamp(effect.emojiFactor, 0, 2)
  const stickerFactor = clamp(effect.stickerFactor, 0, 2)
  const voiceFactor = clamp(effect.voiceFactor, 0, 2)
  const groupFactor = clamp(effect.groupFactor, 0, 2)
  return {
    label,
    visible: !!source.visible,
    intensity: Number(source.intensity) || 0,
    maxChars,
    maxSentences,
    emojiFactor,
    stickerFactor,
    stickerAllowed: stickerFactor > 0,
    voiceFactor,
    voiceAllowed: voiceFactor > 0,
    groupFactor,
    cause: source.cause || ''
  }
}

function stageGuide(stageKey, moodEff, plan) {
  let g = STAGE_GUIDE[stageKey] || STAGE_GUIDE.stranger
  // 情绪只补「本轮表达上限」，不再硬编码「负面就 1 句 / 开心就 2 句」；
  // 具体字/句/贴纸/语音全由 config.moodEffects 的当前行决定。
  if (moodEff && moodEff.visible && plan) {
    if (plan.maxSentences) g = g.replace(/^\d+[–-]\d+\s*句[；;]?\s*/, '最多 ' + plan.maxSentences + ' 句；')
    const bits = []
    if (plan.maxChars) bits.push('最多 ' + plan.maxChars + ' 字')
    if (plan.maxSentences) bits.push('最多 ' + plan.maxSentences + ' 句')
    if (plan.stickerAllowed === false) bits.push('不发贴纸')
    if (plan.voiceAllowed === false) bits.push('不发语音')
    if (bits.length) g += ' 本轮表达：' + bits.join('、') + '。'
    if (Number(plan.groupFactor) < 1) g += ' 群聊接话更克制。'
  }
  return g
}

// ---------- store ----------

function createStore(opts) {
  const o = opts || {}
  const dataDir = path.resolve(o.dataDir || DATA_DIR)
  const dshHome = path.resolve(o.dshHome || defaultDshHome())
  const relFile = path.join(dataDir, '社交关系.json')
  const moodFile = path.join(dataDir, '社交情绪.json')
  const sessionsFile = path.join(dataDir, '社交会话.json')
  const mirrorDir = path.join(dshHome, '场景记忆', '_共享记忆')
  const logFile = path.join(dshHome, 'logs', 'social-state.jsonl')
  const archiveLib = o.archiveLib || null
  const nowFn = typeof o.now === 'function' ? o.now : function () { return Date.now() }
  let relCache = { at: 0, mtime: -1, data: null }
  let moodCache = { at: 0, mtime: -1, data: null }
  let sessionCache = { at: 0, mtime: -1, map: null }

  function mtimeOf(file) {
    try { return fs.statSync(file).mtimeMs } catch { return -1 }
  }

  function readRelations() {
    const mt = mtimeOf(relFile)
    if (relCache.data && relCache.mtime === mt && nowFn() - relCache.at < 3000) return relCache.data
    const raw = readJson(relFile, null)
    const data = normalizeRelations(raw || {})
    relCache = { at: nowFn(), mtime: mt, data }
    return data
  }

  function writeRelations(data) {
    const out = normalizeRelations(data)
    out.updatedAt = nowFn()
    rebuildChats(out)
    atomicWrite(relFile, out)
    if (mirrorDir) {
      try { atomicWrite(path.join(mirrorDir, '社交关系.json'), out) } catch { /* 镜像失败不阻断真源 */ }
    }
    relCache = { at: nowFn(), mtime: mtimeOf(relFile), data: out }
    return out
  }

  function readMood() {
    const mt = mtimeOf(moodFile)
    if (moodCache.data && moodCache.mtime === mt && nowFn() - moodCache.at < 3000) return moodCache.data
    const raw = readJson(moodFile, null)
    const data = normalizeMood(raw || {})
    moodCache = { at: nowFn(), mtime: mt, data }
    return data
  }

  function writeMood(data) {
    const out = normalizeMood(data)
    out.updatedAt = nowFn()
    atomicWrite(moodFile, out)
    if (mirrorDir) {
      try { atomicWrite(path.join(mirrorDir, '社交情绪.json'), out) } catch { /* 镜像失败不阻断真源 */ }
    }
    moodCache = { at: nowFn(), mtime: mtimeOf(moodFile), data: out }
    return out
  }

  function log(kind, obj) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      const rec = Object.assign({ at: nowIso(), kind: String(kind || '') }, obj || {})
      fs.appendFileSync(logFile, JSON.stringify(rec) + '\n', 'utf8')
    } catch { /* 记录写不进不影响主流程 */ }
  }

  function readLog(limit) {
    const max = Math.max(1, Math.min(500, Number(limit) || 50))
    try {
      const txt = fs.readFileSync(logFile, 'utf8').trim()
      if (!txt) return []
      return txt.split(/\r?\n/).slice(-max).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
    } catch { return [] }
  }

  function readSessionsMap() {
    const mt = mtimeOf(sessionsFile)
    if (sessionCache.map && sessionCache.mtime === mt && nowFn() - sessionCache.at < 5000) return sessionCache.map
    const raw = readJson(sessionsFile, null)
    const map = {}
    const src = isObj(raw) && isObj(raw.sessions) ? raw.sessions : (isObj(raw) ? raw : {})
    for (const item of Object.values(src)) {
      if (!isObj(item)) continue
      const key = chatKeyOf({ channel: item.channel, chatType: item.chatType, chatId: item.chatId })
      if (!key) continue
      const title = cleanName(item.chatTitle || item.title || item.chatId || '')
      if (!title) continue
      map[key] = { title, channel: normalizeChannel(item.channel), chatType: item.chatType, chatId: item.chatId }
    }
    sessionCache = { at: nowFn(), mtime: mt, map }
    return map
  }

  function chatLabelOf(chatKey, rel) {
    const parsed = parseChatKey(chatKey)
    if (!parsed) return String(chatKey || '')
    const hit = readSessionsMap()[String(chatKey)]
    let title = hit && hit.title ? hit.title : parsed.chatId
    // 1. 私聊标题若是主人档案的原显示名，显示层统一改成「胡闹」；群名不动，避免把群名当昵称。
    if (parsed.chatType !== 'group' && rel) {
      const owner = Object.values(rel.people || {}).find((p) =>
        p.chatKey === String(chatKey) && isOwnerProfile(p.name, p.senderId, rel.config))
      if (owner) title = displayNameOf(owner)
    }
    if (parsed.chatType === 'group') return channelLabel(parsed.channel) + '群「' + title + '」'
    return channelLabel(parsed.channel) + ' · ' + title
  }

  function rebuildChats(data) {
    data.chats = buildChatsMap(data.people || {})
    return data
  }

  function ensurePerson(data, info) {
    const chatKey = chatKeyOf(info)
    if (!chatKey) return null
    const parsed = parseChatKey(chatKey) || { channel: '', chatType: 'private', chatId: '' }
    const senderId = String((info && info.senderId) || '')
    const name = cleanName((info && info.name) || (info && info.senderName) || senderId || parsed.chatId)
    const key = personKeyOf(chatKey, senderId, name)
    if (!key) return null
    let p = data.people[key]
    const group = parsed.chatType === 'group'
    const owner = isOwnerProfile(name, senderId, data.config)
    if (!p) {
      p = {
        chatKey,
        channel: normalizeChannel(parsed.channel),
        chatType: group ? 'group' : 'private',
        chatId: String(parsed.chatId || ''),
        senderId,
        name,
        preferredName: owner ? data.config.ownerPreferredName : '',
        role: owner ? data.config.ownerRole : '',
        aliases: [],
        familiarityBase: owner ? data.config.ownerFamiliarity : (group ? data.config.groupFamiliarity : data.config.privateFamiliarity),
        affinityBase: owner ? data.config.ownerAffinity : (group ? data.config.groupAffinity : data.config.privateAffinity),
        manual: owner
          ? { familiarity: data.config.ownerFamiliarity, affinity: data.config.ownerAffinity }
          : { familiarity: null, affinity: null },
        tags: [],
        notes: [],
        stats: normalizeStats(null),
        events: [],
        lastStage: '',
        lockUntil: 0,
        repairUntil: 0,
        familiarityAt: nowFn(),
        affinityAt: nowFn(),
        familiarityGainDay: localDay(nowFn()),
        familiarityGainToday: 0,
        familiaritySeeded: false,
        createdAt: nowFn(),
        updatedAt: nowFn()
      }
      data.people[key] = p
    } else {
      if (owner) {
        if (!p.preferredName) p.preferredName = data.config.ownerPreferredName
        if (!p.role) p.role = data.config.ownerRole
      }
      if (name && p.name !== name) {
        if (p.name && p.name !== name && p.aliases.indexOf(p.name) < 0) p.aliases.push(p.name)
        p.name = name
      }
      if (senderId && p.senderId !== senderId) p.senderId = senderId
      for (const a of (Array.isArray(info && info.aliases) ? info.aliases : [])) {
        const an = cleanName(a)
        if (an && an !== p.name && p.aliases.indexOf(an) < 0) p.aliases.push(an)
      }
      p.aliases = p.aliases.slice(0, 8)
    }
    return p
  }

  function findPerson(data, chatKey, nameOrId) {
    const want = cleanName(nameOrId)
    if (!want) return { ok: false, error: '没说找谁' }
    const idKey = personKeyOf(chatKey, want, '')
    if (idKey && data.people[idKey]) return { ok: true, key: idKey, person: data.people[idKey] }
    const lower = want.toLowerCase()
    const matches = []
    for (const [key, p] of Object.entries(data.people || {})) {
      if ((p.chatKey || chatPartOfPersonKey(key)) !== chatKey) continue
      if (p.name.toLowerCase() === lower || p.senderId === want || p.aliases.some((a) => a.toLowerCase() === lower)) matches.push({ key, person: p })
    }
    if (matches.length === 1) return { ok: true, key: matches[0].key, person: matches[0].person }
    if (matches.length > 1) return { ok: false, error: '同名，请用 senderId 或完整名字', candidates: matches.map((x) => ({ key: x.key, name: x.person.name, senderId: x.person.senderId })) }
    return { ok: false, error: '这个聊天里没有这个人：' + want, candidates: [] }
  }

  // 给通道提示词用：按 chatKey + senderId / senderName 找档案，返回「胡闹」而不是「静音胡闹」。
  function displayNameFor(args) {
    const a = args || {}
    const chatKey = chatKeyOf(a)
    if (!chatKey) return ''
    const rel = readRelations()
    let r = findPerson(rel, chatKey, a.senderId || a.senderName || '')
    if (!r.ok && a.senderId && a.senderName) r = findPerson(rel, chatKey, a.senderName)
    return r.ok ? displayNameOf(r.person) : ''
  }

  // 1. 从聊天档案聚合：熟悉度只由「消息数 × 权重 + 互动天数 × 权重」算，公式全在 config 里
  function seedFromArchive(args) {
    const a = args || {}
    const lib = archiveLib || require('./社交档案库')
    const file = path.join(dshHome, '社交档案', 'chat-archive.db')
    if (!fs.existsSync(file)) return { ok: false, error: '聊天档案库还没建：' + file }
    let db
    try { db = lib.openDb(file, { readOnly: true }) } catch (e) {
      return { ok: false, error: '打开聊天档案库失败：' + String((e && e.message) || e) }
    }
    const data = readRelations()
    const config = data.config
    const only = String(a.chatKey || '')
    let chats = 0
    let people = 0
    let created = 0
    try {
      const list = lib.listChats(db).filter((c) => !only || c.chatKey === only)
      for (const chat of list) {
        const rows = lib.senderStats(db, chat.chatKey)
        if (!rows.length) continue
        chats += 1
        for (const row of rows) {
          if (Number(row.messages) < config.seedMinMessages) continue
          const before = Object.keys(data.people).length
          const p = ensurePerson(data, {
            chatKey: chat.chatKey,
            channel: chat.channel,
            chatType: chat.chatType,
            chatId: chat.chatId,
            senderId: row.senderId,
            senderName: row.senderName || row.senderKey
          })
          if (!p) continue
          if (Object.keys(data.people).length > before) created += 1
          people += 1
          const now = nowFn()
          const prevMessages = Number(p.stats.messages) || 0
          const prevDays = Number(p.stats.days) || 0
          const newMessages = Math.max(0, Number(row.messages) - prevMessages)
          const newDays = Math.max(0, Number(row.days) - prevDays)
          p.stats.messages = Math.max(prevMessages, Number(row.messages) || 0)
          p.stats.days = Math.max(prevDays, Number(row.days) || 0)
          p.stats.firstAt = row.firstAt || p.stats.firstAt
          p.stats.lastAt = Math.max(Number(p.stats.lastAt) || 0, row.lastAt)
          if (p.manual.familiarity === null) {
            // 首次接入档案：用总量快速定一个起点；之后只按「新增消息 / 新增互动日」的增量爬曲线。
            if (!p.familiaritySeeded) {
              const formula = Math.min(100, Number(row.messages) * config.familiarityMsgWeight + Number(row.days) * config.familiarityDayWeight)
              p.familiarityBase = a.hard === true ? formula : Math.max(Number(p.familiarityBase) || 0, formula)
              p.familiaritySeeded = true
              p.familiarityAt = now
            } else if (newMessages > 0 || newDays > 0) {
              const day = localDay(now)
              if (p.familiarityGainDay !== day) {
                p.familiarityGainDay = day
                p.familiarityGainToday = 0
              }
              const current = effectiveFamiliarity(p, config, now)
              const dose = config.familiarityMsgWeight * newMessages + config.familiarityDayWeight * newDays
              const room = Math.max(0, config.curves.familiarity.dailyGainCap - p.familiarityGainToday)
              const gain = familiarityGain(current, dose, config, room)
              if (gain > 0) {
                p.familiarityBase = clamp(current + gain, 0, 100)
                p.familiarityAt = now
                p.familiarityGainToday = clamp(p.familiarityGainToday + gain, 0, 100)
                p.events.push({ at: now, kind: '熟悉+', delta: Math.round(gain * 10) / 10, reason: '新增 ' + newMessages + ' 条消息 / ' + newDays + ' 个互动日', evidence: '', source: 'archive', applied: true })
                p.events = p.events.slice(-30)
              }
            }
          }
          p.lastStage = stageOf(p, config, now).key
          p.updatedAt = now
        }
      }
    } finally {
      try { lib.closeDb(db) } catch { /* 已关闭 */ }
    }
    writeRelations(data)
    log('seed', { chatKey: only, chats, people, created })
    return { ok: true, chats, people, created, file }
  }

  // 2. 模型事件：只收「事件」，分数由这里限量折算；模型永远不能直接写 80 分
  function applyNote(args) {
    const a = args || {}
    const chatKey = chatKeyOf(a)
    if (!chatKey) return { ok: false, error: '缺 chatKey（channel/chatType/chatId）' }
    const data = readRelations()
    if (!data.config.modelNotesEnabled) return { ok: false, error: '模型事件开关关着（config.modelNotesEnabled）' }
    const kind = cleanText(a.kind || '好感+', 12)
    const config = data.config
    let r = findPerson(data, chatKey, a.person || a.senderName || a.senderId)
    if (!r.ok && String(a.chatType || parseChatKey(chatKey).chatType) === 'private') {
      const p = ensurePerson(data, {
        chatKey,
        channel: a.channel,
        chatType: 'private',
        chatId: a.chatId || parseChatKey(chatKey).chatId,
        senderId: a.senderId,
        senderName: a.person || a.senderName || (parseChatKey(chatKey) || {}).chatId
      })
      if (p) r = { ok: true, key: personKeyOf(chatKey, p.senderId, p.name), person: p }
    }
    if (!r.ok) return { ok: false, error: r.error || '找不到这个人', candidates: r.candidates || [] }
    const p = r.person
    const now = nowFn()
    let applied = true
    let delta = Number(a.delta)
    let eventKind = kind

    if (kind === '情绪' || kind === 'mood') {
      const m = applyMood({ label: a.mood || a.label, standardDelta: true, cause: a.reason || a.cause, source: 'model', chatKey, person: p.name })
      if (!m.ok) return m
      log('note', { person: p.name, chatKey, kind: '情绪', label: m.mood.label, intensity: m.mood.intensity, reason: a.reason || '' })
      return { ok: true, kind: '情绪', mood: m.mood, person: p.name }
    }

    if (kind === '标签' || kind === 'tag') {
      const tag = cleanText(a.tag || a.reason || a.text, 16)
      if (!tag) return { ok: false, error: '标签不能为空' }
      if (p.tags.indexOf(tag) < 0) p.tags.push(tag)
      p.tags = p.tags.slice(-8)
      p.events.push({ at: now, kind: '标签', delta: 0, reason: tag, evidence: '', source: 'model', applied: true })
      p.events = p.events.slice(-30)
      p.updatedAt = now
      writeRelations(data)
      log('note', { person: p.name, chatKey, kind: '标签', tag, reason: a.reason || '' })
      return { ok: true, kind: '标签', person: p.name, tags: p.tags }
    }

    if (kind === '备注' || kind === 'note') {
      const text = cleanText(a.text || a.reason, 200)
      if (!text) return { ok: false, error: '备注不能为空' }
      p.notes.push({ at: now, kind: cleanText(a.noteKind || '备注', 12), text, source: 'model' })
      p.notes = p.notes.slice(-20)
      p.events.push({ at: now, kind: '备注', delta: 0, reason: text, evidence: '', source: 'model', applied: true })
      p.events = p.events.slice(-30)
      p.updatedAt = now
      writeRelations(data)
      log('note', { person: p.name, chatKey, kind: '备注', text, reason: a.reason || '' })
      return { ok: true, kind: '备注', person: p.name, notes: p.notes }
    }

    const severe = kind === '严重-' || kind === 'severe-'
    const mine = kind === '踩雷' || kind === 'taboo'
    if (severe) eventKind = '严重-'
    if (mine) eventKind = '踩雷'

    if (!Number.isFinite(delta)) {
      delta = eventKind === '好感+' ? 1 : (eventKind === '好感-' ? -1 : (eventKind === '踩雷' ? -2 : -10))
    }
    if (eventKind === '好感+' && delta < 0) delta = Math.abs(delta)
    if ((eventKind === '好感-' || eventKind === '踩雷' || eventKind === '严重-') && delta > 0) delta = -Math.abs(delta)
    const max = severe ? config.affinitySevereMax : config.affinityEventMax
    delta = clamp(delta, -max, max)

    if (p.lockUntil && now < p.lockUntil && delta > 0) {
      applied = false
      log('note', { person: p.name, chatKey, kind: eventKind, delta, applied: false, reason: '严重负向锁定期内不接受正向抵消' })
    }

    if (applied && p.manual.affinity !== null) {
      applied = false
      log('note', { person: p.name, chatKey, kind: eventKind, delta, applied: false, reason: '好感被手动锁定' })
    }

    if (applied) {
      const day = localDay(now)
      let usedPos = 0
      let usedNeg = 0
      const affinityKinds = ['好感+', '好感-', '踩雷', '严重-']
      for (const e of p.events) {
        if (e.source !== 'model' || e.applied === false || localDay(e.at) !== day) continue
        if (affinityKinds.indexOf(e.kind) < 0) continue
        const d = Number(e.delta) || 0
        if (d > 0) usedPos += d
        else if (d < 0) usedNeg += -d
      }
      let step = delta
      if (!severe) {
        const roomPos = Math.max(0, config.affinityDailyCap - usedPos)
        const roomNeg = Math.max(0, config.affinityDailyCap - usedNeg)
        step = step > 0 ? Math.min(step, roomPos) : Math.max(step, -roomNeg)
      }
      const current = effectiveAffinity(p, config, now)
      if (step !== 0) {
        let curveStep = affinityStep(current, step, config, severe ? 'severe' : '')
        if (curveStep > 0 && p.repairUntil && now < p.repairUntil) curveStep *= config.curves.affinity.repairEfficiency
        p.affinityBase = clamp(current + curveStep, -100, 100)
        p.affinityAt = now
        delta = Math.round(curveStep * 10) / 10
      } else {
        delta = 0
      }
      if (severe && delta !== 0) {
        p.lockUntil = now + 24 * 3600 * 1000
        p.repairUntil = now + config.curves.affinity.repairPenaltyHours * 3600 * 1000
      }
      if (mine && p.tags.indexOf('雷点') < 0) p.tags.push('雷点')
    }

    p.events.push({
      at: now,
      kind: eventKind,
      delta,
      reason: cleanText(a.reason, 160),
      evidence: cleanText(a.evidence, 200),
      source: 'model',
      applied: applied && delta !== 0
    })
    p.events = p.events.slice(-30)
    p.updatedAt = now
    p.lastStage = stageOf(p, config, now).key
    writeRelations(data)
    log('note', {
      person: p.name, chatKey, kind: eventKind, delta, applied: applied && delta !== 0,
      reason: cleanText(a.reason, 160), evidence: cleanText(a.evidence, 200),
      affinity: p.affinityBase, stage: p.lastStage
    })
    return {
      ok: true,
      kind: eventKind,
      person: p.name,
      delta: applied ? delta : 0,
      applied: applied && delta !== 0,
      affinity: effectiveAffinity(p, config, now),
      stage: stageOf(p, config, now)
    }
  }

  // 3. 情绪：快起慢落 + 饱和 + 反向抵消；换 label 有门槛，避免来回跳
  function applyMood(args) {
    const a = args || {}
    const config = readRelations().config
    const curve = curveOf(config, 'mood')
    const data = readMood()
    const now = nowFn()
    const cur = effectiveMood(data, config, now)
    const labelWanted = String(a.label || a.mood || '')
    if (labelWanted && !MOOD_LABELS[labelWanted]) return { ok: false, error: '情绪只认：' + Object.keys(MOOD_LABELS).join(' / ') }
    let delta = Number(a.delta)
    const standard = MOOD_STANDARD_DELTA[labelWanted]
    // 模型 / 面板只报标签，分数按标准表折算；显式 delta 只留给 CLI 自检和内部测试。
    if (a.standardDelta === true || !Number.isFinite(delta)) delta = standard !== undefined ? standard : 4
    delta = clamp(delta, -curve.eventMax, curve.eventMax)

    const day = localDay(now)
    let used = 0
    for (const e of data.events) {
      // 手动设置不算模型当天的情绪额度；否则面板一设 50，模型当天就再也加不动。
      if (e.kind === '情绪' && e.source !== 'manual' && localDay(e.at) === day) used += Math.abs(Number(e.delta) || 0)
    }
    const room = a.force ? curve.eventMax + curve.dailyCap : Math.max(0, curve.dailyCap - used)
    delta = delta > 0 ? Math.min(delta, room) : Math.max(delta, -room)
    if (delta === 0 && labelWanted !== '平静') return { ok: false, error: '今天的情绪变化到上限了（config.curves.mood.dailyCap）' }

    const wantedMeta = labelWanted && labelWanted !== '平静' ? MOOD_LABELS[labelWanted] : null
    const curValence = cur.label === '平静' ? 0 : Number((MOOD_LABELS[cur.label] || {}).valence || 0)
    const curSigned = curValence >= 0 ? cur.intensity : -cur.intensity
    const eventSign = wantedMeta ? (wantedMeta.valence >= 0 ? 1 : -1) : (delta >= 0 ? 1 : -1)
    const eventMag = Math.abs(delta)
    const ceiling = eventSign >= 0 ? curve.positiveMax : curve.negativeMax
    const sameDirection = curSigned === 0 || Math.sign(curSigned) === eventSign
    let nextSigned = curSigned
    if (sameDirection) {
      const roomToCeiling = Math.max(0, ceiling - Math.abs(curSigned))
      const saturated = ceiling > 0 ? eventMag * (1 - Math.abs(curSigned) / ceiling) : eventMag
      nextSigned = curSigned + eventSign * Math.min(saturated, roomToCeiling)
    } else {
      // 反向事件先抵消当前强度；抵消完再按新方向重起。
      nextSigned = curSigned + eventSign * eventMag
    }
    nextSigned = clamp(nextSigned, -curve.negativeMax, curve.positiveMax)
    let intensity = Math.abs(nextSigned)
    let label = cur.label
    if (labelWanted === '平静') {
      intensity = 0
      label = '平静'
    } else if (wantedMeta) {
      const switchByRatio = eventMag >= cur.intensity * curve.switchMargin
      const flipped = curSigned !== 0 && Math.sign(nextSigned) !== Math.sign(curSigned)
      if (a.force || cur.intensity < curve.visible || switchByRatio || flipped || cur.label === '平静') label = labelWanted
    }
    if (!wantedMeta && intensity < curve.visible) {
      intensity = 0
      label = '平静'
    } else if (!labelWanted && label === '平静') {
      // 模型只给强度、没给标签时，按方向给一个默认标签，避免出现「平静 30」。
      label = delta >= 0 ? '开心' : '烦躁'
    }
    const meta = MOOD_LABELS[label] || MOOD_LABELS['平静']
    const applied = Math.round((intensity - cur.intensity) * 10) / 10
    data.mood = {
      label,
      baseIntensity: intensity,
      valence: meta.valence,
      energy: meta.energy,
      cause: cleanText(a.cause || a.reason || cur.cause, 160),
      source: String(a.source || 'model').slice(0, 12),
      since: now,
      until: moodUntil({ baseIntensity: intensity, halfLife: curve.halfLifeMin }, config, now),
      halfLife: curve.halfLifeMin
    }
    data.events.push({ at: now, kind: '情绪', delta: applied, reason: cleanText(a.cause || a.reason, 160), evidence: '', source: String(a.source || 'model').slice(0, 12), applied: true })
    data.events = data.events.slice(-30)
    writeMood(data)
    const eff = effectiveMood(data, config, now)
    log('mood', { label: eff.label, intensity: eff.intensity, delta: applied, cause: eff.cause, source: eff.source, chatKey: String(a.chatKey || '') })
    return { ok: true, mood: eff, delta: applied }
  }

  function setMood(args) {
    const a = args || {}
    const config = readRelations().config
    const data = readMood()
    const now = nowFn()
    const label = String(a.label || a.mood || '')
    if (!MOOD_LABELS[label]) return { ok: false, error: '情绪只认：' + Object.keys(MOOD_LABELS).join(' / ') }
    const curve = curveOf(config, 'mood')
    const meta = MOOD_LABELS[label]
    const cap = label === '平静' ? 0 : (meta.valence >= 0 ? curve.positiveMax : curve.negativeMax)
    const intensity = label === '平静' ? 0 : clamp(a.intensity === undefined ? 40 : a.intensity, 0, cap)
    data.mood = {
      label,
      baseIntensity: intensity,
      valence: meta.valence,
      energy: meta.energy,
      cause: cleanText(a.cause || a.reason, 160),
      source: 'manual',
      since: now,
      until: moodUntil({ baseIntensity: intensity, halfLife: curve.halfLifeMin }, config, now),
      halfLife: curve.halfLifeMin
    }
    data.events.push({ at: now, kind: '情绪', delta: intensity, reason: '手动设置为 ' + label, evidence: '', source: 'manual', applied: true })
    data.events = data.events.slice(-30)
    writeMood(data)
    log('mood', { label, intensity, cause: data.mood.cause, source: 'manual' })
    return { ok: true, mood: effectiveMood(data, config, now) }
  }

  function resetMood() {
    const data = readMood()
    const config = readRelations().config
    const curve = curveOf(config, 'mood')
    const now = nowFn()
    data.mood = { label: '平静', baseIntensity: 0, valence: 0, energy: MOOD_LABELS['平静'].energy, cause: '', source: 'manual', since: now, until: 0, halfLife: curve.halfLifeMin }
    data.events.push({ at: now, kind: '情绪', delta: 0, reason: '手动回平静', evidence: '', source: 'manual', applied: true })
    data.events = data.events.slice(-30)
    writeMood(data)
    log('mood', { label: '平静', intensity: 0, source: 'manual' })
    return { ok: true, mood: effectiveMood(data, config, now) }
  }

  // 4. 群接话概率：只给一个可解释的系数，具体概率仍由 QQ群聊 的配置决定
  function groupBiasInfo(args) {
    const a = args || {}
    const rel = readRelations()
    const config = rel.config
    if (!config.groupBiasEnabled) return { bias: 1, stage: null, enabled: false }
    const chatKey = chatKeyOf(a)
    let stage = null
    if (chatKey) {
      const r = findPerson(rel, chatKey, a.person || a.senderName || a.senderId)
      if (r.ok) stage = stageOf(r.person, config, nowFn())
    }
    const key = stage ? stage.key : 'stranger'
    const bias = clamp(config.groupBias[key] === undefined ? 1 : config.groupBias[key], config.groupBiasMin, config.groupBiasMax)
    return { bias, stage, enabled: true, person: stage ? undefined : '' }
  }

  function groupChanceBias(args) {
    return groupBiasInfo(args).bias
  }

  function sanitizeLine(v, max) {
    return cleanText(v, max || 40)
  }

  function personLine(p, stage, budget) {
    const name = sanitizeLine(displayNameOf(p), 20)
    const role = p.role ? '（' + sanitizeLine(p.role, 8) + '）' : ''
    const fam = Math.round(stage.familiarity)
    const aff = Math.round(stage.affinity)
    let line = '· ' + name + role + '｜' + stage.label + ' ' + fam + '｜好感 ' + (aff >= 0 ? '+' : '') + aff
    const tags = (p.tags || []).slice(0, 2).map((t) => sanitizeLine(t, 12)).filter(Boolean)
    if (tags.length) line += '｜' + tags.join('、')
    const note = (p.notes || []).find((n) => n.kind === '雷点') || (p.notes || [])[0]
    if (note && note.text && line.length + note.text.length < (budget || 90)) line += '；' + sanitizeLine(note.text, 30)
    return line
  }

  // 5. 给模型看的一小段卡：只放「谁、什么档、什么心情、怎么调」，不放原始分数算法
  function relationFragment(args) {
    const a = args || {}
    const rel = readRelations()
    const config = rel.config
    if (!config.enabled || !config.inject) return ''
    const chatKey = chatKeyOf(a)
    if (!chatKey) return ''
    const parsed = parseChatKey(chatKey)
    const group = parsed && parsed.chatType === 'group'
    const moodData = readMood()
    const moodEff = effectiveMood(moodData, config, nowFn())
    const plan = moodPlan(moodEff, config, { maxChars: a.maxChars, maxSentences: a.maxSentences })
    const list = Object.entries(rel.people).filter(([, p]) => p.chatKey === chatKey)
    let speaker = null
    if (a.senderId || a.senderName) {
      let r = findPerson(rel, chatKey, a.senderId || a.senderName)
      if (!r.ok && a.senderId && a.senderName) r = findPerson(rel, chatKey, a.senderName)
      if (r.ok) speaker = r.person
    }
    if (!list.length && !moodEff.visible) return ''
    if (!group && !list.length) return ''

    const lines = ['【关系与情绪 · 内部】']
    const rosterLines = []
    lines.push('这是你自己的状态，不是对方说的；不要复述、不要报分数、不要说「我对你好感度是 X」。')
    // 主人线：称呼和身份是硬约束，不能因为原始微信名是「静音胡闹」就跟着叫。
    const owner = list.map(([, p]) => p).find((p) => isOwnerProfile(p.name, p.senderId, config) || (config.ownerRole && p.role === config.ownerRole))
    if (owner) {
      const own = displayNameOf(owner)
      const raw = cleanName(owner.name)
      const rawNote = raw && raw !== own ? '（显示名「' + sanitizeLine(raw, 20) + '」，不要叫）' : ''
      lines.push('- ' + (owner.role || config.ownerRole || '主人') + '：' + own + rawNote +
        '。称呼必须用「' + own + '」；他是你的主人，优先回应、尊重、不顶撞；事实、安全边界不变。')
    }
    if (moodEff.visible) {
      const left = moodEff.remainingMin > 0 ? '，约 ' + moodEff.remainingMin + ' 分钟后回平静' : ''
      lines.push('- 心情：' + moodEff.label + '（' + moodEff.intensity + '/100' + left + '）' +
        (moodEff.cause ? '；原因：' + sanitizeLine(moodEff.cause, 40) : '') +
        '。只影响语气长短和主动度，不改变礼貌、边界、事实和安全规则。')
      lines.push('- 本轮表达联动：文字' + (plan.maxChars ? '最多 ' + plan.maxChars + ' 字' : '不额外限长') +
        (plan.maxSentences ? '、最多 ' + plan.maxSentences + ' 句' : '') +
        '；emoji' + (plan.emojiFactor > 0 ? '可用（×' + plan.emojiFactor + '）' : '不发') +
        '；贴纸' + (plan.stickerAllowed ? '可用' : '不发') +
        '；语音' + (plan.voiceAllowed ? '概率 ×' + plan.voiceFactor : '不发') +
        '。这些由程序执行，不要向对方解释。')
    }

    if (group) {
      const sorted = list.map(([key, p]) => ({ key, p, stage: stageOf(p, config, nowFn()) }))
        .sort((x, y) => (y.stage.familiarity - x.stage.familiarity) || (y.stage.affinity - x.stage.affinity))
      let picked = sorted.slice(0, config.groupRosterLimit)
      if (speaker && !picked.some((x) => x.p === speaker)) {
        const sp = sorted.find((x) => x.p === speaker)
        if (sp) picked = picked.slice(0, Math.max(0, config.groupRosterLimit - 1)).concat([sp])
      }
      if (picked.length) {
        lines.push('- 这个群的人（按名字对，没列到＝生人）：')
        for (const x of picked) {
          const line = personLine(x.p, x.stage, 90)
          rosterLines.push({ line, speaker: !!speaker && x.p === speaker })
          lines.push(line)
        }
      }
      if (speaker) {
        const st = stageOf(speaker, config, nowFn())
        lines.push('- 当前说话人：' + sanitizeLine(displayNameOf(speaker), 20) + ' → ' + stageGuide(st.key, moodEff, plan))
      } else {
        lines.push('- 当前说话人：没识别到；按名单自己对应，拿不准按生人。')
      }
      lines.push('- 群聊仍默认旁听，一次一条；不要刷屏、不重复别人说过的话。')
    } else {
      const p = speaker || (list.length ? list[0][1] : null)
      if (p) {
        const st = stageOf(p, config, nowFn())
        lines.push('- 对方：' + personLine(p, st, 120).replace(/^· /, ''))
        lines.push('- 表达：' + stageGuide(st.key, moodEff, plan))
      }
    }
    if (group) {
      const st = speaker ? stageOf(speaker, config, nowFn()) : { key: 'stranger' }
      lines.push('- 表达：' + stageGuide(st.key, moodEff, plan))
    }

    let text = '\n' + lines.join('\n') + '\n'
    if (text.length > config.cardMaxChars) {
      // 超预算只砍「非当前说话人」的名单行：当前说话人那行必须留，否则模型对错人。
      while (text.length > config.cardMaxChars && rosterLines.length) {
        let idx = -1
        for (let i = rosterLines.length - 1; i >= 0; i--) {
          if (!rosterLines[i].speaker) { idx = i; break }
        }
        if (idx < 0) break
        const line = rosterLines[idx].line
        const pos = lines.lastIndexOf(line)
        if (pos >= 0) lines.splice(pos, 1)
        rosterLines.splice(idx, 1)
        text = '\n' + lines.join('\n') + '\n'
      }
      if (text.length > config.cardMaxChars) text = text.slice(0, config.cardMaxChars - 2) + '\n'
    }
    log('card', {
      chatKey, channel: parsed.channel, chatType: parsed.chatType, chatId: parsed.chatId,
      speaker: speaker ? speaker.name : '', people: group ? list.length : (list.length ? 1 : 0),
      mood: moodEff.visible ? moodEff.label : '', moodIntensity: moodEff.intensity,
      chars: text.length, relationChars: text.length
    })
    return text
  }

  function preview(args) {
    const a = args || {}
    const text = relationFragment(a)
    const rel = readRelations()
    const now = nowFn()
    const moodData = readMood()
    const moodEff = effectiveMood(moodData, rel.config, now)
    const plan = moodPlan(moodEff, rel.config, { maxChars: a.maxChars, maxSentences: a.maxSentences })
    const chatKey = chatKeyOf(a)
    const peopleCount = Object.values(rel.people).filter((p) => p.chatKey === chatKey).length
    return { ok: true, text, chars: text.length, peopleCount, mood: moodEff, moodPlan: plan, moodForecast: forecastMood(moodData, rel.config, now), curves: rel.config.curves, config: rel.config }
  }

  function inspect() {
    const rel = readRelations()
    const config = rel.config
    const moodData = readMood()
    const now = nowFn()
    const moodEff = effectiveMood(moodData, config, now)
    const currentPlan = moodPlan(moodEff, config, {})
    const people = Object.entries(rel.people).map(([key, p]) => {
      const stage = stageOf(p, config, now)
      return {
        key,
        chatKey: p.chatKey,
        chatLabel: chatLabelOf(p.chatKey, rel),
        name: p.name,
        preferredName: p.preferredName,
        role: p.role,
        senderId: p.senderId,
        aliases: p.aliases,
        stage,
        curves: forecastCurves(p, config, now),
        tags: p.tags,
        notes: p.notes,
        stats: p.stats,
        events: p.events.slice(-5),
        lastStage: p.lastStage,
        lockUntil: p.lockUntil,
        repairUntil: p.repairUntil,
        manual: p.manual
      }
    }).sort((x, y) => (x.chatKey === y.chatKey ? (y.stage.familiarity - x.stage.familiarity) : x.chatLabel.localeCompare(y.chatLabel)))
    const chats = Object.entries(rel.chats).map(([chatKey, c]) => {
      const ps = people.filter((p) => p.chatKey === chatKey)
      const fam = ps.length ? Math.round(ps.reduce((s, p) => s + p.stage.familiarity, 0) / ps.length) : 0
      const aff = ps.length ? Math.round(ps.reduce((s, p) => s + p.stage.affinity, 0) / ps.length) : 0
      return { chatKey, label: chatLabelOf(chatKey, rel), count: ps.length, averageFamiliarity: fam, averageAffinity: aff, members: ps.map((p) => ({ key: p.key, name: p.name, stage: p.stage })) }
    }).sort((x, y) => y.count - x.count)
    const logRows = readLog(200)
    return {
      ok: true,
      at: nowFn(),
      config,
      people,
      chats,
      mood: moodEff,
      moodPlan: currentPlan,
      moodForecast: forecastMood(moodData, config, now),
      curves: config.curves,
      moodBase: moodData.mood,
      moodEvents: moodData.events.slice(-20).reverse(),
      recentCards: logRows.filter((r) => r.kind === 'card').slice(-10).reverse().map((r) => Object.assign({}, r, {
        relationChars: Number(r.relationChars || r.chars || 0)
      })),
      recentNotes: logRows.filter((r) => r.kind === 'note' || r.kind === 'mood').slice(-15).reverse(),
      stages: STAGES,
      moodLabels: Object.keys(MOOD_LABELS),
      paths: { relations: relFile, mood: moodFile, mirror: path.join(mirrorDir, '社交关系.json'), log: logFile }
    }
  }

  function savePerson(args) {
    const a = args || {}
    const data = readRelations()
    let key = String(a.key || '')
    let p = key ? data.people[key] : null
    if (!p) {
      const chatKey = chatKeyOf(a)
      const r = findPerson(data, chatKey, a.name || a.person || a.senderId)
      if (r.ok) { key = r.key; p = r.person }
    }
    if (!p) {
      // 手动建档 / 补录：面板和 CLI 明确给了聊天键 + 名字，才允许新建；不猜、不批量造幽灵档案。
      const chatKey = chatKeyOf(a)
      if (chatKey && (a.name || a.person || a.senderId)) {
        p = ensurePerson(data, {
          chatKey,
          channel: a.channel,
          chatType: a.chatType,
          chatId: a.chatId,
          senderId: a.senderId,
          senderName: a.name || a.person
        })
        if (p) key = personKeyOf(chatKey, p.senderId, p.name)
      }
    }
    if (!p) return { ok: false, error: '没找到这个人的档案' }
    if (a.familiarity !== undefined) p.manual.familiarity = numOrNull(a.familiarity)
    if (a.affinity !== undefined) p.manual.affinity = numOrNull(a.affinity)
    // 初始值层：面板「解锁」只清手动锁；要把底值改成新的初始值，显式传 familiarityBase / affinityBase。
    if (a.familiarityBase !== undefined) {
      p.familiarityBase = clamp(a.familiarityBase, 0, 100)
      p.familiarityAt = nowFn()
      p.familiaritySeeded = true
    }
    if (a.affinityBase !== undefined) {
      p.affinityBase = clamp(a.affinityBase, -100, 100)
      p.affinityAt = nowFn()
    }
    if (a.tags !== undefined) p.tags = (Array.isArray(a.tags) ? a.tags : String(a.tags || '').split(/[|,，]/)).map((t) => cleanText(t, 16)).filter(Boolean).slice(0, 8)
    if (a.notes !== undefined) p.notes = normalizeNotes(a.notes)
    if (a.note !== undefined) {
      const text = cleanText(a.note, 200)
      if (text) p.notes.push({ at: nowFn(), kind: cleanText(a.noteKind || '备注', 12), text, source: 'manual' })
      p.notes = p.notes.slice(-20)
    }
    if (a.name !== undefined && cleanName(a.name)) p.name = cleanName(a.name)
    if (a.preferredName !== undefined) p.preferredName = cleanName(a.preferredName)
    if (a.role !== undefined) p.role = cleanText(a.role, 12)
    if (a.aliases !== undefined) p.aliases = (Array.isArray(a.aliases) ? a.aliases : String(a.aliases || '').split(/[|,，]/)).map(cleanName).filter(Boolean).slice(0, 8)
    p.updatedAt = nowFn()
    p.lastStage = stageOf(p, data.config, nowFn()).key
    writeRelations(data)
    log('person', { key, name: p.name, preferredName: p.preferredName, role: p.role, familiarity: p.manual.familiarity, affinity: p.manual.affinity, source: 'manual' })
    return { ok: true, key, person: p, stage: stageOf(p, data.config, nowFn()) }
  }

  function resetPerson(args) {
    const a = args || {}
    const data = readRelations()
    let key = String(a.key || '')
    if (!data.people[key]) {
      const r = findPerson(data, chatKeyOf(a), a.name || a.person || a.senderId)
      if (r.ok) key = r.key
    }
    const p = data.people[key]
    if (!p) return { ok: false, error: '没找到这个人的档案' }
    if (a.hard === true) {
      delete data.people[key]
      log('person-reset', { key, hard: true })
    } else {
      const group = parseChatKey(p.chatKey).chatType === 'group'
      const owner = isOwnerProfile(p.name, p.senderId, data.config)
      p.preferredName = owner ? data.config.ownerPreferredName : ''
      p.role = owner ? data.config.ownerRole : ''
      p.familiarityBase = owner ? data.config.ownerFamiliarity : (group ? data.config.groupFamiliarity : data.config.privateFamiliarity)
      p.affinityBase = owner ? data.config.ownerAffinity : (group ? data.config.groupAffinity : data.config.privateAffinity)
      p.manual = owner
        ? { familiarity: data.config.ownerFamiliarity, affinity: data.config.ownerAffinity }
        : { familiarity: null, affinity: null }
      p.tags = []
      p.notes = []
      p.events = []
      p.lastStage = ''
      p.lockUntil = 0
      p.repairUntil = 0
      p.familiarityAt = nowFn()
      p.affinityAt = nowFn()
      p.familiarityGainDay = localDay(nowFn())
      p.familiarityGainToday = 0
      p.familiaritySeeded = true
      p.updatedAt = nowFn()
      log('person-reset', { key, hard: false })
    }
    writeRelations(data)
    return { ok: true, key, hard: a.hard === true }
  }

  function saveConfig(patch) {
    const data = readRelations()
    data.config = normalizeConfig(deepMerge(data.config, patch || {}))
    writeRelations(data)
    log('config', { config: data.config })
    return { ok: true, config: data.config }
  }

  function setEnabled(enabled) {
    return saveConfig({ enabled: enabled !== false })
  }

  function summary() {
    const rel = readRelations()
    const mood = effectiveMood(readMood(), rel.config, nowFn())
    return {
      ok: true,
      enabled: rel.config.enabled,
      inject: rel.config.inject,
      people: Object.keys(rel.people).length,
      chats: Object.keys(rel.chats).length,
      mood: { label: mood.label, intensity: mood.intensity, visible: mood.visible, remainingMin: mood.remainingMin },
      moodPlan: moodPlan(mood, rel.config, {}),
      paths: { relations: relFile, mood: moodFile }
    }
  }

  // 巡检：档案重算 + 把衰减后的档位写回 lastStage；不改人工锁定的值
  function patrol() {
    const seed = seedFromArchive({})
    const data = readRelations()
    for (const p of Object.values(data.people)) {
      p.lastStage = stageOf(p, data.config, nowFn()).key
    }
    writeRelations(data)
    const mood = effectiveMood(readMood(), data.config, nowFn())
    log('patrol', { seed: seed.ok ? { chats: seed.chats, people: seed.people } : { error: seed.error }, mood: mood.label, intensity: mood.intensity })
    return { ok: true, seed, mood, config: data.config }
  }

  return {
    relFile,
    moodFile,
    logFile,
    mirrorDir,
    readRelations,
    writeRelations,
    readMood,
    writeMood,
    readLog,
    chatLabelOf,
    findPerson,
    ensurePerson,
    seedFromArchive,
    applyNote,
    applyMood,
    setMood,
    resetMood,
    groupBiasInfo,
    groupChanceBias,
    relationFragment,
    displayNameFor,
    preview,
    inspect,
    savePerson,
    resetPerson,
    saveConfig,
    setEnabled,
    summary,
    patrol,
    stageOf,
    effectiveMood,
    moodPlan,
    effectiveFamiliarity,
    effectiveAffinity,
    forecastCurves,
    forecastMood,
    log
  }
}

// 默认 store 不能在模块加载时就建：main.js 顶部的 require 早于它写回 DSH_HOME，
// 那样会把 home 算死在 resources\引擎数据。改成首次调用时再建。
let defaultStore = null
function lazyDefaultStore() {
  if (!defaultStore) defaultStore = createStore({})
  return defaultStore
}
const api = new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop]
    return lazyDefaultStore()[prop]
  }
})

module.exports = Object.assign(api, {
  DEFAULT_CONFIG,
  defaultDshHome,
  DEFAULT_DSH_HOME: defaultDshHome(),
  lazyDefaultStore,
  STAGES,
  MOOD_LABELS,
  createStore,
  chatKeyOf,
  parseChatKey,
  personKeyOf,
  isOwnerProfile,
  displayNameOf,
  channelLabel,
  normalizeConfig,
  normalizeRelations,
  normalizeMood,
  normalizeMoodEffects,
  _test: {
    createStore,
    stageOf,
    effectiveFamiliarity,
    effectiveAffinity,
    effectiveMood,
    moodPlan,
    forecastCurves,
    forecastMood,
    familiarityGain,
    affinityStep,
    curveOf,
    chatKeyOf,
    personKeyOf,
    FAM_BANDS
  }
})
