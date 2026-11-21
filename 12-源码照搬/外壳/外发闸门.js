'use strict';
// 外发闸门（2026-11-18）—— 所有「她发到工作台之外」的消息，从这里过。
//
// 为什么要有它：提示词只能降低概率，管不住上下文里本来就带着的
//   `C:\Users\<用户名>\...`、`127.0.0.1:3083`、token、sessionId —— 模型复述一遍就出去了。
// 所以这里把「判定」做成确定性代码，并挂在每个通道**唯一**的发送出口上：
//   · QQ：本机代理 3100 → SnowLuma 的 OneBot HTTP；插件 onebotHttp 指过来，换地址也绕不过。
//   · 微信：微信通道.js 的 _reply() 返回正文之前调 check()。
//   · 飞书：dsh-im 直连 open.feishu.cn，出站不可拦；接线前必须换成自己的发送器（见说明文档）。
// 失败一律默认拒绝（fail-closed）：判不清、打码失败、附件类型不认识 ⇒ 不发。
//
// 判据唯一出处就是本文件；工具\外发闸门.mjs 只是它的命令行壳，供自检 / 手工审一条。
// 数据（全部在本机、不入库，12-源码照搬/.gitignore 的 外壳/data/ 挡着）：
//   外壳\data\安全闸门.json         配置（模式 / 渠道开关 / 每类规则动作 / 回话）
//   外壳\data\安全资产.json         本机资产指纹（网卡 IP、主机名、用户、路径、凭据）
//   外壳\data\安全闸门\状态.json    给面板看的状态（10 秒内新鲜）
//   外壳\data\安全闸门\审计.jsonl   每次非 pass 的审计（不存全文）
//   外壳\data\安全闸门\拦截\*.txt   被拦原文（仅本机，可在设置里关掉）

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SHELL_DIR = __dirname;
const ROOT = path.dirname(SHELL_DIR);                 // 12-源码照搬
const DATA_DIR = process.env.DSH_SHELL_DATA || path.join(SHELL_DIR, 'data');
const CONFIG_FILE = path.join(DATA_DIR, '安全闸门.json');
const RUNTIME_DIR = path.join(DATA_DIR, '安全闸门');
const ASSET_FILE = path.join(DATA_DIR, '安全资产.json');
const AUDIT_FILE = path.join(RUNTIME_DIR, '审计.jsonl');
const STATUS_FILE = path.join(RUNTIME_DIR, '状态.json');
const COUNTER_FILE = path.join(RUNTIME_DIR, '计数.json');
const BLOCKED_DIR = path.join(RUNTIME_DIR, '拦截');
const QQ_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json');
const WECHAT_CONFIG_FILE = path.join(DATA_DIR, '微信通道.json');
const BRIDGE_CONFIG_FILE = path.join(DATA_DIR, '桥接.json');
const DSH_HOME = process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh');
// 情绪联动：QQ 普通 @ / 私聊的正文也按当前心情收一次；缺失时完全不改原行为。
let socialReply = null;
try { socialReply = require('./社交回复'); } catch (e) { /* 没有回复策略层，闸门保持原样 */ }

// ---------- 1. 默认配置与归一化 ----------

const ACTIONS = ['block', 'redact', 'pass'];
const CATEGORIES = [
  { key: 'ip', label: 'IP / 本机地址', hint: 'IPv4、IPv6、localhost、127.0.0.1:端口；聊天里不该出现' },
  { key: 'path', label: '本机路径', hint: 'C:\\Users\\...、D:\\codeData\\...、/Users/、/home/、UNC 路径、file://' },
  { key: 'host', label: '主机名', hint: '本机计算机名；换机器后自动重新采集' },
  { key: 'user', label: '用户名', hint: '路径里的 Windows 用户名（C:\\Users\\xxx）' },
  { key: 'secret', label: '密钥 / 令牌', hint: 'sk-、ark-、Bearer、token=、DSH token、桥接密码' },
  { key: 'account', label: '账号 / 联系方式', hint: '手机号、身份证、邮箱、银行卡、QQ / 微信 / open_id' },
  { key: 'attachment', label: '图片 / 文件', hint: 'QQ 发图、发文件、合并转发；截图最容易带出窗口标题和路径' }
];

const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'enforce',                    // enforce = 真拦；shadow = 只记日志不拦（默认不放宽）
  channels: { wechat: true, qq: true, feishu: false },
  action: {
    ip: 'block',
    path: 'block',
    host: 'block',
    user: 'block',
    secret: 'block',
    account: 'redact',                // 手机号 / 身份证 / 邮箱默认打码后发
    attachment: 'block'
  },
  replyFallback: '这个我在这儿不方便说～',
  allowPhrases: [],                   // 明确放行的短语（精确包含；出现在正文里就先摘掉再判）
  storeBlockedText: true,             // 被拦原文只写本机 安全闸门\拦截\
  unknownAction: 'block',             // QQ 里出现没登记过的 send/upload 动作：默认拦
  qq: {
    proxy: true,                      // 是否接管 QQ 的 OneBot HTTP
    listenPort: 3100,
    upstream: 'http://127.0.0.1:3000/',
    originalHttp: ''                  // 接管前的地址，关掉时原样还回去
  }
};

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isObj(patch)) return out;
  Object.keys(patch).forEach(function (k) {
    const v = patch[k];
    if (isObj(v) && isObj(base && base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  });
  return out;
}

function clampPort(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? Math.round(n) : dflt;
}

function normalizeConfig(raw) {
  const c = deepMerge(DEFAULT_CONFIG, raw || {});
  c.enabled = c.enabled !== false;
  c.mode = c.mode === 'shadow' ? 'shadow' : 'enforce';
  c.channels = {
    wechat: !!(c.channels && c.channels.wechat),
    qq: !!(c.channels && c.channels.qq),
    // 飞书出站目前拦不到（dsh-im 硬编码 open.feishu.cn）。不给「打开开关就以为安全」的假象：
    // 等自有发送器或带 hash 自检的补丁接上后，再在这里放开。
    feishu: false
  };
  const actions = {};
  CATEGORIES.forEach(function (cat) {
    const v = c.action && c.action[cat.key];
    actions[cat.key] = ACTIONS.indexOf(v) >= 0 ? v : DEFAULT_CONFIG.action[cat.key];
  });
  c.action = actions;
  c.replyFallback = typeof c.replyFallback === 'string' ? c.replyFallback.slice(0, 200) : DEFAULT_CONFIG.replyFallback;
  c.allowPhrases = (Array.isArray(c.allowPhrases) ? c.allowPhrases : [])
    .map(function (x) { return String(x || '').trim(); })
    .filter(function (x) { return x.length >= 2 && x.length <= 120; })
    .slice(0, 200);
  c.storeBlockedText = c.storeBlockedText !== false;
  c.unknownAction = c.unknownAction === 'pass' ? 'pass' : 'block';
  c.qq = {
    proxy: c.qq ? c.qq.proxy !== false : true,
    listenPort: clampPort(c.qq && c.qq.listenPort, 3100),
    upstream: typeof (c.qq && c.qq.upstream) === 'string' && /^https?:\/\//i.test(c.qq.upstream)
      ? c.qq.upstream : 'http://127.0.0.1:3000/',
    originalHttp: typeof (c.qq && c.qq.originalHttp) === 'string' ? c.qq.originalHttp : ''
  };
  return c;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) { return false; }
}

function readConfig() {
  return normalizeConfig(readJson(CONFIG_FILE));
}

function writeConfig(cfg) {
  return writeJson(CONFIG_FILE, normalizeConfig(cfg));
}

// ---------- 2. 本机资产指纹（动态，不靠静态词表） ----------

function addAsset(items, seen, kind, value, label) {
  const v = String(value || '').trim();
  if (!v || v.length < 2) return;
  const key = kind + '|' + v.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  items.push({ kind: kind, value: v, label: String(label || '') });
}

function buildAssets() {
  const items = [];
  const seen = new Set();
  const nets = os.networkInterfaces() || {};
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (a) {
      if (a && a.address) addAsset(items, seen, 'ip', a.address, '网卡 ' + name);
    });
  });
  addAsset(items, seen, 'host', os.hostname(), '本机主机名');
  try { addAsset(items, seen, 'user', os.userInfo().username, 'Windows 用户名'); } catch (e) { /* 忽略 */ }
  [ROOT, SHELL_DIR, DSH_HOME, process.env.USERPROFILE || os.homedir()].forEach(function (p) {
    if (p) addAsset(items, seen, 'path', p, '本机路径');
  });

  const qq = readJson(QQ_CONFIG_FILE);
  if (qq) {
    if (qq.token) addAsset(items, seen, 'secret', qq.token, 'QQ 桥接 token');
    if (qq.wsToken) addAsset(items, seen, 'secret', qq.wsToken, 'QQ WS token');
    ['selfUin', 'ownerUin', 'peerUin'].forEach(function (k) {
      if (qq[k]) addAsset(items, seen, 'account', String(qq[k]), 'QQ 号 ' + k);
    });
    (Array.isArray(qq.groupUins) ? qq.groupUins : []).forEach(function (g) {
      addAsset(items, seen, 'account', String(g), 'QQ 群号');
    });
  }
  const wx = readJson(WECHAT_CONFIG_FILE);
  if (wx) {
    if (wx.adapterToken) addAsset(items, seen, 'secret', wx.adapterToken, '微信适配器 token');
    if (wx.wechatAccount) addAsset(items, seen, 'account', wx.wechatAccount, '微信账号');
  }
  const br = readJson(BRIDGE_CONFIG_FILE);
  if (br && br.bootstrapPassword) addAsset(items, seen, 'secret', br.bootstrapPassword, 'SnowLuma 控制台密码');

  const out = { generatedAt: Date.now(), items: items };
  writeJson(ASSET_FILE, out);
  return out;
}

function loadAssets(refresh) {
  const cur = readJson(ASSET_FILE);
  const fresh = cur && Array.isArray(cur.items) && Number(cur.generatedAt) &&
    (Date.now() - Number(cur.generatedAt) < 12 * 3600 * 1000);
  if (!refresh && fresh) return cur;
  return buildAssets();
}

// ---------- 3. 判定（确定性规则；不调模型） ----------

function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function luhnOk(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0 && digits.length >= 12;
}

function findIpv4(flat) {
  const hits = [];
  // 数字之间被空格拆开的 IP：先给检测串补点，原始 matched 仍回原文里找
  const probe = flat.replace(/(\d)\s+(?=\d)/g, '$1.');
  const re = /\d{1,3}(?:[.。·]\d{1,3}){3}/g;
  let m;
  while ((m = re.exec(probe))) {
    const parts = m[0].split(/[.。·]/).map(Number);
    if (parts.some(function (n) { return n > 255; })) continue;
    hits.push({ code: 'IP-V4', match: m[0] });
  }
  return hits;
}

function findIpv6(flat) {
  const hits = [];
  const re = /[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}/gi;
  let m;
  while ((m = re.exec(flat))) {
    const s = m[0];
    if (!s.includes(':') || s.split(':').length < 3) continue;
    if (s.includes('::')) { hits.push({ code: 'IP-V6', match: s }); continue; }
    const groups = s.split(':').filter(function (x) { return x !== ''; });
    if (groups.length >= 4 && /[a-f]/i.test(s)) hits.push({ code: 'IP-V6', match: s });
  }
  return hits;
}

function matchAsset(flat, asset, kind) {
  const v = asset.value;
  if (!v) return false;
  if (kind === 'host' || kind === 'user') {
    const re = new RegExp('(?<![a-z0-9])' + escapeRe(v) + '(?![a-z0-9])', 'i');
    return re.test(flat);
  }
  if (/^\d+$/.test(v)) {
    const re = new RegExp('(?<!\\d)' + escapeRe(v) + '(?!\\d)');
    return re.test(flat);
  }
  if (kind === 'secret' || kind === 'path' || kind === 'ip') {
    return flat.toLowerCase().includes(v.toLowerCase());
  }
  const re = new RegExp('(?<![a-z0-9_])' + escapeRe(v) + '(?![a-z0-9_])', 'i');
  return re.test(flat);
}

function pushHit(hits, code, label, match, category) {
  hits.push({ code: code, label: label, match: match, category: category || CATEGORY_OF[code] || 'secret' });
}

const CATEGORY_OF = {
  'IP-V4': 'ip', 'IP-V6': 'ip', 'LOCAL-HOST': 'ip',
  'PATH-WIN': 'path', 'PATH-UNIX': 'path', 'PATH-UNC': 'path', 'FILE-URL': 'path',
  'HOST-NAME': 'host',
  'USER-PATH': 'user',
  'SECRET-KEY': 'secret', 'SECRET-TOKEN': 'secret', 'SESSION-ID': 'secret',
  'PHONE': 'account', 'ID-CARD': 'account', 'EMAIL': 'account', 'BANK-CARD': 'account',
  'WXID': 'account', 'OPEN-ID': 'account', 'QQ-ASSET': 'account', 'ASSET-ACCOUNT': 'account',
  'ASSET-SECRET': 'secret', 'ASSET-PATH': 'path', 'ASSET-IP': 'ip', 'ASSET-HOST': 'host', 'ASSET-USER': 'user',
  'ATTACHMENT': 'attachment', 'UNKNOWN-ACTION': 'attachment'
};

function detectAll(flat, assets, cfg) {
  const hits = [];
  // 3.1 本机资产（动态指纹）
  (assets || []).forEach(function (a) {
    if (!matchAsset(flat, a, a.kind)) return;
    const code = {
      ip: 'ASSET-IP', host: 'ASSET-HOST', user: 'ASSET-USER',
      path: 'ASSET-PATH', secret: 'ASSET-SECRET', account: 'ASSET-ACCOUNT'
    }[a.kind] || 'ASSET-ACCOUNT';
    pushHit(hits, code, a.label || a.kind, a.value);
  });
  // 3.2 IP / 本机地址
  findIpv4(flat).forEach(function (h) { pushHit(hits, h.code, 'IPv4 地址', h.match); });
  findIpv6(flat).forEach(function (h) { pushHit(hits, h.code, 'IPv6 地址', h.match); });
  if (/(?<![a-z0-9])localhost(?![a-z0-9])/i.test(flat)) pushHit(hits, 'LOCAL-HOST', 'localhost', 'localhost');

  // 3.3 路径
  const pathRes = [
    // 单字母 + 冒号 + 斜杠才是盘符；前面必须不是字母数字，避免把 https:// 当成 s 盘
    /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s，。！？；、"'<>|）(]{2,}/g,
    /\\\\[^\s，。！？；、"'<>|]{2,}/g,
    /(?<![A-Za-z0-9])\/(?:Users|home|root|var|etc|opt)\/[^\s，。！？；、"'<>|）(]*/g,
    /file:\/\/[^\s"'<>]+/gi
  ];
  pathRes.forEach(function (re) {
    let m;
    while ((m = re.exec(flat))) pushHit(hits, re.source.indexOf('file:') >= 0 ? 'FILE-URL' : (m[0].startsWith('\\\\') ? 'PATH-UNC' : (m[0].slice(0, 1) === '/' ? 'PATH-UNIX' : 'PATH-WIN')), '本机路径', m[0]);
  });
  // 用户名只在「路径语境」里算（单独出现可能是正常词）
  assets.forEach(function (a) {
    if (a.kind !== 'user') return;
    const re = new RegExp('(?:Users|用户)[\\\\/ ]+' + escapeRe(a.value), 'i');
    if (re.test(flat)) pushHit(hits, 'USER-PATH', '路径里的用户名', 'Users\\' + a.value);
  });

  // 3.4 密钥 / 令牌
  const secretRes = [
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bark-[A-Za-z0-9_-]{16,}/g,
    /\b(?:ghp_|gho_|ghs_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi,
    /\b(?:token|password|passwd|secret|api[-_]?key|access[-_]?key)\s*[=:：]\s*[^\s，。；]{6,}/gi,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
  ];
  secretRes.forEach(function (re) {
    let m;
    while ((m = re.exec(flat))) pushHit(hits, 'SECRET-KEY', '疑似密钥', m[0]);
  });
  const sid = flat.match(/\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (sid) pushHit(hits, 'SESSION-ID', 'DSH 会话 id', sid[0]);

  // 3.5 账号 / 联系方式
  const phoneRe = /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d{9}(?!\d)/g;
  let m;
  while ((m = phoneRe.exec(flat))) pushHit(hits, 'PHONE', '手机号', m[0]);
  const phoneSep = /(?<!\d)1[3-9]\d[\s-]\d{4}[\s-]\d{4}(?!\d)/g;
  while ((m = phoneSep.exec(flat))) pushHit(hits, 'PHONE', '手机号', m[0]);
  const idRe = /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;
  while ((m = idRe.exec(flat))) pushHit(hits, 'ID-CARD', '身份证号', m[0]);
  const mail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = mail.exec(flat))) pushHit(hits, 'EMAIL', '邮箱', m[0]);
  // 只认「四位一组用空格/横线分开」的卡号：连续 16~19 位会和 18 位身份证重叠，
  // 重叠命中会让打码互相打架（先打码的命中把后一个的原文替换掉 ⇒ 判成打码失败）。
  const bankRe = /(?<!\d)\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}(?:[\s-]\d{1,3})?(?!\d)/g;
  while ((m = bankRe.exec(flat))) {
    const digits = m[0].replace(/[\s-]/g, '');
    if (digits.length >= 16 && digits.length <= 19 && luhnOk(digits)) pushHit(hits, 'BANK-CARD', '银行卡号', m[0]);
  }
  const wxid = flat.match(/\bwxid_[A-Za-z0-9_-]{6,}/i);
  if (wxid) pushHit(hits, 'WXID', '微信号', wxid[0]);
  const openid = flat.match(/\b(?:ou|on)_[0-9a-f]{20,}/i);
  if (openid) pushHit(hits, 'OPEN-ID', 'open_id', openid[0]);
  return hits;
}

function maskFor(hit) {
  const m = String(hit.match || '');
  if (hit.code === 'PHONE') {
    const d = m.replace(/[^\d]/g, '');
    if (d.length >= 7) return d.slice(0, 3) + '****' + d.slice(-4);
    return '[已隐藏号码]';
  }
  if (hit.code === 'ID-CARD') {
    return m.length >= 8 ? m.slice(0, 4) + '**********' + m.slice(-4) : '[已隐藏证件]';
  }
  if (hit.code === 'EMAIL') {
    const at = m.indexOf('@');
    return at > 0 ? m.slice(0, 1) + '***' + m.slice(at) : '[已隐藏邮箱]';
  }
  if (hit.code === 'BANK-CARD') {
    const d = m.replace(/[^\d]/g, '');
    return d.length >= 4 ? '**** **** **** ' + d.slice(-4) : '[已隐藏卡号]';
  }
  if (hit.code === 'IP-V4' || hit.code === 'IP-V6' || hit.code === 'ASSET-IP') return '[已隐藏地址]';
  if (hit.code === 'PATH-WIN' || hit.code === 'PATH-UNIX' || hit.code === 'PATH-UNC' || hit.code === 'FILE-URL' || hit.code === 'ASSET-PATH') return '[已隐藏路径]';
  return '[已隐藏]';
}

function actionOf(hit, cfg) {
  const cat = hit.category || CATEGORY_OF[hit.code] || 'secret';
  return (cfg.action && cfg.action[cat]) || 'block';
}

// 判定入口：纯函数，不写盘。ctx = { channel, chatType, chatId }
function checkText(text, ctx, opts) {
  const cfg = normalizeConfig((opts && opts.config) || DEFAULT_CONFIG);
  const channel = String((ctx && ctx.channel) || '').toLowerCase();
  if (!cfg.enabled) return { verdict: 'pass', text: String(text || ''), hits: [], rules: [], disabled: true };
  if (channel && hasOwn(cfg.channels, channel) && cfg.channels[channel] !== true) {
    return { verdict: 'pass', text: String(text || ''), hits: [], rules: [], disabled: true };
  }
  let flat = normalizeText(text);
  // 明确放行的短语：先摘掉再判，避免「用户自己写的白名单」被自己的规则拦
  cfg.allowPhrases.forEach(function (p) {
    flat = flat.replace(new RegExp(escapeRe(p), 'gi'), '〔放行〕');
  });
  const assets = (opts && opts.assets) || [];
  const hits = detectAll(flat, assets, cfg);
  if (!hits.length) return { verdict: 'pass', text: String(text || ''), hits: [], rules: [] };

  // 归并同一段重复命中
  const seen = new Set();
  const uniq = [];
  hits.forEach(function (h) {
    const k = h.code + '|' + h.match;
    if (seen.has(k)) return;
    seen.add(k);
    uniq.push(h);
  });

  const actions = uniq.map(function (h) { return actionOf(h, cfg); });
  const worst = actions.indexOf('block') >= 0 ? 'block' : (actions.indexOf('redact') >= 0 ? 'redact' : 'pass');
  const rules = uniq.map(function (h) { return h.code; });
  if (cfg.mode === 'shadow') {
    return { verdict: 'pass', text: String(text || ''), hits: uniq, rules: rules, shadow: worst !== 'pass', would: worst };
  }
  if (worst === 'block') {
    return { verdict: 'block', text: String(text || ''), hits: uniq, rules: rules };
  }
  if (worst === 'redact') {
    let out = String(text || '');
    for (let i = 0; i < uniq.length; i++) {
      const h = uniq[i];
      if (actionOf(h, cfg) !== 'redact') continue;
      if (out.indexOf(h.match) < 0) {
        // 打码打不准（比如全角原文）⇒ 退回整条拒绝，绝不放过
        return { verdict: 'block', text: String(text || ''), hits: uniq, rules: rules.concat(['REDACT-FAILED']) };
      }
      out = out.split(h.match).join(maskFor(h));
    }
    return { verdict: 'redact', text: out, hits: uniq, rules: rules };
  }
  return { verdict: 'pass', text: String(text || ''), hits: uniq, rules: rules };
}

function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

// ---------- 4. 代理（OneBot HTTP → 真协议端） ----------

const TEXT_ACTIONS = ['send_private_msg', 'send_group_msg', 'send_msg', 'send_forward_msg', 'send_group_notice'];
const FILE_ACTIONS = ['upload_private_file', 'upload_group_file'];
// 不带正文的发送类动作：赞、戳、表情回应、好友/群请求处理 —— 不该被内容闸门拦
const BENIGN_SEND = ['send_like', 'send_poke', 'set_msg_emoji_like', 'set_group_card', 'set_friend_add_request', 'set_group_add_request'];

function collectSegments(value, texts, attachments, depth) {
  if ((depth || 0) > 8) return;
  if (typeof value === 'string') { texts.push(value); return; }
  if (Array.isArray(value)) { value.forEach(function (v) { collectSegments(v, texts, attachments, (depth || 0) + 1); }); return; }
  if (!isObj(value)) return;
  const t = String(value.type || '');
  if (t === 'text' && typeof (value.data && value.data.text) === 'string') texts.push(value.data.text);
  else if (['image', 'file', 'record', 'video', 'forward'].indexOf(t) >= 0) attachments.push(t);
  if (isObj(value.data)) {
    if (typeof value.data.content === 'string') collectSegments(value.data.content, texts, attachments, (depth || 0) + 1);
    else if (value.data.content !== undefined) collectSegments(value.data.content, texts, attachments, (depth || 0) + 1);
    if (Array.isArray(value.data.messages)) collectSegments(value.data.messages, texts, attachments, (depth || 0) + 1);
    if (typeof value.data.file === 'string' && (t === 'image' || t === 'file' || t === 'video' || t === 'record')) {
      texts.push(value.data.file);
    }
    if (typeof value.data.name === 'string') texts.push(value.data.name);
  }
  if (Array.isArray(value.messages)) collectSegments(value.messages, texts, attachments, (depth || 0) + 1);
  if (value.content !== undefined && value.type !== 'text') collectSegments(value.content, texts, attachments, (depth || 0) + 1);
}

function collectMentions(value, out, depth) {
  if ((depth || 0) > 8) return;
  if (Array.isArray(value)) { value.forEach(function (v) { collectMentions(v, out, (depth || 0) + 1); }); return; }
  if (!isObj(value)) return;
  if (String(value.type || '') === 'at') out.push(String((value.data && value.data.qq) || (value.data && value.data.user_id) || ''));
  if (isObj(value.data)) {
    if (value.data.content !== undefined) collectMentions(value.data.content, out, (depth || 0) + 1);
    if (Array.isArray(value.data.messages)) collectMentions(value.data.messages, out, (depth || 0) + 1);
  }
  if (Array.isArray(value.messages)) collectMentions(value.messages, out, (depth || 0) + 1);
}

function collectOneBot(payload, ctx) {
  const params = (payload && payload.params) || {};
  const action = String((payload && payload.action) || '');
  const texts = [];
  const attachments = [];
  if (FILE_ACTIONS.indexOf(action) >= 0) {
    ['name', 'file', 'file_name', 'file_path', 'path'].forEach(function (k) {
      if (typeof params[k] === 'string') texts.push(params[k]);
    });
    attachments.push('file');
  } else {
    if (params.message !== undefined) collectSegments(params.message, texts, attachments, 0);
    if (params.messages !== undefined) collectSegments(params.messages, texts, attachments, 0);
    if (typeof params.content === 'string') texts.push(params.content);
    if (typeof params.notice === 'string') texts.push(params.notice);
  }
  const mentions = [];
  if (params.message !== undefined) collectMentions(params.message, mentions, 0);
  if (params.messages !== undefined) collectMentions(params.messages, mentions, 0);
  return {
    action: action,
    texts: texts,
    attachments: attachments,
    mentions: mentions,
    chatType: String(params.message_type || (params.group_id ? 'group' : 'private')),
    chatId: String(params.group_id || params.user_id || '')
  };
}

function rewriteSegments(value, mapper, depth) {
  if ((depth || 0) > 8) return value;
  if (typeof value === 'string') return mapper(value);
  if (Array.isArray(value)) return value.map(function (v) { return rewriteSegments(v, mapper, (depth || 0) + 1); });
  if (!isObj(value)) return value;
  const out = Object.assign({}, value);
  if (value.type === 'text' && isObj(value.data) && typeof value.data.text === 'string') {
    out.data = Object.assign({}, value.data, { text: mapper(value.data.text) });
  }
  if (isObj(value.data)) {
    if (Array.isArray(value.data.content)) out.data = Object.assign({}, out.data, { content: rewriteSegments(value.data.content, mapper, (depth || 0) + 1) });
    else if (typeof value.data.content === 'string') out.data = Object.assign({}, out.data, { content: mapper(value.data.content) });
    if (Array.isArray(value.data.messages)) out.data = Object.assign({}, out.data, { messages: rewriteSegments(value.data.messages, mapper, (depth || 0) + 1) });
  }
  if (Array.isArray(value.messages)) out.messages = rewriteSegments(value.messages, mapper, (depth || 0) + 1);
  if (typeof value.content === 'string') out.content = mapper(value.content);
  return out;
}

function readReqBody(req, cb) {
  let raw = '';
  let done = false;
  req.on('data', function (chunk) {
    if (done) return;
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) { done = true; cb(new Error('body too large'), ''); try { req.destroy(); } catch (e) { /* 忽略 */ } }
  });
  req.on('end', function () { if (!done) { done = true; cb(null, raw); } });
  req.on('error', function (e) { if (!done) { done = true; cb(e, ''); } });
}

function createProxy(opt) {
  const o = opt || {};
  const upstream = o.upstream || DEFAULT_CONFIG.qq.upstream;
  const check = o.check || function () { return { verdict: 'pass', text: '' }; };
  const log = o.log || function () { };
  let server = null;

  function forward(req, res, rawBody, onSuccess) {
    let u;
    try { u = new URL(upstream); } catch (e) { u = new URL(DEFAULT_CONFIG.qq.upstream); }
    const headers = Object.assign({}, req.headers);
    delete headers['content-length'];
    headers.host = u.host;
    const req2 = http.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: req.url || '/',
      method: req.method,
      headers: headers,
      timeout: 15000
    }, function (r2) {
      const h = Object.assign({}, r2.headers);
      res.writeHead(r2.statusCode || 502, h);
      if (!onSuccess) {
        r2.pipe(res);
        return;
      }
      // 需要补语音的请求：先把上游响应读完，确认 OneBot 真的 retcode=0 再触发。
      // 不能只看 HTTP 200 —— OneBot 失败时也常用 200 + status=failed。
      let body = '';
      let tooLarge = false;
      r2.on('data', function (chunk) {
        if (tooLarge) return;
        body += chunk.toString('utf8');
        if (body.length > 1024 * 1024) { tooLarge = true; body = ''; }
      });
      r2.on('end', function () {
        let ok = r2.statusCode >= 200 && r2.statusCode < 300 && !tooLarge;
        if (ok) {
          try {
            const j = JSON.parse(body);
            ok = (!j || Number(j.retcode) === 0) && String((j && j.status) || '') !== 'failed';
          } catch (e) { ok = false; }
        }
        try { res.end(body || ''); } catch (e) { log('[gate] 回写上游响应失败: ' + ((e && e.message) || e)); }
        if (ok) {
          try { onSuccess(); } catch (e) { log('[gate] 发送后钩子失败: ' + ((e && e.message) || e)); }
        }
      });
    });
    req2.on('timeout', function () { req2.destroy(new Error('timeout')); });
    req2.on('error', function (e) {
      try {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'failed', retcode: 1500, data: null, wording: '安全闸门连不上协议端：' + (e && e.message ? e.message : e) }));
        } else { res.destroy(); }
      } catch (e2) { log('[gate] 回写上游错误失败: ' + ((e2 && e2.message) || e2)); }
    });
    if (rawBody) req2.end(rawBody); else req2.end();
  }

  function fail(res, code, extra) {
    const wording = '本机安全闸门已拦截这条消息（规则 ' + code + '）：不要发送地址 / 路径 / 密钥 / 账号等本机信息。';
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1400, data: null, wording: wording, rule: code, extra: extra || null }));
  }

  function handle(req, res) {
    if (req.method === 'GET' && (req.url || '').split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, gate: 'outbound', upstream: upstream }));
      return;
    }
    readReqBody(req, function (err, raw) {
      if (err) {
        try {
          if (!res.headersSent) {
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ status: 'failed', retcode: 1400, data: null, wording: '消息过大，安全闸门拒绝转发' }));
          }
        } catch (e) { /* 忽略 */ }
        return;
      }
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch (e) {
        forward(req, res, raw);
        return;
      }
      if (!payload || typeof payload.action !== 'string') { forward(req, res, raw); return; }
      const action = payload.action;
      if (BENIGN_SEND.indexOf(action) >= 0) { forward(req, res, raw); return; }
      const isText = TEXT_ACTIONS.indexOf(action) >= 0;
      const isFile = FILE_ACTIONS.indexOf(action) >= 0;
      if (!isText && !isFile) {
        if (/send|upload|post/i.test(action)) {
          if (o.unknownAction === 'pass') { forward(req, res, raw); return; }
          check('', { channel: 'qq', chatType: 'private', action: action, unknownAction: true });
          fail(res, 'UNKNOWN-ACTION');
          return;
        }
        forward(req, res, raw);
        return;
      }
      const c = collectOneBot(payload, {});
      const skipVoice = String(req.headers['x-wb-voice-skip'] || '') === '1';
      const afterSendFor = function (cc) {
        if (!o.afterSend) return;
        const text = (cc.texts || []).join('\n').trim();
        try {
          Promise.resolve(o.afterSend({
            chatType: cc.chatType,
            chatId: cc.chatId,
            text: text,
            hasAt: !!(cc.mentions && cc.mentions.length),
            attachments: (cc.attachments || []).slice(),
            skipVoice: skipVoice
          })).catch(function (e) { log('[gate] 发送后钩子异常: ' + ((e && e.message) || e)); });
        } catch (e) { log('[gate] 发送后钩子异常: ' + ((e && e.message) || e)); }
      };
      if (c.attachments.length) {
        const at = check('', { channel: 'qq', chatType: c.chatType, chatId: c.chatId, attachment: c.attachments[0] });
        // 附件单独走「附件」类动作；check 返回 pass 才允许
        if (at && at.verdict === 'block') { fail(res, 'ATTACHMENT', { type: c.attachments[0] }); return; }
      }
      let blocked = '';
      let changed = false;
      let moodPlan = null;
      try {
        moodPlan = socialReply && typeof socialReply.moodPlanFor === 'function'
          ? socialReply.moodPlanFor({})
          : null;
      } catch (e) { moodPlan = null; }
      c.texts.forEach(function (t) {
        if (blocked) return;
        const r = check(t, { channel: 'qq', chatType: c.chatType, chatId: c.chatId });
        if (r.verdict === 'block') { blocked = (r.rules && r.rules[0]) || 'TEXT'; return; }
        if (r.verdict === 'redact' && r.text !== t) changed = true;
      });
      // 只在「纯文字、无附件」时按情绪收紧；多段转发不拆着砍，避免把文件路径/引用截坏。
      if (moodPlan && c.texts.length === 1 && !c.attachments.length) {
        const stripped = socialReply.stripEmoji(c.texts[0]);
        if (stripped !== c.texts[0]) changed = true;
        const trimmed = socialReply.limitReplyText(stripped, moodPlan);
        if (trimmed !== c.texts[0]) changed = true;
      }
      if (blocked) { fail(res, blocked); return; }
      if (!changed) { forward(req, res, raw, function () { afterSendFor(c); }); return; }
      // 有打码 / 情绪收字：按段重写后再转发
      const mapper = function (t) {
        const r = check(t, { channel: 'qq', chatType: c.chatType, chatId: c.chatId });
        let out = r.verdict === 'redact' ? r.text : t;
        if (moodPlan && c.texts.length === 1 && !c.attachments.length) {
          if (typeof socialReply.stripEmoji === 'function') out = socialReply.stripEmoji(out);
          out = socialReply.limitReplyText(out, moodPlan);
        }
        return out;
      };
      let next = payload;
      if (payload.params && payload.params.message !== undefined) {
        next = Object.assign({}, payload, { params: Object.assign({}, payload.params, { message: rewriteSegments(payload.params.message, mapper, 0) }) });
      }
      if (payload.params && payload.params.messages !== undefined) {
        next = Object.assign({}, next, { params: Object.assign({}, (next && next.params) || payload.params, { messages: rewriteSegments(payload.params.messages, mapper, 0) }) });
      }
      // send_group_notice / 其它把正文放 content / notice 的动作：同样要打码，不能只改 message
      if (next.params && typeof next.params.content === 'string') {
        next = Object.assign({}, next, { params: Object.assign({}, next.params, { content: mapper(next.params.content) }) });
      }
      if (next.params && typeof next.params.notice === 'string') {
        next = Object.assign({}, next, { params: Object.assign({}, next.params, { notice: mapper(next.params.notice) }) });
      }
      const body = JSON.stringify(next);
      const headers = Object.assign({}, req.headers);
      headers['content-length'] = Buffer.byteLength(body);
      req.headers = headers;
      const outCtx = collectOneBot(next, {});
      forward(req, res, body, function () { afterSendFor(outCtx); });
    });
  }

  return {
    start: function (port) {
      return new Promise(function (resolve, reject) {
        server = http.createServer(handle);
        server.on('error', function (e) { reject(e); });
        server.listen(port, '127.0.0.1', function () { resolve(server.address().port); });
      });
    },
    stop: function () {
      return new Promise(function (resolve) {
        if (!server) return resolve();
        try { server.close(function () { resolve(); }); } catch (e) { resolve(); }
        server = null;
      });
    },
    get listening() { return !!server && server.listening; },
    get port() { return server && server.address() ? server.address().port : 0; }
  };
}

// ---------- 5. 服务（配置 / 资产 / 审计 / 代理 / 给面板的接口） ----------

function localDate() {
  const d = new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function stamp() {
  const d = new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function probeTcp(host, port, timeoutMs) {
  return new Promise(function (resolve) {
    if (!host || !port) return resolve(false);
    const s = net.connect({ host: host, port: port });
    let done = false;
    const fin = function (v) { if (done) return; done = true; try { s.destroy(); } catch (e) { /* 忽略 */ } resolve(v); };
    s.setTimeout(timeoutMs || 1500, function () { fin(false); });
    s.on('connect', function () { fin(true); });
    s.on('error', function () { fin(false); });
  });
}

function parseUrl(u) {
  try { const x = new URL(u); return { host: x.hostname, port: Number(x.port || (x.protocol === 'https:' ? 443 : 80)) }; } catch (e) { return { host: '', port: 0 }; }
}

function createService(opts) {
  const o = opts || {};
  const log = o.log || function () { };
  // 引擎地址由壳传入（主进程知道端口真源）；这里不留默认端口，避免和 3083 的单真源打架。
  // 万一手工调用没传 base，apply/restore 会在拼 URL 前报「缺引擎地址」，不会静默打错地方。
  const base = String(o.base || '');
  const getToken = o.getToken || function () { return process.env.DSH_TOKEN || ''; };
  const dshHome = o.dshHome || DSH_HOME;
  // QQ 普通 @ / 私聊的「正文后补语音」由闸门统一做：
  // 普通 @ 与私聊都走 onebotHttp（3100 代理），只有这一层能同时看到两种出站。
  const media = o.media || null;

  const svc = {
    cfg: readConfig(),
    assets: loadAssets(false),
    counters: readJson(COUNTER_FILE) || { date: localDate(), checked: 0, blocked: 0, redacted: 0 },
    proxy: null,
    lastError: ''
  };
  if (!svc.counters.date || svc.counters.date !== localDate()) {
    svc.counters = { date: localDate(), checked: 0, blocked: 0, redacted: 0 };
  }
  ensureDirs();
  // 第一次跑：把默认配置落盘，面板打开就能看到真实文件（不是内存里的影子配置）
  if (!fs.existsSync(CONFIG_FILE)) writeConfig(svc.cfg);

  function ensureDirs() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.mkdirSync(BLOCKED_DIR, { recursive: true });
    } catch (e) { log('[gate] 建运行目录失败: ' + ((e && e.message) || e)); }
  }

  function currentAssets() {
    if (!svc.assets || !Array.isArray(svc.assets.items)) svc.assets = loadAssets(false);
    const items = svc.assets.items.slice();
    // DSH token 只在内存里，不写资产文件
    const tok = String(getToken() || '');
    if (tok.length >= 8) items.push({ kind: 'secret', value: tok, label: 'DSH token（内存）' });
    return items;
  }

  function bump(key) {
    if (svc.counters.date !== localDate()) svc.counters = { date: localDate(), checked: 0, blocked: 0, redacted: 0 };
    svc.counters[key] = (Number(svc.counters[key]) || 0) + 1;
    try { writeJson(COUNTER_FILE, svc.counters); } catch (e) { /* 忽略 */ }
  }

  function record(result, ctx, text) {
    const channel = String((ctx && ctx.channel) || 'unknown');
    const ts = new Date().toISOString();
    const rec = {
      ts: ts,
      channel: channel,
      chatType: String((ctx && ctx.chatType) || ''),
      verdict: result.verdict,
      shadow: !!result.shadow,
      would: result.would || '',
      rules: (result.rules || []).slice(0, 8),
      len: String(text || '').length,
      hash: crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
    };
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) { log('[gate] 写审计失败: ' + ((e && e.message) || e)); }
    bump('checked');
    if (result.verdict === 'block') bump('blocked');
    if (result.verdict === 'redact') bump('redacted');
    if (result.verdict === 'block' && svc.cfg.storeBlockedText) {
      try {
        fs.mkdirSync(BLOCKED_DIR, { recursive: true });
        fs.writeFileSync(path.join(BLOCKED_DIR, stamp() + '-' + channel + '.txt'),
          '规则：' + (result.rules || []).join(' / ') + '\r\n时间：' + ts + '\r\n渠道：' + channel + '\r\n\r\n' + String(text || ''), 'utf8');
      } catch (e) { log('[gate] 存拦截原文失败: ' + ((e && e.message) || e)); }
    }
    writeStatusFile();
  }

  function check(text, ctx) {
    const r = checkText(text, ctx, { config: svc.cfg, assets: currentAssets() });
    if (!r.disabled) record(r, ctx, text);
    if (r.verdict === 'block') r.fallback = svc.cfg.replyFallback;
    return r;
  }

  async function writeStatusFile() {
    try {
      const st = await buildStatus();
      writeJson(STATUS_FILE, st);
    } catch (e) { log('[gate] 写状态失败: ' + ((e && e.message) || e)); }
  }

  async function buildStatus() {
    const u = parseUrl(svc.cfg.qq.upstream);
    const upstreamOk = u.port ? await probeTcp(u.host, u.port, 1500) : false;
    const qqCfg = readJson(QQ_CONFIG_FILE) || {};
    const gateUrl = 'http://127.0.0.1:' + svc.cfg.qq.listenPort + '/';
    const qqViaGate = String(qqCfg.onebotHttp || '').replace(/\/+$/, '') === gateUrl.replace(/\/+$/, '');
    return {
      at: Date.now(),
      enabled: svc.cfg.enabled,
      mode: svc.cfg.mode,
      listening: !!(svc.proxy && svc.proxy.listening),
      port: svc.cfg.qq.listenPort,
      upstream: svc.cfg.qq.upstream,
      upstreamOk: upstreamOk,
      qq: {
        proxy: svc.cfg.qq.proxy,
        applied: qqViaGate,
        current: String(qqCfg.onebotHttp || ''),
        original: svc.cfg.qq.originalHttp,
        hasConfig: !!qqCfg.token
      },
      today: {
        date: svc.counters.date,
        checked: Number(svc.counters.checked) || 0,
        blocked: Number(svc.counters.blocked) || 0,
        redacted: Number(svc.counters.redacted) || 0
      },
      assets: {
        generatedAt: Number((svc.assets && svc.assets.generatedAt) || 0),
        count: Array.isArray(svc.assets && svc.assets.items) ? svc.assets.items.length : 0
      },
      channels: svc.cfg.channels,
      lastError: svc.lastError || ''
    };
  }

  async function start() {
    // 只要 qq.proxy 开着、且闸门在用（总开关开）或 QQ 已经指过来，就把代理拉起来：
    // 后者是为了避免「上次接管过、这次总开关关了，3100 没人听 → QQ 半残」。
    const gateUrl = 'http://127.0.0.1:' + svc.cfg.qq.listenPort + '/';
    const qqCfg = readJson(QQ_CONFIG_FILE) || {};
    const pointsGate = String(qqCfg.onebotHttp || '').replace(/\/+$/, '') === gateUrl.replace(/\/+$/, '');
    if (svc.cfg.qq.proxy && (svc.cfg.enabled || pointsGate)) {
      await startProxy();
    }
    await writeStatusFile();
    return { ok: true, status: await buildStatus() };
  }

  // QQ 直接语音：正文已被闸门放行并真的发出去后，再决定补不补一条语音。
  // 群随机接话由 QQ群聊.js 自己发正文+语音，并在请求头带 x-wb-voice-skip，避免这里再补一条。
  async function afterQqSend(ctx) {
    if (!media || !ctx || ctx.skipVoice) return;
    if (!ctx.text || (ctx.attachments || []).indexOf('record') >= 0) return;
    if (typeof media.shouldVoiceDirect !== 'function' || !media.shouldVoiceDirect(ctx)) return;
    const qq = readJson(QQ_CONFIG_FILE) || {};
    const url = String(svc.cfg.qq.upstream || '').trim();
    if (!url) {
      if (typeof media.noteDirectVoice === 'function') media.noteDirectVoice(false, Object.assign({}, ctx, { error: 'QQ 协议端地址为空' }));
      log('[gate] QQ 直接语音跳过：协议端地址为空');
      return;
    }
    try {
      const result = await media.synthesizeVoice(ctx.text);
      if (!result || !result.ok || !result.file) {
        const err = String((result && (result.breezeError || result.silkError || result.error)) || '语音合成失败');
        if (typeof media.noteDirectVoice === 'function') media.noteDirectVoice(false, Object.assign({}, ctx, { provider: (result && result.provider) || '', error: err }));
        log('[gate] QQ 直接语音失败：' + err);
        return;
      }
      const idKey = ctx.chatType === 'group' ? 'group_id' : 'user_id';
      const id = Number(ctx.chatId);
      if (!Number.isFinite(id) || id <= 0) {
        if (typeof media.noteDirectVoice === 'function') media.noteDirectVoice(false, Object.assign({}, ctx, { provider: result.provider, error: '聊天 id 非法' }));
        log('[gate] QQ 直接语音跳过：聊天 id 非法 ' + ctx.chatId);
        return;
      }
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + String(qq.token || '')
        },
        body: JSON.stringify({
          action: ctx.chatType === 'group' ? 'send_group_msg' : 'send_private_msg',
          params: Object.assign({}, { [idKey]: id }, {
            message: [{ type: 'record', data: { file: result.file } }]
          })
        }),
        signal: AbortSignal.timeout(15000)
      });
      const raw = await r.text();
      let j = null;
      try { j = JSON.parse(raw); } catch (e) { /* 下面按原文报 */ }
      if (!r.ok || !j || Number(j.retcode) !== 0) {
        const err = 'OneBot ' + (r.ok ? 'retcode ' + (j && j.retcode) : 'HTTP ' + r.status) + '：' + raw.slice(0, 120);
        if (typeof media.noteDirectVoice === 'function') media.noteDirectVoice(false, Object.assign({}, ctx, { provider: result.provider, bytes: result.bytes, error: err }));
        log('[gate] QQ 直接语音发送失败：' + err);
        return;
      }
      if (typeof media.noteDirectVoice === 'function') {
        media.noteDirectVoice(true, Object.assign({}, ctx, { provider: result.provider, bytes: result.bytes, error: '' }));
      }
      log('[gate] QQ 直接语音已发 ' + ctx.chatType + ':' + ctx.chatId + ' provider=' + (result.provider || '') + ' bytes=' + (result.bytes || 0));
    } catch (e) {
      const err = String((e && e.message) || e);
      if (typeof media.noteDirectVoice === 'function') media.noteDirectVoice(false, Object.assign({}, ctx, { error: err }));
      log('[gate] QQ 直接语音异常：' + err);
    }
  }

  async function startProxy() {
    if (svc.proxy && svc.proxy.listening && svc.proxy.port === svc.cfg.qq.listenPort) return;
    if (svc.proxy) { await svc.proxy.stop(); svc.proxy = null; }
    const p = createProxy({
      upstream: svc.cfg.qq.upstream,
      unknownAction: svc.cfg.unknownAction,
      log: log,
      check: function (text, ctx) { return check(text, ctx); },
      afterSend: function (ctx) { return afterQqSend(ctx); }
    });
    try {
      await p.start(svc.cfg.qq.listenPort);
      svc.proxy = p;
      svc.lastError = '';
      log('[gate] QQ 闸门代理在听 127.0.0.1:' + svc.cfg.qq.listenPort + ' → ' + svc.cfg.qq.upstream);
    } catch (e) {
      svc.lastError = 'QQ 闸门代理起不来（' + ((e && e.message) || e) + '）：先看 ' + svc.cfg.qq.listenPort + ' 是否被别的程序占用';
      log('[gate] ' + svc.lastError);
      throw e;
    }
  }

  async function stopProxy() {
    if (!svc.proxy) return;
    await svc.proxy.stop();
    svc.proxy = null;
  }

  function lib() {
    if (svc.libCache) return svc.libCache;
    process.env.DSH_HOME = dshHome;
    process.env.DSH_WEB_URL = base;
    svc.libCache = import(pathToFileURL(path.join(ROOT, '工具', '派发-公共.mjs')).href);
    return svc.libCache;
  }

  async function postQqSave(body) {
    const L = await lib();
    const cookie = await L.getCookie();
    if (!cookie) throw new Error('换不到引擎 cookie（引擎没就绪或 token 失效）');
    const r = await fetch(base + '/api/qq-bridge/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', cookie: cookie },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!r.ok || !j || j.ok !== true) {
      throw new Error('QQ 桥接接口拒绝（HTTP ' + r.status + '）：' + String((j && j.error) || text).slice(0, 160));
    }
    return true;
  }

  function backupQqConfig() {
    try {
      if (!fs.existsSync(QQ_CONFIG_FILE)) return;
      const bak = QQ_CONFIG_FILE + '.bak-安全闸门';
      if (!fs.existsSync(bak)) fs.copyFileSync(QQ_CONFIG_FILE, bak);
    } catch (e) { log('[gate] 备份 QQ 配置失败: ' + ((e && e.message) || e)); }
  }

  async function doApplyQqProxy() {
    // 「立即接管」是用户的明确动作：把 proxy / channels.qq 一并写成开，别出现
    // 「这次接管了、重启后又变回直连」的半截状态。总开关不动（只记录模式也允许接管观察）。
    let cfgDirty = false;
    if (!svc.cfg.qq.proxy) { svc.cfg.qq.proxy = true; cfgDirty = true; }
    if (!svc.cfg.channels.qq) { svc.cfg.channels.qq = true; cfgDirty = true; }
    if (cfgDirty) writeConfig(svc.cfg);
    const gateUrl = 'http://127.0.0.1:' + svc.cfg.qq.listenPort + '/';
    const qq = readJson(QQ_CONFIG_FILE);
    if (!qq) {
      return { ok: false, applied: false, error: '没有 QQ 桥接配置（~/.dsh/qq-bridge.config.json）：先在「QQ 桥接」页绑好小号再开启闸门' };
    }
    if (!qq.token && !qq.selfUin) {
      return { ok: false, applied: false, error: 'QQ 桥接还没绑小号（缺 token / selfUin）：开启闸门没有意义' };
    }
    if (String(qq.onebotHttp || '').replace(/\/+$/, '') === gateUrl.replace(/\/+$/, '')) {
      return { ok: true, applied: true, via: 'already' };
    }
    if (!svc.cfg.qq.originalHttp && qq.onebotHttp) {
      svc.cfg.qq.originalHttp = String(qq.onebotHttp);
      writeConfig(svc.cfg);
    }
    backupQqConfig();
    await startProxy();
    // 1. 先走插件自己的保存接口：它会同时改内存与文件，下一轮投递立刻生效，不用重启整壳
    try {
      await postQqSave({ onebotHttp: gateUrl });
      await writeStatusFile();
      log('[gate] QQ 已改指闸门（热生效）：' + gateUrl);
      return { ok: true, applied: true, via: 'live', url: gateUrl };
    } catch (e) {
      // 2. 引擎没就绪 / cookie 换不到：直接写文件，标「重启整壳后生效」，绝不假装已生效
      const next = Object.assign({}, qq, { onebotHttp: gateUrl });
      writeJson(QQ_CONFIG_FILE, next);
      await writeStatusFile();
      log('[gate] QQ 已写指闸门（需重启整壳才生效）：' + ((e && e.message) || e));
      return { ok: true, applied: false, restartRequired: true, error: String((e && e.message) || e), url: gateUrl };
    }
  }

  function applyQqProxy() {
    // 启动时主流程与 20 秒后的重试可能同时到：同一时刻只允许一次接管，第二次复用第一次的 Promise
    if (svc.applyPromise) return svc.applyPromise;
    svc.applyPromise = doApplyQqProxy().then(function (r) {
      svc.applyPromise = null;
      return r;
    }, function (e) {
      svc.applyPromise = null;
      throw e;
    });
    return svc.applyPromise;
  }

  async function restoreQqProxy() {
    // 恢复直连是持久动作：把 qq.proxy 落成 false；否则重启整壳后 start() 又会把代理拉起来并重新接管。
    if (svc.cfg.qq.proxy) { svc.cfg.qq.proxy = false; writeConfig(svc.cfg); }
    const qq = readJson(QQ_CONFIG_FILE);
    if (!qq) { if (svc.proxy) await stopProxy(); return { ok: true, restored: true, skipped: 'no-config' }; }
    const original = svc.cfg.qq.originalHttp || '';
    if (!original) return { ok: true, restored: true, skipped: 'no-original' };
    try {
      await postQqSave({ onebotHttp: original });
      if (svc.proxy) await stopProxy();
      log('[gate] QQ 已恢复直连（热生效）：' + original);
      await writeStatusFile();
      return { ok: true, restored: true, via: 'live', url: original };
    } catch (e) {
      const next = Object.assign({}, qq, { onebotHttp: original });
      const wrote = writeJson(QQ_CONFIG_FILE, next);
      if (wrote && svc.proxy) await stopProxy();
      await writeStatusFile();
      return { ok: true, restored: true, restartRequired: true, error: String((e && e.message) || e), url: original };
    }
  }

  async function ensureQqProxy() {
    if (!svc.cfg.enabled || !svc.cfg.qq.proxy || !svc.cfg.channels.qq) {
      if (svc.cfg.qq.originalHttp) {
        const r = await restoreQqProxy();
        if (svc.proxy) await stopProxy();
        return r;
      }
      return { ok: true, skipped: 'disabled' };
    }
    return applyQqProxy();
  }

  function auditTail(n) {
    try {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(500, Number(n) || 30))).map(function (l) {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) { return []; }
  }

  async function getSettings() {
    const status = await buildStatus();
    return {
      ok: true,
      config: svc.cfg,
      status: status,
      categories: CATEGORIES,
      assets: {
        count: Array.isArray(svc.assets.items) ? svc.assets.items.length : 0,
        generatedAt: Number(svc.assets.generatedAt) || 0,
        kinds: (function () {
          const out = {};
          (svc.assets.items || []).forEach(function (a) { out[a.kind] = (out[a.kind] || 0) + 1; });
          return out;
        })()
      },
      paths: {
        config: CONFIG_FILE,
        assets: ASSET_FILE,
        audit: AUDIT_FILE,
        blocked: BLOCKED_DIR,
        qqConfig: QQ_CONFIG_FILE
      },
      files: {
        configExists: fs.existsSync(CONFIG_FILE),
        assetExists: fs.existsSync(ASSET_FILE)
      }
    };
  }

  async function saveSettings(patch) {
    const before = JSON.parse(JSON.stringify(svc.cfg));
    const next = normalizeConfig(deepMerge(svc.cfg, patch || {}));
    svc.cfg = next;
    writeConfig(svc.cfg);
    // QQ 接管开关 / 端口变化：按顺序处理，失败要能回滚说明（不静默）
    const portChanged = before.qq.listenPort !== next.qq.listenPort;
    const channelChanged = before.channels.qq !== next.channels.qq;
    const upstreamChanged = before.qq.upstream !== next.qq.upstream;
    const unknownChanged = before.unknownAction !== next.unknownAction;
    const proxyChanged = before.qq.proxy !== next.qq.proxy || before.enabled !== next.enabled;
    if (!next.enabled || !next.qq.proxy || !next.channels.qq) {
      if (svc.cfg.qq.originalHttp) await restoreQqProxy();
      if (svc.proxy) await stopProxy();
    } else if (proxyChanged || portChanged || channelChanged || upstreamChanged || unknownChanged || !svc.proxy || !svc.proxy.listening) {
      if (svc.proxy) await stopProxy();
      await startProxy();
      const applied = await applyQqProxy();
      await writeStatusFile();
      return { ok: true, config: svc.cfg, applied: applied, status: await buildStatus() };
    }
    await writeStatusFile();
    return { ok: true, config: svc.cfg, status: await buildStatus() };
  }

  async function refreshAssets() {
    svc.assets = buildAssets();
    await writeStatusFile();
    return { ok: true, count: svc.assets.items.length, generatedAt: svc.assets.generatedAt, kinds: (function () {
      const out = {};
      svc.assets.items.forEach(function (a) { out[a.kind] = (out[a.kind] || 0) + 1; });
      return out;
    })() };
  }

  function testText(text, channel) {
    return checkText(text, { channel: channel || 'qq' }, { config: svc.cfg, assets: currentAssets() });
  }

  async function selfCheck() {
    return selfTest();
  }

  // QQ 群文本发送（2026-11-19）：发送动作只允许出现在闸门本体里。
  // 群消息也是「她发到工作台之外」的正文，先按同一套规则审：block 不发、redact 用打码正文。
  // 闸门接管时 onebotHttp 已指向本地代理（applyQqProxy 写的），这一发在代理里还会再过一次。
  async function sendQqGroupText(groupId, text) {
    return sendQqGroupMessage(groupId, { text: text });
  }

  // QQ 群媒体发送（2026-11-19）：语音、表情包和正文走同一条闸门。
  // 只允许工作台自己生成的媒体：表情包必须在 pet3d\表情包 下，语音必须在 QQ能力\voice 下。
  // 这是防止模型/调用方把任意本机文件当附件发出去，不是「媒体免检」。
  function mediaAllowed(file, kind) {
    const p = String(file || '').trim();
    if (!p) return '';
    let full = '';
    try { full = fs.realpathSync(p); } catch (e) { return ''; }
    const roots = kind === 'image'
      ? [path.join(__dirname, 'pet3d', '表情包')]
      : [path.join(DATA_DIR, 'QQ能力', 'voice')];
    for (const root of roots) {
      let real = '';
      try { real = fs.realpathSync(root); } catch (e) { continue; }
      if (full === real || full.startsWith(real + path.sep)) return full;
    }
    return '';
  }

  async function sendQqGroupMessage(groupId, parts) {
    const p = parts && typeof parts === 'object' ? parts : {};
    const body = String(p.text || '');
    const ctx = { channel: 'qq', chatType: 'group', chatId: String(groupId || '') };
    const g = check(body, ctx);
    if (g.verdict === 'block') {
      return { ok: false, blocked: true, rules: (g.rules || []).slice(0, 8), fallback: String(g.fallback || '') };
    }
    const finalText = g.verdict === 'redact' ? String(g.text || body) : body;
    const imageFile = mediaAllowed(p.imageFile, 'image');
    const voiceFile = mediaAllowed(p.voiceFile, 'voice');
    const mediaErrors = [];
    if (p.imageFile && !imageFile) mediaErrors.push('表情包路径不在工作台图库内');
    if (p.voiceFile && !voiceFile) mediaErrors.push('语音路径不在工作台语音目录内');
    if (!finalText && !imageFile && !voiceFile) return { ok: false, error: '空消息，不发送' };
    const qq = readJson(QQ_CONFIG_FILE) || {};
    const url = String(qq.onebotHttp || '').trim();
    if (!url) return { ok: false, error: 'QQ 协议端地址为空（qq-bridge.config.json onebotHttp）' };

    // 先发正文，再发媒体：语音段/表情段协议端不认时，正文不能跟着一起丢。
    // 两步都在闸门里，路径都已校验；第二步失败会作为 mediaError 返回，不静默吞。
    let messageId = '';
    if (finalText) {
      const textResult = await postQqGroupAction(url, qq, groupId, [{ type: 'text', data: { text: finalText } }]);
      if (!textResult.ok) return textResult;
      messageId = textResult.messageId;
    }
    let mediaError = mediaErrors.join('；');
    if (imageFile || voiceFile) {
      const segments = [];
      if (imageFile) segments.push({ type: 'image', data: { file: imageFile, sub_type: 1 } });
      if (voiceFile) segments.push({ type: 'record', data: { file: voiceFile } });
      const mediaResult = await postQqGroupAction(url, qq, groupId, segments);
      if (!mediaResult.ok) mediaError = mediaError || mediaResult.error;
      else messageId = messageId || mediaResult.messageId;
    }
    return {
      ok: true,
      messageId: messageId,
      text: finalText,
      verdict: g.verdict,
      image: !!imageFile,
      voice: !!voiceFile,
      mediaError: mediaError
    };
  }

  async function postQqGroupAction(url, qq, groupId, message) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(qq.token || ''),
        'x-wb-voice-skip': '1'
      },
      body: JSON.stringify({
        action: 'send_group_msg',
        params: { group_id: Number(groupId), message: message }
      }),
      signal: AbortSignal.timeout(12000)
    });
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { /* 下面按原文报 */ }
    if (!r.ok) return { ok: false, error: 'OneBot HTTP ' + r.status + '：' + raw.slice(0, 120) };
    if (!j || Number(j.retcode) !== 0) {
      return { ok: false, error: 'OneBot send_group_msg 返回 retcode ' + (j && j.retcode) + '：' + raw.slice(0, 120) };
    }
    return { ok: true, messageId: String((j.data && j.data.message_id) || '') };
  }

  async function stop() {
    await stopProxy();
  }

  return {
    start: start,
    stop: stop,
    check: check,
    testText: testText,
    sendQqGroupText: sendQqGroupText,
    sendQqGroupMessage: sendQqGroupMessage,
    getSettings: getSettings,
    saveSettings: saveSettings,
    refreshAssets: refreshAssets,
    auditTail: auditTail,
    status: buildStatus,
    applyQqProxy: applyQqProxy,
    restoreQqProxy: restoreQqProxy,
    ensureQqProxy: ensureQqProxy,
    selfCheck: selfCheck,
    paths: { config: CONFIG_FILE, assets: ASSET_FILE, audit: AUDIT_FILE, blocked: BLOCKED_DIR, qqConfig: QQ_CONFIG_FILE }
  };
}

// ---------- 6. 自检（会失败的检查 + 反例） ----------

const TEST_ASSETS = [
  { kind: 'ip', value: '10.11.12.13', label: '测试网卡' },
  { kind: 'host', value: 'TEST-HOST', label: '测试主机名' },
  { kind: 'user', value: 'tester', label: '测试用户名' },
  { kind: 'path', value: 'D:\\test\\proj', label: '测试项目路径' },
  { kind: 'account', value: '2531357970', label: '测试 QQ' },
  { kind: 'secret', value: 'tok_abcdef1234567890', label: '测试 token' }
];

function testConfig() {
  return normalizeConfig(deepMerge(DEFAULT_CONFIG, {
    enabled: true,
    mode: 'enforce',
    channels: { wechat: true, qq: true, feishu: true },
    action: { ip: 'block', path: 'block', host: 'block', user: 'block', secret: 'block', account: 'redact', attachment: 'block' },
    allowPhrases: [],
    qq: { proxy: false }
  }));
}

const TEST_CASES = [
  { name: '内网 IP', text: '我这台机器在 192.168.1.23 上', want: 'block' },
  { name: '公网 IP', text: '出口是 8.8.8.8 你信吗', want: 'block' },
  { name: '资产 IP', text: '地址是 10.11.12.13', want: 'block' },
  { name: 'Windows 路径', text: '文件在 C:\\Users\\tester\\Desktop\\a.png', want: 'block' },
  { name: '项目绝对路径', text: '仓库在 D:\\test\\proj\\12-源码照搬', want: 'block' },
  { name: 'Unix 路径', text: '配置在 /home/tester/.config', want: 'block' },
  // 下面三条样例在运行期拼装：被测文本与真实值同形，但源码里不留真值形态（发布前红线会把它当泄露）
  { name: '密钥 sk-', text: 'key 是 ' + 'sk-' + 'abcdefghijklmnop1234', want: 'block' },
  { name: 'token= 形式', text: 'token=abcdef1234567890 别忘了', want: 'block' },
  { name: '资产 token', text: 'tok_abcdef1234567890', want: 'block' },
  { name: '手机号', text: '打 13812345678 找我', want: 'redact' },
  { name: '身份证', text: '身份证 440101199001011234', want: 'redact' },
  { name: '邮箱', text: '发我 a@b.com', want: 'redact' },
  { name: '全角 IP', text: '１９２.１６８.１.２３', want: 'block' },
  { name: '空格拆 IP', text: '192.168 1.23', want: 'block' },
  { name: 'localhost', text: 'localhost:3100 在听', want: 'block' },
  { name: '会话 id', text: 'session-' + '3b4debec-abf6-43a9-bbb6-737a265f3550', want: 'block' },
  { name: '微信号', text: 'wxid_mrqe7dl8oyc822_e787', want: 'redact' },
  { name: '资产 QQ 号', text: 'QQ 2531357970', want: 'redact' },
  { name: '主机名', text: '我的主机 TEST-HOST', want: 'block' },
  { name: '零宽拆字 IP', text: '1\u200b9\u200b2.168.1.23', want: 'block' },
  { name: '正常聊天', text: '今天好热，想吃冰淇淋', want: 'pass' },
  { name: '正常聊天 2', text: '我在写代码，晚点回你', want: 'pass' },
  { name: '版本号不是 IP', text: '版本 1.2.3 更新了', want: 'pass' },
  { name: '日期不是 IP', text: '今天是 2026.11.18', want: 'pass' },
  { name: '时间不是 IPv6', text: '现在是 14:17:32', want: 'pass' }
];

function selfTest() {
  const cfg = testConfig();
  const results = [];
  TEST_CASES.forEach(function (c) {
    const r = checkText(c.text, { channel: 'qq' }, { config: cfg, assets: TEST_ASSETS });
    const ok = c.want === 'pass' ? r.verdict === 'pass' : r.verdict === c.want;
    results.push({ name: c.name, want: c.want, got: r.verdict, ok: ok, rules: r.rules || [], text: r.text });
  });
  // 白名单短语必须真的放行
  const allowCfg = normalizeConfig(deepMerge(cfg, { allowPhrases: ['192.168.1.23'] }));
  const allow = checkText('我的内网是 192.168.1.23', { channel: 'qq' }, { config: allowCfg, assets: TEST_ASSETS });
  results.push({ name: '白名单短语', want: 'pass', got: allow.verdict, ok: allow.verdict === 'pass', rules: allow.rules || [], text: allow.text });
  // 打码后必须真的看不到原号码
  const red = checkText('打 13812345678 找我', { channel: 'qq' }, { config: cfg, assets: TEST_ASSETS });
  results.push({
    name: '打码不残留', want: 'no-original', got: red.verdict,
    ok: red.verdict === 'redact' && String(red.text).indexOf('13812345678') < 0,
    rules: red.rules || [], text: red.text
  });
  const failed = results.filter(function (r) { return !r.ok; });
  return { ok: failed.length === 0, total: results.length, failed: failed.length, results: results };
}

async function proxySelfTest() {
  const cfg = testConfig();
  const check = function (text, ctx) { return checkText(text, ctx, { config: cfg, assets: TEST_ASSETS }); };
  const received = [];
  const up = http.createServer(function (req, res) {
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
      received.push(raw);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
    });
  });
  await new Promise(function (resolve) { up.listen(0, '127.0.0.1', resolve); });
  const upPort = up.address().port;
  const proxy = createProxy({ upstream: 'http://127.0.0.1:' + upPort + '/', check: check, unknownAction: 'block' });
  const port = await proxy.start(0);
  const post = function (payload) {
    return new Promise(function (resolve, reject) {
      const body = JSON.stringify(payload);
      const req = http.request({ host: '127.0.0.1', port: port, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, function (res) {
        let raw = '';
        res.on('data', function (c) { raw += c; });
        res.on('end', function () { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('返回不是 JSON：' + raw.slice(0, 80))); } });
      });
      req.on('error', reject);
      req.end(body);
    });
  };
  const cases = [];
  // 1) 含内网 IP 的私聊：必须拦，上游一次都不该被调
  const blocked = await post({ action: 'send_private_msg', params: { user_id: 2310468741, message: [{ type: 'text', data: { text: '我在 192.168.1.23 上' } }] } });
  cases.push({ name: '代理拦截内网 IP', ok: blocked.retcode === 1400 && received.length === 0, detail: blocked });
  // 2) 正常消息：必须转发，上游收到原文
  const pass = await post({ action: 'send_private_msg', params: { user_id: 2310468741, message: [{ type: 'text', data: { text: '在写代码，晚点回你' } }] } });
  cases.push({ name: '代理放行正常消息', ok: pass.retcode === 0 && received.length === 1 && received[0].indexOf('在写代码') >= 0, detail: pass });
  // 3) 手机号：必须打码后再转发
  const red = await post({ action: 'send_private_msg', params: { user_id: 2310468741, message: [{ type: 'text', data: { text: '打 13812345678 找我' } }] } });
  const last = received[received.length - 1] || '';
  cases.push({ name: '代理打码手机号', ok: red.retcode === 0 && last.indexOf('13812345678') < 0 && last.indexOf('****') >= 0, detail: red });
  // 4) 图片：默认拦
  const img = await post({ action: 'send_private_msg', params: { user_id: 2310468741, message: [{ type: 'image', data: { file: 'C:\\Users\\tester\\a.png' } }] } });
  cases.push({ name: '代理拦图片', ok: img.retcode === 1400, detail: img });
  // 5) 字符串 message（不是消息段数组）：打码也必须真的改写后再转发
  const redStr = await post({ action: 'send_private_msg', params: { user_id: 2310468741, message: '打 13812345678 找我' } });
  const lastStr = received[received.length - 1] || '';
  cases.push({ name: '代理打码字符串 message', ok: redStr.retcode === 0 && lastStr.indexOf('13812345678') < 0 && lastStr.indexOf('****') >= 0, detail: redStr });
  // 6) 群公告正文在 content：打码同样要落到转发体里
  const notice = await post({ action: 'send_group_notice', params: { group_id: 1, content: '电话 13812345678' } });
  const lastNotice = received[received.length - 1] || '';
  cases.push({ name: '代理打码群公告 content', ok: notice.retcode === 0 && lastNotice.indexOf('13812345678') < 0 && lastNotice.indexOf('****') >= 0, detail: notice });
  await proxy.stop();
  await new Promise(function (resolve) { up.close(resolve); });
  const failed = cases.filter(function (c) { return !c.ok; });
  return { ok: failed.length === 0, total: cases.length, failed: failed.length, results: cases };
}

// 命令行读配置 / 资产时用（不启动代理）
function inspect() {
  const cfg = readConfig();
  const assets = loadAssets(false);
  return {
    config: cfg,
    assets: { generatedAt: assets.generatedAt, count: assets.items.length, kinds: (function () {
      const out = {};
      assets.items.forEach(function (a) { out[a.kind] = (out[a.kind] || 0) + 1; });
      return out;
    })() },
    status: readJson(STATUS_FILE) || null,
    paths: { config: CONFIG_FILE, assets: ASSET_FILE, audit: AUDIT_FILE, blocked: BLOCKED_DIR, qqConfig: QQ_CONFIG_FILE }
  };
}

module.exports = {
  createService: createService,
  createProxy: createProxy,
  checkText: checkText,
  buildAssets: buildAssets,
  loadAssets: loadAssets,
  normalizeConfig: normalizeConfig,
  readConfig: readConfig,
  writeConfig: writeConfig,
  inspect: inspect,
  selfTest: selfTest,
  proxySelfTest: proxySelfTest,
  maskFor: maskFor,
  CATEGORIES: CATEGORIES,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  paths: { config: CONFIG_FILE, assets: ASSET_FILE, audit: AUDIT_FILE, status: STATUS_FILE, blocked: BLOCKED_DIR, qqConfig: QQ_CONFIG_FILE }
};
