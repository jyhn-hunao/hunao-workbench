#!/usr/bin/env node
// 通道记忆.mjs —— 把 QQ / 飞书 通道里真正聊过的话，自动落成人格的「对话」记忆（2026-11-13）
//
// 为什么要它：桥接插件只负责把消息送进人格会话，不会替她记；隔天再开口，只有上下文里的
//   那点残影。这里从**引擎会话转录**里把带通道前缀的往来捞出来，配成「他说 → 她答」写成条目。
//
// 为什么不改插件：插件是引擎侧的第三方依赖（升级整目录替换、手改就再也对不上游版本）。
//   数据面已经由 外壳\社交.js 解好了（zstd 转录 + platformOf），复用它是同一个风险面，
//   不额外引新的引擎内部格式。
//
// 用法：
//   node 12-源码照搬\工具\通道记忆.mjs            # 扫最近的通道往来并写入（已记过的跳过）
//   node 12-源码照搬\工具\通道记忆.mjs --dry      # 只打印会记哪几条
//   node 12-源码照搬\工具\通道记忆.mjs --条 40    # 本次最多记 40 组
// 退出码：0 = 完成（或没有新消息）/ 3 = 设置要求先确认 / 4 = 写入失败
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pet = require('../外壳/桌宠设置.js');
const social = require('../外壳/社交.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEMTOOL = path.join(ROOT, '工具', '人格记忆.mjs');
const CURSOR = path.join(ROOT, '外壳', 'data', 'pet', '通道游标.json');
// SnowLuma 会把「她实际发出去的话」记在这份日志里（含被引用的消息 id），比转录更可信
const BRIDGELOG = path.join(ROOT, '外壳', 'data', '桥接', 'snowluma.log');
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const say = (s) => console.log(s);
const DRY = has('--dry');
const LIMIT = Math.max(1, Number(val('--条', 60)) || 60);
const settings = pet.getSettings();
const mem = settings.memory || {};

if (mem.writeDialog === false) { say('✓ 设置里关了「记下聊过什么」⇒ 不记（要开：人格面板 ⚙ 设置 → 记忆）'); process.exit(0); }

// 1. 扫最近的会话转录：通道消息可能落在当前人格会话，也可能在换会话前被归档的旧会话里
//    只看带通道前缀的消息（QQ / 飞书），其余一律不碰 —— 这样扫多个会话也不会误记别的场景的对话。
const baseDir = path.join(pet.DSH_HOME, 'sessions');
const DAYS = Math.max(1, Number(val('--窗口', 7)) || 7);
const cutoff = Date.now() - DAYS * 86400000;
let files = [];
try {
  for (const d of fs.readdirSync(baseDir)) {
    const p1 = path.join(baseDir, d);
    if (!fs.statSync(p1).isDirectory()) continue;
    for (const sd of fs.readdirSync(p1)) {
      const f = path.join(p1, sd, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const mt = fs.statSync(f).mtimeMs;
      if (mt < cutoff) continue;
      files.push({ sid: sd, file: f, mt });
    }
  }
} catch (e) { say('✗ 读不到会话目录：' + baseDir); process.exit(4); }
files.sort((a, b) => b.mt - a.mt);
files = files.slice(0, 12);          // 只扫最近 12 个会话，防止越跑越慢

// 2. 按会话解：通道消息（them）带平台标记；她的回复本身没有标记，所以不能按 key 过滤掉。
//    同一条消息可能在多个 inbox 事件里重复出现，按「角色 + 原文前 80 字」去重。
function bodyOf(t) {
  const raw = String(t || '').trim();
  const m = /（(?:QQ|飞书)[^）]*）/ .exec(raw);
  if (m) return raw.slice(m.index + m[0].length).trim();
  return raw.replace(/^（关于他[^）]*）/,'').replace(/^（\d{4}-\d{2}-\d{2}[^）]*）\[#[^\]]*\]/,'').trim();
}
// 2.2 她真正发出去的话：从桥接日志里按「被引用的消息 id」对上（转录里有时只有空的 assistant 消息）
const replyById = {};
try {
  if (fs.existsSync(BRIDGELOG)) {
    const txt = fs.readFileSync(BRIDGELOG, 'utf8');
    const re = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\].*\[OneBot\] (?:私聊|群聊) (\d+) \| 发送：(?:\[回复:([-\d]+)\]\s*)?(.*)$/gm;
    let mm;
    while ((mm = re.exec(txt))) {
      const at = new Date(mm[1].replace(' ', 'T') + '+08:00').getTime();
      const body = String(mm[4] || '').trim();
      if (!body) continue;
      const rid = mm[3] || 'no-reply';
      if (rid !== 'no-reply') replyById[rid] = { at: at || 0, text: body };
    }
  }
} catch (e) { /* 日志读不到就当没有，不影响主流程 */ }
// 2.5 合并成一条时间线：她可能在被换掉的旧会话里回复，所以按时间全局配，而不是各会话各配。
//     配对规则：这句之后、下一条「他」之前、且 15 分钟内的「她」才算回复。
const line = [];
for (const it of files) {
  const events = social.readEvents(it.file);
  if (!events) continue;
  const msgs = social.messagesOf(events, 400);
  for (const m of msgs) {
    if (m.role === 'them' && m.key === 'other') continue;     // 非通道来源不参与
    // id：通道消息信封里的消息号（[#-1757928087]），用来和桥接日志里的「回复:id」对上
    line.push({ role: m.role, key: m.key, at: Number(m.at) || 0, text: m.role === 'them' ? bodyOf(m.text) : m.text, sid: it.sid, msgId: (/\[#([-\d]+)\]/.exec(String(m.text || '')) || [])[1] || '' });
  }
}
line.sort((a, b) => a.at - b.at);
const groups = [];
const seenThem = {};
for (let i = 0; i < line.length; i++) {
  const m = line[i];
  if (m.role !== 'them' || !m.text) continue;
  const sig = m.key + '|' + m.text.slice(0, 80);
  if (seenThem[sig]) continue;
  seenThem[sig] = 1;
  const hers = [];
  for (let j = i + 1; j < line.length && hers.length < 3; j++) {
    const nx = line[j];
    if (nx.role === 'them' && nx.key !== 'other') break;   // 只有「下一句通道来话」才算打断；换会话注入的开场/系统消息不算
    if (nx.at - m.at > 15 * 60 * 1000) break;
    if (nx.text) hers.push(nx.text);
  }
  // 转录里她的话有时是空的（回复走通道工具），按消息 id 从桥接日志补一句真实回复
  const lg = m.msgId && replyById[m.msgId];
  if (lg && lg.text && hers.indexOf(lg.text) < 0) hers.unshift(lg.text);
  groups.push({ key: m.key, at: m.at, them: m.text, hers });
}
if (!groups.length) { say('✓ 最近 ' + DAYS + ' 天的会话里没有通道往来（QQ / 飞书）'); process.exit(0); }
// 3. 游标：已记过的消息不再记（按 平台+时间+原话 的短哈希）
let state = {};
try { state = JSON.parse(fs.readFileSync(CURSOR, 'utf8')) || {}; } catch (e) { state = {}; }
state.seen = state.seen || {};
const h = (g) => crypto.createHash('sha1').update(g.key + '|' + g.at + '|' + g.them).digest('hex').slice(0, 12);
const fresh = groups.filter((g) => !state.seen[h(g)]);
if (!fresh.length) { say('✓ 没有新消息（已记过的会跳过）'); process.exit(0); }

// 4. 按「平台 + 当天」归并，一次写一条；标题带时刻，重复跑不会互相覆盖
function dayOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return { date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()), hm: p2(d.getHours()) + ':' + p2(d.getMinutes()) };
}
const buckets = new Map();
for (const g of fresh.slice(-LIMIT)) {
  const d = dayOf(g.at);
  const k = g.key + '|' + d.date;
  if (!buckets.has(k)) buckets.set(k, { key: g.key, date: d.date, start: d.hm, items: [] });
  const b = buckets.get(k);
  const clean = (t) => String(t).replace(/[|｜]/g, '｜').replace(/\s+/g, ' ').slice(0, 200);
  b.items.push(d.hm + ' 他：' + clean(g.them) + (g.hers.length ? ' → 她：' + g.hers.map(clean).join(' / ') : ' → 她：（未回）'));
}
const PLAT = { qq: 'QQ', feishu: '飞书' };

if (DRY) {
  say('（--dry）会写 ' + buckets.size + ' 条，共 ' + fresh.length + ' 组往来：');
  for (const b of buckets.values()) {
    say('· ' + (PLAT[b.key] || b.key) + ' · ' + b.date + ' · ' + b.items.length + ' 组');
    b.items.slice(0, 3).forEach((x) => say('    ' + x));
  }
  process.exit(0);
}

// 5. 写入：统一走 人格记忆.mjs（开关、确认、索引、近期摘要、闸门都在那边执行）
let bad = 0;
const done = [];
for (const b of buckets.values()) {
  const title = '通道对话 · ' + (PLAT[b.key] || b.key) + ' · ' + b.date + ' · ' + b.start;
  const r = spawnSync(process.execPath || 'node', [MEMTOOL, '写', '--类', '对话', '--标题', title,
    '--要点', b.items.join('|'), '--来源', (PLAT[b.key] || b.key) + ' 通道', '--另存'], { cwd: ROOT, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const out = String((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status === 0) { done.push(b); if (out) say('  ' + out.split('\n')[0].trim()); }
  else if (r.status === 3) { say('⚠ 设置要求「写之前先问我」⇒ 这批没写。确认后加 --确认 再跑：node 12-源码照搬\\工具\\通道记忆.mjs --确认'); process.exit(3); }
  else { bad += 1; say('✗ 写失败：' + (out.split('\n').filter((x) => x.includes('✗'))[0] || out.split('\n')[0] || '未知原因')); }
}

// 6. 成功记过的才推游标，失败的下一轮还会重试
if (done.length) {
  for (const g of fresh.slice(-LIMIT)) state.seen[h(g)] = 1;
  state.last = new Date().toISOString();
  const keys = Object.keys(state.seen).slice(-800);   // 只留最近 800 个指纹，文件不会无限长
  const keep = {};
  for (const k of keys) keep[k] = state.seen[k];
  fs.mkdirSync(path.dirname(CURSOR), { recursive: true });
  fs.writeFileSync(CURSOR, JSON.stringify({ seen: keep, last: state.last }, null, 2), 'utf8');
}
say(bad ? '✗ 有 ' + bad + ' 条没写成' : '✓ 通道往来已记入人格「对话」记忆（' + done.length + ' 条）');
process.exit(bad ? 4 : 0);
