#!/usr/bin/env node
// 首启绑定.mjs —— 安装版第一次启动后，把没有会话的 AI 面板自动建会话并绑好
// @功能台 {"name":"首启绑定","group":"场景维护","freq":"按需","plain":"给没有会话的 AI 面板建会话并回写场景绑定","why":"安装版首次启动 / 升级后会话会丢，面板会空白","label":"首启绑定"}
//
// 为什么需要它：sessionId 是引擎随机生成的，装完不可能让用户手抄；场景 json 里的 id 又属于
//   「本机运行时数据」，安装包升级会覆盖 app 目录 ⇒ 每次升级都可能需要重新绑一次。
// 做法：扫 scenarios 里 type=harness 的面板，按「会话文件是否真存在」判定缺失；
//   同一条旧 id / 同一个 sessionTitle 的面板归成一组（共用会话的，如 so-msg 与 pet-ai），
//   一组只建一条，再让 建会话.mjs --panel a,b 一次写回多个面板。
//
// 用法：
//   node 工具\首启绑定.mjs            # 只列缺哪些，不动
//   node 工具\首启绑定.mjs --go       # 真建（引擎必须已在跑；由壳在引擎就绪后自动调）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH = path.resolve(here, '..');
// 源码版壳在 <根>\外壳；安装版壳在 resources\app，工具在 resources\工具（同级没有「外壳」）
const SHELL = process.env.DSH_SHELL_DIR
  || (fs.existsSync(path.join(WORKBENCH, '外壳')) ? path.join(WORKBENCH, '外壳') : path.join(WORKBENCH, 'app'));
const SCEN = path.join(SHELL, 'scenarios');
const DSH_HOME = process.env.DSH_HOME || path.join(WORKBENCH, '引擎数据', '.dsh');
const CREATOR = path.join(SHELL, 'scripts', '建会话.mjs');
const argv = process.argv.slice(2);
const go = argv.includes('--go');
const say = (s) => console.log(s);

function sessionExists(id) {
  if (!id) return false;
  const base = path.join(DSH_HOME, 'storages');
  if (!fs.existsSync(base)) return false;
  for (const d of fs.readdirSync(base)) {
    if (fs.existsSync(path.join(base, d, 'sessions', String(id) + '.json'))) return true;
  }
  return false;
}

function panels() {
  const out = [];
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN).filter((x) => x.endsWith('.json') && x[0] !== '_')) {
    let j = null; try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8')); } catch (e) { continue; }
    for (const p of (j.panels || [])) if (p.type === 'harness' || p.sessionId || p.sessionTitle) out.push({ file: f, scene: j, p: p });
  }
  return out;
}

/** 缺失面板分组：旧 id 优先（共用 id 一定同组），否则按 sessionTitle，再否则单面板一组。 */
function groups(all) {
  const map = new Map();
  for (const x of all) {
    const id = String(x.p.sessionId || '').trim();
    if (id && sessionExists(id)) continue;
    const key = id ? 'id:' + id
      : (x.p.sessionTitle ? 'title:' + x.p.sessionTitle : 'panel:' + x.p.id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(x);
  }
  return Array.from(map.values());
}

const missing = groups(panels());
if (!missing.length) { say('✓ 所有 AI 面板的会话都在（不用绑）'); process.exit(0); }
say('缺会话的面板 ' + missing.reduce((n, g) => n + g.length, 0) + ' 个，归成 ' + missing.length + ' 条：');
for (const g of missing) {
  const title = String(g[0].p.sessionTitle || (g[0].p.pinTarget || [])[0] || g[0].p.title || g[0].scene.name || g[0].p.id).trim();
  say('  · 「' + title + '」 ← ' + g.map((x) => x.p.id).join(', '));
}
if (!go) { say('\n（只列不动；加 --go 才建。壳会在引擎就绪后自动跑 --go）'); process.exit(0); }

let failed = 0;
for (const g of missing) {
  const title = String(g[0].p.sessionTitle || (g[0].p.pinTarget || [])[0] || g[0].p.title || g[0].scene.name || g[0].p.id).trim();
  const ids = g.map((x) => x.p.id).join(',');
  try {
    const out = execFileSync(process.execPath, [CREATOR, '--title', title, '--panel', ids], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20,
      env: Object.assign({}, process.env, { DSH_HOME: DSH_HOME }),
    });
    const line = String(out).split(/\r?\n/).find((l) => l.startsWith('✓ 新会话')) || '';
    say('  ✓ ' + line.replace(/^✓\s*/, '') + ' → ' + ids);
  } catch (e) {
    failed++;
    const err = String((e.stdout || '') + (e.stderr || '') || e.message || e).trim().split(/\r?\n/).slice(-3).join(' / ');
    say('  ✗ 「' + title + '」建会话失败：' + err.slice(0, 240));
  }
}
say(failed ? '\n✗ ' + failed + ' 条没绑成（面板仍空；壳下次启动会再试）' : '\n✓ 全部绑好');
process.exit(failed ? 1 : 0);
