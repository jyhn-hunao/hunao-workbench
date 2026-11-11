#!/usr/bin/env node
// 用量自检.mjs —— 验「外壳\用量.js」的算法 + 「外壳\renderer\用量面板.js」能跑到末尾。
//
// 为什么要它（照「自我复盘」§五 第 56 条）：
//   `node --check` 只证明语法；这里用**假 DOM + 假投影缓存**证明它真能算、真能挂上，
//   不用开 Electron、不看窗口也能跑。
//
// 用法：node 外壳\scripts\用量自检.mjs
//   全绿 exit 0；任何一条失败 exit 1（失败行会打 ✗ 和期望/实际）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));     // 外壳\scripts
const SHELL = path.resolve(HERE, '..');                        // 外壳
const require = createRequire(import.meta.url);
const usage = require(path.join(SHELL, '用量.js'));

let pass = 0;
const fails = [];
function ok(name, cond, got) {
  if (cond) { pass++; return; }
  fails.push(name + (got === undefined ? '' : '  ← 实际：' + JSON.stringify(got)));
}
function eq(name, a, b) { ok(name + '（期望 ' + JSON.stringify(b) + '）', JSON.stringify(a) === JSON.stringify(b), a); }

// ---------- 1. 造一份假的投影缓存 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
const dshHome = path.join(tmp, '.dsh');
const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
const scenariosDir = path.join(tmp, 'scenarios');
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(scenariosDir, { recursive: true });

// 一条「很贵」的会话：579348 上下文 / 336 步 / 缓存重读 111026944
const heavy = {
  version: 7,
  record: {
    identity: { cwd: 'D:\\demo' },
    rows: {
      title: { val: '记忆能力改造设计定稿' },
      tokenUsage: { val: { totals: { uncachedInputTokens: 253683, outputTokens: 360919, cacheReadTokens: 111026944, cacheWriteTokens: 0 } } },
      contextPressure: { val: { surfaceTokens: 386744, contextWindow: 1048576, pressureTokens: 579348 } },
      contextBreakdown: { val: { surfaceTokens: 386744, breakdown: { systemTokens: 1448, toolsTokens: 7205, messageTokens: 385296 } } },
      sessionStats: { val: { turns: 17, steps: 336 } }
    }
  }
};
// 一条「还轻」的会话：4 万上下文 / 18 步
const light = {
  version: 7,
  record: {
    identity: { cwd: 'D:\\demo' },
    rows: {
      title: { val: '自我复盘' },
      tokenUsage: { val: { totals: { uncachedInputTokens: 22157, outputTokens: 10323, cacheReadTokens: 379008 } } },
      contextPressure: { val: { contextWindow: 1048576, pressureTokens: 42129 } },
      contextBreakdown: { val: { surfaceTokens: 42129, breakdown: { messageTokens: 41000 } } },
      sessionStats: { val: { turns: 5, steps: 18 } }
    }
  }
};
fs.writeFileSync(path.join(cacheDir, 'session-heavy.json'), JSON.stringify(heavy), 'utf8');
fs.writeFileSync(path.join(cacheDir, 'session-light.json'), JSON.stringify(light), 'utf8');

// 两个场景：一个钉了会话，一个钉了没数据的会话
const sceneA = {
  id: 'code-dev', name: '程序开发',
  panels: [
    { id: 'cd-ai', type: 'harness', title: 'AI', sessionId: 'session-heavy', sessionTitle: '记忆能力改造设计定稿' },
    { id: 'cd-git', type: 'git' }
  ]
};
const sceneB = {
  id: 'self-review', name: '自我复盘',
  panels: [
    { id: 'sr-ai', type: 'harness', title: 'AI', sessionId: 'session-light', sessionTitle: '自我复盘' },
    { id: 'sr-ai2', type: 'harness', title: 'AI2', sessionId: 'session-missing', sessionTitle: '还没跑过' }
  ]
};
fs.writeFileSync(path.join(scenariosDir, 'code-dev.json'), JSON.stringify(sceneA), 'utf8');
fs.writeFileSync(path.join(scenariosDir, 'self-review.json'), JSON.stringify(sceneB), 'utf8');
fs.writeFileSync(path.join(scenariosDir, '_场景身份索引.md'), '# 索引不是场景', 'utf8');

const fsx = {
  readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
  readDir: (p) => { try { return fs.readdirSync(p); } catch (e) { return []; } },
  exists: (p) => { try { return fs.existsSync(p); } catch (e) { return false; } }
};

// ---------- 2. 算得对不对 ----------
const s = usage.summarize(usage.readRecord(fsx, dshHome, 'session-heavy'));
eq('hasData', s.hasData, true);
eq('steps', s.steps, 336);
eq('ctx', s.ctx, 579348);
eq('pct（579348/1048576）', s.pct, 55.3);
eq('每步重发 = (111026944+253683)/336', s.perStep, Math.round((111026944 + 253683) / 336));
eq('重放率', s.replayPct, Math.round(111026944 / (111026944 + 253683 + 360919) * 1000) / 10);
eq('消息面占比', s.msgShare, 100);

const sLight = usage.summarize(usage.readRecord(fsx, dshHome, 'session-light'));
eq('轻会话也该有数', sLight.hasData, true);
eq('轻会话 pct', sLight.pct, 4);

const sNone = usage.summarize(usage.readRecord(fsx, dshHome, 'session-missing'));
eq('没缓存 ⇒ hasData=false（不编 0 数据）', sNone.hasData, false);

// ---------- 3. 分档边界 ----------
eq('20% / 50 步 ⇒ ok', usage.levelOf({ hasData: true, pct: 20, steps: 50 }), 'ok');
eq('28% ⇒ warn', usage.levelOf({ hasData: true, pct: 28, steps: 10 }), 'warn');
eq('45% ⇒ over', usage.levelOf({ hasData: true, pct: 45, steps: 10 }), 'over');
eq('步数 100 ⇒ warn', usage.levelOf({ hasData: true, pct: 1, steps: 100 }), 'warn');
eq('步数 220 ⇒ over', usage.levelOf({ hasData: true, pct: 1, steps: 220 }), 'over');
eq('没数据 ⇒ 不判档', usage.levelOf({ hasData: false, pct: 99, steps: 999 }), 'ok');
eq('阈值可覆盖', usage.levelOf({ hasData: true, pct: 10, steps: 10 }, { warnPct: 5 }), 'warn');

// ---------- 4. 汇总（IPC 里返回的那一份） ----------
const res = usage.listUsages(fsx, { dshHome, scenariosDir });
eq('场景数：只算 harness 面板', res.rows.length, 3);
eq('最该换的排第一', res.rows[0].sessionId, 'session-heavy');
eq('它被判 over', res.rows[0].level, 'over');
eq('over 计数', res.over, 1);
eq('没数据的那条计 noData', res.noData, 1);
ok('没数据的行不显示百分比', res.rows.filter((r) => !r.hasData).every((r) => r.pct === 0 || r.pct === 0));
ok('建议文案带「每步要重发」', /每步要重发/.test(res.rows[0].advice), res.rows[0].advice);
ok('交接指令带步数', /336 步/.test(usage.handoffPrompt(res.rows[0])), usage.handoffPrompt(res.rows[0]));
eq('万位换算', [usage.wan(9000), usage.wan(250000)], ['9000', '25 万']);

// ---------- 5. 空场景目录也不炸 ----------
const empty = usage.listUsages(fsx, { dshHome, scenariosDir: path.join(tmp, 'nope') });
eq('空目录 ⇒ 0 行', empty.rows.length, 0);
eq('空目录 ⇒ worst 为 null', empty.worst, null);

// ---------- 6. 渲染层：假 DOM 跑到末尾 ----------
// 只证明「能执行完并挂上全局」，不证明画得好看（视觉层要靠整页重载复验）。
function stubNode() {
  const n = {
    style: {}, classList: { add() {}, remove() {} }, children: [], parentNode: null,
    textContent: '', className: '', id: '', title: '', type: '',
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, focus() {}, select() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    contains() { return false; },
    querySelector() { return null; }
  };
  return n;
}
const sandbox = {
  console,
  setTimeout: (fn) => { try { fn(); } catch (e) { throw e; } return 1; },
  setInterval: () => 1,
  clearInterval: () => {},
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  Promise
};
sandbox.window = sandbox;
sandbox.document = {
  readyState: 'complete',
  createElement: stubNode,
  createTextNode: () => stubNode(),
  querySelector: () => null,
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  execCommand: () => true,
  body: stubNode()
};
sandbox.globalThis = sandbox;
const panelPath = path.join(SHELL, 'renderer', '用量面板.js');
const code = fs.readFileSync(panelPath, 'utf8');
let panelErr = null;
try {
  vm.runInNewContext(code, sandbox, { filename: panelPath, timeout: 5000 });
} catch (e) {
  panelErr = e;
}
ok('用量面板.js 能跑到末尾（假 DOM）', panelErr === null, panelErr && String(panelErr.stack || panelErr).split('\n').slice(0, 3));
eq('挂上了 __dshUsagePanel', sandbox.window.__dshUsagePanel, true);
ok('暴露了 USAGE_PANEL.refresh', sandbox.window.USAGE_PANEL && typeof sandbox.window.USAGE_PANEL.refresh === 'function');

// ---------- 7. 收尾 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

if (fails.length) {
  console.log('✗ 用量自检失败 ' + fails.length + ' 条（通过 ' + pass + ' 条）：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 用量自检通过 ' + pass + ' 条');
