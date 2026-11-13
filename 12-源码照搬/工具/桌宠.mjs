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

  const r = pet.resolveRoute(text, pet.getSettings());
  if (!r.hit) {
    say('✗ 认不出该派给谁。候选场景：' + (r.candidates || []).join(' / '));
    return 2;
  }
  // 审批：confirm 级别必须有人点头（--确认）；read 级别直接派
  if (r.hit.level !== 'read' && !confirmed) {
    say('⚠ 这条要派给「' + r.hit.to + '」，级别 ' + r.hit.level + ' ⇒ 需要你确认。确认后加 --确认 再跑一次：');
    say('  node 12-源码照搬\\工具\\桌宠.mjs 派 --文本 "' + text + '" --确认');
    return 3;
  }
  if (dry) {
    say('（--dry）会派给「' + r.hit.to + '」：' + text);
    return 0;
  }

  const t0 = Date.now();
  const res = spawnSync(process.execPath || 'node', [DISPATCH, '--to', r.hit.to, text, '--timeout', String(timeoutSec)], {
    cwd: ROOT, encoding: 'utf8', timeout: (timeoutSec + 20) * 1000, maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const out = String((res.stdout || '') + (res.stderr || '')).trim();
  const ok = res.status === 0 && !res.error;
  const tail = out.split('\n').filter(Boolean).slice(-3).join(' | ');
  pet.logDispatch({
    at: new Date().toISOString(), text, to: r.hit.to, level: r.hit.level,
    ok, summary: ok ? (tail || '已投递') : (res.error ? String(res.error.message || res.error) : tail || '退出码 ' + res.status),
    ms,
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

const table = { 路由: cmdRoute, 派: cmdDispatch, 日志: cmdLog, 设置: cmdSettings, 桥接同步: cmdSync };
if (!table[cmd]) {
  say('用法：node 12-源码照搬\\工具\\桌宠.mjs <路由|派|日志|设置|桥接同步> [参数]');
  process.exit(2);
}
process.exit(table[cmd]());
