#!/usr/bin/env node
// @功能台 {"name":"打引擎包","group":"引擎","freq":"发版前","plain":"把当前引擎目录打成自包含 tar.gz（含 node_modules），算 sha256，输出可直接填进 engine.source 的一段 JSON。","why":"首启下载不能依赖 pnpm 重装依赖，必须发一份装好依赖的整目录包；sha256 必须和包一起发。","label":"打引擎包"}
// 打包引擎.mjs —— 发版前置：把 12-源码照搬\引擎 打成可首启下载的自包含包
//
// 用法：
//   node 工具\打包引擎.mjs                        # 输出到 12-源码照搬\发布\引擎包\
//   node 工具\打包引擎.mjs --out D:\发布\引擎包     # 指定目录
//   node 工具\打包引擎.mjs --dry                  # 只打印会打什么、体积、条目数
//
// 产物：
//   <out>\引擎-<版本>-win-x64.tar.gz
//   <out>\引擎-<版本>-win-x64.tar.gz.sha256
// 并打印一段 engine.source JSON（url 先写占位，托管后替换域名即可）。
//
// ⛔ 不把 引擎\.dsh（会话 / 凭证 / 缓存）和日志打进包；引擎目录本身不手改。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
const has = k => argv.includes(k);
const val = k => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : ''; };
const DRY = has('--dry');

const ENGINE = val('--dir') || path.join(ROOT, '引擎');
const OUT = val('--out') || path.join(ROOT, '发布', '引擎包');

// 1. 版本与包名
let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'), 'utf8')).version || version; } catch (e) {
  console.error('✗ 读不到引擎 package.json：' + e.message);
  process.exit(2);
}
const NAME = '引擎-' + version + '-win-x64.tar.gz';
const TGZ = path.join(OUT, NAME);
const SHA_FILE = TGZ + '.sha256';

// 2. 入口必须齐（缺依赖的包发出去也会在客户机装不上）
const entries = [path.join(ENGINE, 'lib', 'bin.js'), path.join(ENGINE, 'apps', 'cli', 'lib', 'bin.js')];
if (!entries.some(p => { try { return fs.statSync(p).size > 0; } catch (e) { return false; } })) {
  console.error('✗ 引擎入口不存在（lib/bin.js 或 apps/cli/lib/bin.js）');
  process.exit(1);
}
if (!fs.existsSync(path.join(ENGINE, 'node_modules'))) {
  console.error('✗ 引擎缺 node_modules：这种包到了客户机起不来，先在本机装好依赖再打');
  process.exit(1);
}

// 3.1 有符号链接/junction 就拒打：pnpm 隔离布局的 node_modules 里几千个链接，
//     tar 带 -L 会绕圈（实测 15 秒只涨 0.8 MB）；不带 -L 到客户机又解不回来。
//     发布包必须是 hoisted 布局（`pnpm install --node-linker=hoisted`，见 工具\引擎更新.mjs 的 prepare）。
let links = 0;
(function countLinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { links += 1; continue; }   // junction / 符号链接都走这里
    if (e.isDirectory()) countLinks(p);
  }
})(ENGINE);
if (links > 0) {
  console.error('✗ 引擎里有 ' + links + ' 个符号链接 / junction，这种包到客户机解不回来：');
  console.error('  先用 hoisted 布局重装一份引擎（pnpm install --node-linker=hoisted），再指向它打包：');
  console.error('  node 工具\\打包引擎.mjs --dir <hoisted 引擎目录>');
  process.exit(3);
}

// 3.2 体积预估（只读）
function sizeOf(dir) {
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sum += sizeOf(p);
    else { try { sum += fs.statSync(p).size; } catch (x) { /* 读不到就跳过 */ } }
  }
  return sum;
}
const rawMB = sizeOf(ENGINE) / 1024 / 1024;
console.log('引擎目录：' + ENGINE);
console.log('版本：' + version + ' · 原始 ' + rawMB.toFixed(1) + ' MB');

if (DRY) {
  console.log('（演练）会打：' + TGZ);
  console.log('  排除：引擎\\.dsh、node_modules\\.cache、*.log');
  process.exit(0);
}

// 4. 打包：在暂存目录建一个 ASCII 名的 junction 指向引擎（包内根名固定 engine/；
//    中文目录名直接当 tar 参数会写进 GBK 字节，客户机解包报 Invalid argument）。
//    引擎已确认无符号链接（见 3.1），所以不加 -L，避免绕圈。
const staging = path.join(ROOT, '.engine-pack-' + Date.now());
const link = path.join(staging, 'engine');
fs.mkdirSync(staging, { recursive: true });
let linked = false;
try {
  fs.symlinkSync(ENGINE, link, 'junction');
  linked = true;
} catch (e) {
  console.warn('! junction 建不了，退回整目录复制（会慢）：' + e.message);
  fs.cpSync(ENGINE, link, { recursive: true });
}

fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(TGZ)) fs.rmSync(TGZ, { force: true });
const t0 = Date.now();
const r = spawnSync('tar', [
  '-czf', TGZ, '-C', staging,
  '--exclude=engine/.dsh', '--exclude=engine/node_modules/.cache',
  '--exclude=engine/*.log', '--exclude=engine/*.log.prev',
  // 装机包只留运行必需：类型声明 / 源码映射 / 调试符号 / 文档 / arm64 预编译都不是 x64 运行时依赖。
  // 实测 31.5k 文件 → 16k 左右，首启解包时间至少减半（Windows Defender 逐文件扫描是瓶颈）。
  '--exclude=*.d.ts', '--exclude=*.map', '--exclude=*.pdb',
  '--exclude=*.md', '--exclude=*/win32-arm64/*',
  'engine'
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
// 4.1 无论成败都收掉暂存（junction 只删链接，不碰引擎本体）
try {
  if (linked) fs.unlinkSync(link);
  fs.rmSync(staging, { recursive: true, force: true });
} catch (e) {
  console.warn('! 暂存目录清理失败：' + staging + '（' + e.message + '）');
}
if (r.status !== 0) {
  console.error('✗ 打包失败（tar 退出码 ' + r.status + '）：' + String(r.stderr || '').slice(0, 300));
  process.exit(1);
}

// 5. 自检：包能解开、里面有入口（引擎条目上万，列表会超过 spawnSync 默认 1 MB 缓冲）
const list = spawnSync('tar', ['-tzf', TGZ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const names = String(list.stdout || '').split(/\r?\n/);
if (list.status !== 0 || !names.some(n => /\/lib\/bin\.js$/.test(n))) {
  console.error('✗ 包自检失败：里面没有 */lib/bin.js');
  process.exit(1);
}

// 6. sha256 + 大小
const hash = crypto.createHash('sha256');
hash.update(fs.readFileSync(TGZ));
const sha = hash.digest('hex');
const bytes = fs.statSync(TGZ).size;
fs.writeFileSync(SHA_FILE, sha + '  ' + NAME + '\n', 'utf8');

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log('✓ ' + TGZ);
console.log('  ' + (bytes / 1024 / 1024).toFixed(1) + ' MB · 用时 ' + secs + 's · sha256 ' + sha);
console.log('  ' + SHA_FILE);
console.log('');
console.log('把下面这段填进 机器配置.json（或随包的 外壳\\引擎源.json），托管后替换 url：');
console.log(JSON.stringify({
  engine: {
    source: {
      url: 'https://<托管域名>/' + encodeURIComponent(NAME),
      sha256: sha,
      version: version,
      bytes: bytes
    }
  }
}, null, 1));
