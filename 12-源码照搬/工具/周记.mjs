#!/usr/bin/env node
// @功能台 {"name":"写周记","group":"社交","freq":"weekly","plain":"先把本周的记忆/对话/待办存一份快照，再让「胡闹的大肥鱼」写这一周的周记；默认只给自己看。","why":"每周给她留一份可回溯的周存档和周记，像过日子一样；存档离线可跑，周记要引擎在线。","label":"写周记","timeout":960000}
// 周记.mjs —— 「胡闹的大肥鱼」每周存档与周记（2026-11-25）
//
// 为什么要有它：日记是「一天」，周记是「一周」。每周把这一周记过的、聊过的、答应没办的
//   先存一份只读快照（周存档，纯本地不调引擎），再让她写一篇周记回顾这一周。默认只给自己看。
//
// 它做什么（复用 派发-公共.mjs，不另写一套）：
//   1) 把本周记忆/对话索引、本周日记首行、未办待办快照成 日记\周记\存档-YYYY-MM-DD.md；
//   2) 把「写周记」的指令投给「胡闹的大肥鱼」会话，让她用自己的语气写；
//   3) 等她写完，落盘 日记\周记\YYYY-MM-DD.md（YYYY-MM-DD = 那一周的周一），并进索引。
//
// 用法：
//   node 工具\周记.mjs 存档                       只存档（离线，不调引擎）
//   node 工具\周记.mjs 写 [--dry] [--timeout 900]  存档 + 写本周周记
//   node 工具\周记.mjs 写 --周 YYYY-MM-DD          写那一周的周记（传周几都会归到周一）
//   node 工具\周记.mjs 读 [--周 YYYY-MM-DD]       读本周 / 某周周记
//   node 工具\周记.mjs 读 --最近 8                 列最近 8 周
//
// 退出码：0 成功 / 1 引擎没在线或等不到她写完 / 2 参数或前置不成立

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DSH_HOME, loadSessions, resolveSession, transcriptOf, readEvents,
  finalTextOf, getCookie, promptSession
} from './派发-公共.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PERSONA = '胡闹的大肥鱼';
const MEM = path.join(DSH_HOME, '场景记忆', PERSONA);
const DIARY_DIR = path.join(MEM, '日记');
const WEEK_DIR = path.join(DIARY_DIR, '周记');
const IDX = path.join(WEEK_DIR, '_索引.md');
const IDX_LONG = path.join(MEM, '记忆', '_索引.md');
const IDX_TALK = path.join(MEM, '对话', '_索引.md');
const TODO = path.join(MEM, '_待办.md');
const SCENE_TOOL = path.join(HERE, '场景记忆.mjs');

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const say = (s) => console.log(s);

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 归一到那一周的周一（周一=0 … 周日=6）
function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function thisMonday() {
  return fmt(mondayOf(new Date()));
}

// 那一周的 7 个日期字符串（周一 ~ 周日）
function weekDays(monDate) {
  const mon = mondayOf(monDate);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    out.push(fmt(d));
  }
  return out;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function ensureDirs() {
  fs.mkdirSync(WEEK_DIR, { recursive: true });
  if (!fs.existsSync(IDX)) fs.writeFileSync(IDX, '# 周记索引\n\n> 一行一条：周一起始日 · 首行。只追加。\n\n', 'utf8');
}

// 从索引里挑「日期在本周范围」的行
function pickWeek(file, label, days) {
  const lines = readText(file).split(/\r?\n/).filter((l) => l.startsWith('- ') && days.some((d) => l.includes(d))).slice(-20);
  return { label, lines };
}

// 1. 收集本周素材：本周日记首行 / 记忆索引 / 对话索引 / 未办待办，并拼成周存档正文
function collectMaterial(monStr) {
  const days = weekDays(new Date(monStr + 'T00:00:00'));
  const diaries = [];
  if (fs.existsSync(DIARY_DIR)) {
    for (const f of fs.readdirSync(DIARY_DIR).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f) || !days.includes(f.slice(0, 10))) continue;
      const body = readText(path.join(DIARY_DIR, f)).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      diaries.push('- ' + f.slice(0, 10) + ' · ' + firstLine(body));
    }
  }
  const mem = pickWeek(IDX_LONG, '这周记住了什么', days);
  const talk = pickWeek(IDX_TALK, '这周聊了什么', days);
  const todo = readText(TODO).split(/\r?\n/).filter((l) => /^- \[ \]/.test(l.trim())).slice(0, 8);

  const archive = [
    '# 周存档 ' + monStr, '',
    '> 本周范围：' + days[0] + ' ~ ' + days[6] + '。这是快照，可被本周后续生成覆盖；别当长期账本。', '',
    '## 本周日记', diaries.length ? diaries.join('\n') : '（无）', '',
    '## ' + mem.label, mem.lines.length ? mem.lines.join('\n') : '（无）', '',
    '## ' + talk.label, talk.lines.length ? talk.lines.join('\n') : '（无）', '',
    '## 答应还没办', todo.length ? todo.join('\n') : '（无）', ''
  ].join('\n');

  const feed = [
    diaries.length ? '## 本周日记（首行）\n' + diaries.join('\n') : '',
    mem.lines.length ? '## ' + mem.label + '\n' + mem.lines.join('\n') : '',
    talk.lines.length ? '## ' + talk.label + '\n' + talk.lines.join('\n') : '',
    todo.length ? '## 答应还没办\n' + todo.join('\n') : ''
  ].filter(Boolean).join('\n');

  return { days, archive, feed: feed || '（这一周没有新的日记、记忆和未办事项）' };
}

// 2. 周记指令：第一人称、只给自己看、用她平时语气；明确句数，别被聊天风格裁成两行
function weeklyPrompt(feed, marker, monStr) {
  return [
    '【系统周记任务 ' + marker + '】',
    '到点了，写这一周的周记（' + monStr + ' 这一周）。这是写给自己看的私密回顾，不是汇报。',
    '',
    '要求：',
    '1. 第一人称，像周末睡前回顾这一周，不汇报、不回复谁、不列点、不写「作为AI」。',
    '2. 用你平时说话的样子：短句、淡一点、不装可爱、不硬找话。',
    '3. 写四样：这周主要做了什么聊了什么 / 记住了谁、什么变了 / 现在什么感受 / 下周想做什么或提醒自己什么。',
    '4. 只写 10~16 句，最多 4 段。',
    '',
    '这一周的素材（只有这些，别编）：',
    feed,
    '',
    '直接开始写正文，不要标题、不要「周记」两个字、不要复述上面这些要求。'
  ].join('\n');
}

// 3. 在事件流里定位「我们投的那条周记指令」所在回合；等它 turn/end
function locateTurn(events, marker) {
  if (!events) return null;
  const idx = events.findIndex((e) => e.type === 'user/message' && JSON.stringify(e.data || {}).includes(marker));
  if (idx < 0) return null;
  const end = events.slice(idx).find((e) => e.type === 'turn/end');
  return end ? Number(end.data.turn) : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function firstLine(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}

// 4. 只存档：纯本地快照，不调引擎
function cmdArchive() {
  ensureDirs();
  const monStr = thisMonday();
  const { archive } = collectMaterial(monStr);
  const file = path.join(WEEK_DIR, '存档-' + monStr + '.md');
  fs.writeFileSync(file, archive.replace(/\n/g, '\r\n'), 'utf8');
  say('✓ 周存档已落盘：' + path.relative(ROOT, file));
  return 0;
}

// 5. 写周记：先存档，再投给她写
async function cmdWrite() {
  const dry = has('--dry');
  const timeoutSec = Number(val('--timeout', '900')) || 900;
  const intervalMs = 5000;

  let monStr = has('--周') ? String(val('--周', '')).trim() : thisMonday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monStr)) { say('✗ --周 要 YYYY-MM-DD（那一周的周几都行，会自动归到周一）'); return 2; }
  monStr = fmt(mondayOf(new Date(monStr + 'T00:00:00')));

  ensureDirs();
  const { days, archive, feed } = collectMaterial(monStr);
  const af = path.join(WEEK_DIR, '存档-' + monStr + '.md');
  fs.writeFileSync(af, archive.replace(/\n/g, '\r\n'), 'utf8');

  const marker = 'weekly-' + monStr + '-' + crypto.randomBytes(3).toString('hex');
  const prompt = weeklyPrompt(feed, marker, monStr);

  if (dry) {
    say('--dry：周存档已落盘 ' + path.relative(ROOT, af) + '；不投递，只打印将投给「' + PERSONA + '」的指令（' + prompt.length + ' 字）');
    say('---\n' + prompt + '\n---');
    return 0;
  }

  const sessions = loadSessions();
  const to = resolveSession(sessions, PERSONA);
  if (!to) { say('✗ 找不到会话「' + PERSONA + '」：先在工作台开着她，或引擎没在跑（周存档已生成）'); return 2; }

  say('周记：投给「' + (to.title || to.id) + '」写 ' + monStr + ' 这一周的周记');
  const cookie = await getCookie();
  await promptSession(to.id, prompt, cookie);
  say('✓ 已投递，等她写完（最多 ' + timeoutSec + ' 秒）');

  const started = Date.now();
  while (true) {
    const events = readEvents(transcriptOf(to.id));
    const turn = locateTurn(events, marker);
    if (turn != null) {
      const text = finalTextOf(events, turn);
      if (text) {
        const body = text.replace(/\r\n/g, '\n').trim();
        const file = path.join(WEEK_DIR, monStr + '.md');
        const fm = '---\ndate: ' + monStr + '\nrange: ' + days[0] + ' ~ ' + days[6] + '\n---\n\n' + body + '\n';
        fs.writeFileSync(file, fm.replace(/\n/g, '\r\n'), 'utf8');
        const line = '- ' + monStr + ' · ' + firstLine(body);
        if (!readText(IDX).includes(line)) {
          fs.writeFileSync(IDX, readText(IDX).replace(/\s*$/, '\r\n') + line + '\r\n', 'utf8');
        }
        say('✓ 周记已落盘：' + path.relative(ROOT, file) + '（' + body.length + ' 字）');
        const res = spawnSync(process.execPath || 'node', [SCENE_TOOL, '索引', '--场景', PERSONA], {
          cwd: ROOT, encoding: 'utf8', timeout: 60000
        });
        say(res.status === 0 ? '✓ 索引已刷' : '⚠ 索引刷新失败：' + String((res.stdout || '') + (res.stderr || '')).trim());
        return 0;
      }
      say('回合已结束但正文为空，再等一拍');
    }
    if (Date.now() - started > timeoutSec * 1000) {
      say('✗ 超过 ' + timeoutSec + ' 秒没等到她写完。引擎可能忙、或这一轮被别的活占了。');
      say('  晚点再跑一次：node 12-源码照搬\\工具\\周记.mjs 写');
      return 1;
    }
    await sleep(intervalMs);
  }
}

// 6. 读周记
function cmdRead() {
  ensureDirs();
  if (has('--最近')) {
    const n = Math.max(1, Number(val('--最近', '8')) || 8);
    const files = fs.readdirSync(WEEK_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-n);
    if (!files.length) { say('还没有周记（跑一次「写」就有了）'); return 0; }
    say('最近 ' + files.length + ' 周：');
    for (const f of files) {
      const body = readText(path.join(WEEK_DIR, f)).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      say('- ' + f.replace(/\.md$/, '') + ' · ' + firstLine(body));
    }
    return 0;
  }
  let monStr = has('--周') ? String(val('--周', '')).trim() : thisMonday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monStr)) { say('✗ --周 要 YYYY-MM-DD'); return 2; }
  monStr = fmt(mondayOf(new Date(monStr + 'T00:00:00')));
  const file = path.join(WEEK_DIR, monStr + '.md');
  if (!fs.existsSync(file)) { say('没有 ' + monStr + ' 这一周的周记（还没写）'); return 0; }
  say('【' + monStr + ' 这一周的周记】');
  say(readText(file).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim());
  return 0;
}

const table = { 写: cmdWrite, 存档: cmdArchive, 读: cmdRead };
if (!table[cmd]) {
  say('用法：node 工具\\周记.mjs 存档 ｜ 写 [--dry] [--timeout 秒] [--周 YYYY-MM-DD] ｜ 读 [--周 YYYY-MM-DD] ｜ 读 --最近 N');
  process.exit(2);
}

Promise.resolve(table[cmd]()).then((code) => process.exit(code)).catch((e) => {
  say('✗ ' + ((e && e.message) || e));
  process.exit(1);
});
