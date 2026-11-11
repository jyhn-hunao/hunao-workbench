#!/usr/bin/env node
// 用量账本.mjs —— 命令行看「每条会话烧了多少 token、该不该换会话」。
//
// 为什么要有它：顶栏的「压力」胶囊 2026-10-23 按用户要求删掉了，之后这些数只剩引擎自己知道。
//   本工具只读投影缓存（引擎数据\.dsh\storages\session_projcache\），不 spawn 引擎、不写任何文件。
// 口径与 外壳\用量.js 完全一致（同一组函数），不另算一套数字。
//
// 用法：
//   node 工具\用量账本.mjs                  看当前各场景面板钉的会话
//   node 工具\用量账本.mjs --json           机器可读（给其它脚本/自检用）
//   node 工具\用量账本.mjs --session <id>   只看一条会话
//   node 工具\用量账本.mjs --all            所有写过用量的会话（含没被面板钉的）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // 12-源码照搬\工具
const BASE = path.resolve(HERE, '..');                          // 12-源码照搬
const SHELL = path.join(BASE, '外壳');
const DSH_HOME = process.env.DSH_HOME || path.join(BASE, '引擎数据', '.dsh');
const SCENARIOS = path.join(SHELL, 'scenarios');
const CACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

const require = createRequire(import.meta.url);
const usage = require(path.join(SHELL, '用量.js'));

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

// 这里的 fsx 与 main.js 里注入的是同一形状（readText / readDir / exists），本文件只用前两个
const fsx = {
  readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
  readDir: (p) => { try { return fs.readdirSync(p); } catch (e) { return []; } },
  exists: (p) => { try { return fs.existsSync(p); } catch (e) { return false; } }
};

// 1. 取数：默认只算「面板真的钉了的会话」；--all 才算目录里所有会话
function collect() {
  if (has('--all') || has('--session')) {
    const ids = has('--session')
      ? [String(val('--session', ''))]
      : fsx.readDir(CACHE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    const rows = ids.map((id) => {
      const s = usage.summarize(usage.readRecord(fsx, DSH_HOME, id));
      const level = usage.levelOf(s);
      return Object.assign({ sceneName: '(未钉面板)', sessionTitle: '', sessionId: id, panelTitle: '' }, s, {
        level, advice: usage.adviceOf(level, s)
      });
    });
    rows.sort((a, b) => usage.RANK[b.level] - usage.RANK[a.level] || b.perStep - a.perStep);
    return { ok: true, at: Date.now(), rows, worst: rows[0] || null };
  }
  return usage.listUsages(fsx, { dshHome: DSH_HOME, scenariosDir: SCENARIOS });
}

// 2. 出数：--json 原样，否则一张人读表
const res = collect();
if (has('--json')) {
  console.log(JSON.stringify(res));
  process.exit(0);
}

if (!res.rows.length) {
  console.log('没找到任何会话：先确认工作台在跑（引擎才会写投影缓存），或换 --all 试试。');
  process.exit(0);
}

const pad = (s, n) => {
  s = String(s == null ? '' : s);
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - w));
};
const wan = usage.wan;

console.log('场景      会话                    步数   上下文   占比    每步重发   重放率  建议');
console.log('--------  ----------------------  -----  -------  -----  ---------  ------  ----');
for (const r of res.rows) {
  const name = (r.sessionTitle || r.sceneName || '').slice(0, 20);
  console.log(
    pad(r.sceneName, 10) + pad(name, 24) + pad(r.hasData ? r.steps : '—', 7) +
    pad(r.hasData ? wan(r.ctx) : '—', 9) + pad(r.hasData ? r.pct + '%' : '—', 7) +
    pad(r.hasData ? wan(r.perStep) : '—', 11) + pad(r.hasData ? r.replayPct + '%' : '—', 8) +
    (r.level === 'over' ? '换会话' : r.level === 'warn' ? '准备收尾' : '照常')
  );
}
const warn = res.rows.filter((r) => r.level !== 'ok').length;
console.log('');
console.log('共 ' + res.rows.length + ' 条；要收尾的 ' + warn + ' 条。口径：上下文 / 窗口（本机 1M）；每步重发 = 累计(缓存重读+新增输入)/步数。');
if (res.worst && res.worst.level !== 'ok') {
  console.log('最该换的：' + (res.worst.sessionTitle || res.worst.sceneName) + ' —— ' + res.worst.advice);
}
