// 桥接.js —— QQ 个人号桥接（SnowLuma）的进程面（2026-11-13）
//
// 用户的要求原话：「把这个 snowluma 接入工作台，启动工作台时就一起启动了，省去单独启动；
//   面板也挂到社交场景，但是要作为设置按钮才打开，不是常驻面板。」
//
// 所以这一层只管三件事，不碰协议、不碰面板：
//   ① 随壳启动：壳 ready 后拉起 `node dist\index.mjs`（SnowLuma Lite），退出时一起收掉；
//   ② 生命周期归壳：像引擎一样不许外面单开一份（否则面板连的是"另一只"、关了壳它还在）；
//   ③ 供数给面板：status() 给端口通没通、账号密码、日志尾巴；start()/stop() 给按钮用。
//
// 落位（可移植做法，源码里不写死本机盘符）：
//   · 运行时的家：环境变量 SNOWLUMA_HOME → `外壳\data\桥接.json` 的 snowlumaHome → `<仓>\桥接\SnowLuma`
//     （data\ 整个目录已被 .gitignore 挡掉 ⇒ 本机路径只活在这台机器上，不进 git）
//   · 运行时要含 `dist\index.mjs`（自建步骤见 插件\社交通道\说明.md §10）
//   · 端口默认 5099（WebUI）；OneBot 的 3000/3001 由 SnowLuma 控制台里另建，不归这里管
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { probePort } = require('./社交');   // 端口探测复用同一份（只连 200ms，不做服务类型断言）

const ROOT = path.resolve(__dirname, '..');                       // 12-源码照搬
const DATA_DIR = path.join(__dirname, 'data');
const WORK_DIR = path.join(DATA_DIR, '桥接');
const LOG_FILE = path.join(WORK_DIR, 'snowluma.log');
const PID_FILE = path.join(WORK_DIR, 'snowluma.pid');
const DEFAULT_PORT = 5099;

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function readConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '桥接.json'), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

// 1. 找运行时的家：env → data 配置 → 仓内的「桥接\SnowLuma」
function resolveHome(cfg) {
  const cands = [];
  if (process.env.SNOWLUMA_HOME) cands.push(String(process.env.SNOWLUMA_HOME));
  if (cfg && cfg.snowlumaHome) cands.push(String(cfg.snowlumaHome));
  cands.push(path.join(ROOT, '桥接', 'SnowLuma'));
  for (const h of cands) {
    if (!h) continue;
    if (fs.existsSync(path.join(h, 'dist', 'index.mjs'))) return h;
  }
  return '';
}

// 1.1 找 Node：⛔ 不能用 process.execPath —— 在壳里那是 electron.exe，拉起来会变成再开一个 Electron
//     （用户只会看到"啥也没发生"）。顺序：data 配置 nodeExe → 环境变量 SNOWLUMA_NODE → PATH 里的 node
function resolveNode(cfg) {
  const cands = [];
  if (cfg && cfg.nodeExe) cands.push(String(cfg.nodeExe));
  if (process.env.SNOWLUMA_NODE) cands.push(String(process.env.SNOWLUMA_NODE));
  cands.push('node');
  for (const n of cands) {
    if (!n) continue;
    if (path.isAbsolute(n)) { if (fs.existsSync(n)) return n; continue; }
    return n;                                   // 交给 PATH 解析（spawn 会按 PATHEXT 找 node.exe）
  }
  return '';
}

function tailLines(file, n) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split(/\r?\n/).filter((x) => x.trim());
    return lines.slice(-(n || 6));
  } catch (e) { return []; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// 2. 剩下的旧进程：只有我们上次自己拉起的那只（pid 文件对得上）才敢收 ——
//    5099 上可能坐着别人的服务，不能见端口有在听就杀
function killLeftover() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; } catch (e) { pid = 0; }
  if (!pid || !isAlive(pid)) return false;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch (e) { /* ignore */ }
  try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
  return true;
}

function createService() {
  let child = null;
  let creds = null;
  let lastErr = '';
  let startedAt = 0;

  function log(line) {
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, '[' + nowStamp() + '] ' + line + '\r\n', 'utf8');
    } catch (e) { /* 日志写不进去也不能让桥接停摆 */ }
  }

  // 3. 收子进程的 stdout：密码行只在启动日志里出现一次 ⇒ 抓下来给面板/按钮用
  function onOutput(buf) {
    const txt = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      log(line);
      const m = /initial credentials:\s*user=(\S+)\s+password=(\S+)/.exec(line);
      if (m) creds = { user: m[1], password: m[2] };
      if (/listening http:\/\//.test(line)) startedAt = startedAt || Date.now();
    }
  }

  // 4. 状态：端口在听 = running；密码与日志尾巴一起给出去（面板的按钮/提示要用）
  async function status() {
    const cfg = readConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    const home = resolveHome(cfg);
    const running = await probePort(port);
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      running,
      port,
      url: 'http://127.0.0.1:' + port,
      home,
      own: !!child && !!child.pid,
      pid: child && child.pid ? child.pid : 0,
      credentials: creds,
      // 控制台登录用：账号固定 admin；密码 = 首次启动种下去的那个（配置里的 bootstrapPassword），
      // 用户若在控制台里改过密码，就以此后自己设的为准（这里给的是"出厂那一把"）
      passwordHint: cfg.bootstrapPassword ? String(cfg.bootstrapPassword) : '',
      error: lastErr,
      logFile: LOG_FILE,
      tail: tailLines(LOG_FILE, 6)
    };
  }

  // 5. 启动：已经在听就直接认（不重复拉起第二只）；找不到运行时就把原因说清，不静默
  async function start() {
    const cfg = readConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    const home = resolveHome(cfg);
    if (await probePort(port)) {
      return { ok: true, running: true, adopted: true, port, url: 'http://127.0.0.1:' + port, home,
        passwordHint: cfg.bootstrapPassword ? String(cfg.bootstrapPassword) : '' };
    }
    if (!home) {
      lastErr = '找不到 SnowLuma 运行时：设置 SNOWLUMA_HOME，或在 外壳\\data\\桥接.json 里写 snowlumaHome（要含 dist\\index.mjs）';
      log('[启动失败] ' + lastErr);
      return { ok: false, running: false, error: lastErr };
    }
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const nodeExe = resolveNode(cfg);
    if (!nodeExe) {
      lastErr = '找不到 node：在 外壳\\data\\桥接.json 里写 nodeExe（例：C:\\Program Files\\nodejs\\node.exe）';
      log('[启动失败] ' + lastErr);
      return { ok: false, running: false, error: lastErr };
    }
    let logFd = null;
    try {
      logFd = fs.openSync(LOG_FILE, 'a');
      // 首次启动时用我们给的密码种一次（SnowLuma 只在 config\webui.json 不存在时读这个环境变量）：
      // 否则它每次生成随机 16 位密码、只往终端打一遍 ⇒ 收进窗口后没人知道密码，登录不进去。
      const env = Object.assign({}, process.env);
      if (cfg && cfg.bootstrapPassword) env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = String(cfg.bootstrapPassword);
      child = spawn(nodeExe, ['index.mjs'], {
        cwd: path.join(home, 'dist'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env
      });
    } catch (e) {
      lastErr = '拉起 SnowLuma 失败：' + String((e && e.message) || e);
      log('[启动失败] ' + lastErr);
      return { ok: false, running: false, error: lastErr };
    } finally {
      if (logFd != null) { try { fs.closeSync(logFd); } catch (e) { /* ignore */ } }
    }
    creds = null;
    lastErr = '';
    startedAt = 0;
    // 6. 留 pid 文件：下次壳启动时只收"自己上次拉的那只"，绝不误杀别人占着 5099 的服务
    try { fs.writeFileSync(PID_FILE, String(child.pid || 0), 'utf8'); } catch (e) { /* ignore */ }
    log('拉起：' + nodeExe + ' index.mjs（cwd=' + path.join(home, 'dist') + '，pid=' + (child.pid || 0) + '）');
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (e) => {
      lastErr = String((e && e.message) || e);
      log('[子进程错误] ' + lastErr);
      child = null;
      try { fs.unlinkSync(PID_FILE); } catch (e2) { /* ignore */ }
    });
    child.once('exit', (code, sig) => {
      log('[子进程退出] code=' + code + ' sig=' + (sig || ''));
      child = null;
      try { fs.unlinkSync(PID_FILE); } catch (e2) { /* ignore */ }
    });
    return {
      ok: true, running: true, starting: true, port,
      url: 'http://127.0.0.1:' + port, home, pid: child.pid || 0,
      passwordHint: cfg.bootstrapPassword ? String(cfg.bootstrapPassword) : ''
    };
  }

  // 7. 停止：只停自己拉的那只（taskkill /T 连它可能再起的子进程一起收）
  function stop() {
    const pid = child && child.pid ? child.pid : 0;
    if (!pid) {
      try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
      return { ok: true, running: false };
    }
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch (e) { try { child.kill(); } catch (e2) { /* ignore */ } }
    log('停止：pid=' + pid);
    child = null;
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    return { ok: true, running: false };
  }

  // 8. 随壳启动：先收掉上次自己留下的那只（壳崩过一次时端口会被占着）
  async function autoStart() {
    const cfg = readConfig();
    if (cfg.enabled === false) { log('data\\桥接.json 里 enabled=false ⇒ 不随壳启动'); return { ok: true, skipped: true }; }
    if (killLeftover()) log('收掉上次遗留的 SnowLuma 进程后重新拉起');
    const r = await start();
    if (!r.ok) log('[随壳启动失败] ' + (r.error || '未知原因'));
    return r;
  }

  return { status, start, stop, autoStart, resolveHome, LOG_FILE };
}

module.exports = { createService, resolveHome, resolveNode, readConfig, LOG_FILE };
