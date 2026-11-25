#!/usr/bin/env node
// 会话标题自愈（2026-11-25）
//
// 问题：场景改过名之后（B站 → 生活），引擎侧那个会话的标题还是旧的「B站」，
//   而场景 json 的面板写的是「生活」⇒ sessions.mjs --check 报「id 与标题不一致」；
//   记忆回响的 pinTarget、开口.mjs 按标题找人，也都会认不到。
// 判据：面板写的 sessionTitle = 期望值；引擎 projcache 里的 title = 现状；
//   不一致就用引擎自己的 session/rename 改回面板写的那个（不新建会话、不动历史）。
// 为什么必须由壳来跑：改标题要 token → cookie（server.log 已脱敏成 token=***），
//   只有壳 spawn 的子进程带 DSH_TOKEN（见 main.js 的 scriptEnv）。
//
// 用法：
//   node 12-源码照搬\工具\标题自愈.mjs           对齐（真写引擎）
//   node 12-源码照搬\工具\标题自愈.mjs --dry     只看差异，不改
//   node 12-源码照搬\工具\标题自愈.mjs --json    机器读
// @功能台 {"name":"会话标题自愈","group":"维护","freq":"按需","plain":"场景面板写的会话标题和引擎里的不一致时，改回面板写的那个","why":"引擎侧标题漂移会让记忆注入和主动开口认不到会话","label":"标题自愈"}
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BASE, getCookie, loadSessions } from './派发-公共.mjs';

const SCEN = path.join(ROOT, '外壳', 'scenarios');
const DRY = process.argv.includes('--dry');
const JSONOUT = process.argv.includes('--json');
const say = (s) => { if (!JSONOUT) console.log(s); };

// 1. 面板期望表：sessionId → 期望标题（同一 id 被多个面板共用时取第一个非空）
function wanted() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(SCEN).filter((f) => f.endsWith('.json')); } catch (e) { return out; }
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8')); } catch (e) { continue; }
    for (const p of (j.panels || [])) {
      if (!p || !p.sessionId || !p.sessionTitle) continue;
      const want = String(p.sessionTitle).trim();
      if (!want) continue;
      if (!out.has(p.sessionId)) out.set(p.sessionId, { want, scene: j.id || f, file: f, panel: p.id || '' });
    }
  }
  return out;
}

// 2. 引擎侧现状
function nowTitle(sessions, id) {
  const s = sessions.get(id);
  return s ? String(s.title || '').trim() : '';
}

// 3. 引擎 RPC（与 sessions.mjs 同一套 client-request 壳）
async function rpc(cookie, method, args) {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'title-heal', method, payload: { args } }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON 原样带出 */ }
  return { status: r.status, j, t };
}

(async () => {
  const want = wanted();
  const sessions = loadSessions();
  const diffs = [];
  for (const [id, w] of want) {
    const cur = nowTitle(sessions, id);
    if (!cur) { diffs.push({ id, ...w, cur: '(引擎里没有这条会话)', state: 'missing' }); continue; }
    if (cur === w.want) continue;
    diffs.push({ id, ...w, cur, state: 'diff' });
  }

  if (JSONOUT) {
    console.log(JSON.stringify({ base: BASE, dry: DRY, total: want.size, diffs }, null, 2));
  } else {
    say('引擎 ' + BASE + ' · 面板期望 ' + want.size + ' 条 · 不一致 ' + diffs.length + ' 条');
  }

  if (!diffs.length) { if (!JSONOUT) say('✓ 全部一致，不用改'); process.exit(0); }

  if (!JSONOUT) {
    for (const d of diffs) {
      say('  ' + d.scene + ' · ' + d.panel + '  面板「' + d.want + '」');
      say('    ' + d.id + '  现状「' + d.cur + '」' + (d.state === 'missing' ? '  → 会话不在引擎里，跳过' : ''));
    }
  }

  if (DRY) { if (!JSONOUT) say('\n--dry：以上都没改。去掉 --dry 才真写。'); process.exit(0); }

  let cookie = '';
  try { cookie = await getCookie(); } catch (e) {
    console.error('换不到 cookie：' + ((e && e.message) || e) + '\n  · 在壳里跑（功能台按钮 / 壳启动自愈）才有 DSH_TOKEN；外部手跑先设 DSH_TOKEN。');
    process.exit(2);
  }

  let ok = 0, bad = 0;
  for (const d of diffs) {
    if (d.state === 'missing') continue;
    const r = await rpc(cookie, 'session/rename', { request: { sessionId: d.id, title: d.want } });
    const done = r.status === 200 && !(r.j && r.j.error);
    if (done) { ok++; if (!JSONOUT) say('  ✓ ' + d.id.slice(0, 17) + '… → 「' + d.want + '」'); }
    else { bad++; console.error('  ✗ ' + d.id + ' → 「' + d.want + '」HTTP ' + r.status + ' ' + String(r.t).slice(0, 160)); }
  }
  if (!JSONOUT) say('结果：' + ok + ' 改成 · ' + bad + ' 失败（改完可跑 sessions.mjs --check 复核）');
  process.exit(bad ? 1 : 0);
})();
