#!/usr/bin/env node
// 省token开关.mjs —— 把引擎自带的三个省 token 机制按需打开 / 关掉。
//
// 为什么要有它（而不是让人手改 YAML）：
//   ① 这是**行为变更**（会摘要历史、会截断工具返回），必须一条命令能回滚；
//   ② patch 文件是 YAML，手改缩进错一位，引擎启动就报错——脚本能写前校验、写完复核；
//   ③ 现状是 **disabled**：web 层把 `compaction-basic` 和 `command-compact` 关掉了
//      （`dsh --profile web --dump-config` 里能看到 `disabled: true`），所以今天那条
//      会话才会一路涨到 57.9 万上下文、每一步都重读一遍。
//
// 用法：
//   node 工具\省token开关.mjs --status              看现在开没开（读配置 + 跑 dump-config 复核）
//   node 工具\省token开关.mjs --on                  打开（默认 阈值 30% / 摘要后留 10%）
//   node 工具\省token开关.mjs --on --threshold 0.4 --retain 0.12
//   node 工具\省token开关.mjs --off                 关掉（整段删掉，回到出厂状态）
//   node 工具\省token开关.mjs --dry                 只打印要写的字节，不落盘
//   node 工具\省token开关.mjs --file <yml>          指定别的 patch 文件（自检用）
//
// 生效：改完**重启工作台**（引擎只在启动时读 profile patch）。
// 回滚：`--off`，再重启。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));          // 12-源码照搬\工具
const BASE = path.resolve(HERE, '..');                              // 12-源码照搬
const DSH_HOME = process.env.DSH_HOME || path.join(BASE, '引擎数据', '.dsh');
const DEFAULT_FILE = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
const ENGINE_BIN = path.join(BASE, '引擎', 'lib', 'bin.js');

const BEGIN = '# >>> 省token · 工具\\省token开关.mjs 管理（--off 删掉这一整段）';
const END = '# <<< 省token';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const file = path.resolve(val('--file', DEFAULT_FILE));
const dry = has('--dry');
const threshold = Number(val('--threshold', '0.3'));
const retain = Number(val('--retain', '0.1'));

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

// ---------- 1. 生成要插入的那段 ----------
function block(t, r) {
  if (!(t > 0 && t <= 1)) die('--threshold 要在 (0,1] 之间：' + t);
  if (!(r > 0 && r < t)) die('--retain 要在 (0, threshold) 之间：' + r);
  return [
    BEGIN,
    '# 引擎自带、但 web 层默认 disabled 的三个机制：',
    '#   compaction-basic      上下文到 thresholdRatio 就摘要，摘要后只留 retainRatio',
    '#   command-compact       /compact：手动压一次（不想等自动阈值时用）',
    '#   tool-result-pruner    单条工具返回超 thresholdChars 就截断成 head+tail',
    '# 判据：重启后 `node 工具\\用量账本.mjs` 看「上下文」是否被压住、不再一路涨。',
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  disabled: false',
    '  config:',
    '    thresholdRatio: ' + t,
    '    retainRatio: ' + r,
    '- id: command-compact',
    "  name: '@deepseek-ai/dsh-command-compact'",
    '  disabled: false',
    '- id: tool-result-pruner',
    "  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '  config:',
    '    thresholdChars: 4096',
    '    headChars: 1536',
    '    tailChars: 512',
    END
  ].join('\n');
}

// ---------- 2. 读现状 ----------
if (!fs.existsSync(file)) die('找不到配置：' + file);
const before = fs.readFileSync(file, 'utf8');
const eol = before.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
const b = before.split(/\r?\n/);
const i0 = b.findIndex((l) => l.trim() === BEGIN);
const i1 = b.findIndex((l) => l.trim() === END);
const on = i0 >= 0 && i1 > i0;

// 状态：dump-config 才是真话（配置里写了 disabled:false 也不代表插件真装上）
function dumpCheck() {
  try {
    const out = execFileSync(process.execPath, [ENGINE_BIN, '--profile', 'web', '--dump-config'], {
      encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { DSH_HOME })
    });
    const lines = out.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^-\s*id:\s*compaction-basic\s*$/.test(l));
    if (idx < 0) return { known: false, note: 'dump 里没找到 compaction-basic' };
    const chunk = lines.slice(idx, idx + 6).join('\n');
    return { known: true, disabled: /disabled:\s*true/.test(chunk), raw: chunk.split('\n').slice(0, 3).join(' | ') };
  } catch (e) {
    return { known: false, note: '跑不动 dump-config：' + ((e && e.message) || e) };
  }
}

if (has('--status') || (!has('--on') && !has('--off') && !has('--dry'))) {
  console.log('配置文件：' + file);
  console.log('脚本块：' + (on ? '已写入（第 ' + (i0 + 1) + '–' + (i1 + 1) + ' 行）' : '未写入（= 出厂状态，省 token 的三条都没开）'));
  const d = dumpCheck();
  if (!d.known) console.log('生效复核：' + d.note);
  else console.log('生效复核：compaction-basic ' + (d.disabled ? '仍是 disabled（重启后才会变）' : '已启用 ✓'));
  if (!on) console.log('\n要开：node 工具\\省token开关.mjs --on   然后重启工作台');
  process.exit(0);
}

// ---------- 3. 写入 / 删除 ----------
let next;
if (has('--off')) {
  if (!on) { console.log('本来就没开，不用动。'); process.exit(0); }
  // 连同块前那个空行一起删掉，并保持文件原来的结尾形态（有没有末尾空行）——否则 --on 再 --off 回不到原样
  const head = b.slice(0, i0);
  while (head.length && head[head.length - 1].trim() === '') head.pop();
  next = head.join(eol) + (/\r?\n$/.test(before) ? eol : '');
} else {
  const seg = block(threshold, retain).split('\n');
  const body = before.replace(/(\r?\n)+$/, '');
  next = on
    ? b.slice(0, i0).concat(seg, b.slice(i1 + 1)).join(eol)   // 已存在：整段替换（参数可改）
    : body + eol + eol + seg.join(eol) + eol;
}

// 写完前先自证：标记还在、数量正确、YAML 顶层仍是列表
const check = next.split(/\r?\n/);
const c0 = check.filter((l) => l.trim() === BEGIN).length;
const c1 = check.filter((l) => l.trim() === END).length;
if (has('--on') || (on && !has('--off'))) {
  if (c0 !== 1 || c1 !== 1) die('标记数量不对（BEGIN=' + c0 + ' END=' + c1 + '），未写入');
  const firstReal = check.find((l) => l.trim() && !l.trim().startsWith('#'));
  if (firstReal && firstReal.trim() !== '[]' && firstReal.trim()[0] !== '-') die('改完第一行不是列表项，未写入：' + firstReal);
}

if (dry) {
  console.log('---- 将要写回（--dry，未落盘）----');
  console.log(next);
  console.log('---- 结束 ----');
  process.exit(0);
}

// 落盘：先备份，再原编码写回（保留 CRLF）
const bak = path.join(os.tmpdir(), 'cordis.patch.' + Date.now() + '.bak.yml');
fs.writeFileSync(bak, before, 'utf8');
fs.writeFileSync(file, next, 'utf8');
console.log((has('--off') ? '已关闭' : '已打开') + '：' + file);
console.log('备份：' + bak);
console.log('下一步：重启工作台 —— 引擎只在启动时读这份 patch。');
console.log('复核：node 工具\\省token开关.mjs --status');
