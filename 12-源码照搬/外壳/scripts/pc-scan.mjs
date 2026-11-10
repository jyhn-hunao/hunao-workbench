// pc-scan.mjs —— 「本地电脑」场景的磁盘扫描器（2026-11-10 补）
// 谁在用：外壳\renderer\renderers.js 的 pc-toplarge / pc-junk 两块面板只读快照 JSON
//         （渲染层没有列目录能力 ⇒ 体积必须在这里算好落盘）。
// 产出：外壳\data\pc-cleanup-scan.json
//   { scannedAt, tookSec, minGb, depth, truncated,
//     drives:[{letter,buckets,truncated,denied}], items:[{path,gb}],
//     byDrive:{"C:":[{path,gb}]}, junk:[{k,path,note,gb}], junkTotalGb }
// 用法：node 外壳\scripts\pc-scan.mjs [--min-gb 0.5] [--budget-sec 300] [--depth 3]
//        [--skip-junk] [--out <文件>] [--quiet]
// 只依赖 Node 内置模块（AGENTS.md §4：工具脚本不引第三方依赖）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // …\外壳\scripts
const SHELL_DIR = process.env.DSH_SHELL_DIR || path.join(HERE, '..');
const GIB = 1024 * 1024 * 1024;

// ---- 1. 参数 ----
const OPT = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const o = { minGb: 0.5, budgetSec: 300, depth: 3, skipJunk: false, quiet: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--min-gb') o.minGb = num(next(), o.minGb);
    else if (a === '--budget-sec') o.budgetSec = num(next(), o.budgetSec);
    else if (a === '--depth') o.depth = Math.min(4, Math.max(1, num(next(), o.depth)));
    else if (a === '--skip-junk') o.skipJunk = true;
    else if (a === '--out') o.out = String(next() || '');
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  }
  if (!o.out) o.out = path.join(SHELL_DIR, 'data', 'pc-cleanup-scan.json');
  return o;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function usage() {
  console.log('node 外壳\\scripts\\pc-scan.mjs [--min-gb 0.5] [--budget-sec 300] [--depth 3] [--skip-junk] [--out <文件>] [--quiet]');
}

const say = (s) => { if (!OPT.quiet) console.log(s); };

// ---- 2. 盘符枚举（只认能读的固定盘根） ----
function listDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = letter + ':\\';
    try {
      const st = fs.statSync(root);                 // 光驱/未挂载的盘在这里抛错，跳过即可
      if (!st.isDirectory()) continue;
      out.push({ letter, root });
    } catch (e) { /* 这个字母没有盘 */ }
  }
  return out;
}

// ---- 3. 扫盘：一次遍历，按「桶」累加体积 ----
// 桶 = 盘根 或 深度 ≤ depth 的目录；更深的文件都算到最近的那个祖先桶上。
// 这样一次遍历就能同时得到「C:\ 本身」「C:\Users」「C:\Users\<用户>\AppData」各占多少。
function scanDrive(drive, ctx) {
  const buckets = new Map([[drive.root, 0]]);
  let dirs = 0, files = 0, denied = 0;
  let truncated = false;
  const stack = [{ dir: drive.root, depth: 0, bucket: drive.root }];
  while (stack.length) {
    if (Date.now() > ctx.deadline) { truncated = true; break; }
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur.dir, { withFileTypes: true }); }
    catch (e) { denied++; continue; }               // 系统保护目录（System Volume Information 等）读不了就跳过
    dirs++;
    let bucket = cur.bucket;
    if (cur.depth > 0 && cur.depth <= ctx.depth) { bucket = cur.dir; buckets.set(bucket, 0); }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;            // junction / 符号链接：跳，避免重复计数和死循环
      const full = path.join(cur.dir, ent.name);
      if (ent.isDirectory()) { stack.push({ dir: full, depth: cur.depth + 1, bucket }); continue; }
      if (!ent.isFile()) continue;
      const st = tryStat(full);
      if (!st) continue;
      const size = st.size || 0;
      buckets.set(bucket, (buckets.get(bucket) || 0) + size);
      files++;
    }
  }
  return { buckets, dirs, files, denied, truncated };
}

function tryStat(file) {
  try { return fs.statSync(file, { throwIfNoEntry: false }); }
  catch (e) { return null; }
}

// 去掉被更具体的桶吃掉的父桶：C:\Users 和 C:\Users\<用户> 同时上榜时只留后者。
function dropRedundant(list) {
  const out = [];
  for (const cur of list.slice().sort((a, b) => b.bytes - a.bytes)) {
    const takeOver = out.findIndex((k) => isUnder(cur.path, k.path) && cur.bytes >= k.bytes * 0.9);
    if (takeOver >= 0) { out.splice(takeOver, 1); out.push(cur); continue; }
    if (out.some((k) => isUnder(k.path, cur.path) && k.bytes >= cur.bytes * 0.9)) continue;
    out.push(cur);
  }
  return out;
}

function isUnder(child, parent) {
  if (!child || !parent || child === parent) return false;
  const base = parent.endsWith('\\') ? parent : parent + '\\';
  return child.startsWith(base);
}

// ---- 4. 可清理体检：定点量已知缓存目录 ----
function junkTargets() {
  const L = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const win = process.env.SystemRoot || 'C:\\Windows';
  const t = [];
  const add = (k, p, note, filter) => { if (p) t.push({ k, path: p, note: note || '', filter: filter || null }); };

  add('用户临时文件', os.tmpdir(), 'TEMP：直接删，正被占用的会跳过');
  add('Windows 临时文件', path.join(win, 'Temp'), '系统临时目录，直接删');
  add('Windows 更新缓存', path.join(win, 'SoftwareDistribution', 'Download'), '已装的更新包，删了不影响系统');
  add('传递优化缓存', path.join(win, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization'), '更新分发的缓存，可删');
  add('错误报告与转储', path.join(L, 'CrashDumps'), '崩溃转储，除排查问题外没用');
  add('预读取文件', path.join(win, 'Prefetch'), '删了会短暂拖慢开机，一般不动');
  add('缩略图缓存', path.join(L, 'Microsoft', 'Windows', 'Explorer'), '只量 thumbcache_*.db', (n) => /^thumbcache_.*\.db$/i.test(n));
  add('Chrome 缓存', path.join(L, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), '浏览器缓存，删了要重新加载资源');
  add('Edge 缓存', path.join(L, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), '浏览器缓存，删了要重新加载资源');
  add('npm 缓存', path.join(L, 'npm-cache'), '下次安装会重新下');
  add('pnpm 缓存', path.join(L, 'pnpm', 'store'), '下次安装会重新下');
  add('pip 缓存', path.join(L, 'pip', 'Cache'), '下次安装会重新下');
  add('工作台 Electron 缓存', path.join(SHELL_DIR, 'data', 'electron-profile'), '本工作台自己的浏览器缓存，删了重启后重建');
  for (const d of listDrives()) {
    add('回收站 ' + d.letter, path.join(d.root, '$Recycle.Bin'), '已删除文件还在占空间，清空回收站即释放');
  }
  return t;
}

function dirSize(dir, filter, deadline) {
  let total = 0, cut = false;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) { cut = true; break; }
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) continue;
      if (filter && !filter(ent.name)) continue;
      const st = tryStat(full);
      if (st) total += st.size || 0;
    }
  }
  return { bytes: total, cut };
}

function scanJunk(deadline) {
  const out = [];
  for (const t of junkTargets()) {
    if (!fs.existsSync(t.path)) continue;
    const r = dirSize(t.path, t.filter, deadline);
    if (r.bytes < 10 * 1024 * 1024) continue;      // 不到 10MB 的不算“可清理”，否则面板里一排 0.00 GB
    out.push({ k: t.k, path: t.path, note: t.note + (r.cut ? '（没量完，结果偏小）' : ''), gb: gb(r.bytes) });
  }
  return out.sort((a, b) => b.gb - a.gb);
}

const gb = (bytes) => Math.round((bytes / GIB) * 100) / 100;

// ---- 5. 主流程：扫 → 拼 → 落盘 ----
function main() {
  const startedAt = Date.now();
  const drives = listDrives();
  if (!drives.length) { console.error('没找到可扫描的盘'); process.exit(1); }

  const perDriveMs = Math.max(30000, (OPT.budgetSec * 1000) / drives.length);   // 每个盘分到的时间，最少 30s
  const driveInfo = [];
  const allBuckets = [];
  const byDrive = {};

  for (const d of drives) {
    say('[' + d.letter + ':] 扫描中…');
    const ctx = { depth: OPT.depth, deadline: Date.now() + perDriveMs };
    const r = scanDrive(d, ctx);
    const list = [];
    for (const [p, bytes] of r.buckets) if (bytes > 0) list.push({ path: p, bytes });
    const ranked = dropRedundant(list).slice(0, 15);
    byDrive[d.letter + ':'] = ranked.map((x) => ({ path: x.path, gb: gb(x.bytes) }));
    for (const x of list) allBuckets.push({ path: x.path, bytes: x.bytes, drive: d.letter + ':' });
    driveInfo.push({ letter: d.letter, buckets: r.buckets.size, truncated: r.truncated, denied: r.denied });
    say('[' + d.letter + ':] 目录 ' + r.dirs + ' 个 · 读不了 ' + r.denied + ' 个 · 用时 ' +
        ((Date.now() - startedAt) / 1000).toFixed(1) + 's' + (r.truncated ? '（到时间上限，结果不完整）' : ''));
  }

  const minBytes = OPT.minGb * GIB;
  const items = dropRedundant(allBuckets)
    .filter((x) => x.bytes >= minBytes)
    .slice(0, 40)
    .map((x) => ({ path: x.path, gb: gb(x.bytes) }));

  const junk = OPT.skipJunk ? [] : scanJunk(Date.now() + 90000);
  const data = {
    scannedAt: new Date().toISOString(),
    tookSec: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
    minGb: OPT.minGb,
    depth: OPT.depth,
    truncated: driveInfo.some((d) => d.truncated),
    drives: driveInfo,
    items,
    byDrive,
    junk,
    junkTotalGb: Math.round(junk.reduce((a, j) => a + j.gb, 0) * 100) / 100,
  };

  fs.mkdirSync(path.dirname(OPT.out), { recursive: true });
  fs.writeFileSync(OPT.out, JSON.stringify(data, null, 1), 'utf8');

  say('');
  say('大户排行 Top ' + Math.min(8, items.length) + '：');
  items.slice(0, 8).forEach((it, i) => say('  ' + (i + 1) + '. ' + fmt(it.gb) + '  ' + it.path));
  say('可清理体检：' + junk.length + ' 项，合计 ' + fmt(data.junkTotalGb));
  junk.slice(0, 5).forEach((j) => say('  · ' + j.k + '  ' + fmt(j.gb)));
  say('已写入：' + OPT.out + '（总用时 ' + data.tookSec + 's）');
}

function fmt(v) { return v >= 1024 ? (v / 1024).toFixed(2) + ' TB' : v.toFixed(2) + ' GB'; }

main();
