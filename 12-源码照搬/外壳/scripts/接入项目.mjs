#!/usr/bin/env node
// 接入项目.mjs —— 把一个新项目接进「程序开发」场景（技能 project-onboarding 的第 1–3 步）
//
// 为什么需要它：接一个项目要动四处（工作区登记 / 建会话 / 改名 / 回写面板 sessionId），
//   手工做每处都能漏，漏了还不报错（面板只是"钉不到会话"）。这里一次做完并打印验收方法。
//
// 用法：
//   node 外壳\scripts\接入项目.mjs --root "D:\codeData\myself\新项目"
//   node 外壳\scripts\接入项目.mjs --root "D:\..." --name "显示名" --scene code-dev
//   node 外壳\scripts\接入项目.mjs --root "D:\..." --no-bind     只建会话，不写面板
//   node 外壳\scripts\接入项目.mjs --root "D:\..." --dry         只查不改
//   node 外壳\scripts\接入项目.mjs --root "D:\..." --memory-only 只补项目记忆与登记（给已接入的项目补业务记忆）
//
// 做了四件事：
//   1) 查 引擎数据\.dsh\storages\workspace.json：该项目的工作区没有就调 workspace/create 建一个；
//   2) session/create 挂到该工作区 → session/rename 成项目名（侧栏分组与标题都因此对得上）；
//   3) 把 sessionId / sessionTitle / pinTarget 写进 scenarios\<scene>.json 的 AI 面板；
//   4) 建 项目记忆\<项目>.md 骨架（状态区 + 业务区）并把 项目.json 的 memory 指过去——
//      业务记忆按项目隔离，场景私有记忆只放跨项目规矩。
//   项目规范（0–8 步）不替你做，脚本最后打印步骤。
//
// 前置：工作台在跑（3083），且 shell 的 server.log 里有带 token 的地址（启动.vbs 会写）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // 外壳\scripts
const SHELL = path.resolve(HERE, '..');                          // 外壳
const PROJECT = path.resolve(SHELL, '..');                       // 12-源码照搬
const DSH_HOME = process.env.DSH_HOME || path.join(PROJECT, '引擎数据', '.dsh');
// 端口真源：唯一实现在 工具\环境.mjs（env > 机器配置 > 默认），脚本里不再写字面量（2026-11-13）
import { port } from '../../工具/环境.mjs';
const BASE = process.env.DSH_GUI_BASE || process.env.DSH_WEB_URL || ('http://127.0.0.1:' + port('dsh'));
const PORT = (() => { try { return new URL(BASE).port || '80'; } catch (e) { return ''; } })();
const LOG = process.env.DSH_LOG || path.join(SHELL, 'server.log');

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const rootArg = val('--root', '');
const scene = val('--scene', 'code-dev');
const dry = has('--dry');
const bind = !has('--no-bind');
const memoryOnly = has('--memory-only');
if (!rootArg) {
  console.error('用法：node 外壳\\scripts\\接入项目.mjs --root "<项目根目录>" [--name 名字] [--scene code-dev] [--no-bind] [--dry]');
  process.exit(2);
}

const root = path.resolve(rootArg);
const name = val('--name', path.basename(root));
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

if (!fs.existsSync(root)) { console.error('✗ 目录不存在：' + root); process.exit(1); }

const say = (s) => console.log(s);
const WS_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');
const SCEN_FILE = path.join(SHELL, 'scenarios', scene + '.json');

// ── 项目记忆（业务记忆隔离）：一项目一份 + 登记到 项目.json 的 memory ──
//   为什么：不同项目领域不同，业务知识（术语 / 数据来源 / 契约）只该被该项目读到；
//   场景私有记忆是共享区，只放跨项目规矩。
const SCENE_DIR = { 'code-dev': '程序开发' }[scene] || scene;
const MEMROOT = path.join(DSH_HOME, '场景记忆');
const PM_DIR = path.join(MEMROOT, SCENE_DIR, '项目记忆');
const PJ_FILE = path.join(MEMROOT, '_共享记忆', '项目.json');

function ensureProjectMemory() {
  fs.mkdirSync(PM_DIR, { recursive: true });
  const file = path.join(PM_DIR, name + '.md');
  if (fs.existsSync(file)) {
    say('• 项目记忆已存在，保持不动：' + path.relative(PROJECT, file));
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const body = [
      '# ' + name + ' · 项目记忆',
      '',
      '> 项目根：`' + root + '`｜场景：' + SCENE_DIR + '（' + scene + '）｜建单：' + today,
      '> **业务记忆只住这里**：术语 / 数据来源 / 契约 / 领域规则都写本文件；跨项目规矩去 场景私有记忆。',
      '',
      '## 状态区',
      '',
      '- **状态**：进行中',
      '- **一句话**：（待补：这个项目是什么、做到哪了）',
      '- **成果/证据**：（待补：产物路径、版本、验收结论）',
      '- **下一步**：（待补）',
      '- **已有档案**：（待补：README / 设计文档路径）',
      '',
      '## 一、领域与术语',
      '',
      '- 业务域：（待补）',
      '- 专有名词与口径：（待补）',
      '- 边界：不负责什么（待补）',
      '',
      '## 二、数据来源与业务规则',
      '',
      '- 数据从哪来：（待补：表 / 接口 / 文件）',
      '- 谁维护：（待补）',
      '- 脏字段与例外：（待补）',
      '',
      '## 三、接口与契约',
      '',
      '- （待补：对外接口、字段含义、跨端约定、版本）',
      '',
      '## 四、决策与坑（只追加）',
      '',
      '- ' + today + '：（待补）',
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(file, body, 'utf8');
    say('✓ 项目记忆骨架：' + path.relative(PROJECT, file));
  }
  try {
    const reg = fs.existsSync(PJ_FILE) ? JSON.parse(fs.readFileSync(PJ_FILE, 'utf8')) : { projects: [] };
    reg.projects = Array.isArray(reg.projects) ? reg.projects : [];
    let it = reg.projects.find((p) => p && ((p.paths || []).some((x) => norm(x) === norm(root)) || p.name === name));
    if (!it) { it = { name, paths: [root], owner: SCENE_DIR, status: 'active', aliases: [] }; reg.projects.push(it); }
    it.memory = file;
    fs.writeFileSync(PJ_FILE, JSON.stringify(reg, null, 1) + '\n', 'utf8');
    say('✓ 项目.json：' + name + ' 的 memory 指向该文件');
  } catch (e) { say('⚠ 项目.json 未更新：' + e.message); }
}

if (memoryOnly) {
  say('项目根：' + root);
  say('项目名：' + name);
  ensureProjectMemory();
  say('\n--memory-only：只建/补项目记忆与登记，没有动工作区与会话。');
  process.exit(0);
}

// ── 1) 工作区：先查登记表，没有再走 RPC ──
function findWorkspace() {
  try {
    const tbl = (JSON.parse(fs.readFileSync(WS_FILE, 'utf8')).tables || {}).workspaces || {};
    for (const [id, v] of Object.entries(tbl)) {
      if (norm(v.path) === norm(root)) return { id, title: v.title || '' };
    }
  } catch (e) { /* 读不到就当没有 */ }
  return null;
}

// ── token → 签名 cookie（必须 redirect:'manual'）──
async function connect() {
  const toks = fs.existsSync(LOG)
    ? [...fs.readFileSync(LOG, 'utf8').matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]{16,})/g)]
        .filter((m) => !PORT || m[1] === PORT).map((m) => m[2]).reverse()
    : [];
  for (const t of toks.slice(0, 3)) {
    try {
      const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) return sc.map((c) => c.split(';')[0]).join('; ');
    } catch (e) { /* 换下一条 */ }
  }
  return '';
}

let cookie = '';
const rpc = async (method, args) => {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* 原样返回 */ }
  return { status: r.status, j, t };
};

const ws = findWorkspace();
say('项目根：' + root);
say('项目名：' + name);
say('工作区：' + (ws ? '已登记「' + ws.title + '」 ' + ws.id : '未登记，将新建'));

if (dry) { say('\n--dry：以上只是检查，没有建任何东西。去掉 --dry 即真做。'); process.exit(0); }

cookie = await connect();
if (!cookie) { console.error('✗ 换不到 cookie（工作台没在跑？token 过期？先启动 启动.vbs 再重试）'); process.exit(1); }

// ── 2) 建工作区（若需要）──
let wsId = ws ? ws.id : '';
if (!wsId) {
  const r = await rpc('workspace/create', { request: { path: root } });
  wsId = (r.j && r.j.result && r.j.result.value && r.j.result.value.workspace && r.j.result.value.workspace.workspaceId) || '';
  if (!wsId) { console.error('✗ 建工作区失败：HTTP ' + r.status + ' ' + String(r.t).slice(0, 200)); process.exit(1); }
  say('✓ 工作区已建：' + wsId);
}

// ── 3) 建会话 + 改名 ──
const c = await rpc('session/create', { request: { workspaceId: wsId } });
const sessionId = (c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId) || '';
if (!sessionId) { console.error('✗ 建会话失败：HTTP ' + c.status + ' ' + String(c.t).slice(0, 200)); process.exit(1); }
say('✓ 新会话：' + sessionId);

const rn = await rpc('session/rename', { request: { sessionId, title: name } });
if (rn.status !== 200) { console.error('✗ 改名失败（HTTP ' + rn.status + '）⇒ 别把 id 写进 json'); process.exit(1); }
say('✓ 已命名为「' + name + '」');

// ── 4) 回写面板 ──
if (!bind) {
  say('\n（--no-bind：没有写场景 json。要手动绑就把下面写进 ' + path.relative(PROJECT, SCEN_FILE) + ' 的 AI 面板）');
  say('  "sessionTitle": "' + name + '",');
  say('  "sessionId": "' + sessionId + '",');
  say('  "pinTarget": ["' + name + '"]');
} else if (!fs.existsSync(SCEN_FILE)) {
  console.error('✗ 场景文件不存在：' + SCEN_FILE);
  process.exit(1);
} else {
  let t = fs.readFileSync(SCEN_FILE, 'utf8');
  const before = t;
  const pt = '["' + name + '", "程序开发"]';
  t = t.replace(/"sessionTitle":\s*"[^"]*"/, '"sessionTitle": "' + name + '"');
  t = t.replace(/"sessionId":\s*"[^"]*"/, '"sessionId": "' + sessionId + '"');
  t = t.replace(/"pinTarget":\s*\[[^\]]*\]/, '"pinTarget": ' + pt);
  if (t === before) { console.error('✗ 回写没命中：' + path.basename(SCEN_FILE) + ' 里没有 sessionTitle/sessionId/pinTarget 字段'); process.exit(1); }
  fs.writeFileSync(SCEN_FILE, t, 'utf8');
  say('✓ 已回写 ' + path.basename(SCEN_FILE) + ' 的 AI 面板（sessionTitle / sessionId / pinTarget）');
}

// ── 5) 项目记忆（业务记忆隔离）+ 交回给人/AI 的一步 ──
ensureProjectMemory();

say('\n接下来（脚本不替你做，需要判断）：');
say('  ① 项目规范：按 ~/.dsh/standards 的「迁移到具体项目 0–8 步」生成');
say('     <项目>\\AGENTS.md + doc\\提交准则.md + doc\\迁移报告.md（写「规范基线 <commit>」）');
say('  ② 填项目记忆的业务区（领域与术语 / 数据来源与业务规则 / 接口与契约）——这三节是隔离的关键');
say('  ③ 验收：node 外壳\\scripts\\sessions.mjs --check  与  node 工具\\场景记忆.mjs check --场景 程序开发');
say('\nsessionId = ' + sessionId);
