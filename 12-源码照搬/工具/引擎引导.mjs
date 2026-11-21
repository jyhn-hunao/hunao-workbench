#!/usr/bin/env node
// @功能台 {"name":"引擎引导","group":"引擎","freq":"按需","plain":"查引擎装没装；没装就按 机器配置.json 的下载源下一份自包含引擎包装进来。","why":"安装包不随引擎分发，首启要能自己把引擎补齐；下载源和 sha256 必须可核对。","label":"引擎下载/检测"}
// 引擎引导.mjs —— 引擎检测 / 首启下载的命令行入口（与 外壳\引擎引导.js 同一套逻辑）
//
// 用法：
//   node 工具\引擎引导.mjs check                  # 只看：装没装、版本、下载源配没配
//   node 工具\引擎引导.mjs apply                  # 按机器配置.json 的 engine.source 下载并安装
//   node 工具\引擎引导.mjs apply --url <url> --sha256 <64位> [--version x.y.z] [--force]
//   node 工具\引擎引导.mjs check --json           # 机器读
//
// 退出码：0 通过 / 1 引擎未就位或安装失败 / 2 下载源没配好
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);
const engineBoot = require(path.join(ROOT, '外壳', '引擎引导.js'));

const argv = process.argv.slice(2);
const has = k => argv.includes(k);
const val = k => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : ''; };
const cmd = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'check';
const asJson = has('--json');
const force = has('--force');

const ENGINE_DIR = val('--dir') || process.env.DSH_ENGINE_DIR || path.join(ROOT, '引擎');
const CONFIG = process.env.DSH_MACHINE_FILE || path.join(ROOT, '引擎数据', '.dsh', '机器配置.json');
const SHIPPED = path.join(ROOT, '外壳', '引擎源.json');

function human(bytes) {
  if (!bytes) return '—';
  if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function readSource() {
  return engineBoot.readSource({ configPath: CONFIG, shippedPath: SHIPPED });
}

// 1. check：引擎 + 下载源两张状态
function cmdCheck() {
  const d = engineBoot.detect(ENGINE_DIR);
  const src = readSource();
  const out = {
    engineDir: ENGINE_DIR,
    installed: d.ok,
    version: d.version || '',
    layout: d.layout || '',
    entry: d.entry || '',
    reason: d.reason || '',
    source: { url: src.url, sha256: src.sha256, version: src.version, ok: src.ok, problems: src.problems, origin: src.origin }
  };
  if (asJson) { console.log(JSON.stringify(out, null, 1)); return d.ok ? 0 : 1; }
  console.log('引擎目录：' + ENGINE_DIR);
  console.log(d.ok
    ? '✓ 已就位 · ' + (d.version || '版本未知') + ' · ' + d.layout + ' 布局'
    : '✗ 未就位 · ' + d.text);
  console.log('下载源：' + (src.ok ? '✓ 已配好（' + src.origin.join(' / ') + '）' : '✗ ' + src.problems.join('；')));
  if (src.url) console.log('  url   ：' + src.url);
  if (src.sha256) console.log('  sha256：' + src.sha256);
  if (src.version) console.log('  版本  ：' + src.version);
  return d.ok ? 0 : 1;
}

// 2. apply：下载 + 校验 + 安装
async function cmdApply() {
  let src = readSource();
  // 2.1 命令行参数覆盖（调试 / 内网发布用）
  if (val('--url') || val('--sha256')) {
    src = Object.assign({}, src, {
      url: val('--url') || src.url,
      sha256: val('--sha256') || src.sha256,
      version: val('--version') || src.version
    });
    src.ok = !!src.url && /^[0-9a-f]{64}$/i.test(src.sha256);
    src.problems = [];
    if (!src.url) src.problems.push('缺少 --url');
    if (!src.ok) src.problems.push('--sha256 需 64 位十六进制');
  }
  if (!src.ok) {
    console.error('✗ 下载源没配好：' + src.problems.join('；'));
    console.error('  在 机器配置.json 里加 engine.source = { url, sha256, version }，或用 --url / --sha256 传入');
    return 2;
  }

  let lastLine = '';
  const r = await engineBoot.ensure({
    root: ENGINE_DIR,
    source: src,
    force: force,
    onProgress: function (p) {
      if (asJson) return;
      // 2.2 终端只刷一行进度（CI 日志不至于爆）
      if (p.phase === 'download') {
        const line = '  下载 ' + String(p.pct || 0).padStart(3) + '% · ' + human(p.bytes) + (p.total ? ' / ' + human(p.total) : '') + (p.speed ? ' · ' + human(p.speed) + '/s' : '');
        process.stdout.write('\r' + line.padEnd(lastLine.length));
        lastLine = line;
      } else if (p.phase === 'verify' || p.phase === 'extract' || p.phase === 'install') {
        if (lastLine) process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
        lastLine = '';
        console.log('  ' + p.text);
      }
    }
  });
  if (lastLine) process.stdout.write('\n');
  if (asJson) { console.log(JSON.stringify(r, null, 1)); return r.ok ? 0 : 1; }
  if (!r.ok) { console.error('✗ ' + (r.err || '安装失败')); return 1; }
  if (r.skipped) { console.log('✓ 引擎已就位，跳过下载（要重装加 --force）'); return 0; }
  console.log('✓ 引擎已装好：' + (r.version || '版本未知') + ' · ' + human(r.bytes) + ' · 用时 ' + r.seconds + 's');
  console.log('  目录：' + r.root);
  return 0;
}

// 3. source：只打印解析后的下载源（不含任何密钥）
function cmdSource() {
  const src = readSource();
  console.log(JSON.stringify(src, null, 1));
  return src.ok ? 0 : 2;
}

const CMDS = { check: cmdCheck, apply: cmdApply, source: cmdSource };
const fn = CMDS[cmd];
if (!fn) {
  console.error('未知命令：' + cmd + '（可用：check / apply / source）');
  process.exit(64);
}
Promise.resolve(fn()).then(code => process.exit(code || 0)).catch(e => {
  console.error('✗ ' + ((e && e.message) || e));
  if (e && e.code) console.error('  code: ' + e.code);
  process.exit(1);
});
