#!/usr/bin/env node
// 等回执.mjs —— 盯着一张派发单，目标会话那一轮干完就把结论投回派发方
//
// 为什么要有它：目标会话可能忘了回执、也可能压根没收到「回执协议」那句；
//   只看 transcript 就能判断「我们派的那条消息所在回合结束了没有」，不依赖对方自觉。
//
// 用法（一般由 派发.mjs 自动拉起，不用手敲）：
//   node 工具\等回执.mjs --ticket <派发单.json 或 id> [--timeout 3600] [--interval 5] [--once]
//
// 判据：在目标 transcript 里找「user/message 正文含派发单 id」那条，再找它之后第一个 turn/end。

import fs from 'node:fs';
import path from 'node:path';
import {
  readTicket, findTicketFile, saveTicket, appendLog, transcriptOf, readEvents,
  finalTextOf, getCookie, promptSession, tail, nowStamp
} from './派发-公共.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const ticketArg = val('--ticket', '');
const timeoutSec = Number(val('--timeout', '3600')) || 3600;
const intervalMs = Math.max(1000, (Number(val('--interval', '5')) || 5) * 1000);
const once = argv.includes('--once');

const file = findTicketFile(ticketArg);
if (!file) { console.error('✗ 找不到派发单：' + ticketArg); process.exit(2); }

// 1. 在事件流里定位「我们派的那条消息」所在的回合
function locateTurn(events, ticket) {
  if (!events) return null;
  const idx = events.findIndex((e) => e.type === 'user/message'
    && JSON.stringify(e.data || {}).includes(ticket.id));
  if (idx < 0) return null;
  const end = events.slice(idx).find((e) => e.type === 'turn/end');
  return end ? Number(end.data.turn) : null;
}

// 2. 投回执：正文只带结论 + 出处；失败抛错，让日志留下痕迹
async function deliver(ticket, text, cookie) {
  const body = '【回执】「' + (ticket.toTitle || ticket.to) + '」完成派发单 ' + ticket.id + '\n\n'
    + text + '\n\n—— 本条由 工具\\等回执.mjs 自动投递；派发单 ' + file + ' ——';
  await promptSession(ticket.from, body, cookie);
}

const started = Date.now();
let lastState = '';
console.log('等回执：' + path.basename(file));

// 3. 轮询：单子被 回执.mjs 手动结掉 → 退；否则等我们那轮结束
while (true) {
  const ticket = readTicket(file);
  if (!ticket) { console.error('✗ 派发单读不出来：' + file); process.exit(1); }
  if (ticket.state !== 'pending' && ticket.state !== lastState) {
    console.log('单子已是 ' + ticket.state + '，退出');
    process.exit(0);
  }
  lastState = ticket.state;

  const tp = transcriptOf(ticket.to);
  const events = readEvents(tp);
  const turn = locateTurn(events, ticket);

  if (turn != null) {
    const text = finalTextOf(events, turn);
    if (text) {
      // 4. 只有真的拿到结论才回执；拿到空正文就再等一拍（可能还在写最后一段）
      try {
        await deliver(ticket, text, await getCookie());
        ticket.state = 'done'; ticket.replyAt = Date.now(); ticket.reply = tail(text, 4000);
        saveTicket(file, ticket);
        appendLog('[' + nowStamp() + '] 回执 ' + ticket.id
          + ' → ' + ticket.fromTitle + '（自动·等回执）');
        console.log('✓ 已回执到 ' + (ticket.fromTitle || ticket.from));
        process.exit(0);
      } catch (e) {
        console.error('✗ 回执投递失败：' + e.message + '（5 秒后重试）');
      }
    } else {
      console.log('回合 ' + turn + ' 已结束但正文为空，等下一拍');
    }
  }

  if (Date.now() - started > timeoutSec * 1000) {
    // 5. 超时也要回一条：派发方必须知道「没回」，不能静默
    const note = '⚠ 派发单 ' + ticket.id + ' 超过 ' + timeoutSec + ' 秒没有回执。目标会话：'
      + (ticket.toTitle || ticket.to) + '。可能原因：任务还在跑、被中断、或对方没收到派发消息。请到界面上看一眼。';
    try {
      await deliver(ticket, note, await getCookie());
      ticket.state = 'timeout'; ticket.replyAt = Date.now(); ticket.reply = note;
      saveTicket(file, ticket);
      appendLog('[' + nowStamp() + '] 超时回执 ' + ticket.id);
      console.log('✓ 已回执（超时）');
    } catch (e) { console.error('✗ 超时回执也失败：' + e.message); }
    process.exit(0);
  }

  if (once) { console.log('--once：本轮没检测到完成，退出'); process.exit(0); }
  await new Promise((r) => setTimeout(r, intervalMs));
}
