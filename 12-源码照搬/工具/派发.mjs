#!/usr/bin/env node
// 派发.mjs —— 把一条任务派给另一个场景的会话，并登记派发单（回执靠这张单对账）
//
// 为什么要有它：以前只能「手搓一条 session/prompt」，派发是单向的——目标会话干完，
//   派发方这边什么也不会收到（2026-11-12 用户实报：任务完成了，回执没回来）。
//   现在一条命令做四件事：认会话 → 写派发单 → 投消息（自动附回执命令）→ 起后台等回执。
//
// 用法：
//   node 工具\派发.mjs --to "luanyujia-workbench" "排查技能面板为什么是空的"
//   node 工具\派发.mjs --to session-cd20... "任务" --no-watch --timeout 1800
//   node 工具\派发.mjs --to "mlw" "任务" --dry        # 只核对会话与派发单，不投递
//
// 约定：--from 不写就是当前会话（DSH_SESSION_ID）；目标会话按标题逐字相等或 session id 认。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, loadSessions, resolveSession, transcriptOf, readEvents, turnStats,
  newTicket, getCookie, promptSession
} from './派发-公共.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };

const toWant = val('--to', '');
const fromId = val('--from', process.env.DSH_SESSION_ID || '');
const task = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--to' && argv[i - 1] !== '--from'
  && argv[i - 1] !== '--timeout').join(' ').trim();

if (!toWant || !task) {
  console.error('用法：node 工具\\派发.mjs --to "<会话标题或 id>" "<任务>" [--from <派发方会话id>] [--no-watch] [--timeout 秒] [--dry]');
  process.exit(2);
}
if (!fromId) { console.error('✗ 拿不到派发方会话：设 DSH_SESSION_ID 或显式 --from'); process.exit(2); }

// 1. 认会话：标题逐字相等 / 直接给 id
const sessions = loadSessions();
const from = sessions.get(fromId) || { id: fromId, title: '(未知会话)' };
const to = resolveSession(sessions, toWant);
if (!to) {
  console.error('✗ 找不到会话「' + toWant + '」。现有会话：');
  for (const s of [...sessions.values()].sort((a, b) => b.at - a.at).slice(0, 15)) {
    console.error('   - ' + (s.title || '(无标题)') + '  ' + s.id + '  ' + s.cwd);
  }
  process.exit(1);
}
if (to.id === fromId) { console.error('✗ 目标会话就是自己（' + to.id + '），不派发'); process.exit(2); }

// 2. 派发前记下目标会话已完成几轮：后台等回执只认「比这个多出来的那一轮」
const before = turnStats(readEvents(transcriptOf(to.id)));
const turnsBefore = before ? before.count : 0;
console.log('派发方：' + (from.title || from.id) + '  ' + from.id);
console.log('目标  ：' + (to.title || '(无标题)') + '  ' + to.id);
console.log('目标已完成轮数：' + turnsBefore + (before ? '' : '（读不到 transcript，回执可能退化为按时间判断）'));

// 3. 登记派发单（先落盘再投递：投递失败也留得下现场）
const { ticket, file } = newTicket({
  from: fromId, fromTitle: from.title || '', to: to.id, toTitle: to.title || '',
  text: task, turnsBefore
});

// 4. 正文 = 用户任务 + 回执协议（写死绝对路径，目标会话照抄就能跑）
const msg = task + '\n\n'
  + '—— 回执协议（由 工具\\派发.mjs 自动附加，别删）——\n'
  + '这条任务由会话「' + (from.title || fromId) + '」派发，派发单：' + ticket.id + '。\n'
  + '干完（含「只诊断不改」的活）后，在任意 shell 执行：\n'
  + '  node "' + path.join(ROOT, '工具', '回执.mjs') + '" --ticket ' + ticket.id + ' --summary "<3~6 行结论：做了什么 / 结论 / 要用户拍板的项>"\n'
  + '回执会以一条消息投回派发方会话；不回执 = 任务没交付。';

if (has('--dry')) {
  console.log('\n--dry：派发单已写 ' + file + '，没有投递。');
  console.log('--- 将发送的正文（前 600 字）---\n' + msg.slice(0, 600));
  process.exit(0);
}

// 5. 投递（失败就报错退出，别让派发单永远 pending 却没人知道）
const cookie = await getCookie();
await promptSession(to.id, msg, cookie);
console.log('✓ 已投递到「' + (to.title || to.id) + '」 派发单 ' + ticket.id);

// 6. 起后台等回执：目标完成那一轮 → 自动把结论投回本会话（--no-watch 关掉）
if (!has('--no-watch')) {
  const w = path.join(HERE, '等回执.mjs');
  if (!fs.existsSync(w)) { console.error('! 等回执.mjs 不在 ' + w + '，本次只能靠目标会话主动回执'); process.exit(0); }
  const timeout = val('--timeout', '3600');
  const child = spawn(process.execPath, [w, '--ticket', file, '--timeout', timeout], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  console.log('✓ 已在后台等回执（最多 ' + timeout + ' 秒）；回执会以一条消息出现在本会话');
  console.log('  查单：' + file);
}
