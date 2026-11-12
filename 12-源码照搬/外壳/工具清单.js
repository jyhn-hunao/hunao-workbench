// 工具清单.js —— 扫描「引擎里已安装且启用」的工具插件，产出工具面板要的清单结构。
// 为什么要单文件：main.js 已经 280KB；这份扫描要能脱离 Electron 用 `node 工具清单.js --json` 自测。
//
// 数据来源（每一层都能指到文件，全部由引擎自带，不需要人维护）：
//   ① 启用名单：<引擎>\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml
//      形式是 `- id: xxx` + `name: '@deepseek-ai/dsh-tool-yyy'`，`disabled: true` 的不算启用；
//   ② 中文名 / 一句话说明：每个工具包自带的 `locale\zh.json`（meta.title / meta.description）；
//   ③ 兜底：包 package.json 的 description（英文，面板会原样显示，不做假翻译）。
'use strict';
const fs = require('fs');
const path = require('path');

// 1. 包名前缀 → 面板分组（组名 + 一句组说明）
const GROUPS = [
  [/^dsh-tool-(fs|fs-search)$/, '文件与搜索', '读写、检索本机文件'],
  [/^dsh-tool-(pwsh|bash|pwsh-persistent|bash-persistent)$/, '终端', '执行命令，persistent 版保留会话'],
  [/^dsh-tool-web$/, '网页', '搜索与抓取网页'],
  [/^dsh-tool-(subagent|subagent-control|jobs)$/, '子代理与任务', '派给子代理、管理后台任务'],
  [/^dsh-tool-(todo|goal|schedule|workflow)$/, '计划与流程', '待办、目标、定时与工作流'],
  [/^dsh-tool-(present|ask-user|skill|cordis)$/, '交互与扩展', '呈现、提问、技能与插件'],
];

// 2. 解析 dsh-base 的 patch：拿到「启用」的工具插件包名
function enabledToolPackages(patchFile) {
  const out = [];
  let cur = null;
  const txt = fs.readFileSync(patchFile, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+id:\s*(\S+)/);
    if (m) { if (cur && cur.name && !cur.disabled) out.push(cur.name); cur = { id: m[1], name: '', disabled: false }; continue; }
    if (!cur) continue;
    const n = line.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?/);
    if (n) cur.name = n[1];
    if (/^\s*disabled:\s*true\b/.test(line)) cur.disabled = true;
  }
  if (cur && cur.name && !cur.disabled) out.push(cur.name);
  return out.filter((n) => /(^|\/)dsh-tool-[\w-]+$/.test(n)).map((n) => n.split('/').pop());
}

// 3. 一个包 → 一条面板条目
function itemOf(nmDir, pkg) {
  const dir = path.join(nmDir, pkg);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'locale', 'zh.json'), 'utf8')).meta || {}; } catch (e) { /* 该包没中文 locale */ }
  let desc = '';
  try { desc = String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).description || ''); } catch (e) { /* ignore */ }
  return {
    name: meta.title || pkg.replace(/^dsh-tool-/, ''),
    tag: pkg.replace(/^dsh-tool-/, ''),
    plain: meta.description || desc || '（该包没写说明）',
    how: '随引擎安装，启用即生效',
    where: '引擎\\node_modules\\@deepseek-ai\\' + pkg
  };
}

// 4. 主入口：返回 { groups, note, scanned }，结构与旧 工具清单.json 兼容
function buildCatalog(opts) {
  const harnessDir = (opts && opts.harnessDir) || path.resolve(__dirname, '..', '引擎');
  const nmDir = path.join(harnessDir, 'node_modules', '@deepseek-ai');
  const patchFile = path.join(nmDir, 'dsh-base', 'cordis.patch.yml');
  // 启用名单 = 基础 bundle + 用户 profile 的 patch（profile 里新加的行也算启用，2026-11-12）
  // 默认也读本机 profile 的 patch（CLI 自测要反映真实启用状态）
  const patchFiles = [patchFile].concat((opts && opts.extraPatches) || [path.resolve(__dirname, '..', '引擎数据', '.dsh', 'profiles', 'web', 'cordis.patch.yml')]);
  let enabled = [];
  for (const pf of patchFiles) { try { enabled = enabled.concat(enabledToolPackages(pf)); } catch (e) { /* 缺哪层就跳过哪层 */ } }
  enabled = [...new Set(enabled)];
  // 已安装 = 目录里真的有的 dsh-tool-* 包；启用 = patch 里列了且没 disabled
  const installed = fs.existsSync(nmDir) ? fs.readdirSync(nmDir).filter((n) => /^dsh-tool-[\w-]+$/.test(n)) : [];
  // 1. 先列启用的（按 patch 顺序），再列「装了但默认 profile 没启用」的，免得面板漏报工具
  const names = enabled.concat(installed.filter((n) => enabled.indexOf(n) < 0));
  const groups = [];
  for (const pkg of names) {
    if (!fs.existsSync(path.join(nmDir, pkg))) continue;
    const g = GROUPS.find((x) => x[0].test(pkg)) || [/^$/, '其他', '其余工具'];
    let box = groups.find((x) => x.title === g[1]);
    if (!box) { box = { title: g[1], note: g[2], sections: [{ title: '', items: [] }] }; groups.push(box); }
    const item = itemOf(nmDir, pkg);
    if (enabled.indexOf(pkg) < 0) {
      item.tag += ' · 未启用';
      item.how = '已安装，但默认 profile 没启用（要在 profile 的 cordis.patch.yml 里加一行才生效）';
    }
    box.sections[0].items.push(item);
  }
  const total = groups.reduce((a, g) => a + g.sections[0].items.length, 0);
  // 「启用」按真正列出的条目标记算（patch 里可能有包不存在，别把 14 当成已启用数）
  const enabledCount = groups.reduce((a, g) => a + g.sections[0].items.filter((it) => it.tag.indexOf('未启用') < 0).length, 0);
  return {
    updated: null, scanned: true, groups,
    note: '实时扫描：' + total + ' 个工具包（启用 ' + enabledCount + ' 个）· 新增 dsh-tool-* 包即出现，无需维护清单'
  };
}

module.exports = { buildCatalog, enabledToolPackages };

// 命令行自测：node 12-源码照搬\外壳\工具清单.js [--json]
if (require.main === module) {
  const c = buildCatalog();
  if (process.argv.includes('--json')) console.log(JSON.stringify(c, null, 1));
  else {
    console.log(c.note);
    for (const g of c.groups) for (const it of g.sections[0].items) console.log('  [' + g.title + '] ' + it.name + ' | ' + it.tag + ' | ' + it.plain);
  }
}
