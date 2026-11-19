'use strict';
// 微信通道.js —— 社交场景「微信个人号」的进程面 + 换脑适配器（2026-11-18）
//
// 定位：whale_girl（鲸鲸，微信 4.x 桌面自动化）只当**传输通道**，不当第二个人格。
//   鲸鲸先按它自己的规则判定「这条要不要接」（私聊默认接、群聊被 @/叫名字才接），
//   判到 reply 后，我们的 JavaScript 插件把消息 POST 到本文件的 31241 适配器；
//   适配器把消息投给 DSH「胡闹的大肥鱼」会话，等这一轮 turn/end，再把正文回给插件。
//   插件返回 {text} 会替换鲸鲸自己的模型调用 ⇒ 微信里说话的是工作台人格。
//   任何失败都返回空文本 ⇒ 鲸鲸把本轮标记为 ignore，**绝不回落鲸鲸自己的模型**。
//
// 为什么适配器在壳进程里而不是独立脚本：
//   · token 只在壳内存（harnessToken），独立进程要靠环境变量传，引擎重启就过期；
//   · DSH 的会话/转录/换 cookie 逻辑已经在 工具/派发-公共.mjs，动态 import 复用，不复制第二份；
//   · 壳退出时能一起收掉，不留孤儿端口。
//
// 端口：适配器 31241（31238=站点、31239=网页版 AI、31240=预览，别复用）。
// 落盘：外壳\data\微信通道.json（本机配置，gitignored）
//       外壳\data\微信通道\状态.json（社交卡片读它；10 秒刷新）
//       外壳\data\微信通道\通道.log / whale-kernel.log / whale-bridge.log

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync, execFile } = require('child_process');
const { pathToFileURL } = require('url');

const SHELL = __dirname;
const ROOT = path.dirname(SHELL);
const DATA_DIR = path.join(SHELL, 'data');
const WORK_DIR = path.join(DATA_DIR, '微信通道');
const CONFIG_FILE = path.join(DATA_DIR, '微信通道.json');
const STATUS_FILE = path.join(WORK_DIR, '状态.json');
const LOG_FILE = path.join(WORK_DIR, '通道.log');
const KERNEL_LOG = path.join(WORK_DIR, 'whale-kernel.log');
const BRIDGE_LOG = path.join(WORK_DIR, 'whale-bridge.log');
const PLUGIN_SRC_DIR = path.join(ROOT, '插件', '社交通道', 'whale');
// 鲸鲸桥接的 Python 兼容补丁：只用 sitecustomize 把 Weixin.exe 的
// open_files 探测限流，避免微信句柄多时卡住心跳；不改鲸鲸安装目录。
const PY_PATCH_DIR = path.join(PLUGIN_SRC_DIR, 'python_patch');
const PLUGIN_ID = 'dsh-wechat';
const LIB_FILE = path.join(ROOT, '工具', '派发-公共.mjs');
const WORKSPACE_DIR = path.join(ROOT, '工作区');
const CHAT_MAP_FILE = path.join(WORK_DIR, '微信会话.json');
// 群聊旁听：chat.received 把群里每一条消息落到这里，不触发回复；
// 群聊真正被叫到时，提示词从这里取最近上下文，而不是只取鲸鲸 store 的 12 条。
const LISTEN_DIR = path.join(WORK_DIR, '旁听');
const PERSONA_MAP_REL = path.join('场景记忆', '_共享记忆', '微信会话.json');
const DEFAULT_ADAPTER_PORT = 31241;

// native：鲸鲸原生功能的控制面。默认全开；真正生效还要求模型 Key / 贴纸素材到位，
// 设置页会分别显示「已保存」和「实际生效」，不把开关当成功。
const NATIVE_DEFAULTS = {
  voice: true,
  vision: true,
  links: true,
  websearch: true,
  stickers: true,
  diary: true,
  diarySend: true,
  momentsAutoRead: 6,
  momentsAutoLike: true,
  memorySnapshot: false,
  voiceReply: true,
  voiceReplyPrivate: true,
  voiceReplyGroups: false,
  voiceReplyChance: 0,
  groupAddressGuard: true,
  accountGuard: true,
  backgroundSend: true,
  quoteReply: false
};

const DEFAULTS = {
  _说明: '微信个人号通道。whale_girl 只做收发，回复由 DSH「胡闹的大肥鱼」会话生成。改完重启通道生效；白名单可热改。',
  whaleHome: '',
  autoStart: true,
  kernelPort: 8787,
  adapterPort: DEFAULT_ADAPTER_PORT,
  sessionTitle: '胡闹的大肥鱼',
  sessionMode: 'per-chat',
  native: NATIVE_DEFAULTS,
  allowedChats: ['文件传输助手'],
  allowAll: true,
  ratePerMinute: 8,
  maxChars: 300,
  replyTimeoutMs: 110000,
  adapterToken: '',
  whaleNode: '',
  whalePython: '',
  windowHwnd: 0,
  wechatDbDir: '',
  wechatAccount: ''
};

let registryCache = null;

// ---------- 基础小工具 ----------
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* 由调用方报错 */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

function randomHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 10);
}

// 每个微信私聊 / 群聊一条独立 DSH 会话。映射表是唯一真源：
//   · 外壳读它做状态卡 / 自检 / 设置页；
//   · 记忆回响插件读 DSH_HOME 下的同名副本，给动态会话补人格卡（否则新会话会变成通用 agent）。
function readChatMap() {
  const j = readJson(CHAT_MAP_FILE);
  if (!j || typeof j !== 'object' || !j.chats || typeof j.chats !== 'object') {
    return { version: 1, updatedAt: 0, chats: {} };
  }
  return j;
}

function writeChatMap(map, dshHome) {
  const out = map && typeof map === 'object' ? map : { version: 1, chats: {} };
  out.version = 1;
  out.updatedAt = Date.now();
  if (!out.chats || typeof out.chats !== 'object') out.chats = {};
  writeText(CHAT_MAP_FILE, JSON.stringify(out, null, 2));
  // 插件只认 sessionId → { scene, panel }，不给它喂聊天名/账号，减少隐私面。
  if (dshHome) {
    const direct = {};
    for (const item of Object.values(out.chats)) {
      if (!item || !item.sessionId) continue;
      direct[String(item.sessionId)] = {
        scene: '胡闹的大肥鱼',
        panel: '',
        title: String(item.title || ''),
        chatType: String(item.chatType || ''),
        chatId: String(item.chatId || ''),
        updatedAt: Number(item.lastAt || item.createdAt || Date.now())
      };
    }
    try {
      writeText(path.join(dshHome, PERSONA_MAP_REL), JSON.stringify(direct, null, 2));
    } catch (e) { /* 写不进只影响人格注入，不影响收发；状态卡会显示 */ }
    // 通用社交会话总表：微信不再只写自己的 _共享记忆/微信会话.json，
    // 否则 QQ / 飞书接进来时记忆回响还得再写一套。镜像写不进时不影响收发。
    try { socialReply.syncFromWechatMap(out, dshHome); } catch (e) {
      if (process.env.DSH_DEBUG) console.warn('[wechat] sync social sessions failed', e);
    }
  }
  return out;
}

function chatTitlePart(s, max) {
  return String(s || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 40);
}

// ---------- 群聊旁听 ----------
// 只落群消息，不发、不触发 DSH。文件用 chatId 的短哈希命名，正文里带聊天标题，
// 避免把群名直接当文件名（Windows 非法字符/超长都会炸）。
function listenFilePath(chatId) {
  return path.join(LISTEN_DIR, shortHash(chatId) + '.jsonl');
}

function appendListenRecord(rec) {
  if (!rec || !rec.chatId || !rec.text) return false;
  ensureDir(LISTEN_DIR);
  const file = listenFilePath(rec.chatId);
  try {
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    // 单群最多留 600 条；超过就截尾重写。旁听只服务最近上下文，不承担全量归档。
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { size = 0; }
    if (size > 1024 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-600);
      fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    }
    return true;
  } catch (e) { return false; }
}

function readListenRecords(chatId, limit) {
  const file = listenFilePath(chatId);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, limit || 20));
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
    }
    return out;
  } catch (e) { return []; }
}

function listenStats() {
  const out = { groups: 0, records: 0, latestAt: 0, files: 0 };
  let entries = [];
  try { entries = fs.readdirSync(LISTEN_DIR, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent || !ent.isFile() || !/\.jsonl$/i.test(ent.name)) continue;
    out.files++;
    const file = path.join(LISTEN_DIR, ent.name);
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      out.records += lines.length;
      const st = fs.statSync(file);
      out.latestAt = Math.max(out.latestAt, Number(st.mtimeMs) || 0);
      let title = '';
      try { title = String((JSON.parse(lines[0] || '{}') || {}).chatTitle || ''); } catch (e) { title = ''; }
      if (lines.length && title) out.groups++;
    } catch (e) { /* 单个坏文件不影响整表 */ }
  }
  return out;
}

function sessionIsolationView(cfg) {
  const m = readChatMap();
  const items = Object.entries(m.chats || {}).map(([key, v]) => ({
    chatId: String((v && v.chatId) || key || ''),
    chatType: String((v && v.chatType) || 'private'),
    chatTitle: String((v && v.chatTitle) || ''),
    title: String((v && v.title) || ''),
    sessionId: String((v && v.sessionId) || ''),
    createdAt: Number((v && v.createdAt) || 0),
    lastAt: Number((v && v.lastAt) || 0),
    lastTurn: Number((v && v.lastTurn) || 0),
    lastSender: String((v && v.lastSender) || '')
  })).sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt));
  const groups = items.filter((x) => x.chatType === 'group').length;
  const privates = items.filter((x) => x.chatType !== 'group').length;
  return {
    mode: String((cfg && cfg.sessionMode) || 'per-chat'),
    enabled: String((cfg && cfg.sessionMode) || 'per-chat') !== 'shared',
    count: items.length,
    groups: groups,
    privates: privates,
    updatedAt: Number(m.updatedAt || 0),
    items: items.slice(0, 30)
  };
}

function normalizePath(p) {
  return String(p || '').replace(/[\\/]+/g, path.sep).replace(/[\\/]$/, '').toLowerCase();
}

function safeEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function tailFile(file, n) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    const lines = s.split(/\r?\n/).filter((x) => x.trim());
    return lines.slice(-n).join('\n').slice(-600);
  } catch (e) { return ''; }
}

function isWhaleHome(p) {
  try {
    return fs.existsSync(path.join(p, 'server.js')) && fs.existsSync(path.join(p, 'bridge'));
  } catch (e) { return false; }
}

function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = String(process.env.Path || process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

// Inno Setup 会把安装位置写进卸载表；路径可能是 D:\whale-girl，不在代码里写死盘符。
function registryHomes() {
  if (registryCache && Date.now() - registryCache.at < 300000) return registryCache.list;
  const out = [];
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  for (const key of keys) {
    try {
      const txt = execFileSync('reg.exe', ['query', key, '/s', '/v', 'InstallLocation'], {
        encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024
      });
      for (const line of txt.split(/\r?\n/)) {
        const m = /InstallLocation\s+REG_SZ\s+(.+)$/.exec(line.trim());
        if (m) out.push(m[1].trim().replace(/^"|"$/g, ''));
      }
    } catch (e) { /* 没有这个键或没有权限：继续下一档 */ }
  }
  registryCache = { at: Date.now(), list: out };
  return out;
}

function readWhaleConfig(home) {
  if (!home) return {};
  const files = [
    path.join(home, 'config.json'),
    path.join(home, 'config', 'config.example.json'),
    path.join(home, 'config.example.json')
  ];
  for (const f of files) {
    const j = readJson(f);
    if (j && typeof j === 'object') return j;
  }
  return {};
}

function writeWhaleConfig(home, cfg) {
  writeText(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

// 贴纸开关打开但没有素材，是「开了也没用」的典型静默失败；设置页必须看见数量。
function stickerStats(home) {
  const dir = path.join(String(home || ''), 'data', 'stickers');
  let count = 0;
  let exists = false;
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (!ent) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full, depth + 1); continue; }
      if (ent.isFile() && /\.(?:png|jpg|jpeg|gif|webp)$/i.test(ent.name)) count++;
    }
  };
  try {
    exists = fs.existsSync(dir);
    if (exists) walk(dir, 0);
  } catch (e) { /* 读不了就当 0，界面会提示目录 */ }
  return { dir: dir, exists: exists, count: count };
}

// 语音回复是桥接自己的策略文件（data/voice-send.json），不是 config.json 字段。
// 它只决定「何时发语音」，不存任何密钥；显式“发语音”永远优先，Probability 只影响主动概率。
function readVoicePolicy(home) {
  const file = path.join(String(home || ''), 'data', 'voice-send.json');
  const j = readJson(file) || {};
  return {
    file: file,
    exists: fs.existsSync(file),
    enabled: j.Enabled === true,
    private: j.Private !== false,
    groups: j.Groups === true,
    probability: Number.isFinite(Number(j.Probability)) ? Math.max(0, Math.min(100, Number(j.Probability))) : 0,
    synthTimeoutSec: Number.isFinite(Number(j.SynthTimeoutSec)) ? Math.max(5, Math.min(90, Number(j.SynthTimeoutSec))) : 85,
    raw: j
  };
}
function writeVoicePolicy(home, policy) {
  const file = path.join(String(home || ''), 'data', 'voice-send.json');
  const next = Object.assign({}, (readJson(file) || {}), {
    Enabled: !!policy.enabled,
    Private: !!policy.private,
    Groups: !!policy.groups,
    Probability: Math.max(0, Math.min(100, Number(policy.probability) || 0)),
    SynthTimeoutSec: Math.max(5, Math.min(90, Number(policy.synthTimeoutSec) || 85))
  });
  writeText(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// 图片理解没有独立 Key 时，鲸鲸会自动跟随聊天服务商的视觉模型。
// UI 不能只看 vision.apiKey 就判“没配”，否则会出现「实际能看图、界面说不可用」的假阴性。
function visionReady(home, wc) {
  const cfg = wc || {};
  const v = cfg.vision || {};
  if (String(v.apiKey || '').trim()) return true;
  const settings = readJson(path.join(String(home || ''), 'data', 'settings.json')) || {};
  const keys = settings.keys || {};
  if (String(settings.visionApiKey || keys.vision || '').trim()) return true;
  const provider = String(settings.visionProvider || cfg.provider ||
    (cfg.llm && cfg.llm.provider) || (cfg.deepseek && cfg.deepseek.provider) || 'deepseek').toLowerCase();
  const env = process.env || {};
  if (provider === 'deepseek') return !!(cfg.deepseek && String(cfg.deepseek.apiKey || '').trim());
  if (provider === 'zhipu') return !!(env.ZHIPU_API_KEY || env.VISION_API_KEY);
  if (provider === 'doubao') return !!(env.ARK_API_KEY || env.DOUBAO_API_KEY);
  if (provider === 'dashscope' || provider === 'qwen') return !!env.DASHSCOPE_API_KEY;
  if (provider === 'siliconflow') return !!env.SILICONFLOW_API_KEY;
  return false;
}

// 千问表情包配置只放鲸鲸 data 目录，不写进仓库，也不从设置接口回显 Key。
// 同一套生成接口只认这个文件；私聊/群聊的发送仍走鲸鲸原生表情包队列。
function qwenImageFile(home) {
  return path.join(String(home || ''), 'data', 'qwen-image.json');
}
function readQwenImage(home) {
  const file = qwenImageFile(home);
  const j = readJson(file) || {};
  return {
    file: file,
    exists: fs.existsSync(file),
    apiKeyConfigured: !!String(j.apiKey || '').trim(),
    apiKey: String(j.apiKey || ''),
    model: String(j.model || 'qwen-image-2.1-pro'),
    baseUrl: String(j.baseUrl || 'https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation'),
    category: String(j.category || '鲸鲸千问'),
    chat: String(j.chat || '静音胡闹'),
    updatedAt: Number(j.updatedAt || 0)
  };
}
function writeQwenImage(home, patch) {
  const cur = readQwenImage(home);
  const next = {
    apiKey: String((patch && patch.apiKey) || cur.apiKey || ''),
    model: String((patch && patch.model) || cur.model || 'qwen-image-2.1-pro').slice(0, 80),
    baseUrl: String((patch && patch.baseUrl) || cur.baseUrl || '').slice(0, 300),
    category: String((patch && patch.category) || cur.category || '鲸鲸千问').replace(/[\\/:*?"<>|]/g, '').slice(0, 20),
    chat: String((patch && patch.chat) || cur.chat || '静音胡闹').replace(/[\r\n]/g, '').slice(0, 160),
    updatedAt: Date.now()
  };
  writeText(qwenImageFile(home), JSON.stringify(next, null, 2) + '\n');
  return next;
}

function diaryStats(home) {
  const dir = path.join(String(home || ''), 'data', 'diary');
  const files = [];
  try {
    if (fs.existsSync(dir)) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent || !ent.isFile() || !/\.(?:md|txt|json)$/i.test(ent.name)) continue;
        const file = path.join(dir, ent.name);
        const stat = fs.statSync(file);
        files.push({ name: ent.name, file: file, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  } catch (e) { /* 目录读不了就按空状态显示 */ }
  files.sort((a, b) => b.mtime - a.mtime);
  return { dir: dir, count: files.length, latest: files[0] || null, recent: files.slice(0, 5) };
}

function remindersStats(home) {
  const j = readJson(path.join(String(home || ''), 'data', 'reminders.json')) || {};
  const items = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : []);
  const pending = items.filter((x) => x && (String(x.status || '') === '' || /pending|waiting|due/i.test(String(x.status || ''))));
  return {
    file: path.join(String(home || ''), 'data', 'reminders.json'),
    total: items.length,
    pending: pending.length,
    items: pending.slice(0, 8).map((x) => ({
      id: String(x.id || ''),
      text: String(x.text || '').slice(0, 80),
      dueAt: Number(x.dueAt || x.at || 0) || 0,
      status: String(x.status || '')
    }))
  };
}

function whaleVersion(home) {
  const pkg = readJson(path.join(String(home || ''), 'package.json')) || {};
  return { version: String(pkg.version || ''), name: String(pkg.name || '') };
}

// 设置面板只改「能安全改的通道参数」：白名单之外的键一律不落盘。
// 布尔读法兼容旧配置里的 "false" / "0"；数字统一取整并夹到合理范围。
function asBool(v, dflt) {
  if (v === undefined || v === null) return !!dflt;
  if (typeof v === 'string') return !/^(?:false|0|off|no)$/i.test(v.trim());
  return v !== false && v !== 0;
}
function asInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function hasKey(o, k) {
  return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}

function settingsView(cfg, wc, home) {
  const g = (wc && wc.group) || {};
  const wx = (wc && wc.wechat) || {};
  const ft = (wc && wc.features) || {};
  const vo = (wc && wc.voice) || {};
  const vi = (wc && wc.vision) || {};
  const li = (wc && wc.links) || {};
  const ws = (wc && wc.websearch) || {};
  const di = (wc && wc.diary) || {};
  const mo = (wc && wc.moments) || {};
  const nCfg = Object.assign({}, NATIVE_DEFAULTS, (cfg && cfg.native) || {});
  const rawPct = Number(g.freeChatChance);
  const pct = Number.isFinite(rawPct) ? Math.round(rawPct * 1000) / 10 : 6;
  return {
    autoStart: asBool(cfg.autoStart, true),
    maxChars: asInt(cfg.maxChars, 60, 2000, 300),
    allowAll: asBool(cfg.allowAll, true),
    account: String(cfg.wechatAccount || ''),
    sessionMode: String(cfg.sessionMode || 'per-chat'),
    group: {
      requireAt: asBool(g.requireAt, true),
      freeChat: asBool(g.freeChat, false),
      freeChatChance: pct,
      engagedMinutes: asInt(g.engagedMinutes, 1, 120, 6),
      silentMinutes: asInt(g.silentMinutes, 1, 240, 30),
      cooldownSec: asInt(g.cooldownSec, 0, 3600, 0),
      maxRepliesPerMinute: asInt(g.maxRepliesPerMinute, 1, 30, 15),
      addressGuard: asBool(ft.groupAddressGuard, !!nCfg.groupAddressGuard),
      masterAlwaysReply: asBool(g.masterAlwaysReply, true)
    },
    wechat: {
      backgroundSend: asBool(wx.backgroundSend, !!nCfg.backgroundSend),
      quoteReply: asBool(wx.quoteReply, !!nCfg.quoteReply),
      accountGuard: asBool(wx.accountGuard, !!nCfg.accountGuard),
      windowHwnd: asInt(wx.windowHwnd, 0, 9999999, 0),
      dbDir: String(wx.dbDir || ''),
      pipelineWorkers: asInt(wx.pipelineWorkers, 1, 16, 4)
    },
    native: {
      voice: asBool(vo.enabled, !!nCfg.voice),
      // 鲸鲸原生视觉没有 enab 开关：配了 Key 就生效。这里保留字段只为兼容旧界面，
      // 新界面显示为只读状态；不要再写 vision.enabled（那是无效键）。
      vision: true,
      visionAlwaysOn: true,
      links: asBool(li.enabled, !!nCfg.links),
      // 本地搜索常开；这个开关真正控制的是第三方搜索 API（热榜/网页结果）。
      websearch: asBool((ws.api || {}).enabled, !!nCfg.websearch),
      stickers: asBool(ft.stickers, !!nCfg.stickers),
      diary: asBool(di.enabled, !!nCfg.diary),
      diarySend: asBool(di.sendToOwner, !!nCfg.diarySend),
      momentsAutoRead: asInt(mo.autoReadEveryHours, 0, 24, Number(nCfg.momentsAutoRead) || 6),
      momentsAutoLike: asBool(mo.autoLike, !!nCfg.momentsAutoLike),
      memorySnapshot: false,
      voiceReply: asBool(nCfg.voiceReply, true),
      voiceReplyPrivate: asBool(nCfg.voiceReplyPrivate, true),
      voiceReplyGroups: asBool(nCfg.voiceReplyGroups, false),
      voiceReplyChance: asInt(nCfg.voiceReplyChance, 0, 100, 0),
      groupAddressGuard: asBool(ft.groupAddressGuard, !!nCfg.groupAddressGuard),
      apiKeyConfigured: !!(wc && wc.deepseek && String(wc.deepseek.apiKey || '').trim()),
      visionKeyConfigured: visionReady(home, wc),
      voiceKeyConfigured: !!(wc && wc.deepseek && String(wc.deepseek.apiKey || '').trim()),
      provider: String((wc && wc.provider) || 'deepseek')
    },
    features: { javascriptPlugins: asBool(ft.javascriptPlugins, false) }
  };
}

// 把设置面板提交的补丁合并进内存里的 shell / 鲸鲸配置，返回改了哪些键。
function applySettings(args, cfg, wc) {
  const changed = [];
  let shellChanged = false;
  let whaleChanged = false;

  if (hasKey(args, 'autoStart')) {
    cfg.autoStart = asBool(args.autoStart, cfg.autoStart);
    changed.push('autoStart');
    shellChanged = true;
  }
  if (hasKey(args, 'maxChars')) {
    const next = asInt(args.maxChars, 60, 2000, Number(cfg.maxChars) || 300);
    if (next !== Number(cfg.maxChars)) {
      cfg.maxChars = next;
      changed.push('maxChars');
      shellChanged = true;
    }
  }

  const gIn = args.group;
  if (gIn && typeof gIn === 'object') {
    wc.group = wc.group || {};
    if (hasKey(gIn, 'addressGuard')) {
      const next = asBool(gIn.addressGuard, true);
      if (!wc.features || typeof wc.features !== 'object') wc.features = {};
      if (asBool(wc.features.groupAddressGuard, true) !== next) {
        wc.features.groupAddressGuard = next;
        cfg.native = Object.assign({}, NATIVE_DEFAULTS, cfg.native || {}, { groupAddressGuard: next });
        changed.push('group.addressGuard');
        whaleChanged = true;
      }
    }
    const pairs = [
      ['requireAt', 'requireAt', true],
      ['freeChat', 'freeChat', false]
    ];
    pairs.forEach(function (p) {
      if (!hasKey(gIn, p[0])) return;
      const next = asBool(gIn[p[0]], asBool(wc.group[p[1]], p[2]));
      if (next !== asBool(wc.group[p[1]], p[2])) {
        wc.group[p[1]] = next;
        changed.push('group.' + p[1]);
        whaleChanged = true;
      }
    });
    if (hasKey(gIn, 'freeChatChance')) {
      const pct = asInt(gIn.freeChatChance, 0, 100, 6);
      const next = pct / 100;
      if (Math.abs(Number(wc.group.freeChatChance) - next) > 0.0001) {
        wc.group.freeChatChance = next;
        changed.push('group.freeChatChance');
        whaleChanged = true;
      }
    }
    const nums = [
      ['engagedMinutes', 'engagedMinutes', 1, 120, 6],
      ['silentMinutes', 'silentMinutes', 1, 240, 30],
      ['cooldownSec', 'cooldownSec', 0, 3600, 0],
      ['maxRepliesPerMinute', 'maxRepliesPerMinute', 1, 30, 15]
    ];
    nums.forEach(function (p) {
      if (!hasKey(gIn, p[0])) return;
      const next = asInt(gIn[p[0]], p[2], p[3], p[4]);
      if (next !== Number(wc.group[p[1]])) {
        wc.group[p[1]] = next;
        changed.push('group.' + p[1]);
        whaleChanged = true;
      }
    });
  }

  const wIn = args.wechat;
  if (wIn && typeof wIn === 'object' && hasKey(wIn, 'backgroundSend')) {
    wc.wechat = wc.wechat || {};
    const next = asBool(wIn.backgroundSend, asBool(wc.wechat.backgroundSend, true));
    if (next !== asBool(wc.wechat.backgroundSend, true)) {
      wc.wechat.backgroundSend = next;
      changed.push('wechat.backgroundSend');
      whaleChanged = true;
    }
  }

  // 原生功能：cfg.native 是控制面，同时把能热改的值写进鲸鲸 config；
  // 这样设置页「保存」后立刻能读到实际值，重启时 _patchWhaleConfig 再按控制面兜底。
  const nIn = args.native;
  if (nIn && typeof nIn === 'object') {
    cfg.native = Object.assign({}, NATIVE_DEFAULTS, cfg.native || {});
    // 旧版曾写 vision.enabled；鲸鲸根本不读这个键，保存时顺手删掉，
    // 避免配置文件里留一个看起来能关、实际不生效的开关。
    if (wc.vision && typeof wc.vision === 'object') delete wc.vision.enabled;
    const boolPairs = [
      ['voice', 'voice', 'enabled', true],
      // 图片理解没有原生总开关：鲸鲸收到图就会走视觉接口，缺 Key 时失败。
      // 不再写 vision.enabled，避免界面上出现「关了但还在用」的假开关。
      ['links', 'links', 'enabled', true],
      ['stickers', 'features', 'stickers', true],
      ['diary', 'diary', 'enabled', true],
      ['diarySend', 'diary', 'sendToOwner', true],
      ['momentsAutoLike', 'moments', 'autoLike', true],
      ['groupAddressGuard', 'features', 'groupAddressGuard', true],
      ['accountGuard', 'wechat', 'accountGuard', true],
      ['backgroundSend', 'wechat', 'backgroundSend', true],
      ['quoteReply', 'wechat', 'quoteReply', false]
    ];
    boolPairs.forEach(function (p) {
      if (!hasKey(nIn, p[0])) return;
      const next = asBool(nIn[p[0]], !!cfg.native[p[0]]);
      // 与「鲸鲸 config 的实际值」比，而不是与壳默认值比；否则默认全开时
      // 界面把实际 false 打开会被误判成「没有修改」。
      const cur = asBool(wc[p[1]] && wc[p[1]][p[2]], !!cfg.native[p[0]]);
      if (next === cur) return;
      cfg.native[p[0]] = next;
      if (!wc[p[1]] || typeof wc[p[1]] !== 'object') wc[p[1]] = {};
      wc[p[1]][p[2]] = next;
      changed.push('native.' + p[0]);
      shellChanged = true;
      whaleChanged = true;
    });
    // 搜索：鲸鲸把「本地搜索」钉死为常开（loadConfig 强制 websearch.enabled=true），
    // 真正可关的是第三方 API。界面开关一律写 websearch.api.enabled，
    // 否则用户关了搜索却发现本地结果还在，或者开了却只走本地、热榜永远不生效。
    if (hasKey(nIn, 'websearch')) {
      const next = asBool(nIn.websearch, !!cfg.native.websearch);
      if (!wc.websearch || typeof wc.websearch !== 'object') wc.websearch = {};
      if (!wc.websearch.api || typeof wc.websearch.api !== 'object') wc.websearch.api = {};
      const cur = asBool(wc.websearch.api.enabled, true);
      if (next !== cur) {
        cfg.native.websearch = next;
        wc.websearch.api.enabled = next;
        changed.push('native.websearch');
        shellChanged = true;
        whaleChanged = true;
      }
    }
    if (hasKey(nIn, 'momentsAutoRead')) {
      const next = asInt(nIn.momentsAutoRead, 0, 24, Number(cfg.native.momentsAutoRead) || 6);
      const cur = asInt(wc.moments && wc.moments.autoReadEveryHours, 0, 24, Number(cfg.native.momentsAutoRead) || 6);
      if (next !== cur) {
        cfg.native.momentsAutoRead = next;
        if (!wc.moments || typeof wc.moments !== 'object') wc.moments = {};
        wc.moments.autoReadEveryHours = next;
        changed.push('native.momentsAutoRead');
        shellChanged = true;
        whaleChanged = true;
      }
    }
    // 只接受非空新值；空串 = 不改，不用 __KEEP__ 这类魔法值。
    if (hasKey(nIn, 'apiKey')) {
      const key = String(nIn.apiKey || '').trim();
      if (key) {
        if (!wc.deepseek || typeof wc.deepseek !== 'object') wc.deepseek = {};
        wc.provider = String(wc.provider || 'deepseek');
        if (String(wc.deepseek.apiKey || '') !== key) {
          wc.deepseek.apiKey = key;
          changed.push('native.apiKey');
          whaleChanged = true;
        }
      }
    }
    // 视觉和语音识别各有独立服务；空值 = 不改，避免把旧 Key 回写到界面。
    if (hasKey(nIn, 'visionApiKey')) {
      const key = String(nIn.visionApiKey || '').trim();
      if (key) {
        if (!wc.vision || typeof wc.vision !== 'object') wc.vision = {};
        if (String(wc.vision.apiKey || '') !== key) {
          wc.vision.apiKey = key;
          changed.push('native.visionApiKey');
          whaleChanged = true;
        }
      }
    }
    if (hasKey(nIn, 'voiceApiKey')) {
      const key = String(nIn.voiceApiKey || '').trim();
      if (key) {
        if (!wc.voice || typeof wc.voice !== 'object') wc.voice = {};
        if (String(wc.voice.apiKey || '') !== key) {
          wc.voice.apiKey = key;
          wc.voice.enabled = true;
          changed.push('native.voiceApiKey');
          whaleChanged = true;
        }
      }
    }
    if (hasKey(nIn, 'voiceReply')) {
      const next = asBool(nIn.voiceReply, !!cfg.native.voiceReply);
      if (next !== !!cfg.native.voiceReply) {
        cfg.native.voiceReply = next;
        changed.push('native.voiceReply');
        shellChanged = true;
      }
    }
    if (hasKey(nIn, 'voiceReplyPrivate')) {
      const next = asBool(nIn.voiceReplyPrivate, !!cfg.native.voiceReplyPrivate);
      if (next !== !!cfg.native.voiceReplyPrivate) {
        cfg.native.voiceReplyPrivate = next;
        changed.push('native.voiceReplyPrivate');
        shellChanged = true;
      }
    }
    if (hasKey(nIn, 'voiceReplyGroups')) {
      const next = asBool(nIn.voiceReplyGroups, !!cfg.native.voiceReplyGroups);
      if (next !== !!cfg.native.voiceReplyGroups) {
        cfg.native.voiceReplyGroups = next;
        changed.push('native.voiceReplyGroups');
        shellChanged = true;
      }
    }
    if (hasKey(nIn, 'voiceReplyChance')) {
      const next = asInt(nIn.voiceReplyChance, 0, 100, Number(cfg.native.voiceReplyChance) || 0);
      if (next !== Number(cfg.native.voiceReplyChance)) {
        cfg.native.voiceReplyChance = next;
        changed.push('native.voiceReplyChance');
        shellChanged = true;
      }
    }
  }

  // 回复长度是工作台自己的 cfg.maxChars；鲸鲸下一次 start 会按它同步 chat 两个上限。
  // 这里顺手写进鲸鲸 config，未重启时也能从文件看出意图。
  if (hasKey(args, 'maxChars')) {
    wc.chat = wc.chat || {};
    if (Number(wc.chat.privateMaxChars) !== Number(cfg.maxChars)) {
      wc.chat.privateMaxChars = Number(cfg.maxChars);
      whaleChanged = true;
    }
    if (Number(wc.chat.groupMaxChars) !== Number(cfg.maxChars)) {
      wc.chat.groupMaxChars = Number(cfg.maxChars);
      whaleChanged = true;
    }
    wc.chat.maxBubbles = 1;
  }

  return { changed: changed, shellChanged: shellChanged, whaleChanged: whaleChanged };
}

// 微信账号目录名比真 wxid 多一段 4 位哈希（wxid_xxx_c248），两者指同一个号。
// 双开时 accounts.json 会列出本机登录过的号；UI 的下拉靠它，不靠猜。
function accountCore(s) {
  const v = String(s || '').trim();
  // 只削「wxid_xxx_4位哈希」这种账号目录名；不要对普通 wxid 尾部的 4 位十六进制动手。
  const m = v.match(/^(wxid_[^_]+)_([0-9a-f]{4})$/i);
  return m ? m[1] : v;
}
function sameAccount(a, b) {
  const x = accountCore(a);
  const y = accountCore(b);
  return !!x && !!y && x.toLowerCase() === y.toLowerCase();
}
function readWhaleAccounts(home) {
  if (!home) return [];
  const j = readJson(path.join(home, 'data', 'accounts.json')) || {};
  const rows = Array.isArray(j.accounts) ? j.accounts : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const account = String(r.account || r.wxid || '').trim();
    if (!account) continue;
    const wxid = String(r.wxid || '').trim();
    const nick = String(r.nick || '').trim();
    out.push({
      account,
      wxid,
      nick,
      lastActive: Number(r.lastActive) || 0,
      label: nick ? (nick + (wxid && nick !== wxid ? '（' + wxid + '）' : '')) : (wxid || account)
    });
  }
  out.sort(function (a, b) { return b.lastActive - a.lastActive; });
  return out;
}
function labelForAccount(list, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const hit = (list || []).find(function (a) { return sameAccount(a.account, v) || sameAccount(a.wxid, v); });
  return hit ? hit.label : v;
}
// 不依赖鲸鲸桥接：直接扫微信数据目录。用户刚换号、桥接还没启动时，
// accounts.json 可能还是旧的；这里先让新号出现在下拉里，昵称等桥接补。
function scanWechatAccounts(dbDir) {
  const out = [];
  if (!dbDir) return out;
  let entries = [];
  try { entries = fs.readdirSync(dbDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent || !ent.isDirectory()) continue;
    const account = String(ent.name || '');
    if (!account) continue;
    const storage = path.join(dbDir, account, 'db_storage');
    let st;
    try { st = fs.statSync(storage); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const wxid = accountCore(account);
    out.push({
      account,
      wxid,
      nick: '',
      lastActive: Number(st.mtimeMs) || 0,
      label: wxid
    });
  }
  out.sort(function (a, b) { return b.lastActive - a.lastActive; });
  return out;
}

// 已钉账号 → 微信数据目录下的真实账号目录（含 4 位哈希后缀）。
function resolveAccountDbDir(dbDir, account) {
  const rows = scanWechatAccounts(dbDir);
  const hit = rows.find(function (a) { return sameAccount(a.account, account) || sameAccount(a.wxid, account); });
  if (!hit) return '';
  const p = path.join(dbDir, hit.account, 'db_storage');
  // 微信数据目录可能是 Junction（D:\MyApp → D:\电脑管家迁移文件）。
  // 鲸鲸用进程打开文件拿到的是真实路径，这里也要给真实路径，否则同一条
  // 账号目录会因为别名不同而比不相等，被误判成「没扫到微信主窗」。
  try { return fs.realpathSync(p); } catch (e) { return p; }
}

function readConfig() {
  const file = readJson(CONFIG_FILE) || {};
  const cfg = Object.assign({}, DEFAULTS, file);
  if (!Array.isArray(cfg.allowedChats)) cfg.allowedChats = DEFAULTS.allowedChats.slice();
  cfg.native = Object.assign({}, NATIVE_DEFAULTS, (file && file.native && typeof file.native === 'object') ? file.native : {});
  return cfg;
}

function ensureConfig() {
  ensureDir(DATA_DIR);
  let cur = readJson(CONFIG_FILE);
  let changed = false;
  if (!cur || typeof cur !== 'object') { cur = {}; changed = true; }
  for (const k of Object.keys(DEFAULTS)) {
    if (cur[k] === undefined) { cur[k] = DEFAULTS[k]; changed = true; }
  }
  if (!cur.native || typeof cur.native !== 'object') {
    cur.native = Object.assign({}, NATIVE_DEFAULTS);
    changed = true;
  } else {
    for (const k of Object.keys(NATIVE_DEFAULTS)) {
      if (cur.native[k] === undefined) { cur.native[k] = NATIVE_DEFAULTS[k]; changed = true; }
    }
  }
  if (!cur.adapterToken) { cur.adapterToken = randomHex(32); changed = true; }
  if (changed) writeText(CONFIG_FILE, JSON.stringify(cur, null, 2) + '\n');
  return cur;
}

function extractBridge(status) {
  const gws = status && Array.isArray(status.gateways) ? status.gateways : [];
  const gw = gws.find((g) => g && (g.platform === 'wechat' || g.name === 'wechat' ||
    g.key === 'wechat' || g.id === 'wechat')) || gws[0] || null;
  if (!gw) return null;
  return gw.bridge && typeof gw.bridge === 'object' ? gw.bridge : gw;
}

function findMarkerTurn(events, marker) {
  // DSH 的 user/message 事件只带 content，不带 turn；marker 在这条上，
  // 后面紧跟的 step/start、assistant/message、turn/end 才带 turn。
  // 以前只查「带 turn 且含 marker」的事件，永远返回 0，适配器等满 110 秒后
  // 判超时，插件拿到空串 → 微信侧不回。
  let idx = -1;
  for (let i = 0; i < (events || []).length; i++) {
    try {
      if (JSON.stringify(events[i] && events[i].data || {}).indexOf(marker) >= 0) {
        idx = i;
        break;
      }
    } catch (x) { /* 忽略不可序列化的脏事件 */ }
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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        try { req.destroy(); } catch (e) { /* ignore */ }
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonReply(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (e) { /* 客户端已断开 */ }
}

function httpJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    let req = null;
    try {
      const u = new URL(url);
      req = http.get({
        hostname: u.hostname, port: u.port || 80,
        path: u.pathname + u.search, timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1024 * 1024) {
            try { req.destroy(); } catch (e) { /* ignore */ }
            finish({ ok: false, status: res.statusCode, error: 'body_too_large' });
          }
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (e) { /* 非 JSON 原样带出 */ }
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: body });
        });
      });
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch (e) { /* ignore */ }
        finish({ ok: false, error: 'timeout' });
      });
      req.on('error', (e) => finish({ ok: false, error: (e && (e.code || e.message)) || 'error' }));
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || 'error' });
    }
  });
}

function httpPostJson(url, body, timeoutMs, headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    let req = null;
    try {
      const u = new URL(url);
      const data = JSON.stringify(body === undefined ? {} : body);
      req = http.request({
        hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign({
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(data)
        }, headers || {}),
        timeout: timeoutMs
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
          if (text.length > 1024 * 1024) {
            try { req.destroy(); } catch (e) { /* ignore */ }
            finish({ ok: false, status: res.statusCode, error: 'body_too_large' });
          }
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* 非 JSON 原样带出 */ }
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text });
        });
      });
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch (e) { /* ignore */ }
        finish({ ok: false, error: 'timeout' });
      });
      req.on('error', (e) => finish({ ok: false, error: (e && (e.code || e.message)) || 'error' }));
      req.write(data);
      req.end();
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || 'error' });
    }
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const s = net.connect({ host: '127.0.0.1', port: Number(port) });
    s.setTimeout(800, () => { try { s.destroy(); } catch (e) { /* ignore */ } finish(false); });
    s.once('connect', () => { try { s.destroy(); } catch (e) { /* ignore */ } finish(true); });
    s.once('error', () => finish(false));
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch (e) { /* ignore */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
  }
}

// ---------- 服务 ----------
class WechatService {
  constructor(opts) {
    const o = opts || {};
    this.dshHome = String(o.dshHome || process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME ||
      path.join(ROOT, '引擎数据', '.dsh'));
    this.base = String(o.base || process.env.DSH_WEB_URL || '');
    this.getToken = typeof o.getToken === 'function' ? o.getToken : (() => process.env.DSH_TOKEN || '');
    this.log = typeof o.log === 'function' ? o.log : null;
    // 外发安全闸门（2026-11-18）：所有真正发到微信的正文都要先过它；没注入就退化成「不过闸门」，
    // 但状态里会写明 gate:false，面板不许把「没接闸门」画成安全。
    this.gate = o.gate || null;

    this.server = null;
    this.serverListening = false;
    this.kernelChild = null;
    this.bridgeChild = null;
    this.bridgeLastExit = null;
    this.statusTimer = null;
    this.writing = false;
    this.lastStatus = null;
    this.lastSend = null;
    this.lastGate = null;             // 最近一次外发审查结果（面板只显示 verdict / 规则码，不回显原文）
    this.libCache = null;
    this.startedAt = 0;

    this.counts = { rx: 0, replied: 0, blocked: 0, skipped: 0, errors: 0, lastAt: 0, lastError: '', lastChat: '' };
    this.seen = new Map();
    this.listenSeen = new Map();
    this.rate = [];
    this.chain = Promise.resolve();
  }

  // 1. 配置 / 目录 / 日志 / 脱敏
  config() {
    ensureConfig();
    return readConfig();
  }

  _ensureDirs() {
    ensureDir(WORK_DIR);
  }

  _redact(s) {
    return String(s || '')
      .replace(/(token=)([A-Za-z0-9_-]{12,})/g, '$1***')
      .replace(/(x-wx-token[=:]\s*)([A-Za-z0-9_-]{12,})/gi, '$1***')
      .replace(/(DSH_TOKEN[=:]\s*)([A-Za-z0-9_-]{12,})/gi, '$1***');
  }

  _appendLog(msg) {
    const line = '[' + new Date().toISOString() + '] ' + this._redact(msg);
    try { this._ensureDirs(); fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8'); } catch (e) { /* ignore */ }
    try { if (this.log) this.log('[wechat] ' + this._redact(msg)); } catch (e) { /* ignore */ }
  }

  _writeChildLog(stream, data) {
    try { if (stream) stream.write(this._redact(String(data))); } catch (e) { /* ignore */ }
  }

  // 2. 找 whale_girl：显式配置优先；显式配错要报，不静默退回别的目录
  _home(cfg) {
    const explicit = String(cfg.whaleHome || '').trim();
    if (explicit) {
      if (isWhaleHome(explicit)) return { home: explicit, error: '' };
      return { home: '', error: '配置的 whaleHome 不是鲸鲸目录（缺 server.js 或 bridge/）：' + explicit };
    }
    const env = String(process.env.WHALE_HOME || '').trim();
    if (env) {
      if (isWhaleHome(env)) return { home: env, error: '' };
      return { home: '', error: '环境变量 WHALE_HOME 指的不是鲸鲸目录：' + env };
    }
    const candidates = [
      path.join(ROOT, '桥接', 'whale-girl'),
      path.join(os.homedir(), 'whale-girl'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'whale-girl'),
      path.join(process.env.ProgramFiles || '', 'whale-girl'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'whale-girl')
    ].concat(registryHomes());
    for (const p of candidates) {
      if (p && isWhaleHome(p)) return { home: p, error: '' };
    }
    return {
      home: '',
      error: '未找到 whale_girl：装到纯英文路径后，在 ' + CONFIG_FILE + ' 填 whaleHome，或设 WHALE_HOME'
    };
  }

  _kernelPort(cfg, home) {
    const fromCfg = Number(cfg.kernelPort) || 0;
    if (fromCfg) return fromCfg;
    const fromWhale = Number((readWhaleConfig(home).server || {}).port) || 0;
    return fromWhale || 8787;
  }

  _adapterPort(cfg) {
    return Number(cfg.adapterPort) || DEFAULT_ADAPTER_PORT;
  }

  _node(home, cfg) {
    const cands = [
      String(cfg.whaleNode || ''),
      path.join(home, 'runtime', 'node', 'node.exe'),
      path.join(home, 'runtime', 'node', 'node'),
      findOnPath('node')
    ];
    for (const p of cands) {
      if (!p) continue;
      if (p === 'node' || fs.existsSync(p)) return p;
    }
    throw new Error('找不到 node：鲸鲸安装目录下没有 runtime\\node\\node.exe，也没在 PATH 里找到 node');
  }

  _python(home, cfg) {
    const explicit = String(cfg.whalePython || '');
    if (explicit) return { cmd: explicit, args: [] };
    const bundled = [
      path.join(home, 'runtime', 'python', 'python.exe'),
      path.join(home, 'runtime', 'python', 'python3.exe')
    ];
    for (const p of bundled) if (fs.existsSync(p)) return { cmd: p, args: [] };
    const py = findOnPath('py');
    if (py) return { cmd: py, args: ['-3.12'] };
    const python = findOnPath('python');
    if (python) return { cmd: python, args: [] };
    throw new Error('找不到 Python 3.12：鲸鲸安装目录下没有 runtime\\python\\python.exe');
  }

  // Python embeddable 版会忽略 PYTHONPATH，sitecustomize 必须放到
  // runtime\python\Lib\site-packages 才会在解释器启动时自动 import。
  _installSitecustomize(home) {
    const src = path.join(PY_PATCH_DIR, 'sitecustomize.py');
    if (!fs.existsSync(src)) return '';
    const dst = path.join(home, 'runtime', 'python', 'Lib', 'site-packages', 'sitecustomize.py');
    try {
      const next = fs.readFileSync(src, 'utf8');
      const old = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
      if (old === next) return dst;
      if (old && old.indexOf('DSH_WHALE_PATCH') < 0) {
        fs.writeFileSync(dst + '.dshbak', old, 'utf8');
      }
      ensureDir(path.dirname(dst));
      fs.writeFileSync(dst, next, 'utf8');
      return dst;
    } catch (e) {
      this._appendLog('安装 sitecustomize 失败：' + ((e && e.message) || e));
      return '';
    }
  }

  // 读当前可见的微信主窗。鲸鲸的 UIA 驱动必须有一个明确的主窗，
  // 双开时如果看到多个主窗，不猜，交给用户关掉一个再启动。
  _findWechatWindows(home, cfg) {
    const py = this._python(home, cfg);
    const script = [
      'import json, win32gui, win32process',
      'rows=[]',
      'def cb(h,_):',
      '  try:',
      '    if not win32gui.IsWindowVisible(h): return',
      "    title=(win32gui.GetWindowText(h) or '').strip()",
      "    if title not in ('微信','Weixin'): return",
      '    cls=win32gui.GetClassName(h) or ""',
      '    rc=win32gui.GetWindowRect(h)',
      '    area=max(0,rc[2]-rc[0])*max(0,rc[3]-rc[1])',
      '    if not win32gui.IsIconic(h) and area < 300*250: return',
      '    rows.append({"hwnd":int(h),"pid":int(win32process.GetWindowThreadProcessId(h)[1]),"title":title,"class":cls,"area":area})',
      '  except Exception: pass',
      'win32gui.EnumWindows(cb,None)',
      "print(json.dumps(rows,ensure_ascii=False))"
    ].join('\n');
    const env = Object.assign(this._childEnv(), { DSH_WHALE_HOME: home });
    try {
      const out = execFileSync(py.cmd, py.args.concat(['-c', script]), {
        cwd: home, env, encoding: 'utf8', timeout: 15000, windowsHide: true
      });
      const rows = JSON.parse(String(out || '').trim() || '[]');
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      this._appendLog('找微信主窗失败：' + ((e && e.message) || e));
      return [];
    }
  }

  _prepareWindow(home, cfg) {
    const rows = this._findWechatWindows(home, cfg);
    let hwnd = 0;
    if (rows.length === 1) hwnd = Number(rows[0].hwnd) || 0;
    if (rows.length > 1) {
      this._appendLog('看到 ' + rows.length + ' 个微信主窗：先只保留小号主窗，否则不启动发送通道');
    }
    cfg.windowHwnd = hwnd;
    return { rows: rows, hwnd: hwnd };
  }

  _writeConfig(cfg) {
    ensureDir(DATA_DIR);
    writeText(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  }

  // 3. 给鲸鲸 config.json 补齐本项目必需的键（不覆盖用户已设的值）
  _patchWhaleConfig(home, cfg) {
    const wc = readWhaleConfig(home);
    const before = JSON.stringify(wc);
    // 原生功能控制面：壳的 cfg.native 是唯一开关处，启动时同步进鲸鲸 config。
    // 「开关开」不等于「能用」：模型 Key 和贴纸素材另算，设置页会把这两项单独标出来。
    const nativeCfg = Object.assign({}, NATIVE_DEFAULTS, (cfg.native && typeof cfg.native === 'object') ? cfg.native : {});

    wc.server = wc.server || {};
    if (!Number(wc.server.port)) wc.server.port = 8787;

    if (!wc.features || typeof wc.features !== 'object') wc.features = {};
    wc.features.javascriptPlugins = true;                 // 换脑插件必需

    wc.gateway = wc.gateway || {};
    wc.gateway.wechat = wc.gateway.wechat || {};
    wc.gateway.wechat.enabled = true;
    if (!wc.gateway.wechat.inboundToken || wc.gateway.wechat.inboundToken === 'change-me-wechat') {
      wc.gateway.wechat.inboundToken = randomHex(32);
    }

    wc.wechat = wc.wechat || {};
    if (cfg.wechatDbDir) wc.wechat.dbDir = String(cfg.wechatDbDir);
    if (cfg.wechatAccount) wc.wechat.account = String(cfg.wechatAccount);
    // 工作台每次启动按当前可见的唯一主窗重新钉；主窗变了就置 0，宁可让桥接
    // 报「账号未确认」，也不拿旧句柄把消息发到另一个账号。
    wc.wechat.windowHwnd = Number(cfg.windowHwnd) || 0;
    wc.wechat.accountGuard = !!nativeCfg.accountGuard;    // 认不出账号宁可不发
    wc.wechat.backgroundSend = !!nativeCfg.backgroundSend; // 后台零焦点发送
    wc.wechat.quoteReply = !!nativeCfg.quoteReply;         // 引用回复会抢前台，默认关

    wc.persona = wc.persona || {};
    if (!wc.persona.name || wc.persona.name === '鲸鲸') {
      wc.persona.name = '胡闹的大肥鱼';
      const aliases = Array.isArray(wc.persona.aliases) ? wc.persona.aliases : [];
      wc.persona.aliases = Array.from(new Set(aliases.concat(['大肥鱼', '肥鱼'])));
    }

    // 鲸鲸的「主动搭话」会走它自己的模型，等于第二个人格 ⇒ 默认关。
    // 要主动找话题请走桌宠/派发链路，不走鲸鲸的 care。
    wc.care = wc.care || {};
    wc.care.enabled = false;
    wc.care.allowGroups = false;
    wc.care.allowOthers = false;

    wc.group = wc.group || {};
    if (wc.group.requireAt === undefined) wc.group.requireAt = true;

    // 提醒是用户明确列出的能力，且没有单独的关闭入口：保持开启。
    // 真要禁用，应在鲸鲸原生设置里操作，不要让它悄悄失效。
    wc.reminder = wc.reminder || {};
    wc.reminder.enabled = true;

    // 原生功能控制面：壳的 cfg.native 是唯一开关处，启动时同步进鲸鲸 config。
    // 「开关开」不等于「能用」：模型 Key 和贴纸素材另算，设置页会把这两项单独标出来。
    if (!wc.voice || typeof wc.voice !== 'object') wc.voice = {};
    wc.voice.enabled = !!nativeCfg.voice;
    // 语音识别必须和聊天 Key 同源。deepseek 官方有 /v1/tools/asr，语音复用聊天 Key；
    // 以前的 follow 模式找不到 settings.json 会静默变成「不支持」，这里把它钉到 deepseek。
    if (!wc.voice.provider || wc.voice.provider === 'follow' || wc.voice.provider === 'auto') {
      wc.voice.provider = 'deepseek';
      wc.voice.baseUrl = 'https://api.deepseek.com/v1/tools/asr';
      wc.voice.model = '';
    }
    if (!wc.vision || typeof wc.vision !== 'object') wc.vision = {};
    // 鲸鲸没有 vision.enabled 这个键，写了也不会读；顺手删掉旧版遗留，
    // 免得界面/配置文件看起来像有一个能关的开关。
    delete wc.vision.enabled;
    if (!wc.links || typeof wc.links !== 'object') wc.links = {};
    wc.links.enabled = !!nativeCfg.links;
    if (!wc.websearch || typeof wc.websearch !== 'object') wc.websearch = {};
    // 本地搜索常开（鲸鲸 loadConfig 会强制 websearch.enabled=true）；
    // 工作台的开关只能落在第三方 API 上，否则是个假开关。
    wc.websearch.enabled = true;
    if (!wc.websearch.api || typeof wc.websearch.api !== 'object') wc.websearch.api = {};
    wc.websearch.api.enabled = !!nativeCfg.websearch;
    wc.features.stickers = !!nativeCfg.stickers;
    // 记忆归属 DSH：鲸鲸自己的 memorySnapshot 会和工作台每聊天独立会话形成两套记忆，
    // 统一关闭；DSH 的会话转录 + 记忆回响插件是唯一记忆源。
    wc.features.memorySnapshot = false;
    wc.features.groupAddressGuard = !!nativeCfg.groupAddressGuard;
    if (!wc.group || typeof wc.group !== 'object') wc.group = {};
    wc.group.silentMinutes = clamp(Number(wc.group.silentMinutes) || 30, 1, 240);
    if (!wc.diary || typeof wc.diary !== 'object') wc.diary = {};
    wc.diary.enabled = !!nativeCfg.diary;
    wc.diary.sendToOwner = !!nativeCfg.diarySend;
    if (!wc.moments || typeof wc.moments !== 'object') wc.moments = {};
    wc.moments.autoReadEveryHours = clamp(Number(nativeCfg.momentsAutoRead) || 0, 0, 24);
    wc.moments.autoLike = !!nativeCfg.momentsAutoLike;
    if (!wc.sticker || typeof wc.sticker !== 'object') wc.sticker = {};
    wc.sticker.collectReceived = true;
    if (wc.sticker.demandChance === undefined) wc.sticker.demandChance = 0.7;

    // 回复长度 / 气泡数：DSH 的回复按 maxChars 截，别让鲸鲸的 140 字先砍一刀；
    // maxBubbles=1 让 finalize 不按逗号拆成多条（拆了工作台这边就看不到完整一条）。
    wc.chat = wc.chat || {};
    const maxChars = Math.max(60, Number(cfg.maxChars) || 300);
    wc.chat.privateMaxChars = maxChars;
    wc.chat.groupMaxChars = maxChars;
    wc.chat.maxBubbles = 1;

    // 语音回复策略是桥接独立文件：显式“发语音”永远优先，Probability=0 只表示不主动加语音。
    // 不给它写文件，界面上即使开了语音回复也永远不会发。
    const vp = readVoicePolicy(home);
    const wanted = {
      enabled: !!nativeCfg.voiceReply,
      private: !!nativeCfg.voiceReplyPrivate,
      groups: !!nativeCfg.voiceReplyGroups,
      probability: Number(nativeCfg.voiceReplyChance) || 0,
      synthTimeoutSec: vp.synthTimeoutSec || 85
    };
    if (!vp.exists || vp.enabled !== wanted.enabled || vp.private !== wanted.private ||
        vp.groups !== wanted.groups || Math.abs(vp.probability - wanted.probability) > 0.01) {
      writeVoicePolicy(home, wanted);
    }

    if (JSON.stringify(wc) !== before) {
      writeWhaleConfig(home, wc);
      this._appendLog('鲸鲸 config.json 已补齐（JS 插件 / 网关 / 账号保护 / 原生功能开关）');
    }
    return wc;
  }

  // 4. 写换脑插件三件套：flow.json + .enabled + flow-grant.json
  _ensurePlugin(home, cfg, adapterPort) {
    const pluginSrc = path.join(PLUGIN_SRC_DIR, 'plugin.js');
    if (!fs.existsSync(pluginSrc)) throw new Error('换脑插件源文件缺失：' + pluginSrc);
    const javascript = fs.readFileSync(pluginSrc, 'utf8');
    const dir = path.join(home, 'data', 'plugins');
    ensureDir(dir);

    const flow = {
      id: PLUGIN_ID,
      name: 'DSH 微信换脑',
      version: '1.1.0',
      author: 'luanyujia-workbench',
      description: '把鲸鲸判定要回复的微信消息转给工作台人格会话，由工作台生成回复；同时旁听群消息，失败不回话。',
      api: 4,
      kind: 'message',
      hooks: ['chat.received', 'chat.generate', 'chat.reply', 'tool.run'],
      permissions: ['system.full'],
      executionTimeoutMs: 118000,
      javascript
    };
    const bytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n', 'utf8');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');

    const flowFile = path.join(dir, PLUGIN_ID + '.flow.json');
    const enabledFile = path.join(dir, PLUGIN_ID + '.enabled');
    const grantFile = path.join(dir, PLUGIN_ID + '.flow-grant.json');

    const writeIfChanged = (file, buf) => {
      try {
        const old = fs.readFileSync(file);
        if (old.equals(buf)) return false;
      } catch (e) { /* 不存在 */ }
      fs.writeFileSync(file, buf);
      return true;
    };

    const changedFlow = writeIfChanged(flowFile, bytes);
    writeIfChanged(enabledFile, Buffer.from('', 'utf8'));
    const grant = {
      hash,
      enabled: true,
      fullAccess: true,
      settings: {
        adapterUrl: 'http://127.0.0.1:' + adapterPort,
        token: String(cfg.adapterToken || '')
      }
    };
    const grantBuf = Buffer.from(JSON.stringify(grant, null, 2) + '\n', 'utf8');
    const changedGrant = writeIfChanged(grantFile, grantBuf);

    return { flowFile, grantFile, hash, changed: changedFlow || changedGrant };
  }

  // 5. 启停 whale_girl（生命周期归壳：只杀自己拉起的子进程，不碰外部实例）
  _childEnv() {
    const env = Object.assign({}, process.env);
    for (const k of ['DSH_TOKEN', 'DSH_WEB_URL', 'DSH_HOME', 'DSH_CUSTOMER_HOME', 'DSH_MACHINE_FILE']) {
      delete env[k];
    }
    return env;
  }

  async _startKernel(home, cfg) {
    const port = this._kernelPort(cfg, home);
    const url = 'http://127.0.0.1:' + port;
    const probe = await httpJson(url + '/healthz', 1200);
    // 鲸鲸 /healthz 不同版本字段不完全一样：service 或 ok 任一命中就先复用，
    // 后面 _enableJs 会真正校验它是不是鲸鲸（不是就会抛错并回滚）。
    const looksWhale = probe.ok && probe.json && (probe.json.service === 'whale-girl' || probe.json.ok === true);
    if (looksWhale) {
      this._appendLog('内核已在跑，复用 127.0.0.1:' + port);
      return { port, adopted: true };
    }
    if (await portOpen(port)) throw new Error('端口 ' + port + ' 已被别的服务占用（不是鲸鲸内核）');

    const node = this._node(home, cfg);
    this._ensureDirs();
    const out = fs.createWriteStream(KERNEL_LOG, { flags: 'a' });
    const child = spawn(node, ['server.js'], {
      cwd: home,
      env: this._childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => this._writeChildLog(out, d));
    child.stderr.on('data', (d) => this._writeChildLog(out, d));
    child.on('error', (e) => this._appendLog('内核 spawn 失败：' + ((e && e.message) || e)));
    child.on('exit', (code, signal) => {
      this._appendLog('内核退出 code=' + code + ' signal=' + (signal || '-'));
      try { out.end(); } catch (e) { /* ignore */ }
      if (this.kernelChild === child) this.kernelChild = null;
    });
    this.kernelChild = child;

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error('鲸鲸内核启动失败（exit ' + child.exitCode + '），看 ' + KERNEL_LOG + '：' +
          tailFile(KERNEL_LOG, 4));
      }
      const r = await httpJson(url + '/healthz', 1200);
      if (r.ok) return { port, adopted: false, child };
      await sleep(500);
    }
    throw new Error('鲸鲸内核 30 秒没起来，看 ' + KERNEL_LOG + '：' + tailFile(KERNEL_LOG, 4));
  }

  async _enableJs(kernelPort) {
    const r = await httpPostJson('http://127.0.0.1:' + kernelPort + '/api/features',
      { key: 'javascriptPlugins', value: true }, 6000);
    if (!r.ok || !r.json || r.json.ok !== true) {
      throw new Error('打开鲸鲸「JavaScript 插件」总开关失败：' +
        ((r.json && r.json.error) || r.error || ('HTTP ' + r.status)));
    }
    return r.json;
  }

  async _startBridge(home, cfg, kernelPort) {
    this._installSitecustomize(home);
    const statusUrl = 'http://127.0.0.1:' + kernelPort + '/api/status';
    const before = await httpJson(statusUrl, 1500);
    const b0 = extractBridge(before.json);
    if (b0 && b0.online === true) {
      this._appendLog('桥接已在跑，复用');
      return { started: false, online: true };
    }

    const py = this._python(home, cfg);
    const whaleCfg = readWhaleConfig(home) || {};
    const wantedAccount = String(cfg.wechatAccount || (whaleCfg.wechat && whaleCfg.wechat.account) || '');
    const accountDbDir = resolveAccountDbDir(String(cfg.wechatDbDir || ''), wantedAccount);
    const env = Object.assign(this._childEnv(), {
      WHALE_BOT_URL: 'http://127.0.0.1:' + kernelPort + '/webhook/wechat',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      DSH_WHALE_HOME: home
    });
    if (accountDbDir) env.DSH_WX_ACCOUNT_DIR = accountDbDir;
    // 官方安装包里的 Python 是 embeddable 版：sys.path 不含 cwd（python312._pth 只列 zip/Lib/site-packages），
    // 所以 `python -m bridge` 必须显式把安装根加进 PYTHONPATH，否则报 No module named bridge。
    const vendor = path.join(home, 'vendor', 'wechatauto');
    const patchDir = fs.existsSync(PY_PATCH_DIR) ? PY_PATCH_DIR : '';
    env.PYTHONPATH = (patchDir ? patchDir + path.delimiter : '') +
      home + (fs.existsSync(vendor) ? path.delimiter + vendor : '') +
      (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');

    const out = fs.createWriteStream(BRIDGE_LOG, { flags: 'a' });
    // 官方安装包的 Python 是 embeddable 版：python312._pth 里的 "." 相对 runtime\python，
    // 不是 cwd；`python -m bridge` 会报 No module named bridge。直接跑 bridge\__main__.py
    // 最稳：它自己把 bridge/ 和 examples/ 塞进 sys.path，再 import engine。
    const bridgeEntry = path.join(home, 'bridge', '__main__.py');
    const args = py.args.concat([bridgeEntry]);
    const child = spawn(py.cmd, args, {
      cwd: home,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => this._writeChildLog(out, d));
    child.stderr.on('data', (d) => this._writeChildLog(out, d));
    child.on('error', (e) => this._appendLog('桥接 spawn 失败：' + ((e && e.message) || e)));
    child.on('exit', (code, signal) => {
      this._appendLog('桥接退出 code=' + code + ' signal=' + (signal || '-'));
      this.bridgeLastExit = { code: code, at: Date.now() };
      try { out.end(); } catch (e) { /* ignore */ }
      if (this.bridgeChild === child) this.bridgeChild = null;
    });
    this.bridgeChild = child;

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return { started: true, online: false, exited: true, code: child.exitCode,
          tail: tailFile(BRIDGE_LOG, 5) };
      }
      const r = await httpJson(statusUrl, 1500);
      const b = extractBridge(r.json);
      if (b && b.online === true) return { started: true, online: true };
      await sleep(500);
    }
    return { started: true, online: false, waiting: true, tail: tailFile(BRIDGE_LOG, 5) };
  }

  _startStatusTimer() {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => {
      this._writeStatus().catch(() => {});
    }, 10000);
    try { this.statusTimer.unref(); } catch (e) { /* ignore */ }
  }

  // 6. 状态快照（社交卡片读 状态.json；自检也用它）
  async _statusSnapshot(cfg, home) {
    const kernelPort = this._kernelPort(cfg, home);
    const adapterPort = this._adapterPort(cfg);
    const kernel = home ? await httpJson('http://127.0.0.1:' + kernelPort + '/healthz', 1200) : { ok: false };
    const kernelOnline = !!(home && kernel.ok && kernel.json &&
      (kernel.json.service === 'whale-girl' || kernel.json.ok === true));

    const status = kernelOnline ? await httpJson('http://127.0.0.1:' + kernelPort + '/api/status', 1800) : { ok: false };
    const bridge = kernelOnline ? extractBridge(status.json) : null;
    const bridgeOnline = !!(bridge && bridge.online === true &&
      (bridge.lastSeenSec === undefined || bridge.lastSeenSec === null || Number(bridge.lastSeenSec) < 45));
    const uia = bridge ? (bridge.uia === undefined ? null : !!bridge.uia) : null;

    const plugin = kernelOnline ? await httpJson('http://127.0.0.1:' + kernelPort + '/api/plugins/status', 1500) : { ok: false };
    const items = (plugin.json && Array.isArray(plugin.json.items)) ? plugin.json.items : [];
    const item = items.find((x) => x && x.id === PLUGIN_ID) || null;
    // 31241 可能由壳主进程在听，也可能是另一个工作台实例/排查进程。自检不能只看
    // 本对象的 serverListening，否则从 CLI 跑自检会误报「适配器没起」。
    let adapterOnline = !!this.serverListening;
    if (!adapterOnline) {
      const ah = await httpJson('http://127.0.0.1:' + adapterPort + '/healthz', 1200);
      adapterOnline = !!(ah.ok && ah.json && ah.json.service === 'dsh-wechat-adapter');
    }

    const wc = readWhaleConfig(home);
    const pinnedAccount = String((wc.wechat && wc.wechat.account) || '');
    const rawAccount = String((bridge && (bridge.account || bridge.account_nick || bridge.accountName || bridge.account_name)) || '');
    const rawWxid = String((bridge && (bridge.account_wxid || bridge.accountWxid || '')) || '');
    const rawNick = String((bridge && (bridge.account_nick || bridge.accountNick || '')) || '');
    const accounts = readWhaleAccounts(home);
    // accounts.json 要等桥接启动才补写；换号后桥接还没起时，直接扫 db_storage 目录兜底。
    const scanned = scanWechatAccounts(String((cfg && cfg.wechatDbDir) || ''));
    for (const a of scanned) {
      const hit = accounts.find(function (x) { return sameAccount(x.account, a.account) || sameAccount(x.wxid, a.account); });
      if (hit) {
        if (!hit.lastActive || a.lastActive > hit.lastActive) hit.lastActive = a.lastActive;
        if (!hit.wxid) hit.wxid = a.wxid;
      } else {
        accounts.push(a);
      }
    }
    if (rawAccount && !accounts.some(function (a) { return sameAccount(a.account, rawAccount) || sameAccount(a.wxid, rawAccount); })) {
      accounts.push({
        account: rawAccount,
        wxid: rawWxid,
        nick: rawNick,
        lastActive: Date.now(),
        label: rawNick ? (rawNick + (rawWxid && rawNick !== rawWxid ? '（' + rawWxid + '）' : '')) : (rawWxid || rawAccount)
      });
    }
    // 配置里钉着、但 accounts.json 还没补到的号也要出现在下拉里，不能让「已钉」看不见。
    if (pinnedAccount && !accounts.some(function (a) { return sameAccount(a.account, pinnedAccount) || sameAccount(a.wxid, pinnedAccount); })) {
      accounts.push({ account: pinnedAccount, wxid: '', nick: '', lastActive: 0, label: pinnedAccount });
    }
    // 桥接刚上报的昵称比 accounts.json 的旧缓存新；当前账号要把「饭团」补到下拉里，
    // 否则小号只显示 wxid，用户会以为选项里没有小号。
    if (rawAccount && rawNick) {
      const current = accounts.find(function (a) { return sameAccount(a.account, rawAccount) || sameAccount(a.wxid, rawAccount); });
      if (current) {
        current.nick = rawNick;
        current.label = rawNick + (rawWxid && rawNick !== rawWxid ? '（' + rawWxid + '）' : '');
      }
    }
    accounts.sort(function (a, b) { return (Number(b.lastActive) || 0) - (Number(a.lastActive) || 0); });
    const rawAccountLabel = labelForAccount(accounts, rawAccount) || rawAccount;
    const pinnedAccountLabel = labelForAccount(accounts, pinnedAccount) || pinnedAccount;
    let accountOk = null;
    if (bridge && typeof bridge.account_ok === 'boolean') accountOk = bridge.account_ok;
    else if (bridge && typeof bridge.accountOk === 'boolean') accountOk = bridge.accountOk;
    else if (rawAccount) accountOk = true;

    const accountMismatch = !!(pinnedAccount && rawAccount && !sameAccount(pinnedAccount, rawAccount));
    const account = rawAccountLabel || (pinnedAccount ? '钉住 ' + pinnedAccountLabel : '未登录/未上报');

    let state = 'off';
    let detail = '';
    if (!home) {
      state = 'off';
      detail = 'whale_girl 未安装（4.1.7 安装包，装到纯英文路径）';
    } else if (!kernelOnline) {
      state = 'warn';
      const autoSkip = !!cfg.autoStart && !pinnedAccount && accounts.length > 0;
      detail = autoSkip
        ? '鲸鲸内核未启动：壳启动时发现本机有 ' + accounts.length + ' 个账号目录但还没选号，已跳过自动启动；先在微信列选小号并保存，再点「启动」'
        : '鲸鲸内核未启动（点「启动」；日志 ' + KERNEL_LOG + '）';
    } else if (!bridgeOnline) {
      state = 'warn';
      detail = '桥接离线：' + (this.bridgeChild ? '进程在但没心跳' : '微信未登录或桥接没起') +
        '（日志 ' + BRIDGE_LOG + '）';
    } else if (uia === false) {
      state = 'warn';
      detail = '桥接在线，但 UIA 不可用：能收不能发（看 whale-bridge.log）';
    } else if (!item) {
      state = 'warn';
      detail = '换脑插件未加载（确认鲸鲸 JavaScript 插件总开关已开）';
    } else if (!this.serverListening && !adapterOnline) {
      state = 'warn';
      detail = '本机适配器未启动（点「启动」）';
    } else if (accountMismatch) {
      state = 'warn';
      detail = '当前账号 ' + rawAccount + ' 与钉住的 ' + pinnedAccount + ' 不一致';
    } else if (!rawAccount) {
      state = 'warn';
      detail = '账号未上报（登录后看 whale-bridge.log）';
    } else {
      state = 'ok';
      detail = '内核 / 桥接 / 插件 / 适配器就绪';
    }

    const bridgeTail = (home ? tailFile(path.join(home, 'data', 'wechat-bridge-4x.log'), 4) : '') ||
      tailFile(BRIDGE_LOG, 4);

    return {
      ok: true,
      at: Date.now(),
      installed: !!home,
      running: !!(kernelOnline || bridgeOnline || this.serverListening),
      state,
      detail,
      home: home || '',
      homeError: '',
      kernel: { online: kernelOnline, port: kernelPort },
      bridge: {
        online: bridgeOnline,
        lastSeenSec: bridge ? bridge.lastSeenSec : null,
        uia: uia,
        ffmpeg: bridge ? bridge.ffmpeg : null,
        processAlive: !!(this.bridgeChild && this.bridgeChild.exitCode === null),
        tail: this._redact(bridgeTail)
      },
      account: account,
      rawAccount: rawAccount,
      accountLabel: rawAccountLabel,
      accountOk: accountOk,
      pinnedAccount: pinnedAccount,
      pinnedAccountLabel: pinnedAccountLabel,
      windowHwnd: Number(cfg.windowHwnd) || 0,
      accountMismatch: accountMismatch,
      accounts: accounts.map(function (a) {
        return Object.assign({}, a, {
          current: sameAccount(a.account, rawAccount) || sameAccount(a.wxid, rawAccount),
          pinned: !!pinnedAccount && (sameAccount(a.account, pinnedAccount) || sameAccount(a.wxid, pinnedAccount))
        });
      }),
      plugin: {
        id: PLUGIN_ID,
        enabled: !!(plugin.json && plugin.json.enabled),
        loaded: !!item,
        hooks: item ? item.hooks : [],
        active: plugin.json ? plugin.json.active : null,
        workers: plugin.json ? plugin.json.workers : null
      },
      adapter: { online: adapterOnline, port: adapterPort },
      adapterPort: adapterPort,
      kernelPort: kernelPort,
      version: (status.json && status.json.version) || '',
      persona: (status.json && status.json.name) || '',
      sessionIsolation: sessionIsolationView(cfg),
      groupListen: listenStats(),
      counts: Object.assign({}, this.counts),
      gate: { attached: !!this.gate, blocked: Number(this.counts.blocked) || 0, last: this.lastGate },
      lastSend: this.lastSend,
      configFile: CONFIG_FILE,
      statusFile: STATUS_FILE,
      logFile: LOG_FILE
    };
  }

  async _writeStatus() {
    if (this.writing) return this.lastStatus;
    this.writing = true;
    try {
      const cfg = this.config();
      const h = this._home(cfg);
      const snap = await this._statusSnapshot(cfg, h.home);
      snap.homeError = h.error || '';
      this.lastStatus = snap;
      writeText(STATUS_FILE, JSON.stringify(snap, null, 2) + '\n');
      return snap;
    } catch (e) {
      this._appendLog('写状态失败：' + ((e && e.message) || e));
      return this.lastStatus;
    } finally {
      this.writing = false;
    }
  }

  // 7. 对外：status / start / stop / autoStart
  async status() {
    const snap = await this._writeStatus();
    return Object.assign({ ok: !!snap }, snap || { error: '状态读取失败' });
  }

  // 8. 设置面板：只暴露接入微信真正有用的参数；不返回 token、不返回任意配置。
  //   账号仍走 pinAccount（要同时钉窗口并重启桥接），不混进这里的批量保存。
  async settingsGet() {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const wc = readWhaleConfig(h.home);
    let status = null;
    try { status = await this.status(); } catch (e) { status = { ok: false, error: String((e && e.message) || e) }; }
    const view = settingsView(cfg, wc, h.home);
    const vp = readVoicePolicy(h.home);
    const qwen = readQwenImage(h.home);
    let qwenCategoryCount = 0;
    try {
      const qdir = path.join(h.home, 'data', 'stickers', qwen.category);
      if (fs.existsSync(qdir)) {
        qwenCategoryCount = fs.readdirSync(qdir, { withFileTypes: true })
          .filter((x) => x && x.isFile() && /\.(?:png|jpg|jpeg|gif|webp)$/i.test(x.name)).length;
      }
    } catch (e) { qwenCategoryCount = 0; }
    view.stickerGen = {
      apiKeyConfigured: qwen.apiKeyConfigured,
      model: qwen.model,
      baseUrl: qwen.baseUrl,
      category: qwen.category,
      chat: qwen.chat,
      categoryCount: qwenCategoryCount,
      configFile: qwen.file,
      updatedAt: qwen.updatedAt
    };

    // 语音回复策略文件的真实值优先于壳默认值：界面必须显示「桥接会不会真的发语音」。
    view.native.voiceReply = vp.exists ? vp.enabled : !!view.native.voiceReply;
    view.native.voiceReplyPrivate = vp.exists ? vp.private : !!view.native.voiceReplyPrivate;
    view.native.voiceReplyGroups = vp.exists ? vp.groups : !!view.native.voiceReplyGroups;
    view.native.voiceReplyChance = vp.exists ? vp.probability : Number(view.native.voiceReplyChance) || 0;

    const port = this._kernelPort(cfg, h.home);
    const online = !!(status && status.kernel && status.kernel.online);
    let moments = null;
    let reminders = null;
    let diaryRuntime = null;
    let publish = null;
    if (online) {
      const base = 'http://127.0.0.1:' + port;
      const [m, r, d, p] = await Promise.all([
        httpJson(base + '/api/moments/latest', 1800),
        httpJson(base + '/api/reminders', 1800),
        httpJson(base + '/api/diary', 1800),
        httpJson(base + '/api/moments/publish-settings', 6000)
      ]);
      moments = (m && m.ok && m.json && m.json.snapshot) || null;
      reminders = (r && r.ok && r.json) || null;
      diaryRuntime = (d && d.ok && d.json) || null;
      publish = (p && p.ok && p.json) || null;
    }
    const diary = Object.assign({}, diaryStats(h.home), {
      runtime: diaryRuntime,
      enabled: !!view.native.diary,
      sendToOwner: !!view.native.diarySend
    });
    const rem = Object.assign({}, remindersStats(h.home), reminders || {});
    if (Array.isArray(rem.items)) {
      rem.items = rem.items.filter((x) => x && (String(x.status || '') === '' || /pending|waiting|due/i.test(String(x.status || ''))))
        .slice(0, 8)
        .map((x) => ({
          id: String(x.id || ''),
          text: String(x.text || '').slice(0, 80),
          dueAt: Number(x.dueAt || x.at || 0) || 0,
          status: String(x.status || '')
        }));
      rem.pending = rem.items.length;
    }
    return {
      ok: true,
      config: view,
      status: status,
      nativeFiles: {
        stickers: stickerStats(h.home),
        vision: { apiKeyConfigured: !!view.native.visionKeyConfigured, baseUrl: String((wc.vision && wc.vision.baseUrl) || ''), model: String((wc.vision && wc.vision.model) || '') },
        voice: { apiKeyConfigured: !!view.native.voiceKeyConfigured, provider: String((wc.voice && wc.voice.provider) || '') }
      },
      nativeState: {
        voicePolicy: vp,
        moments: moments,
        publish: publish,
        reminders: rem,
        diary: diary,
        groupListen: listenStats(),
        version: whaleVersion(h.home)
      },
      paths: {
        whaleHome: h.home,
        configFile: path.join(h.home, 'config.json'),
        shellConfig: CONFIG_FILE,
        logDir: WORK_DIR,
        diaryDir: diary.dir,
        voicePolicy: vp.file,
        launcher: path.join(h.home, 'WhaleLauncher.exe')
      }
    };
  }

  // 10.2 千问表情包：生成和发送都归工作台通道，不把 Key 放进仓库，也不走人手操作微信。
  //     生成：调本机 Node 工具（工具/表情包生成.mjs）→ 写 concept 图同目录；
  //     入库：走鲸鲸原生 /api/stickers/upload；
  //     发送：走 /api/stickers/test 的同一套表情包队列，桥接负责落屏和结果回执。
  async stickerGenerate(args) {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const qwen = readQwenImage(h.home);
    const apiKey = String((args && args.apiKey) || qwen.apiKey || '').trim();
    const category = String((args && args.category) || qwen.category || '').replace(/[\\/:*?"<>|]/g, '').slice(0, 20);
    if (!apiKey) return { ok: false, error: '千问 Key 未配置：先在「功能」页填 Key 并保存' };
    if (!category) return { ok: false, error: '表情包分类名为空' };
    const tool = path.join(ROOT, '工具', '表情包生成.mjs');
    if (!fs.existsSync(tool)) return { ok: false, error: '生成工具缺失：' + tool };
    const node = String(cfg.whaleNode || '').trim() || findOnPath('node') || 'node';
    const model = String((args && args.model) || qwen.model || 'qwen-image-2.1-pro');
    const ref = path.join(SHELL, 'pet3d', '概念', '07-气氛图.png');
    const out = path.join(SHELL, 'pet3d', '表情包', '鲸鲸千问');
    const only = args && args.only ? String(args.only) : '';
    const env = Object.assign({}, process.env, { QWEN_API_KEY: apiKey,
      QWEN_IMAGE_ENDPOINT: qwen.baseUrl || '' });
    const childArgs = [tool, '--model', model, '--ref', ref, '--out', out];
    if (only) childArgs.push('--only', only);
    const run = await new Promise((resolve) => {
      execFile(node, childArgs, { cwd: ROOT, env: env, timeout: 260000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error: error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    if (run.error) {
      return { ok: false, error: '千问生成失败：' + (run.stderr.trim() || run.error.message || String(run.error)) };
    }
    let generated = null;
    try { generated = JSON.parse(run.stdout.trim()); } catch (e) { /* fall through */ }
    if (!generated || generated.ok !== true || !Array.isArray(generated.files) || !generated.files.length) {
      return { ok: false, error: '千问生成没有返回可用图片：' + run.stdout.slice(0, 300) };
    }

    const base = 'http://127.0.0.1:' + this._kernelPort(cfg, h.home);
    const made = await httpPostJson(base + '/api/stickers/category', { action: 'add', label: category }, 8000);
    if (!made.ok && !/已经有这个分类/.test(String(made.error || ''))) {
      return { ok: false, error: '创建表情分类失败：' + (made.error || 'HTTP ' + made.status) };
    }
    const uploaded = [];
    for (const file of generated.files) {
      let bytes;
      try { bytes = fs.readFileSync(file.path); } catch (e) { return { ok: false, error: '读取生成图失败：' + file.path }; }
      const up = await httpPostJson(base + '/api/stickers/upload', {
        emotion: 'x:' + category,
        files: [{ name: file.name, data: bytes.toString('base64') }]
      }, 60000);
      if (!up.ok) return { ok: false, error: '表情入库失败（' + file.name + '）：' + (up.error || 'HTTP ' + up.status) };
      uploaded.push((up.json && up.json.uploaded && up.json.uploaded[0]) || { name: file.name });
    }
    return { ok: true, category: category, model: model, dir: generated.dir, files: generated.files, uploaded: uploaded };
  }

  async stickerSend(args) {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const qwen = readQwenImage(h.home);
    const category = String((args && args.category) || qwen.category || '').trim();
    const chat = String((args && args.chat) || qwen.chat || '').trim();
    if (!category) return { ok: false, error: '表情分类名为空' };
    if (!chat) return { ok: false, error: '目标私聊为空' };
    const base = 'http://127.0.0.1:' + this._kernelPort(cfg, h.home);
    const test = await httpPostJson(base + '/api/stickers/test', {
      emotion: 'x:' + category,
      chat: chat
    }, 10000);
    if (!test.ok) return { ok: false, error: '排队发送失败：' + (test.error || 'HTTP ' + test.status) };
    const queued = test.json && test.json.queued;
    if (!queued || !queued.id) return { ok: false, error: '表情队列没有返回任务 id' };
    let last = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const st = await httpJson(base + '/api/stickers/status?queueOnly=1', 1500);
      const jobs = (st.json && st.json.jobs) || [];
      last = jobs.find((x) => x && x.id === queued.id) || null;
      if (last && ['confirmed', 'failed', 'cancelled', 'unconfirmed'].includes(String(last.status))) break;
    }
    const status = String((last && last.status) || 'pending');
    return {
      ok: status === 'confirmed',
      status: status,
      chat: chat,
      category: category,
      job: { id: queued.id, path: queued.path, status: status, error: String((last && last.error) || '') }
    };
  }

  // 看图的真实可用性只有发一次请求才知道；UI 的「测试看图」走这里。
  // 用鲸鲸内置 64x64 测试图，不碰微信消息，也不把 Key 回显到前端。
  async visionTest() {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const base = 'http://127.0.0.1:' + this._kernelPort(cfg, h.home);
    const r = await httpPostJson(base + '/api/vision/test', {}, 45000);
    const j = (r && r.json) || {};
    if (!r || !r.ok || !j.ok) {
      return {
        ok: false,
        error: String((j && j.error) || (r && (r.error || ('HTTP ' + r.status))) || '视觉接口不可达'),
        vision: (j && j.vision) || {}
      };
    }
    return { ok: true, sample: String(j.sample || ''), vision: j.vision || {} };
  }

  // 10.1 朋友圈 / 日记 / 提醒：直接复用鲸鲸本机接口，不另造一套业务。
  //     鲸鲸接口只接受 loopback，工作台壳和它同机；朋友圈动作会让微信前台导航，UI 必须二次确认。
  async _whaleApi(method, apiPath, body, timeoutMs) {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const base = 'http://127.0.0.1:' + this._kernelPort(cfg, h.home);
    const r = method === 'POST'
      ? await httpPostJson(base + apiPath, body || {}, timeoutMs || 8000)
      : await httpJson(base + apiPath, timeoutMs || 6000);
    if (!r || !r.ok) return { ok: false, error: (r && (r.error || ('HTTP ' + r.status))) || '接口不可达' };
    return Object.assign({ ok: true, httpStatus: r.status }, r.json || {});
  }

  async momentsRead(args) {
    const body = args || {};
    return this._whaleApi('POST', '/api/moments/read', {
      limit: asInt(body.limit, 1, 50, 20),
      keyword: String(body.keyword || '').slice(0, 100),
      username: String(body.username || '').slice(0, 120),
      own: body.own === true,
      account: String(body.account || '')
    }, 9000);
  }

  async momentsAction(args) {
    const body = args || {};
    const action = ['like', 'unlike', 'comment', 'reply'].includes(String(body.action)) ? String(body.action) : '';
    if (!action) return { ok: false, error: '朋友圈动作只支持 like / unlike / comment / reply' };
    if (!String(body.publisher || '').trim() || !String(body.keyword || '').trim()) {
      return { ok: false, error: '请填写发布者昵称和动态正文关键词' };
    }
    if ((action === 'comment' || action === 'reply') && !String(body.content || '').trim()) {
      return { ok: false, error: '评论/回复内容不能为空' };
    }
    if (action === 'reply' && !String(body.replyTo || '').trim()) {
      return { ok: false, error: '回复需要填写被回复者昵称' };
    }
    return this._whaleApi('POST', '/api/moments/action', {
      action: action,
      publisher: String(body.publisher).slice(0, 120),
      keyword: String(body.keyword).slice(0, 100),
      content: String(body.content || '').slice(0, 1000),
      replyTo: String(body.replyTo || '').slice(0, 120),
      account: String(body.account || '')
    }, 9000);
  }

  async momentsResult(id) {
    if (!String(id || '').trim()) return { ok: false, error: '缺少任务 id' };
    return this._whaleApi('GET', '/api/moments/result?id=' + encodeURIComponent(String(id)), null, 4000);
  }

  async diaryGenerate() {
    return this._whaleApi('POST', '/api/diary/generate', {}, 5000);
  }

  async diaryRead() {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const stats = diaryStats(h.home);
    let text = '';
    if (stats.latest) {
      try { text = fs.readFileSync(stats.latest.file, 'utf8').slice(0, 4000); } catch (e) { text = ''; }
    }
    return { ok: true, diary: stats, text: text };
  }

  async remindersList() {
    return this._whaleApi('GET', '/api/reminders', null, 5000);
  }

  async reminderCancel(id) {
    if (!String(id || '').trim()) return { ok: false, error: '缺少提醒 id' };
    return this._whaleApi('POST', '/api/reminders/cancel', { id: String(id) }, 5000);
  }

  async momentsSnapshot() {
    return this._whaleApi('GET', '/api/moments/latest', null, 5000);
  }

  async saveSettings(args) {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const wc = readWhaleConfig(h.home);
    const sg = args && args.stickerGen && typeof args.stickerGen === 'object' ? args.stickerGen : null;
    let qwenChanged = false;
    if (sg && (sg.apiKey !== undefined || sg.model !== undefined || sg.category !== undefined || sg.chat !== undefined)) {
      writeQwenImage(h.home, sg);
      qwenChanged = true;
    }
    const applied = applySettings(args || {}, cfg, wc);
    if (!applied.changed.length && !qwenChanged) {
      return { ok: true, saved: false, changed: [], restartRequired: false, message: '没有需要保存的修改' };
    }

    try {
      if (applied.shellChanged) this._writeConfig(cfg);
      if (applied.whaleChanged) writeWhaleConfig(h.home, wc);
      const n = (args && args.native) || {};
      if (Object.prototype.hasOwnProperty.call(n, 'voiceReply') ||
          Object.prototype.hasOwnProperty.call(n, 'voiceReplyPrivate') ||
          Object.prototype.hasOwnProperty.call(n, 'voiceReplyGroups') ||
          Object.prototype.hasOwnProperty.call(n, 'voiceReplyChance')) {
        const cur = readVoicePolicy(h.home);
        writeVoicePolicy(h.home, {
          enabled: asBool((cfg.native || {}).voiceReply, true),
          private: asBool((cfg.native || {}).voiceReplyPrivate, true),
          groups: asBool((cfg.native || {}).voiceReplyGroups, false),
          probability: asInt((cfg.native || {}).voiceReplyChance, 0, 100, 0),
          synthTimeoutSec: cur.synthTimeoutSec || 85
        });
      }
    } catch (e) {
      this._appendLog('保存设置失败：' + ((e && e.message) || e));
      return { ok: false, error: '写入配置失败：' + ((e && e.message) || e) };
    }

    const restartRequired = applied.changed.some((k) => k !== 'autoStart');
    let started = null;
    if (args && args.restart === true) {
      try {
        if (this.serverListening || this.bridgeChild || this.kernelChild) {
          await this.stop();
          await sleep(500);
        }
        started = await this.start();
      } catch (e) {
        started = { ok: false, error: String((e && e.message) || e) };
      }
    }

    return {
      ok: !started || started.ok !== false,
      saved: true,
      changed: applied.changed.concat(qwenChanged ? ['stickerGen'] : []),
      restartRequired: restartRequired,
      restarted: !!(args && args.restart === true),
      start: started,
      status: started && started.status ? started.status : null,
      error: started && started.ok === false ? ('已保存，但重启失败：' + (started.error || '未知原因')) : ''
    };
  }

  async start() {
    this._ensureDirs();
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };

    try {
      this._installSitecustomize(h.home);
      const win = this._prepareWindow(h.home, cfg);
      this._writeConfig(cfg);
      if (cfg.wechatAccount && !win.hwnd) {
        this._appendLog('已选账号但没找到唯一微信主窗：先把小号主窗打开、关掉另一个微信窗口');
      }
      this._patchWhaleConfig(h.home, cfg);
      const plugin = this._ensurePlugin(h.home, cfg, this._adapterPort(cfg));
      const kernel = await this._startKernel(h.home, cfg);
      await this._enableJs(kernel.port);
      // 先把适配器立起来，再起桥接：避免桥接刚上线那几秒收到消息却没人接。
      await this._startAdapter(cfg);
      const bridge = await this._startBridge(h.home, cfg, kernel.port);
      this.startedAt = this.startedAt || Date.now();
      this._startStatusTimer();
      const snap = await this._writeStatus();
      this._appendLog('start ok kernel=' + kernel.port + ' bridgeOnline=' + bridge.online +
        ' plugin=' + (plugin.changed ? 'written' : 'unchanged'));
      return {
        ok: true,
        home: h.home,
        kernelPort: kernel.port,
        kernelAdopted: kernel.adopted,
        bridge: bridge,
        adapterPort: this._adapterPort(cfg),
        plugin: plugin,
        status: snap
      };
    } catch (e) {
      this._appendLog('start failed：' + ((e && e.message) || e));
      this._stopChildren();
      this._stopAdapter();
      await this._writeStatus();
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  _stopChildren() {
    if (this.bridgeChild) {
      const pid = this.bridgeChild.pid;
      this.bridgeChild = null;
      killTree(pid);
    }
    if (this.kernelChild) {
      const pid = this.kernelChild.pid;
      this.kernelChild = null;
      killTree(pid);
    }
  }

  _stopAdapter() {
    if (this.server) {
      try { this.server.close(); } catch (e) { /* ignore */ }
      this.server = null;
    }
    this.serverListening = false;
  }

  async stop() {
    this._stopAdapter();
    this._stopChildren();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.startedAt = 0;
    await this._writeStatus();
    return { ok: true };
  }

  async autoStart() {
    try {
      const cfg = this.config();
      if (!cfg.autoStart) return { ok: true, skipped: 'autoStart=false' };
      const h = this._home(cfg);
      if (!h.home) return { ok: false, error: h.error };
      // 双开/换号后 accounts.json 可能还是旧的；未选号就不自动接，
      // 避免壳一启动就按「最近活跃」接到主号。当前小号已经钉住时才会自动起。
      const snap = await this._statusSnapshot(cfg, h.home);
      const accounts = Array.isArray(snap.accounts) ? snap.accounts : [];
      if (!snap.pinnedAccount && accounts.length > 0) {
        this._appendLog('autoStart 跳过：微信账号未钉（为不碰主号，先在面板选小号并保存账号）');
        return { ok: true, skipped: 'account-not-pinned', accounts: accounts.length };
      }
      return await this.start();
    } catch (e) {
      this._appendLog('autoStart 失败：' + ((e && e.message) || e));
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // 8. 自检：有 bad 就是「过不了」，warn 是「还没实测/待确认」
  async selfCheck() {
    const cfg = this.config();
    const h = this._home(cfg);
    const snap = await this._statusSnapshot(cfg, h.home);

    let session = { ok: false, title: cfg.sessionTitle, id: '', file: '', error: '' };
    let sessionLib = null;
    let sessionSessions = null;
    try {
      const lib = await this._lib();
      const sessions = lib.loadSessions();
      sessionLib = lib;
      sessionSessions = sessions;
      const s = lib.resolveSession(sessions, cfg.sessionTitle);
      if (!s) {
        session.error = '找不到标题为「' + cfg.sessionTitle + '」的会话（先建会话/换会话）';
      } else {
        const file = lib.transcriptOf(s.id);
        session.id = s.id;
        session.file = file || '';
        session.ok = !!file;
        if (!file) session.error = '找到会话但转录文件不存在：' + s.id;
      }
    } catch (e) {
      session.error = '读会话失败：' + ((e && e.message) || e);
    }

    const checks = [];
    const add = (key, label, level, detail) => checks.push({ key, label, level, detail });

    add('home', '鲸鲸已安装', h.home ? 'ok' : 'bad',
      h.home || h.error);

    add('kernel', '鲸鲸内核', snap.kernel.online ? 'ok' : 'bad',
      snap.kernel.online ? ('127.0.0.1:' + snap.kernel.port + ' · v' + (snap.version || '?')) :
        ('127.0.0.1:' + snap.kernel.port + ' 没在听'));

    add('bridge', '微信桥接', snap.bridge.online ? 'ok' : (snap.bridge.processAlive ? 'warn' : 'bad'),
      snap.bridge.online ? ('心跳 ' + (snap.bridge.lastSeenSec == null ? '?' : snap.bridge.lastSeenSec) + ' 秒前') :
        (snap.bridge.processAlive ? '进程在，心跳还没到（启动要 20–60 秒；等一会儿再自检）' :
          '离线：微信未登录或桥接没起'));

    add('uia', '发送通道 UIA', snap.bridge.uia === true ? 'ok' : (snap.bridge.uia === false ? 'bad' : 'warn'),
      snap.bridge.uia === true ? 'UIA 可用（后台发送优先）' :
        (snap.bridge.uia === false ? 'UIA 不可用：能收不能发' : '桥接没上报 UIA 状态'));

    let accountLevel = 'ok';
    let accountDetail = '';
    const accountCount = Array.isArray(snap.accounts) ? snap.accounts.length : 0;
    if (snap.accountOk === false) { accountLevel = 'bad'; accountDetail = '账号校验失败（看 whale-bridge.log）'; }
    else if (snap.accountMismatch) { accountLevel = 'bad'; accountDetail = '当前 ' + (snap.accountLabel || snap.rawAccount) + ' ≠ 钉住 ' + (snap.pinnedAccountLabel || snap.pinnedAccount); }
    else if (!snap.rawAccount) { accountLevel = 'warn'; accountDetail = '未上报账号；启动后微信列下拉会列出本机登录的号'; }
    else if (!snap.pinnedAccount) {
      accountLevel = 'warn';
      accountDetail = '本机登录 ' + accountCount + ' 个微信账号（当前 ' + (snap.accountLabel || snap.rawAccount) + '）；在微信列下拉选小号后点「保存账号」';
    } else { accountDetail = (snap.accountLabel || snap.rawAccount) + '（已钉住）'; }
    add('account', '微信账号', accountLevel, accountDetail);

    // 视觉没有总开关：配了 Key 就生效，缺 Key 时图片/表情理解会失败。
    const wcNow = h.home ? readWhaleConfig(h.home) : {};
    const visionReadyNow = h.home ? visionReady(h.home, wcNow) : false;
    add('vision', '图片 / 贴纸理解', visionReadyNow ? 'ok' : 'warn',
      visionReadyNow ? '视觉可用（专属 Key 或聊天同源视觉）' : '缺视觉 Key，且聊天服务商没有可复用的视觉模型；图片/表情只会收到占位说明');

    // 会话过滤：默认 allowAll=true（先接通）；要收窄就在 微信通道.json 里改。
    const chats = Array.isArray(cfg.allowedChats) ? cfg.allowedChats.map(String) : [];
    let filterLevel = 'ok';
    let filterDetail = '';
    if (cfg.allowAll === true) {
      filterDetail = '允许所有私聊/群聊（allowAll=true）；要收窄改 微信通道.json 的 allowedChats';
    } else if (!chats.length) {
      filterLevel = 'bad';
      filterDetail = 'allowAll=false 且 allowedChats 为空：所有消息都会被拒';
    } else if (chats.includes('*')) {
      filterDetail = '通配 *：允许所有会话';
    } else {
      filterDetail = '仅允许：' + chats.slice(0, 4).join(' / ') + (chats.length > 4 ? ' 等 ' + chats.length + ' 个' : '');
    }
    add('filter', '会话过滤', filterLevel, filterDetail);

    add('plugin', '换脑插件', snap.plugin.loaded ? 'ok' : 'bad',
      snap.plugin.loaded ? ('已加载 · ' + (snap.plugin.hooks || []).join(' / ')) :
        (snap.plugin.enabled ? '总开关已开，但插件没加载（看 通道.log）' : 'JavaScript 插件总开关没开'));

    const adapterOk = !!(snap.adapter && snap.adapter.online) || this.serverListening;
    add('adapter', '本机适配器', adapterOk ? 'ok' : 'bad',
      adapterOk ? ('127.0.0.1:' + snap.adapterPort + ' 在听') : '31241 适配器没起（点「启动」）');

    add('session', '工作台人格会话', session.ok ? 'ok' : 'bad',
      session.ok ? (session.title + ' · ' + session.id.slice(0, 12)) : (session.error || '读不到会话'));

    // 会话隔离自检不只看「开关写了 per-chat」：要看真实映射表里每条会话是否还在、
    // 有没有首条消息后还没生成转录。群/私聊混进同一个会话时，这里才能被看见。
    let isoLevel = 'ok';
    let isoDetail = '';
    const iso = snap.sessionIsolation || sessionIsolationView(cfg);
    if (String(iso.mode || 'per-chat') === 'shared') {
      isoLevel = 'bad';
      isoDetail = 'sessionMode=shared：私聊/群聊会共用「' + cfg.sessionTitle + '」，消息会串';
    } else if (!iso.count) {
      isoLevel = 'warn';
      isoDetail = '已启用 per-chat；还没有微信独立会话，发第一条私聊/群聊（需要工作台回的那条）后自动建';
    } else {
      let missing = 0;
      let noFile = 0;
      if (!sessionLib || !sessionSessions) {
        isoLevel = 'warn';
        isoDetail = '映射表有 ' + iso.count + ' 条，但读不到 DSH 会话库，无法核对（先在设置页刷新映射）';
      } else {
        for (const item of (iso.items || [])) {
          const sid = String(item.sessionId || '');
          if (!sid || !sessionSessions.has(sid)) missing++;
          else if (!sessionLib.transcriptOf(sid)) noFile++;
        }
      }
      if (missing) {
        isoLevel = 'bad';
        isoDetail = '有 ' + missing + ' 条映射指向不存在的 DSH 会话（重新发一条消息会按标题认回/重建）';
      } else if (noFile) {
        isoLevel = 'warn';
        isoDetail = '已建 ' + iso.count + ' 个独立会话；其中 ' + noFile + ' 个还没写出转录（等首轮跑完）';
      } else {
        isoDetail = '已生效 · 群 ' + iso.groups + ' / 私聊 ' + iso.privates + ' · 共 ' + iso.count + ' 个独立会话';
      }
    }
    add('isolation', '会话隔离', isoLevel, isoDetail);

    // 群聊旁听要能看到“真的在记”：插件必须有 chat.received 钩子，目录里要有记录。
    const gl = snap.groupListen || listenStats();
    const hasListenHook = (snap.plugin.hooks || []).includes('chat.received');
    let glLevel = 'warn';
    let glDetail = '插件没挂 chat.received：群里没被叫到的消息不会进旁听';
    if (hasListenHook) {
      if (gl.records > 0) {
        glLevel = 'ok';
        glDetail = '已记录 ' + gl.groups + ' 个群 / ' + gl.records + ' 条；最近 ' +
          (gl.latestAt ? new Date(gl.latestAt).toLocaleTimeString('zh-CN') : '未写入');
      } else {
        glDetail = '钩子已挂，还没有群消息；群里发一条（不 @ 也行）就会落盘';
      }
    } else if (snap.plugin.loaded) {
      glLevel = 'bad';
    }
    add('groupListen', '群聊旁听', glLevel, glDetail);

    let sendLevel = 'bad';
    let sendDetail = '';
    const last = snap.lastSend || this.lastSend || null;
    const lastFresh = !!(last && Number(last.at) && Date.now() - Number(last.at) < 10 * 60 * 1000);
    // CLI/外部脚本发完会写一条「发送成功」，但壳的 10 秒状态轮询只认自己的
    // lastSend，容易把刚成功的发送覆盖成「未实测」。这里以桥接日志为准兜底。
    let bridgeSend = '';
    try {
      const st = fs.statSync(BRIDGE_LOG);
      if (Date.now() - st.mtimeMs < 15 * 60 * 1000) {
        const text = fs.readFileSync(BRIDGE_LOG, 'utf8').slice(-8000);
        const lines = text.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/^\[(\d{2}):(\d{2}):(\d{2})\].*发送成功（/);
          if (!m) continue;
          const now = new Date();
          const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
            Number(m[1]), Number(m[2]), Number(m[3])).getTime();
          let diff = Date.now() - at;
          if (diff < -60 * 1000) diff += 24 * 60 * 60 * 1000;
          if (diff >= 0 && diff < 15 * 60 * 1000) bridgeSend = m[0].slice(0, 60);
          break;
        }
      }
    } catch (e) { bridgeSend = ''; }
    if (!snap.bridge.online) {
      sendLevel = snap.bridge.processAlive ? 'warn' : 'bad';
      sendDetail = snap.bridge.processAlive ? '桥接启动中，心跳未到；等一会儿再试' : '桥接没在线';
    } else if (snap.bridge.uia === false) sendDetail = 'UIA 不可用';
    else if (snap.accountOk === false) sendDetail = '账号校验失败';
    else if (lastFresh && last.confirmed === true) {
      sendLevel = 'ok';
      sendDetail = '已实测 confirmed（' + new Date(Number(last.at)).toLocaleTimeString('zh-CN') + '）';
    } else if (lastFresh && last.error) {
      sendLevel = 'warn';
      sendDetail = '上次测试失败：' + String(last.error).slice(0, 120);
    } else if (bridgeSend) {
      sendLevel = 'ok';
      sendDetail = '桥接日志显示真实发送成功：' + bridgeSend;
    } else {
      sendLevel = 'warn';
      sendDetail = '就绪，未实测；点「发测试消息」看文件传输助手';
    }
    add('send', '真实发送', sendLevel, sendDetail);

    const bad = checks.filter((c) => c.level === 'bad').length;
    const warn = checks.filter((c) => c.level === 'warn').length;
    const ok = checks.length - bad - warn;
    const state = bad ? 'bad' : (warn ? 'warn' : 'ok');
    const summary = ok + ' 通过 · ' + warn + ' 待确认 · ' + bad + ' 不通';

    this._appendLog('selfcheck ' + state + ' ' + summary);
    return {
      ok: state !== 'bad',
      state,
      summary,
      checks,
      session,
      sessionIsolation: iso,
      snapshot: snap,
      at: Date.now()
    };
  }

  // 9. 发一条测试消息（走鲸鲸插件 → 账号保护 → 桥接队列；不绕过任何闸门）
  async sendTest(args) {
    const cfg = this.config();
    const h = this._home(cfg);
    const fail = async (error) => {
      this.lastSend = { at: Date.now(), confirmed: false, status: 'failed', error: String(error || '').slice(0, 240) };
      try { await this._writeStatus(); } catch (e) { /* ignore */ }
      return { ok: false, error: error };
    };
    if (!h.home) return await fail(h.error);
    const port = this._kernelPort(cfg, h.home);
    const health = await httpJson('http://127.0.0.1:' + port + '/healthz', 1200);
    if (!health.ok) return await fail('鲸鲸内核没在跑（127.0.0.1:' + port + '）');

    const plugin = await httpJson('http://127.0.0.1:' + port + '/api/plugins/status', 1500);
    const item = ((plugin.json && plugin.json.items) || []).find((x) => x && x.id === PLUGIN_ID);
    if (!item) return await fail('换脑插件没加载（先开 JavaScript 插件总开关）');

    // 桥接刚起来时 UIA 可能还在热激活（日志会写「微信窗口未唤醒」）；这时把消息塞进队列
    // 有可能一直排在 pending。先等 UIA 就绪，最多 60 秒，避免把「还没准备好」当成「发送失败」。
    let uiaReady = false;
    for (let i = 0; i < 12; i++) {
      const st = await httpJson('http://127.0.0.1:' + port + '/api/status', 1500);
      const b = extractBridge(st.json);
      if (b && b.online === true && b.uia !== false) { uiaReady = true; break; }
      await sleep(5000);
    }
    if (!uiaReady) return await fail('发送通道 UIA 还没就绪（桥接在线但没唤醒）；等自检「发送通道 UIA」变绿再试');

    const a = args || {};
    let text = String(a.text || ('微信通道自检 ' + new Date().toLocaleTimeString('zh-CN')));
    // 自检消息也是真发出去的消息：同一道闸门，不许留后门
    if (this.gate && typeof this.gate.check === 'function') {
      const g = this.gate.check(text, { channel: 'wechat', chatType: 'private', chatId: 'filehelper' });
      if (g.verdict === 'block') {
        return await fail('本机安全闸门拦下了这条测试消息（规则 ' + (g.rules || []).join('|') + '）：换一句不含地址/路径/密钥的话');
      }
      if (g.verdict === 'redact') text = g.text;
    }
    const name = String(a.chat || '文件传输助手');
    const chatId = String(a.chatId || 'filehelper');
    // 记录发送前的桥接日志偏移：鲸鲸的 delivery 常常停在 pending，但桥接日志会写
    // 「发送成功（后台通道）」。这是比 delivery 更硬的落屏证据，也能给面板一个明确结论。
    let logOffset = 0;
    try { logOffset = fs.statSync(BRIDGE_LOG).size; } catch (e) { logOffset = 0; }
    const r = await httpPostJson('http://127.0.0.1:' + port + '/api/plugins/run', {
      id: PLUGIN_ID,
      input: { action: 'sendTest', chatId, name, text }
    }, 125000);

    const result = (r.json && r.json.result) || null;
    if (!r.ok || !r.json || r.json.ok !== true) {
      return await fail((r.json && r.json.error) || r.error || ('HTTP ' + r.status));
    }
    if (result && result.ok === false) {
      return await fail(result.error || '插件发送失败');
    }

    const delivery0 = (result && result.delivery) || null;
    const submitted = (result && result.submitted) || null;
    let delivery = delivery0;
    const isConfirmed = (d) => {
      const s = String((d && d.status) || '');
      return !!(d && (d.confirmed === true || ['confirmed', 'sent', 'delivered'].includes(s)));
    };
    let confirmed = isConfirmed(delivery);
    // 鲸鲸 sendText 返回 queued，delivery 一开始是 pending；实战里 3 秒左右才变 sent。
    // 多轮询几次，别让面板把「已经落屏」误报成「未确认」。
    if (!confirmed && submitted && submitted.id) {
      for (let i = 0; i < 4 && !confirmed; i++) {
        await sleep(3000);
        const q = await httpPostJson('http://127.0.0.1:' + port + '/api/plugins/run', {
          id: PLUGIN_ID,
          input: { action: 'delivery', id: submitted.id }
        }, 30000);
        const d2 = q.json && q.json.result && q.json.result.delivery;
        if (d2) {
          delivery = d2;
          confirmed = isConfirmed(d2);
          if (/failed|error|denied|uipi/i.test(String(d2.status || ''))) break;
        }
      }
    }
    const ds = String((delivery && delivery.status) || '');
    const dError = (delivery && delivery.error) || '';
    let logSent = false;
    // 后台发送常常 3–20 秒才在鲸鲸自己的日志里写「发送成功」；多等几拍，
    // 避免把刚落屏的消息误报成「未确认」。
    for (let i = 0; i < 8 && !logSent; i++) {
      try {
        const st = fs.statSync(BRIDGE_LOG);
        if (st.size > logOffset) {
          const chunk = fs.readFileSync(BRIDGE_LOG, { start: logOffset, end: st.size }).toString('utf8');
          logSent = /发送成功（|result=submitted reason=sent/.test(chunk);
        }
      } catch (e) { logSent = false; }
      if (!logSent) await sleep(2000);
    }
    if (!confirmed && logSent) {
      confirmed = true;
      delivery = Object.assign({}, delivery || {}, { status: 'sent', confirmed: true, source: 'bridge-log' });
    }
    const failed = /failed|error|denied|uipi/i.test(ds) || (!!dError && !confirmed);
    const finalStatus = confirmed ? (/(confirmed|sent|delivered)/.test(ds) ? ds : 'sent') : (ds || 'queued');
    this.lastSend = {
      at: Date.now(), confirmed: confirmed, status: finalStatus,
      id: (submitted && submitted.id) || '',
      error: failed ? String(dError || ds || '发送失败').slice(0, 240) : ''
    };
    await this._writeStatus();
    if (failed) return { ok: false, error: this.lastSend.error, submitted: submitted, delivery: delivery, text: text };
    return {
      ok: true,
      submitted: submitted,
      delivery: delivery,
      confirmed: confirmed,
      text
    };
  }

  // 10. 选/钉微信账号（双开时必做；写配置 + 重启自己拉起的桥接）
  // args.account = 账号目录或 wxid；显式传空串 = 取消钉住、回到「最近活跃」自动选。
  async pinAccount(args) {
    const cfg = this.config();
    const h = this._home(cfg);
    if (!h.home) return { ok: false, error: h.error };
    const snap = await this._statusSnapshot(cfg, h.home);
    const hasArg = !!(args && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, 'account'));
    const requested = hasArg ? String(args.account || '').trim() : '';
    const raw = String(snap.rawAccount || '').trim();
    const accounts = Array.isArray(snap.accounts) ? snap.accounts : [];
    let target = raw;
    let targetLabel = snap.accountLabel || raw;
    if (hasArg) {
      if (!requested) {
        target = '';
        targetLabel = '自动（最近活跃）';
      } else {
        const hit = accounts.find(function (a) {
          return sameAccount(a.account, requested) || sameAccount(a.wxid, requested);
        });
        if (hit) {
          target = hit.account || requested;
          targetLabel = hit.label || target;
        } else if (sameAccount(raw, requested)) {
          target = raw;
          targetLabel = snap.accountLabel || raw;
        } else {
          return { ok: false, error: '选中的账号不在本机已登录列表：先启动通道/等桥接同步账号，再刷新' };
        }
      }
    } else {
      if (!raw) {
        return { ok: false, error: '桥接没上报当前账号：先在鲸鲸启动器「微信桥接」页点一下账号卡，或看 whale-bridge.log' };
      }
      target = raw;
      targetLabel = snap.accountLabel || raw;
    }

    const port = snap.kernelPort;
    // 账号必须和「窗口」一起钉：鲸鲸只认 config 里的 account + windowHwnd。
    // 这里顺手把工作台自己的选择持久化，壳重启 autoStart 才能知道接哪个号。
    const win = this._prepareWindow(h.home, cfg);
    cfg.wechatAccount = target;
    cfg.windowHwnd = win.hwnd;
    this._writeConfig(cfg);

    let patched = false;
    if (snap.kernel.online) {
      const r = await httpPostJson('http://127.0.0.1:' + port + '/api/config',
        { patch: { wechat: { account: target, windowHwnd: win.hwnd } } }, 5000);
      patched = !!(r.ok && r.json && r.json.ok !== false);
    }

    const wc = readWhaleConfig(h.home);
    wc.wechat = wc.wechat || {};
    wc.wechat.account = target;
    wc.wechat.windowHwnd = win.hwnd;
    writeWhaleConfig(h.home, wc);

    let restarted = false;
    let note = '';
    if (!win.hwnd && target) {
      note = '已保存账号，但没找到唯一微信主窗：先只留小号主窗、关掉另一个微信窗口，再启动';
    } else if (!snap.kernel.online) {
      note = '内核未启动：已写入本地配置，点「启动」后按这个账号选';
    } else if (this.bridgeChild) {
      const pid = this.bridgeChild.pid;
      this.bridgeChild = null;
      killTree(pid);
      await sleep(500);
      const b = await this._startBridge(h.home, cfg, port);
      restarted = true;
      note = b.online ? '桥接已重启并连上' : '桥接已重启，等待微信心跳';
    } else {
      note = '桥接是外部启动的：请在鲸鲸启动器点「重启桥接」生效';
    }
    await this._writeStatus();
    return { ok: true, account: target, accountLabel: targetLabel, patched, restarted, note };
  }

  // 11. 适配器 HTTP：只监听 127.0.0.1，只认 x-wx-token
  async _startAdapter(cfg) {
    if (this.serverListening) return;
    const port = this._adapterPort(cfg);
    if (await portOpen(port)) {
      throw new Error('适配器端口 ' + port + ' 已被占用（可能是上一个工作台实例；先退出旧实例）');
    }

    this.server = http.createServer((req, res) => {
      Promise.resolve(this._route(req, res)).catch((e) => {
        this._appendLog('adapter route 异常：' + ((e && e.message) || e));
        jsonReply(res, 500, { ok: false, error: 'adapter_error' });
      });
    });
    this.server.on('error', (e) => {
      this._appendLog('adapter error：' + ((e && e.message) || e));
    });
    await new Promise((resolve, reject) => {
      const onError = (e) => { reject(e); };
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        this.serverListening = true;
        this._appendLog('adapter 在听 127.0.0.1:' + port);
        resolve();
      });
    });
  }

  async _route(req, res) {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/healthz') {
      return jsonReply(res, 200, { ok: true, up: true, service: 'dsh-wechat-adapter', at: Date.now() });
    }
    if (req.method === 'GET' && u.pathname === '/status') {
      const snap = await this._writeStatus();
      return jsonReply(res, 200, Object.assign({ ok: true }, snap || {}));
    }
    if (req.method === 'POST' && u.pathname === '/api/social/wechat') {
      return this._handleInbound(req, res);
    }
    if (req.method === 'POST' && u.pathname === '/api/social/wechat/listen') {
      return this._handleListen(req, res);
    }
    return jsonReply(res, 404, { ok: false, error: 'not_found' });
  }

  _authorized(req, cfg) {
    const token = String(req.headers['x-wx-token'] || '');
    const auth = String(req.headers.authorization || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    return safeEq(token || bearer, cfg.adapterToken);
  }

  async _handleInbound(req, res) {
    const cfg = this.config();
    if (!this._authorized(req, cfg)) {
      this.counts.errors++;
      this.counts.lastError = 'unauthorized';
      return jsonReply(res, 401, { ok: false, error: 'unauthorized' });
    }

    let body = '';
    try {
      body = await readBody(req, 1024 * 1024);
    } catch (e) {
      return jsonReply(res, 413, { ok: false, error: (e && e.code) || 'body_error' });
    }

    let p = null;
    try { p = JSON.parse(body); } catch (e) {
      return jsonReply(res, 400, { ok: false, error: 'invalid_json' });
    }

    const text = String((p && (p.text || p.content)) || '').trim();
    if (!text) return jsonReply(res, 200, { ok: true, text: '', skipped: 'empty' });

    const payload = {
      chatId: String(p.chat_id || p.chatId || ''),
      chatType: String(p.chat_type || p.chatType || 'private') === 'group' ? 'group' : 'private',
      chatTitle: String(p.chat_title || p.chatTitle || ''),
      senderId: String(p.sender_id || p.senderId || ''),
      senderName: String(p.sender_name || p.senderName || ''),
      groupMembers: Array.isArray(p.group_members || p.groupMembers)
        ? (p.group_members || p.groupMembers).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 60)
        : [],
      msgId: String(p.msg_id || p.msgId || ''),
      atMe: !!(p.at_me || p.atMe),
      // 鲸鲸原生链路已经算好的上下文：链接正文、联网/热榜摘要、语音诉求。
      // DSH 接管后如果丢掉这些，原生功能虽然开着，模型却看不见。
      linkText: String(p.link_text || p.linkText || '').slice(0, 4000),
      searchText: String(p.search_text || p.searchText || '').slice(0, 4000),
      voiceRequested: !!(p.voice_requested || p.voiceRequested),
      history: Array.isArray(p.history)
        ? p.history.slice(-12).map((h) => ({
          role: String((h && h.role) || '').slice(0, 12),
          text: String((h && h.text) || '').slice(0, 300)
        })).filter((h) => h.text)
        : [],
      text
    };

    const key = payload.msgId ||
      (payload.chatId + '|' + payload.senderId + '|' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 16));
    const now = Date.now();
    const old = this.seen.get(key);
    if (old && now - old < (payload.msgId ? 600000 : 5000)) {
      this.counts.skipped++;
      return jsonReply(res, 200, { ok: true, text: '', skipped: 'duplicate' });
    }
    this.seen.set(key, now);
    if (this.seen.size > 2000) {
      for (const [k, v] of this.seen) if (now - v > 600000) this.seen.delete(k);
    }

    if (!this._allowed(cfg, payload)) {
      this.counts.skipped++;
      this._appendLog('skip whitelist chat=' + shortHash(payload.chatId));
      return jsonReply(res, 200, { ok: true, text: '', skipped: 'whitelist' });
    }
    if (!this._rateOk(cfg)) {
      this.counts.skipped++;
      return jsonReply(res, 200, { ok: true, text: '', skipped: 'rate' });
    }

    this.counts.rx++;
    this.counts.lastAt = now;
    this.counts.lastChat = shortHash(payload.chatId);

    const task = this.chain.then(() => this._reply(payload, cfg));
    this.chain = task.catch(() => {});
    try {
      const r = await task;
      return jsonReply(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      this.counts.errors++;
      this.counts.lastError = String((e && e.message) || e).slice(0, 240);
      this._appendLog('reply failed chat=' + shortHash(payload.chatId) + '：' + this.counts.lastError);
      return jsonReply(res, 200, { ok: false, error: this.counts.lastError, text: '' });
    }
  }

  // 群聊旁听：只记消息，不回复。插件在 chat.received 阶段调用，所以群里
  // 没被叫到的消息也会进最近上下文；DSH 真正被叫到时由 _formatPrompt 取用。
  async _handleListen(req, res) {
    const cfg = this.config();
    if (!this._authorized(req, cfg)) {
      this.counts.errors++;
      this.counts.lastError = 'listen_unauthorized';
      return jsonReply(res, 401, { ok: false, error: 'unauthorized' });
    }
    let body = '';
    try {
      body = await readBody(req, 256 * 1024);
    } catch (e) {
      return jsonReply(res, 413, { ok: false, error: (e && e.code) || 'body_error' });
    }
    let p = null;
    try { p = JSON.parse(body); } catch (e) {
      return jsonReply(res, 400, { ok: false, error: 'invalid_json' });
    }
    if (!p || String(p.chat_type || p.chatType || '') !== 'group') {
      return jsonReply(res, 200, { ok: true, recorded: false, skipped: 'not_group' });
    }
    const chatId = String(p.chat_id || p.chatId || '').trim();
    const text = String(p.text || p.content || '').trim().slice(0, 2000);
    if (!chatId || !text) {
      return jsonReply(res, 200, { ok: true, recorded: false, skipped: 'empty' });
    }
    const msgId = String(p.msg_id || p.msgId || '').trim();
    const key = msgId || (chatId + '|' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 16));
    const now = Date.now();
    const old = this.listenSeen.get(key);
    if (old && now - old < 600000) {
      return jsonReply(res, 200, { ok: true, recorded: false, skipped: 'duplicate' });
    }
    this.listenSeen.set(key, now);
    if (this.listenSeen.size > 2000) {
      for (const [k, v] of this.listenSeen) if (now - v > 600000) this.listenSeen.delete(k);
    }
    const rec = {
      chatId: chatId,
      chatTitle: String(p.chat_title || p.chatTitle || '').slice(0, 80),
      senderId: String(p.sender_id || p.senderId || '').slice(0, 120),
      senderName: String(p.sender_name || p.senderName || '').slice(0, 80),
      text: text,
      at: now,
      msgId: msgId
    };
    const recorded = appendListenRecord(rec);
    if (!recorded) this._appendLog('旁听记录写入失败 chat=' + shortHash(chatId));
    return jsonReply(res, 200, { ok: true, recorded: recorded });
  }

  _allowed(cfg, p) {
    if (cfg.allowAll === true) return true;
    const list = Array.isArray(cfg.allowedChats) ? cfg.allowedChats.map(String) : [];
    if (!list.length) return false;
    return list.some((x) => x === '*' || x === p.chatId || x === p.chatTitle || x === p.senderName);
  }

  _rateOk(cfg) {
    const limit = Math.max(1, Number(cfg.ratePerMinute) || 8);
    const now = Date.now();
    while (this.rate.length && now - this.rate[0] > 60000) this.rate.shift();
    if (this.rate.length >= limit) return false;
    this.rate.push(now);
    return true;
  }

  // 12. 一轮微信 → DSH：投消息、按 marker 找本轮、等 turn/end、取最后一条 assistant 正文
  async _lib() {
    if (this.libCache) return this.libCache;
    if (this.base) process.env.DSH_WEB_URL = this.base;
    if (this.dshHome) process.env.DSH_HOME = this.dshHome;
    this.libCache = await import(pathToFileURL(LIB_FILE).href);
    return this.libCache;
  }

  _maxChars(cfg, chatType) {
    const wc = readWhaleConfig(this._home(cfg).home);
    const chat = wc.chat || {};
    const base = chatType === 'group'
      ? (Number(chat.groupMaxChars) || 70)
      : (Number(chat.privateMaxChars) || 140);
    const bubbles = clamp(Number(chat.maxBubbles) || 2, 1, 4);
    const cap = Math.max(40, Number(cfg.maxChars) || 300);
    return Math.max(40, Math.min(cap, base * bubbles));
  }

  _formatPrompt(p, cfg, max, marker) {
    const kind = p.chatType === 'group'
      ? '群聊「' + (p.chatTitle || '群聊') + '」'
      : '私聊';
    const who = p.senderName || '对方';
    const roster = p.chatType === 'group' && Array.isArray(p.groupMembers) && p.groupMembers.length
      ? '\n群成员：' + p.groupMembers.slice(0, 30).join('、')
      : '';
    const nativeCfg = Object.assign({}, NATIVE_DEFAULTS, (cfg && cfg.native) || {});
    const context = [];
    // 群聊“旁听记忆”：插件在 chat.received 阶段把每条群消息落盘（连没被叫到的也记），
    // 这里取最近 24 条作为上下文，比鲸鲸 store 的 12 条更完整；当前这条单独在 prompt 里，
    // 从旁听记录中剔掉，避免同一句话重复两遍。
    if (p.chatType === 'group') {
      const heard = readListenRecords(p.chatId, 30).filter((r) => {
        if (!r || !r.text) return false;
        if (String(r.text) !== String(p.text || '')) return true;
        if (p.senderId && r.senderId && String(r.senderId) !== String(p.senderId)) return true;
        return false;
      }).slice(-24);
      if (heard.length) {
        const recent = heard.map((r) => {
          const who = r.senderName || '群友';
          return who + '：' + String(r.text).slice(0, 300);
        });
        context.push('\n[群聊旁听记录 · 最近 ' + recent.length + ' 条]\n' + recent.join('\n'));
      } else if (Array.isArray(p.history) && p.history.length) {
        // 旁听文件还没写入（刚接通/旧会话）时退回鲸鲸的 history，不让上下文断档。
        const recent = p.history.slice(-8).map((h) => (h.role === 'assistant' ? '我' : '对方') + '：' + h.text);
        context.push('\n[最近群聊上下文]\n' + recent.join('\n'));
      }
    }
    if (p.linkText) {
      context.push('\n[链接已抽取]\n' + String(p.linkText).slice(0, 2000));
    }
    if (p.searchText) {
      context.push('\n[联网检索结果]\n' + String(p.searchText).slice(0, 2000));
    }
    if (p.voiceRequested) {
      context.push('\n[语音消息已转写] 对方发的是语音，本条按语音语境回复；语音回复由通道按设置合成，不要解释技术细节。');
    }
    const sticker = nativeCfg.stickers
      ? '\n[表情包] 需要配表情包时，在正文最后单独附一个 [[sticker:happy]] 或 [[sticker:angry]] 或 [[sticker:cute]]；程序会剥掉标记并补图。不要自己发图片或解释标记。'
      : '';
    return '（微信' + kind + ' · ' + who + ' 说）\n' + p.text + roster + context.join('') +
      '\n\n[通道] 这是微信真实对话。直接回复对方，只输出要发出去的那条消息；' +
      '不要解释系统/工具，不要 @ 任何人，控制在 ' + max + ' 字内。' + sticker + '\n' + marker;
  }

  _workspaceId() {
    const j = readJson(path.join(this.dshHome, 'storages', 'workspace.json')) || {};
    const tbl = (j.tables && j.tables.workspaces) || {};
    const target = normalizePath(WORKSPACE_DIR);
    for (const [id, v] of Object.entries(tbl)) {
      if (v && normalizePath(v.path) === target) return id;
    }
    return '';
  }

  async _engineRpc(method, args) {
    const base = String(this.base || process.env.DSH_WEB_URL || '').replace(/\/+$/, '');
    if (!base) throw new Error('DSH 引擎地址未注入，无法建微信独立会话');
    const lib = await this._lib();
    const cookie = await lib.getCookie();
    const r = await fetch(base + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'wx-' + shortHash(Date.now() + method),
        method: method,
        payload: { args: args || {} }
      })
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { /* 下面按原文报 */ }
    // 引擎 RPC 外层是 {type, rpcId, result:{ok, value}}；不能拿顶层 ok 判断。
    const result = j && j.result ? j.result : null;
    if (!r.ok || !result || result.ok !== true) {
      throw new Error('引擎 ' + method + ' 失败（HTTP ' + r.status + '）：' +
        ((result && (result.error || result.message)) || txt.slice(0, 160) || '无返回'));
    }
    return result.value !== undefined ? result.value : result;
  }

  _chatKey(p) {
    return String((p && (p.chatId || p.chatTitle)) || 'unknown');
  }

  _chatSessionTitle(cfg, p) {
    const kind = p.chatType === 'group' ? '群' : '私聊';
    const name = chatTitlePart(p.chatTitle || p.senderName || p.chatId, 34) || (kind === '群' ? '未命名群' : '对方');
    const prefix = chatTitlePart(cfg.sessionTitle || '胡闹的大肥鱼', 24) || '胡闹的大肥鱼';
    return prefix + ' · ' + kind + ' · ' + name + ' · ' + shortHash(p.chatId).slice(0, 6);
  }

  async _createChatSession(cfg, p, title) {
    ensureDir(WORKSPACE_DIR);
    const ws = this._workspaceId();
    const req = ws ? { workspaceId: ws } : { cwd: WORKSPACE_DIR };
    const created = await this._engineRpc('session/create', { request: req });
    const id = String(created.sessionId || created.id || (created.value && created.value.sessionId) || '');
    if (!id) throw new Error('引擎 session/create 没返回 sessionId');
    let renamed = true;
    try {
      await this._engineRpc('session/rename', { request: { sessionId: id, title: title } });
    } catch (e) {
      renamed = false;
      this._appendLog('建微信会话后改名失败：' + ((e && e.message) || e));
    }
    const map = readChatMap();
    const key = this._chatKey(p);
    map.chats[key] = {
      chatId: String(p.chatId || key),
      chatType: p.chatType === 'group' ? 'group' : 'private',
      chatTitle: String(p.chatTitle || p.senderName || ''),
      title: title,
      sessionId: id,
      createdAt: Date.now(),
      lastAt: Date.now(),
      lastTurn: 0,
      lastSender: String(p.senderName || '')
    };
    writeChatMap(map, this.dshHome);
    this._appendLog('建微信独立会话 chat=' + shortHash(p.chatId) + ' type=' + p.chatType +
      ' session=' + id + (renamed ? '' : '（标题未改成）'));
    return { id: id, title: title, created: true };
  }

  // 选择/创建这个私聊或群聊专属的 DSH 会话。绝不回落到工作台人格会话，
  // 否则不同群/私聊的上下文会串，用户看不出来但回复已经错位。
  async _resolveChatSession(cfg, p) {
    const lib = await this._lib();
    if (String(cfg.sessionMode || 'per-chat') === 'shared') {
      const sessionsShared = lib.loadSessions();
      const base = lib.resolveSession(sessionsShared, cfg.sessionTitle);
      if (!base) throw new Error('找不到 DSH 会话「' + cfg.sessionTitle + '」');
      return { id: base.id, title: base.title, created: false };
    }

    const key = this._chatKey(p);
    const wantTitle = this._chatSessionTitle(cfg, p);
    const map = readChatMap();
    const item = map.chats[key];
    const sessions = lib.loadSessions();

    if (item && item.sessionId) {
      const hit = lib.resolveSession(sessions, String(item.sessionId));
      if (hit) {
        if (!item.title || item.title !== hit.title) {
          item.title = hit.title || item.title;
          item.lastAt = Date.now();
          writeChatMap(map, this.dshHome);
        }
        return { id: hit.id, title: hit.title || wantTitle, created: false };
      }
    }
    // 映射丢了但同名会话还在（例如手工重命名/换机后重建）：先认回，不重复建。
    const byTitle = lib.resolveSession(sessions, wantTitle);
    if (byTitle) {
      map.chats[key] = {
        chatId: String(p.chatId || key),
        chatType: p.chatType === 'group' ? 'group' : 'private',
        chatTitle: String(p.chatTitle || p.senderName || ''),
        title: byTitle.title || wantTitle,
        sessionId: byTitle.id,
        createdAt: Number((item && item.createdAt) || Date.now()),
        lastAt: Date.now(),
        lastTurn: Number((item && item.lastTurn) || 0),
        lastSender: String(p.senderName || '')
      };
      writeChatMap(map, this.dshHome);
      return { id: byTitle.id, title: byTitle.title || wantTitle, created: false };
    }
    return await this._createChatSession(cfg, p, wantTitle);
  }

  _touchChatSession(p, turn, textLen) {
    const key = this._chatKey(p);
    const map = readChatMap();
    if (!map.chats[key]) return;
    map.chats[key].lastAt = Date.now();
    map.chats[key].lastTurn = Number(turn || 0);
    map.chats[key].lastSender = String(p.senderName || '');
    map.chats[key].lastLen = Number(textLen || 0);
    writeChatMap(map, this.dshHome);
  }

  _clean(text, max) {
    let t = String(text || '').replace(/\r/g, '').trim();
    // 鲸鲸插件的输出校验会拒 control chars / 双向控制符 / @所有人；这里先清掉，
    // 否则插件判 invalid_output 会退回鲸鲸自己的模型（等于第二人格说话）。
    t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
    t = t.replace(/[@＠][\s\u200B-\u200D\u2060\uFEFF]*\*(?:所有人|全体成员|all)(?![\p{L}\p{N}.])/giu, '');
    t = t.replace(/〔WX#[0-9a-f]{8}〕/gi, '');
    // 表情包标记不能在这里删：DSH 的文本要原样交给鲸鲸 finalize，
    // 由它剥掉标记并挂 stickerCategory；这里删了等于出站表情包永远发不出去。
    t = t.replace(/\[\[(?!sticker:)[^\]]+\]\]/gi, '');
    t = t.replace(/\(\(\s*silence[^)]*\)\)/gi, '');
    t = t.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
    t = t.replace(/^\s*[@＠][^\s，,。:：]+\s*/, '');
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    if (!t) return '';
    const chars = Array.from(t);
    if (chars.length > max) {
      const cut = chars.slice(0, Math.max(1, max - 1)).join('');
      const idx = Math.max(
        cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
        cut.lastIndexOf('；'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf(';')
      );
      const body = idx >= Math.floor(max * 0.5) ? cut.slice(0, idx + 1) : cut;
      t = body.replace(/[\s，,、]+$/, '') + '…';
    }
    return t;
  }

  async _reply(p, cfg) {
    const max = this._maxChars(cfg, p.chatType);
    const marker = '〔WX#' + crypto.randomBytes(4).toString('hex') + '〕';
    const prompt = this._formatPrompt(p, cfg, max, marker);
    const started = Date.now();
    const r = await this._callSession(cfg, p, prompt, marker, cfg.replyTimeoutMs);
    let text = this._clean(r.text, max);
    if (!text) {
      this.counts.skipped++;
      this._appendLog('reply empty chat=' + shortHash(p.chatId) + ' type=' + p.chatType +
        ' session=' + String(r.sessionId || '') + ' timeout=' + !!r.timeout +
        ' turn=' + (r.turn || 0));
      return { ok: true, text: '', skipped: r.timeout ? 'timeout' : 'empty_reply', turn: r.turn || 0 };
    }
    // 外发安全闸门：先审再截断（截在前会把 IP 截成半截，反而更难判）。
    // block ⇒ 换成固定安全话术（不静默消失）；redact ⇒ 用打码正文；shadow ⇒ pass 但闸门已记日志。
    let gated = null;
    if (this.gate && typeof this.gate.check === 'function') {
      gated = this.gate.check(text, { channel: 'wechat', chatType: p.chatType, chatId: p.chatId });
      this.lastGate = { at: Date.now(), verdict: gated.verdict, rules: (gated.rules || []).slice(0, 8) };
      if (gated.verdict === 'block') {
        this.counts.blocked = (Number(this.counts.blocked) || 0) + 1;
        const fallback = this._clean(String(gated.fallback || '这个我在这儿不方便说～'), max);
        this._appendLog('reply blocked rules=' + (gated.rules || []).join('|') +
          ' chat=' + shortHash(p.chatId) + ' type=' + p.chatType + ' turn=' + (r.turn || 0));
        text = fallback;
        if (!text) {
          this.counts.skipped++;
          return { ok: true, text: '', skipped: 'blocked', turn: r.turn || 0 };
        }
      } else if (gated.verdict === 'redact') {
        text = this._clean(gated.text, max);
        this._appendLog('reply redacted rules=' + (gated.rules || []).join('|') +
          ' chat=' + shortHash(p.chatId) + ' type=' + p.chatType + ' turn=' + (r.turn || 0));
      }
    }
    this.counts.replied++;
    this.counts.lastAt = Date.now();
    this.counts.lastChat = shortHash(p.chatId);
    this._touchChatSession(p, r.turn || 0, text.length);
    this._appendLog('reply chat=' + shortHash(p.chatId) + ' type=' + p.chatType +
      ' session=' + String(r.sessionId || '') + ' len=' + text.length +
      ' ms=' + (Date.now() - started) + ' turn=' + (r.turn || 0) +
      (gated ? ' gate=' + gated.verdict : ''));
    return { ok: true, text, turn: r.turn || 0, ms: Date.now() - started };
  }

  async _callSession(cfg, p, prompt, marker, timeoutMs) {
    const token = String(this.getToken() || '');
    if (!token) throw new Error('壳还没拿到引擎 token（等引擎就绪后再试）');
    process.env.DSH_TOKEN = token;

    const lib = await this._lib();
    const s = await this._resolveChatSession(cfg, p);
    let file = lib.transcriptOf(s.id);
    let before = 0;
    if (file) {
      for (let i = 0; i < 3; i++) {
        const ev = lib.readEvents(file);
        if (ev) {
          const st = lib.turnStats(ev) || {};
          before = Number(st.lastTurn) || 0;
          break;
        }
        await sleep(200);
      }
    }

    const cookie = await lib.getCookie();
    await lib.promptSession(s.id, prompt, cookie);

    const deadline = Date.now() + clamp(Number(timeoutMs) || 110000, 20000, 118000);
    let lastSize = -1;
    let markerTurn = 0;
    while (Date.now() < deadline) {
      await sleep(350);
      // 动态新建的会话在首轮 prompt 前没有 transcript；不能在投递前就判死，
      // 要等引擎把第一帧写出来再按 marker 找 turn。
      if (!file) file = lib.transcriptOf(s.id);
      if (!file) continue;
      let stat = null;
      try { stat = fs.statSync(file); } catch (e) { continue; }
      if (stat.size === lastSize) continue;
      lastSize = stat.size;
      const events = lib.readEvents(file);
      if (!events) continue;
      if (!markerTurn) markerTurn = findMarkerTurn(events, marker);
      if (markerTurn && events.some((e) => e.type === 'turn/end' &&
        Number(e.data && e.data.turn) === markerTurn)) {
        return {
          text: lib.finalTextOf(events, markerTurn),
          turn: markerTurn,
          timeout: false,
          sessionId: s.id,
          sessionTitle: s.title,
          created: !!s.created
        };
      }
    }
    this._appendLog('session timeout marker=' + marker + ' before=' + before + ' markerTurn=' + markerTurn +
      ' session=' + s.id + ' type=' + p.chatType);
    return { text: '', turn: markerTurn || 0, timeout: true, sessionId: s.id, sessionTitle: s.title, created: !!s.created };
  }
}

function createService(opts) {
  return new WechatService(opts);
}

module.exports = {
  createService,
  WechatService,
  readConfig,
  ensureConfig,
  CONFIG_FILE,
  STATUS_FILE,
  LOG_FILE,
  PLUGIN_ID,
  DEFAULT_ADAPTER_PORT,
  // 群聊旁听的落盘/读取：给 CLI 排查和本地测试用，不对外暴露 HTTP。
  appendListenRecord,
  readListenRecords,
  listenStats,
  listenFilePath
};

// CLI 只用于本地排查（工作台运行中不要用 start，避免抢 31241）：
//   node 外壳\微信通道.js status
//   node 外壳\微信通道.js selfcheck
//   node 外壳\微信通道.js sticker-generate
//   node 外壳\微信通道.js sticker-send --chat "静音胡闹"
if (require.main === module) {
  const cmd = String(process.argv[2] || 'status');
  const cli = (name) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
  };
  const svc = createService({});
  const run = async () => {
    if (cmd === 'status') return svc.status();
    if (cmd === 'selfcheck') return svc.selfCheck();
    if (cmd === 'stop') return svc.stop();
    if (cmd === 'sticker-generate') return svc.stickerGenerate({
      apiKey: String(process.env.QWEN_API_KEY || ''),
      category: cli('category')
    });
    if (cmd === 'sticker-send') return svc.stickerSend({
      chat: cli('chat'),
      category: cli('category')
    });
    return { ok: false, error: '用法：node 微信通道.js status|selfcheck|stop|sticker-generate|sticker-send' };
  };
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); }).catch((e) => {
    console.error((e && e.stack) || e);
    process.exitCode = 1;
  });
}
