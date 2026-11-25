#!/usr/bin/env node
// @功能台 {"name":"写日记","group":"社交","freq":"daily","plain":"让「胡闹的大肥鱼」写今天或某天的日记；默认只给自己看、不进开场注入。","why":"她要像个独立虚拟人，得有自己过日子的痕迹；每天 23:00 自动写，漏了可手动补。","label":"写日记","timeout":960000}
// 日记.mjs —— 「胡闹的大肥鱼」每晚写日记（2026-11-25）
//
// 为什么要有它：她要像个独立的虚拟人，就得有「自己的日子」——每天睡前把今天写给自己看，
//   而不是只在你问的时候才开口。日记默认只给自己看、不进开场注入；你想看就主动读。
//
// 它做什么（复用 派发-公共.mjs 的引擎调用，不另写一套）：
//   1) 收集这一天的人格素材（聊过什么 / 记住了什么 / 答应没办）；
//   2) 把「写日记」的指令投给「胡闹的大肥鱼」会话，让她用自己的语气写；
//   3) 等她写完那一轮，把正文落盘 场景记忆\胡闹的大肥鱼\日记\YYYY-MM-DD.md，并进索引。
//
// 用法：
//   node 工具\日记.mjs 写 [--dry] [--timeout 900] [--日 YYYY-MM-DD] [--覆盖]
//     写今天；--日 可补写某天（已存在默认不覆盖，--覆盖 才重写）；--dry 只打印将投递的指令
//   node 工具\日记.mjs 读 [--天 YYYY-MM-DD]              读某天日记（默认今天）
//   node 工具\日记.mjs 读 --最近 7                        列最近 7 篇（日期 · 首行）
//
// 退出码：0 成功 / 1 引擎没在线或等不到她写完 / 2 参数或前置不成立

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DSH_HOME, loadSessions, resolveSession, transcriptOf, readEvents,
  finalTextOf, getCookie, promptSession, nowStamp
} from './派发-公共.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PERSONA = '胡闹的大肥鱼';
const MEM = path.join(DSH_HOME, '场景记忆', PERSONA);
const PERSONA_TOOL = path.join(HERE, '人格记忆.mjs');
const SCENE_TOOL = path.join(HERE, '场景记忆.mjs');
const DIARY_DIR = path.join(MEM, '日记');
const IDX = path.join(DIARY_DIR, '_索引.md');
const IDX_LONG = path.join(MEM, '记忆', '_索引.md');
const IDX_TALK = path.join(MEM, '对话', '_索引.md');
const TODO = path.join(MEM, '_待办.md');

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const say = (s) => console.log(s);

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function validDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  const d = new Date(y, mo - 1, day);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === day;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function ensureDirs() {
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  if (!fs.existsSync(IDX)) fs.writeFileSync(IDX, '# 日记索引\n\n> 一行一条：日期 · 首行。只追加。\n\n', 'utf8');
}

// 1. 收集素材：默认今天，也可指定补写日期；对话 / 记忆索引里只要含这一天，各限 12 行
function collectMaterial(d = today()) {
  const rows = [];
  const pick = (file, label) => {
    const lines = readText(file).split(/\r?\n/).filter((l) => l.startsWith('- ') && l.includes(d)).slice(-12);
    if (lines.length) rows.push('## ' + label + '（' + d + '）', lines.join('\n'));
  };
  pick(IDX_TALK, '聊过什么');
  pick(IDX_LONG, '记住了什么');
  const todo = readText(TODO).split(/\r?\n/).filter((l) => /^- \[ \]/.test(l.trim())).slice(0, 8);
  if (todo.length) rows.push('## 答应还没办', todo.join('\n'));
  return rows.length ? rows.join('\n') : '（今天没有新的聊天、记忆和未办事项）';
}

// 2. 写日记指令：第一人称、只给自己看、用她平时的语气；明确要写多句，别被聊天风格裁成两行
function diaryPrompt(material, marker, d = today()) {
  const when = d === today() ? '今天' : d + ' 这一天';
  return [
    '【系统日记任务 ' + marker + '】',
    '写' + when + '的日记。这不是有人找你聊天，是写给自己看的私密日记。',
    '',
    '要求：',
    '1. 第一人称，像睡前自己写给自己，不汇报、不回复谁、不列点、不写「作为AI」。',
    '2. 用你平时说话的样子：短句、淡一点、不装可爱、不硬找话。',
    '3. 写四样：' + when + '主要聊了什么 / 记住了谁、记下哪件事 / 现在什么感受 / 明天想做什么或提醒自己什么。',
    '4. 只写 8~14 句，最多 3 段。',
    '5. 正文写完后，空一行，再写两块给系统提炼用（没有就写「（无）」）：',
    '【记忆候选】',
    '- 一句话标题 ｜ 要点一 ｜ 要点二',
    '【待办候选】',
    '- 谁答应了谁、要办什么',
    '6. 记忆候选只写「以后还会用到」的事；当天流水、空泛总结（如「今天没什么可记」「各干各的」）不要写；没有就写（无）。',
    '这两块不进日记正文，正文里不要提到它们。',
    '',
    '这一天的素材（只有这些，别编）：',
    material,
    '',
    '直接开始写正文，不要标题、不要「日记」两个字、不要复述上面这些要求。'
  ].join('\n');
}

// 3.1 把日记拆成「正文 + 记忆候选 + 待办候选」：模型偶尔会漏写标记，漏了就整篇当正文
function trivialCandidate(s) {
  const t = String(s || '').replace(/^\d{4}-\d{2}-\d{2}\s*/, '').trim();
  return /^（?无）?$/.test(t) ||
    /基本没什么可记|没什么可记|没什么新东西|各干各的|一切照旧|和平时一样/.test(t);
}
function splitCandidates(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  const at = clean.search(/【记忆候选】/);
  if (at < 0) return { body: clean, memory: [], todo: [] };
  const body = clean.slice(0, at).trim();
  const tail = clean.slice(at);
  const memRaw = (tail.match(/【记忆候选】([\s\S]*?)(?=【待办候选】|$)/) || [])[1] || '';
  const todoRaw = (tail.match(/【待办候选】([\s\S]*)$/) || [])[1] || '';
  const rows = (s) => s.split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l && l !== '（无）' && l !== '(无)');
  return {
    body: body || clean,
    memory: rows(memRaw).filter((l) => !trivialCandidate(l)).slice(0, 3),
    todo: rows(todoRaw).filter((l) => !trivialCandidate(l)).slice(0, 2)
  };
}

// 3.2 候选写回人格记忆：仍走 人格记忆.mjs 的闸门（相似拒写 / 确认开关都在它那边）
function rememberCandidates(cands, d = today()) {
  let mem = 0, todo = 0;
  const run = (args) => spawnSync(process.execPath || 'node', [PERSONA_TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000
  });
  for (const r of cands.memory) {
    const parts = r.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) continue;
    const title = parts[0].replace(/^\d{4}-\d{2}-\d{2}\s*/, '').trim();
    if (!title || trivialCandidate(title)) continue;
    const res = run(['写', '--类', '记忆', '--标题', title, '--要点', parts.slice(1).join('|') || title, '--日期', d]);
    if (res.status === 0) mem++;
  }
  for (const r of cands.todo) {
    const title = String(r || '').replace(/^\d{4}-\d{2}-\d{2}\s*/, '').trim();
    if (!title || trivialCandidate(title)) continue;
    const res = run(['写', '--类', '待办', '--标题', title, '--日期', d]);
    if (res.status === 0) todo++;
  }
  if (mem || todo) say('✓ 从日记提炼：记忆 ' + mem + ' 条 · 待办 ' + todo + ' 条');
  return mem + todo;
}

// 3.3 写完立刻刷分条索引，神经元与下钻页不用等人手动跑
function refreshSceneIndex() {
  const res = spawnSync(process.execPath || 'node', [SCENE_TOOL, '索引', '--场景', PERSONA], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000
  });
  say(res.status === 0 ? '✓ 索引已刷' : '⚠ 索引刷新失败：' + String((res.stdout || '') + (res.stderr || '')).trim());
}

// 3. 在事件流里定位「我们投的那条日记指令」所在回合；等它 turn/end
function locateTurn(events, marker) {
  if (!events) return null;
  const idx = events.findIndex((e) => e.type === 'user/message' && JSON.stringify(e.data || {}).includes(marker));
  if (idx < 0) return null;
  const end = events.slice(idx).find((e) => e.type === 'turn/end');
  return end ? Number(end.data.turn) : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 4. 写某一天：投指令 → 等她写完 → 落盘（默认今天；--日 可补写，已存在则拒绝覆盖）
async function cmdWrite() {
  const dry = has('--dry');
  const timeoutSec = Number(val('--timeout', '900')) || 900;
  const intervalMs = 5000;
  const d = String(val('--日', today())).trim();
  if (!validDay(d)) { say('✗ --日 要真实存在的 YYYY-MM-DD：' + d); return 2; }
  const outFile = path.join(DIARY_DIR, d + '.md');

  ensureDirs();
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0 && !has('--覆盖') && !dry) {
    say('✓ ' + d + ' 的日记已经存在，不覆盖：' + path.relative(ROOT, outFile) + '（要重写加 --覆盖）');
    return 0;
  }
  const material = collectMaterial(d);
  const marker = 'diary-' + d + '-' + crypto.randomBytes(3).toString('hex');
  const prompt = diaryPrompt(material, marker, d);

  if (dry) {
    say('--dry：不投递，只打印将投给「' + PERSONA + '」的指令（' + prompt.length + ' 字，日期 ' + d + '）');
    say('---\n' + prompt + '\n---');
    return 0;
  }

  const sessions = loadSessions();
  const to = resolveSession(sessions, PERSONA);
  if (!to) { say('✗ 找不到会话「' + PERSONA + '」：先在工作台开着她，或引擎没在跑'); return 2; }

  say('日记：投给「' + (to.title || to.id) + '」写 ' + d + ' 的日记');
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
        const cands = splitCandidates(text);
        const body = cands.body;
        const file = outFile;
        const fm = '---\ndate: ' + d + '\n---\n\n' + body + '\n';
        fs.writeFileSync(file, fm.replace(/\n/g, '\r\n'), 'utf8');
        const rel = d + '.md';
        const line = '- ' + d + ' · ' + firstLine(body);
        if (!readText(IDX).includes(line)) {
          fs.writeFileSync(IDX, readText(IDX).replace(/\s*$/, '\r\n') + line + '\r\n', 'utf8');
        }
        say('✓ 日记已落盘：' + path.relative(ROOT, file) + '（' + body.length + ' 字）');
        rememberCandidates(cands, d);
        refreshSceneIndex();
        return 0;
      }
      say('回合已结束但正文为空，再等一拍');
    }
    if (Date.now() - started > timeoutSec * 1000) {
      say('✗ 超过 ' + timeoutSec + ' 秒没等到她写完。引擎可能忙、或这一轮被别的活占了。');
      say('  晚点再跑一次：node 12-源码照搬\\工具\\日记.mjs 写' + (d !== today() ? (' --日 ' + d) : ''));
      return 1;
    }
    await sleep(intervalMs);
  }
}

function firstLine(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}

// 5. 读：读某天 / 今天，或列最近 N 篇
function cmdRead() {
  ensureDirs();
  if (has('--最近')) {
    const n = Math.max(1, Number(val('--最近', '7')) || 7);
    const files = fs.readdirSync(DIARY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-n);
    if (!files.length) { say('还没有日记（跑一次「写」就有了）'); return 0; }
    say('最近 ' + files.length + ' 篇：');
    for (const f of files) {
      const body = readText(path.join(DIARY_DIR, f)).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      say('- ' + f.replace(/\.md$/, '') + ' · ' + firstLine(body));
    }
    return 0;
  }
  const d = String(val('--天', today())).trim();
  const file = path.join(DIARY_DIR, d + '.md');
  if (!fs.existsSync(file)) { say('没有 ' + d + ' 的日记（' + (d === today() ? '今天还没写' : '这天没写') + '）'); return 0; }
  say('【' + d + ' 的日记】');
  say(readText(file).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim());
  return 0;
}

const table = { 写: cmdWrite, 读: cmdRead };
if (!table[cmd]) {
  say('用法：node 工具\\日记.mjs 写 [--dry] [--timeout 秒] ｜ 读 [--天 YYYY-MM-DD] ｜ 读 --最近 N');
  process.exit(2);
}

Promise.resolve(table[cmd]()).then((code) => process.exit(code)).catch((e) => {
  say('✗ ' + ((e && e.message) || e));
  process.exit(1);
});
