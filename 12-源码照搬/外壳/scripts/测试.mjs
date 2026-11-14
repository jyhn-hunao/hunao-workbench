#!/usr/bin/env node
// 外壳静态测试入口（2026-11-13 · S3-10）
//
// 为什么要有：改一版界面只有 check-gui 的"结构在不在"，没有任何东西拦住**回归**——
//   端口又被写死、catch 又开始吞错误、场景 json 少了 sessionTitle、加了场景却忘了登记图标。
// 这个脚本把这些"能被机器判定的规矩"集中成一条命令，全部只读、不联网、不启壳。
//
// 用法：node scripts\测试.mjs            # 人读输出，有 ✗ 时退出码 1
//       node scripts\测试.mjs --json     # 给 CI / 其它脚本消费
//       node scripts\测试.mjs --only ports,ipc
//
// 判定三档：✓ 通过 / ! 值得看一眼（不阻断）/ ✗ 违规（退出码 1）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const req = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.dirname(HERE);            // 12-源码照搬\外壳
const REPO = path.dirname(path.dirname(SHELL)); // 仓库根
const TOOLS = path.join(path.dirname(SHELL), '工具');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

const results = [];
function add(name, level, msg, detail) { results.push({ name, level, msg, detail }); }

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');
const listDir = (dir, filter) => {
  try { return fs.readdirSync(dir).filter(filter).map((n) => path.join(dir, n)); } catch { return []; }
};

// ── 1. 端口单一真源：3083 只许出现在两处（外壳入口默认值 + 工具/环境.mjs 的 DEFAULT_PORTS）────
function checkPorts() {
  const files = [
    ...listDir(SHELL, (n) => n.endsWith('.js')),
    ...listDir(path.join(SHELL, 'renderer'), (n) => n.endsWith('.js')),
    ...listDir(path.join(SHELL, 'scripts'), (n) => n.endsWith('.mjs')),
    ...listDir(TOOLS, (n) => n.endsWith('.mjs')),
  ];
  const hits = [];
  for (const f of files) {
    const base = path.basename(f);
    if (base === '测试.mjs') continue;                                // 本脚本自身要提 3083，不算违规
    read(f).split(/\r?\n/).forEach((line, i) => {
      if (!/3083/.test(line)) return;
      if (/^\s*(\/\/|\*|#)/.test(line.trim())) return;                 // 注释里的说明不算
      // 白名单：外壳入口的默认值 + 环境.mjs 的 DEFAULT_PORTS（真源）
      if (base === 'main.js' && /process\.env\.DSH_PORT\s*\|\|\s*'3083'/.test(line)) return;
      if (base === '环境.mjs' && /dsh:\s*3083/.test(line)) return;
      hits.push(rel(f) + ':' + (i + 1) + '  ' + line.trim().slice(0, 100));
    });
  }
  if (hits.length) add('端口单一真源', 'fail', '有 ' + hits.length + ' 处硬编码 3083（应走 工具\\环境.mjs 的 port()）', hits);
  else add('端口单一真源', 'ok', '3083 只在 main.js 入口默认值与 工具\\环境.mjs 的 DEFAULT_PORTS');
}

// ── 2. 静默 catch 回归：已接日志的三个文件不许再出现"块里只有注释/空"的 catch ──────────
const CATCH_RE = /catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{\s*(?:\/\*[^}]*?\*\/)?\s*\}/g;
// 判断某个下标是否落在字符串字面量里（注入脚本里也会写 catch(e){}，不能误报）
function outsideString(line, idx) {
  let inS = null;
  for (let i = 0; i < idx; i++) {
    const ch = line[i];
    if (inS) { if (ch === '\\') { i++; continue; } if (ch === inS) inS = null; }
    else if (ch === "'" || ch === '"') inS = ch;
  }
  return inS === null;
}
function countSilentCatch(file) {
  const src = read(file);
  let n = 0;
  src.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.includes('`')) return;
    if (line.includes('fs.appendFileSync(LOG_FILE')) return; // log() 自己的兜底：再往里记会递归
    CATCH_RE.lastIndex = 0;
    let m;
    while ((m = CATCH_RE.exec(line))) if (outsideString(line, m.index)) n++;
  });
  return n;
}
function checkCatch() {
  const guarded = ['main.js', 'renderer\\renderers.js', 'renderer\\renderer.js'].map((n) => path.join(SHELL, n));
  const bad = [];
  for (const f of guarded) if (exists(f)) { const n = countSilentCatch(f); if (n) bad.push(rel(f) + ' → ' + n + ' 处静默 catch'); }
  const others = listDir(SHELL, (n) => n.endsWith('.js'))
    .concat(listDir(path.join(SHELL, 'renderer'), (n) => n.endsWith('.js') && n !== 'wb-warn.js'))
    .filter((f) => !guarded.includes(f) && path.basename(f) !== 'main.js' && path.basename(f) !== 'renderers.js' && path.basename(f) !== 'renderer.js')
    .map((f) => ({ file: f, n: countSilentCatch(f) }))
    .filter((o) => o.n > 0)
    .map((o) => rel(o.file) + ' → ' + o.n + ' 处');
  if (bad.length) add('静默兜底', 'fail', '已接日志的文件又出现吞错误', bad);
  else add('静默兜底', 'ok', 'main.js / renderers.js / renderer.js 已 0 处静默 catch（wbWarn / warnOnce 兜底）');
  if (others.length) add('静默兜底（其余文件）', 'warn', '这些文件还有静默 catch（尚未接入日志，属已知存量）', others);
}

// ── 3. IPC 配对：preload 用到的通道，main 必须有实现；反之报"只实现没人用" ──────────────
function channelsOf(src, kind) {
  const re = kind === 'preload'
    ? /ipcRenderer\.(invoke|send|on)\(\s*'([^']+)'/g
    : /ipcMain\.(handle|handleOnce|on)\(\s*'([^']+)'/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src))) out.set(m[2], m[1]);
  return out;
}
function checkIpc() {
  // main 侧的通道实现不只在 main.js：还分散在 require('./xxx') 的模块里（项目切换 / 社交 / 桥接 / 桌宠设置 / scripts\sidebar.js）
  const mainSrc = [read(path.join(SHELL, 'main.js'))];
  for (const m of read(path.join(SHELL, 'main.js')).matchAll(/require\('\.\/([^']+)'\)/g)) {
    const p = path.join(SHELL, m[1].endsWith('.js') ? m[1] : m[1] + '.js');
    if (exists(p)) mainSrc.push(read(p));
  }
  const main = new Map();
  for (const src of mainSrc) for (const [k, v] of channelsOf(src, 'main')) main.set(k, v);
  const pre = channelsOf(read(path.join(SHELL, 'preload.js')), 'preload');
  // preload 里 invoke/send 是"渲染层 → 主进程"，必须在 main 有实现；
  // on 是"主进程 → 渲染层"的广播（webContents.send），不需要主进程 handler，只核对有没有人发。
  const toMain = [...pre.entries()].filter(([, kind]) => kind === 'invoke' || kind === 'send').map(([k]) => k);
  const fromMain = [...pre.entries()].filter(([, kind]) => kind === 'on').map(([k]) => k);
  const missing = toMain.filter((k) => !main.has(k));
  const orphan = [...main.keys()].filter((k) => !pre.has(k));
  if (missing.length) add('IPC 配对', 'fail', 'preload 用了但 main 没实现的通道 ' + missing.length + ' 个', missing.map((k) => 'preload → ' + k));
  else add('IPC 配对', 'ok', 'preload 的 ' + toMain.length + ' 个上行通道都有 main 侧实现（含 ' + (mainSrc.length - 1) + ' 个本地模块）');
  if (orphan.length) add('IPC 配对（反向）', 'warn', 'main 实现但 preload 没暴露的通道 ' + orphan.length + ' 个（可能是内部或 webview 用）', orphan.slice(0, 12));
  if (fromMain.length) add('IPC 广播通道', 'ok', '主进程 → 渲染层的广播 ' + fromMain.length + ' 个（' + fromMain.slice(0, 6).join(', ') + '…）');
}

// ── 4. 场景 JSON 契约：id / name 唯一；面板 type 必填；AI 面板 sessionId 与 sessionTitle 成对 ──
function checkScenarios() {
  const files = listDir(path.join(SHELL, 'scenarios'), (n) => n.endsWith('.json'));
  const ids = new Map(); const names = new Map(); const bad = [];
  const types = new Set();
  for (const f of files) {
    let json;
    try { json = JSON.parse(read(f)); } catch (e) { bad.push(rel(f) + ' → JSON 解析失败：' + e.message); continue; }
    const where = path.basename(f);
    if (!json.id) bad.push(where + ' → 缺 id');
    if (!json.name) bad.push(where + ' → 缺 name');
    if (json.id) { if (ids.has(json.id)) bad.push(where + ' → id 重复：' + json.id); ids.set(json.id, where); }
    if (json.name) { if (names.has(json.name)) bad.push(where + ' → name 重复：' + json.name); names.set(json.name, where); }
    const panels = Array.isArray(json.panels) ? json.panels : [];
    if (!panels.length) bad.push(where + ' → panels 为空');
    for (const p of panels) {
      const tag = where + ' · 面板 ' + (p.id || '(无 id)');
      if (!p.type) bad.push(tag + ' → 缺 type');
      else types.add(p.type);
      if (!p.id) bad.push(tag + ' → 缺 id');
      if (!p.title) bad.push(tag + ' → 缺 title');
      if ((p.sessionId && !p.sessionTitle) || (!p.sessionId && p.sessionTitle)) bad.push(tag + ' → sessionId / sessionTitle 必须成对');
    }
  }
  if (bad.length) add('场景 JSON 契约', 'fail', '违规 ' + bad.length + ' 条', bad);
  else add('场景 JSON 契约', 'ok', files.length + ' 个场景 · id/name 唯一 · 面板字段齐全 · AI 面板 id 成对');
  return { types, scenarioCount: files.length };
}

// ── 5. 渲染器注册：场景 json 里用到的 type，renderers.js 必须有实现 ───────────────────────
function checkRenderers(used) {
  const src = read(path.join(SHELL, 'renderer', 'renderers.js'));
  const re = /renderers(?:\[['"]([^'"]+)['"]\]|\.([A-Za-z_$][\w$]*))\s*=\s*(?:function|\()/g;
  const reg = new Set();
  let m;
  while ((m = re.exec(src))) reg.add(m[1] || m[2]);
  const miss = [...used].filter((t) => !reg.has(t));
  // 2026-11-14：反向也看一眼 —— 注册了却没有任何场景引用的 type，是「代码在、用户点不到」的死面板
  //   （控制台收到 2 块之后 feature-find/recent/triage 就是这么变成未用的，靠人肉发现，没有告警）
  const unused = [...reg].filter((t) => !used.has(t));
  if (miss.length) add('渲染器注册', 'fail', '场景用到但没注册的 type：' + miss.join(', '), []);
  else add('渲染器注册', 'ok', '场景用到的 ' + used.size + ' 个 type 都已注册（总注册 ' + reg.size + ' 个）');
  if (unused.length) add('渲染器注册（反向）', 'warn', '注册但无任何场景引用 ' + unused.length + ' 个（删或挂，属产品口径）', unused.slice(0, 24));
}

// ── 6. 图标：登记表的值不重复、pet≠social、图标文件都在、兜底池够用 ──────────────────────
function checkIcons() {
  const src = read(path.join(SHELL, 'renderer', 'scene-icons.js'));
  const mapBlock = src.match(/var MAP = \{[\s\S]*?\}/);
  const poolBlock = src.match(/var POOL = \[[\s\S]*?\]/);
  if (!mapBlock || !poolBlock) { add('场景图标', 'fail', 'scene-icons.js 结构变了（找不到 MAP / POOL）', []); return; }
  const map = {};
  mapBlock[0].replace(/'([^']+)'\s*:\s*'([^']+)'/g, (_, id, name) => { map[id] = name; });
  const pool = (poolBlock[0].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  const bad = [];
  const all = { ...map };
  const seen = new Map();
  for (const [id, name] of Object.entries(map)) {
    if (seen.has(name)) bad.push('登记表撞图：' + id + ' 与 ' + seen.get(name) + ' 都用 ' + name);
    seen.set(name, id);
    if (!exists(path.join(SHELL, 'renderer', 'assets', 'icons', name + '.svg'))) bad.push(id + ' → 图标文件缺：assets/icons/' + name + '.svg');
  }
  if (map.pet && map.social && map.pet === map.social) bad.push('「胡闹的大肥鱼」与「社交」又撞同一枚图标了');
  for (const name of pool) {
    if (all[name]) continue;
    if (!exists(path.join(SHELL, 'renderer', 'assets', 'icons', name + '.svg'))) bad.push('兜底池图标文件缺：' + name + '.svg');
  }
  const scenarioDir = path.join(SHELL, 'scenarios');
  const ids = (listDir(scenarioDir, (n) => n.endsWith('.json')) || []).map((f) => { try { return JSON.parse(read(f)).id; } catch { return null; } }).filter(Boolean);
  const unregistered = ids.filter((id) => !map[id]);
  if (unregistered.length > pool.length) bad.push('未登记场景 ' + unregistered.length + ' 个 > 兜底池 ' + pool.length + ' 个，必然撞图');
  if (bad.length) add('场景图标', 'fail', '违规 ' + bad.length + ' 条', bad);
  else add('场景图标', 'ok', '登记 ' + Object.keys(map).length + ' 个 · 兜底池 ' + pool.length + ' 个 · 未登记场景 ' + unregistered.length + ' 个（各领一枚不重复的）');
}

// ── 7. 语法：外壳与脚本一遍 node --check（拦"改了忘跑就重启"的低级崩）──────────────────
function checkSyntax() {
  const groups = [
    ...listDir(SHELL, (n) => n.endsWith('.js')),
    ...listDir(path.join(SHELL, 'renderer'), (n) => n.endsWith('.js')),
    ...listDir(path.join(SHELL, 'scripts'), (n) => n.endsWith('.mjs')),
    ...listDir(TOOLS, (n) => n.endsWith('.mjs')),
  ].filter((f) => !/node_modules/.test(f));
  const bad = [];
  for (const f of groups) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(rel(f) + ' → ' + (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0]);
  }
  if (bad.length) add('语法', 'fail', bad.length + ' 个文件语法不过', bad.slice(0, 20));
  else add('语法', 'ok', groups.length + ' 个文件 node --check 全过');
}

// ── 8. 元数据对齐：package.json 描述里的场景数与 scenarios\*.json 数量一致 ──────────────
function checkMeta(count) {
  const pkg = JSON.parse(read(path.join(SHELL, 'package.json')));
  const num = (pkg.description || '').match(/(\d+)\s*个场景|(\d+)\s*场景/);
  if (!num) add('元数据对齐', 'warn', 'package.json description 没写场景数，无法核对', []);
  else if (Number(num[1] || num[2]) !== count) add('元数据对齐', 'fail', 'description 写 ' + (num[1] || num[2]) + ' 个场景，实际 ' + count + ' 个', []);
  else add('元数据对齐', 'ok', 'package.json description 的场景数与 scenarios/ 一致（' + count + ' 个）');
}

// ── 9. 功能台登记表：每项都得有说明 / 动作 / 白名单脚本；症状表不许指向空卡 ──────────────
//    为什么：功能台是「点错就改真实文件」的地方，登记项写歪了界面不会报，只会静默少一张卡。
function checkFeatureDesk() {
  let desk;
  try { desk = req(path.join(SHELL, '功能台.js')); } catch (e) { add('功能台登记表', 'fail', '功能台.js 加载失败：' + e.message, []); return; }
  let o;
  try { o = desk.list(); } catch (e) { add('功能台登记表', 'fail', 'list() 抛错：' + e.message, []); return; }
  const bad = [];
  const groups = new Set(o.groups.map((g) => g.id));
  const ids = new Set();
  o.groups.forEach((g) => g.features.forEach((f) => {
    if (ids.has(f.id)) bad.push('功能 id 重复：' + f.id);
    ids.add(f.id);
    if (!groups.has(f.group)) bad.push(f.id + ' 的 group 不在 GROUPS：' + f.group);
    if (!f.name) bad.push(f.id + ' 缺 name');
    if (!f.plain || !String(f.plain).trim() || String(f.plain).trim().length < 8) bad.push(f.id + ' 的 plain 太短（一句话得说清这是什么）');
    if (!(f.actions || []).length) bad.push(f.id + ' 一个动作都没有');
    if (!(/^工具\\/.test(f.script) || /^外壳\\scripts\\/.test(f.script))) bad.push(f.id + ' 的脚本不在白名单目录（工具\\ 或 外壳\\scripts\\）：' + f.script);
    if (!f.ok) bad.push(f.id + ' 的脚本不存在：' + f.script);
    const acts = new Set();
    (f.actions || []).forEach((a) => {
      if (acts.has(a.id)) bad.push(f.id + ' 动作 id 重复：' + a.id);
      acts.add(a.id);
      if (!a.label || !String(a.label).trim()) bad.push(f.id + '.' + a.id + ' 缺按钮名');
      if (a.danger !== 'read' && a.danger !== 'write' && a.danger !== 'destructive') bad.push(f.id + '.' + a.id + ' 的 danger 值非法：' + a.danger);
      (a.inputs || []).forEach((s) => {
        if (!s.key || !s.label) bad.push(f.id + '.' + a.id + ' 的输入项缺 key / label');
        if (['text', 'number', 'select', 'scene', 'memscene', 'file', 'dir'].indexOf(s.kind) < 0) bad.push(f.id + '.' + a.id + '.' + s.key + ' 的 kind 不认识：' + s.kind);
      });
    });
    (f.next || []).forEach((n) => {
      if (!n.ok) bad.push(f.id + ' 的「接着做」指向不存在的功能：' + n.id);
    });
    if (f.also && String(f.also).trim().length < 6) bad.push(f.id + ' 的 also 说明太短（得说清顶栏哪里也有）');
  }));
  const tri = o.triage || [];
  if (!tri.length) bad.push('症状表是空的（TRIAGE 至少留一条）');
  tri.forEach((t) => {
    if (!ids.has(t.feature)) bad.push('症状表指向不存在的功能：' + t.feature);
    else if (!t.ok) bad.push('症状表指向的脚本不在：' + t.feature);
  });
  if (bad.length) add('功能台登记表', 'fail', '违规 ' + bad.length + ' 条', bad);
  else add('功能台登记表', 'ok', (o.stats.features || 0) + ' 项 / ' + (o.stats.actions || 0) + ' 个动作 · 说明齐全 · 脚本都在白名单目录 · 症状表 ' + tri.length + ' 条都能落到卡上');
}

// ── 跑 ───────────────────────────────────────────────────────────────────────────────
const want = (k) => !ONLY || ONLY.includes(k);
let types = new Set();
let count = 0;
try {
  if (want('ports')) checkPorts();
  if (want('catch')) checkCatch();
  if (want('ipc')) checkIpc();
  const sc = checkScenarios();
  types = sc.types; count = sc.scenarioCount;
  if (want('renderers')) checkRenderers(types);
  if (want('icons')) checkIcons();
  if (want('syntax')) checkSyntax();
  if (want('meta')) checkMeta(count);
  if (want('features')) checkFeatureDesk();
} catch (e) {
  add('脚本自身', 'fail', '测试脚本异常：' + e.message, [String(e.stack || '').split('\n')[1] || '']);
}

const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: fails.length === 0, fails: fails.length, warns: warns.length, results }, null, 2));
} else {
  console.log('外壳静态测试 · ' + new Date().toLocaleString('zh-CN'));
  for (const r of results) {
    const mark = r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✗';
    console.log(mark + ' ' + r.name + '：' + r.msg);
    if (r.detail && r.detail.length) for (const d of r.detail.slice(0, 15)) console.log('    - ' + d);
  }
  console.log('---');
  console.log(fails.length ? '✗ ' + fails.length + ' 项违规（退出码 1）' : '✓ 全部通过（warning ' + warns.length + '）');
}
process.exit(fails.length ? 1 : 0);
