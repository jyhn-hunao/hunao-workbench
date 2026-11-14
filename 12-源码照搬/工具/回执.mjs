#!/usr/bin/env node
// 回执.mjs —— 目标会话干完活后，把结论作为一条消息投回派发方会话
//
// 为什么要有它：派发是跨会话的，对方看不见这边的回答；回执 = 反向再投一条 session/prompt，
//   同时把派发单标成 done，下次谁查单都知道「这活回了没有」。
//
// 用法：
//   node 工具\回执.mjs --ticket <派发单id> --summary "3~6 行结论"
//   node 工具\回执.mjs --summary "..." --file 结论.md        # 结论长就放文件
//   node 工具\回执.mjs --ticket <id> --to <派发方会话id> --summary "..."   # 单子找不到时直投
//
// 不写 --ticket 时：按 --to 或「当前会话」找最近一张 pending 单（派发方反查）。

import fs from 'node:fs';
import {
  DISPATCH_DIR, findTicketFile, readTicket, saveTicket, appendLog,
  getCookie, promptSession, tail, nowStamp
} from './派发-公共.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const ticketArg = val('--ticket', '');
const explicitTo = val('--to', '');
const toArg = explicitTo || process.env.DSH_SESSION_ID || '';
const fileArg = val('--file', '');
const dry = argv.includes('--dry');
let summary = val('--summary', '');

// 1. 结论来源：--summary 优先，其次 --file；纯文本，不拼 HTML
if (!summary && fileArg && fs.existsSync(fileArg)) summary = fs.readFileSync(fileArg, 'utf8').trim();
if (!summary) { console.error('用法：node 工具\\回执.mjs --ticket <id> --summary "<结论>" [--file 结论.md]'); process.exit(2); }
if (!toArg && !ticketArg) { console.error('✗ 不知道回给谁：给 --ticket，或设 DSH_SESSION_ID / 显式 --to'); process.exit(2); }

// 2. 找单：给了 ticket 就认它；否则按「目标会话 = 回执方」找最近 pending
let file = ticketArg ? findTicketFile(ticketArg) : null;
let ticket = file ? readTicket(file) : null;
if (!ticket) {
  const dir = DISPATCH_DIR;
  const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const pend = list.map((f) => ({ f, t: readTicket(dir + '\\' + f) }))
    .filter((x) => x.t && x.t.state === 'pending' && (x.t.to === toArg || !toArg))
    .sort((a, b) => b.t.createdAt - a.t.createdAt);
  if (pend.length) { file = dir + '\\' + pend[0].f; ticket = pend[0].t; }
}
// 没有单子又没显式给派发方 ⇒ 宁可报错，也别把回执投回自己（会自激一圈）
if (!ticket && !explicitTo) {
  console.error('✗ 找不到对应派发单，且没给 --to <派发方会话id>。先确认派发单 id，或显式指定回给谁。');
  process.exit(2);
}

// 3. 构造回执正文：出处 + 结论；末尾写明「不必再回」，避免两边互相回执成环
const from = ticket ? ticket.from : toArg;
const title = ticket ? (ticket.toTitle || ticket.to) : '(未登记派发单)';
const stamp = nowStamp();
const body = '【回执】「' + title + '」' + (ticket ? '完成派发单 ' + ticket.id : '完成派发任务') + '（' + stamp + '）\n\n'
  + summary
  + '\n\n—— 本条由「' + title + '」的 工具\\回执.mjs 投递；不必再回执这一条 ——';

try {
  if (dry) {
    console.log('--dry：不投递。将回给 ' + from + ' 的正文：\n' + body);
    if (ticket && ticket.rootFrom && ticket.rootFrom !== ticket.from) {
      console.log('还会自动上浮到：' + (ticket.rootFromTitle || ticket.rootFrom) + '（外层单 ' + (ticket.parent || '—') + '）');
    }
    process.exit(0);
  }
  // 4. 投递：mode queue，不抢派发方正在跑的回合
  var cookie = await getCookie();
  await promptSession(from, body, cookie);
} catch (e) {
  console.error('✗ 回执没投出去：' + e.message);
  process.exit(1);
}

// 5. 结单 + 留一行日志（结不了单也要提示，不能装作成功）
if (ticket && file) {
  ticket.state = 'done'; ticket.replyAt = Date.now(); ticket.reply = tail(summary, 4000);
  saveTicket(file, ticket);
  appendLog('[' + stamp + '] 回执 ' + ticket.id + ' → ' + (ticket.fromTitle || ticket.from) + '（目标会话主动）');
}

// 6. 分层上浮（2026-11-14 加）：本单挂在外层单上 ⇒ 结论同时冒到根派发方，并把外层单结掉。
//    为什么写在回执里、不写成规则：worker 不会记得再手写一张外层回执，忘了就是「活干完、总入口永远不知道」。
const rootFrom = String((ticket && ticket.rootFrom) || '');
let upFailed = false;
if (ticket && rootFrom && rootFrom !== ticket.from) {
  const upBody = '【上浮回执】派发单 ' + ticket.id + '（' + (ticket.toTitle || ticket.to) + '）已交付给「' + (ticket.fromTitle || ticket.from) + '」\n\n'
    + summary
    + '\n\n—— 自动上浮（工具\\回执.mjs）；本条不必再回执 ——';
  try {
    await promptSession(rootFrom, upBody, cookie);
    appendLog('[' + stamp + '] 上浮 ' + ticket.id + ' → ' + (ticket.rootFromTitle || rootFrom));
  } catch (e) {
    upFailed = true;
    console.error('✗ 上浮失败（子单已回执给上层，根派发方没收到）：' + e.message);
  }
}

// 6b. 外层单收口：子单已交付，外层单就必须结掉——哪怕根派发方就是本会话、不必再投一条。
function closeOuter(t) {
  if (!t || !t.parent || t.state !== 'done') return;
  const pf = findTicketFile(t.parent);
  const pt = pf ? readTicket(pf) : null;
  if (!pt || pt.state !== 'pending') return;
  pt.state = 'done'; pt.replyAt = Date.now();
  pt.reply = tail('（子单 ' + t.id + ' 已交付）' + summary, 4000);
  saveTicket(pf, pt);
  appendLog('[' + stamp + '] 外层单 ' + pt.id + ' 已结（靠子单 ' + t.id + ' 上浮）');
}
closeOuter(ticket);
console.log('✓ 已回执到 ' + (ticket ? (ticket.fromTitle || ticket.from) : from)
  + (ticket && rootFrom && rootFrom !== ticket.from ? (upFailed ? '（上浮失败，见上）' : '（已自动上浮到根派发方）') : ''));
if (upFailed) process.exit(1);
