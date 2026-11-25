#!/usr/bin/env node
// @功能台 {"name":"自主记忆","group":"记忆","freq":"10m","plain":"每 10 分钟把「胡闹的大肥鱼」面板上的真实对话落成当天的对话记忆，并自动刷索引与近期记忆；不用人敲命令。","why":"记忆不能靠人手动维护：她每天在面板里说的话，隔天就只剩上下文残影。","label":"自主记忆","timeout":180000}
// 自主记忆.mjs —— 面板对话的自动落盘（2026-11-25）
//
// 为什么要有它：`通道记忆.mjs` 只管 QQ / 微信 / 飞书；面板里跟她聊的话没人记，
//   隔天开场注入里看不到，等于没发生过。这里按会话游标增量扫，只收真人说的话，
//   按天写成 `对话\YYYY-MM-DD-面板.md`，再自己刷 `_索引.json` 与 `_近期.md`。
//
// 它做什么：
//   1) 从 pet.json 找到面板真正绑定的会话（不是按标题猜最近的），再补扫同名的旧会话（换会话归档后不丢尾段）；
//   2) 按会话游标读转录，配对「他说的 → 她答的」，跳过注入块 / 回执 / 通道信封；
//   3) 按天追加到 对话\YYYY-MM-DD-面板.md（带 frontmatter，正文按时间分小节）；
//   4) 自动补 对话\_索引.md 一行、`场景记忆.mjs 索引 --场景 胡闹的大肥鱼`、`人格记忆.mjs 近期`；
//   5) 把本次结果写进 外壳\data\pet\自主记忆.json（界面/巡检可查）。
//
// 用法：
//   node 工具\自主记忆.mjs            增量抓一次（定时任务用这个）
//   node 工具\自主记忆.mjs --dry      只看会记哪几条，不落盘
//   node 工具\自主记忆.mjs status     看上次结果与游标
//   node 工具\自主记忆.mjs --窗口 7   首次回看几天（默认 3）
// 退出码：0 完成 / 1 失败 / 2 参数不成立
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, DSH_HOME, loadSessions, resolveSession, transcriptOf, readEvents, finalTextOf
} from './派发-公共.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERSONA = '胡闹的大肥鱼';
const MEM = path.join(DSH_HOME, '场景记忆', PERSONA);
const TALK = path.join(MEM, '对话');
const IDX_TALK = path.join(TALK, '_索引.md');
const DATA = path.join(ROOT, '外壳', 'data', 'pet');
const CURSOR = path.join(DATA, '自主记忆游标.json');
const STATUS = path.join(DATA, '自主记忆.json');
const SCENE_TOOL = path.join(HERE, '场景记忆.mjs');
const PERSONA_TOOL = path.join(HERE, '人格记忆.mjs');
const SCENARIO = path.join(ROOT, '外壳', 'scenarios', 'pet.json');

const argv = process.argv.slice(2);
const cmd = (argv[0] && !argv[0].startsWith('-')) ? String(argv[0]) : 'capture';
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const has = (k) => argv.includes(k);
const DRY = has('--dry');
const DAYS = Math.max(1, Number(val('--窗口', '3')) || 3);
const say = (s) => console.log(s);

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } }
function writeJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
}
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function localDate(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function clock(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 面板真正绑定的会话：pet.json 的 pet-ai.sessionId 优先，缺失才按标题取最近 */
function boundSession(sessions) {
  const j = readJson(SCENARIO, null);
  const p = j && Array.isArray(j.panels) ? j.panels.find((x) => x && x.id === 'pet-ai') : null;
  const sid = String((p && p.sessionId) || '');
  if (sid && sessions.has(sid)) return sessions.get(sid);
  if (sid) {
    const t = transcriptOf(sid);
    if (t) return { id: sid, title: String((p && p.sessionTitle) || PERSONA) };
  }
  return resolveSession(sessions, PERSONA);
}

/** 一条 user/message 的正文；注入块一律不认 */
function userTextOf(e) {
  const c = (e && e.data && e.data.content) || [];
  return c.filter((x) => x && x.type === 'text').map((x) => String(x.text || '')).join('\n').trim();
}
const SKIP = /^(?:<system-reminder|【(?:回执|派发|系统|记忆|自动|日记|周记|回信路由|人格回想|任务)|（(?:QQ|微信|飞书))/;
function cleanUser(t) {
  let s = String(t || '').replace(/\r\n/g, '\n').trim();
  if (!s || SKIP.test(s)) return '';
  // 人偶尔会把系统块粘进来：从第一个 <system-reminder 起截掉
  const cut = s.indexOf('<system-reminder');
  if (cut >= 0) s = s.slice(0, cut).trim();
  if (!s || s.length < 2) return '';
  return s.slice(0, 600);
}
const TECH_RE = /(?:DSH_TOKEN|server\.log|换不到\s*cookie|拿不到.{0,12}token|派不出去|OneBot\s*502|CLI\s*环境|引擎\s*token)/i;
function cleanReply(t) {
  let s = String(t || '').replace(/\r\n/g, '\n').trim();
  if (!s) return '';
  if (s.startsWith('【')) return '';                 // 系统回执不是她的话
  // 工具故障的整段过程不进人格记忆：保留同一回复里正常的话，整段都是故障就记一句中性的
  if (TECH_RE.test(s)) {
    const kept = s.split(/\n{2,}/).filter((p) => !TECH_RE.test(p)).join('\n\n').trim();
    s = kept || '（这轮在修工具，技术过程不写进记忆）';
  }
  return s.slice(0, 800);
}

/** 配对：最后一个真人 user/message → 该轮 turn/end 的最终文本 */
function pairsOf(events) {
  const out = [];
  let last = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user') {
      const t = cleanUser(userTextOf(e));
      const turn = e.data.turn != null ? Number(e.data.turn) : null;
      if (t && last && last.turn != null && turn != null && last.turn === turn) {
        // 同一轮里人连发两条：都留下，别只记最后一句
        last.text = (last.text + '\n' + t).slice(0, 900);
      } else if (t) {
        last = { text: t, time: Number(e.time) || 0, turn };
      }
    }
    if (e && e.type === 'turn/end') {
      const turn = Number((e.data && e.data.turn) || 0);
      const reply = cleanReply(finalTextOf(events, turn));
      if (last && reply && (last.turn == null || last.turn === turn)) {
        out.push({ turn, time: last.time || Number(e.time) || 0, user: last.text, reply });
      }
      last = null;
    }
  }
  return out;
}

function ensureTalk() {
  fs.mkdirSync(TALK, { recursive: true });
  if (!fs.existsSync(IDX_TALK)) fs.writeFileSync(IDX_TALK, '# 对话索引\n\n> 一行一条：日期 · 来源 · 标题 · 文件。只追加。\n\n', 'utf8');
}
function addTalkIndex(day, rel) {
  const line = '- ' + day + ' · 面板 · 日常对话 · `' + rel + '`';
  const t = readText(IDX_TALK);
  if (t.includes(line)) return false;
  fs.writeFileSync(IDX_TALK, t.replace(/\s*$/, '\r\n') + line + '\r\n', 'utf8');
  return true;
}
function dayFile(day) {
  return path.join(TALK, day + '-面板.md');
}
function ensureDayFile(day) {
  const f = dayFile(day);
  if (fs.existsSync(f)) return { file: f, fresh: false };
  const body = [
    '---',
    'date: ' + day,
    'kind: 对话',
    'source: 面板',
    '---',
    '',
    '# ' + day + ' · 面板对话',
    '',
    ''
  ].join('\r\n');
  fs.writeFileSync(f, body, 'utf8');
  return { file: f, fresh: true };
}
function appendPair(day, p) {
  const f = dayFile(day);
  const block = [
    '',
    '## ' + clock(p.time) + ' 他',
    '',
    p.user,
    '',
    '**我：** ' + p.reply,
    ''
  ].join('\r\n');
  const cur = readText(f).replace(/\r?\n/g, '\r\n').replace(/\s*$/, '\r\n');
  fs.writeFileSync(f, cur + block, 'utf8');
}

function runTool(tool, args) {
  const r = spawnSync(process.execPath || 'node', [tool].concat(args), { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { ok: r.status === 0, out: String((r.stdout || '') + (r.stderr || '')).trim() };
}

/**
 * 同一人格的所有会话：当前面板绑定优先，其次是同名旧会话（换会话归档后的那几条）。
 * 换会话时面板会指向新会话，旧会话最后一段如果没人扫，就永久丢在转录里。
 * 旧会话按创建时间倒序最多看 4 条；很久没动的会在 captureOne 里按文件修改时间跳过。
 */
function candidateSessions(sessions, primary) {
  const out = [];
  const add = (s) => { if (s && s.id && !out.some((x) => x.id === s.id)) out.push(s); };
  add(primary);
  const old = [...sessions.values()]
    .filter((s) => s && (s.title === PERSONA || s.title.startsWith(PERSONA + ' (')))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 4);
  old.forEach(add);
  return out;
}

/** 单会话增量：读游标 → 配对 → 追加 → 算安全游标；dry 只算不写 */
function captureOne(s, state, cutoff, seen, dry) {
  const file = transcriptOf(s.id);
  if (!file) return { id: s.id, title: s.title || '', skip: '找不到转录' };
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* 读不到就按 0，下面按空转录处理 */ }
  if (mtime && mtime < cutoff) return { id: s.id, title: s.title || '', skip: '窗口内没动过' };
  const events = readEvents(file);
  if (!events || !events.length) return { id: s.id, title: s.title || '', skip: '转录读不出来' };

  const prev = state.sessions[s.id] || { processed: 0 };
  let start = Number(prev.processed) || 0;
  if (!start) {
    // 首次：只回看窗口内的消息，别把整份历史一口气抄进对话
    const idx = events.findIndex((e) => e && Number(e.time) >= cutoff);
    start = idx > 0 ? idx : 0;
  }
  if (start > events.length) start = 0;   // 转录被重写过（换会话/压缩）就重扫，靠 hashes 去重

  // 首次也只收窗口内的消息：start 已经对齐到窗口起点，这里再按 p.time 过滤，
  //   避免「会话近期没消息、start 退到 0」时把整段历史一口气抄进对话。
  const pairs = pairsOf(events.slice(start)).filter((p) => p.time >= cutoff);
  const fresh = [];
  for (const p of pairs) {
    const h = crypto.createHash('sha1').update(p.time + '|' + p.user + '|' + p.reply).digest('hex').slice(0, 12);
    p.hash = h;
    if (seen.has(h)) continue;
    seen.add(h);
    fresh.push(p);
  }

  if (!dry) {
    const days = new Set();
    fresh.forEach((p) => {
      const day = localDate(p.time);
      days.add(day);
      ensureDayFile(day);
      appendPair(day, p);
    });
    days.forEach((day) => addTalkIndex(day, '对话\\' + day + '-面板.md'));
    return { id: s.id, title: s.title || '', events: events.length, start, added: fresh.length, days: [...days], safeEnd: safeEndOf(events, start) };
  }
  return {
    id: s.id, title: s.title || '', events: events.length, start, added: fresh.length,
    days: [...new Set(fresh.map((p) => localDate(p.time)))], safeEnd: safeEndOf(events, start), fresh
  };
}

function safeEndOf(events, start) {
  // 游标只前移到「最后一个已收尾的回合」：末尾那条刚发出、还没等到回复的用户消息要留给下一轮，
  //   否则这一轮抓不到它，下一轮从 events.length 往后看就永远配不上对了。
  let safeEnd = start;
  for (let i = start; i < events.length; i++) {
    if (events[i] && events[i].type === 'turn/end') safeEnd = i + 1;
  }
  return safeEnd < start ? start : safeEnd;
}

function cmdCapture() {
  try {
    return cmdCaptureInner();
  } catch (e) {
    // 采集途中抛异常（写盘失败 / 转录损坏 / 锁异常）也要留下可见状态，
    // 否则 status 仍是上一次成功，自动巡检就看不见这次失败。
    const msg = String((e && e.stack) || e || '未知错误');
    const prev = readJson(STATUS, null) || {};
    try {
      writeJson(STATUS, Object.assign({}, prev, {
        at: new Date().toISOString(),
        error: '采集异常：' + msg.slice(0, 300)
      }));
    } catch { /* 状态也写不进去时只能靠 stdout / server.log */ }
    say('✗ 自主记忆异常：' + msg.slice(0, 300));
    return 1;
  }
}

function cmdCaptureInner() {
  const sessions = loadSessions();
  const to = boundSession(sessions);
  if (!to) { say('✗ 找不到「' + PERSONA + '」的会话：引擎没在跑，或还没建会话'); return 2; }
  const state = readJson(CURSOR, { version: 1, sessions: {}, hashes: [] });
  const cutoff = Date.now() - DAYS * 86400000;
  const seen = new Set(Array.isArray(state.hashes) ? state.hashes : []);
  if (!DRY) ensureTalk();   // 落盘前先建 对话\ 与 _索引.md，空目录也能写
  const targets = candidateSessions(sessions, to);
  const results = targets.map((s) => captureOne(s, state, cutoff, seen, DRY));

  const primary = results.find((r) => r.id === to.id) || results[0];
  if (primary && primary.skip && primary.skip !== '窗口内没动过') {
    say('✗ ' + (primary.id === to.id ? '当前会话' : '会话') + '不可读：' + primary.skip + '（' + to.id + '）');
    return primary.id === to.id ? 1 : 0;
  }

  const added = results.reduce((n, r) => n + (r.added || 0), 0);
  const days = [...new Set(results.flatMap((r) => r.days || []))];

  if (DRY) {
    say('--dry：将记 ' + added + ' 条（扫描 ' + results.filter((r) => !r.skip).length + ' 个会话）');
    results.forEach((r) => {
      const tail = r.skip ? '跳过（' + r.skip + '）' : '将记 ' + r.added + ' 条（游标 ' + r.start + '/' + r.events + '）';
      say('  · ' + (r.title || r.id) + '：' + tail);
      (r.fresh || []).slice(0, 5).forEach((p) => say('    ' + localDate(p.time) + ' ' + clock(p.time) + ' | ' + p.user.slice(0, 40).replace(/\n/g, ' ') + ' → ' + p.reply.slice(0, 40).replace(/\n/g, ' ')));
    });
    return 0;
  }

  // 游标前移；hash 只留最近 1200 条（一年也够去重）。只写真正扫过的会话，跳过的保持原游标。
  state.version = 1;
  state.sessions = state.sessions || {};
  results.filter((r) => !r.skip).forEach((r) => {
    state.sessions[r.id] = { processed: Number(r.safeEnd) || 0, lastAt: Date.now(), title: r.title || '' };
  });
  state.hashes = [...seen].slice(-1200);
  writeJson(CURSOR, state);

  const prevSt = readJson(STATUS, null) || {};
  const status = {
    at: new Date().toISOString(),
    sessionId: to.id,
    sessionTitle: to.title || '',
    events: (primary && primary.events) || 0,
    scanned: results.filter((r) => !r.skip).length,
    added,
    days,
    sessions: results.map((r) => ({ id: r.id, title: r.title || '', events: r.events || 0, added: r.added || 0, skip: r.skip || '' })),
    // 本轮没有新条目时沿用上一轮的结论，别把「上次索引成功」显示成「没刷」
    indexed: added ? false : !!prevSt.indexed,
    recent: added ? false : !!prevSt.recent,
    error: ''
  };

  if (added) {
    const idx = runTool(SCENE_TOOL, ['索引', '--场景', PERSONA]);
    status.indexed = idx.ok;
    if (!idx.ok) status.error = '索引失败：' + idx.out.slice(0, 300);
    const rec = runTool(PERSONA_TOOL, ['近期']);
    status.recent = rec.ok;
    if (!rec.ok && !status.error) status.error = '近期记忆失败：' + rec.out.slice(0, 300);
  }
  writeJson(STATUS, status);

  say('✓ 自主记忆：新增 ' + added + ' 条' + (added ? '（' + days.join(' / ') + '）' : '')
    + ' · 扫描 ' + status.scanned + ' 个会话'
    + ' · 索引 ' + (added ? (status.indexed ? '已刷' : '失败') : '无新条目不用刷')
    + (status.error ? (' · ' + status.error) : ''));
  return status.error ? 1 : 0;
}

function cmdStatus() {
  const st = readJson(STATUS, null);
  const cur = readJson(CURSOR, { sessions: {} });
  if (!st) { say('还没有跑过自主记忆。跑一次：node 工具\\自主记忆.mjs'); return 0; }
  say('自主记忆 · 上次 ' + st.at);
  say('  会话：' + (st.sessionTitle || st.sessionId) + (st.scanned != null ? '（扫描 ' + st.scanned + ' 个同名会话）' : ''));
  say('  新增 ' + st.added + ' 条' + (st.days && st.days.length ? '（' + st.days.join(' / ') + '）' : ''));
  say('  索引 ' + (st.indexed ? '✓' : '—') + ' · 近期记忆 ' + (st.recent ? '✓' : '—'));
  if (st.error) { say('✗ 自主记忆上次失败：' + st.error); return 1; }
  Object.keys((cur && cur.sessions) || {}).forEach((sid) => {
    const s = cur.sessions[sid];
    say('  游标 ' + sid + '：' + s.processed + ' 条事件 · ' + new Date(s.lastAt).toLocaleString());
  });
  return 0;
}

const table = { capture: cmdCapture, status: cmdStatus };
if (!table[cmd]) { say('用法：node 工具\\自主记忆.mjs [--dry] ｜ status'); process.exit(2); }
try {
  process.exit(table[cmd]());
} catch (e) {
  say('✗ ' + ((e && e.message) || e));
  try {
    const p = path.join(DATA, '自主记忆.json');
    const old = readJson(p, {}) || {};
    old.error = String((e && e.message) || e).slice(0, 300);
    old.at = new Date().toISOString();
    writeJson(p, old);
  } catch { /* 状态写不进也不影响退出码 */ }
  process.exit(1);
}
