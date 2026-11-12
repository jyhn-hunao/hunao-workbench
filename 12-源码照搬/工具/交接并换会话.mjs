#!/usr/bin/env node
// 交接并换会话.mjs —— 「换会话」按钮的"先写交接再换"路径（2026-11-12 用户拍板）
// 干什么（一条命令三步）：
//   1. 给该面板**旧会话**投一条交接提示（口径 = `场景记忆.mjs 交接` 的 §〇 四小节，不另造模板）；
//   2. 等那一轮跑完（按 transcript 轮数判，不按时间猜）；--timeout 是**无进展等待**上限（默认 600 秒），
//      只要旧会话还在写（出现新 turn/step/事件）就把期限往后推，不会被固定秒数硬切；
//   3. 完成后跑 `换会话.mjs <panel> --go`（**不带 --force**，让 2 小时交接闸自然生效），
//      再复核 §〇 到底落了没有；没落就打印 `WARN:`（壳把它显示成「换会话完成，但交接未写入」）。
// 失败语义：超时/投递失败 ⇒ 退出 4，**不动绑定**；轮换失败原样透出退出码。
//
// 用法：node 工具\交接并换会话.mjs --panel cd-ai [--timeout 600] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DSH_HOME, SHELL, loadSessions, getCookie, promptSession, transcriptOf, readEvents, turnStats } from './派发-公共.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const PANEL = val('--panel', '');
const TIMEOUT = Math.max(30, Number(val('--timeout', '600')) || 600);
const DRY = argv.includes('--dry');
const POLL_MS = 3000;
const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!PANEL) { console.error('用法：node 工具\\交接并换会话.mjs --panel <面板id> [--timeout 600] [--dry]'); process.exit(2); }

// 1. 面板 → 旧会话 id（以场景 json 为准）；顺手取场景名，用来定位本场景的交接文件
const scenDir = path.join(SHELL, 'scenarios');
let oldId = '', sceneId = '', sceneName = '';
for (const f of fs.readdirSync(scenDir).filter((x) => x.endsWith('.json') && x[0] !== '_')) {
  let sc; try { sc = JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8')); } catch (e) { continue; }
  const p = (sc.panels || []).find((x) => x.id === PANEL);
  if (p) { oldId = String(p.sessionId || ''); sceneId = String(sc.id || f.replace(/\.json$/, '')); sceneName = String(sc.name || ''); break; }
}
if (!oldId) { console.error('✗ 找不到面板或它没绑 sessionId：' + PANEL); process.exit(2); }

const sessions = loadSessions();
const old = sessions.get(oldId);
const oldTitle = (old && old.title) || '';
const HANDOFF = sceneName ? path.join(DSH_HOME, '场景记忆', sceneName, '场景私有记忆.md') : '';
say('面板 ' + PANEL + '（场景 ' + sceneId + '）· 旧会话 ' + oldId + '「' + oldTitle + '」');
if (HANDOFF) say('交接文件：' + HANDOFF);

// 2. §〇 快照：换完用它复核「交接到底落没落」（只认 §〇 段，不拿整文件 mtime 当唯一证据）
function sec0Of(file) {
  if (!file || !fs.existsSync(file)) return null;
  const txt = fs.readFileSync(file, 'utf8');
  const h = txt.search(/^## (?:§〇|〇、|§0)/m);
  if (h < 0) return { sec: '' };
  const rest = txt.slice(h);
  const next = rest.indexOf('\n## ', 5);
  return { sec: next >= 0 ? rest.slice(0, next) : rest };
}
function mtimeOf(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }
function hasFourSections(sec) {
  return /上次交接/.test(sec) && /当前项目/.test(sec) && /私有记忆变更/.test(sec) && /(下一步|卡点)/.test(sec);
}

const TIP = '【换会话前交接】请现在把本轮结论写进本场景的 `场景记忆\\<场景>\\场景私有记忆.md` 的 §〇，口径按 `工具\\场景记忆.mjs 交接` 的四小节：'
  + '① 上次交接 ② 当前项目 ③ 私有记忆变更 ④ 下一步/卡点。只改这四小节，别新建文件、别动历史段落。'
  + '写完只回一句「交接已更新」即可，不要做别的事。';

if (DRY) { say('\n--dry：将投递如下提示，然后按进度续期等待（默认 ' + TIMEOUT + ' 秒无进展才放弃），最后轮换并复核 §〇。\n' + TIP); process.exit(0); }

// 3. 投递 + 等这一轮结束（按轮数判；有进展就续期，不按固定秒数硬切）
const transcript0 = transcriptOf(oldId);
const ev0 = readEvents(transcript0);
const st0 = turnStats(ev0) || { count: 0, lastTurn: 0 };
const turnsBefore = st0.count;
const countOf = (ev, type) => (ev ? ev.filter((e) => e.type === type).length : 0);
const startsBefore = countOf(ev0, 'turn/start');
// 旧会话可能还有一轮在跑：我们的提示是 queue，会排在它后面 ⇒ 完成线要算上在跑的那轮。
// 只有“恰好一轮未结束”才当在跑；多出来的 start（历史残缺）不抬完成线，否则永远等不到。
const inFlight = (startsBefore - turnsBefore) === 1;
const targetTurns = turnsBefore + 1 + (inFlight ? 1 : 0);
// 认“我们这条提示”而不是只数轮数：旧会话里可能已有历史交接提示（15:39 就有一条），
//   只认基线之后新写入、正文带【换会话前交接】的那条 user/message，再看它后面有没有 turn/end。
const BASELINE = ev0 ? ev0.length : 0;
const msgText = (e) => ((e && e.data && e.data.content) || []).filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n');
const handoverStart = (ev) => {
  if (!ev) return -1;
  for (let i = ev.length - 1; i >= BASELINE; i--) {
    if (ev[i] && ev[i].type === 'user/message' && msgText(ev[i]).includes('【换会话前交接】')) return i;
  }
  return -1;
};
const endedAfter = (ev, idx) => ev.some((e, i) => i > idx && e.type === 'turn/end');
const hand0 = HANDOFF ? sec0Of(HANDOFF) : null;
const mtime0 = mtimeOf(HANDOFF);

say('投递交接提示（该会话当前已完成 ' + turnsBefore + ' 轮' + (inFlight ? '，还有一轮在跑' : '') + '）…');
try {
  const cookie = await getCookie();
  await promptSession(oldId, TIP, cookie);
} catch (e) {
  console.error('✗ 投递失败，未换会话：' + ((e && e.message) || e));
  process.exit(4);
}

const t0 = Date.now();
let deadline = t0 + TIMEOUT * 1000;
let done = false, startedHandover = false, lastProgressAt = t0;
let lastLen = ev0 ? ev0.length : 0;
let lastMtime = mtimeOf(transcript0);
let turnsNow = turnsBefore, startIdx = -1;
while (Date.now() < deadline) {
  await sleep(POLL_MS);
  const tp = transcriptOf(oldId);
  const ev = readEvents(tp);
  const st = turnStats(ev) || { count: 0 };
  turnsNow = st.count;
  startIdx = handoverStart(ev);
  if (startIdx >= 0) {
    startedHandover = true;
    // 认准那条提示：只有它后面出现 turn/end 才算这一轮跑完（不会把上一轮 in-flight 的结束当成我们的）
    if (endedAfter(ev, startIdx)) { done = true; break; }
  } else if (st.count >= targetTurns) { done = true; break; }   // 引擎没落提示原文时的兜底
  // 4. 还在写（新事件或文件时间前进）⇒ 把期限推到「最后一次进展 + TIMEOUT」
  const len = ev ? ev.length : lastLen;
  const mt = mtimeOf(tp);
  if (ev && (len > lastLen || mt > lastMtime)) {
    lastLen = Math.max(lastLen, len);
    lastMtime = Math.max(lastMtime, mt);
    lastProgressAt = Date.now();
    deadline = Math.max(deadline, lastProgressAt + TIMEOUT * 1000);
  }
}
if (!done) {
  const waited = Math.round((Date.now() - t0) / 1000);
  const idle = Math.round((Date.now() - lastProgressAt) / 1000);
  console.error('✗ 等交接超时（等了 ' + waited + ' 秒）⇒ 交接可能还在进行，已放弃换会话，绑定没动。');
  console.error('· 旧会话「' + oldTitle + '」：开等时已完成 ' + turnsBefore + ' 轮；现在已完成 ' + turnsNow + ' 轮'
    + (startedHandover
      ? '，交接提示已送达、新一轮已开始但未结束（最近 ' + idle + ' 秒没有新进展）'
      : '，投递后还没看到交接提示被开始处理（可能引擎忙或消息没被消费）'));
  console.error('· 可稍后重试本按钮（会重新投递交接提示），或选「直接换」（跳过交接，绑定立即换）。');
  process.exit(4);
}
say('✓ 交接那一轮已结束（' + Math.round((Date.now() - t0) / 1000) + ' 秒，共 ' + turnsNow + ' 轮）');

// 5. 不带 --force 正换：2 小时交接闸自然生效
const r = spawnSync(process.execPath, [path.join(SHELL, 'scripts', '换会话.mjs'), PANEL, '--go'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20 });
if (r.stdout) say(String(r.stdout));
if (r.stderr) console.error(String(r.stderr));
const code = r.status == null ? 1 : r.status;
if (code !== 0) process.exit(code);

// 6. 换完复核：§〇 真变了、四小节齐 —— 没落只警告，不改退出码（绑定已经换了，别误报成失败）
let warn = '';
if (!HANDOFF) warn = '找不到本场景的交接文件，无法复核交接是否写入';
else if (!fs.existsSync(HANDOFF)) warn = '交接文件不存在（' + HANDOFF + '）';
else {
  const hand1 = sec0Of(HANDOFF);
  const mt1 = mtimeOf(HANDOFF);
  const changed = !!(hand0 && hand1 && hand0.sec !== hand1.sec);
  if (!changed && mt1 <= mtime0) warn = '交接未写入（§〇 与文件修改时间都没变化）';
  else if (!changed) warn = '交接文件有改动，但 §〇 没变（可能写到了别处）';
  else if (!hasFourSections(hand1.sec)) warn = '§〇 有改动，但四小节不全（上次交接 / 当前项目 / 私有记忆变更 / 下一步）';
  else say('✓ 复核：§〇 已更新（改于 ' + new Date(mt1).toLocaleTimeString('zh-CN') + '，四小节齐）');
}
if (warn) console.log('WARN: ' + warn + '（绑定已指向新会话）');
process.exit(0);
