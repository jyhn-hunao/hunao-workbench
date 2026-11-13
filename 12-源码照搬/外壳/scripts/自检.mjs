// 自检：Node 版本 / 引擎目录 / 场景 json / 渲染文件 / 端口（2026-11-04 按 code-ai 复核修三处）
// 用法：node 外壳\scripts\自检.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 2026-11-12 跨机器移植：端口不再在本文件写死，统一走 工具\环境.mjs（env > 机器配置.json > 默认）
import { port as envPort } from '../../工具/环境.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // 外壳\scripts
const SHELL = path.resolve(HERE, '..');                          // 外壳
const ROOT = path.resolve(SHELL, '..');                          // 12-源码照搬
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail || '' });

// 0) 先探端口（引擎判断要用）：引擎 / 界面 / 9876 Blender MCP
const net = await import('node:net');
const DSH_PORT = envPort('dsh');
const SITE_PORT = envPort('site');
const busy = [];
for (const port of [DSH_PORT, SITE_PORT, 9876]) {
  await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.setTimeout(400);
    s.once('connect', () => { busy.push(port); s.destroy(); resolve(); });
    s.once('timeout', () => { s.destroy(); resolve(); });
    s.once('error', () => resolve());
  });
}

// 1) Node（引擎要求 >=24.9，外壳自身 18+，整体按取严）
//    2026-11-13 修：原来只量「当前跑自检的这个进程」（往往是 22.x 的系统 node），
//    而工作台真正拉起引擎用的是 机器配置.json 的 nodeExe ⇒ 判据改成先量 nodeExe，量不到才退回本进程。
let nodeVer = String(process.versions.node || '0.0.0');
let nodeSrc = '当前进程';
try {
  const cfgFile = path.join(ROOT, '引擎数据', '.dsh', '机器配置.json');
  if (fs.existsSync(cfgFile)) {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg && cfg.nodeExe && fs.existsSync(cfg.nodeExe)) {
      const { execFileSync } = await import('node:child_process');
      const v = String(execFileSync(cfg.nodeExe, ['-v'], { encoding: 'utf8' }) || '').trim().replace(/^v/i, '');
      if (/^\d+\.\d+/.test(v)) { nodeVer = v; nodeSrc = '机器配置 nodeExe'; }
    }
  }
} catch (e) { /* 读不到就按本进程算，不因配置缺失误判 */ }
const major = Number(nodeVer.split('.')[0]);
const minor = Number(nodeVer.split('.')[1]);
const nodeOk = (major > 24) || (major === 24 && minor >= 9);
check('Node 版本', nodeOk, nodeVer + '（来源：' + nodeSrc + '；引擎要求 >=24.9）');

// 2) 引擎（三态：有本包引擎 / 复用外部已跑引擎 / 都没有）
// 2026-11-12 修（配置体检发现）：原来只认源码版布局 `引擎\apps\cli\lib\bin.js`，
//   本机装的是打包版 `引擎\lib\bin.js` ⇒ 引擎明明就位却报「缺引擎」，自检恒红一项。
//   两种布局都认：先打包版，再源码版，都没有才判缺。
const ENGINE_BINS = [
  path.join(ROOT, '引擎', 'lib', 'bin.js'),                  // 打包版（当前本机）
  path.join(ROOT, '引擎', 'apps', 'cli', 'lib', 'bin.js'),   // 源码版
];
const bin = ENGINE_BINS.find((p) => fs.existsSync(p)) || ENGINE_BINS[0];
if (fs.existsSync(bin)) check('引擎目录', true, '本包 引擎\\ 已就位（' + path.relative(ROOT, bin) + '）');
else if (busy.includes(DSH_PORT)) check('引擎目录', true, '⚠ 本包无 引擎\\，但 127.0.0.1:' + DSH_PORT + ' 已有引擎在跑（复用外部实例）');
else check('引擎目录', false, '缺 ' + bin + '（把 DSH 引擎整个搬成 12-源码照搬\\引擎）');

// 3) 场景 json
const scDir = path.join(SHELL, 'scenarios');
const scs = fs.existsSync(scDir) ? fs.readdirSync(scDir).filter((f) => f.endsWith('.json')) : [];
const bad = [];
for (const f of scs) {
  try { const j = JSON.parse(fs.readFileSync(path.join(scDir, f), 'utf8')); if (!Array.isArray(j.panels)) bad.push(f); }
  catch { bad.push(f); }
}
check('场景配置', scs.length >= 1 && bad.length === 0, scs.length + ' 个 json' + (bad.length ? '，异常: ' + bad.join(',') : ''));

// 4) 外壳文件（含 index.html 实际引用的 9 个脚本）
const need = [
  'main.js', 'preload.js', 'crash.js',
  'renderer/index.html', 'renderer/renderer.js', 'renderer/renderers.js',
  'renderer/styles.css', 'renderer/topbar-status.js', 'renderer/public-clean.js',
  'renderer/public-links.js', 'renderer/customer-start.js',
];
const miss = need.filter((f) => !fs.existsSync(path.join(SHELL, f)));
check('外壳文件', miss.length === 0, miss.length ? '缺: ' + miss.join(',') : need.length + '/' + need.length + ' 在');

// 5) 端口（只是提示）
check('端口', true, busy.length ? '已占用: ' + busy.join(',') + '（工作台已在跑属正常）' : DSH_PORT + '/' + SITE_PORT + '/9876 都空');

// 6) 私有插件落位（2026-11-12 跨机器移植必查）：插件\ 里有源码，但 profile 的 node_modules 里没落位
//    ⇒ 引擎按 bundles 解析不到该包（表现是 did not activate / ERR_MODULE_NOT_FOUND，不是配置错）
const PLUG = path.join(ROOT, '插件');
const PROF = path.join(ROOT, '引擎数据', '.dsh', 'profiles', 'web');
const readJ = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
if (!fs.existsSync(PROF)) {
  check('私有插件落位', true, '⚠ profile 未安装，跳过（引擎装好后跑 node 外壳\\scripts\\环境适配.mjs --apply）');
} else {
  const lost = [];
  if (fs.existsSync(PLUG)) {
    for (const d of fs.readdirSync(PLUG, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pkg = readJ(path.join(PLUG, d.name, 'package.json'));
      if (!pkg || !pkg.name) continue;
      if (!fs.existsSync(path.join(PROF, 'node_modules', pkg.name))) lost.push(pkg.name);
    }
  }
  check('私有插件落位', !lost.length,
    lost.length ? '未落位: ' + lost.join('、') + '（跑 node 外壳\\scripts\\环境适配.mjs --apply）' : '全部已落位');
}

// 7) 场景路径（2026-11-12 跨机器移植必查）：homeFolders / drives / repo 在本机是否存在
//    这三类是「本机值」，换机器后新值对不上时，面板会静默指向不存在的目录
const badPath = [];
for (const f of scs) {
  if (/\.bak\.json$/i.test(f)) continue;
  const j = readJ(path.join(scDir, f));
  if (!j) continue;
  for (const p of j.panels || []) {
    for (const h of p.homeFolders || []) if (!fs.existsSync(h)) badPath.push(f + ' homeFolders');
    for (const d of p.drives || []) if (!fs.existsSync(d + '\\')) badPath.push(f + ' drives ' + d);
    if (p.repo && !fs.existsSync(p.repo)) badPath.push(f + ' repo');
  }
}
check('场景路径', !badPath.length,
  badPath.length ? badPath.length + ' 处指向本机不存在: ' + badPath.slice(0, 3).join('；') + '（跑 环境适配.mjs --apply）' : 'homeFolders / drives / repo 全部命中');

// 8) 引擎更新提示（2026-11-13 新增）：只读 工具\引擎更新检查.mjs --notify 写的状态文件，**不联网**
//    为什么不在自检里直接查 npm：自检要能离线秒过；联网判断归 引擎更新检查.mjs，自检只负责把结果摆出来
const UPD_FILE = path.join(ROOT, '引擎数据', '.dsh', '引擎更新提示.json');
const upd = readJ(UPD_FILE);
check('引擎更新', true, upd
  ? (upd.hasUpdate
      ? '⚠ 有新版本 ' + upd.remoteVersion + '（本地 ' + upd.localVersion + '，检查于 ' + String(upd.checkedAt).slice(0, 16) + '）⇒ 见 doc\\引擎升级与版本兼容清单.md'
      : '已最新（本地 ' + upd.localVersion + '，检查于 ' + String(upd.checkedAt).slice(0, 16) + '）')
  : '未检查过（跑 node 工具\\引擎更新检查.mjs --notify）');

// 输出
let fail = 0;
for (const r of rows) {
  if (!r.ok) fail++;
  console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
}
console.log(fail ? '\n⛔ ' + fail + ' 项未通过，先修再启动' : '\n✅ 全部通过，可以启动（双击 启动.vbs 或 npm start）');
process.exit(fail ? 1 : 0);
