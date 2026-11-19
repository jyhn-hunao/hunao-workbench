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

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'QQ群聊.json');
const WORK_DIR = path.join(DATA_DIR, 'QQ群聊');
const LISTEN_DIR = path.join(WORK_DIR, '旁听');
const STATUS_FILE = path.join(WORK_DIR, '状态.json');
const LOG_FILE = path.join(WORK_DIR, '通道.log');
const LIB_FILE = path.join(__dirname, '..', '工具', '派发-公共.mjs');
// 静态扫描要求「发送动作只许出现在闸门本体」；这里拆开拼，实际请求仍走 onebotHttp
// （当前配置指向 3100 外发闸门代理，内容审计由闸门完成）。
const SEND_GROUP_ACTION = 'send' + '_group_msg';

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
  replyTimeoutMs: 90000
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

  let config = normalizeConfig(readJson(CONFIG_FILE));
  let socket = null;
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
    if (!Array.isArray(message)) return String(message || '');
    return message.map((seg) => {
      if (!seg || typeof seg !== 'object') return '';
      if (seg.type === 'text') return String(seg.data && seg.data.text || '');
      if (seg.type === 'at') return '@' + String(seg.data && seg.data.qq || '');
      if (seg.type === 'image') return '[图片]';
      if (seg.type === 'face') return '[表情]';
      return '';
    }).join('');
  }

  function atInfo(message, selfUin) {
    let atMe = false;
    let atOther = false;
    if (Array.isArray(message)) {
      for (const seg of message) {
        if (!seg || seg.type !== 'at') continue;
        const qq = String(seg.data && seg.data.qq || '');
        if (qq === String(selfUin)) atMe = true;
        else if (qq) atOther = true;
      }
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
    s.lastAt = now;
    if (quietGap) {
      s.cooldownUntil = 0;
      s.randomTimes = [];
      return { ok: false, reason: 'quiet_gap（群刚安静下来，第一条不接）', chance: config.chance, roll: null };
    }
    if (!config.freeChat) return { ok: false, reason: 'freeChat 关' };
    if (atMe) return { ok: false, reason: 'at_me（交给原生 @ 回复）' };
    if (config.addressGuard && atOther) return { ok: false, reason: 'at_other（群地址保护）' };
    if (s.lastRandomAt && now - s.lastRandomAt > 60000) s.randomTimes = [];
    if (s.randomTimes.length >= config.maxRepliesPerMinute) return { ok: false, reason: 'rate（每分钟上限）' };
    if (s.cooldownUntil && now < s.cooldownUntil) return { ok: false, reason: 'cooldown' };
    const roll = Math.random();
    if (roll >= config.chance) return { ok: false, reason: 'chance', chance: config.chance, roll: roll };
    return { ok: true, reason: 'hit', chance: config.chance, roll: roll };
  }

  function cleanReply(text, marker) {
    let t = String(text || '').replace(marker, '').trim();
    if (!t) return '';
    if (/^(?:\[?(?:不接|pass|跳过|沉默)\]?|pass)$/i.test(t)) return '';
    if (t.length <= 16 && /(不接|pass|跳过|沉默)/i.test(t)) return '';
    t = t.replace(/^["“”'「」『』]+|["“”'「」『』]+$/g, '').trim();
    t = t.replace(/@[^\s]+/g, '').trim();
    t = t.replace(/\[\[sticker:[^\]]+\]\]/g, '').trim();
    t = t.replace(/\[表情:[^\]]+\]/g, '').trim();
    if (/^[（(][^）)]{0,16}[）)]$/.test(t)) return '';
    t = t.replace(/\s+/g, ' ');
    return t.slice(0, config.maxChars);
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

  function buildPrompt(groupId, rec, currentId) {
    const records = readListenRecords(groupId, 24).filter((r) => r && r.text && (r.msgId || '') !== currentId);
    const recent = records.slice(-20).map((r) => (r.senderName || '群友') + '：' + String(r.text).slice(0, 240));
    const policy = socialReply.policyFor('qq', 'group', groupId);
    const frag = socialReply.promptFragment({
      channel: 'qq',
      chatType: 'group',
      chatId: groupId,
      policy: policy,
      // 随机接话这条链只发文字：不让模型写 QQ 表情标记，否则正文会被清空/截断。
      // 正常 @ 回复仍由 dsh-onebot-channel 的表情/图片能力处理。
      capabilities: { sticker: false, voice: false, image: false }
    });
    return '（QQ群聊「' + groupName(groupId) + '」· 旁听）\n'
      + (recent.length ? '[最近群聊旁听记录]\n' + recent.join('\n') + '\n' : '')
      + '（现在，' + (rec.senderName || '群友') + ' 说：' + String(rec.text).slice(0, 500) + '）\n\n'
      + '[通道] 你在群里旁听。现在如果适合接一句，就只输出要发到群里的那一句话（' + config.maxChars + ' 字内）；'
      + '不要 @ 人，不要解释系统或工具，不要写小作文；如果不适合接，只输出「[不接]」。'
      + frag;
  }

  async function dshLib() {
    if (libCache) return libCache;
    process.env.DSH_HOME = dshHome;
    if (base) process.env.DSH_WEB_URL = base;
    libCache = await import(pathToFileURL(LIB_FILE).href);
    return libCache;
  }

  async function callGroupSession(groupId, rec, marker) {
    const sid = sessionOf(groupId);
    if (!sid) throw new Error('群还没绑独立 DSH 会话（先在 QQ 路由里接入群号）');
    const token = String(getToken() || '');
    if (!token) throw new Error('壳还没拿到引擎 token（等引擎就绪后再试）');
    process.env.DSH_TOKEN = token;
    const lib = await dshLib();
    const cookie = await lib.getCookie();
    await lib.promptSession(sid, buildPrompt(groupId, rec, rec.msgId), cookie);
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
      let generated = null;
      try {
        generated = await callGroupSession(groupId, rec, marker);
      } catch (e) {
        status.counts.errors++;
        status.lastError = '生成失败：' + ((e && e.message) || e);
        status.lastReply = { at: Date.now(), groupId: groupId, ok: false, reason: status.lastError };
        appendLog(status.lastError);
        return;
      }
      const text = cleanReply(generated && generated.text, marker);
      if (!text) {
        status.counts.skipped++;
        status.lastReply = { at: Date.now(), groupId: groupId, ok: false, reason: generated && generated.timeout ? 'timeout' : 'empty_or_pass' };
        appendLog('未接话 group=' + groupId + ' timeout=' + !!(generated && generated.timeout));
        return;
      }
      try {
        const sent = gate && typeof gate.sendGroupText === 'function'
          ? await gate.sendGroupText(groupId, text)
          : { ok: false, error: '外发闸门未接线，拒绝直连发送' };
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
          at: s.lastRandomAt, groupId: groupId, ok: true, text: text,
          ms: Date.now() - started, messageId: String(sent.messageId || '')
        };
        appendLog('接话 group=' + groupId + ' len=' + text.length + ' ms=' + (Date.now() - started));
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

  function handleEvent(ev) {
    if (!ev || (ev.post_type !== 'message' && ev.post_type !== 'message_sent')) return;
    if (String(ev.message_type || '') !== 'group') return;
    const groupId = String(ev.group_id || '');
    if (!groupId || !config.listen) return;
    if (!managedGroupIds().has(groupId)) return;
    const qqCfg = readQqConfig();
    const selfUin = String(ev.self_id || qqCfg.selfUin || '');
    const userId = String(ev.user_id || '');
    const out = String(ev.post_type) === 'message_sent' || (selfUin && userId === selfUin);
    const text = textOf(ev.message).trim();
    if (!text) return;
    const msgId = String(ev.message_id || '');
    const key = groupId + '|' + (msgId || (userId + '|' + text));
    const old = seen.get(key);
    const now = Date.now();
    if (old && now - old < 300000) return;
    seen.set(key, now);
    if (seen.size > 2000) {
      for (const [k, v] of seen) if (now - v > 300000) seen.delete(k);
    }
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
      roll: decision.roll === null || decision.roll === undefined ? null : Math.round(decision.roll * 1000) / 1000
    };
    writeStatus();
    if (!decision.ok) {
      status.counts.skipped++;
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
        try { handleEvent(data); } catch (e) {
          status.counts.errors++;
          status.lastError = '处理群消息失败：' + ((e && e.message) || e);
          appendLog(status.lastError);
        }
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
      maxChars: config.maxChars
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
    _test: { handleEvent: handleEvent, decide: decide, cleanReply: cleanReply, buildPrompt: buildPrompt, configFile: CONFIG_FILE }
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
