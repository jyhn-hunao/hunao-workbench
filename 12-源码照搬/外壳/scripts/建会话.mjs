#!/usr/bin/env node
// 建会话.mjs —— 不开 GUI、不用点侧边栏，直接経引擎 RPC 建一条会话（给新场景的 AI 面板用）
//
// 为什么需要它：新场景的 AI 面板要写 `sessionId`（身份校验）/`sessionTitle`（逐字一致的标题），
//   而"在 GUI 里手建再抄 id"既慢又容易抄错。引擎有 `session/create` + `session/rename` 两个 RPC，
//   这里照 `sessions.mjs` 的实测配方调（token 从 server.log 取 → 换签名 cookie → POST /api/<method>）。
//
// ⚠ 两条实测铁律（抄自 sessions.mjs，别改）：
//   ① **必须传 workspaceId**：侧边栏按 workspace 分组，只传 cwd 建出来的会话会掉进「未分组」（2026-09-21 实测）；
//   ② **默认不写开场消息**（2026-11-17）：交接由「记忆回响」插件每轮注入；`--seed` 才走旧的“开场 + 打断”。
//
// 用法：
//   node scripts\建会话.mjs --title "设计杂活" --scene "design" --panel "ds-ai"   # 建完直接绑回场景（推荐）
//   node scripts\建会话.mjs --title "设计杂活"                       # 默认挂 <临时目录> 的工作区
//   node scripts\建会话.mjs --title "设计杂活" --cwd "<资料库>"        # 换工作区
//   node scripts\建会话.mjs --title "设计杂活" --seed --dry           # 空跑，不真建
//   输出最后一行就是 sessionId（--scene/--panel 已自动回写，一般不用抄）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = shellDir;                                        // 外壳
const PROJECT = path.resolve(shellDir, '..');                  // 12-源码照搬
const HARNESS_DIR = process.env.DSH_HARNESS_DIR || path.join(PROJECT, '引擎');
const DSH_HOME = process.env.DSH_HOME || path.join(HARNESS_DIR, '.dsh');
// 端口真源：唯一实现在 工具\环境.mjs（env > 机器配置 > 默认），脚本里不再写字面量（2026-11-13）
// 要用别的端口实例：设 DSH_PORT（或 DSH_GUI_BASE 直接给完整地址），不要改这里的字面量。
import { port } from '../../工具/环境.mjs';
import { engineTokens } from '../../工具/引擎token.mjs';
const BASE = process.env.DSH_GUI_BASE || process.env.DSH_WEB_URL || ('http://127.0.0.1:' + port('dsh'));

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const title = val('--title', '');
const cwd = val('--cwd', process.env.DSH_WORKSPACE || path.join(PROJECT, '工作区'));   // 默认 <本夹>\工作区
const dry = argv.includes('--dry');
const seedIt = argv.includes('--seed');
// 2026-11-21：建完直接把 id 绑回场景（安装版首启要靠它，用户不该手抄 sessionId）
const panelArg = val('--panel', '');
const panelIds = panelArg ? panelArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
const sceneArg = val('--scene', '');

if (!title) { console.error('用法：node 外壳\\scripts\\建会话.mjs --title "会话名" [--cwd "<本夹>\\工作区"] [--seed] [--dry]'); process.exit(2); }
// cwd 不存在就先建：新机器克隆后 `工作区\` 是空的（根 .gitignore 挡着它不进库），
// 不建的话引擎会收到一个不存在的 cwd。只读盘/无权限时不拦，让引擎自己报清楚。
try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) { /* 交给引擎报错 */ }
const say = (s) => console.log(s);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };

// ── 绑定回写（--panel / --scene）：场景 json + 定位卡 + 场景身份索引 ──────────
// 为什么不让用户手抄 id：sessionId 是引擎随机生成的，人抄一遍就多一个抄错的机会。
const SCEN_DIR = path.join(root, 'scenarios');
function harnessPanels() {
  const out = [];
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR).filter((x) => x.endsWith('.json') && x[0] !== '_')) {
    let j = null; try { j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8')); } catch (e) { continue; }
    if (sceneArg && (j.id !== sceneArg && f !== sceneArg + '.json')) continue;
    for (const p of (j.panels || [])) if (p.type === 'harness' || p.sessionId || p.sessionTitle) out.push({ file: f, scene: j, panel: p });
  }
  return panelIds.length ? out.filter((x) => panelIds.includes(x.panel.id)) : out;
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + (fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'), 'utf8');
  fs.renameSync(tmp, file);
}
/** 把新 id 写进场景 json、定位卡里含本面板的那行、身份索引里含本面板的那行。 */
function bindPanel(hit, newId) {
  const notes = [];
  // ① 场景 json
  hit.panel.sessionId = newId;
  hit.panel.sessionTitle = title;
  writeJsonAtomic(path.join(SCEN_DIR, hit.file), hit.scene);
  notes.push('场景 json 已写 ' + hit.file + '（面板 ' + hit.panel.id + '）');
  // ② 定位卡
  const card = path.join(SCEN_DIR, String(hit.scene.id || hit.file.replace(/\.json$/, '')) + '-context.md');
  if (fs.existsSync(card)) {
    const text = fs.readFileSync(card, 'utf8');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    let n = 0;
    const out = text.split(/\r?\n/).map((line) => {
      if (line.indexOf('`' + hit.panel.id + '`') < 0 || line.indexOf('session-') < 0) return line;
      n++; return line.replace(/session-[0-9a-fA-F-]{8,}/g, newId);
    });
    if (n) { fs.writeFileSync(card, out.join(nl), 'utf8'); notes.push('定位卡已回写 ' + n + ' 行'); }
    else notes.push('⚠ 定位卡里没有本面板的会话行（未登记）');
  } else notes.push('⚠ 定位卡不存在：' + path.basename(card));
  // ③ 场景身份索引
  const idx = path.join(SCEN_DIR, '_场景身份索引.md');
  if (fs.existsSync(idx)) {
    const text = fs.readFileSync(idx, 'utf8');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    let n = 0;
    const out = text.split(/\r?\n/).map((line) => {
      if (line.indexOf('`' + hit.panel.id + '`') < 0 || line.indexOf('|') < 0) return line;
      if (!/session-[0-9a-fA-F-]{8,}|`\s*`/.test(line)) return line;
      // 只换「会话 id」这一列（倒数第 3 列），不碰定位卡列
      n++;
      return line.replace(/\|\s*`?session-[0-9a-fA-F-]{8,}`?\s*(?=\|)/, '| `' + newId + '` ');
    });
    if (n) { fs.writeFileSync(idx, out.join(nl), 'utf8'); notes.push('身份索引已回写 ' + n + ' 行'); }
    else notes.push('⚠ 身份索引里没有本面板的会话 id 单元格');
  } else notes.push('⚠ 身份索引不存在');
  return notes;
}

// ── 找 workspace id（侧边栏分组靠它）──
let wsId = '', wsTitle = '';
try {
  const wf = path.join(DSH_HOME, 'storages', 'workspace.json');
  const tbl = (fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {}).tables || {};
  const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  for (const [id, v] of Object.entries(tbl.workspaces || {})) {
    if (norm(v.path) === norm(cwd)) { wsId = id; wsTitle = v.title || ''; break; }
  }
} catch (e) { /* 读不到就退回 cwd */ }
say('工作区：' + (wsId ? '「' + wsTitle + '」 ' + wsId : '⚠ 没找到 ' + cwd + ' 对应的工作区（会落进「未分组」）'));

if (dry) { say('\n--dry：以上只是查了工作区，没有建会话。去掉 --dry 即真做。'); process.exit(0); }

// ── token → 签名 cookie（必须 redirect:'manual'，跟随后反而 401）──
const LOG = process.env.DSH_LOG || path.join(root, 'server.log');
// token 正则跟随 BASE 的端口（原来写死 3080：引擎默认跑 3083 时取不到 token）
const PORT = (() => { try { return new URL(BASE).port || '80'; } catch (e) { return ''; } })();
const toks = engineTokens(LOG, PORT);
let cookie = '';
for (const t of toks.slice(0, 3)) {
  try {
    const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (sc.length) { cookie = sc.map((c) => c.split(';')[0]).join('; '); break; }
  } catch (e) { /* 换下一条 */ }
}
if (!cookie) die('换不到 cookie（引擎没在跑或 token 失效）—— 工作台在跑时重试即可');

const rpc = async (method, a) => {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args: a } }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { }
  return { status: r.status, j, t };
};

// ── 建会话 ──
const c = await rpc('session/create', { request: wsId ? { workspaceId: wsId } : { cwd } });
const newId = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
if (!newId) die('建会话失败：HTTP ' + c.status + ' ' + String(c.t).slice(0, 200));
say('✓ 新会话：' + newId);

const rn = await rpc('session/rename', { request: { sessionId: newId, title } });
if (rn.status !== 200) die('改名失败（HTTP ' + rn.status + '）⇒ 别把 id 写进 json');
say('✓ 已命名为「' + title + '」');

// ── 直接绑回场景（--panel / --scene）：场景 json + 定位卡 + 身份索引 ──
if (panelArg || sceneArg) {
  const hits = harnessPanels();
  if (!hits.length) {
    say('\n⚠ 没找到匹配的 AI 面板（--panel ' + (panelArg || '空') + ' / --scene ' + (sceneArg || '空') + '）⇒ 未回写，下面仍打印手动写法');
  } else if (hits.length > 1 && panelIds.length < 2) {
    say('\n⚠ 匹配到 ' + hits.length + ' 个 AI 面板，不敢替你挑 ⇒ 加 --panel <面板id> 再跑一次：');
    for (const h of hits) say('   · 场景 ' + h.scene.id + ' / 面板 ' + h.panel.id + '（' + h.file + '）');
  } else {
    for (const h of hits) {
      for (const n of bindPanel(h, newId)) say('  ' + (n[0] === '⚠' ? n : '✓ ' + n));
    }
    // 记忆联动：有场景记忆目录就重盖章；不盖也会被 check 自动重盖章，这里主动盖是为了当场一致
    const first = hits[0];
    const sceneName = String(first.scene.name || first.panel.pinTarget && first.panel.pinTarget[0] || '').trim();
    const memDir = path.join(DSH_HOME, '场景记忆', sceneName);
    const memTool = path.join(PROJECT, '工具', '场景记忆.mjs');
    if (sceneName && fs.existsSync(memDir) && fs.existsSync(memTool)) {
      try {
        const { execFileSync } = await import('node:child_process');
        const env = Object.assign({}, process.env, { DSH_HOME: DSH_HOME });
        if (process.env.DSH_MACHINE_FILE) env.DSH_MACHINE_FILE = process.env.DSH_MACHINE_FILE;
        execFileSync(process.execPath, [memTool, 'stamp', '--场景', sceneName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env });
        say('  ✓ 场景记忆身份卡已重盖章（' + sceneName + '）');
      } catch (e) { say('  ⚠ 身份卡重盖章失败（面板已绑好）：' + String((e && e.message) || e).slice(0, 160)); }
    }
  }
}

// ── （仅 --seed）开场消息 + 立刻打断（这轮不许干活；侧边栏要等它被打开过才显示）──
if (seedIt) {
  const seedTxt = '你是「' + title + '」场景的 AI 助手。现在只回一句话「已读」即可 —— '
    + '不要读任何文件、不要调用任何工具、不要开始干活，等用户下一条指令。';
  const pr = await rpc('session/prompt', { request: {
    requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    sessionId: newId, mode: 'queue', content: [{ type: 'text', text: seedTxt }],
  } });
  await new Promise((r) => setTimeout(r, 10000));   // 太早取消 = 这轮没真开始 = 会话仍是空 = 侧边栏看不到
  const cx = await rpc('session/cancel', { request: { sessionId: newId } });
  say((pr.status === 200 ? '✓' : '✗ HTTP ' + pr.status) + ' 开场消息   ' + (cx.status === 200 ? '✓' : '✗ HTTP ' + cx.status) + ' 已打断（这轮不会动任何东西）');
} else say('（默认不写开场消息：交接由「记忆回响」插件每轮注入；侧边栏可能要等它被打开过才显示，--seed 恢复旧行为）');

say('\nsessionId = ' + newId);
say('下一步：把下面两行写进 scenarios\\<场景id>.json 的 AI 面板：');
say('  "sessionTitle": "' + title + '",');
say('  "sessionId": "' + newId + '",');
