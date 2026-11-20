#!/usr/bin/env node
// 守卫开关.mjs —— 把「省 token 守卫」作为 **bundle** 组进 web profile（一条命令，可回滚）。
//
// 为什么走 bundle 而不是手写 cordis.patch.yml：
//   ① profile 的 patch 只支持「改已有条目 / 往已有 group 里 insert」，
//      直接写一个不存在的 id 会被引擎拒掉（`patch: entry "token-guard" not found`）；
//   ② bundle 才是官方的「新增一个插件」通道：包自带 cordis.patch.yml，
//      把包名加进 profile package.json 的 dsh.profile.bundles 就会在启动时被组进树里。
//
// 用法：
//   node 工具\守卫开关.mjs --status                 看装没装 / 组没组进 profile
//   node 工具\守卫开关.mjs --on                     装 + 组进 bundles（默认 shadow：只记不拦）
//   node 工具\守卫开关.mjs --on --mode enforce       装 + 组进 bundles（真拦）
//   node 工具\守卫开关.mjs --off                    摘掉（从 bundles 移除 + 删副本）
//
// 生效：重启工作台。日志：引擎数据\.dsh\storages\token-guard.jsonl
// 回滚：`--off`，再重启。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));              // 12-源码照搬\工具
const BASE = path.resolve(HERE, '..');                                  // 12-源码照搬
const DSH_HOME = process.env.DSH_HOME || path.join(BASE, '引擎数据', '.dsh');
const PROFILE = path.join(DSH_HOME, 'profiles', 'web');
const PKG_FILE = path.join(PROFILE, 'package.json');
const SRC = path.join(BASE, '插件', '省token守卫');
const DEST = path.join(PROFILE, 'node_modules', 'dsh-token-guard');
const LOG = path.join(DSH_HOME, 'storages', 'token-guard.jsonl');
const ENGINE_BIN = path.join(BASE, '引擎', 'lib', 'bin.js');
const BUNDLE = 'dsh-token-guard';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const dry = has('--dry');
const mode = String(val('--mode', 'shadow')).toLowerCase() === 'enforce' ? 'enforce' : 'shadow';

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

// 读 profile 的 package.json（保留 2 空格缩进写回）
function readPkg() {
  try { return JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (e) { die('读不了 ' + PKG_FILE + '：' + e.message); }
}
function bundlesOf(pkg) {
  const d = (pkg && pkg.dsh) || {};
  const p = (d && d.profile) || {};
  return Array.isArray(p.bundles) ? p.bundles : [];
}
function withBundles(pkg, next) {
  const out = JSON.parse(JSON.stringify(pkg));
  out.dsh = out.dsh || {};
  out.dsh.profile = out.dsh.profile || {};
  out.dsh.profile.bundles = next;
  return out;
}

const pkg = readPkg();
const inBundles = bundlesOf(pkg).includes(BUNDLE);
const installed = fs.existsSync(path.join(DEST, 'package.json'));

// 真话：dump-config 里有这一条，才说明它会被组进树里
function dumpHasGuard() {
  try {
    const out = execFileSync(process.execPath, [ENGINE_BIN, '--profile', 'web', '--dump-config'], {
      encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { DSH_HOME })
    });
    return { ok: true, hit: /id:\s*token-guard\b/.test(out) };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e).split('\n')[0] };
  }
}

// 副本里的 patch 才是模式真源（--mode 只在写的时候用）
function modeOf() {
  try {
    const t = fs.readFileSync(path.join(DEST, 'cordis.patch.yml'), 'utf8');
    const m = t.match(/mode:\s*(\w+)/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

// 日志汇总（2026-11-20）：原来状态只报「有多少行」，看不出哪条规则命中最多、最近一次是什么。
//   只聚合规则名 / 次数 / 最近时间，不读正文（正文里是命令与路径，界面只给统计）。
function logSummary() {
  let lines = 0, errors = 0, last = null
  const rules = {}
  try {
    const rows = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    lines = rows.length
    for (const row of rows.slice(-1000)) {
      try {
        const j = JSON.parse(row)
        if (j.error) errors++
        const rule = String(j.rule || '(无规则)')
        rules[rule] = (rules[rule] || 0) + 1
        last = j
      } catch { /* 单行坏不挡统计 */ }
    }
  } catch { /* 还没有日志 */ }
  const top = Object.keys(rules).sort((a, b) => rules[b] - rules[a]).slice(0, 6).map((rule) => ({ rule: rule, n: rules[rule] }))
  return { lines: lines, rules: rules, top: top, errors: errors, lastAt: (last && last.at) || null, lastRule: (last && last.rule) || null, lastMode: (last && last.mode) || null }
}

if (has('--status') || (!has('--on') && !has('--off') && !has('--dry'))) {
  const modeNow = modeOf();
  const log = logSummary();
  // --json 是快查：不跑 dump-config（它要起一次引擎、可能超过界面的 25 秒探针超时）
  if (has('--json')) {
    console.log(JSON.stringify({
      at: Date.now(), installed: installed, inBundles: inBundles,
      mode: modeNow || null, source: PKG_FILE,
      bundlePatch: path.join(DEST, 'cordis.patch.yml'),
      log: Object.assign({ path: LOG }, log),
      engine: null,
    }, null, 0));
    process.exit(0);
  }
  console.log('源码：' + SRC);
  console.log('副本：' + (installed ? '已复制到 ' + DEST : '未安装'));
  console.log('profile bundles：' + (inBundles ? '已包含 ' + BUNDLE : '未包含'));
  console.log('模式：' + (modeNow || '未装 / 副本里没写'));
  const d = dumpHasGuard();
  if (!d.ok) console.log('引擎视图：跑不动 dump-config —— ' + d.err);
  else console.log('引擎视图：' + (d.hit ? '✓ 组进树里了（token-guard 在配置里）' : '✗ 配置里没有 token-guard（重启也不会加载）'));
  if (log.lines) {
    console.log('日志：' + LOG + '（' + log.lines + ' 行' + (log.errors ? ' · 失败 ' + log.errors + ' 行' : '') + '）');
    console.log('命中 Top：' + (log.top.length ? log.top.map((x) => x.rule + '×' + x.n).join(' / ') : '—'));
    console.log('最近一次：' + (log.lastAt || '—') + ' · ' + (log.lastRule || '—') + ' · ' + (log.lastMode || '—'));
  } else console.log('日志：还没有（重启并跑一次任务后才会有）');
  if (!inBundles) console.log('\n要装：node 工具\\守卫开关.mjs --on    然后重启工作台');
  process.exit(0);
}

if (has('--off')) {
  if (inBundles) {
    fs.writeFileSync(PKG_FILE, JSON.stringify(withBundles(pkg, bundlesOf(pkg).filter((x) => x !== BUNDLE)), null, 2) + '\n', 'utf8');
  }
  if (installed) fs.rmSync(DEST, { recursive: true, force: true });
  console.log('已摘掉：' + (inBundles ? '从 bundles 移除 ' : '本来没在 bundles ') + (installed ? '+ 删了副本' : ''));
  console.log('下一步：重启工作台。');
  process.exit(0);
}

// ---------- 装 ----------
if (!fs.existsSync(path.join(SRC, 'index.js'))) die('找不到插件源码：' + SRC);

if (dry) {
  console.log('---- 会复制 ----\n' + SRC + '  →  ' + DEST);
  console.log('---- 会写进 ' + PKG_FILE + ' ----');
  console.log(JSON.stringify(withBundles(pkg, bundlesOf(pkg).concat([BUNDLE])), null, 2));
  console.log('---- 会写进副本的 cordis.patch.yml ----');
  console.log('mode: ' + mode);
  process.exit(0);
}

// 1. 复制源码（先删旧副本）
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });

// 2. 副本里写 bundle 清单（模式在这里定）
// ⚠ 必须用 `- insert:` 包裹：patch 里带 id 的条目是「改已有条目」，
//    写 `- id: token-guard` 会被引擎判成「找不到这个条目」而丢掉（我踩过一次）。
// 顺带把裁剪阈值也压在这里：同一份 bundle 里的 id 补丁会改到前面 bundle 已挂的条目
//   （`dsh-web-app` 就是这么改 `dsh-base` 的），而且 dump-config 看得见 ⇒ 可验证。
fs.writeFileSync(path.join(DEST, 'cordis.patch.yml'), [
  '# 由 工具\\守卫开关.mjs 生成：作为 bundle 被组进 web profile 时才生效',
  '- insert:',
  '    - id: token-guard',
  '      name: ' + BUNDLE,
  '      config:',
  '        mode: ' + mode,
  '# 工具返回裁剪：单条超 4096 字符就截成 head 1536 + tail 512（默认是 8192/4096/1024）',
  '- id: tool-result-pruner',
  "  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  '  config:',
  '    thresholdChars: 4096',
  '    headChars: 1536',
  '    tailChars: 512',
  '',
].join('\n'), 'utf8');

// 3. 组进 profile 的 bundles
const nextBundles = inBundles ? bundlesOf(pkg) : bundlesOf(pkg).concat([BUNDLE]);
fs.writeFileSync(PKG_FILE, JSON.stringify(withBundles(pkg, nextBundles), null, 2) + '\n', 'utf8');

// 4. 自证：引擎的配置树里真的出现了
const d = dumpHasGuard();
if (!d.ok) die('组进去了但 dump-config 跑不动：' + d.err);
if (!d.hit) die('组进去了但配置树里没有 token-guard —— 重启也不会加载，已中止（用 --off 收拾）');

console.log('已装好：' + DEST);
console.log('引擎视图：✓ token-guard 已在配置树里');
console.log('模式：' + mode + (mode === 'shadow' ? '（只记日志，不拦）' : '（真拦）'));
console.log('下一步：重启工作台 → 跑一次任务 → 看 ' + LOG);
