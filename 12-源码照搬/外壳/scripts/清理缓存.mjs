#!/usr/bin/env node
// 清理缓存.mjs —— 回收 `外壳\data\electron-profile` 里的 Chromium 缓存（2026-11-13 新增）
//
// 为什么有它：壳把 webview/embed 的会话数据放在 data\electron-profile 下，浏览器缓存只增不减。
//   实测本机 1,226 MB / 8,179 个文件 / 38 个分区，单文件最大 40 MB（webai-doubao），
//   原来没有任何回收手段 —— 长期跑就是慢慢吃盘，小盘机先表现为"写不进东西"。
//
// 只删**可重建的缓存**，登录态一概不碰：
//   删：Cache / Code Cache / GPUCache / ShaderCache / DawnCache / GraphiteDawnCache /
//       Partitions\<名字>\Cache、\Code Cache、\GPUCache …
//   留：Cookies、Local Storage、IndexedDB、Session Storage、Network、Preferences、Local State
//
// 安全约束：
//   · 默认 **--dry**（只统计，不删）；真删要显式 `--apply`
//   · 壳在跑（端口上有引擎在应答）时 **拒绝执行** —— 应用开着删缓存，轻则面板白屏，重则分区损坏
//   · 删完只删空目录，不递归删父目录
//
// 用法：
//   node 外壳\scripts\清理缓存.mjs              只读体检：总量 + Top 10 大头 + 可回收多少
//   node 外壳\scripts\清理缓存.mjs --apply      真删缓存（先在设置里退出工作台）
//   node 外壳\scripts\清理缓存.mjs --after-exit <pid> [--apply]   等这个进程退出（且端口空）后再删
//                                                —— 2026-11-14 加：壳退出时自己拉起它，用户不用记得手动清
//   node 外壳\scripts\清理缓存.mjs --json       机器可读
//
// 退出码：0 正常 / 2 前置不成立（目录不存在、壳在跑）/ 4 有删除失败

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { port } from '../../工具/环境.mjs';

const SHELL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // 外壳
const DATA = path.join(SHELL, 'data');
const PROFILE = path.join(DATA, 'electron-profile');
const DSH_PORT = port('dsh');
// 自动维护的流水账（只在 --after-exit 模式写；人手动跑还是打屏幕）
const AUTO_LOG = path.join(DATA, '自动维护.log');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const JSON_OUT = argv.includes('--json');
const AFTER_IDX = argv.indexOf('--after-exit');
const AFTER_PID = AFTER_IDX >= 0 ? Number(argv[AFTER_IDX + 1] || 0) : 0;

function autoLog(line) {
  try {
    fs.appendFileSync(AUTO_LOG, '[' + new Date().toISOString() + '] ' + line + '\r\n');
  } catch { /* 写不进就算了，不阻塞清理 */ }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 缓存目录名白名单（大小写不敏感；只在 profile 内、按目录名匹配）
const CACHE_NAMES = new Set([
  'cache', 'code cache', 'gpucache', 'shadercache', 'dawncache', 'graphitedawncache',
  'grshadercache', 'webgpu blocklist', 'cachestorage_tmp',
]);

// 2. 绝不删除的目录名（防手滑：白名单命中也要过这一关）
const KEEP_NAMES = new Set([
  'cookies', 'network', 'local storage', 'session storage', 'indexeddb', 'preferences', 'local state',
  'transportsecurity', 'trust tokens',
]);

function walk(dir, acc) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      acc.dirs.push(p);
      walk(p, acc);
    } else if (it.isFile()) {
      try {
        const st = fs.statSync(p);
        acc.files.push({ path: p, size: st.size });
        acc.bytes += st.size;
      } catch { /* 读不到就跳过 */ }
    }
  }
}

function listTargets() {
  const targets = [];
  const walkInto = (dir, depth) => {
    if (depth > 6) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (!it.isDirectory()) continue;
      const p = path.join(dir, it.name);
      const nm = it.name.toLowerCase();
      if (CACHE_NAMES.has(nm) && !KEEP_NAMES.has(nm)) { targets.push(p); continue; }
      walkInto(p, depth + 1);
    }
  };
  walkInto(PROFILE, 0);
  return targets;
}

function measure(dirs) {
  let bytes = 0, files = 0;
  for (const d of dirs) {
    const acc = { dirs: [], files: [], bytes: 0 };
    walk(d, acc);
    bytes += acc.bytes;
    files += acc.files.length;
  }
  return { bytes, files };
}

// 3. 壳是否在跑：端口能连上就认为在跑（引擎由壳拉起，端口在 = 壳在）
function engineBusy() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: DSH_PORT, timeout: 1200 });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

function topDirs(dir, n) {
  const out = [];
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const p = path.join(dir, it.name);
    const acc = { dirs: [], files: [], bytes: 0 };
    walk(p, acc);
    out.push({ name: it.name, bytes: acc.bytes, files: acc.files.length });
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, n);
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';

async function main() {
  if (!fs.existsSync(PROFILE)) {
    console.error('✗ 没有 electron-profile 目录：' + PROFILE + '\n  （还没启动过工作台？先双击 启动.vbs 一次）');
    process.exit(2);
  }

  const whole = { dirs: [], files: [], bytes: 0 };
  walk(DATA, whole);
  const targets = listTargets();
  const reclaim = measure(targets);

  // 1. 自动模式：先等壳真的退干净（进程没了 + 端口空了），再走同一套删除逻辑
  if (AFTER_PID) {
    const waitStart = Date.now();
    const LIMIT_MS = 15 * 60 * 1000;   // 最多等 15 分钟：等不到就放弃，别留一个僵尸进程
    while (Date.now() - waitStart < LIMIT_MS) {
      const busy = await engineBusy();
      if (!pidAlive(AFTER_PID) && !busy) break;
      await sleep(700);
    }
    const busy2 = await engineBusy();
    if (pidAlive(AFTER_PID) || busy2) {
      autoLog('放弃：等了 15 分钟壳仍未退出（pid ' + AFTER_PID + ' alive=' + pidAlive(AFTER_PID) + ' / 端口在=' + busy2 + '）');
      process.exit(2);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      data: { dir: DATA, bytes: whole.bytes, files: whole.files.length },
      profile: { dir: PROFILE, top: topDirs(PROFILE, 10) },
      reclaim: { dirs: targets.length, bytes: reclaim.bytes, files: reclaim.files },
      applied: APPLY, port: DSH_PORT,
    }, null, 2));
    return;
  }

  console.log('外壳\\data 合计：' + mb(whole.bytes) + ' / ' + whole.files.length + ' 个文件');
  console.log('其中 electron-profile 里可回收的缓存：' + mb(reclaim.bytes) + ' / ' + reclaim.files + ' 个文件 / ' + targets.length + ' 个缓存目录');
  console.log('\nTop 10 大头（electron-profile 下）：');
  for (const t of topDirs(PROFILE, 10)) console.log('  ' + mb(t.bytes).padStart(9) + '  ' + t.files + ' 文件  ' + t.name);

  // 5. 列出最大的 5 个待删缓存目录：让人在 --apply 之前能看清到底删什么
  const sized = targets.map((d) => { const acc = { dirs: [], files: [], bytes: 0 }; walk(d, acc); return { d, bytes: acc.bytes, files: acc.files.length }; })
    .sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  console.log('\n待删的最大 5 个缓存目录：');
  for (const s of sized) console.log('  ' + mb(s.bytes).padStart(9) + '  ' + s.files + ' 文件  ' + path.relative(PROFILE, s.d));

  if (!APPLY) {
    console.log('\n（只读体检。要真删：先退出工作台，再跑 node 外壳\\scripts\\清理缓存.mjs --apply）');
    return;
  }

  const busy = await engineBusy();
  if (busy) {
    console.error('\n✗ 工作台还在跑（' + DSH_PORT + ' 端口在应答）⇒ 拒绝删缓存。\n  先退出工作台（托盘退出或关窗），再跑一次。');
    if (AFTER_PID) autoLog('放弃：端口仍被占用（' + DSH_PORT + '）');
    process.exit(2);
  }

  let failed = 0;
  for (const d of targets) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { failed++; console.error('  ✗ 删不掉 ' + d + '：' + (e && e.message)); }
  }
  if (AFTER_PID) autoLog('自动清缓存：删 ' + (targets.length - failed) + ' 个目录，释放约 ' + mb(reclaim.bytes) + '（失败 ' + failed + '）');
  console.log('\n✓ 已删除 ' + (targets.length - failed) + ' 个缓存目录，释放约 ' + mb(reclaim.bytes) + '（失败 ' + failed + ' 个）');
  console.log('  登录态（Cookies / Local Storage / IndexedDB）未动；下次启动会重建缓存，首屏可能慢 1–3 秒。');
  if (failed) process.exit(4);
}

main();
