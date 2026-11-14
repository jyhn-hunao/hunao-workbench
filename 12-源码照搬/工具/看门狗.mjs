#!/usr/bin/env node
// 看门狗.mjs —— 派发单巡检：一张单到底是「还在跑」「压根没进会话」还是「干完了没回执」
//
// 为什么要有它：派发.mjs 会顺手起一个后台 等回执.mjs，但那只在「那个后台进程还活着」时有效——
//   机器重启、壳关掉、进程被杀、或用户加了 --no-watch，单子就永远停在 pending，
//   没人会发现「活干完了，派发方还蒙在鼓里」。2026-11-14 按 Super-agent 的 Watchdog 补这一环：
//   只读派发单 + transcript，判定后报，不替人做决定、不改单子。
//
// 用法：
//   node 工具\看门狗.mjs                       # 人读报告；有 ERR 时退出码 1
//   node 工具\看门狗.mjs --warn 30 --err 60    # 阈值（分钟；默认 30 / 60，与 等回执 默认 3600 秒对齐）
//   node 工具\看门狗.mjs --all                 # 连 done 一起列（默认只列未闭环的）
//   node 工具\看门狗.mjs --json                # 给计划任务 / 界面消费
//   node 工具\看门狗.mjs --strict              # warn 也算失败（退出码 1）
//   node 工具\看门狗.mjs --补                  # 对「已干完·未回执」的单补投一次回执（复用 等回执 --once）
//
// 判定（口径同 等回执.mjs，不另发明一套）：
//   state=done                     → 已回执，闭环
//   state=done 但外层单仍 pending    → 已回执·外层未结 ⇒ WARN（分层上浮没走完）
//   state=closed                   → 人工作废，不再跟踪
//   state=timeout                  → 超时已报过但仍没人收尾 ⇒ ERR
//   transcript 里没有含单号的消息  → 投递可能失败 / 会话被换掉 ⇒ 超阈值 ERR
//   有消息、但那轮还没 turn/end   → 在跑（按阈值分 ok / warn / err）
//   有轮、正文为空                 → 回合结束但结论空 ⇒ warn
//   有轮、有正文、单子仍 pending   → 已干完·未回执 ⇒ 刚干完 warn / 超阈值 ERR
//
// ⛔ 默认只读：不投消息、不改派发单；只有显式 --补 才投一次回执。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DISPATCH_DIR, readTicket, findTicketFile, transcriptOf, readEvents, finalTextOf, nowStamp
} from './派发-公共.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
// 取数值型参数：只认正的有限数，否则退回默认（别让 --warn abc 变成 NaN 一路传下去）
const num = (k, d) => {
  const i = argv.indexOf(k);
  const n = Number(i >= 0 ? argv[i + 1] : '');
  return Number.isFinite(n) && n > 0 ? n : d;
};

const warnMin = num('--warn', 30);
const errMin = Math.max(warnMin, num('--err', 60));
const JSON_OUT = has('--json');
const STRICT = has('--strict');
const AUTO_FIX = has('--补');
const SHOW_ALL = has('--all');
const STAMP = nowStamp();

// 1. 收集派发单：目录不存在 = 还没派过活，不算故障
function collect() {
  if (!fs.existsSync(DISPATCH_DIR)) return [];
  return fs.readdirSync(DISPATCH_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(DISPATCH_DIR, f);
      return { file, ticket: readTicket(file) };
    })
    .filter((x) => x.ticket && x.ticket.state);
}

// 2. 会话事件只解一次：多张单常指向同一个目标会话，而 zstd 解压并不便宜
const eventCache = new Map();
function eventsOf(sessionId) {
  if (eventCache.has(sessionId)) return eventCache.get(sessionId);
  let ev = null;
  try { ev = readEvents(transcriptOf(sessionId)); } catch { ev = null; }   // 解不开 = 没写完 / 会话没了，交给判定说"读不到"，不猜
  eventCache.set(sessionId, ev);
  return ev;
}

// 3. 定位「我们派的那条消息」所在回合：含单号的 user/message → 其后第一个 turn/end
function locate(events, ticketId) {
  if (!events) return { found: false, turn: null };
  const idx = events.findIndex((e) => e.type === 'user/message'
    && JSON.stringify(e.data || {}).includes(ticketId));
  if (idx < 0) return { found: false, turn: null };
  const end = events.slice(idx).find((e) => e.type === 'turn/end');
  return { found: true, turn: end ? Number(end.data.turn) : null };
}

// 4.0 外层单是否还没结：分层派发时子单 done、外层仍 pending = 上浮没走完，要报 WARN 而不是 OK
function outerPendingOf(t) {
  if (!t || !t.parent) return '';
  const pf = findTicketFile(t.parent);
  const pt = pf ? readTicket(pf) : null;
  return pt && pt.state === 'pending' ? pt.id : '';
}

// 4. 判一张单：level(ok | warn | err) + verdict + detail；阈值只用在还没闭环的单上
function judge(t) {
  const created = Number(t.createdAt) || 0;
  const ageMin = created ? Math.floor((Date.now() - created) / 60000) : -1;

  if (t.state === 'closed') {
    return { level: 'ok', verdict: '已作废', detail: '人工作废的单，不再跟踪' + (t.closedWhy ? '（' + t.closedWhy + '）' : ''), ageMin };
  }
  if (t.state === 'done') {
    const pend = outerPendingOf(t);
    if (pend) {
      return { level: 'warn', verdict: '已回执·外层未结', detail: '子单已交付，但它挂的外层单 ' + pend + ' 还 pending（上浮没把外层结掉）', ageMin };
    }
    return { level: 'ok', verdict: '已回执', detail: t.reply ? '结论 ' + String(t.reply).length + ' 字' : '', ageMin };
  }
  if (t.state === 'timeout') {
    return { level: 'err', verdict: '超时未交付', detail: '等回执报过超时，单子仍未闭环，要人看一眼', ageMin };
  }
  if (!created) {
    return { level: 'warn', verdict: '单子缺 createdAt', detail: '判不了时长，按单号人看', ageMin };
  }

  const events = eventsOf(t.to);
  if (!events) {
    return { level: 'warn', verdict: '读不到 transcript', detail: '会话「' + (t.toTitle || t.to) + '」没有 transcript（可能已归档或重建），判不了', ageMin };
  }
  const at = locate(events, t.id);
  if (!at.found) {
    return { level: ageMin > warnMin ? 'err' : 'warn', verdict: '消息没进会话', detail: 'transcript 里找不到单号：投递可能失败，或目标会话已被换掉', ageMin };
  }
  if (at.turn == null) {
    return {
      level: ageMin > errMin ? 'err' : (ageMin > warnMin ? 'warn' : 'ok'),
      verdict: '在跑', detail: '已发出 ' + ageMin + ' 分钟，那一轮还没结束', ageMin
    };
  }
  const text = finalTextOf(events, at.turn);
  if (!text) {
    return { level: ageMin > warnMin ? 'err' : 'warn', verdict: '回合结束·结论为空', detail: '第 ' + at.turn + ' 轮已结束但没有正文（可能还在写最后一段，也可能答空了）', ageMin };
  }
  return {
    level: ageMin > warnMin ? 'err' : 'warn', verdict: '已干完·未回执',
    detail: '第 ' + at.turn + ' 轮已结束、结论 ' + text.length + ' 字，单子还 pending（多半是 等回执.mjs 没在跑）',
    ageMin, text
  };
}

// 5. --补：只对「已干完·未回执」补一次回执，直接复用 等回执.mjs --once（不另写一套投递）
function autoReply(file) {
  const w = path.join(HERE, '等回执.mjs');
  if (!fs.existsSync(w)) return { ok: false, out: '等回执.mjs 不在：' + w };
  const r = spawnSync(process.execPath, [w, '--ticket', file, '--once'], {
    encoding: 'utf8', windowsHide: true, timeout: 120000
  });
  const out = String((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: /已回执/.test(out), out: out || ('退出码 ' + r.status) };
}

// 6. 主流程：判 →（可选）补 → 汇总 → 打印；有 ERR（--strict 时含 WARN）就退出码 1
const items = collect().map((x) => ({ file: x.file, ticket: x.ticket, ...judge(x.ticket) }));

if (AUTO_FIX) {
  for (const it of items) {
    if (it.verdict !== '已干完·未回执') continue;
    const r = autoReply(it.file);
    it.fixed = r.ok;
    it.detail += r.ok ? '｜已自动补投回执' : '｜补投失败：' + r.out.split('\n').filter(Boolean).slice(-1)[0];
    if (r.ok) it.level = 'ok';
  }
}

const rank = { err: 0, warn: 1, ok: 2 };
const sorted = items.slice().sort((a, b) => (rank[a.level] - rank[b.level]) || (b.ageMin - a.ageMin));
const errs = items.filter((x) => x.level === 'err');
const warns = items.filter((x) => x.level === 'warn');
const counts = items.reduce((a, x) => { a[x.ticket.state] = (a[x.ticket.state] || 0) + 1; return a; }, {});
const failed = errs.length > 0 || (STRICT && warns.length > 0);

// 6.1 --json：机器可读（计划任务、界面看板都吃它）；字段保持扁平，别让人再猜
if (JSON_OUT) {
  const payload = {
    checkedAt: STAMP,
    thresholds: { warnMin, errMin },
    counts,
    failed,
    tickets: sorted
      .filter((x) => SHOW_ALL || x.level !== 'ok')
      .map((x) => ({
        id: x.ticket.id, state: x.ticket.state, level: x.level, verdict: x.verdict,
        ageMin: x.ageMin, detail: x.detail, fixed: !!x.fixed,
        from: x.ticket.fromTitle || x.ticket.from, to: x.ticket.toTitle || x.ticket.to,
        parent: x.ticket.parent || '', rootFrom: x.ticket.rootFromTitle || x.ticket.rootFrom || '',
        file: x.file
      }))
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(failed ? 1 : 0);
}

// 6.2 人读报告：先给结论，再逐条给「判成什么 + 下一步怎么办」
const head = '派发单巡检 ' + STAMP + '（阈值 warn ' + warnMin + ' / err ' + errMin + ' 分钟）';
const tally = '共 ' + items.length + ' 张：'
  + ['pending', 'done', 'timeout', 'closed'].map((k) => k + ' ' + (counts[k] || 0)).join(' · ');
console.log(head);
console.log(tally);

const shown = SHOW_ALL ? sorted : sorted.filter((x) => x.level !== 'ok');
if (shown.length) {
  console.log('');
  for (const it of shown) {
    const tag = it.level === 'err' ? '✗ [ERR] ' : (it.level === 'warn' ? '! [WARN] ' : '· [OK]   ');
    const age = it.ageMin >= 0 ? it.ageMin + ' 分钟前' : '时间未知';
    console.log(tag + it.ticket.id + '  ' + age);
    console.log('   ' + (it.ticket.fromTitle || it.ticket.from) + ' → 「' + (it.ticket.toTitle || it.ticket.to) + '」  ' + it.verdict);
    console.log('   ' + it.detail);
    if (it.level !== 'ok' && it.verdict === '已干完·未回执' && !it.fixed) {
      console.log('   下一步：node 工具\\回执.mjs --ticket ' + it.ticket.id + ' --summary "<结论>"  或重跑加 --补');
    }
  }
}

console.log('');
if (!failed) {
  console.log('✓ 巡检通过：' + (errs.length ? '' : '没有需要立刻处理的单子') + '（' + (counts.done || 0) + ' 张已闭环）');
} else {
  console.log('✗ 需要处理：ERR ' + errs.length + ' 张' + (STRICT ? ' · WARN ' + warns.length + ' 张' : '') + '（退出码 1，便于计划任务报警）');
}
if (!AUTO_FIX) console.log('⛔ 本次只读巡检：没有投递、没有改单；要补回执请加 --补');

process.exit(failed ? 1 : 0);
