#!/usr/bin/env node
// 通道发送（2026-11-25）—— 她要「主动找主人」时，按优先级挑一条能通的通道发出去
//
// 为什么要它：微信 / QQ / 飞书 / 其它（B站私信）各自是独立的实现，谁先谁后不该写死在某个脚本里。
//   这里只做三件事：探测谁可用 → 按顺序挑第一个 → 发出去；前一个不通就顺位往下，全不通就报清楚。
// 口径：顺序在 外壳\data\通道优先级.json；默认 微信 → QQ → 飞书 → 其它。
//   · 微信：鲸鲸内核 8787 的插件口（dsh-wechat sendTest，走壳里的安全闸门）
//   · QQ：OneBot（桥接配置里的 onebotHttp + token，经安全闸门 3100 → 协议端）
//   · 飞书：dsh-im 插件，当前未装 ⇒ 探测即跳过（不假装发出去）
//   · 其它：B站私信（她自己的小号 → 主人的 UID）
// 探测口径照抄 外壳\社交.js 的 channelStates，不另造一套标准。
//
// 用法：
//   node 12-源码照搬\工具\通道发送.mjs 探测 [--json]      每条通道能不能用、为什么
//   node 12-源码照搬\工具\通道发送.mjs 发 --说 "…" [--dry]   按优先级发一条（--通道 微信 可指定）
//   node 12-源码照搬\工具\通道发送.mjs 状态              最近一次发了什么、落在哪条
// 退出码：0 已发出（或 dry/探测正常）· 1 全都不通 · 2 参数不成立
// @功能台 {"name":"她往外说话","group":"社交","freq":"daily","plain":"按微信→QQ→飞书→其它 的顺序探测并发出；--dry 只打印会走哪条","why":"主动找主人时不能只写面板；通道要按优先级自动降级，且能看见落在了哪","label":"通道发送","timeout":120000}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 发送动作只允许出现在闸门本体里（2026-11-25）：QQ 私聊从 外壳\外发闸门.js 走，脚本不自己拼 OneBot 请求
import gate from '../外壳/外发闸门.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHELL = path.join(ROOT, '外壳');
const DATA = process.env.DSH_SHELL_DATA || path.join(SHELL, 'data');
const PRIO_FILE = path.join(DATA, '通道优先级.json');
const LAST_FILE = path.join(DATA, '通道外发-最近.json');
const LOG_FILE = path.join(DATA, '通道外发.jsonl');
const WX_CFG = path.join(DATA, '微信通道.json');
const BILI_TOOL = path.join(HERE, 'B站操作.mjs');
const BILI_MEM = path.join(process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh'), '场景记忆', '生活');

// 默认顺序就是用户要的口径：微信先，微信不通转 QQ，其次飞书，其次其它
const DEFAULTS = {
  order: ['wechat', 'qq', 'feishu', 'other'],
  enabled: true,
  wechat: { chatId: 'filehelper', name: '文件传输助手' },
  qq: {},
  feishu: { enabled: false, note: 'dsh-im 未装；装了把凭据绑在 设置 → IM机器人' },
  other: { kind: 'bili-dm' }
};
const LABEL = { wechat: '微信', qq: 'QQ', feishu: '飞书', other: '其它' };

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const say = (s) => console.log(s);

function readJson(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fb; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function config() {
  const c = readJson(PRIO_FILE, null) || {};
  const order = Array.isArray(c.order) && c.order.length ? c.order.filter((k) => LABEL[k]) : DEFAULTS.order.slice();
  for (const k of DEFAULTS.order) if (!order.includes(k)) order.push(k);   // 漏写的补齐，不丢通道
  return {
    ...DEFAULTS, ...c,
    order,
    wechat: { ...DEFAULTS.wechat, ...(c.wechat || {}) },
    qq: { ...DEFAULTS.qq, ...(c.qq || {}) },
    feishu: { ...DEFAULTS.feishu, ...(c.feishu || {}) },
    other: { ...DEFAULTS.other, ...(c.other || {}) },
    enabled: c.enabled !== false
  };
}

async function getJson(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms || 2500) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON 原样带出 */ }
  return { ok: r.ok, status: r.status, j, t };
}
async function postJson(url, body, ms) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms || 15000)
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON 原样带出 */ }
  return { ok: r.ok, status: r.status, j, t };
}

// 1. 微信：鲸鲸内核在听 + 微信适配器在听（适配器不在 = 微信客户端没上线，发了也落不了屏）
function wxCfg() { return readJson(WX_CFG, {}) || {}; }
async function probeWechat() {
  const cfg = wxCfg();
  const kernel = Number(cfg.kernelPort) || 8787;
  const adapter = Number(cfg.adapterPort) || 31241;
  if (!cfg.whaleHome) return { key: 'wechat', ok: false, why: '没配微信通道（外壳\\data\\微信通道.json 缺 whaleHome）' };
  try {
    const h = await getJson('http://127.0.0.1:' + kernel + '/healthz', 2000);
    if (!h.ok) return { key: 'wechat', ok: false, why: '鲸鲸内核没在听（127.0.0.1:' + kernel + '）' };
  } catch (e) { return { key: 'wechat', ok: false, why: '鲸鲸内核连不上（127.0.0.1:' + kernel + '）' }; }
  try {
    const a = await getJson('http://127.0.0.1:' + adapter + '/healthz', 2000);
    if (!a.ok) return { key: 'wechat', ok: false, why: '微信适配器没在听（127.0.0.1:' + adapter + '）：微信客户端没上线？' };
  } catch (e) { return { key: 'wechat', ok: false, why: '微信适配器连不上（127.0.0.1:' + adapter + '）：微信客户端没上线？' }; }
  return { key: 'wechat', ok: true, why: '内核 + 适配器都在听', kernel, adapter, chatId: cfg.chatId };
}
async function sendWechat(text, cfg) {
  const p = await probeWechat();
  if (!p.ok) return { ok: false, error: p.why };
  const w = cfg.wechat || {};
  const body = { id: 'dsh-wechat', input: { action: 'sendTest', chatId: String(w.chatId || 'filehelper'), name: String(w.name || '文件传输助手'), text } };
  try {
    const r = await postJson('http://127.0.0.1:' + p.kernel + '/api/plugins/run', body, 125000);
    const j = r.j || {};
    if (!r.ok || j.ok !== true) return { ok: false, error: (j.error || ('HTTP ' + r.status)) };
    const res = j.result || {};
    if (res.ok === false) return { ok: false, error: res.error || '插件发送失败' };
    return { ok: true, detail: '→ ' + String(w.name || '文件传输助手') };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// 2. QQ：OneBot（桥接配置里的 onebotHttp + token；目标 = ownerUin）
function qqCfg() {
  const p = path.join(process.env.USERPROFILE || '', '.dsh', 'qq-bridge.config.json');
  const c = readJson(p, null);
  if (!c || !c.token) return null;
  return c;
}
async function probeQQ() {
  const c = qqCfg();
  if (!c) return { key: 'qq', ok: false, why: '没找到 ~/.dsh/qq-bridge.config.json（QQ 桥接没配）' };
  const base = String(c.onebotHttp || 'http://127.0.0.1:3100/').replace(/\/$/, '');
  try {
    const r = await getJson(base + '/get_login_info?access_token=' + encodeURIComponent(c.token), 3000);
    const j = r.j || {};
    if (Number(j.retcode) !== 0 || !(j.data && j.data.user_id)) return { key: 'qq', ok: false, why: '协议端没登录（retcode ' + j.retcode + '）' };
    const to = String(c.ownerUin || c.peerUin || '');
    if (!to) return { key: 'qq', ok: false, why: '桥接没配 ownerUin（发给谁？）' };
    return { key: 'qq', ok: true, why: '协议端在线 · 小号 ' + j.data.user_id + '（' + (j.data.nickname || '') + '）', to };
  } catch (e) { return { key: 'qq', ok: false, why: 'OneBot 连不上：' + ((e && e.message) || e) }; }
}
async function sendQQ(text) {
  const p = await probeQQ();
  if (!p.ok) return { ok: false, error: p.why };
  try {
    const svc = gate.createService({ log: function () {} });
    const r = await svc.sendQqPrivateText(Number(p.to), text);
    if (!r || !r.ok) {
      const why = (r && (r.error || ('被安全闸门拦下（' + ((r.rules || []).join(' / ') || '规则') + '）'))) || '发送失败';
      return { ok: false, error: why };
    }
    return { ok: true, detail: '→ QQ ' + p.to + (r.verdict === 'redact' ? '（已打码）' : '') };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// 3. 飞书：dsh-im 装了才可能通（凭据在 设置 → IM机器人），没装就明确跳过
function probeFeishu() {
  const nm = path.join(ROOT, '引擎数据', '.dsh', 'profiles', 'web', 'node_modules', '@xmanrui', 'dsh-im');
  const installed = fs.existsSync(nm);
  if (!installed) return { key: 'feishu', ok: false, why: 'dsh-im 未装（装了把凭据绑在 设置 → IM机器人）' };
  return { key: 'feishu', ok: false, why: 'dsh-im 已装，但出口还没接（先绑凭据，再接 通道发送）' };
}

// 4. 其它：B站私信（她的小号 → 主人 UID）
function probeOther() {
  const acc = readJson(path.join(DATA, 'bili-account.json'), null);
  const pub = readJson(path.join(BILI_MEM, '发布.json'), {}) || {};
  if (pub.dmEnabled === false) return { key: 'other', ok: false, why: 'B站私信出口在 发布.json 里关着' };
  if (!acc || !acc.sessdata) return { key: 'other', ok: false, why: '没有 B站小号登录态（生活场景网页登录后点「同步账号」）' };
  if (!String(pub.ownerMid || '').trim()) return { key: 'other', ok: false, why: '没配主人 B站 UID（生活配置面板里填）' };
  return { key: 'other', ok: true, why: 'B站私信 → ' + pub.ownerMid, ownerMid: pub.ownerMid };
}
function sendOther(text) {
  const p = probeOther();
  if (!p.ok) return { ok: false, error: p.why };
  const r = spawnSync(process.execPath, [BILI_TOOL, '私信', '--说', text], { encoding: 'utf8', timeout: 60000, env: process.env });
  if (r.status !== 0) return { ok: false, error: String((r.stdout || r.stderr || '').trim()).slice(0, 240) || ('B站私信 exit ' + r.status) };
  return { ok: true, detail: '→ B站 ' + p.ownerMid };
}

const PROBES = { wechat: probeWechat, qq: probeQQ, feishu: probeFeishu, other: probeOther };

// 5. 探测全表
async function probeAll() {
  const out = [];
  for (const k of DEFAULTS.order) {
    let r;
    try { r = await PROBES[k](); } catch (e) { r = { key: k, ok: false, why: '探测异常：' + ((e && e.message) || e) }; }
    out.push({ key: k, label: LABEL[k], ok: !!r.ok, why: r.why || '', extra: r });
  }
  return out;
}

function appendLog(row) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (e) { /* 不挡发送 */ }
}

// 6. 发：按 order 挑第一个通的；发失败顺位往下（这就是「微信不通转 QQ」）
async function send(text, opts) {
  const cfg = config();
  const only = String((opts && opts.only) || '').trim();
  const list = only ? cfg.order.filter((k) => LABEL[k] === only || k === only) : cfg.order;
  if (!list.length) return { ok: false, error: '没有这个通道：' + only };
  const tried = [];
  for (const k of list) {
    const p = await PROBES[k]();
    if (!p.ok) { tried.push({ key: k, label: LABEL[k], skipped: p.why }); continue; }
    let r;
    if (k === 'wechat') r = await sendWechat(text, cfg);
    else if (k === 'qq') r = await sendQQ(text);
    else if (k === 'other') r = sendOther(text);
    else r = { ok: false, error: '飞书出口未接' };
    if (r.ok) {
      tried.push({ key: k, label: LABEL[k], sent: true, detail: r.detail || '' });
      return { ok: true, channel: k, label: LABEL[k], detail: r.detail || '', tried };
    }
    tried.push({ key: k, label: LABEL[k], failed: r.error || '未知' });
  }
  return { ok: false, error: '全部通道都不通', tried };
}

async function cmdProbe() {
  const list = await probeAll();
  if (has('--json')) { console.log(JSON.stringify({ at: stamp(), channels: list }, null, 2)); return 0; }
  say('主动出消息的顺序：' + config().order.map((k) => LABEL[k]).join(' → '));
  for (const c of list) say('  ' + (c.ok ? '✓ ' : '✗ ') + c.label.padEnd(3, '　') + ' ' + c.why);
  return 0;
}

async function cmdSend() {
  const text = String(val('--说', '')).trim();
  if (!text) { say('✗ 缺 --说 "要说的话"'); return 2; }
  const only = String(val('--通道', ''));
  const cfg = config();
  if (!cfg.enabled) { say('✗ 通道发送全局关着（通道优先级.json enabled=false）'); return 1; }

  if (has('--dry')) {
    const list = await probeAll();
    const pick = only
      ? list.find((x) => LABEL[x.key] === only || x.key === only)
      : list.find((x) => x.ok);
    say('--dry：不发。顺序 ' + cfg.order.map((k) => LABEL[k]).join(' → '));
    for (const c of list) say('  ' + (c.ok ? '✓ ' : '✗ ') + c.label + ' ' + c.why);
    say(pick ? ('会走：' + pick.label) : '会走：没有可用的，发不出去');
    return 0;
  }

  const r = await send(text, { only });
  writeJson(LAST_FILE, { at: stamp(), ok: !!r.ok, channel: r.channel || '', label: r.label || '', detail: r.detail || '', error: r.error || '', tried: r.tried || [] });
  appendLog({ at: stamp(), ok: !!r.ok, channel: r.channel || '', label: r.label || '', text: text.slice(0, 120), error: r.error || '' });
  if (!r.ok) {
    say('✗ ' + r.error);
    for (const t of r.tried || []) say('  · ' + t.label + '：' + (t.skipped || t.failed || ''));
    return 1;
  }
  say('✓ 发出去了 · ' + r.label + ' ' + (r.detail || ''));
  for (const t of (r.tried || [])) if (!t.sent) say('  · 跳过 ' + t.label + '：' + (t.skipped || t.failed || ''));
  return 0;
}

function cmdLast() {
  const last = readJson(LAST_FILE, null);
  if (!last) { say('还没发过。'); return 0; }
  say('最近一次：' + last.at + ' · ' + (last.ok ? '✓ ' + last.label + ' ' + (last.detail || '') : '✗ ' + last.error));
  for (const t of (last.tried || [])) say('  · ' + t.label + (t.sent ? ' 发了' : (t.skipped ? ' 跳过：' + t.skipped : ' 失败：' + (t.failed || ''))));
  return 0;
}

const table = { 探测: cmdProbe, 发: cmdSend, 状态: cmdLast };
if (!table[cmd]) {
  say('用法：node 工具\\通道发送.mjs 探测 [--json] ｜ 发 --说 "…" [--通道 微信] [--dry] ｜ 状态');
  process.exit(2);
}
Promise.resolve(table[cmd]()).then((c) => process.exit(c)).catch((e) => { say('✗ ' + ((e && e.message) || e)); process.exit(1); });
