#!/usr/bin/env node
// 自检.mjs —— 守卫插件能不能按预期拦（不启动引擎、不看窗口）
//
// 为什么要它：拦截规则写错会误伤正常操作，比浪费 token 更贵。
// 这个脚本用假 ctx + 假调用把三条规则各跑一遍，红的绿的当场可见。
//
// 用法：node 12-源码照搬\插件\省token守卫\自检.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, decide, remember, LIMITS } from './rules.js';
import { apply } from './index.js';

let pass = 0;
const fails = [];
const ok = (name, cond, got) => { if (cond) pass++; else fails.push(name + (got === undefined ? '' : '  ← ' + JSON.stringify(got))); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
const small = path.join(tmp, 'small.js');
const big = path.join(tmp, 'big.js');
fs.writeFileSync(small, 'x'.repeat(1024), 'utf8');
fs.writeFileSync(big, 'x'.repeat(LIMITS.bigFileBytes + 1024), 'utf8');
const logFile = path.join(tmp, 'guard.jsonl');

// ---------- 1. 纯规则 ----------
{
  const h = new Map();
  const c1 = classify('read', { file_path: small });
  ok('read 分类', c1 && c1.kind === 'read' && c1.key.startsWith('read|'));
  ok('read 带范围识别', classify('read', { file_path: small, limit: 50 }).hasRange === true);

  ok('第 1 次读放行', decide(h, Object.assign({}, c1, { size: 1024 })) === null);
  remember(h, c1);
  ok('第 2 次读放行', decide(h, Object.assign({}, c1, { size: 1024 })) === null);
  remember(h, c1);
  const hit = decide(h, Object.assign({}, c1, { size: 1024 }));
  ok('第 3 次读被拦（repeat-read）', hit && hit.rule === 'repeat-read', hit && hit.rule);
  ok('拒绝原因说清换法', hit && /grep/.test(hit.reason));

  const bigCall = Object.assign({}, classify('read', { file_path: big }), { size: LIMITS.bigFileBytes + 1024 });
  ok('整读大文件被拦（full-read-big）', decide(new Map(), bigCall).rule === 'full-read-big');
  ok('带 offset 的大文件放行', decide(new Map(), Object.assign({}, bigCall, { hasRange: true })) === null);

  const pcall = classify('pwsh', { command: 'node  x.mjs   --dry' });
  ok('命令归一化（空白折叠）', pcall.key === 'pwsh|node x.mjs --dry', pcall.key);
  const ph = new Map();
  ok('同命令第 1 次放行', decide(ph, pcall) === null);
  remember(ph, pcall);
  ok('同命令第 2 次被拦（repeat-command）', decide(ph, pcall).rule === 'repeat-command');

  ok('grep/edit 不参与', classify('grep', { pattern: 'x' }) === null && classify('edit', {}) === null);
}

// ---------- 2. 影子模式：只记不拦 ----------
{
  const handlers = {};
  const ctx = { on: (ev, fn) => { handlers[ev] = fn; } };
  apply(ctx, { mode: 'shadow', logFile });
  const next = async () => ({ kind: 'allow' });
  const agent = { sessionId: 's-1' };
  const read = async () => handlers['tools/pre-execute']({ name: 'read', arguments: { file_path: big }, agent }, next);

  const r1 = await read();
  ok('影子模式不拦（第 1 次）', r1 && r1.kind === 'allow', r1 && r1.kind);
  const r2 = await read();
  ok('影子模式仍不拦（大文件第 2 次）', r2 && r2.kind === 'allow', r2 && r2.kind);
  const txt = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
  ok('影子模式写了日志', txt.length >= 1, txt.length);
  ok('日志里标明 mode=shadow', txt.some((l) => /"mode":"shadow"/.test(l)));
}

// ---------- 3. 拦截模式：命中就 deny ----------
{
  const handlers = {};
  const ctx = { on: (ev, fn) => { handlers[ev] = fn; } };
  apply(ctx, { mode: 'enforce', logFile });
  const next = async () => ({ kind: 'allow' });
  const agent = { sessionId: 's-2' };
  const call = (name, args) => handlers['tools/pre-execute']({ name, arguments: args, agent }, next);

  const bigRead = await call('read', { file_path: big });
  ok('拦截模式：整读大文件 ⇒ deny', bigRead && bigRead.kind === 'deny', bigRead && bigRead.kind);
  ok('deny 带原因', bigRead && typeof bigRead.reason === 'string' && bigRead.reason.length > 20);

  // 同一小文件读三次：前两次 allow，第三次 deny
  const a = await call('read', { file_path: small, limit: 20 });
  const b = await call('read', { file_path: small, limit: 20 });
  const c = await call('read', { file_path: small, limit: 20 });
  ok('前两次放行', a.kind === 'allow' && b.kind === 'allow', [a.kind, b.kind]);
  ok('第三次 deny', c.kind === 'deny', c.kind);

  const p1 = await call('pwsh', { command: 'npm run build' });
  const p2 = await call('pwsh', { command: 'npm run build' });
  ok('同命令第 1 次放行', p1.kind === 'allow', p1.kind);
  ok('同命令第 2 次 deny', p2.kind === 'deny', p2.kind);

  // 不同 agent 不共享历史
  const d = await handlers['tools/pre-execute']({ name: 'read', arguments: { file_path: small, limit: 20 }, agent: { sessionId: 's-3' } }, next);
  ok('换会话后历史清零', d.kind === 'allow', d.kind);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

if (fails.length) {
  console.log('✗ 守卫自检失败 ' + fails.length + ' 条（通过 ' + pass + '）：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 守卫自检通过 ' + pass + ' 条');
