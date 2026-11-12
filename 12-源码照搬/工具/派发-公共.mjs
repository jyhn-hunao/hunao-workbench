// 派发-公共.mjs —— 「跨会话派发 → 回执」三个脚本共用的读写与引擎调用
//
// 为什么单独一个文件：派发.mjs / 等回执.mjs / 回执.mjs 都要做同样四件事
//   （找会话、算 transcript、换 cookie、投一条消息），复制三份必漂移。
//
// 口径（2026-11-12 与用户确认过的现场）：
//   · 派发 = 引擎 RPC session/prompt，和 建会话.mjs 同一套 token→cookie→POST /api/<method>；
//   · 回执 = 反过来给派发方会话再投一条 session/prompt（mode: queue，不抢正在跑的回合）；
//   · 派发单落 引擎数据\.dsh\派发\（运行时数据，已加 .gitignore），回执按单子对账，不猜。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');                         // 12-源码照搬
export const DSH_HOME = process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh');
export const SHELL = path.join(ROOT, '外壳');
export const DISPATCH_DIR = path.join(DSH_HOME, '派发');
export const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3083';

// 1. 会话索引：逐会话缓存文件（真源）+ 总表补齐（抄 项目切换.js 的口径）
export function loadSessions() {
  const out = new Map();
  const dir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(path.join(dir, f));
    const rec = j && j.record;
    if (!rec) continue;
    const rows = rec.rows || {};
    out.set(f.replace(/\.json$/, ''), {
      id: f.replace(/\.json$/, ''),
      title: String((rows.title && rows.title.val) || '').trim(),
      cwd: String((rec.identity && rec.identity.cwd) || ''),
      at: Number((rec.identity && rec.identity.createdAt) || 0)
    });
  }
  const total = readJson(path.join(DSH_HOME, 'storages', 'session_projcache.json'));
  const tbl = total && total.tables && total.tables.sessions;
  for (const id of Object.keys(tbl || {})) {
    if (out.has(id)) continue;
    const v = tbl[id] || {};
    const rows = v.rows || {};
    out.set(id, {
      id,
      title: String((rows.title && rows.title.val) || '').trim(),
      cwd: String((v.identity && v.identity.cwd) || ''),
      at: Number((v.identity && v.identity.createdAt) || 0)
    });
  }
  return out;
}

// 2. 按标题或 id 认会话：id 直接认；标题要逐字相等，多条取最近建的那条
export function resolveSession(sessions, want) {
  const w = String(want || '').trim();
  if (!w) return null;
  if (sessions.has(w)) return sessions.get(w);
  const hit = [...sessions.values()].filter((s) => s.title === w).sort((a, b) => b.at - a.at);
  return hit[0] || null;
}

// 3. 会话正文：引擎按 cwd 分目录，目录名编码过 ⇒ 不做文件名推导，直接遍历找 <sessionId>
export function transcriptOf(sessionId) {
  const base = path.join(DSH_HOME, 'sessions');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, sessionId, 'session.v4.jsonl.zstd');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 4. 解 transcript：zstd 单帧，尾部半行会坏 ⇒ 坏行跳过；解压失败返回 null（写入中会这样，调用方重试）
export function readEvents(file) {
  if (!file || !fs.existsSync(file)) return null;
  let txt;
  try { txt = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'); } catch { return null; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 尾行只写了一半 */ }
  }
  return out;
}

export function turnStats(events) {
  if (!events) return null;
  const ends = events.filter((e) => e.type === 'turn/end');
  return { count: ends.length, lastTurn: ends.length ? Number(ends[ends.length - 1].data.turn) : 0 };
}

// 5. 取某轮的最后一条 assistant 正文（只拼 text 段，reasoning 不要）
export function finalTextOf(events, turn) {
  if (!events) return '';
  const msgs = events.filter((e) => e.type === 'assistant/message' && Number(e.data && e.data.turn) === turn);
  const last = msgs[msgs.length - 1];
  if (!last) return '';
  const c = (last.data.message && last.data.message.content) || [];
  return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
}

// 6. 换签名 cookie（必须 redirect:'manual'；token 正则跟 BASE 端口走，别写死 3080）
export async function getCookie() {
  const log = path.join(SHELL, 'server.log');
  const port = (() => { try { return new URL(BASE).port || '80'; } catch { return ''; } })();
  const toks = fs.existsSync(log)
    ? [...fs.readFileSync(log, 'utf8').matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]{16,})/g)]
        .filter((m) => !port || m[1] === port).map((m) => m[2]).reverse()
    : [];
  for (const t of toks.slice(0, 3)) {
    try {
      const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) return sc.map((c) => c.split(';')[0]).join('; ');
    } catch { /* 换下一条 */ }
  }
  throw new Error('换不到 cookie：引擎没在跑（' + BASE + '）或 server.log 里没有可用 token');
}

// 7. 投一条用户消息（派发与回执共用）；失败必须抛，不静默
export async function promptSession(sessionId, text, cookie) {
  const ck = cookie || await getCookie();
  const requestId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const r = await fetch(BASE + '/api/session/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie: ck },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'dispatch', method: 'session/prompt',
      payload: { args: { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] } } }
    })
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* 非 JSON 原样带出 */ }
  if (!r.ok || !(j && j.result && j.result.value && j.result.value.accepted)) {
    throw new Error('投递失败（HTTP ' + r.status + '）：' + t.slice(0, 200));
  }
  return true;
}

// 8. 派发单：一个任务一张，id = 时间戳 + 目标会话尾号；写盘后再派发，崩了也能追
export function ensureDispatchDir() {
  fs.mkdirSync(DISPATCH_DIR, { recursive: true });
}

export function newTicket({ from, fromTitle, to, toTitle, text, turnsBefore }) {
  const now = new Date();
  const stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0')
    + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
  const ticket = {
    id: stamp + '-' + String(to).slice(-6),
    from, fromTitle: fromTitle || '',
    to, toTitle: toTitle || '',
    text: String(text || '').slice(0, 300),
    turnsBefore,
    createdAt: Date.now(),
    state: 'pending',
    replyAt: 0,
    reply: ''
  };
  ensureDispatchDir();
  const file = path.join(DISPATCH_DIR, ticket.id + '.json');
  fs.writeFileSync(file, JSON.stringify(ticket, null, 2), 'utf8');
  return { ticket, file };
}

export function readTicket(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function findTicketFile(idOrPath) {
  if (!idOrPath) return null;
  if (fs.existsSync(idOrPath)) return idOrPath;
  const id = String(idOrPath).replace(/\.json$/, '');     // 允许传「2026…-eaf220.json」或纯 id
  const p = path.join(DISPATCH_DIR, id + '.json');
  return fs.existsSync(p) ? p : null;
}

export function saveTicket(file, ticket) {
  fs.writeFileSync(file, JSON.stringify(ticket, null, 2), 'utf8');
}

// 9. 回执日志：人要看「派过什么、回没回」，一行一条，只追加
export function appendLog(line) {
  ensureDispatchDir();
  fs.appendFileSync(path.join(DISPATCH_DIR, '回执日志.md'), '- ' + line + '\n', 'utf8');
}

export function tail(s, n) {
  const t = String(s || '').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

// 10. 本地时间戳：日志和回执正文都给人看，别甩 UTC（2026-11-12 实测 ISO 会差 8 小时）
export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
