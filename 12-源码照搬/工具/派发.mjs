#!/usr/bin/env node
// 派发.mjs —— 把一条任务派给另一个场景的会话，并登记派发单（回执靠这张单对账）
//
// 为什么要有它：以前只能「手搓一条 session/prompt」，派发是单向的——目标会话干完，
//   派发方这边什么也不会收到（2026-11-12 用户实报：任务完成了，回执没回来）。
//   现在一条命令做四件事：认会话 → 写派发单 → 投消息（自动附回执命令）→ 起后台等回执。
//
// 用法：
//   node 工具\派发.mjs --to "luanyujia-workbench" "排查技能面板为什么是空的"
//   node 工具\派发.mjs --project "工作台本体" "排查技能面板为什么是空的"   # 项目名/别称（查 项目.json）
//   node 工具\派发.mjs --to session-cd20... "任务" --no-watch --timeout 1800
//   node 工具\派发.mjs --to "mlw" "任务" --dry        # 只核对会话与派发单，不投递
//   node 工具\派发.mjs --to "mlw" "任务" --mandate "只改 工具\X.mjs，不动引擎、不提交"   # 本次授权范围
//   node 工具\派发.mjs --to "创意工坊·原画概念" --parent <外层单号> "工单内容"           # 分层派发：回执自动上浮到根派发方
//
// 约定：--from 不写就是当前会话（DSH_SESSION_ID）；--to 按会话标题逐字相等或 session id 认；
//   --project 按 `_共享记忆\项目.json` 的 name / aliases 认项目，再按 cwd 找该项目当前会话
//   （认不出就列候选并退出，不静默猜）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, DSH_HOME, loadSessions, resolveSession, transcriptOf, readEvents, turnStats,
  newTicket, findTicketFile, readTicket, getCookie, promptSession
} from './派发-公共.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };

const toWant = val('--to', '');
const projectWant = val('--project', '');
const fromId = val('--from', process.env.DSH_SESSION_ID || '');
const taskFile = val('--file', '');
// 任务正文：--file 读文件（长任务别在命令行里拼引号），否则取位置参数
const task = taskFile
  ? (fs.existsSync(taskFile) ? fs.readFileSync(taskFile, 'utf8').trim() : '')
  : argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--to' && argv[i - 1] !== '--from'
    && argv[i - 1] !== '--timeout' && argv[i - 1] !== '--file' && argv[i - 1] !== '--project'
    && argv[i - 1] !== '--mandate' && argv[i - 1] !== '--parent').join(' ').trim();

// 授权（Mandate）：一次一单写清「这次允许做到哪」；不写就用默认，别让「上次也这么干」变成长期授权
const DEFAULT_MANDATE = '只做本条任务：可在项目目录内改动、可跑只读检查；⛔ 不动 12-源码照搬\\引擎、不改别人的场景记忆、不提交不推送；越界即停并回问。';
const mandate = String(val('--mandate', '') || DEFAULT_MANDATE).trim();

if ((!toWant && !projectWant) || !task) {
  console.error('用法：node 工具\\派发.mjs （--to "<会话标题或 id>" | --project "<项目名/别称>"） "<任务>" [--file 任务.md] [--from <派发方会话id>] [--mandate "本次授权范围"] [--no-watch] [--timeout 秒] [--dry]');
  process.exit(2);
}
if (!fromId) { console.error('✗ 拿不到派发方会话：设 DSH_SESSION_ID 或显式 --from'); process.exit(2); }

// 1. 认会话：标题逐字相等 / 直接给 id / --project 先查项目台账
const sessions = loadSessions();
const from = sessions.get(fromId) || { id: fromId, title: '(未知会话)' };
let to = null;
if (projectWant) {
  // 1a. 工作区会话只拿得到「项目名/别称」⇒ 先查登记表，再按 cwd 找该项目当前会话
  const r = resolveProjectSession(sessions, projectWant, fromId);
  if (!r.ok) {
    console.error('✗ ' + r.err);
    if (r.candidates && r.candidates.length) {
      console.error('候选（请挑一个再派，别猜）：');
      for (const c of r.candidates) console.error('   - ' + c);
    }
    process.exit(1);
  }
  to = r.session;
  console.log('项目  ：' + r.project + ' → 会话「' + (to.title || to.id) + '」');
} else {
  to = resolveSession(sessions, toWant);
}
if (!to) {
  console.error('✗ 找不到会话「' + (toWant || projectWant) + '」。现有会话：');
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

// 2b. 分层派发（--parent <外层单号>）：流程 superAgent 把活派给 worker 时带上它，
//     worker 的回执会自动上浮到根派发方（总入口），L2 不用再手写一张外层回执。
const parentArg = String(val('--parent', '') || '').trim();
let parentTicket = null, parentFile = null;
if (parentArg) {
  parentFile = findTicketFile(parentArg);
  parentTicket = parentFile ? readTicket(parentFile) : null;
  if (!parentTicket) { console.error('✗ 找不到外层派发单：' + parentArg); process.exit(2); }
  if (parentTicket.state !== 'pending') { console.error('✗ 外层单 ' + parentTicket.id + ' 已是 ' + parentTicket.state + '，不再往上挂子单'); process.exit(2); }
}
const rootFrom = parentTicket ? String(parentTicket.rootFrom || parentTicket.from || '') : '';
const rootFromTitle = parentTicket ? String(parentTicket.rootFromTitle || parentTicket.fromTitle || '') : '';
if (parentTicket) console.log('外层单：' + parentTicket.id + '（根派发方 ' + (rootFromTitle || rootFrom) + '）');

// 3. 登记派发单（先落盘再投递：投递失败也留得下现场）
const { ticket, file } = newTicket({
  from: fromId, fromTitle: from.title || '', to: to.id, toTitle: to.title || '',
  text: task, turnsBefore, mandate, parent: parentTicket ? parentTicket.id : '', rootFrom, rootFromTitle
});

// 4. 正文 = 授权 + 用户任务 + 回执协议（写死绝对路径，目标会话照抄就能跑）
const msg = task + '\n\n'
  + '—— 授权（Mandate · 一次一单）——\n'
  + mandate + '\n'
  + '越界即停：发现要超出上面范围，先回问派发方，不拿「上次也这么干」当默认。\n\n'
  + (parentTicket ? '—— 分层归属 ——\n本单隶属外层派发单 ' + parentTicket.id + '（根派发方：' + (rootFromTitle || rootFrom) + '）；照常回执即可，结论会自动上浮到根派发方。\n\n' : '')
  + '—— 回执协议（由 工具\\派发.mjs 自动附加，别删）——\n'
  + '这条任务由会话「' + (from.title || fromId) + '」派发，派发单：' + ticket.id + '。\n'
  + '干完（含「只诊断不改」的活）后，在任意 shell 执行：\n'
  + '  node "' + path.join(ROOT, '工具', '回执.mjs') + '" --ticket ' + ticket.id + ' --summary "<3~6 行结论：做了什么 / 结论 / 要用户拍板的项>"\n'
  + '结果超过一屏就落成文件，回执里只写结论 + 路径（别把全文塞进消息）。\n'
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

/* 项目名/别称 → 该项目当前的会话（工作区会话只路由，不猜）
 * 1. 只认 `_共享记忆\项目.json` 的 name / aliases；查不到就返回候选，让调用方问用户
 * 2. 会话按 cwd 落在该项目 paths 之下认（排除派发方自己），多条取最近活跃
 * 3. 登记了项目但会话不在线 ⇒ 明说「先切到该项目」，不退回按名字硬找 */
function resolveProjectSession(sessions, want, fromId) {
  const reg = path.join(DSH_HOME, '场景记忆', '_共享记忆', '项目.json');
  let list = [];
  try { list = (JSON.parse(fs.readFileSync(reg, 'utf8')).projects || []); } catch (e) {
    return { ok: false, err: '读不到项目登记表：' + reg + '（' + ((e && e.message) || e) + '）', candidates: [] };
  }
  const q = String(want || '').trim().toLowerCase();
  const hit = list.filter((p) => {
    const names = [p.name, ...(p.aliases || [])].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
    return names.some((n) => n === q || n.includes(q) || q.includes(n));
  });
  if (!hit.length) {
    return {
      ok: false, err: '项目登记表里没有「' + want + '」',
      candidates: list.map((p) => p.name + ((p.aliases || []).length ? '（' + p.aliases.join('/') + '）' : '') + ' → ' + (p.paths || []).join(' , '))
    };
  }
  if (hit.length > 1) {
    return { ok: false, err: '「' + want + '」命中了多个项目', candidates: hit.map((p) => p.name + ' → ' + (p.paths || []).join(' , ')) };
  }
  const proj = hit[0];
  const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  const roots = (proj.paths || []).map(norm).filter(Boolean);
  const names = [proj.name, ...(proj.aliases || [])].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  // 2. 先只认「有标题」的会话：空标题的新会话认不出是谁，派过去也没人看
  const pool = [...sessions.values()].filter((s) => String(s.title || '').trim());
  const inProj = pool.filter((s) => {
    const c = norm(s.cwd);
    return roots.some((r) => c === r || c.startsWith(r + '\\') || c.startsWith(r + '/'));
  });
  // 2a. 该项目唯一的会话就是派发方自己 ⇒ 明说，别让人以为项目没会话
  if (inProj.length === 1 && inProj[0].id === fromId) {
    return { ok: false, err: '项目「' + proj.name + '」当前的会话就是派发方自己（' + fromId + '）', candidates: ['换一种派法：--to <另一个场景的会话标题>'] };
  }
  const cands = inProj.filter((s) => s.id !== fromId)
    .map((s) => ({ s, exact: names.includes(String(s.title || '').trim().toLowerCase()) }))
    .sort((a, b) => (Number(b.exact) - Number(a.exact)) || ((b.s.at || 0) - (a.s.at || 0)))
    .map((x) => x.s);
  if (!cands.length) {
    return {
      ok: false,
      err: '项目「' + proj.name + '」已登记，但它的会话不在线（' + (proj.paths || []).join(' , ') + '）',
      candidates: ['先在工作台把「程序开发」面板切到该项目，或改用 --to <会话标题>']
    };
  }
  return { ok: true, project: proj.name, session: cands[0] };
}
