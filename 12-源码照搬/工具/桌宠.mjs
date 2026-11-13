#!/usr/bin/env node
// 桌宠.mjs —— 桌宠层的三个动作：查路由 / 派活 / 看日志（2026-11-13）
//
// 为什么有它：人格会话不该自己拼「派发.mjs --to 某某」，也不该猜某个词属于哪个场景。
//   这里把 外壳\桌宠设置.js 的配置读出来，一条原话先过路由表，再决定派给谁、要不要人点头。
//
// 用法：
//   node 12-源码照搬\工具\桌宠.mjs 路由 --文本 "B站那期视频的脚本还在吗"
//   node 12-源码照搬\工具\桌宠.mjs 派   --文本 "帮我看下项目里那个 bug"              # level=confirm 时会拒绝并提示加 --确认
//   node 12-源码照搬\工具\桌宠.mjs 派   --文本 "…" --确认                           # 人已经点头了
//   node 12-源码照搬\工具\桌宠.mjs 派   --文本 "…" --超时 900 --dry                 # 只看会派给谁，不投递
//   node 12-源码照搬\工具\桌宠.mjs 日志 --尾 10
//   node 12-源码照搬\工具\桌宠.mjs 设置                                             # 打印配置文件路径与当前值
//   node 12-源码照搬\工具\桌宠.mjs 桥接同步                                         # 把桥接 routes 指回 pet-ai 的当前会话
//
// 退出码：0 = 成功 / 2 = 认不出路由（列候选） / 3 = 需要人确认（未加 --确认） / 4 = 派发失败或超时
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pet = require('../外壳/桌宠设置.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = path.join(ROOT, '工具', '派发.mjs');
const SYNC = path.join(ROOT, '工具', '同步桥接路由.mjs');
const MEMTOOL = path.join(ROOT, '工具', '人格记忆.mjs');

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const has = (k) => argv.includes(k);
const say = (s) => console.log(s);

function cmdRoute() {
  const text = val('--文本', argv.slice(1).join(' '));
  const r = pet.resolveRoute(text, pet.getSettings());
  if (!r.hit) {
    say('✗ 认不出该派给谁。候选场景：' + (r.candidates || []).join(' / '));
    say('  （改关键词去 外壳\\data\\pet\\设置.json 的 routes，或直接 --to 指定会话）');
    return 2;
  }
  say('✓ 派给「' + r.hit.to + '」（级别 ' + r.hit.level + '，命中关键词：' + r.hit.matched.join('、') + '）');
  return 0;
}

function cmdDispatch() {
  const text = String(val('--文本', ''));
  const dry = has('--dry');
  const confirmed = has('--确认');
  const timeoutSec = Math.max(30, Number(val('--超时', 600)) || 600);
  if (!text.trim()) { say('✗ 缺少 --文本 "<原话>"'); return 4; }

  const settings = pet.getSettings();
  // 工具白名单是硬门：设置里没让「派活」，直接拒绝，不靠模型自觉（2026-11-13）
  const allow = (settings.tools || {}).allow || [];
  const deny = (settings.tools || {}).deny || [];
  if (deny.indexOf('dispatch') >= 0 || allow.indexOf('dispatch') < 0) {
    say('✗ 设置里没允许「派活给别的场景」⇒ 不派。（人格面板 ⚙ 设置 → 她可以做什么 → 派活给别的场景）');
    return 5;
  }

  const r = pet.resolveRoute(text, settings);
  if (!r.hit) {
    say('✗ 认不出该派给谁。候选场景：' + (r.candidates || []).join(' / '));
    return 2;
  }
  // 审批一律走 桌宠设置.js 的 dispatchPolicy（通道降级、全局只读要问、never 都在那一条里判）
  const pol = pet.dispatchPolicy(text, r.hit, settings);
  if (pol.level === 'never') {
    say('✗ 不派：' + (pol.reason || '该场景被设为禁止') + '。要改：人格面板 ⚙ 设置 → 哪句话该交给谁');
    return 5;
  }
  if (pol.confirm && !confirmed) {
    say('⚠ 这条要派给「' + r.hit.to + '」⇒ 需要你确认（' + pol.reason + '）。确认后加 --确认 再跑一次：');
    say('  node 12-源码照搬\\工具\\桌宠.mjs 派 --文本 "' + text + '" --确认');
    return 3;
  }
  if (dry) {
    say('（--dry）会派给「' + r.hit.to + '」：' + text);
    return 0;
  }

  const t0 = Date.now();
  // 派发方默认是人格会话（桌宠就是「胡闹的大肥鱼」这条会话），别让人再手填 --from
  const fromId = String(val('--from', '') || pet.petSession().sessionId || '');
  const args = [DISPATCH, '--to', r.hit.to, text, '--timeout', String(timeoutSec)];
  if (fromId) args.push('--from', fromId);
  const res = spawnSync(process.execPath || 'node', args, {
    cwd: ROOT, encoding: 'utf8', timeout: (timeoutSec + 20) * 1000, maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const out = String((res.stdout || '') + (res.stderr || '')).trim();
  const ok = res.status === 0 && !res.error;
  const tail = out.split('\n').filter(Boolean).slice(-3).join(' | ');
  const ticket = (out.match(/派发单\s+([0-9\w-]+)/) || [])[1] || '';
  pet.logDispatch({
    at: new Date().toISOString(), text, to: r.hit.to, level: r.hit.level,
    ok, summary: ok ? (tail || '已投递') : (res.error ? String(res.error.message || res.error) : tail || '退出码 ' + res.status),
    ms, ticket,
  });
  say((ok ? '✓' : '✗') + ' 派给「' + r.hit.to + '」' + (ok ? ' 完成' : ' 失败') + '（' + Math.round(ms) + 'ms）');
  if (tail) say('  ' + tail);
  if (!ok && res.error && res.error.code === 'ETIMEDOUT') say('  （超时：' + timeoutSec + 's 内没等到回执，任务可能还在跑）');
  return ok ? 0 : 4;
}

function cmdLog() {
  const n = Number(val('--尾', 10)) || 10;
  const rows = pet.tailLog(n);
  say('日志：' + pet.logPath());
  if (!rows.length) say('（还没有派发记录）');
  rows.forEach((x) => say(x));
  return 0;
}

function cmdSettings() {
  say('默认值：' + pet.DEFAULT_FILE);
  say('运行值：' + pet.DATA_FILE + (fs.existsSync(pet.DATA_FILE) ? '' : '（还没生成，按默认值生效）'));
  say('引擎 home：' + pet.DSH_HOME);
  const s = pet.getSettings();
  const p = pet.petSession();
  say('人格会话：' + (p.sessionId || '未绑定') + '（' + (p.sessionTitle || '—') + '）');
  say(JSON.stringify(s, null, 2));
  return 0;
}

function cmdSync() {
  const r = spawnSync(process.execPath || 'node', [SYNC], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  const out = String((r.stdout || '') + (r.stderr || '')).trim();
  if (out) say(out);
  return r.status === 0 ? 0 : 4;
}

// 6. 能主动吗：判据与次数账都在 桌宠设置.js 的 proactiveGate 里（跨进程计数，避免各写一份）
//    --记账 才占用这一小时的额度；只查询不记账。
function cmdProactive() {
  const g = pet.proactiveGate(pet.getSettings(), { record: has('--记账') });
  say((g.ok ? '✓ ' : '✗ ') + g.reason);
  if (g.ok && !has('--记账')) say('  （要真的开口就加 --记账：占一次本小时的额度）');
  return g.ok ? 0 : 1;
}

// 7. 记：把「写记忆」这步交给 人格记忆.mjs（开关与确认都在那边按设置执行）
function cmdRemember() {
  const pass = argv.slice(1);
  const sub = String(pass[0] || '');
  const full = ['写', '读', '体检', '归档'].indexOf(sub) >= 0 ? pass : ['写'].concat(pass);   // 不写子命令默认是「写」
  const r = spawnSync(process.execPath || 'node', [MEMTOOL].concat(full), { cwd: ROOT, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const out = String((r.stdout || '') + (r.stderr || '')).trim();
  if (out) out.split('\n').forEach(say);
  return r.status === 0 ? 0 : (r.status || 4);
}

// 8. 场景：一张表列出「有哪些场景 / 绑哪条会话 / 记忆有多少 / 最近记了什么」
//    为什么：她要「去工作台记忆里找某个场景的事」，不能靠猜目录名；先看这张表，再按名字读 §〇。
function memStatOf(dirName) {
  const md = path.join(pet.DSH_HOME, '场景记忆', dirName);
  const out = { dir: dirName, ok: fs.existsSync(md), sec: 0, long: 0, last: '', todo: 0, recent: false, note: '' };
  if (!out.ok) return out;
  const f = path.join(md, '场景私有记忆.md');
  if (fs.existsSync(f)) out.sec = fs.statSync(f).size;
  // 长期知识可能落在 记忆\、决策\、坑\ 三处（老场景只有决策/坑），一起数，别只看一个目录
  const dirs3 = ['记忆', '决策', '坑'].map((d) => path.join(md, d)).filter((d) => fs.existsSync(d));
  const files = [];
  for (const d of dirs3) fs.readdirSync(d).filter((x) => x.endsWith('.md') && !x.startsWith('_')).forEach((x) => files.push(x));
  out.long = files.length;
  out.last = files.map((x) => (/^\d{4}-\d{2}-\d{2}/.exec(x) || [''])[0]).filter(Boolean).sort().slice(-1)[0] || '';
  out.recent = fs.existsSync(path.join(md, '_近期.md'));
  const td = path.join(md, '_待办.md');
  if (fs.existsSync(td)) out.todo = (fs.readFileSync(td, 'utf8').match(/^- \[ \]/gm) || []).length;
  if (!out.sec) out.note = '还没有场景记忆骨架（先 init）';
  return out;
}
function cmdScenes() {
  const dir = path.join(ROOT, '外壳', 'scenarios');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch (e) { say('✗ 读不到场景目录'); return 2; }
  // 一个场景一行：同一场景的多个面板合并显示，她要找的是「哪个场景能干活、记忆有多少」
  const rowsOut = [];
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    if (!j || !Array.isArray(j.panels)) continue;
    const name = String(j.name || j.id || f);
    const id = String(j.id || '');
    let st = memStatOf(name);
    if (!st.ok && id && id !== name) st = memStatOf(id);
    const titles = [];
    let loops = 0;
    for (const p of j.panels) {
      if (!p) continue;
      const title = String(p.sessionTitle || '');
      if (title && titles.indexOf(title) < 0) titles.push(title);   // 同一场景多张卡片指同一条会话时只报一次
      if (String(p.type) === 'harness') loops += 1;
    }
    rowsOut.push({ scene: name, id, titles, st, canDispatch: titles.length > 0, harness: loops });
  }
  if (has('--json')) { say(JSON.stringify(rowsOut, null, 2)); return 0; }
  say('场景 | 能派给谁 | §〇 | 长期记忆 | 最近一条 | 待办 | 有近期摘要');
  for (const r of rowsOut) {
    const s2 = r.st;
    say([r.scene, r.titles.length ? r.titles.join(' / ') : '（无 AI 面板）',
      s2.ok ? (s2.sec + ' B') : '无记忆骨架',
      s2.ok ? (s2.long + ' 条') : '—',
      s2.last || '—',
      s2.ok ? (s2.todo + ' 项') : '—',
      s2.recent ? '✓' : '—'].join(' | '));
    if (s2.note) say('    ⚠ ' + s2.note);
  }
  say('\n读某个场景的记忆：node 12-源码照搬\\工具\\场景记忆.mjs 读 --场景 "<上面第一列的场景名>" --节 §〇');
  say('本场景（人格）的长期记忆：node 12-源码照搬\\工具\\桌宠.mjs 记 读 --词 "关键词"');
  return 0;
}

// 9. 收尾：一轮活干完 / 换会话前跑一次，把记忆闭环补齐（重建近期摘要 → 对齐引用 → 过场景记忆闸门）
//    为什么做成一条命令：这三步原来分散在三个工具里，人只会漏；漏一步就会出现「记忆写了、开场没带上」。
function cmdWrap() {
  let bad = 0;
  say('⓪ 通道往来归档（QQ / 飞书 的对话 → 人格「对话」记忆）');
  const ch = spawnSync(process.execPath || 'node', [path.join(ROOT, '工具', '通道记忆.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  String((ch.stdout || '') + (ch.stderr || '')).trim().split('\n').filter((x) => x.trim()).slice(0, 4).forEach((x) => say('   ' + x.trim()));
  if (ch.status !== 0 && ch.status !== 3) bad += 1;
  if (ch.status === 3) say('   ⚠ 设置要求写前确认 ⇒ 通道往来这批先没记');
  say('① 记忆体检 + 重建近期摘要');
  const d = spawnSync(process.execPath || 'node', [MEMTOOL, '体检'], { cwd: ROOT, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  String((d.stdout || '') + (d.stderr || '')).trim().split('\n').filter((x) => x.trim()).forEach((x) => say('   ' + x.trim()));
  if (d.status !== 0) bad += 1;

  say('② 人格引用一致性（场景卡片 + QQ 路由）');
  const c = spawnSync(process.execPath || 'node', [SYNC, '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  if (c.status === 0) say('   ✓ 已是最新');
  else {
    say('   ⚠ 有引用不一致 ⇒ 自动对齐');
    const s = spawnSync(process.execPath || 'node', [SYNC], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    String((s.stdout || '') + (s.stderr || '')).trim().split('\n').forEach((x) => say('   ' + x.trim()));
    if (s.status !== 0) bad += 1;
  }

  say('③ 场景记忆闸门');
  const g = spawnSync(process.execPath || 'node', [path.join(ROOT, '工具', '场景记忆.mjs'), 'check', '--all'], { cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const gl = String((g.stdout || '') + (g.stderr || '')).split('\n').filter((x) => x.includes('✗') || x.includes('全部通过'));
  gl.slice(0, 6).forEach((x) => say('   ' + x.trim()));
  if (g.status !== 0) bad += 1;

  say(bad ? '✗ 收尾没全过（' + bad + ' 步失败，看上面）' : '✓ 收尾完成：近期摘要已重建、引用已对齐、记忆闸门通过');
  return bad ? 4 : 0;
}

const table = { 路由: cmdRoute, 派: cmdDispatch, 日志: cmdLog, 设置: cmdSettings, 桥接同步: cmdSync, 能主动吗: cmdProactive, 记: cmdRemember, 场景: cmdScenes, 收尾: cmdWrap };
if (!table[cmd]) {
  say('用法：node 12-源码照搬\\工具\\桌宠.mjs <路由|派|日志|设置|桥接同步|能主动吗|记|场景|收尾> [参数]');
  process.exit(2);
}
process.exit(table[cmd]());
