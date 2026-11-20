// QQ群聊.js —— QQ 群的旁听 + 随机接话（2026-11-19）
//
// 和微信群的差别：
//   · 微信原生鲸鲸自己有 freeChat（旁听后按概率接话）；
//   · QQ 的 dsh-onebot-channel 只有「@ 才投递」，没有旁听和随机接话。
// 这里补一层，不碰第三方插件：WS 旁听全部群消息 → 本地 jsonl（最近 600 条）
// → 通过概率/窗口/冷却/防刷屏几道闸 → 在已绑定的独立 DSH 群会话里生成一句
// → 交给外发闸门代发（同一套外发规则审过，再走闸门的 OneBot 代理）。
//
// 普通 @ 回复仍由 dsh-onebot-channel 自己处理；本服务只在「没被 @」时按概率接话，
// 不抢原生路由，也不会因为接话失败影响正常消息。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const socialReply = require('./社交回复');
// 关系权重：只给「接不接」一个可解释的小系数；缺失时按 1（不改原概率）。
let socialState = null;
try { socialState = require('./社交状态'); } catch (e) { /* 关系层没装，群聊照旧 */ }

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'QQ群聊.json');
const WORK_DIR = path.join(DATA_DIR, 'QQ群聊');
const LISTEN_DIR = path.join(WORK_DIR, '旁听');
const STATUS_FILE = path.join(WORK_DIR, '状态.json');
const LOG_FILE = path.join(WORK_DIR, '通道.log');
const LIB_FILE = path.join(__dirname, '..', '工具', '派发-公共.mjs');

const DEFAULTS = {
  enabled: true,
  listen: true,
  freeChat: false,
  chance: 0.06,
  engagedMinutes: 6,
  silentMinutes: 30,
  cooldownSec: 0,
  maxRepliesPerMinute: 15,
  addressGuard: true,
  maxChars: 70,
  replyTimeoutMs: 90000,
  // 关系权重：熟人发言更容易接，生人/反感更少接；系数在 社交关系.json 的 groupBias 里逐档可调。
  relationBias: true,
  // 媒体能力由 QQ能力.js 管；这里只保留旁听链自己的开关，避免两套配置各说各话。
  voiceListen: true
};

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) { fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
}

function safeId(v) {
  return String(v || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'unknown';
}

function nowText() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeConfig(raw) {
  const x = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  x.enabled = x.enabled !== false;
  x.listen = x.listen !== false;
  x.freeChat = x.freeChat === true;
  x.chance = clamp(x.chance, 0, 1);
  x.engagedMinutes = clamp(Math.round(Number(x.engagedMinutes) || 6), 1, 120);
  x.silentMinutes = clamp(Math.round(Number(x.silentMinutes) || 30), 1, 240);
  x.cooldownSec = clamp(Math.round(Number(x.cooldownSec) || 0), 0, 3600);
  x.maxRepliesPerMinute = clamp(Math.round(Number(x.maxRepliesPerMinute) || 15), 1, 30);
  x.addressGuard = x.addressGuard !== false;
  x.maxChars = clamp(Math.round(Number(x.maxChars) || 70), 20, 300);
  x.replyTimeoutMs = clamp(Math.round(Number(x.replyTimeoutMs) || 90000), 20000, 118000);
  x.relationBias = x.relationBias !== false;
  x.voiceListen = x.voiceListen !== false;
  return x;
}

function createService(options) {
  const opt = options || {};
  const dshHome = String(opt.dshHome || process.env.DSH_HOME || '');
  const base = String(opt.base || process.env.DSH_WEB_URL || '');
  const getToken = typeof opt.getToken === 'function' ? opt.getToken : function () { return process.env.DSH_TOKEN || ''; };
  const log = typeof opt.log === 'function' ? opt.log : function () {};
  // 外发闸门（2026-11-19）：群消息也是外发正文，发送动作统一由闸门代发；
  // 没接闸门就拒绝发送，不静默直连（测试.mjs 把直连发送字面量当违规）。
  const gate = opt.gate || null;
  // 媒体层（2026-11-19）：语音转写 / 千问表情包 / 语音合成由 QQ能力.js 提供。
  // 群聊只消费能力，不复制一套 ASR/TTS；没有接上就退回纯文字，不假装支持。
  const media = opt.media || null;

  let config = normalizeConfig(readJson(CONFIG_FILE));
  let socket = null;
  let mediaCache = { at: 0, value: null };
  let retryTimer = null;
  let groupTimer = null;
  let libCache = null;
  let chain = Promise.resolve();
  let statusTimer = 0;
  const groups = new Map();      // groupId -> { id, name, sessionId, lastAt, lastSelfAt }
  const groupStates = new Map(); // groupId -> { lastAt, lastSelfAt, lastRandomAt, randomTimes, cooldownUntil }
  const seen = new Map();
  const status = {
    ok: true,
    enabled: config.enabled,
    listen: config.listen,
    startedAt: 0,
    connected: false,
    lastEventAt: 0,
    lastError: '',
    lastDecision: null,
    lastReply: null,
    counts: { events: 0, considered: 0, replied: 0, skipped: 0, errors: 0, self: 0 },
    groups: [],
    configFile: CONFIG_FILE,
    listenDir: LISTEN_DIR,
    statusFile: STATUS_FILE
  };

  function appendLog(line) {
    const text = '[' + nowText() + '] ' + String(line || '').slice(0, 1000);
    try { fs.mkdirSync(WORK_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, text + '\r\n', 'utf8'); } catch (e) { /* 日志不影响主流程 */ }
    try { log('[qq-group] ' + text); } catch (e) { /* 外部日志失败不影响 */ }
  }

  // QQ能力.js 的状态读一次缓存 5 秒：群事件可能成串到达，不能每条都去扫图库/起 PowerShell。
  function mediaSettings() {
    if (!media || typeof media.settingsGet !== 'function') {
      return { config: { voice: false, stickers: false, voiceReply: false, voiceReplyGroups: false,
        voiceReplyChance: 0, stickerChance: 0, stickerDynamic: false }, categories: [] };
    }
    const now = Date.now();
    if (mediaCache.value && now - mediaCache.at < 1000) return mediaCache.value;
    try {
      const st = media.settingsGet() || {};
      const cfg = st.config || {};
      mediaCache = { at: now, value: {
        config: cfg,
        categories: (st.stickers && Array.isArray(st.stickers.categories)) ? st.stickers.categories : [],
        asr: st.asr || {}, tts: st.tts || {}, qwen: st.qwen || {}
      } };
      return mediaCache.value;
    } catch (e) {
      appendLog('读取媒体能力失败：' + ((e && e.message) || e));
      return { config: { voice: false, stickers: false, voiceReply: false, voiceReplyChance: 0, stickerChance: 0 }, categories: [] };
    }
  }

  function writeStatus() {
    const now = Date.now();
    if (now - statusTimer < 800) return;
    statusTimer = now;
    try { writeAtomic(STATUS_FILE, statusGet()); } catch (e) { /* 状态文件失败不影响 */ }
  }

  function readQqConfig() {
    const candidates = [
      path.join(os.homedir(), '.dsh', 'qq-bridge.config.json'),
      path.join(dshHome, 'qq-bridge.config.json')
    ];
    for (const file of candidates) {
      const j = readJson(file);
      if (j && typeof j === 'object') return j;
    }
    return {};
  }

  function groupRoutes() {
    const cfg = readQqConfig();
    const routes = cfg.routes && cfg.routes.group && typeof cfg.routes.group === 'object' ? cfg.routes.group : {};
    const out = {};
    for (const [id, v] of Object.entries(routes)) {
      out[String(id)] = v;
    }
    return out;
  }

  function managedGroupIds() {
    const cfg = readQqConfig();
    const ids = new Set();
    const routes = cfg.routes && cfg.routes.group && typeof cfg.routes.group === 'object' ? cfg.routes.group : {};
    Object.keys(routes).forEach((id) => ids.add(String(id)));
    if (Array.isArray(cfg.groupUins)) cfg.groupUins.forEach((id) => ids.add(String(id)));
    return ids;
  }

  function sessionOf(groupId) {
    const routes = groupRoutes();
    const row = routes[String(groupId)] || {};
    return String(row && row.sessionId || '');
  }

  async function oneBot(action, params) {
    const cfg = readQqConfig();
    const url = String(cfg.onebotHttp || '').trim();
    if (!url) throw new Error('QQ 协议端地址为空（qq-bridge.config.json onebotHttp）');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(cfg.token || '')
      },
      body: JSON.stringify({ action: action, params: params || {} }),
      signal: AbortSignal.timeout(8000)
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* 下面按原文报 */ }
    if (!r.ok) throw new Error('OneBot HTTP ' + r.status + '：' + text.slice(0, 120));
    if (!j || Number(j.retcode) !== 0) throw new Error('OneBot ' + action + ' 返回 retcode ' + (j && j.retcode) + '：' + text.slice(0, 120));
    return j.data === undefined ? j : j.data;
  }

  async function refreshGroups() {
    try {
      const list = await oneBot('get_group_list', {});
      const arr = Array.isArray(list) ? list : (Array.isArray(list && list.groups) ? list.groups : []);
      for (const x of arr) {
        const id = String(x && x.group_id || '');
        if (!id) continue;
        const row = groups.get(id) || { id: id, name: '', sessionId: '' };
        row.name = String(x.group_name || row.name || '');
        row.sessionId = sessionOf(id);
        groups.set(id, row);
      }
      for (const id of managedGroupIds()) {
        if (!groups.has(id)) groups.set(id, { id: id, name: '', sessionId: sessionOf(id) });
      }
      status.groups = Array.from(groups.values()).map((x) => ({
        id: x.id, name: x.name || ('QQ群 ' + x.id), sessionId: x.sessionId || '',
        managed: managedGroupIds().has(String(x.id))
      }));
      if (String(status.lastError || '').indexOf('读群列表失败') === 0) status.lastError = '';
      writeStatus();
      return { ok: true, count: groups.size };
    } catch (e) {
      status.lastError = '读群列表失败：' + ((e && e.message) || e);
      appendLog(status.lastError);
      writeStatus();
      return { ok: false, error: status.lastError };
    }
  }

  function textOf(message) {
    if (typeof message === 'string') return message;
    if (!Array.isArray(message)) {
      if (message && typeof message === 'object' && message.type) return textOf([message]);
      return String(message || '');
    }
    return message.map((seg) => {
      if (!seg || typeof seg !== 'object') return '';
      if (seg.type === 'text') return String(seg.data && seg.data.text || '');
      if (seg.type === 'at') return '@' + String(seg.data && seg.data.qq || '');
      if (seg.type === 'image') return '[图片]';
      if (seg.type === 'face') return '[表情]';
      // mface 是商城大表情：至少把名字带进旁听，不然模型看到「[表情]」分不出是哭还是笑。
      if (seg.type === 'mface') {
        const name = String((seg.data && (seg.data.summary || seg.data.emoji_name || seg.data.name)) || '').trim();
        return name ? '[表情:' + name.slice(0, 20) + ']' : '[表情包]';
      }
      if (seg.type === 'record') return '[语音]';
      return '';
    }).join('');
  }

  // 入站转写只做「群旁听」这一段；私聊仍由 dsh-onebot-channel 投递。
  // 语音失败时保留 [语音] 占位并把原因写进旁听，不把失败的语音当成没说话。
  async function describeMessage(ev) {
    let text = textOf(ev && ev.message).trim();
    if (!media || typeof media.transcribeMessage !== 'function') return text;
    const ms = mediaSettings();
    if (ms.config.voiceListen === false || !ms.config.voice) return text;
    const hasRecord = (Array.isArray(ev.message) ? ev.message : [ev.message])
      .some((seg) => seg && seg.type === 'record');
    if (!hasRecord) return text;
    const tr = await media.transcribeMessage(ev.message);
    if (tr && tr.ok && tr.text) {
      text = text.replace('[语音]', '[语音转写] ' + String(tr.text).slice(0, 500));
    } else if (tr && tr.error) {
      text = text.replace('[语音]', '[语音]（转写失败：' + String(tr.error).slice(0, 120) + '）');
    }
    return text.trim();
  }

  function atInfo(message, selfUin) {
    let atMe = false;
    let atOther = false;
    const segs = Array.isArray(message) ? message : (message && message.type ? [message] : []);
    for (const seg of segs) {
      if (!seg || seg.type !== 'at') continue;
      const qq = String(seg.data && seg.data.qq || '');
      if (qq === String(selfUin)) atMe = true;
      else if (qq) atOther = true;
    }
    return { atMe: atMe, atOther: atOther };
  }

  function groupName(groupId) {
    const row = groups.get(String(groupId));
    return String(row && row.name || ('QQ群 ' + groupId));
  }

  function readListenRecords(groupId, limit) {
    const file = path.join(LISTEN_DIR, safeId(groupId) + '.jsonl');
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const out = [];
      for (const line of lines.slice(-Math.max(1, Number(limit) || 20))) {
        try { out.push(JSON.parse(line)); } catch (e) { /* 单行坏数据跳过 */ }
      }
      return out;
    } catch (e) { return []; }
  }

  function appendListenRecord(rec) {
    try {
      fs.mkdirSync(LISTEN_DIR, { recursive: true });
      const file = path.join(LISTEN_DIR, safeId(rec.groupId) + '.jsonl');
      fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
      // 只保留最近 600 条；超过 200KB 才整理，避免每条消息都读整文件。
      let st = null;
      try { st = fs.statSync(file); } catch (e) { return; }
      if (st.size > 200 * 1024) {
        const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(file, all.slice(-600).join('\n') + '\n', 'utf8');
      }
    } catch (e) { appendLog('旁听落盘失败：' + ((e && e.message) || e)); }
  }

  function stateOf(groupId) {
    const id = String(groupId);
    let s = groupStates.get(id);
    if (!s) {
      s = { lastAt: 0, lastSelfAt: 0, lastRandomAt: 0, randomTimes: [], cooldownUntil: 0 };
      groupStates.set(id, s);
    }
    return s;
  }

  // 「旁听 → 该不该接」的唯一判据。返回 { ok, reason, chance, roll }。
  function decide(groupId, rec, atMe, atOther) {
    const id = String(groupId);
    const s = stateOf(id);
    const now = rec.at || Date.now();
    const prevAt = s.lastAt;
    const quietGap = prevAt > 0 && (now - prevAt) > config.silentMinutes * 60000;
    const engagedWindow = !prevAt || (now - prevAt) <= config.engagedMinutes * 60000;
    s.lastAt = now;
    if (quietGap) {
      s.cooldownUntil = 0;
      s.randomTimes = [];
      return { ok: false, reason: 'quiet_gap（群刚安静下来，第一条不接）', chance: config.chance, roll: null };
    }
    if (!engagedWindow) {
      return { ok: false, reason: 'engaged_expired（上一条消息离现在超过接话窗口）', chance: config.chance, roll: null };
    }
    if (!config.freeChat) return { ok: false, reason: 'freeChat 关' };
    if (atMe) return { ok: false, reason: 'at_me（交给原生 @ 回复）' };
    if (config.addressGuard && atOther) return { ok: false, reason: 'at_other（群地址保护）' };
    if (s.lastRandomAt && now - s.lastRandomAt > 60000) s.randomTimes = [];
    if (s.randomTimes.length >= config.maxRepliesPerMinute) return { ok: false, reason: 'rate（每分钟上限）' };
    if (s.cooldownUntil && now < s.cooldownUntil) return { ok: false, reason: 'cooldown' };
    // 关系权重：把「这个人是谁」折成一个 0.5–1.5 的系数，原概率和上限仍由本配置控制。
    let bias = 1;
    let biasStage = '';
    let moodFactor = 1;
    let moodLabel = '';
    try {
      if (config.relationBias && socialState && typeof socialState.groupBiasInfo === 'function') {
        const info = socialState.groupBiasInfo({
          channel: 'qq',
          chatType: 'group',
          chatId: id,
          senderId: rec.senderId || '',
          senderName: rec.senderName || ''
        });
        bias = Number(info && info.bias) || 1;
        biasStage = info && info.stage ? info.stage.key : 'stranger';
      }
    } catch (e) { bias = 1; }
    // 情绪权重：她此刻不想说话/很兴奋，都会改变接话概率；仍夹在 0–1 内。
    try {
      const plan = socialReply.moodPlanFor({ maxChars: config.maxChars });
      moodFactor = Number(plan && plan.groupFactor) || 1;
      moodLabel = plan && plan.visible ? plan.label : '';
    } catch (e) { moodFactor = 1; }
    const chance = clamp(config.chance * bias * moodFactor, 0, 1);
    const roll = Math.random();
    if (roll >= chance) return { ok: false, reason: 'chance', chance: chance, bias: bias, stage: biasStage, mood: moodLabel, moodFactor: moodFactor, roll: roll };
    return { ok: true, reason: 'hit', chance: chance, bias: bias, stage: biasStage, mood: moodLabel, moodFactor: moodFactor, roll: roll };
  }

  // 模型允许写 [[sticker:情绪]]：正文剥掉标记，标记单独交给发送层补图。
  // 旧的 cleanReply 继续保留为「只取正文」，测试和别处调用不会因为新增返回值而坏掉。
  function parseReply(text, marker, plan) {
    let t = String(text || '').replace(marker, '').trim();
    if (!t) return { text: '', sticker: '', pass: false };
    if (/^(?:\[?(?:不接|pass|跳过|沉默)\]?|pass)$/i.test(t)) return { text: '', sticker: '', pass: true };
    if (t.length <= 16 && /(不接|pass|跳过|沉默)/i.test(t)) return { text: '', sticker: '', pass: true };
    t = t.replace(/^["“”'「」『』]+|["“”'「」『』]+$/g, '').trim();
    t = t.replace(/@[^\s]+/g, '').trim();
    let sticker = '';
    t = t.replace(/\[\[\s*sticker\s*:\s*([^\]\n]{1,24})\s*\]\]/gi, function (whole, name) {
      if (!sticker) sticker = String(name || '').trim();
      return '';
    }).trim();
    // 经典表情标记在随机接话链没有工具可用；剥掉，别把标记当正文发出去。
    t = t.replace(/\[表情:[^\]]+\]/g, '').trim();
    if (/^[（(][^）)]{0,16}[）)]$/.test(t)) return { text: '', sticker: '', pass: true };
    t = t.replace(/\s+/g, ' ');
    // 情绪联动在发送前按同一张表再收一次：emoji=0 先删，再按句数 / 字数截。
    if (plan && plan.emojiFactor === 0) t = socialReply.stripEmoji(t);
    t = socialReply.limitReplyText(t, plan || { maxChars: config.maxChars, maxSentences: 2 });
    return { text: t, sticker: sticker, pass: false };
  }

  function cleanReply(text, marker) {
    return parseReply(text, marker).text;
  }

  function gateReply(text, rec) {
    if (!gate) return { ok: true, text: text };
    try {
      const v = gate.check(text, {
        channel: 'qq',
        chatType: 'group',
        chatId: String(rec.groupId || ''),
        sender: rec.senderName || '',
        direction: 'out'
      });
      if (!v || v.verdict === 'block') {
        return { ok: false, reason: 'outbound_blocked', fallback: (v && v.fallback) || '' };
      }
      return { ok: true, text: String((v && v.text) || text) };
    } catch (e) {
      return { ok: false, reason: 'gate_error: ' + ((e && e.message) || e) };
    }
  }

  function buildPrompt(groupId, rec, currentId, moodPlan) {
    const records = readListenRecords(groupId, 24).filter((r) => r && r.text && (r.msgId || '') !== currentId);
    // 旁听记录和「现在谁说」都优先用关系档案里的称呼（例如「胡闹」），不再叫微信/QQ 原显示名。
    function shownName(r) {
      const raw = (r && r.senderName) || '群友';
      try {
        if (socialState && typeof socialState.displayNameFor === 'function') {
          return socialState.displayNameFor({
            channel: 'qq', chatType: 'group', chatId: groupId,
            senderId: (r && r.senderId) || '', senderName: raw
          }) || raw;
        }
      } catch (e) { /* 称呼层失败就退回原显示名 */ }
      return raw;
    }
    const recent = records.slice(-20).map((r) => shownName(r) + '：' + String(r.text).slice(0, 240));
    const speakerName = shownName(rec);
    const policy = socialReply.policyFor('qq', 'group', groupId);
    const plan = moodPlan || socialReply.moodPlanFor({ maxChars: config.maxChars });
    const ms = mediaSettings();
    const cats = ms.categories || [];
    // 随机接话现在允许带表情包（有图库且开关打开时）；语音由发送层按概率自动合成，
    // 不让模型写 [[voice]]，避免模型以为写个标记就会替它发声。
    const stickerOn = ms.config.stickers === true && Number(ms.config.stickerChance) > 0 && cats.length > 0;
    // 把 QQ 媒体层的频率覆盖到通用策略里：界面上的 10% 就是模型看到的 10%，
    // 不再出现「界面 10%、模型按默认 30% 写标记」的两套频率。
    const effectivePolicy = JSON.parse(JSON.stringify(policy || {}));
    if (!effectivePolicy.global || typeof effectivePolicy.global !== 'object') effectivePolicy.global = {};
    if (!effectivePolicy.global.sticker || typeof effectivePolicy.global.sticker !== 'object') effectivePolicy.global.sticker = {};
    effectivePolicy.global.sticker.enabled = stickerOn;
    effectivePolicy.global.sticker.chance = stickerOn ? Number(ms.config.stickerChance) : 0;
    effectivePolicy.global.sticker.maxPerReply = Math.max(1, Number(ms.config.stickerMaxPerReply) || 1);
    const frag = socialReply.promptFragment({
      channel: 'qq',
      chatType: 'group',
      chatId: groupId,
      policy: effectivePolicy,
      capabilities: { sticker: stickerOn && plan.stickerAllowed !== false, voice: plan.voiceAllowed !== false, image: false },
      categories: cats,
      dynamicSticker: stickerOn && ms.config.stickerDynamic === true,
      moodPlan: plan,
      maxChars: plan.maxChars || config.maxChars,
      senderId: rec.senderId || '',
      senderName: speakerName,
      text: rec.text || ''
    });
    const voiceOn = ms.config.voiceReply === true && ms.config.voiceReplyGroups === true && Number(ms.config.voiceReplyChance) > 0 && plan.voiceAllowed !== false;
    const voiceLine = voiceOn
      ? '\n语音：这条有可能被程序合成为语音发出去；你只写正常正文，不要写 [[voice]] 或解释语音。'
      : '';
    return '（QQ群聊「' + groupName(groupId) + '」· 旁听）\n'
      + (recent.length ? '[最近群聊旁听记录]\n' + recent.join('\n') + '\n' : '')
      + '（现在，' + speakerName + ' 说：' + String(rec.text).slice(0, 500) + '）\n\n'
      + '[通道] 你在群里旁听。现在如果适合接一句，就只输出要发到群里的那一句话（' + (plan.maxChars || config.maxChars) + ' 字内）；'
      + '不要 @ 人，不要解释系统或工具，不要写小作文；如果不适合接，只输出「[不接]」。'
      + voiceLine
      + frag;
  }

  async function dshLib() {
    if (libCache) return libCache;
    process.env.DSH_HOME = dshHome;
    if (base) process.env.DSH_WEB_URL = base;
    libCache = await import(pathToFileURL(LIB_FILE).href);
    return libCache;
  }

  async function callGroupSession(groupId, rec, marker, moodPlan) {
    const sid = sessionOf(groupId);
    if (!sid) throw new Error('群还没绑独立 DSH 会话（先在 QQ 路由里接入群号）');
    const token = String(getToken() || '');
    if (!token) throw new Error('壳还没拿到引擎 token（等引擎就绪后再试）');
    process.env.DSH_TOKEN = token;
    const lib = await dshLib();
    const cookie = await lib.getCookie();
    await lib.promptSession(sid, buildPrompt(groupId, rec, rec.msgId, moodPlan), cookie);
    const deadline = Date.now() + config.replyTimeoutMs;
    let file = lib.transcriptOf(sid);
    let lastSize = -1;
    let markerTurn = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (!file) file = lib.transcriptOf(sid);
      if (!file) continue;
      let stat = null;
      try { stat = fs.statSync(file); } catch (e) { continue; }
      if (stat.size === lastSize) continue;
      lastSize = stat.size;
      const events = lib.readEvents(file);
      if (!events) continue;
      if (!markerTurn) markerTurn = findMarkerTurn(events, marker);
      if (markerTurn && events.some((e) => e.type === 'turn/end' && Number(e.data && e.data.turn) === markerTurn)) {
        return { text: lib.finalTextOf(events, markerTurn), turn: markerTurn, timeout: false, sessionId: sid };
      }
    }
    return { text: '', turn: markerTurn, timeout: true, sessionId: sid };
  }

  function enqueueReply(groupId, rec) {
    const s = stateOf(groupId);
    if (s.busy) return false;
    s.busy = true;
    chain = chain.then(async function () {
      const started = Date.now();
      const marker = '〔QQG#' + crypto.randomBytes(4).toString('hex') + '〕';
      const moodPlan = socialReply.moodPlanFor({ maxChars: config.maxChars, maxSentences: 2 });
      let generated = null;
      try {
        generated = await callGroupSession(groupId, rec, marker, moodPlan);
      } catch (e) {
        status.counts.errors++;
        status.lastError = '生成失败：' + ((e && e.message) || e);
        status.lastReply = { at: Date.now(), groupId: groupId, ok: false, reason: status.lastError };
        appendLog(status.lastError);
        return;
      }
      const parsed = parseReply(generated && generated.text, marker, moodPlan);
      if (!parsed.text && !parsed.sticker) {
        status.counts.skipped++;
        status.lastReply = { at: Date.now(), groupId: groupId, ok: false, reason: generated && generated.timeout ? 'timeout' : 'empty_or_pass' };
        appendLog('未接话 group=' + groupId + ' timeout=' + !!(generated && generated.timeout));
        return;
      }
      // 表情包 / 语音都从同一份媒体配置读，界面关掉就立刻退回文字。
      const ms = mediaSettings();
      let imageFile = '';
      let stickerLabel = '';
      const stickerChance = clamp(Number(ms.config.stickerChance) * Number(moodPlan.stickerFactor || 1), 0, 1);
      // 模型可以提议表情，但最终频率仍由界面控制：情绪系数再乘一层；
      // 心情沉重时 plan.stickerAllowed=false，模型写了也会被丢弃。
      if (parsed.sticker && (moodPlan.stickerAllowed === false || Math.random() >= stickerChance)) parsed.sticker = '';
      if (parsed.sticker && ms.config.stickers === true && stickerChance > 0) {
        try {
          const sticker = media && typeof media.ensureSticker === 'function'
            ? await media.ensureSticker(parsed.sticker, (rec.text || '').slice(0, 600))
            : null;
          if (sticker && sticker.file && fs.existsSync(sticker.file)) {
            imageFile = sticker.file;
            stickerLabel = sticker.label || parsed.sticker;
          } else {
            appendLog('表情包没取到 group=' + groupId + ' label=' + parsed.sticker + '（本条只发文字）');
          }
        } catch (e) {
          appendLog('表情包失败 group=' + groupId + '：' + ((e && e.message) || e));
        }
      }
      let voiceFile = '';
      let voiceProvider = '';
      const voiceChance = clamp(Number(ms.config.voiceReplyChance) * Number(moodPlan.voiceFactor || 1), 0, 1);
      if (ms.config.voiceReply === true && ms.config.voiceReplyGroups === true && moodPlan.voiceAllowed !== false && voiceChance > 0) {
        const roll = Math.random();
        if (roll < voiceChance) {
          try {
            const voice = media && typeof media.synthesizeVoice === 'function'
              ? await media.synthesizeVoice(parsed.text)
              : null;
            if (voice && voice.file && fs.existsSync(voice.file)) {
              voiceFile = voice.file;
              voiceProvider = String(voice.provider || '');
            } else {
              appendLog('语音合成没成功 group=' + groupId + '：' + ((voice && voice.error) || '未知原因'));
            }
          } catch (e) {
            appendLog('语音合成失败 group=' + groupId + '：' + ((e && e.message) || e));
          }
        }
      }
      try {
        const sent = gate && typeof gate.sendGroupMessage === 'function'
          ? await gate.sendGroupMessage(groupId, { text: parsed.text, imageFile: imageFile, voiceFile: voiceFile })
          : (gate && typeof gate.sendGroupText === 'function'
            ? await gate.sendGroupText(groupId, parsed.text)
            : { ok: false, error: '外发闸门未接线，拒绝直连发送' });
        if (!sent || sent.ok !== true) {
          throw new Error(sent && sent.blocked
            ? '闸门拦下（规则 ' + ((sent.rules || []).join('|') || '未知') + '）'
            : ((sent && sent.error) || '发送失败'));
        }
        s.lastRandomAt = Date.now();
        s.cooldownUntil = s.lastRandomAt + config.cooldownSec * 1000;
        s.randomTimes = s.randomTimes.filter((t) => s.lastRandomAt - t < 60000);
        s.randomTimes.push(s.lastRandomAt);
        status.counts.replied++;
        status.lastError = '';
        status.lastReply = {
          at: s.lastRandomAt, groupId: groupId, ok: true, text: String(sent.text || parsed.text),
          sticker: stickerLabel || '', voice: !!voiceFile, voiceProvider: voiceProvider,
          mood: moodPlan.visible ? moodPlan.label : '', moodPlan: {
            maxChars: moodPlan.maxChars, maxSentences: moodPlan.maxSentences,
            emojiFactor: moodPlan.emojiFactor, stickerFactor: moodPlan.stickerFactor,
            voiceFactor: moodPlan.voiceFactor, groupFactor: moodPlan.groupFactor
          },
          mediaError: String(sent.mediaError || ''),
          ms: Date.now() - started, messageId: String(sent.messageId || '')
        };
        if (sent.mediaError) appendLog('正文已发，媒体没发出去 group=' + groupId + '：' + sent.mediaError);
        appendLog('接话 group=' + groupId + ' len=' + parsed.text.length
          + ' sticker=' + (stickerLabel || '-') + ' voice=' + (voiceFile ? '1' : '0')
          + ' voiceProvider=' + (voiceProvider || '-')
          + ' mood=' + (moodPlan.visible ? moodPlan.label : '-')
          + ' maxChars=' + moodPlan.maxChars
          + ' stickerChance=' + stickerChance.toFixed(2)
          + ' voiceChance=' + voiceChance.toFixed(2)
          + ' ms=' + (Date.now() - started));
      } catch (e) {
        status.counts.errors++;
        status.lastError = '发送失败：' + ((e && e.message) || e);
        status.lastReply = { at: Date.now(), groupId: groupId, ok: false, reason: status.lastError };
        appendLog(status.lastError);
      }
    }).catch((e) => {
      status.counts.errors++;
      status.lastError = '接话任务异常：' + ((e && e.message) || e);
      appendLog(status.lastError);
    }).finally(function () { s.busy = false; writeStatus(); });
    return true;
  }

  async function handleEvent(ev) {
    if (!ev || (ev.post_type !== 'message' && ev.post_type !== 'message_sent')) return;
    if (String(ev.message_type || '') !== 'group') return;
    const groupId = String(ev.group_id || '');
    if (!groupId || !config.listen) return;
    if (!managedGroupIds().has(groupId)) return;
    const qqCfg = readQqConfig();
    const selfUin = String(ev.self_id || qqCfg.selfUin || '');
    const userId = String(ev.user_id || '');
    const out = String(ev.post_type) === 'message_sent' || (selfUin && userId === selfUin);
    const rawText = textOf(ev.message).trim();
    if (!rawText) return;
    const msgId = String(ev.message_id || '');
    const key = groupId + '|' + (msgId || (userId + '|' + rawText));
    const old = seen.get(key);
    const now = Date.now();
    if (old && now - old < 300000) return;
    seen.set(key, now);
    if (seen.size > 2000) {
      for (const [k, v] of seen) if (now - v > 300000) seen.delete(k);
    }
    // 语音转写放在去重之后、落旁听之前：同一条语音不会因为重连被识别两遍。
    // 自己发出去的语音不再转写（message_sent 只用于记「我刚说过话」和防刷屏）。
    const text = out ? rawText : await describeMessage(ev);
    if (!text) return;
    const ai = atInfo(ev.message, selfUin);
    const senderName = out ? '我' : String((ev.sender && (ev.sender.card || ev.sender.nickname)) || ('群友 ' + userId));
    const rec = {
      groupId: groupId,
      groupName: groupName(groupId),
      senderId: userId,
      senderName: senderName,
      text: text,
      at: now,
      msgId: msgId,
      direction: out ? 'out' : 'in'
    };
    appendListenRecord(rec);
    status.counts.events++;
    status.lastEventAt = now;
    const s = stateOf(groupId);
    if (out) {
      s.lastSelfAt = now;
      status.counts.self++;
      writeStatus();
      return;
    }
    if (!config.freeChat) return;
    status.counts.considered++;
    const decision = decide(groupId, rec, ai.atMe, ai.atOther);
    status.lastDecision = {
      at: now, groupId: groupId, sender: senderName, text: text.slice(0, 80),
      ok: decision.ok, reason: decision.reason,
      chancePct: Math.round((decision.chance || config.chance) * 1000) / 10,
      roll: decision.roll === null || decision.roll === undefined ? null : Math.round(decision.roll * 1000) / 1000,
      relationBias: decision.bias, relationStage: decision.stage,
      mood: decision.mood || '', moodFactor: decision.moodFactor
    };
    writeStatus();
    if (!decision.ok) {
      status.counts.skipped++;
      return;
    }
    if (!sessionOf(groupId)) {
      status.counts.skipped++;
      status.lastDecision = Object.assign({}, status.lastDecision, {
        ok: false, reason: 'no_session（群还没绑独立 DSH 会话）'
      });
      writeStatus();
      return;
    }
    enqueueReply(groupId, rec);
  }

  function connect() {
    if (!config.enabled) {
      status.lastError = 'QQ 群聊服务已关闭';
      writeStatus();
      return { ok: false, skipped: 'disabled' };
    }
    const cfg = readQqConfig();
    const wsUrl = String(cfg.wsUrl || '');
    const wsToken = String(cfg.wsToken || '');
    if (cfg.wsEnabled === false) {
      status.lastError = 'wsEnabled=false：只能靠旁听文件，实时接话不启动';
      writeStatus();
      return { ok: false, skipped: status.lastError };
    }
    if (!wsUrl || !wsToken) {
      status.lastError = '没配 wsUrl / wsToken，无法旁听 QQ 群';
      writeStatus();
      return { ok: false, skipped: status.lastError };
    }
    try {
      const u = new URL(wsUrl);
      if (u.searchParams.get('access_token') === null) u.searchParams.set('access_token', wsToken);
      const target = u.toString();
      socket = new WebSocket(target);
      socket.onopen = function () {
        status.connected = true;
        status.lastError = '';
        appendLog('已连上 SnowLuma WS，开始旁听 QQ 群');
        writeStatus();
      };
      socket.onmessage = function (event) {
        let data = null;
        try { data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch (e) { return; }
        Promise.resolve(handleEvent(data)).catch(function (e) {
          status.counts.errors++;
          status.lastError = '处理群消息失败：' + ((e && e.message) || e);
          appendLog(status.lastError);
        });
      };
      socket.onerror = function () {
        status.connected = false;
        status.lastError = 'WS 连接出错';
        writeStatus();
      };
      socket.onclose = function () {
        status.connected = false;
        socket = null;
        writeStatus();
        if (config.enabled) {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(function () { connect(); }, 10000);
        }
      };
      appendLog('开始连接 SnowLuma WS 旁听 QQ 群');
      return { ok: true, connected: true };
    } catch (e) {
      status.connected = false;
      status.lastError = 'WS 建连失败：' + ((e && e.message) || e);
      appendLog(status.lastError);
      writeStatus();
      return { ok: false, error: status.lastError };
    }
  }

  function start() {
    config = normalizeConfig(readJson(CONFIG_FILE));
    status.enabled = config.enabled;
    status.listen = config.listen;
    status.startedAt = Date.now();
    if (media && typeof media.cleanupVoice === 'function') {
      try { media.cleanupVoice(); } catch (e) { appendLog('清理旧语音失败：' + ((e && e.message) || e)); }
    }
    if (!config.enabled) {
      status.lastError = 'QQ 群聊服务已关闭';
      writeStatus();
      return { ok: true, started: false, status: statusGet() };
    }
    refreshGroups().catch(function (e) { appendLog('刷新群列表失败：' + ((e && e.message) || e)); });
    if (groupTimer) clearInterval(groupTimer);
    groupTimer = setInterval(function () {
      refreshGroups().catch(function (e) { appendLog('定时刷新群列表失败：' + ((e && e.message) || e)); });
    }, 5 * 60 * 1000);
    const r = connect();
    writeStatus();
    return Object.assign({ started: true }, r, { status: statusGet() });
  }

  function stop() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (groupTimer) { clearInterval(groupTimer); groupTimer = null; }
    if (socket) {
      try {
        socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
        socket.close();
      } catch (e) { /* 已关闭 */ }
      socket = null;
    }
    status.connected = false;
    writeStatus();
    return { ok: true };
  }

  function settingsGet() {
    return {
      ok: true,
      enabled: config.enabled,
      listen: config.listen,
      freeChat: config.freeChat,
      chancePct: Math.round(config.chance * 1000) / 10,
      engagedMinutes: config.engagedMinutes,
      silentMinutes: config.silentMinutes,
      cooldownSec: config.cooldownSec,
      maxRepliesPerMinute: config.maxRepliesPerMinute,
      addressGuard: config.addressGuard,
      maxChars: config.maxChars,
      voiceListen: config.voiceListen
    };
  }

  function settingsSave(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = Object.assign({}, config);
    if (Object.prototype.hasOwnProperty.call(p, 'enabled')) next.enabled = p.enabled !== false;
    if (Object.prototype.hasOwnProperty.call(p, 'freeChat')) next.freeChat = p.freeChat === true;
    if (Object.prototype.hasOwnProperty.call(p, 'chancePct') || Object.prototype.hasOwnProperty.call(p, 'chance')) {
      const raw = Object.prototype.hasOwnProperty.call(p, 'chancePct') ? p.chancePct : (Number(p.chance) * 100);
      next.chance = clamp(Number(raw) / 100, 0, 1);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'engagedMinutes')) next.engagedMinutes = clamp(Math.round(Number(p.engagedMinutes) || 6), 1, 120);
    if (Object.prototype.hasOwnProperty.call(p, 'silentMinutes')) next.silentMinutes = clamp(Math.round(Number(p.silentMinutes) || 30), 1, 240);
    if (Object.prototype.hasOwnProperty.call(p, 'cooldownSec')) next.cooldownSec = clamp(Math.round(Number(p.cooldownSec) || 0), 0, 3600);
    if (Object.prototype.hasOwnProperty.call(p, 'maxRepliesPerMinute')) next.maxRepliesPerMinute = clamp(Math.round(Number(p.maxRepliesPerMinute) || 15), 1, 30);
    if (Object.prototype.hasOwnProperty.call(p, 'addressGuard')) next.addressGuard = p.addressGuard !== false;
    if (Object.prototype.hasOwnProperty.call(p, 'maxChars')) next.maxChars = clamp(Math.round(Number(p.maxChars) || 70), 20, 300);
    if (Object.prototype.hasOwnProperty.call(p, 'voiceListen')) next.voiceListen = p.voiceListen !== false;
    config = normalizeConfig(next);
    writeAtomic(CONFIG_FILE, config);
    status.enabled = config.enabled;
    status.listen = config.listen;
    writeStatus();
    return settingsGet();
  }

  function statusGet() {
    return Object.assign({}, status, {
      settings: settingsGet(),
      media: mediaSettings(),
      groups: Array.from(groups.values()).map((x) => ({
        id: x.id,
        name: x.name || ('QQ群 ' + x.id),
        sessionId: x.sessionId || sessionOf(x.id),
        managed: managedGroupIds().has(String(x.id))
      })),
      counts: Object.assign({}, status.counts)
    });
  }

  return {
    start: start,
    stop: stop,
    statusGet: statusGet,
    settingsGet: settingsGet,
    settingsSave: settingsSave,
    refreshGroups: refreshGroups,
    // 给本地测试 / 后续诊断用，不对外暴露 HTTP。
    _test: { handleEvent: handleEvent, decide: decide, cleanReply: cleanReply, parseReply: parseReply, buildPrompt: buildPrompt, configFile: CONFIG_FILE }
  };
}

function findMarkerTurn(events, marker) {
  let idx = -1;
  for (let i = 0; i < (events || []).length; i++) {
    try {
      if (JSON.stringify(events[i] && events[i].data || {}).indexOf(marker) >= 0) { idx = i; break; }
    } catch (e) { /* 不可序列化事件跳过 */ }
  }
  if (idx < 0) return 0;
  for (let i = idx; i < events.length; i++) {
    const d = events[i] && events[i].data;
    if (!d) continue;
    const n = Number(d.turn);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

module.exports = { createService: createService, CONFIG_FILE: CONFIG_FILE, DEFAULT_CONFIG: DEFAULTS };
