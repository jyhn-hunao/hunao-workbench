'use strict';
// 社交回复.js —— 通道无关的回复策略 + 社交会话总表（2026-11-19）
//
// 定位：微信 / QQ / 飞书只保留各自的传输与原生能力；回复语气、emoji、表情包频率、
// 严肃场景抑制、会话归属这些「回复机制」集中在这里，避免每接一个通道就复制一套。
//
// 为什么现在先做这一层：微信通道.js 的 _formatPrompt 里只有一句固定 [[sticker:happy]]
// 提示，QQ 的 dsh-onebot-channel 和飞书的 dsh-im 又各有一套自己的提示词。用户要的是
// 「同一套回复策略，通道只换传输」；再往微信里加功能，另外两条通道永远缺。
//
// 数据：
//   外壳\data\社交回复.json        通用策略（唯一可编辑源；本机配置，gitignored）
//   外壳\data\社交会话.json        chatId -> DSH 会话总表（微信 / QQ / 飞书共用）
//   <DSH_HOME>\场景记忆\_共享记忆\社交会话.json  给 DSH 插件读的镜像（不含密钥）
//   外壳\data\社交回复-状态.json   最近一次实际回复 / 计数，设置页观察用
//
// 原则：
//   · 这里不碰登录、窗口、协议、发送；发送仍由各通道适配器完成。
//   · 通道不支持的项不装开关：设置页只显示「支持 / 原生控制 / 不支持」，不画假绿。
//   · 任何策略读失败都退回默认值，绝不阻断消息。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const POLICY_FILE = path.join(DATA_DIR, '社交回复.json');
const SESSIONS_FILE = path.join(DATA_DIR, '社交会话.json');
const STATUS_FILE = path.join(DATA_DIR, '社交回复-状态.json');
const LEGACY_WECHAT_MAP = path.join(DATA_DIR, '微信通道', '微信会话.json');

function dshHomePath() {
  return process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh');
}

function mirrorFile(dshHome) {
  return path.join(String(dshHome || dshHomePath()), '场景记忆', '_共享记忆', '社交会话.json');
}

// 策略镜像：DSH 侧插件读这一份，不直接依赖外壳目录。
// 只镜像策略正文，不含账号 / 密钥 / 端口。
function policyMirrorFile(dshHome) {
  return path.join(String(dshHome || dshHomePath()), '场景记忆', '_共享记忆', '社交回复.json');
}

function dshStatusFile(dshHome) {
  return path.join(String(dshHome || dshHomePath()), '场景记忆', '_共享记忆', '社交策略-状态.json');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] readJson failed: ' + file, e);
    return fallback;
  }
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] mkdir failed: ' + dir, e);
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v * 1000) / 1000));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = isObj(base) ? clone(base) : {};
  if (!isObj(patch)) return out;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = Array.isArray(v) ? clone(v) : v;
  }
  return out;
}

// 默认策略：只放「回复机制」，不放任何账号 / 密钥 / 端口。
// 表情包开关不在这里重复：微信是否允许贴纸仍由鲸鲸设置里的 native.stickers 控制，
// 这里只控制「策略允不允许提议」和频率，避免两套同名开关。
const DEFAULT_POLICY = {
  _说明: '通用社交回复策略。通道只做传输；语气、emoji、表情包频率、严肃抑制在这里。',
  version: 1,
  updatedAt: 0,
  global: {
    tone: '像真人聊天：短句、自然、不写小作文，不用客服腔，不解释系统或工具。',
    emoji: {
      enabled: true,
      chance: 0.18,
      maxPerReply: 1
    },
    sticker: {
      enabled: true,
      chance: 0.3,
      maxPerReply: 1,
      seriousSuppress: true
    },
    // 群聊不是私聊：默认旁听，只有明确该接的时候才接。
    // 具体窗口 / 防刷屏仍由各通道原生逻辑执行；这里只给模型一条统一的判断口径。
    group: {
      listenFirst: true,
      onlyWhenAtOrRelevant: true,
      maxPerTurn: 1,
      noRepeat: true
    }
  },
  channels: {
    wechat: {
      label: '微信',
      sticker: { syntax: 'whale' }
    },
    qq: {
      label: 'QQ',
      sticker: { syntax: 'onebot' }
    },
    feishu: {
      label: '飞书',
      sticker: { syntax: 'none' }
    }
  },
  overrides: {}
};

function normalizePolicy(raw) {
  const p = deepMerge(DEFAULT_POLICY, raw || {});
  p.version = 1;
  p.updatedAt = Number(p.updatedAt) || 0;
  p.global = p.global && typeof p.global === 'object' ? p.global : {};
  p.global.tone = String(p.global.tone || DEFAULT_POLICY.global.tone).slice(0, 300);
  p.global.emoji = p.global.emoji && typeof p.global.emoji === 'object' ? p.global.emoji : {};
  p.global.sticker = p.global.sticker && typeof p.global.sticker === 'object' ? p.global.sticker : {};
  p.global.emoji.enabled = p.global.emoji.enabled !== false;
  p.global.emoji.chance = clamp(p.global.emoji.chance, 0, 1);
  p.global.emoji.maxPerReply = Math.max(1, Math.min(4, Math.round(Number(p.global.emoji.maxPerReply) || 1)));
  p.global.sticker.enabled = p.global.sticker.enabled !== false;
  p.global.sticker.chance = clamp(p.global.sticker.chance, 0, 1);
  p.global.sticker.maxPerReply = Math.max(1, Math.min(2, Math.round(Number(p.global.sticker.maxPerReply) || 1)));
  p.global.sticker.seriousSuppress = p.global.sticker.seriousSuppress !== false;
  p.global.group = p.global.group && typeof p.global.group === 'object' ? p.global.group : {};
  p.global.group.listenFirst = p.global.group.listenFirst !== false;
  p.global.group.onlyWhenAtOrRelevant = p.global.group.onlyWhenAtOrRelevant !== false;
  p.global.group.maxPerTurn = Math.max(1, Math.min(3, Math.round(Number(p.global.group.maxPerTurn) || 1)));
  p.global.group.noRepeat = p.global.group.noRepeat !== false;
  p.channels = p.channels && typeof p.channels === 'object' ? p.channels : {};
  p.overrides = p.overrides && typeof p.overrides === 'object' ? p.overrides : {};
  for (const key of Object.keys(p.channels)) {
    const ch = p.channels[key];
    if (!isObj(ch)) { delete p.channels[key]; continue; }
    if (ch.emoji && typeof ch.emoji === 'object') {
      if (ch.emoji.chance !== undefined) ch.emoji.chance = clamp(ch.emoji.chance, 0, 1);
      if (ch.emoji.maxPerReply !== undefined) ch.emoji.maxPerReply = Math.max(1, Math.min(4, Math.round(Number(ch.emoji.maxPerReply) || 1)));
      if (ch.emoji.enabled !== undefined) ch.emoji.enabled = ch.emoji.enabled !== false;
    }
    if (ch.sticker && typeof ch.sticker === 'object') {
      if (ch.sticker.chance !== undefined) ch.sticker.chance = clamp(ch.sticker.chance, 0, 1);
      if (ch.sticker.maxPerReply !== undefined) ch.sticker.maxPerReply = Math.max(1, Math.min(2, Math.round(Number(ch.sticker.maxPerReply) || 1)));
      if (ch.sticker.enabled !== undefined) ch.sticker.enabled = ch.sticker.enabled !== false;
    }
  }
  return p;
}

function readPolicy() {
  const raw = readJson(POLICY_FILE, null);
  if (!raw) {
    const fresh = normalizePolicy(DEFAULT_POLICY);
    fresh.updatedAt = Date.now();
    try {
      writeJson(POLICY_FILE, fresh);
      writeJson(policyMirrorFile(), fresh);
    } catch (e) {
      if (process.env.DSH_DEBUG) console.warn('[social-reply] write default policy failed', e);
    }
    return fresh;
  }
  return normalizePolicy(raw);
}

function writePolicy(policy) {
  const out = normalizePolicy(policy);
  out.updatedAt = Date.now();
  writeJson(POLICY_FILE, out);
  // DSH 侧插件读镜像，不依赖外壳目录；保存一次即下一条生效。
  try { writeJson(policyMirrorFile(), out); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] write policy mirror failed', e);
  }
  return out;
}

// 通道能力表：true = 原生支持；'native' = 由该通道原生插件控制（工作台只读，不装第二套开关）；
// false = 不支持，策略层不生成对应标记，设置页直说「不支持」。
function capabilitiesFor(channel) {
  const key = String(channel || '').toLowerCase();
  const base = {
    text: true,
    split: true,
    sticker: 'native',
    voice: 'native',
    quote: 'native',
    mention: 'native',
    group: true,
    backgroundSend: 'native'
  };
  if (key === 'wechat') return Object.assign(base, { sticker: 'native', voice: 'native', quote: 'native' });
  // QQ 插件的语音能力取决于 OneBot 实现，不宣称已验证；设置页显示「未验证」。
  if (key === 'qq') return Object.assign(base, { sticker: 'native', voice: null, quote: 'native' });
  if (key === 'feishu') return Object.assign(base, { sticker: false, voice: 'native', quote: 'native' });
  return base;
}

function capOn(v) {
  return v === true || v === 'native' || v === 'yes';
}

// 兼容旧微信的英文别名；DSH 只会见到「开心 / 傲娇 / 炸毛」和真实分类名。
const STICKER_ALIASES = {
  happy: '开心',
  joy: '开心',
  angry: '炸毛',
  mad: '炸毛',
  cute: '傲娇',
  shy: '傲娇'
};

function normalizeStickerName(name) {
  const raw = String(name || '').trim().replace(/^\[+|\]+$/g, '').replace(/\s+/g, '');
  return STICKER_ALIASES[raw.toLowerCase()] || raw;
}

// 图库目录 -> [{name,count}]。只统计真实图片，不把空分类列给模型。
function stickerCatalog(dir) {
  const root = String(dir || '');
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] read sticker root failed: ' + root, e);
    return out;
  }
  for (const ent of ents) {
    if (!ent || !ent.isDirectory()) continue;
    const sub = path.join(root, ent.name);
    let count = 0;
    try {
      for (const f of fs.readdirSync(sub, { withFileTypes: true })) {
        if (f && f.isFile() && /\.(?:png|jpg|jpeg|gif|webp)$/i.test(f.name)) count++;
      }
    } catch (e) {
      if (process.env.DSH_DEBUG) console.warn('[social-reply] read sticker category failed: ' + sub, e);
      count = 0;
    }
    if (count > 0) out.push({ name: ent.name, count });
  }
  return out;
}

function categoriesText(categories) {
  return (categories || []).map((c) => {
    if (typeof c === 'string') return c;
    return String(c.name || '') + '(' + Number(c.count || 0) + '张)';
  }).filter(Boolean).join('、');
}

// 生成给模型看的一小段「社交回复卡」。只放当前通道真正能执行的东西：
// 贴纸不支持就不写 [[sticker:...]]，避免模型写了一个永远发不出去的标记。
function promptFragment(args) {
  const a = args || {};
  const channel = String(a.channel || '');
  const chatType = a.chatType === 'group' ? 'group' : 'private';
  const policy = a.policy || policyFor(channel, chatType, a.chatId || '');
  const caps = a.capabilities || capabilitiesFor(channel);
  const categories = Array.isArray(a.categories) ? a.categories : [];
  const catText = categoriesText(categories);
  const lines = ['【社交回复规范】'];
  lines.push('- 语气：' + String(policy.tone || DEFAULT_POLICY.global.tone));
  lines.push('- 输出：只写要发出去的消息；不要解释系统、工具、标记或本规范。');
  if (chatType === 'group') {
    const group = policy.group || {};
    lines.push('- 这是群聊：默认旁听，不要每句都接；只有被点名/@、直接问你、明确相关，或当前处于接话窗口时才回复；不确定就不说。');
    lines.push('- 群聊一次只回一条，短句；不连续补发、不刷屏、不重复别人已经说过的话。');
    lines.push('- 先判断群地址和当前话题；不要把别的群或私聊的内容带进这个群。');
    if (Number(group.maxPerTurn || 1) > 1) {
      lines.push('- 本群一轮最多回复 ' + Number(group.maxPerTurn) + ' 条。');
    }
  }

  const emoji = policy.global.emoji || {};
  if (emoji.enabled && Number(emoji.chance) > 0) {
    const pct = Math.round(Number(emoji.chance) * 100);
    const max = Math.max(1, Number(emoji.maxPerReply) || 1);
    lines.push('- emoji/颜文字：约 ' + pct + '% 的回复可以带一个与情绪匹配的 emoji；最多 ' + max + ' 个，不要每句都叠。');
  } else {
    lines.push('- 不要使用 emoji 或颜文字。');
  }

  const sticker = policy.global.sticker || {};
  if (capOn(caps.sticker) && sticker.enabled !== false && sticker.chance > 0 && catText) {
    const pct = Math.round(Number(sticker.chance) * 100);
    const max = Math.max(1, Number(sticker.maxPerReply) || 1);
    const builtin = ['开心', '傲娇', '炸毛'].filter((n) => categories.some((c) => normalizeStickerName(typeof c === 'string' ? c : c.name) === n));
    const mood = builtin.length
      ? '对方开心/分享好事/夸你 → 开心；撒娇/嘴硬/逗你 → 傲娇；损你/抬杠/惹你 → 炸毛；其它分类按名字理解。'
      : '按分类名字理解情绪，不要硬套。';
    lines.push('- 表情包可用：' + catText + '。' + mood);
    lines.push('- 表情包频率：普通闲聊约 ' + pct + '% 的回复可以带一张，每条最多 ' + max + ' 张；' +
      (sticker.seriousSuppress !== false ? '对方难过/求助/正事/严肃时不发；' : '') +
      '只在正文最后单独写 [[sticker:分类名]]，程序会剥掉标记补图，不要自己发图片或解释标记。');
  } else if (!capOn(caps.sticker)) {
    lines.push('- 本通道不支持图片表情包：不要写 [[sticker:...]]，用文字/emoji 表达。');
  } else if (sticker.enabled === false) {
    lines.push('- 本轮不发表情包：不要写 [[sticker:...]]。');
  } else {
    lines.push('- 本轮不发表情包：不要写 [[sticker:...]]。');
  }
  return '\n' + lines.join('\n') + '\n';
}

// 按通道能力裁掉模型多写的标记。微信保留标记给鲸鲸 finalize；飞书等不支持的直接删。
function filterReply(text, args) {
  const a = args || {};
  const channel = String(a.channel || '');
  const chatType = a.chatType === 'group' ? 'group' : 'private';
  const policy = a.policy || policyFor(channel, chatType, a.chatId || '');
  const caps = a.capabilities || capabilitiesFor(channel);
  const categories = Array.isArray(a.categories) ? a.categories : [];
  const allowed = categories.map((c) => normalizeStickerName(typeof c === 'string' ? c : c.name)).filter(Boolean);
  const stickers = [];
  const dropped = [];
  const max = Math.max(1, Number(policy.global.sticker && policy.global.sticker.maxPerReply) || 1);
  const stickerChance = Number(policy.global.sticker && policy.global.sticker.chance) || 0;
  const stickerEnabled = capOn(caps.sticker) && policy.global.sticker.enabled !== false && stickerChance > 0;

  let out = String(text || '');
  out = out.replace(/\[\[\s*sticker\s*:\s*([^\]\n]{1,40})\s*\]\]/gi, function (whole, name) {
    const n = normalizeStickerName(name);
    if (!stickerEnabled) { dropped.push(n); return ''; }
    if (allowed.length && allowed.indexOf(n) < 0) { dropped.push(n); return ''; }
    if (stickers.length >= max) { dropped.push(n); return ''; }
    stickers.push(n);
    return '[[' + 'sticker:' + n + ']]';
  });
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, stickers: stickers, dropped: dropped };
}

// 微信原生随机层跟通用策略对齐：显式 >0 会覆盖 persona.emojiLevel 的默认 30%；
// 关闭时把 persona 档位也关掉，避免出现「界面关了、发送层还随机补」的假开关。
function applyWechatWhale(wc, policy) {
  if (!wc || typeof wc !== 'object') return wc;
  const p = policy || readPolicy();
  if (!wc.persona || typeof wc.persona !== 'object') wc.persona = {};
  if (!wc.chat || typeof wc.chat !== 'object') wc.chat = {};
  if (!wc.sticker || typeof wc.sticker !== 'object') wc.sticker = {};
  const e = p.global.emoji || {};
  const chance = e.enabled === false ? 0 : clamp(e.chance, 0, 1);
  wc.chat.emojiChance = chance;
  if (chance <= 0) {
    wc.persona.emojiLevel = '关';
  } else if (String(wc.persona.emojiLevel || '').trim() === '关') {
    wc.persona.emojiLevel = '正常';
  }
  const s = p.global.sticker || {};
  wc.sticker.demandChance = s.enabled === false ? 0 : clamp(s.chance, 0, 1);
  return wc;
}

function policyFor(channel, chatType, chatId) {
  const base = readPolicy();
  const chKey = String(channel || '').toLowerCase();
  const ch = isObj(base.channels[chKey]) ? base.channels[chKey] : {};
  const chPatch = {};
  for (const k of Object.keys(ch)) {
    if (k === 'overrides' || k === 'label' || k === 'profile') continue;
    chPatch[k] = ch[k];
  }
  let out = deepMerge(base.global, chPatch);
  const typ = chatType === 'group' ? 'group' : 'private';
  const id = String(chatId || '');
  const candidates = [
    chKey + ':' + typ + ':' + id,
    chKey + ':' + id,
    typ + ':' + id
  ];
  for (const key of candidates) {
    if (key && base.overrides[key]) out = deepMerge(out, base.overrides[key]);
  }
  if (isObj(ch.overrides)) out = deepMerge(out, ch.overrides);
  return normalizePolicy({ global: out, channels: {}, overrides: {} });
}

// ---------- 社交会话总表 ----------

function entryOf(item) {
  const it = item && typeof item === 'object' ? item : {};
  const out = {
    scene: String(it.scene || '胡闹的大肥鱼'),
    panel: String(it.panel || ''),
    channel: String(it.channel || ''),
    account: String(it.account || ''),
    chatType: String(it.chatType || ''),
    chatId: String(it.chatId || ''),
    chatTitle: String(it.chatTitle || ''),
    title: String(it.title || it.sessionTitle || ''),
    senderName: String(it.senderName || it.lastSender || ''),
    updatedAt: Number(it.updatedAt || it.lastAt || Date.now()) || Date.now()
  };
  // 保留自动登记来源：dsh-im 绑定事件写进来的条目要能被对应 unbind 精确删除，
  // 又不能误删用户手动登记的会话。
  if (it.source) out.source = String(it.source);
  if (it.auto === true) out.auto = true;
  if (it.senderId) out.senderId = String(it.senderId);
  return out;
}

function readSessions() {
  const raw = readJson(SESSIONS_FILE, null);
  const out = { version: 1, updatedAt: 0, sessions: {} };
  if (!raw || typeof raw !== 'object') return out;
  out.updatedAt = Number(raw.updatedAt) || 0;
  const src = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : raw;
  for (const [sid, item] of Object.entries(src || {})) {
    if (!sid || !item || typeof item !== 'object') continue;
    if (!item.sessionId && !item.sessionTitle && !item.chatId && !item.title) continue;
    out.sessions[String(sid)] = entryOf(item);
  }
  return out;
}

function writeSessions(map, dshHome) {
  const out = map && typeof map === 'object' ? map : { version: 1, sessions: {} };
  out.version = 1;
  out.updatedAt = Date.now();
  if (!out.sessions || typeof out.sessions !== 'object') out.sessions = {};
  writeJson(SESSIONS_FILE, out);
  const direct = {};
  for (const [sid, item] of Object.entries(out.sessions)) {
    if (!sid || !item) continue;
    direct[sid] = Object.assign({}, item, { scene: String(item.scene || '胡闹的大肥鱼'), panel: String(item.panel || '') });
  }
  try { writeJson(mirrorFile(dshHome), direct); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] write DSH mirror failed', e);
  }
  return out;
}

function sameSession(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function mergeSessions(items, dshHome) {
  const map = readSessions();
  let changed = false;
  for (const [sid, item] of Object.entries(items || {})) {
    if (!sid || !item) continue;
    const next = entryOf(item);
    const old = map.sessions[sid];
    if (!sameSession(old, next)) {
      map.sessions[sid] = next;
      changed = true;
    }
  }
  if (changed) writeSessions(map, dshHome);
  return { changed: changed, map: map };
}

function syncFromWechatMap(chatMap, dshHome) {
  const chats = chatMap && chatMap.chats && typeof chatMap.chats === 'object' ? chatMap.chats : {};
  const items = {};
  for (const [key, c] of Object.entries(chats)) {
    if (!c || !c.sessionId) continue;
    items[String(c.sessionId)] = {
      scene: '胡闹的大肥鱼',
      panel: '',
      channel: 'wechat',
      account: String(c.account || ''),
      chatType: String(c.chatType || ''),
      chatId: String(c.chatId || key || ''),
      chatTitle: String(c.chatTitle || ''),
      title: String(c.title || ''),
      senderName: String(c.lastSender || ''),
      updatedAt: Number(c.lastAt || c.createdAt || Date.now()) || Date.now()
    };
  }
  return mergeSessions(items, dshHome);
}

function qqConfigCandidates(dshHome) {
  const home = String(dshHome || dshHomePath());
  return [
    path.join(home, 'qq-bridge.config.json'),
    path.join(os.homedir(), '.dsh', 'qq-bridge.config.json')
  ];
}

function readQqConfig(dshHome) {
  for (const file of qqConfigCandidates(dshHome)) {
    if (!fs.existsSync(file)) continue;
    const j = readJson(file, null);
    if (j && typeof j === 'object') return j;
  }
  return {};
}

// QQ 的原生路由表就是 chat -> DSH 会话；只读出来登记，不擅自改第三方配置。
function syncQqSessions(dshHome) {
  const cfg = readQqConfig(dshHome);
  const routes = cfg && cfg.routes && typeof cfg.routes === 'object' ? cfg.routes : {};
  const self = cfg && cfg.selfUin !== undefined ? String(cfg.selfUin) : '';
  const existing = readSessions().sessions;
  const items = {};
  for (const kind of ['private', 'group']) {
    const table = routes[kind];
    if (!table || typeof table !== 'object') continue;
    for (const [id, route] of Object.entries(table)) {
      if (!route || !route.sessionId) continue;
      const typ = kind === 'group' ? 'group' : 'private';
      const prefix = String(route.prefix || '');
      const chatTitle = prefix || (typ === 'group' ? 'QQ 群 ' + id : 'QQ ' + id);
      const old = existing[String(route.sessionId)];
      // 配置没变时不刷新 updatedAt，否则每 10 秒巡检都会写一次总表。
      items[String(route.sessionId)] = {
        scene: '胡闹的大肥鱼',
        panel: '',
        channel: 'qq',
        account: self,
        chatType: typ,
        chatId: String(id),
        chatTitle: chatTitle,
        title: chatTitle,
        senderName: '',
        updatedAt: old && old.channel === 'qq' ? old.updatedAt : (Number(route.updatedAt) || Date.now())
      };
    }
  }
  return mergeSessions(items, dshHome);
}

function migrateLegacyWechat(dshHome) {
  const j = readJson(LEGACY_WECHAT_MAP, null);
  if (!j || !j.chats) return { changed: false };
  return syncFromWechatMap(j, dshHome);
}

function sessionStats() {
  const map = readSessions();
  const byChannel = {};
  let total = 0;
  for (const item of Object.values(map.sessions)) {
    total++;
    const k = String(item.channel || 'other');
    byChannel[k] = (byChannel[k] || 0) + 1;
  }
  return { total: total, byChannel: byChannel, updatedAt: map.updatedAt };
}

// ---------- 观察面 ----------

function readStatus() {
  const j = readJson(STATUS_FILE, null);
  if (!j || typeof j !== 'object') return { at: 0, counts: {}, last: null };
  return {
    at: Number(j.at) || 0,
    counts: j.counts && typeof j.counts === 'object' ? j.counts : {},
    last: j.last && typeof j.last === 'object' ? j.last : null
  };
}

function recordReply(args) {
  const a = args || {};
  const st = readStatus();
  const channel = String(a.channel || 'unknown');
  st.at = Date.now();
  st.counts = st.counts && typeof st.counts === 'object' ? st.counts : {};
  const c = st.counts[channel] && typeof st.counts[channel] === 'object' ? st.counts[channel] : { replies: 0, stickers: 0, chars: 0 };
  c.replies = Number(c.replies || 0) + 1;
  c.stickers = Number(c.stickers || 0) + (Array.isArray(a.stickers) ? a.stickers.length : 0);
  c.chars = Number(c.chars || 0) + String(a.text || '').length;
  st.counts[channel] = c;
  st.last = {
    at: st.at,
    channel: channel,
    chatType: String(a.chatType || ''),
    chatId: String(a.chatId || ''),
    chars: String(a.text || '').length,
    stickers: Array.isArray(a.stickers) ? a.stickers.slice(0, 2) : [],
    dropped: Array.isArray(a.dropped) ? a.dropped.slice(0, 4) : []
  };
  try { writeJson(STATUS_FILE, st); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] write status failed', e);
  }
  return st;
}

// DSH 侧插件（dsh-social-policy）每轮注入后写这一份状态；
// 设置页只读展示，不在外壳里再实现第二次策略判断。
function readDshStatus(dshHome) {
  const j = readJson(dshStatusFile(dshHome), null);
  if (!j || typeof j !== 'object') return null;
  return {
    kind: String(j.kind || ''),
    at: Number(j.at) || 0,
    mode: String(j.mode || ''),
    sessionId: String(j.sessionId || ''),
    channel: String(j.channel || ''),
    chatType: String(j.chatType || ''),
    chatId: String(j.chatId || ''),
    title: String(j.title || ''),
    chars: Number(j.chars || 0)
  };
}

// ---------- 设置页数据面 ----------

function settingsGet(dshHome) {
  try { migrateLegacyWechat(dshHome); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] migrate legacy wechat failed', e);
  }
  try { syncQqSessions(dshHome); } catch (e) {
    if (process.env.DSH_DEBUG) console.warn('[social-reply] sync QQ sessions failed', e);
  }
  const policy = readPolicy();
  const caps = {};
  for (const key of ['wechat', 'qq', 'feishu']) caps[key] = capabilitiesFor(key);
  return {
    ok: true,
    policy: policy,
    capabilities: caps,
    sessions: sessionStats(),
    recent: Object.entries(readSessions().sessions)
      .map(([sid, item]) => Object.assign({ sessionId: sid }, item))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 8),
    status: readStatus(),
    dsh: readDshStatus(dshHome),
    paths: {
      policy: POLICY_FILE,
      policyMirror: policyMirrorFile(dshHome),
      sessions: SESSIONS_FILE,
      mirror: mirrorFile(dshHome),
      dshStatus: dshStatusFile(dshHome)
    }
  };
}

function patchOf(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const out = {};
  if (typeof raw.tone === 'string' && raw.tone.trim()) out.tone = raw.tone.trim().slice(0, 300);
  if (raw.emoji && typeof raw.emoji === 'object') {
    out.emoji = {};
    if (raw.emoji.enabled !== undefined) out.emoji.enabled = raw.emoji.enabled !== false;
    if (raw.emoji.chance !== undefined) out.emoji.chance = clamp(raw.emoji.chance, 0, 1);
    if (raw.emoji.maxPerReply !== undefined) out.emoji.maxPerReply = Math.max(1, Math.min(4, Math.round(Number(raw.emoji.maxPerReply) || 1)));
  }
  if (raw.sticker && typeof raw.sticker === 'object') {
    out.sticker = {};
    if (raw.sticker.enabled !== undefined) out.sticker.enabled = raw.sticker.enabled !== false;
    if (raw.sticker.chance !== undefined) out.sticker.chance = clamp(raw.sticker.chance, 0, 1);
    if (raw.sticker.maxPerReply !== undefined) out.sticker.maxPerReply = Math.max(1, Math.min(2, Math.round(Number(raw.sticker.maxPerReply) || 1)));
    if (raw.sticker.seriousSuppress !== undefined) out.sticker.seriousSuppress = raw.sticker.seriousSuppress !== false;
  }
  return out;
}

function settingsSave(input) {
  const patch = patchOf(input);
  const cur = readPolicy();
  const next = deepMerge(cur, { global: patch });
  const saved = writePolicy(next);
  return { ok: true, saved: true, policy: saved };
}

module.exports = {
  DEFAULT_POLICY,
  POLICY_FILE,
  SESSIONS_FILE,
  STATUS_FILE,
  policyMirrorFile,
  dshStatusFile,
  readPolicy,
  writePolicy,
  policyFor,
  capabilitiesFor,
  promptFragment,
  filterReply,
  stickerCatalog,
  applyWechatWhale,
  readSessions,
  writeSessions,
  syncFromWechatMap,
  syncQqSessions,
  migrateLegacyWechat,
  sessionStats,
  recordReply,
  readStatus,
  readDshStatus,
  settingsGet,
  settingsSave
};
