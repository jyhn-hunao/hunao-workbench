#!/usr/bin/env node
// @功能台 {"name":"她主动开口","group":"社交","freq":"daily","plain":"查她的劲儿攒到哪、能不能开口；劲儿够了就让她主动说一句，默认按 微信→QQ→飞书→其它 发出去并归档（不刷工作台）。","why":"她要像个独立虚拟人，不能只在你问的时候才说话；攒劲儿 + 生物钟 + 有事才开口，克制、不刷屏，而且优先走你真的会看的社交通道。","label":"看劲儿/开口","timeout":660000}
// 开口.mjs —— 「胡闹的大肥鱼」攒劲儿主动开口（2026-11-25）
//
// 为什么要有它：日记是「一天」、周记是「一周」，还差「当下」——她在没人问的时候，
//   攒够了劲儿、又在清醒时段，会自己冒一句。这就是她的生物钟。
//
// 攒劲儿口径（参考 DSH 社区 dsh-fish 的「攒劲」机制，这里裁剪成最小可用）：
//   · 每小时自然 +6，上限 100；开口一次扣 50（约 16 小时攒满，说一次再攒 8 小时）。
//   · 只在清醒时段 09:00–23:30 开口，其余时间她在睡、劲儿照攒但不开口。
//   · 每小时最多开口 2 次（保险，防止某个 bug 刷屏）。
//   · 劲儿不够 / 时段不对 / 本小时说满 ⇒ 不投递、不扣劲，只是「这轮还没到时候」。
//
// 有事才开口：素材只从 未办待办 / 今天聊过什么 / 今天记下什么 三处取；都没有就让她随便冒个泡。
// 落点（2026-11-25 改）：默认「先发社交通道」（微信→QQ→飞书→其它），并且**不再投人格主会话** ——
//   生成那一轮投进一个不绑面板的独白会话（设置 speak.sessionTitle），所以工作台对话框不会再被这些
//   「系统开口任务」刷屏；全通道不通就记进 data\pet\开口-未送出.jsonl，等下次补发。
//   想回到「只出现在工作台」就改 设置 → 人格 → 她主动吗 → 开口去哪 = 只发工作台。
//   归档照旧：场景记忆\胡闹的大肥鱼\开口\。
//
// 用法：
//   node 工具\开口.mjs 查                    看劲儿、时段、能不能开口、还差多少
//   node 工具\开口.mjs 说 [--dry] [--timeout 600]   劲儿够就让她说一句（--dry 只打印，不投不扣）
//   node 工具\开口.mjs 充值 --劲 100          手动加劲儿（调试 / 想让她现在说）
//   node 工具\开口.mjs 清                    清空劲儿与开口记录（重来）
//
// 退出码：0 成功（说成功 / 查成功 / dry）· 1 没到时候（劲儿不够/时段不对/本小时说满）· 2 参数或前置不成立

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
const SHELL = path.join(ROOT, '外壳');
const PERSONA = '胡闹的大肥鱼';
const MEM = path.join(DSH_HOME, '场景记忆', PERSONA);
const SPEAK_DIR = path.join(MEM, '开口');
const IDX = path.join(SPEAK_DIR, '_索引.md');
const IDX_LONG = path.join(MEM, '记忆', '_索引.md');
const IDX_TALK = path.join(MEM, '对话', '_索引.md');
const TODO = path.join(MEM, '_待办.md');
const IDX_CONTENT = path.join(DSH_HOME, '场景记忆', '生活', '内容', '_索引.md');   // 生活场景今天刷到的（2026-11-25）
const DATA_DIR = path.join(process.env.DSH_SHELL_DATA || path.join(SHELL, 'data'), 'pet');
const ENERGY_FILE = path.join(DATA_DIR, '劲儿.json');
const SETTINGS_FILE = path.join(DATA_DIR, '设置.json');
const UNSENT_LOG = path.join(DATA_DIR, '开口-未送出.jsonl');
// 开口去向（默认发通道；顺序在 外壳\data\通道优先级.json，默认 微信→QQ→飞书→其它）
const CH_TOOL = path.join(HERE, '通道发送.mjs');
const BUILD_SESSION = path.join(SHELL, 'scripts', '建会话.mjs');
const DEFAULT_SPEAK_SESSION = '胡闹的大肥鱼 · 开口';

function speakCfg() {
  const s = readJson(SETTINGS_FILE, {}) || {};
  const sp = s.speak || {};
  const delivery = String(sp.delivery || 'channel') === 'panel' ? 'panel' : 'channel';
  return { delivery, title: String(sp.sessionTitle || DEFAULT_SPEAK_SESSION) };
}

// 独白会话：不绑任何面板，面板上就看不到这些「系统开口任务」；没有就现建一个（壳里跑才有 DSH_TOKEN）
function ensureSpeakSession(title) {
  const hit = resolveSession(loadSessions(), title);
  if (hit) return hit;
  say('· 还没有「' + title + '」这个独白会话，先建一个（不绑面板，工作台看不到）');
  const r = spawnSync(process.execPath, [BUILD_SESSION, '--title', title], { encoding: 'utf8', timeout: 180000, env: process.env });
  const out = String((r && (r.stdout || r.stderr)) || '').trim().split(/\r?\n/).filter(Boolean);
  const last = out.length ? out[out.length - 1] : '';
  if (r && r.status === 0) {
    const again = resolveSession(loadSessions(), title);
    if (again) { say('✓ 独白会话建好了：' + again.id); return again; }
  }
  say('✗ 建不出独白会话：' + (last || '建会话脚本没回话') + '（要在壳里跑（带 DSH_TOKEN）；也可手动 node 12-源码照搬\\外壳\\scripts\\建会话.mjs --title "' + title + '"）');
  return null;
}

function appendUnsent(body, why) {
  try {
    fs.mkdirSync(path.dirname(UNSENT_LOG), { recursive: true });
    fs.appendFileSync(UNSENT_LOG, JSON.stringify({ at: new Date().toISOString(), text: body, why: String(why || '').slice(0, 200) }) + '\n', 'utf8');
    say('· 记进未送出台账：' + path.relative(ROOT, UNSENT_LOG) + '（通道恢复后可以照这条补发）');
  } catch (e) { say('· 未送出台账也写不了：' + ((e && e.message) || e)); }
}

function deliverToChannel(body) {
  const r = spawnSync(process.execPath, [CH_TOOL, '发', '--说', body], { encoding: 'utf8', timeout: 180000, env: process.env });
  const out = String((r && (r.stdout || r.stderr)) || '').trim().split(/\r?\n/).filter(Boolean);
  const last = out.length ? out[out.length - 1] : '';
  if (r && r.status === 0) {
    say('✓ 发到通道：' + last.replace(/^✓\s*/, ''));
    return true;
  }
  say('· 通道全不通（微信 / QQ / 飞书 / 其它 都试过了）：' + (last || '没回话'));
  appendUnsent(body, last);
  return false;
}

// 生物钟与攒劲参数（单一真源；将来要面板可调，就把这些搬进 pet\设置.默认.json）
const WAKE_FROM = 9 * 60;        // 09:00
const WAKE_TO = 23 * 60 + 30;    // 23:30
const GROW_PER_HOUR = 6;         // 每小时攒 6 点
const SPEAK_MIN = 50;            // 劲儿 >= 50 才开口
const SPEAK_COST = 50;           // 开口一次扣 50
const MAX_PER_HOUR = 2;          // 每小时最多开口 2 次

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const say = (s) => console.log(s);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}
function readJson(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fb; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function hourKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + d.getHours();
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

// 1. 劲儿账：读 → 按时间补长 → 写回
function readEnergy() {
  const st = readJson(ENERGY_FILE, { energy: 0, lastAt: 0, lastSpokeAt: 0, hours: {} });
  if (st.hours == null || typeof st.hours !== 'object') st.hours = {};
  return st;
}
function saveEnergy(st) {
  writeJson(ENERGY_FILE, st);
}
function tickEnergy() {
  const st = readEnergy();
  const now = Date.now();
  const last = Number(st.lastAt) || now;
  const grown = Math.max(0, (now - last) / 3600000) * GROW_PER_HOUR;
  st.energy = Math.min(100, Math.max(0, Number(st.energy) || 0) + grown);
  st.lastAt = now;
  saveEnergy(st);
  return st;
}

// 2. 能不能开口：清醒时段 + 劲儿够 + 本小时没超过上限
function canSpeak(st) {
  const min = nowMin();
  if (min < WAKE_FROM || min >= WAKE_TO) return { ok: false, reason: '没到清醒时段（09:00–23:30），她在睡' };
  if (Number(st.energy) < SPEAK_MIN) return { ok: false, reason: '劲儿不够（' + Math.round(st.energy) + '/' + SPEAK_MIN + '）' };
  const hk = hourKey(new Date());
  const used = Number((st.hours || {})[hk] || 0);
  if (used >= MAX_PER_HOUR) return { ok: false, reason: '这一小时已经开口 ' + used + '/' + MAX_PER_HOUR + ' 次' };
  return { ok: true, reason: '可以开口（劲儿 ' + Math.round(st.energy) + '，本小时 ' + used + '/' + MAX_PER_HOUR + '）', used };
}

// 3. 有事才开口：未办待办 + 今天聊过/记过；都没有就冒个泡
function collectMaterial() {
  const d = fileStamp().slice(0, 10);
  const rows = [];
  const todo = readText(TODO).split(/\r?\n/).filter((l) => /^- \[ \]/.test(l.trim())).slice(0, 5);
  if (todo.length) rows.push('## 还没办的事', todo.join('\n'));
  const pick = (file, label) => {
    const lines = readText(file).split(/\r?\n/).filter((l) => l.startsWith('- ') && l.includes(d)).slice(-6);
    if (lines.length) rows.push('## ' + label + '（今天）', lines.join('\n'));
  };
  pick(IDX_TALK, '今天聊过什么');
  pick(IDX_LONG, '今天记下什么');
  pick(IDX_CONTENT, '今天刷到的（生活场景）');
  return rows.length ? rows.join('\n') : '';
}

// 人格底子：独白会话不绑面板，记忆回响插件不会给它注入人格卡；这里直接把设置里的
// 「我是谁 / 性格 / 说话 / 在意 / 绝不」摘一段带进 prompt，免得她说出来像通用助手。
function personaBrief() {
  const s = readJson(SETTINGS_FILE, {}) || {};
  const p = s.persona || {};
  const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const speech = String(p.speech || '').split(/\r?\n/)
    .filter((l) => l && !/^(语音：|分两条时|发出去前自检：|范例|「)/.test(l.trim()))
    .join(' ');
  const rows = [];
  if (p.name || p.selfName) rows.push('你是「' + (p.name || '胡闹的大肥鱼') + '」，自称「' + (p.selfName || '饭团') + '」。');
  if (p.identity) rows.push('身份：' + clip(p.identity, 220));
  if (p.personality) rows.push('性格：' + clip(p.personality, 200));
  if (speech) rows.push('说话：' + clip(speech, 260));
  if (p.care) rows.push('在意：' + clip(p.care, 160));
  if (p.never) rows.push('绝不：' + clip(p.never, 160));
  return rows.join('\n');
}

function speakPrompt(material, marker) {
  const brief = personaBrief();
  const lines = ['【系统开口任务 ' + marker + '】', '你现在有点想主动说句话。这是你自己想开口，不是有人在问你、也不是要你汇报。', ''];
  if (brief) lines.push('你是谁（只有这些，别复述、别自我介绍）：', brief, '');
  if (material) lines.push('你想到的（只有这些，别编）：', material, '');
  lines.push(
    '要求：',
    '1. 第一人称，像突然想到就开口，不是回答谁，不带「收到 / 好的 / 我来」这类回应。',
    '2. 用你平时说话的样子，只写 1~3 句，最多 60 字。',
    '3. 素材里有「还没办的事」就自然地提一句（像想起，不是催）；没有值得说的，就说一句「没什么，就想冒个泡」之类。',
    '',
    '直接说，不要标题、不要解释、不要复述上面这些要求。'
  );
  return lines.join('\n');
}

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
function ensureDirs() {
  fs.mkdirSync(SPEAK_DIR, { recursive: true });
  if (!fs.existsSync(IDX)) fs.writeFileSync(IDX, '# 开口索引\n\n> 一行一条：时间 · 首行。只追加。\n\n', 'utf8');
}

// 4. 说：劲儿够才投，投成才扣劲记账；投失败不扣，下轮再试
async function cmdSay() {
  const dry = has('--dry');
  const timeoutSec = Number(val('--timeout', '600')) || 600;
  const intervalMs = 5000;

  const st = tickEnergy();
  const gate = canSpeak(st);
  if (!gate.ok) { say('✗ ' + gate.reason); return 1; }

  const material = collectMaterial();
  const marker = 'speak-' + fileStamp() + '-' + crypto.randomBytes(3).toString('hex');
  const prompt = speakPrompt(material, marker);

  if (dry) {
    say('--dry：不投递、不扣劲儿。当前 ' + gate.reason);
    say('---\n' + prompt + '\n---');
    return 0;
  }

  const cfg = speakCfg();
  const to = cfg.delivery === 'panel' ? resolveSession(loadSessions(), PERSONA) : ensureSpeakSession(cfg.title);
  if (!to) { say('✗ 没有可投的会话（面板=' + PERSONA + ' / 独白=' + cfg.title + '）：引擎没在跑，或会话还没建'); return 2; }

  say('开口：投给「' + (to.title || to.id) + '」让她说一句'
    + (cfg.delivery === 'channel' ? '（独白会话，工作台看不到）' : '')
    + ' · 去向=' + (cfg.delivery === 'channel' ? '社交通道优先' : '只留工作台'));
  const cookie = await getCookie();
  await promptSession(to.id, prompt, cookie);
  say('✓ 已投递，等她说完（最多 ' + timeoutSec + ' 秒）');

  const started = Date.now();
  while (true) {
    const events = readEvents(transcriptOf(to.id));
    const turn = locateTurn(events, marker);
    if (turn != null) {
      const text = finalTextOf(events, turn);
      if (text) {
        const body = text.replace(/\r\n/g, '\n').trim();
        const ts = fileStamp();
        const file = path.join(SPEAK_DIR, ts + '.md');
        fs.writeFileSync(file, ('---\nat: ' + stamp() + '\n---\n\n' + body + '\n').replace(/\n/g, '\r\n'), 'utf8');
        const line = '- ' + stamp() + ' · ' + firstLine(body);
        if (!readText(IDX).includes(line)) {
          fs.writeFileSync(IDX, readText(IDX).replace(/\s*$/, '\r\n') + line + '\r\n', 'utf8');
        }
        // 扣劲 + 记账（只有真的说出口才扣）
        const st2 = readEnergy();
        st2.energy = Math.max(0, Number(st2.energy) - SPEAK_COST);
        st2.lastSpokeAt = Date.now();
        st2.hours = st2.hours || {};
        const hk = hourKey(new Date());
        st2.hours[hk] = Number(st2.hours[hk] || 0) + 1;
        const keys = Object.keys(st2.hours).sort().slice(-48);
        const keep = {};
        for (const k of keys) keep[k] = st2.hours[k];
        st2.hours = keep;
        saveEnergy(st2);
        say('✓ 她开口了（' + body.length + ' 字，劲儿 ' + Math.round(st2.energy) + ' 剩）→ ' + path.relative(ROOT, file));
        // 2026-11-25：默认发通道（微信先，不通转 QQ，再飞书，再其它）；只有「只留工作台」模式才不发
        if (cfg.delivery === 'panel') {
          say('· 去向=只留工作台（设置 → 人格 → 她主动吗 → 开口去哪），这次不发通道');
        } else if (has('--不发')) {
          say('· 带了 --不发：这次只归档，不发通道');
        } else {
          deliverToChannel(body);
        }
        return 0;
      }
      say('回合已结束但正文为空，再等一拍');
    }
    if (Date.now() - started > timeoutSec * 1000) {
      say('✗ 超过 ' + timeoutSec + ' 秒没等到她说完（不扣劲儿，下轮再试）');
      return 1;
    }
    await sleep(intervalMs);
  }
}

// 5. 查：劲儿、时段、能不能开口、还差多少
function cmdQuery() {
  const st = tickEnergy();
  const cfg = speakCfg();
  const min = nowMin();
  const awake = min >= WAKE_FROM && min < WAKE_TO;
  const need = Math.max(0, SPEAK_MIN - Number(st.energy));
  const hours = need / GROW_PER_HOUR;
  say('去向：' + (cfg.delivery === 'channel'
    ? '社交通道优先（微信 → QQ → 飞书 → 其它），生成放独白会话「' + cfg.title + '」'
    : '只留工作台（投「' + PERSONA + '」）'));
  say('劲儿：' + Math.round(Number(st.energy)) + ' / 100（每小时 +' + GROW_PER_HOUR + '，开口一次扣 ' + SPEAK_COST + '）');
  say('时段：' + (awake ? '清醒（09:00–23:30），可以开口' : '在睡（09:00–23:30），这会儿不开口'));
  say('上次开口：' + (st.lastSpokeAt ? stamp() + '（本次启动视角）' : '还没主动说过'));
  const gate = canSpeak(st);
  say((gate.ok ? '✓ ' : '✗ ') + gate.reason);
  if (!gate.ok && awake && Number(st.energy) < SPEAK_MIN) {
    say('  还差 ' + Math.round(need) + ' 点劲儿，约 ' + hours.toFixed(1) + ' 小时攒够。想现在说：node 12-源码照搬\\工具\\开口.mjs 充值 --劲 100');
  }
  return gate.ok ? 0 : 1;
}

// 6. 充值 / 清空（调试、或想让她现在说）
function cmdBoost() {
  const n = Number(val('--劲', ''));
  if (!n || n < 0 || n > 100) { say('✗ --劲 要 0~100 的数'); return 2; }
  const st = readEnergy();
  st.energy = Math.min(100, n);
  st.lastAt = Date.now();
  saveEnergy(st);
  say('✓ 劲儿设为 ' + Math.round(st.energy) + ' / 100');
  return 0;
}
function cmdReset() {
  writeJson(ENERGY_FILE, { energy: 0, lastAt: Date.now(), lastSpokeAt: 0, hours: {} });
  say('✓ 劲儿与开口记录已清空（从 0 重新攒）');
  return 0;
}

const table = { 查: cmdQuery, 说: cmdSay, 充值: cmdBoost, 清: cmdReset };
if (!table[cmd]) {
  say('用法：node 工具\\开口.mjs 查 ｜ 说 [--dry] [--timeout 秒] ｜ 充值 --劲 N ｜ 清');
  process.exit(2);
}
Promise.resolve(table[cmd]()).then((code) => process.exit(code)).catch((e) => {
  say('✗ ' + ((e && e.message) || e));
  process.exit(1);
});
