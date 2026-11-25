#!/usr/bin/env node
// @功能台 {"name":"场景能力","group":"guard","freq":"weekly","plain":"看每个场景现在能干什么 / 认一件事该归哪个场景","why":"场景边界与派发口径核对","label":"跑一遍"}
// 场景能力.mjs —— 「场景 = 能力容器」的 CLI（2026-11-25）
// 两个用途：
//   ① 任何场景会话认「这事该谁做」：查 --词 "B站关注up主" → 命中的场景 + 会话标题 + 派发命令；
//   ② 让人看到某个场景现在有哪些功能：列 / 生成（面板「能力」弹窗读同一份算法，不另写一套）。
//
// 用法：
//   node 12-源码照搬\工具\场景能力.mjs 列
//   node 12-源码照搬\工具\场景能力.mjs 查 --词 "B站关注up主"
//   node 12-源码照搬\工具\场景能力.mjs 生成            # 写 外壳\data\场景能力.json + scenarios\_场景能力.md
// 退出码：0 成功 / 2 认不出（列候选）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DSH_SHELL_DATA || path.join(ROOT, '外壳', 'data');
const DSH = process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh');
const abil = require('../外壳/场景能力.js')({ dataDir: DATA, dshHome: DSH, reviewDir: '' });

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '列');   // 不带参数 = 列（功能台「跑一遍」直接跑这条）
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };

function cmdList() {
  for (const s of abil.all()) {
    console.log('■ ' + s.name + '（' + s.id + '）');
    console.log('  会话：' + (s.session || '不绑会话'));
    console.log('  能接：' + s.keywords.join(' / '));
    console.log('  面板：' + s.panels.map((p) => p.title + '（' + p.kind + '）').join(' · '));
    if (s.entries.length) console.log('  工具条：' + s.entries.map((e) => e.label + '（' + e.desc + '）').join(' / '));
    if (s.settings.length) console.log('  设置：' + s.settings.map((x) => x.title).join(' / '));
    if (s.mechanisms.length) console.log('  机制：' + s.mechanisms.join('；'));
    if (s.commands.length) console.log('  命令：' + s.commands.join('  ·  '));
    console.log('');
  }
  return 0;
}

function cmdFind() {
  const text = val('--词', argv.slice(1).join(' '));
  if (!text) { console.log('✗ 用法：场景能力.mjs 查 --词 "<原话>"'); return 2; }
  const r = abil.find(text);
  if (!r) {
    console.log('✗ 没有场景认领这句话。候选：' + abil.all().map((s) => s.name + '（' + s.id + '）').join(' / '));
    return 2;
  }
  console.log('✓ 「' + r.scene.name + '」（' + r.scene.id + '）能吃这件事 · 命中：' + r.matched.join('、'));
  console.log('  会话：' + (r.scene.session || '不绑会话'));
  console.log('  交给它：node 12-源码照搬\\工具\\派发.mjs --词 "<原话>"（自动认场景，省得记会话名）');
  if (r.scene.session) console.log('  定向下单：node 12-源码照搬\\工具\\派发.mjs --to "' + r.scene.session + '" "<原话>"');
  console.log('  它能用：' + r.scene.entries.map((e) => e.label).join(' / ') + (r.scene.panels.length ? ' · 面板 ' + r.scene.panels.map((p) => p.title).join(' / ') : ''));
  if (r.scene.mechanisms.length) console.log('  它的机制：' + r.scene.mechanisms.join('；'));
  return 0;
}

// 机制：大脑要知道「这双手现在怎么干活」（频次 / 闸门 / 产出落哪 / 边界）
function cmdMech() {
  const id = val('--场景', '');
  const list = abil.all();
  if (!id) {
    console.log('用法：场景能力.mjs 机制 --场景 <场景id>；可选：' + list.map((s) => s.id).join(' / '));
    return 0;
  }
  const s = list.find((x) => x.id === id) || null;
  if (!s) { console.log('✗ 没有这个场景：' + id + '；候选：' + list.map((x) => x.id).join(' / ')); return 2; }
  console.log('■ ' + s.name + '（' + s.id + '）  会话：' + (s.session || '不绑会话'));
  if (s.mechanisms.length) s.mechanisms.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + m));
  else console.log('  （还没写机制：去 外壳\\场景能力.js 的 MECHANISMS 补）');
  if (s.commands.length) console.log('  命令：' + s.commands.join('  ·  '));
  return 0;
}

// 人格的场景索引：从机制表自动重建（大脑不用记命令，看这张表就够）
function writePersonaIndex(list) {
  const dir = path.join(DSH, '场景记忆', '胡闹的大肥鱼');
  fs.mkdirSync(dir, { recursive: true });
  const md = [];
  md.push('# 人格层 · 场景索引（自动生成，别手改）');
  md.push('');
  md.push('> 生成：`node 12-源码照搬\\工具\\场景能力.mjs 生成`；机制真源在 `外壳\\场景能力.js` 的 `MECHANISMS`。');
  md.push('> 要上下文：`场景记忆.mjs 读 --场景 <场景> --节 §〇`（只取交接，别整读）；要派活：`派发.mjs --词 "<原话>"`。');
  md.push('> 规矩：业务场景的记忆只读不写；要改由那个场景自己的会话改。');
  md.push('');
  md.push('| 用户可能这么说 | 场景 | 会话 | 它现在怎么干（机制） |');
  md.push('|---|---|---|---|');
  for (const s of list) {
    const kws = s.keywords.slice(0, 5).join(' / ') || s.name;
    const mech = s.mechanisms.length ? s.mechanisms.join('<br>') : '（还没写机制）';
    md.push('| ' + kws + ' | ' + s.name + '（`' + s.id + '`） | ' + (s.session || '不绑会话（本会话做）') + ' | ' + mech + ' |');
  }
  md.push('');
  md.push('## 派发与回执');
  md.push('');
  md.push('- 派活：`node 12-源码照搬\\工具\\派发.mjs --词 "<原话>"`（自动认场景与会话，认不出列候选）');
  md.push('- 人格走审批：`node 12-源码照搬\\工具\\桌宠.mjs 派 --文本 "<原话>"`（三种结果：派给 X / 归 X 但无会话 / 认不出）');
  md.push('- 收尾：`node 12-源码照搬\\工具\\回执.mjs --ticket <单号> --summary "<结论>"`');
  md.push('- 查机制：`node 12-源码照搬\\工具\\场景能力.mjs 机制 --场景 <id>`');
  md.push('- ⛔ 项目名只认 `场景记忆\\_共享记忆\\项目.json`；认不出列候选问用户');
  const file = path.join(dir, '_场景索引.md');
  fs.writeFileSync(file, md.join('\n') + '\n', 'utf8');
  return file;
}

function cmdGen() {
  const list = abil.all();
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, '场景能力.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scenes: list }, null, 2) + '\n', 'utf8');

  const md = [];
  md.push('# 场景能力目录（自动生成，别手改）');
  md.push('');
  md.push('> 生成：`node 12-源码照搬\\工具\\场景能力.mjs 生成`（从 `scenarios\\*.json` 的面板 / 工具条按钮 + `外壳\\场景配置.js` 的设置项现算）。');
  md.push('> 用途：① 任何场景会话认「这事该谁做」（`场景能力.mjs 查 --词 "<原话>"`）；② 面板「能力」弹窗读同一份数据。');
  md.push('> 关键词表在 `外壳\\场景能力.js` 的 `KEYWORDS`，改它要跟 `外壳\\data\\pet\\设置.json` 的 routes 对齐。');
  md.push('');
  for (const s of list) {
    md.push('## ' + s.name + '（`' + s.id + '`）');
    md.push('');
    md.push('> ' + (s.summary || ''));
    md.push('');
    md.push('| 项 | 内容 |');
    md.push('|---|---|');
    md.push('| 会话 | ' + (s.session || '不绑会话') + ' |');
    md.push('| 能接 | ' + s.keywords.join(' / ') + ' |');
    md.push('| 面板 | ' + s.panels.map((p) => p.title + '（' + p.kind + '）').join(' · ') + ' |');
    if (s.entries.length) md.push('| 工具条 | ' + s.entries.map((e) => e.label + '｜' + e.desc).join('<br>') + ' |');
    if (s.settings.length) md.push('| 设置项 | ' + s.settings.map((x) => x.title).join(' / ') + ' |');
    if (s.mechanisms.length) md.push('| 机制 | ' + s.mechanisms.join('<br>') + ' |');
    if (s.commands.length) md.push('| 命令 | ' + s.commands.map((c) => '`' + c + '`').join('<br>') + ' |');
    md.push('');
  }
  fs.writeFileSync(path.join(ROOT, '外壳', 'scenarios', '_场景能力.md'), md.join('\n') + '\n', 'utf8');
  const personaIndex = writePersonaIndex(list);
  console.log('✓ 外壳\\data\\场景能力.json（' + list.length + ' 个场景）+ 外壳\\scenarios\\_场景能力.md');
  console.log('✓ 人格场景索引：' + path.relative(ROOT, personaIndex));
  return 0;
}

const TABLE = { 列: cmdList, 查: cmdFind, 机制: cmdMech, 生成: cmdGen, '--help': () => { console.log('用法：场景能力.mjs 列 | 查 --词 "<原话>" | 机制 --场景 <id> | 生成'); return 0; } };
const fn = TABLE[cmd];
if (!fn) { console.log('用法：场景能力.mjs 列 | 查 --词 "<原话>" | 机制 --场景 <id> | 生成'); process.exit(2); }
process.exit(fn());
