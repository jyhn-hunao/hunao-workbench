// DSH 引擎 desktop window (Electron wrapper) — 多场景版
// 场景 0：内嵌 DSH 引擎 Web UI（带 token，默认初始界面）
// 场景 1：<客户> OA 系统运维（本地渲染）
// 场景 2：大A / 美股分析（本地渲染）
// 设计：壳与 Harness 解耦——只通过 HTTP+token 认识它；场景配置在 scenarios/ 下。
//
// ⚠ 本文件 5,700+ 行，改之前先看 `外壳\架构索引.md`（分段表 + 段起行 + 函数索引命令）。
//   定位方式：grep 段标题里的中文关键词，别整文件重排/格式化（会造出几万行 diff）。
//   本文件属"壳"层：改完必须重启工作台才生效（renderer\ 下的文件才走 ⟳ 热更新）。
const { app, BrowserWindow, dialog, shell, ipcMain, clipboard, webContents, nativeImage, screen } = require('electron');
const { spawn, spawnSync, execFile } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// ---- 数据根（2026-11-21）：必须在加载本地模块之前定下来 ----
// 为什么提前：社交状态 / 桥接 / 微信 / 功能台等模块在 require 时就会算数据路径；
//   如果等模块加载完再写 env，它们已经按 `resources\app\data` 算死，安装版会写进安装目录。
// 安装版：数据与安装目录分家；源码版：仍是 `外壳\data`（行为不变）。
const PACKAGED = !!app.isPackaged;
const DATA_HOME = process.env.DSH_DATA_HOME || (PACKAGED
  ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), '胡闹的工作台')
  : path.join(__dirname, 'data'));
// 引擎目录：**优先按"与本工作台同级"推导**（换电脑 / 换盘符都不用改这行），推不出来才退回写死值。
const HARNESS_DIR = (function () {
  const sibling = path.join(path.dirname(__dirname), '引擎');
  try { if (fs.existsSync(path.join(sibling, 'apps', 'cli'))) return sibling; } catch (e) { process.stderr.write('[main] 引擎目录探测失败：' + String((e && e.message) || e) + '\n'); }
  return path.join(path.dirname(__dirname), '引擎');
})();
const DSH_HOME = process.env.DSH_CUSTOMER_HOME || (PACKAGED
  ? path.join(DATA_HOME, 'engine-data', '.dsh')
  : path.join(HARNESS_DIR, '.dsh'));
const SHELL_DATA_DIR = process.env.DSH_SHELL_DATA || (PACKAGED
  ? path.join(DATA_HOME, 'data')
  : path.join(__dirname, 'data'));
process.env.DSH_DATA_HOME = DATA_HOME;
process.env.DSH_SHELL_DIR = __dirname;
process.env.DSH_SHELL_DATA = SHELL_DATA_DIR;
// 各子模块（社交档案 / 桌宠设置 / 桥接 / 功能台…）都按 env 找 home；这里统一写回，
// 否则安装版会各自退回 `resources\引擎数据`，同一个进程里出现两份数据目录。
process.env.DSH_CUSTOMER_HOME = process.env.DSH_CUSTOMER_HOME || DSH_HOME;
process.env.DSH_HOME = DSH_HOME;
const MACHINE_FILE_EARLY = process.env.DSH_MACHINE_FILE || (PACKAGED
  ? path.join(DSH_HOME, '机器配置.json')
  : path.join(__dirname, '..', '引擎数据', '.dsh', '机器配置.json'));

const projectSwitch = require('./项目切换');   // 程序开发场景「项目下拉」的数据面（可单测：scripts\项目切换自检.mjs）
const engineBoot = require('./引擎引导');       // 首启下载引擎：检测 / 下载 / sha256 / 解包 / 整目录替换（可单测：工具\引擎引导.mjs）
const socialSvc = require('./社交');           // 社交场景「消息流」的数据面（只读 transcript + 探 OneBot 端口；可单测：工具\消息流.mjs）
const qqChatSvc = require('./QQ会话');         // QQ 私聊/群聊独立 DSH 会话路由（建会话 + 写 qq-bridge routes）
const qqMediaSvc = require('./QQ能力');        // QQ 媒体能力：语音转写 / 语音合成（不碰第三方插件）
const qqGroupSvc = require('./QQ群聊');        // QQ 群旁听 + 随机接话（不抢 @ 原生路由）
const bridgeSvc = require('./桥接');           // QQ 个人号桥接（SnowLuma）的进程面：随壳启动/退出、面板按钮按需打开
const wechatSvc = require('./微信通道');       // 微信个人号通道（whale_girl）的进程面 + 31241 换脑适配器
const outGateSvc = require('./外发闸门');       // 外发安全闸门：QQ 代理 + 正文判定 + 审计（唯一判据出处）
const petSvc = require('./桌宠设置');          // 桌宠层的机器可读设置 + 路由打分 + 派发日志（面板与 工具\桌宠.mjs 共用）
const chatArchiveSvc = require('./社交档案');   // 聊天长期档案：SnowLuma messages.db → 本地 SQLite/FTS5（只读源库）
const socialStateSvc = require('./社交状态');    // 关系 + 情绪：数据根下的 社交关系.json / 社交情绪.json（可观测、可配置）

// ---- 端口真源（2026-11-20）：env > 机器配置.json 的 ports > 默认 ----
// 为什么补这一层：控制台的「机器层」展示的是 机器配置.json 的 ports，但主进程原来只认 env / 写死默认；
//   改机器配置后，脚本（工具\环境.mjs）按新端口连，外壳还在老端口听 ⇒ 两边错位。
// ⛔ 默认值只留在这里与 工具\环境.mjs 的 DEFAULT_PORTS；别处不许再写端口字面量。

// 安装版首启：建数据目录 + 不覆盖地写机器配置 + 种入 skills / standards
const firstRunData = require('./首启数据');
let firstRunInfo = null;
if (PACKAGED) {
  firstRunInfo = firstRunData.prepare({
    dataHome: DATA_HOME, shellDir: __dirname, engineDir: HARNESS_DIR,
    seedDir: path.join(process.resourcesPath, '种子数据', '.dsh'),
  });
}
function machinePort(name, def) {
  try {
    const j = JSON.parse(fs.readFileSync(MACHINE_FILE_EARLY, 'utf8'));
    const n = Number(j && j.ports && j.ports[name]);
    return (Number.isFinite(n) && n > 0 && n < 65536) ? n : def;
  } catch (e) { return def; }
}
const DSH_PORT = String(process.env.DSH_PORT || machinePort('dsh', 3083));
const BASE = 'http://127.0.0.1:' + DSH_PORT;
// 客户包：把外壳目录暴露给 preload / renderer（读 data\boot-animation.json 用）
process.env.DSH_SHELL_DIR = __dirname;

// ⭐ 应用身份（AppUserModelID）：必须在 **app ready 之前**调用才对 Windows 任务栏生效。
//   2026-10-13 查明：原来这行写在 app.whenReady() 回调里（文件靠后位置）⇒ Windows 认不出身份，
//   任务栏右键菜单里显示成「Electron」、图标退回 Electron 原子图标 ✗。提到顶部即可。
//   配套：开始菜单/桌面那两条「工作台」快捷方式必须带同一个 AUMID（脚本 %TEMP%\set-lnk-aumid2.ps1 写过）。
app.setAppUserModelId('deepseek.harness.gui.v2');   // 2026-10-13 换新身份：旧的 deepseek.harness.gui 已被 Windows 按身份缓存成原子图标，绕开它
// 引擎目录：**优先按"与本工作台同级"推导**（换电脑 / 换盘符都不用改这行），推不出来才退回写死值。
// 2026-10-10 为「换电脑一比一复制」加（见 项目信息.md §39）：只要引擎与工作台仍是同级目录，任何盘符都能跑。
const NPM_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
const PNPM_CMD = path.join(NPM_BIN, 'pnpm.cmd');
// 引擎 home（会话 / 存储 / 场景记忆都在这里）：安装版已在上方算成安装目录之外；
// 源码版由 启动.vbs 用 DSH_CUSTOMER_HOME 指到「引擎数据\.dsh」，没设时退回「引擎\.dsh」。
const LOG_FILE = PACKAGED ? path.join(DATA_HOME, 'server.log') : path.join(__dirname, 'server.log');
const LOG_PREV = path.join(__dirname, 'server.log.prev');
const LOG_MAX_BYTES = 4 * 1024 * 1024;   // 超过 4MB 就轮转，只留上一份（见 rotateLog）

// ---- 日志轮转：日志只增不减会把根目录搞得乱七八糟（曾经涨到 3MB+ 且没有上限）----
// 启动时检查一次：超过上限就把旧日志改名为 server.log.prev（覆盖更早的那份），新日志从空开始。
// 只保留 1 份历史，避免"日志文件越堆越多"这种典型的目录污染。
function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    try { fs.rmSync(LOG_PREV, { force: true }); } catch (e) { warnOnce("main", e) }
    fs.renameSync(LOG_FILE, LOG_PREV);
  } catch (e) { warnOnce("main", e) }
}
// rotateLog() 挪到 warnOnce 定义之后再调：首次启动日志文件还不存在时，
// catch 里会走 warnOnce，而 warnOnce 依赖的 WARN_SEEN / WARN_IN 还没初始化（TDZ 崩溃）。
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
// 数据面在 项目切换.js（列项目 / 定点改场景 json / 同步定位卡与索引），这里只接 fs 与 IPC。
// 口径：一条会话 = 一个项目（会话 cwd = 项目根），所以「切项目」就是改面板钉的那条会话。
const projectSwitchSvc = projectSwitch.createService({
  scenariosDir: SCENARIOS_DIR,
  dshHome: DSH_HOME,
  // 扫同级目录时跳过壳自己与工作台根（它们不是"能接进来干活的项目"）
  exclude: [__dirname, path.resolve(__dirname, '..')],
  fsx: {
    readText: function (p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
    writeText: function (p, t) { fs.writeFileSync(p, t, 'utf8'); },
    exists: function (p) { try { return fs.existsSync(p); } catch (e) { return false; } },
    readDir: function (p) { try { return fs.readdirSync(p); } catch (e) { return []; } },
    isDir: function (p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
  }
});

// ---- 保命入口服务（127.0.0.1:SITE_PORT）----
// 2026-11-12：个人站场景（官网静态预览 / 社区站预览 / 本地文件浏览）已整块删除，
//   这个端口只剩 `/chat`（用当前 token 跳引擎对话页）。2026-11-23 起桌宠 Live2D 面板也移除。
//   删面板前先确认过：6 个场景 json 无一引用 personal-site，`code-urls` 只用 app.site.open/probe（不在此服务内）。
// 2026-11-12 跨机器移植：端口统一可 env 覆盖（与 外壳\scripts\自检.mjs、工具\环境.mjs 同源）
const SITE_PORT = Number(process.env.SITE_PORT || machinePort('site', 31238));
let siteServer = null;

// 四态判定（复用 社交.js 读人格会话 transcript）
const petState = require('./桌宠状态');
const petBody = require('./桌宠身体');   // 桌面身体（dsh-pet 0.4.9）薄客户端：只推状态/说一句，不借它的人格与账

// ---- 桌面身体桥（2026-11-20）----
// 为什么：工作台自己的 Live2D 还在磨模型，先用 dsh-pet 0.4.9 当身体；它只负责渲染/动画/物理/气泡，
//   人格、场景路由、待批准、记忆仍在我们这边。状态由本进程算好推过去，不走它的 chat/whisper/balance。
// 插件没装 / 桌面 helper 还没起来时只记一次日志，2 秒后自动重试，不影响工作台启动。
let petBodyClient = null;
let petBodyTimer = null;
let petBodyRunId = 0;            // 每次重连 +1：旧的菜单轮询/通知长轮询看到它变了就自己退场
let petMenuMap = {};             // 菜单 label → 动作；dsh-pet 只回 label，动作表留在这边
let petNotifyCounter = 0;        // 已转发过的 notify 帧序号，防同一帧重复弹顶栏
// 关掉桥：清定时器 + 丢客户端；设置里停用身体后下一拍就不再推状态。
function stopPetBodyBridge() {
  petBodyRunId++;
  if (petBodyTimer) {
    try { clearInterval(petBodyTimer); } catch (e) { log('[pet-body] 清定时器失败: ' + ((e && e.message) || e)); }
    petBodyTimer = null;
  }
  petBodyClient = null;
}
app.on('before-quit', function () { stopPetBodyBridge(); });
function startPetBodyBridge() {
  if (petBodyClient) return petBodyClient;
  const s = petSvc.getSettings() || {};
  const b = s.body || {};
  if (b.enabled === false || String(b.kind || 'dsh-pet') !== 'dsh-pet') {
    log('[pet-body] 已关闭（设置 body.enabled=false 或 kind≠dsh-pet）');
    return null;
  }
  petBodyClient = petBody.createClient({
    base: String(b.base || '').trim() || (BASE + '/dsh-pet-7340'),
    pet: String(b.pet || 'main'),
    token: harnessToken || '',
  });
  const bodyRunId = petBodyRunId;
  const bodyClient = petBodyClient;
  let busy = false;
  let lastLine = '';
  let warned = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      // 1. 全会话算态：审批队列非空时强制 waiting（人的动作优先）
      const st = petState.stateAll(DSH_HOME, { pendingApprovals: pendingApprovalCount() });
      // 2. 推给桌面身体；相同 state+task 客户端内部会跳过
      const r = await petBodyClient.push(st.state, st.task);
      const line = st.state + ' | ' + (st.task || '') + ' | ' + (st.scene || '');
      if (line !== lastLine) {
        log('[pet-body] ' + line + (r && r.ok ? '' : '（未生效：' + ((r && (r.reason || r.error)) || 'unknown') + '）'));
        lastLine = line;
      }
      if (!r || !r.ok) {
        if (!warned) { warned = true; log('[pet-body] 桌面身体未就绪，稍后自动重试：' + ((r && (r.reason || r.error)) || 'unknown')); }
      } else if (warned) {
        warned = false;
        log('[pet-body] 桌面身体已就绪');
      }
    } catch (e) {
      warnOnce('pet-body', e);
    } finally {
      busy = false;
    }
  }
  tick();
  petBodyTimer = setInterval(tick, 2000);
  if (petBodyTimer.unref) petBodyTimer.unref();
  // 1. 注册右键菜单（工作台 / 人格会话 / 待办 + 全部场景）
  syncPetMenu(bodyClient, bodyRunId).catch(function (e) { warnOnce('pet-menu-sync', e); });
  // 2. 持续收菜单点击（长轮询；dsh-pet 重载后自动重注册）
  pollPetMenu(bodyClient, bodyRunId).catch(function (e) { warnOnce('pet-menu-poll', e); });
  // 3. 持续收通知并转顶栏；顺手把它的系统通知切到顶栏口径
  watchPetNotify(bodyClient, bodyRunId).catch(function (e) { warnOnce('pet-notify-watch', e); });
  ensurePetTopbarNotify(bodyClient, bodyRunId).catch(function (e) { warnOnce('pet-notify-switch', e); });
  return petBodyClient;
}
function restartPetBodyBridge() {
  stopPetBodyBridge();
  return startPetBodyBridge();
}

// ---- 桌面身体右键菜单（2026-11-20）----
// dsh-pet 只负责画菜单、回报 label；点下去做什么由工作台决定。
// 菜单注册是进程内存态，dsh-pet 重载就清空，所以轮询发现 unknown-owner 会立刻重注册。
function focusIfAlive(win) {
  if (!win || win.isDestroyed || win.isDestroyed()) return false;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  } catch (e) { warnOnce('pet-menu-focus', e); return false; }
}
function openMainOrConsole() {
  if (focusIfAlive(mainWindow)) return { ok: true, target: 'main' };
  return openSceneWindow('console');
}
function openTopbarPending() {
  let win = mainWindow;
  if (!focusIfAlive(win)) {
    const r = openSceneWindow('console');
    win = findSceneWindow('console');
    if (!win) return r;
  }
  const run = function () {
    try {
      win.webContents.executeJavaScript('window.__tbsOpenPending && window.__tbsOpenPending();').catch(function (e) {
        log('[pet-menu] 打开待办失败: ' + ((e && e.message) || e));
      });
    } catch (e) { log('[pet-menu] 打开待办失败: ' + ((e && e.message) || e)); }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', run);
  else run();
  return { ok: true, target: 'pending' };
}
function buildPetMenu() {
  const map = {};
  map['工作台'] = openMainOrConsole;
  map['人格会话'] = function () { return openSceneWindow('pet'); };
  map['待办'] = openTopbarPending;
  try {
    for (const s of listScenarios()) {
      if (!s || !s.name || !s.id) continue;
      if (map[s.name]) continue;
      map[s.name] = (function (id) {
        return function () { return openSceneWindow(id); };
      })(s.id);
    }
  } catch (e) { warnOnce('pet-menu-scenes', e); }
  return map;
}
async function syncPetMenu(client, runId) {
  if (runId !== petBodyRunId || client !== petBodyClient) return { ok: false, reason: 'stale' };
  const map = buildPetMenu();
  const labels = Object.keys(map);
  petMenuMap = map;
  const r = await client.setMenuItems(labels);
  if (r && r.ok) log('[pet-menu] 已注册 ' + labels.length + ' 项：' + labels.join(' / '));
  else log('[pet-menu] 注册失败：' + ((r && (r.reason || r.error)) || 'unknown'));
  return r;
}
function delayMs(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
async function pollPetMenu(client, runId) {
  let warned = false;
  while (runId === petBodyRunId && client === petBodyClient) {
    let r;
    try { r = await client.pollMenu(10000); } catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
    if (runId !== petBodyRunId || client !== petBodyClient) return;
    if (!r || !r.ok) {
      if (!warned) { warned = true; log('[pet-menu] 轮询未就绪：' + ((r && (r.reason || r.error)) || 'unknown')); }
      // dsh-pet 重载会清空内存菜单；unknown-owner 立刻重注册，其它错误等一拍再试
      if (r && /unknown-owner/.test(String(r.reason || ''))) await syncPetMenu(client, runId);
      await delayMs(1500);
      continue;
    }
    warned = false;
    const events = r.events || {};
    for (const label of Object.keys(events)) {
      if (!events[label]) continue;
      const fn = petMenuMap[label];
      if (typeof fn !== 'function') { log('[pet-menu] 未识别的菜单项：' + label); continue; }
      try {
        const out = fn();
        log('[pet-menu] 点击「' + label + '」 → ' + JSON.stringify(out || {}));
      } catch (e) { warnOnce('pet-menu-click', e); }
    }
  }
}

// ---- 桌面身体通知 → 工作台顶栏（2026-11-20）----
// dsh-pet 的 sections.notify 是单槽，长轮询能第一时间抓到；抓到就广播 topbar:toast。
// 系统通知由 dsh-pet 自己发，这里不重复发；启动时把它的系统通知关掉，统一走顶栏。
function notifyText(frame) {
  const f = frame || {};
  if (f.type === 'session/event' && f.event && f.event.type === 'turn/end') {
    const d = f.event.data || {};
    const kind = d.reason && d.reason.kind;
    if (kind === 'completed') return '对话完成' + (d.text ? '：' + String(d.text).slice(0, 80) : '');
    if (kind === 'error') return '生成失败' + (d.reason && d.reason.error && d.reason.error.message ? '：' + d.reason.error.message : '');
    if (kind === 'max-tokens') return '输出被截断：已达到输出 token 上限';
    return '对话结束';
  }
  if (f.type === 'approval/requested') {
    return '需要你批准' + (f.toolName ? '：工具「' + f.toolName + '」' : '') + (f.reason ? '（' + f.reason + '）' : '');
  }
  if (f.type === 'question/requested') {
    const q = Array.isArray(f.questions) && f.questions[0] && f.questions[0].question;
    return '等你回答' + (q ? '：' + String(q).slice(0, 80) : '');
  }
  if (f.type === 'host/agent-error') return '生成失败：' + String(f.message || '未知错误').slice(0, 100);
  return '';
}
async function watchPetNotify(client, runId) {
  let since = 0;
  while (runId === petBodyRunId && client === petBodyClient) {
    let r;
    try { r = await client.waitState(since, 10000); } catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
    if (runId !== petBodyRunId || client !== petBodyClient) return;
    if (!r || !r.ok || !r.json) {
      await delayMs(1500);
      continue;
    }
    const n = r.json.sections && r.json.sections.notify;
    if (n && Number(n.counter) && Number(n.counter) !== petNotifyCounter && n.data) {
      petNotifyCounter = Number(n.counter);
      const text = notifyText(n.data);
      if (text) {
        const bad = /失败|出错|错误|截断/.test(text);
        try { broadcast('topbar:toast', { text: '桌宠 · ' + text, bad: bad, ms: bad ? 12000 : 6000 }); } catch (e) { warnOnce('pet-notify', e); }
        log('[pet-notify] ' + text);
      }
    }
    const prev = since;
    since = Math.max(since, Number(r.json.counter) || since);
    // counter 没变说明是超时返回，稍等再挂；变了就立刻从新 counter 继续等
    if (Number(r.json.counter) === prev) await delayMs(200);
  }
}
async function ensurePetTopbarNotify(client, runId) {
  if (runId !== petBodyRunId || client !== petBodyClient) return;
  try {
    const v = await client.getVoice();
    if (!v || !v.ok || !v.voice) return;
    if (v.voice.notificationsEnabled === false) return;   // 已经是顶栏口径
    const r = await client.setVoice({ notificationsEnabled: false });
    log('[pet-notify] 已把 dsh-pet 系统通知切到顶栏口径：' + ((r && r.ok) ? 'ok' : ((r && r.reason) || 'failed')));
  } catch (e) { warnOnce('pet-notify-switch', e); }
}

// ---- 数据盘隔离：所有 Electron 运行时数据（userData/session、webview partition、localStorage 等）
// 强制写到 D 盘项目目录，绝不落到 C 盘。必须在任何 app API 之前设置。----
const PROFILE_DIR = PACKAGED ? path.join(DATA_HOME, 'electron-profile') : path.join(SHELL_DATA_DIR, 'electron-profile');
try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (e) { warnOnce("main", e) }
try { app.setPath('userData', PROFILE_DIR); } catch (e) { warnOnce("main", e) }
try { app.setPath('sessionData', path.join(PROFILE_DIR, 'sessions')); } catch (e) { warnOnce("main", e) }

// ---- 默认工作区：新会话的 cwd（`<本夹>\工作区`）----
// 为什么要在启动时建：根 .gitignore 挡着 `工作区/`，克隆下来是空的、甚至不存在；
// cwd 不存在会让建会话/换会话收到一个坏路径。空目录本身是设计状态（见 `说明\默认工作区.md`）。
const WORKSPACE_DIR = PACKAGED ? path.join(DATA_HOME, '工作区') : path.join(__dirname, '..', '工作区');
try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch (e) { warnOnce("main", e) }

// 启动计时基准：日志里会打印「窗口可见耗时」与「引擎就绪总耗时」，便于日后评估启动速度
const APP_T0 = Date.now();

let mainWindow = null;
let serverProc = null;
let logTail = '';
let harnessToken = null;

// 2026-11-17 · token 传给子脚本：2026-11-14 起 server.log 里的 token 被打成 `token=***`（防泄露），
//   但脚本们（建会话/换会话/sessions/归档/改名/派发）仍是「从日志正则取 token」⇒ 闸门放行后必然
//   「换不到 cookie」。token 本体只留在内存，所以改由壳在 spawn 时注入 DSH_TOKEN，
//   脚本侧统一走 工具\引擎token.mjs（env 优先、日志兜底）。
function scriptEnv(extra) {
  return Object.assign({}, process.env, harnessToken ? { DSH_TOKEN: harnessToken } : {}, {
    DSH_MACHINE_FILE: process.env.DSH_MACHINE_FILE || MACHINE_FILE_EARLY,
    DSH_HARNESS_DIR: process.env.DSH_HARNESS_DIR || HARNESS_DIR,
    DSH_LOG: process.env.DSH_LOG || LOG_FILE,
    DSH_WORKSPACE: process.env.DSH_WORKSPACE || WORKSPACE_DIR,
  }, extra || {});
}

function log(line) {
  // 2026-11-14 · token 脱敏：引擎会把自己的启动 URL（`…?token=xxx`）打到 stdout，原来整行进 server.log
  //   ⇒ 45 次启动就留了 45 个明文 token（server.log 还常被拿去发给别人看）。
  //   token 本体只留在内存（captureToken）给界面与 IPC 用；落盘的这一份统一打成 token=***。
  const safe = String(line).replace(/(token=)([A-Za-z0-9_\-]{8,})/g, '$1***');
  try { fs.appendFileSync(LOG_FILE, safe + '\r\n'); } catch (e) { /* ignore */ }
  logTail = (logTail + safe + '\n').slice(-1200);
}

// 静默兜底统一出口（2026-11-13）：主进程里原本 140+ 处 catch 只留一句注释，故障时用户只看到"界面没反应"。
//   同一"位置+消息"只记一次（WARN_SEEN），避免轮询/事件类 catch 把 server.log 刷爆；log() 内部失败不再往里递归。
const WARN_SEEN = new Set();
let WARN_IN = false;
function warnOnce(tag, e) {
  if (WARN_IN) return;
  const msg = (e && (e.message || String(e))) || "unknown";
  let at = "";
  try { at = (String((e && e.stack) || "").split("\n")[1] || "").trim().replace(/^at\s+/, ""); } catch (x) { at = ""; }
  const key = tag + "|" + msg.slice(0, 120) + "|" + at;
  if (WARN_SEEN.has(key)) return;
  WARN_SEEN.add(key);
  WARN_IN = true;
  try { log("[warn] (" + tag + ") " + msg + (at ? " @ " + at : "")); } catch (x) { warnOnce("main", x) }
  WARN_IN = false;
}
rotateLog();

// ---- 2026-11-14 · 缓存体积巡检（只提示，不自动删）----
// 与 自检.mjs 的阈值同源：外壳\data 超过 800 MB 就该清；清理必须退壳后跑 `清理缓存.mjs --apply`
//   （在壳运行中硬删会让面板白屏 / 分区损坏）。
// 7 天内只提示一次（data\cache-hint.json 记时间戳）——刚清过就别反复弹，也避免每次开机都刷一条。
const CACHE_HINT_MB = 800;
const CACHE_HINT_DAYS = 7;
const CACHE_HINT_FILE = path.join(SHELL_DATA_DIR, 'cache-hint.json');
let CACHE_HINT_SCHEDULED = false;

// 异步走目录（10k 文件也别用同步 API 把主进程事件循环卡住）
async function dirSizeAsync(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch (e) { warnOnce("cache-hint", e); continue; }
    const files = [];
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) files.push(p);
    }
    for (const f of files) {
      try { const st = await fs.promises.stat(f); total += st.size; } catch (e) { warnOnce("cache-hint", e); /* 单文件读不到不影响总体（同位置只记一次） */ }
    }
  }
  return total;
}

async function maybeHintCacheSize() {
  try {
    const threshold = autoMaintConfig().cacheClean.thresholdMb;
    const mb = Math.round((await dirSizeAsync(SHELL_DATA_DIR)) / (1024 * 1024));
    if (mb < threshold) return;
    const last = readJsonSafe(CACHE_HINT_FILE, {}) || {};
    if (typeof last.at === 'number' && Date.now() - last.at < CACHE_HINT_DAYS * 24 * 3600 * 1000) return;
    writeJsonSafe(CACHE_HINT_FILE, { at: Date.now(), mb: mb });
    log('[cache] 数据目录 ' + mb + ' MB（阈值 ' + threshold + ' MB）⇒ 建议退壳后跑 清理缓存.mjs --apply');
    broadcast('topbar:toast', {
      text: '数据目录已 ' + mb + ' MB（阈值 ' + threshold + ' MB）：退出工作台后跑 node 12-源码照搬\\外壳\\scripts\\清理缓存.mjs --apply 能回收大部分缓存',
      bad: false,
      ms: 12000,
    });
  } catch (e) { warnOnce("cache-hint", e); }
}

// ---- 2026-11-14 · 自动维护（用户不用记得手动跑）----
// 三件事：① 启动时清"孤儿 staging"；② 引擎就绪 60s 后后台巡检（每 12 小时最多一次）；③ 退出时自动清缓存。
// 判据与手动命令完全一样（不复制第二套规则）：孤儿 = 引擎更新\ 下的 staging-* 里 state.json 没指向的那些；
//   巡检 = 工具\自动巡检.mjs；清缓存 = scripts\清理缓存.mjs --after-exit <pid>。
const UPDATE_DIR_AUTO = path.join(path.dirname(__dirname), '引擎更新');   // 12-源码照搬\引擎更新
const INSPECT_FILE = path.join(SHELL_DATA_DIR, '巡检.json');
const STAGING_FILE = path.join(SHELL_DATA_DIR, 'staging-clean.json');

// ---- 自动维护总开关（2026-11-20）----
// 这张卡管五件后台活：记忆整理 / 巡检 / 退出清缓存 / 孤儿 staging / 崩溃回滚。
// 真源：外壳\data\自动维护.json（不存在按默认建一份，全部开 = 原有行为）。
// JSON 坏了就「全部关闭 + 一条 toast」——不让坏配置静默把自动任务重新打开。
const AUTO_MAINT_FILE = path.join(SHELL_DATA_DIR, '自动维护.json');
function autoMaintConfig() {
  const def = {
    tidy: { enabled: true, everyDays: 7 },
    inspect: { enabled: true, everyHours: 12 },
    cacheClean: { enabled: true, thresholdMb: CACHE_HINT_MB },
    stagingClean: { enabled: true },
    rollback: { enabled: true },
  };
  const off = {
    tidy: { enabled: false, everyDays: def.tidy.everyDays },
    inspect: { enabled: false, everyHours: def.inspect.everyHours },
    cacheClean: { enabled: false, thresholdMb: def.cacheClean.thresholdMb },
    stagingClean: { enabled: false },
    rollback: { enabled: false },
  };
  const num = function (v, d, min, max) {
    const n = Number(v);
    return (Number.isFinite(n) && n >= min && n <= max) ? n : d;
  };
  const isOff = function (v) {
    if (v === false || v === 0) return true;
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    return s === 'false' || s === 'off' || s === '0' || s === 'no' || s === '关';
  };
  const enabled = function (v, d) {
    if (isOff(v)) return false;
    if (v && typeof v === 'object' && isOff(v.enabled)) return false;
    return d;
  };
  let src;
  try {
    if (!fs.existsSync(AUTO_MAINT_FILE)) {
      fs.mkdirSync(path.dirname(AUTO_MAINT_FILE), { recursive: true });
      fs.writeFileSync(AUTO_MAINT_FILE, JSON.stringify(def, null, 2) + '\r\n', 'utf8');
      return def;
    }
    src = JSON.parse(fs.readFileSync(AUTO_MAINT_FILE, 'utf8')) || {};
  } catch (e) {
    log('[auto] 自动维护.json 解析失败 ⇒ 本轮全部关闭：' + ((e && e.message) || e));
    try {
      broadcast('topbar:toast', {
        text: '自动维护.json 解析失败 ⇒ 记忆整理 / 巡检 / 清缓存 / staging / 回滚本轮全部关闭；改好或删掉该文件再重启',
        bad: true, ms: 20000,
      });
    } catch (e2) { warnOnce('auto-maint', e2); }
    return off;
  }
  return {
    tidy: { enabled: enabled(src.tidy, true), everyDays: num(src.tidy && src.tidy.everyDays, def.tidy.everyDays, 1, 30) },
    inspect: { enabled: enabled(src.inspect, true), everyHours: num(src.inspect && src.inspect.everyHours, def.inspect.everyHours, 1, 168) },
    cacheClean: { enabled: enabled(src.cacheClean, true), thresholdMb: num(src.cacheClean && src.cacheClean.thresholdMb, def.cacheClean.thresholdMb, 100, 10000) },
    stagingClean: { enabled: enabled(src.stagingClean, true) },
    rollback: { enabled: enabled(src.rollback, true) },
  };
}


// 用 机器配置.json 的 nodeExe 跑（⛔ 不用 Electron 内置 Node：自检按 >=24.9 判，用错的 node 会假红）
function spawnTool(nodeMode, script, args, opts) {
  const node = resolveNodeExe();
  const env = serverSpawnEnv();
  let cmd;
  if (node) cmd = node;
  else {
    // 干净 Windows 没有 Node：用 Electron 自带的 Node 24.18 跑 .mjs（安装版已核过版本）
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = process.execPath;
  }
  return spawn(cmd, [script].concat(args || []), Object.assign({
    cwd: __dirname, windowsHide: true, env: env,
    stdio: 'ignore',
  }, opts || {}));
}

// 面板会话自愈（2026-11-21）：安装版首启 / 升级后，场景 json 里的 sessionId 在本地会话库里不存在
//   ⇒ 面板打开是空白的。这里让 工具\首启绑定.mjs 扫一遍，缺的自动建并写回（一个进程一次搞定）。
// 每次启动最多跑一次；失败只写日志，不影响启动（下次再试）。
let HEAL_TRIED = false;
function healSessionBindings() {
  if (HEAL_TRIED) return;
  HEAL_TRIED = true;
  const script = path.join(__dirname, '..', '工具', '首启绑定.mjs');
  if (!fs.existsSync(script)) { log('[boot] 跳过会话自愈：没有 工具\\首启绑定.mjs'); return; }
  try {
    const proc = spawnTool(null, script, ['--go'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', function (d) { out += String(d); });
    proc.stderr.on('data', function (d) { out += String(d); });
    proc.on('exit', function (code) {
      const tail = out.trim().split(/\r?\n/).slice(-2).join(' / ');
      log('[boot] 会话自愈 exit=' + code + (tail ? '：' + tail : ''));
      // 2. 新建了会话 ⇒ 场景 json 刚被回写，渲染层在 2 秒前已经按旧 id 挂过面板。
      //    这里点一次「⟳ 刷新当前场景」让它重读场景文件；⛔ 不整页 reload（会连所有 webview 一起刷掉）。
      const m = out.match(/BOUND=(\d+)/);
      const bound = Number(m && m[1]) || 0;
      if (code === 0 && bound > 0) {
        log('[boot] 会话自愈新建 ' + bound + ' 条；刷新当前场景以重钉会话');
        setTimeout(function () {
          try {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.webContents.executeJavaScript(
              "(function(){var b=document.getElementById('btn-refresh');if(b)b.click();})()", true
            ).catch(function (e) { warnOnce('boot-heal-refresh', e); });
          } catch (e) { warnOnce('boot-heal-refresh', e); }
        }, 500);
      }
    });
  } catch (e) { log('[boot] 会话自愈没跑起来：' + ((e && e.message) || e)); }
}

// ① 孤儿 staging：prepare 中途被杀、或换目标版本后残留的那份（可重新 prepare，不是备份，删了不丢东西）
//    每次结果落 data\staging-clean.json，控制台「自动维护」卡读它显示上次清理。
function cleanOrphanStaging() {
  if (!autoMaintConfig().stagingClean.enabled) { log('[auto] 孤儿 staging 清理已关，跳过'); return; }
  if (!fs.existsSync(UPDATE_DIR_AUTO)) {
    writeJsonSafe(STAGING_FILE, { at: new Date().toISOString(), cleaned: 0, failed: 0, kept: '', skipped: '引擎更新目录不存在' });
    return;
  }
  const state = readJsonSafe(path.join(UPDATE_DIR_AUTO, 'state.json'), null);
  // state 读不出来就不动：宁可留着，也不要把"正要应用的那一份"误删
  if (!state || typeof state !== 'object') {
    writeJsonSafe(STAGING_FILE, { at: new Date().toISOString(), cleaned: 0, failed: 0, kept: '', skipped: 'state.json 读不出，未动' });
    log('[auto] 引擎更新 state.json 读不出，跳过 staging 清理');
    return;
  }
  const keep = typeof state.staging === 'string' ? state.staging : '';
  let n = 0;
  let failed = 0;
  for (const name of fs.readdirSync(UPDATE_DIR_AUTO)) {
    if (!name.startsWith('staging-') || name === keep) continue;
    try {
      fs.rmSync(path.join(UPDATE_DIR_AUTO, name), { recursive: true, force: true });
      n++;
      log('[auto] 清掉孤儿 staging：' + name + '（state 指向 ' + (keep || '无') + '）');
    } catch (e) { failed++; warnOnce("auto-staging", e); }
  }
  writeJsonSafe(STAGING_FILE, { at: new Date().toISOString(), cleaned: n, failed: failed, kept: keep, skipped: '' });
  if (!n) log('[auto] staging 已干净（state 指向 ' + (keep || '无') + '）');
}

// ② 后台巡检：开机 60s 后跑一次（每天最多一次），只在有失败时弹通知，详细结果在 data\巡检.json
function scheduleAutoInspection() {
  const cfg = autoMaintConfig();
  if (!cfg.inspect.enabled) { log('[auto] 后台巡检已关，跳过'); return; }
  const everyMs = cfg.inspect.everyHours * 3600 * 1000;
  const last = readJsonSafe(INSPECT_FILE, null);
  const at = last && typeof last.at === 'string' ? Date.parse(last.at) : 0;
  if (at && (Date.now() - at) < everyMs) { log('[auto] 距上次巡检不足 ' + cfg.inspect.everyHours + ' 小时，跳过'); return; }
  setTimeout(function () {
    // 定时器等待期间用户可能已经关掉：执行前再读一次，避免「关了还跑」
    if (!autoMaintConfig().inspect.enabled) { log('[auto] 后台巡检已关，定时取消'); return; }
    const tool = path.join(__dirname, '..', '工具', '自动巡检.mjs');
    if (!fs.existsSync(tool)) { log('[auto] 自动巡检脚本不在，跳过：' + tool); return; }
    let child;
    try { child = spawnTool(null, tool, [], { stdio: 'ignore' }); } catch (e) { warnOnce("auto-inspect", e); return; }
    child.on('exit', function (code) {
      const doc = readJsonSafe(INSPECT_FILE, null) || {};
      const items = Array.isArray(doc.items) ? doc.items : [];
      const fails = items.filter(function (x) { return !x.ok; });
      log('[auto] 巡检完成（exit ' + code + '）：' + items.length + ' 项，失败 ' + fails.length);
      if (fails.length) {
        broadcast('topbar:toast', {
          text: '自动巡检有 ' + fails.length + ' 项没过：' + fails.map(function (x) { return x.name; }).join(' / ') + '（详情见 外壳\\data\\巡检.json）',
          bad: true, ms: 15000
        });
      }
    });
  }, 60000);
}

// ③ 退出后清缓存：壳自己拉一个分离进程，它等本进程退出 + 端口空下来再删（删完写 data\自动维护.log）
//    条件：开机巡检记下的体积 ≥ 阈值（cache-hint.json 的 mb）。没记录就不清 —— 不猜。
function scheduleAutoCacheCleanup() {
  const cfg = autoMaintConfig();
  if (!cfg.cacheClean.enabled) { log('[auto] 退出后清缓存已关，跳过'); return; }
  const hint = readJsonSafe(CACHE_HINT_FILE, null) || {};
  const sizeMb = typeof hint.mb === 'number' ? hint.mb : 0;
  if (sizeMb < cfg.cacheClean.thresholdMb) return;
  const script = path.join(__dirname, 'scripts', '清理缓存.mjs');
  if (!fs.existsSync(script)) return;
  try {
    const child = spawnTool(null, script, ['--after-exit', String(process.pid), '--apply'], { detached: true });
    child.unref();
    log('[auto] 已安排退出后清缓存（体积 ' + sizeMb + ' MB ≥ 阈值 ' + cfg.cacheClean.thresholdMb + ' MB，等 pid ' + process.pid + ' 退出后执行）');
  } catch (e) { warnOnce("auto-clean", e); }
}

// ④ 自动记忆整理：每周一次（把超 180 天的条目搬 归档\、刷索引与近期记忆、复核 check --all）
//    整理本身就是"改历史文件"，所以顺序卡死：先 dry 看计划 → 有要搬的才 记忆打包 留快照 → 再搬。
//    快照拿不到就整轮不搬（宁可这周不整理，也不要没有回退点）。
const TIDY_FILE = path.join(SHELL_DATA_DIR, '记忆整理.json');
function scheduleAutoMemoryTidy() {
  const cfg = autoMaintConfig();
  if (!cfg.tidy.enabled) { log('[auto] 自动记忆整理已关，跳过'); return; }
  const everyMs = cfg.tidy.everyDays * 24 * 3600 * 1000;
  const last = readJsonSafe(TIDY_FILE, null);
  const at = last && typeof last.at === 'string' ? Date.parse(last.at) : 0;
  if (at && (Date.now() - at) < everyMs) { log('[auto] 距上次记忆整理不足 ' + cfg.tidy.everyDays + ' 天，跳过'); return; }
  setTimeout(function () {
    // 定时器等待期间用户可能已经关掉：执行前再读一次
    if (!autoMaintConfig().tidy.enabled) { log('[auto] 自动记忆整理已关，定时取消'); return; }
    const tool = path.join(__dirname, '..', '工具', '自动记忆整理.mjs');
    if (!fs.existsSync(tool)) { log('[auto] 自动记忆整理脚本不在，跳过：' + tool); return; }
    let child;
    try { child = spawnTool(null, tool, [], { stdio: 'ignore' }); } catch (e) { warnOnce("auto-tidy", e); return; }
    child.on('exit', function (code) {
      const doc = readJsonSafe(TIDY_FILE, null) || {};
      log('[auto] 记忆整理完成（exit ' + code + '）：' + (doc.scenes || 0) + ' 个场景，搬 ' + (doc.moved || 0) + ' 篇进 归档\\');
      if (code !== 0) {
        broadcast('topbar:toast', {
          text: '自动记忆整理有失败（详情见 外壳\\data\\记忆整理.json 与 自动维护.log）',
          bad: true, ms: 15000
        });
      }
    });
  }, 90000);
}

// ---- 焦点探针（2026-11-12 用户同意；只记必要几行，不刷屏）----
// 用途：复现「一个面板跑任务时，另一个面板输入框打不进字」时，看是谁把 webview 焦点抢走。
// 开关：data\focus-probe.on 存在才写日志；删掉文件即时关闭（每次事件都查一次，不常驻开启）。
const FOCUS_PROBE_FILE = path.join(SHELL_DATA_DIR, 'focus-probe.on');
try {
  app.on('web-contents-created', (_ev, wc) => {
    try {
      if (wc.getType() !== 'webview') return;
      const where = () => '[focus-probe] wc=' + wc.id + ' ' + String(wc.getURL() || '').slice(0, 90);
      wc.on('focus', () => { try { if (fs.existsSync(FOCUS_PROBE_FILE)) log(where() + ' FOCUS'); } catch (e) { warnOnce("main", e) } });
      wc.on('blur', () => { try { if (fs.existsSync(FOCUS_PROBE_FILE)) log(where() + ' BLUR'); } catch (e) { warnOnce("main", e) } });
    } catch (e) { warnOnce("main", e) }
  });
} catch (e) { warnOnce("main", e) }

// 渲染层诊断进 server.log（2026-11-12 P0：面板切会话的「期望/实际」要留证据，别只写在界面小字里）
ipcMain.on('diag:log', (_e, m) => {
  try { log('[renderer] ' + String(m == null ? '' : m).slice(0, 400)); } catch (e) { warnOnce("main", e) }
});
// ==================== 多窗口（场景分离） ====================
// 主窗口照旧（场景 = 标签页）；任意场景可「弹出」成独立窗口，一屏看一个场景。
// 三条纪律（踩了就出鬼）：
//   ① 窗口控制类 IPC 一律按 e.sender 找窗口 —— 否则分离窗口上的最小化/关闭会去动主窗口；
//   ② 广播类事件（余额 / 启动进度 / 引擎就绪）发给全部窗口 —— 从前只发 mainWindow。
const detachWindows = [];                        // 主窗口之外的场景窗口
const WIN_LAYOUT_FILE = path.join(SHELL_DATA_DIR, 'windows.json');
// 场景标签顺序（拖拽换位的结果）：**主进程是唯一权威**。
// 为什么不让渲染层自己 localStorage：① 顺序要跨窗口一致（主窗口 / 独立场景窗口 / 将来任何消费方）；
// ② file:// 下的 localStorage 可能被清掉或与分区绑定。渲染层只负责"拖完把新顺序报上来"，读一律读这里。
const SCENE_ORDER_FILE = path.join(SHELL_DATA_DIR, 'scene-tab-order.json');
const layoutCache = { main: null, detached: {} }; // sceneId -> 几何（关窗后仍记得，供下次启动恢复）
let quitRequested = false;                       // 主窗口关闭 = 整个应用退出（分离窗口一起关，但布局要留下）

function allWindows() {
  const out = [];
  if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow);
  for (const w of detachWindows) { if (w && !w.isDestroyed()) out.push(w); }
  return out;
}
function broadcast(channel, payload) {
  for (const w of allWindows()) {
    try { w.webContents.send(channel, payload); } catch (e) { warnOnce("main", e) }
  }
}
function windowOfEvent(e) {
  try {
    const w = BrowserWindow.fromWebContents(e && e.sender);
    return (w && !w.isDestroyed()) ? w : null;
  } catch (err) { return null; }
}
function sceneNameOf(id) {
  try {
    const hit = listScenarios().filter(function (s) { return s.id === id; })[0];
    return (hit && hit.name) || String(id || '场景');
  } catch (e) { return String(id || '场景'); }
}
function detachedSceneIds() {
  const out = [];
  for (const w of detachWindows) { if (w && !w.isDestroyed() && w.kunScene) out.push(w.kunScene); }
  return out;
}
function findSceneWindow(sceneId) {
  for (const w of detachWindows) {
    if (w && !w.isDestroyed() && w.kunScene === sceneId) return w;
  }
  return null;
}
function notifyWindowsChanged() {
  broadcast('windows:changed', { detached: detachedSceneIds() });
}

// 记录窗口几何（含所在屏幕）；关窗后仍留着，供下次启动恢复
function rectOfWindow(win) {
  try {
    const max = win.isMaximized();
    const b = (max && typeof win.getNormalBounds === 'function') ? win.getNormalBounds() : win.getBounds();
    let displayId = '';
    try { const d = screen.getDisplayMatching(b); if (d) displayId = String(d.id); } catch (e) { warnOnce("main", e) }
    return { x: b.x, y: b.y, w: b.width, h: b.height, maximized: max, display: displayId };
  } catch (e) { return null; }
}
function noteWindowRect(win) {
  if (!win || win.isDestroyed()) return;
  const r = rectOfWindow(win);
  if (!r) return;
  if (win === mainWindow) layoutCache.main = r;
  else if (win.kunScene) layoutCache.detached[win.kunScene] = r;
}
let layoutSaveTimer = null;
function saveWinLayoutSoon() {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(function () { saveWinLayout(); }, 600);
}
function saveWinLayout() {
  if (layoutSaveTimer) { clearTimeout(layoutSaveTimer); layoutSaveTimer = null; }
  for (const w of allWindows()) noteWindowRect(w);
  try {
    fs.mkdirSync(path.dirname(WIN_LAYOUT_FILE), { recursive: true });
    fs.writeFileSync(WIN_LAYOUT_FILE, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      main: layoutCache.main || null,
      detached: Object.keys(layoutCache.detached).map(function (sid) {
        return Object.assign({ scene: sid }, layoutCache.detached[sid]);
      })
    }, null, 2));
  } catch (e) { log('[win] 保存窗口布局失败: ' + ((e && e.message) || e)); }
}
function loadWinLayout() {
  try {
    const raw = JSON.parse(fs.readFileSync(WIN_LAYOUT_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    layoutCache.main = raw.main || null;
    const map = {};
    (Array.isArray(raw.detached) ? raw.detached : []).forEach(function (d) {
      if (d && d.scene) map[String(d.scene)] = d;
    });
    layoutCache.detached = map;
  } catch (e) { warnOnce("main", e) }
}
// 恢复前校验：副屏被拔 / 坐标跑到屏幕外 → 夹回工作区，避免"窗口开了但看不见"
function fitSavedBounds(saved, defW, defH) {
  const out = { bounds: null, maximized: false };
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return out;
  const w = Math.max(680, Math.round(saved.w || defW));
  const h = Math.max(460, Math.round(saved.h || defH));
  out.maximized = !!saved.maximized;
  let area = null;
  try {
    const displays = screen.getAllDisplays();
    const same = displays.filter(function (d) { return String(d.id) === String(saved.display); })[0];
    const inter = displays.filter(function (d) {
      const a = d.workArea;
      return saved.x < a.x + a.width && saved.x + w > a.x && saved.y < a.y + a.height && saved.y + h > a.y;
    })[0];
    if (same && inter && same.id === inter.id) area = same.workArea;
    else if (inter) area = inter.workArea;
    if (!area) {
      const wa = screen.getPrimaryDisplay().workArea;
      out.bounds = {
        x: Math.round(wa.x + Math.max(0, (wa.width - Math.min(w, wa.width)) / 2)),
        y: Math.round(wa.y + Math.max(0, (wa.height - Math.min(h, wa.height)) / 2)),
        width: Math.min(w, wa.width),
        height: Math.min(h, wa.height)
      };
      out.clamped = true;
      return out;   // 副屏不在了 → 主屏居中
    }
  } catch (e) { return out; }
  out.bounds = {
    x: Math.round(Math.min(Math.max(saved.x, area.x), Math.max(area.x, area.x + area.width - w))),
    y: Math.round(Math.min(Math.max(saved.y, area.y), Math.max(area.y, area.y + area.height - h))),
    width: w,
    height: h
  };
  return out;
}

// ---- 全局兜底：任何未捕获异常都写日志 + 弹一次可见提示，绝不"静默打不开" ----
// 目的：以前一旦启动流程里抛错，表现就是"点了没反应/窗口不出来"，很难查。
// 现在任何致命错误都会：① 写进 server.log ② 弹一次错误框（含日志路径与回滚提示）。
let fatalShown = false;
function reportFatal(where, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  try { log('[FATAL] ' + where + ': ' + detail); } catch (e) { warnOnce("main", e) }
  if (fatalShown) return;
  fatalShown = true;
  try {
    dialog.showErrorBox(
      'DSH 引擎 出错（已记录日志）',
      where + '\n\n' + String(detail).slice(0, 1200) +
      '\n\n日志：' + LOG_FILE +
      '\n回滚：把 data\\backups\\gui-<最新> 里的文件覆盖回来即可。'
    );
  } catch (e) { warnOnce("main", e) }
}
process.on('uncaughtException', function (err) { reportFatal('主进程未捕获异常', err); });
process.on('unhandledRejection', function (reason) { reportFatal('主进程未处理的 Promise 拒绝', reason); });

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function probe() {
  return new Promise(function (resolve) {
    const req = http.get(BASE + '/', { timeout: 1500 }, function (res) {
      res.resume();
      resolve(true);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
  });
}

// 从 dsh web 输出中解析 token 与完整 URL
function captureToken(text) {
  const m = String(text).match(new RegExp('http:\\/\\/127\\.0\\.0\\.1:' + DSH_PORT + '\\/\\?token=([A-Za-z0-9_\\-]+)'));
  if (m && m[1]) {
    harnessToken = m[1];
    // 2026-11-18：微信通道复用 工具\派发-公共.mjs 的 getCookie；它读 DSH_TOKEN。
    // token 本身仍只在内存，只是让同一进程内的适配器能取到（子进程会由 scriptEnv 显式注入）。
    process.env.DSH_TOKEN = m[1];
    // 2026-11-14 · 别把 token 本体写进日志（原来这行是明文的第二处泄漏，log() 的脱敏只管 token=xxx 形态）
    log('[token] captured（长度 ' + m[1].length + '，不落盘）');
  }
}

// ---- 启动进度（渲染层加载页用）----
let lastBoot = { stage: 'init', pct: 0, text: '准备中…', detail: '', ts: Date.now() };
function sendBoot(patch) {
  lastBoot = Object.assign({}, lastBoot, patch, { ts: Date.now() });
  try { broadcast('boot:progress', lastBoot); } catch (e) { warnOnce("main", e) }
  return lastBoot;
}

// 已构建的 CLI 入口：可跳过 cmd.exe → pnpm → tsx 三层转译，作为 pnpm 起不来时的兜底
// 2026-11-14：原来只认源码版 apps/cli/lib/bin.js，打包版引擎（引擎/lib/bin.js）命中不到 ⇒ 兜底永远不可用。
//   现在两套布局都认，与 自检.mjs 的 ENGINE_BINS 同源。
//   ⚠ 实测（见下方 plans 处注释）本机 pnpm 比内置入口更快，所以它只当兜底、不再排第一。
const CLI_CANDS = [
  path.join(HARNESS_DIR, 'apps', 'cli', 'lib', 'bin.js'),   // 源码版
  path.join(HARNESS_DIR, 'lib', 'bin.js')                    // 打包版
];
// ⚠ 这个函数必须每次现算：安装版首启是「先缺引擎 → 运行中装好 → 再启动」，
//   模块加载时算成常量会把路径钉在 apps/cli/lib/bin.js（打包版永远命中不到）⇒ 装好也走 pnpm。
function cliBuiltNow() {
  for (const p of CLI_CANDS) { try { if (fs.existsSync(p)) return p; } catch (e) { warnOnce('main', e) } }
  return CLI_CANDS[0];
}

function serverSpawnEnv() {
  const env = Object.assign({}, process.env);
  env.Path = NPM_BIN + ';' + (env.Path || '');
  // DSH_HOME 显式指向 D 盘项目目录（数据盘隔离：会话/存储/缓存绝不落 C 盘）。
  // 不设置的话 dsh 默认用 <用户目录>\<user>\.dsh，导致历史会话在界面里"消失"。
  env.DSH_HOME = DSH_HOME;
  env.DSH_MACHINE_FILE = process.env.DSH_MACHINE_FILE || MACHINE_FILE_EARLY;
  env.DSH_WORKSPACE = process.env.DSH_WORKSPACE || WORKSPACE_DIR;
  return env;
}

// 统一挂上 stdout/stderr/exit 处理（解析 token + 写日志）
function wireServerProc(proc) {
  proc.stdout.on('data', function (d) {
    const s = String(d);
    captureToken(s);
    log('[out] ' + s.trim());
  });
  proc.stderr.on('data', function (d) {
    const s = String(d);
    captureToken(s);
    log('[err] ' + s.trim());
  });
  proc.on('exit', function (code) { log('[server exited] code=' + code); });
  return proc;
}

// 解析可用的 node 可执行文件（优先系统 node，其次 Electron 以纯 Node 模式运行自身）
// harness 要求 node ^22.19 || >=24
let cachedNodeExe = null;
function resolveNodeExe() {
  if (cachedNodeExe !== null) return cachedNodeExe;
  cachedNodeExe = '';
  if (process.env.DSH_NODE) {
    try { if (fs.statSync(process.env.DSH_NODE).isFile()) { cachedNodeExe = process.env.DSH_NODE; return cachedNodeExe; } } catch (e) { warnOnce("main", e) }
  }
  // 2026-11-14 修：自检按 机器配置.json 的 nodeExe 判 Node 版本（引擎要求 >=24.9），主进程却只扫 PATH
  //   ⇒ PATH 里先命中 22.x（沙箱 / 旧装 / 别的工具自带）时，引擎跑在低版本 node 上而自检仍是绿的。
  //   顺序固定为：DSH_NODE > 机器配置 nodeExe > PATH > Electron 内置 Node。
  try {
    const cfgFile = process.env.DSH_MACHINE_FILE || path.join(__dirname, '..', '引擎数据', '.dsh', '机器配置.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg && cfg.nodeExe && fs.statSync(cfg.nodeExe).isFile()) { cachedNodeExe = cfg.nodeExe; return cachedNodeExe; }
  } catch (e) { warnOnce("main", e) }
  // 安装版：PATH 里的 Node 版本不可控（旧装 / 别的工具自带 22.x），而 Electron 自带 24.18 已满足
  //   `engines.node >=24.9`。所以不进 PATH，直接返回空串 ⇒ 调用方用 ELECTRON_RUN_AS_NODE 跑。
  if (PACKAGED) {
    log('[boot] 安装版使用 Electron 内置 Node（24.18），不扫 PATH');
    return cachedNodeExe;
  }
  const dirs = String(process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, 'node.exe');
    try { if (fs.statSync(p).isFile()) { cachedNodeExe = p; return cachedNodeExe; } } catch (e) { warnOnce("main", e) }
  }
  log('[boot] 未找到系统 node，将用 Electron 的 Node 模式直跑');
  return cachedNodeExe;
}

// 方式一（首选）：直跑构建产物（无 cmd / 无 pnpm / 无 tsx）
function spawnServerDirect() {
  const env = serverSpawnEnv();
  const nodeExe = resolveNodeExe();
  let cmd, args;
  if (nodeExe) {
    cmd = nodeExe;
    args = [cliBuiltNow(), 'web', '--no-open', '--port', DSH_PORT];
  } else {
    // Electron 二进制以纯 Node 运行（内置 Node 24.18，满足 engines 要求）
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = process.execPath;
    args = [cliBuiltNow(), 'web', '--no-open', '--port', DSH_PORT];
  }
  log('[boot] direct: ' + cmd + ' ' + args.join(' '));
  return wireServerProc(spawn(cmd, args, {
    cwd: HARNESS_DIR,
    env: env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

// 方式二（兜底）：原来的 pnpm 脚本（走 tsx 实时转译，慢但兼容性最好）
function spawnServerPnpm() {
  return wireServerProc(spawn('cmd.exe', ['/c', PNPM_CMD + ' dsh web --no-open --port ' + DSH_PORT], {
    cwd: HARNESS_DIR,
    env: serverSpawnEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

// 引擎是不是**别人**拉起来的（我们只是复用）：
//   true ⇒ 我们看不到它启动时打印的 token，日志历史里的 token 也只对"我们自己拉起的那次"有效；
//   引擎在外部重启后旧 token 立刻失效（实测白屏 `dsh web authentication required`）。
//   所以复用外部引擎时，主界面改走本机保命入口 `http://127.0.0.1:<SITE_PORT>/chat`（实时用当前 token 跳转）。
let engineIsForeign = false
let engineAutoLocalTried = false
const LOCAL_ENGINE_DIRS = [
  path.join(path.dirname(process.execPath), '引擎包'),
  path.join(DATA_HOME, '引擎包')
]
const BOOT_FAIL_FILE = path.join(SHELL_DATA_DIR, 'engine-boot-fail.json')

function bumpBootFail() {
  let n = 0
  try { n = Number(JSON.parse(fs.readFileSync(BOOT_FAIL_FILE, 'utf8')).count) || 0 } catch { /* first */ }
  n += 1
  try { fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: n, at: new Date().toISOString() }, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
  return n
}
function resetBootFail() {
  try { fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: 0, at: new Date().toISOString() }, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
}

/**
 * 引擎成功启动后，把当前配置标成“正常点”（2026-10-21 宿主：升级卡死后要能回到上次能用）。
 * 只备份 17 个启动配置，不碰源码/构建；失败静默，不影响启动。
 */
function markEngineGood() {
  try {
    const tool = path.join(__dirname, '..', '工具', '引擎快照.mjs');
    if (!fs.existsSync(tool)) return;
    topbarRunAsync(tool, ['--save', '--quiet'], 120000).then(function (r) {
      if (r && r.ok) log('[engine] 已更新“正常点”配置快照');
      else log('[engine] 正常点快照失败: ' + String((r && r.out) || '').slice(0, 160));
    });
  } catch (e) { log('[engine] 正常点快照异常: ' + String((e && e.message) || e)); }
}

async function startServer() {
  sendBoot({ stage: 'check', pct: 6, text: '检查引擎状态…', detail: '' });
  if (await probe()) {
    log('reuse: port already listening');
    engineIsForeign = true;
    // 端口已在监听时，token 只能尝试从日志历史里找（仅当"我们自己曾拉起过它"时才对）
    if (!harnessToken) {
      const hist = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
      const m = hist.match(/token=([A-Za-z0-9_\-]+)/);
      if (m) {
        harnessToken = m[1];
        process.env.DSH_TOKEN = m[1];
      }
    }
    log('[engine] 复用外部引擎 ⇒ 主界面走保命入口 http://127.0.0.1:' + SITE_PORT + '/chat（token 每次实时转发，永远是最新的）');
    sendBoot({ stage: 'ready', pct: 92, text: '引擎已就绪', detail: '复用正在运行的实例' });
    resetBootFail();
    markEngineGood();
    return true;
  }
  // 2026-11-20 首启 / 安装包：引擎目录空着时，下面两套启动方式都注定失败
  //   （pnpm 脚本要本机 pnpm；内置入口要 引擎\lib\bin.js）⇒ 不空转 90 秒，直接把启动页交给「下载引擎」。
  //   下载完成后由 engine:download / boot:retry 重新进本函数。
  const eng = engineBoot.detect(HARNESS_DIR);
  if (!eng.ok) {
    log('[engine] 未就位：' + eng.text + '（' + HARNESS_DIR + '）');
    // 1. 安装器会把安装器同目录的 引擎-*.tar.gz 拷到 安装目录\引擎包\；
    //    数据根也允许预置一份（%LOCALAPPDATA%\胡闹的工作台\引擎包）。找到就直接装，不再让用户手点选包。
    const localPkg = engineBoot.findLocalPackage(LOCAL_ENGINE_DIRS);
    if (localPkg && !engineAutoLocalTried) {
      engineAutoLocalTried = true;
      engineDownloading = true;
      log('[engine] 发现本地引擎包：' + localPkg.file + '（' + (localPkg.bytes / 1048576).toFixed(1) + ' MB）');
      sendBoot({
        stage: 'engine-install', pct: 0,
        text: '发现本地引擎包，正在校验…',
        detail: localPkg.name
      });
      (async function () {
        try {
          const sha = await engineBoot.sha256File(localPkg.file, function (p) {
            sendBoot({
              stage: 'engine-install', pct: Math.round((p.pct || 0) * 0.8),
              text: '校验本地引擎包…',
              detail: localPkg.name + ' · ' + (p.bytes / 1048576).toFixed(1) + ' MB'
            });
          });
          log('[engine] 本地包校验完成（sha256 ' + sha.slice(0, 12) + '…），开始解包安装');
          const r = await installEngineThenStart({ ok: true, url: localPkg.file, sha256: sha, version: '', origin: ['local-auto'] }, true);
          if (r && r.ok) {
            log('[engine] 本地引擎包装好：v' + (r.version || '?') + '，清理安装包副本');
            try { fs.unlinkSync(localPkg.file); } catch (e) { log('[engine] 安装包副本删不掉（不挡运行）：' + e.message); }
            try { fs.rmdirSync(path.dirname(localPkg.file)); } catch (e) { log('[engine] 引擎包目录还有别的文件，保留：' + e.message); }
          } else {
            log('[engine] 本地引擎包安装失败：' + String((r && r.err) || '未知'));
          }
        } catch (e) {
          log('[engine] 本地引擎包安装异常：' + ((e && e.message) || String(e)));
          sendBoot({ stage: 'engine-missing', pct: 0, text: '本地引擎包安装失败', detail: (e && e.message) || String(e) });
        } finally {
          engineDownloading = false;
        }
      })();
      return false;
    }
    sendBoot({
      stage: 'engine-missing', pct: 0,
      text: '未检测到 DSH 引擎',
      detail: eng.text + ' · 首次启动需要引擎包（安装器同目录的 引擎-*.tar.gz 会自动装载）'
    });
    return false;
  }
  const plans = [];
  // 2026-11-14 实测（同条件：真 DSH_HOME + 3099 端口，各两次）：pnpm 脚本 14.1s / 12.9s，内置入口 20.6s / 20.3s。
  //   结论：本机 pnpm 反而更快 —— 内置入口要先过 @deepseek-ai/dsh-app-boot 的整棵扫描才起服务。
  //   ⛔ 别再凭"跳过三层转译就一定更快"把顺序调回去；要改先按上面方式各测两次。
  // 2026-11-21 安装版：机器上没有 pnpm，走 pnpm 计划只会白等 90 秒 ⇒ 直接走内置入口。
  if (PACKAGED && fs.existsSync(cliBuiltNow())) {
    plans.push({ label: '内置入口', detail: 'CLI 构建产物（安装版首选）', spawn: spawnServerDirect, budget: 60 });
  } else {
    plans.push({ label: 'pnpm 脚本', detail: 'pnpm dsh web（tsx 转译）', spawn: spawnServerPnpm, budget: 90 });
    if (fs.existsSync(cliBuiltNow())) {
      plans.push({ label: '内置入口', detail: 'CLI 构建产物（pnpm 不可用时兜底）', spawn: spawnServerDirect, budget: 45 });
    }
  }

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    sendBoot({ stage: 'spawn', pct: 12, text: '正在启动 Harness 引擎…', detail: plan.detail });
    serverProc = plan.spawn();
    const proc = serverProc;
    const t0 = Date.now();
    while ((Date.now() - t0) < plan.budget * 1000) {
      await sleep(300);   // 300ms 轮询：引擎就绪后最多 0.3s 就能进入下一步（原来 1s）
      if (await probe()) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log('engine ready in ' + secs + 's via ' + plan.label);
        sendBoot({ stage: 'ready', pct: 92, text: '引擎已就绪，正在加载界面…', detail: plan.label + ' · ' + secs + 's' });
        resetBootFail();
        markEngineGood();
        // 引擎就绪后异步巡检一次缓存体积（8s 后跑，不跟启动抢 IO、不自动删）
        if (!CACHE_HINT_SCHEDULED) {
          CACHE_HINT_SCHEDULED = true;
          setTimeout(function () { maybeHintCacheSize(); }, 8000);
        }
        // 面板会话自愈：等引擎把会话存储落盘后 2s 再扫，避免刚建就判定不存在
        setTimeout(function () { healSessionBindings(); }, 2000);
        return true;
      }
      if (proc.exitCode !== null) {
        log(plan.label + ' exited early (code=' + proc.exitCode + ')');
        sendBoot({ stage: 'spawn', pct: 14, text: '该启动方式未成功，正在尝试兜底…', detail: plan.label + ' 退出（code ' + proc.exitCode + '）' });
        break;
      }
      const el = (Date.now() - t0) / 1000;
      const pct = Math.min(88, 14 + Math.round((el / plan.budget) * 74));
      sendBoot({ stage: 'wait', pct: pct, text: '引擎启动中…', detail: plan.detail + ' · ' + el.toFixed(0) + 's' });
    }
    killServer();
  }
  sendBoot({ stage: 'error', pct: 100, text: '引擎启动失败', detail: '可点「重试」，或查看 server.log' });
  try {
    const n = bumpBootFail()
    log('[engine] start failed, consecutive=' + n)
    // 连续两次起不来：自动回退到上一次“正常点”配置，再让用户点重试。
    if (n >= 2) {
      const tool = path.join(__dirname, '..', '工具', '引擎快照.mjs')
      if (fs.existsSync(tool)) {
        log('[engine] 连续失败 ⇒ 自动回退引擎配置正常点')
        topbarRunAsync(tool, ['--restore', '--yes'], 120000).then(function (r) {
          log('[engine] 自动回退' + (r && r.ok ? '完成' : '失败: ' + String((r && r.out) || '').slice(0, 160)))
        })
        resetBootFail()
      }
    }
  } catch (e) { log('[engine] boot-fail 计数异常: ' + String((e && e.message) || e)) }
  return false
}

function killServer() {
  if (serverProc) {
    try {
      spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true });
    } catch (e) { warnOnce("main", e) }
    serverProc = null;
  }
}

// ---- 场景标签顺序：读 / 写 / 应用（见 SCENE_ORDER_FILE 处的说明）----
function readSceneTabOrder() {
  try {
    const j = JSON.parse(fs.readFileSync(SCENE_ORDER_FILE, 'utf8'));
    if (j && Array.isArray(j.ids)) return j.ids.filter((x) => typeof x === 'string' && x);
  } catch (e) { warnOnce("main", e) }
  return [];
}
function saveSceneTabOrder(ids) {
  const clean = [];
  for (const raw of (Array.isArray(ids) ? ids : [])) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || clean.indexOf(id) >= 0) continue;   // 去空、去重
    clean.push(id);
    if (clean.length >= 200) break;                // 上限：坏数据也写不爆文件
  }
  try {
    fs.mkdirSync(path.dirname(SCENE_ORDER_FILE), { recursive: true });
    fs.writeFileSync(SCENE_ORDER_FILE, JSON.stringify({
      version: 1, savedAt: new Date().toISOString(), ids: clean
    }, null, 2));
  } catch (e) { log('[tabs] 保存场景标签顺序失败: ' + ((e && e.message) || e)); }
  return clean;
}
/** 按存下来的顺序排：已删掉的场景自动丢、新场景按 json 自然序追加在后面；标了 first 的场景固定在最前。 */
function applySceneTabOrder(list) {
  const saved = readSceneTabOrder();
  if (!saved.length) return list;
  const byId = {};
  list.forEach((s) => { byId[s.id] = s; });
  const ordered = saved.map((id) => byId[id]).filter(Boolean)
    .concat(list.filter((s) => saved.indexOf(s.id) < 0));
  return ordered.filter((s) => s.first).concat(ordered.filter((s) => !s.first));
}

// ---- 读取场景配置（scenarios/*.json）----
function listScenarios() {
  const out = [];
  if (!fs.existsSync(SCENARIOS_DIR)) return out;
  for (const f of fs.readdirSync(SCENARIOS_DIR).sort()) {
    if (f.startsWith('_')) continue;   // 客户版：_模板-*.json 不参与场景列表
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8'));
      if (s && s.id) out.push({ id: s.id, name: s.name, description: s.description || '', first: !!s.first });
    } catch (e) { warnOnce("main", e) }
  }
  // 在这里就排好 ⇒ 任何消费方（主窗口标签栏 / 独立场景窗口 / 以后的新界面）拿到的顺序天然一致
  return applySceneTabOrder(out);
}

function getScenario(id) {
  const f = path.join(SCENARIOS_DIR, id + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

// ---- 多公司模板支持：当前场景的 meta（可覆盖 SSH/服务/映射/日志/网址）----
// meta 缺省 → 全部回落 oa.db 全局配置（原有场景行为不变）
let oaActiveScenario = 'oa-ops';
function scenarioMeta(sid) {
  const s = getScenario(sid || oaActiveScenario);
  return (s && s.meta && typeof s.meta === 'object') ? s.meta : {};
}
function applyOaScenario(sid) {
  const id = String(sid || '').trim();
  if (!id) return { ok: false, err: '缺少场景 id' };
  oaActiveScenario = id;
  const m = scenarioMeta(id);
  try { oaSsh.setMeta(m); } catch (e) { warnOnce("main", e) }
  invalidateOaCache();          // 切场景后所有采集缓存作废（不同公司数据不能混）
  const sc = getScenario(id);
  return {
    ok: true,
    id: id,
    name: (sc && sc.name) || id,
    company: m.company || '',
    hasMeta: !!(m && Object.keys(m).length),
    ssh: { host: (m.ssh && m.ssh.host) || oaStore.getConfig('ssh.host') || '', user: (m.ssh && m.ssh.user) || oaStore.getConfig('ssh.user') || '' }
  };
}

// ---- 本机配置：端口、工具路径等（机器配置.json 只读；⛔ 不写入）----
const MACHINE_FILE = MACHINE_FILE_EARLY;
function readMachineConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch (e) { return {}; }
}
const MACHINE = readMachineConfig();

function startSiteServer() {
  if (siteServer) return;
  siteServer = http.createServer(function (req, res) {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    // 保命入口：http://127.0.0.1:31238/chat → 用**当前** token 跳到引擎对话页。
    // 为什么需要：引擎每次启动都会随机生成新 token（见引擎源码 packages/client/connection/README.md），
    // 所以「带 token 的收藏网址」一重启就 401。这个固定入口只要工作台在跑就总能进对话。
    if (u === '/chat' || u === '/chat/') {
      const t = harnessToken;
      if (t) {
        res.writeHead(302, { Location: BASE + '/?token=' + t, 'Cache-Control': 'no-store' });
        res.end('redirecting to chat...');
      } else {
        // 引擎还没起来 / 还没抓到 token：给一个会自动重试的提示页，而不是 401 白屏
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>等待引擎…</title>' +
          '<body style="background:#0b0d12;color:#e6e8ee;font:14px/1.8 system-ui;padding:40px">' +
          '<h2>引擎还没就绪</h2><p>工作台正在启动 Harness 引擎（或还没拿到本次启动令牌）。</p>' +
          '<p>这个页面<b>不再自动刷新</b>；看到引擎起来后，点下面按钮重新检查。</p>' +
          '<p><a href="" style="display:inline-block;padding:9px 18px;border:1px solid #3b82f6;border-radius:8px;color:#93c5fd;text-decoration:none">🔄 重新检查</a></p>' +
          '<p style="color:#64748b;font-size:12px">2026-11-01 起改为手动重试</p></body>');
      }
      return;
    }
    // 其它路径一律 404：个人站官网预览与 /__community/ 社区站预览已于 2026-11-12 删除；
    // 桌宠 Live2D 面板（/petlive2d/*）于 2026-11-23 移除。
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('not found');
  });
  // ★ 2026-09-26：同一台机上可能同时跑着两个壳（dev 工作台 + 安装版）⇒ 31238 只能被一个占住。
  //   占不到的那个**安静退让**（原来会抛未捕获的 EADDRINUSE 刷日志），保命入口/官网预览由占住的那个提供；
  //   它自己取主界面地址时走 http://127.0.0.1:31238/chat（见下方 harness:url）⇒ 照样能进官方主界面。
  // ★ 2026-09-26：同一台机上可能同时跑着两个壳（dev 工作台 + 安装版）⇒ 31238 只能被一个占住。
  //   占不到的那个**安静退让**（原来会抛未捕获的 EADDRINUSE 刷日志），保命入口由占住的那个提供；
  //   它自己取主界面地址时走 http://127.0.0.1:31238/chat（见下方 harness:url）⇒ 照样能进官方主界面。
  siteServer.on('error', function (e) {
    log('[site] 端口 ' + SITE_PORT + ' 没占上（' + ((e && e.code) || e) + '）⇒ 本实例让给已在跑的那个壳；'
      + '保命入口继续由它提供，主界面仍走 http://127.0.0.1:' + SITE_PORT + '/chat');
    siteServer = null;
  });
  siteServer.listen(SITE_PORT, '127.0.0.1', function () {
    log('[site] 保命入口服务已启动: http://127.0.0.1:' + SITE_PORT + '（/chat）');
  });
}

// （2026-11-12 删除）个人站场景的 collectSiteContext / buildSiteSystem 已随场景一并移除：
//   两者原先只服务 personal-site 面板（前者给面板填标题/自媒体账号，后者拼个人站 AI 的系统提示），
//   buildSiteSystem 已无任何调用点，collectSiteContext 只被 site:info 调用；面板与 IPC 均已删除。


// 建窗口：opts = { isMain, scene, saved }
//   isMain=true  → 主窗口（场景标签页齐全，行为与以前完全一致）
//   isMain=false → 「场景分离窗口」：只渲染 opts.scene 这一个场景，隐藏场景标签栏（渲染层按 URL 的 solo=1 处理）
function createWindow(opts) {
  opts = opts || {};
  const isMain = !!opts.isMain;
  const scene = String(opts.scene || '');
  const defW = isMain ? 1380 : 1220;
  const defH = isMain ? 900 : 840;
  const fit = fitSavedBounds(opts.saved, defW, defH);
  const bounds = fit.bounds || { width: defW, height: defH };
  const winOpts = {
    width: bounds.width,
    height: bounds.height,
    minWidth: 1000,
    minHeight: 660,
    title: isMain ? 'DSH 引擎' : (sceneNameOf(scene) + ' · 胡闹的工作台'),
    autoHideMenuBar: true,
    frame: false,
    // 2026-11-19：视觉分层后默认浅色画布 #e9edf2（渲染层 applyTheme 会再按实际主题同步一次）
    backgroundColor: '#e9edf2',
    icon: path.join(__dirname, 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  };
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') { winOpts.x = bounds.x; winOpts.y = bounds.y; }
  const win = new BrowserWindow(winOpts);
  win.kunRole = isMain ? 'main' : 'scene';
  win.kunScene = isMain ? '' : scene;
  // 网页版 AI 桥的派发目标：记住"最后被聚焦的窗口"——分离窗口也是一整套壳（自带 preload+渲染器+桥），
  // 任务千万不能广播（旧版本桥会抢单，界面里看到的却一直是新代码，极难排查）。
  win.on('focus', function () { lastFocusedWin = win; });
  if (isMain) lastFocusedWin = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', function () {
    win.show();
    if (fit.maximized) { try { win.maximize(); } catch (e) { warnOnce("main", e) } }
    if (isMain) log('[boot] 窗口可见耗时 ' + (Date.now() - APP_T0) + 'ms');
    else log('[win] 场景窗口已打开: ' + scene + (fit.clamped ? '（原屏幕已不在，已夹回主屏）' : ''));
  });
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url) || /^mailto:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', function (e, url) {
    // 只允许：引擎地址(DSH_PORT) + GUI 自己目录下的 file:// 页面。
    // 其余一律拦截 —— 这样"把文件拖到窗口上"不会把界面导航到那个文件（观感像闪退）。
    // 注意：主进程主动 loadFile 不会触发 will-navigate，所以启动不受影响。
    const u = String(url);
    const ownDir = __dirname.replace(/\\/g, '/').toLowerCase();
    const isOwnFile = u.indexOf('file://') === 0 && decodeURIComponent(u).toLowerCase().indexOf(ownDir) >= 0;
    if (u.indexOf(BASE) !== 0 && !isOwnFile) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', function () {
    // 关之前先把几何记下来：主窗口关闭时还要连带关闭分离窗口，那一刻它们的位置已经取不到了
    noteWindowRect(win);
    if (isMain) { quitRequested = true; saveWinLayout(); }
  });
  win.on('closed', function () {
    if (isMain) {
      mainWindow = null;
      quitRequested = true;
      // 主窗口关闭 = 整个应用退出（用户选定的行为）：连带关掉分离窗口
      for (const w of detachWindows.slice()) { try { w.close(); } catch (e) { warnOnce("main", e) } }
    } else {
      const i = detachWindows.indexOf(win);
      if (i >= 0) detachWindows.splice(i, 1);
      // 用户主动关掉某个场景窗口 = 下次启动不再恢复它；整个应用退出时则保留布局
      if (!quitRequested && win.kunScene) delete layoutCache.detached[win.kunScene];
      saveWinLayout();
      notifyWindowsChanged();
    }
  });
  // 窗口移动 / 缩放：工业软件内置窗与外挂面板要跟着 GUI 走
  win.on('move', function () { scheduleAppwFollow(win); noteWindowRect(win); saveWinLayoutSoon(); });
  win.on('resize', function () { scheduleAppwFollow(win); noteWindowRect(win); saveWinLayoutSoon(); });
  if (isMain) {
    mainWindow = win;
  } else {
    detachWindows.push(win);
    noteWindowRect(win);
    saveWinLayout();
  }
  // 分离窗口：URL 带场景 id + solo 标记 → 渲染层只画这一个场景（并隐藏场景标签栏）
  win.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    isMain ? undefined : { query: { scene: scene, solo: '1' } }
  );
  if (!isMain) notifyWindowsChanged();
  return win;
}

// 「在新窗口打开场景」：已在独立窗口里的场景 → 把那个窗口拉到前台，不重复开
function openSceneWindow(sceneId) {
  const id = String(sceneId || '').trim();
  if (!id) return { ok: false, err: 'empty-scene' };
  // 场景 json 可能已被删/改名 → 先校验，避免开出一个空壳窗口（渲染层取不到场景就只剩空白）
  try {
    const known = listScenarios().map(function (s) { return s.id; });
    if (known.indexOf(id) < 0) return { ok: false, err: 'unknown-scene', scene: id };
  } catch (e) { warnOnce("main", e) }
  const exist = findSceneWindow(id);
  if (exist) {
    try {
      if (exist.isMinimized()) exist.restore();
      exist.show();
      exist.focus();
    } catch (e) { warnOnce("main", e) }
    return { ok: true, focused: true, scene: id };
  }
  createWindow({ scene: id });
  log('[win] 新开场景窗口: ' + id + '（' + sceneNameOf(id) + '）');
  return { ok: true, focused: false, scene: id };
}


// ---- 外链统一交给系统默认浏览器（对话里的网址点一下就跳默认浏览器）----
// 原因：Harness 界面跑在 <webview> 里，那是独立 webContents，
// 主窗口上的 setWindowOpenHandler / will-navigate 管不到它 →
// 对话里的网址（GFM 自动链接，target=_blank）以往在应用内弹窗或毫无反应。
// 这里对 guest(webview) 内容统一接管：外部 http(s)/mailto 交给系统默认浏览器，
// 本地/内部地址（Harness 127.0.0.1:3080、个人站 :31238、file:// 等）保持原行为。
//
// ★例外：「内置网页版 AI」的窗口（渲染器用 partition="persist:webai-<key>" 建，见
//   renderer\renderers.js 的 WEB_AI）必须"像浏览器一样"，否则两头坏（2026-09-20 实测）：
//   ① 它们自己会跳：智谱加载 2.2 秒后自家 iframe 带着 refer__991 参数再跳一次、
//      千问点"登录"要跳 passport.qianwen.com（阿里账号域）。一拦就 e.preventDefault()
//      → 登录框根本出不来（用户报「智谱和千问无法登陆」）；
//   ② 一拦的同时还会 shell.openExternal() → 一开 GUI 预热时豆包/智谱的页面自己一跳，
//      用户的系统浏览器就被弹出来了（用户报「打开 dsh 之后就会自动打开豆包和智谱的网页」）。
//   所以：这些 guest 的导航一律放行；它们的 window.open（登录小窗、文档链接）在应用内开小窗，
//   并沿用原分区（小窗里的登录态要能回到主窗口）。识别方式：会话存储目录里带 Partitions\webai-<key>
//   （contents.session.getStoragePath() 是公开 API，探针已核实取到 "webai-chatglm" 这种名字）。
const INTERNAL_PROTOCOLS = /^(file|about|data|blob|devtools|dsh-app|chrome-extension|ws|wss):/i;
const INTERNAL_HOSTS = { '127.0.0.1': true, 'localhost': true, '::1': true };
const EXTERNAL_PROTOCOLS = /^(https?|mailto):/i;

function guestPartition(contents) {
  try {
    const m = /[\\/]Partitions[\\/](.+)$/.exec(contents.session.getStoragePath() || '');
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function isInternalUrl(u) {
  if (!u) return true;
  if (INTERNAL_PROTOCOLS.test(u)) return true;
  try {
    return INTERNAL_HOSTS[new URL(u).hostname] === true;
  } catch (e) {
    return true;
  }
}

function openInSystemBrowser(u) {
  try {
    if (EXTERNAL_PROTOCOLS.test(u)) { shell.openExternal(u); return true; }
  } catch (e) { warnOnce("main", e) }
  return false;
}

app.on('web-contents-created', function (event, contents) {
  let type = '';
  try { type = contents.getType(); } catch (e) { return; }
  if (type !== 'webview') return;   // 主窗口已有自己的处理，不重复接管
  const part = guestPartition(contents);
  const webai = /^webai-/.test(part);   // 内置网页版 AI 的窗口
  // 2026-10-19 host: B站 scene opens Edge immediately. Embedded web panels (persist:embed-*)
  //   used to send EVERY external link / popup to openInSystemBrowser() -> system browser.
  //   For these partitions we now BLOCK instead (the panel has its own "open in browser" button).
  const isEmbed = /^embed-/.test(part);
  try {
    contents.setWindowOpenHandler(function (details) {
      if (isInternalUrl(details.url)) return { action: 'allow' };
      // 2026-10-19（bv-ai 反馈 · 宿主：「首页点视频/搜索没反应」）：embed 里 target=_blank / window.open 的链接
      //   以前直接 deny ⇒ 点了没反应。改成**就地打开**（照 scripts/sidebar.js L72-75 的写法）：
      //   不开新窗口、不弹系统浏览器，就在这个面板里继续走。
      if (isEmbed) {
        try { if (/^(https?:\/\/|file:\/\/)/.test(details.url || '')) contents.loadURL(details.url); } catch (e) { warnOnce("main", e) }
        return { action: 'deny' };
      }
      if (webai) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560, height: 720, autoHideMenuBar: true,
            webPreferences: { partition: 'persist:' + part },   // 登录小窗与主窗口共用登录态
          },
        };
      }
      openInSystemBrowser(details.url);
      return { action: 'deny' };
    });
  } catch (e) { warnOnce("main", e) }
  if (webai) return;   // 内置网页版 AI：导航完全照浏览器来，不接管
  contents.on('will-navigate', function (e, url) {
    if (isInternalUrl(url)) return;
    if (isEmbed) return;                            // 2026-10-19 embed: 就地导航（不弹系统浏览器、也别拦页面自己的跳转）
    if (openInSystemBrowser(url)) e.preventDefault();
  });
  try {
    contents.on('will-frame-navigate', function (e) {
      const url = e && e.url;
      if (!url || isInternalUrl(url)) return;
      if (isEmbed) return;                            // 2026-10-19 embed: iframe 导航也放行（B站的内部 iframe 全靠它）
      if (openInSystemBrowser(url)) e.preventDefault();
    });
  } catch (e) { warnOnce("main", e) }
});

// ---- IPC：渲染层请求 token / 场景配置 ----
ipcMain.handle('harness:url', () => {
  // ★ 2026-09-26：引擎是**外部进程**时，手上的 token 可能是旧的（引擎一重启就失效 ⇒ 主界面白屏
  //   `dsh web authentication required`）。改用保命入口：由真正拉起引擎的那个工作台提供，
  //   每次请求都拿**当前** token 跳转 ⇒ 安装版/第二个壳也能稳定进主界面。
  if (engineIsForeign) return 'http://127.0.0.1:' + SITE_PORT + '/chat';
  const token = harnessToken;
  return token ? (BASE + '/?token=' + token) : (BASE + '/');
});
// ---- 保命入口基础地址（2026-11-18，桌宠 3D 面板用 @site: 前缀拼页面 URL，场景 json 不写死端口）----
ipcMain.handle('site:base', () => 'http://127.0.0.1:' + SITE_PORT + '/');
// ---- 2026-11-11：token 晚到（端口先 listen、`dsh web: …?token=` 那行后打印）----
// 引擎的打印顺序：webServer 先 listen → loader.await()（整棵插件树）→ auditStartupEntries → 才 log 带 token 的 URL。
// 而壳的 probe() 只要端口有响应（401 也算）就判"就绪"⇒ 广播 harness:ready 时 harnessToken 可能仍是 null，
// 渲染层那次 isHarnessReady() 拿到 false 就再也不重试，启动页永远停在 92%。所以这里补一段**有界等待**。
// 等不到也不静默：返回 false 并写一条日志，渲染层会继续重试，最终给失败态 +「重试」。
const HARNESS_TOKEN_WAIT_MS = 3000;      // 单次询问最多等 3s（渲染层总共等 ~10s，会问 3 轮左右）
let tokenWaitWarned = false;             // 只在第一次等不到时写日志，避免渲染层重试刷屏
function waitHarnessToken(ms) {
  if (engineIsForeign || harnessToken) return Promise.resolve(true);
  return new Promise(function (resolve) {
    const t0 = Date.now();
    const timer = setInterval(function () {
      if (engineIsForeign || harnessToken) { clearInterval(timer); resolve(true); return; }
      if (Date.now() - t0 >= ms) { clearInterval(timer); resolve(false); }
    }, 100);
  });
}
ipcMain.handle('harness:ready', async () => {
  // 1. 外部引擎（走 /chat 保命入口）或 token 已到手 ⇒ 立刻放行
  if (engineIsForeign || harnessToken) return true;
  // 2. 端口通了但 token 行还没到 ⇒ 等一会儿，等不到返回 false 交给渲染层重试
  const ok = await waitHarnessToken(HARNESS_TOKEN_WAIT_MS);
  if (ok) { tokenWaitWarned = false; return true; }   // 等到了：下次再晚到还要能重新告警
  if (!tokenWaitWarned) {
    tokenWaitWarned = true;
    log('[boot] 端口已通，但 ' + HARNESS_TOKEN_WAIT_MS + 'ms 内没解析到 token（引擎还没打印 dsh web URL）⇒ 等渲染层重试');
  }
  return false;
});

// ---- IPC：版本信息（左上角品牌区悬停显示）----
// 放主进程读的原因：版本号来自各处 package.json，渲染层没有文件系统权限；
// 运行时版本（Electron / Chromium / Node）也只有主进程能一次拿全。
ipcMain.handle('app:version', () => {
  const readVer = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch (e) { return null; }
  };
  return {
    gui: readVer(path.join(__dirname, 'package.json')),
    engine: readVer(path.join(HARNESS_DIR, 'package.json')),
    cli: readVer(path.join(HARNESS_DIR, 'apps', 'cli', 'package.json')),
    engineDir: HARNESS_DIR,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
    app: (() => { try { return app.getVersion(); } catch (e) { return ''; } })(),
  };
});

// ---- 内嵌 Harness 面板精简模式：主进程向 webview 注入（只保留聊天流 + 输入框）----
// 隐藏：左侧菜单栏 / 右侧详情列（框架内联 grid-template-columns「Npx minmax(0,1fr) Npx」，
// 用 !important 强制 0/1fr/0，手柄 data-side 隐藏）；对话区顶部会话标题栏（data-phase > header）；
// 对话轨迹 turn rail（[data-chat-flow] 前一兄弟）；宽度拖条（data-width-handle）。
// ★会话列「铺满」★（2026-09-20 第三波，与 renderer\renderers.js 同名常量保持一致）
// 真因（探针 `_排查脚本存档\probe-chat-width` 实测，renderers.js 里有完整说明）：会话列 [data-chat-flow] 的
// `max-width: var(--dsh-chat-content-width)` 是**就地算**的 clamp(680px, 声明元素自身宽度×64%, 920px)，
// 而 [data-phase] 在本版引擎里是"连接状态小圆点"，不是会话相位容器 ⇒ 老写法（往 [data-phase] 写变量）
// 整条空转，列被钉在 887px。现在改成：① 直接盖 max-width；② 沿祖先链逐层压变量（就近生效，压过 .body）；
// ③ CSS 兜底。两边都写 `calc(100% - 16px)` 时，由于父层内边距不同（32px / 16px），自动得到
// "输入卡比会话列宽 32px"＝引擎原设计比例。改这个数之前先跑一次探针拿 before/after。
const HARNESS_WIDE_COL = 'calc(100% - 16px)';
const HARNESS_WIDE_CARD = 'calc(100% - 16px)';
const HARNESS_WIDE_CSS = [
  '[data-chat-flow] { max-width: ' + HARNESS_WIDE_COL + ' !important; }',
  '[data-composer-card] { max-width: ' + HARNESS_WIDE_CARD + ' !important; }',
  '[class*="embeddedBody"], [class*="column"] { --dsh-chat-content-width: ' + HARNESS_WIDE_COL +
  ' !important; --dsh-composer-card-max-width: ' + HARNESS_WIDE_CARD + ' !important; }'
].join('\n');
// 自维持：宿主只投几次，页面重渲染后自己纠回来（window 级守卫，防止攒出一堆定时器）。
const HARNESS_WIDE_PIN_JS = `(() => {
  var COL = ${JSON.stringify(HARNESS_WIDE_COL)}, CARD = ${JSON.stringify(HARNESS_WIDE_CARD)};
  // 2026-11-20：同值不写（沿祖先链每轮都 setProperty 会不停制造 style mutation），间隔 2s → 5s
  var setIf = function (el, prop, val) {
    try {
      if (el.style.getPropertyValue(prop) === val && el.style.getPropertyPriority(prop) === 'important') return;
      el.style.setProperty(prop, val, 'important');
    } catch (e) { window.__kunErr = e; }
  };
  var pinOnce = function () {
    if (window.__kunActive === false) return '0列 0/0px';
    var pin = function (el) {
      while (el && el.nodeType === 1) {
        try {
          setIf(el, '--dsh-chat-content-width', COL);
          setIf(el, '--dsh-composer-card-max-width', CARD);
        } catch (e) { warnOnce("main", e) }
        el = el.parentElement;
      }
    };
    var cols = document.querySelectorAll('[data-chat-flow]');
    for (var i = 0; i < cols.length; i++) { setIf(cols[i], 'max-width', COL); pin(cols[i]); }
    var cards = document.querySelectorAll('[data-composer-card]');
    for (var j = 0; j < cards.length; j++) { setIf(cards[j], 'max-width', CARD); pin(cards[j]); }
    var c0 = cols[0], w = 0, pw = 0;
    if (c0) {
      try {
        w = c0.getBoundingClientRect().width;
        // ⚠ 分母用父层**内容盒**（clientWidth 去左右内边距），不能用 border box —— max-width 的 % 就是这么算的
        var p = c0.parentElement || c0, cs = null;
        try { cs = getComputedStyle(p); } catch (e2) { warnOnce("main", e2) }
        pw = p.clientWidth - ((cs && parseFloat(cs.paddingLeft)) || 0) - ((cs && parseFloat(cs.paddingRight)) || 0);
      } catch (e) { warnOnce("main", e) }
    }
    return { cols: cols.length, cards: cards.length, w: Math.round(w), pw: Math.round(pw) };
  };
  var r = pinOnce();
  try { if (!window.__kunWideTimer) window.__kunWideTimer = setInterval(pinOnce, 5000); } catch (e) { warnOnce("main", e) }
  return r.cols + '列 ' + r.w + '/' + r.pw + 'px';
})()`;
const HARNESS_CHAT_CSS = [
  '[style*="grid-template-columns"][style*="minmax(0"] { grid-template-columns: minmax(0, 1fr) !important; }',
  '[style*="grid-template-columns"][style*="minmax(0"] [data-side="sidebar"], [style*="grid-template-columns"][style*="minmax(0"] [data-side="details"] { display: none !important; }',
  '[style*="grid-template-columns"][style*="minmax(0"] [data-phase] > header { display: none !important; }',
  '[style*="grid-template-columns"][style*="minmax(0"] [data-width-handle] { display: none !important; }',
  // 文字铺满：老写法 `[data-phase] { --dsh-chat-content-width: 100% !important }` 在引擎 0.1.6 上整条空转，
  // 换成上面那组「盖 max-width + 沿祖先链压变量」（与渲染层 renderers.js 用同一份内容）。
  HARNESS_WIDE_CSS
].join('\n');
const HARNESS_FIX_JS = `(() => {
  // 2026-11-20 卡顿治理（与 renderer/renderers.js 同一份逻辑，改动要两边同步）：
  //   ① 同值不写，打断「fix 写样式 → MutationObserver → 再 fix」的自激循环；
  //   ② 框架元素缓存，不再每秒跑一次全文档 [style*=...] 选择器；
  //   ③ observer 合并到 350ms 一次，定时器 1s → 4s 只作保险；后台/隐藏场景整轮跳过。
  const setIf = (el, prop, val, imp) => {
    try {
      if (el.style.getPropertyValue(prop) === val && el.style.getPropertyPriority(prop) === (imp ? 'important' : '')) return;
      el.style.setProperty(prop, val, imp ? 'important' : '');
    } catch (e) { window.__kunErr = e; }
  };
  const pick = () => {
    const c = window.__kunFixFrame;
    if (c && c.isConnected) {
      const cv = c.style.gridTemplateColumns || '';
      if (cv.indexOf('minmax(') >= 0) return c;
    }
    const all = document.querySelectorAll('[style*="grid-template-columns"]');
    for (let i = 0; i < all.length; i++) {
      const v = all[i].style.gridTemplateColumns || '';
      if (v.indexOf('minmax(') >= 0) { window.__kunFixFrame = all[i]; return all[i]; }
    }
    return null;
  };
  const fix = () => {
    const f = pick();
    if (!f) return false;
    // 会话列铺满（见上方 HARNESS_WIDE_CSS / HARNESS_WIDE_PIN_JS 的实测说明）：每次 fix 重算一次，
    // React 重渲染把 max-width 顶回去也能在几秒内纠回来。
    try { window.__wideTxt = ${HARNESS_WIDE_PIN_JS}; } catch (e) { warnOnce("main", e) }
    // 单轨道：配合下方结构隐藏，仅剩的中心列占满整个框架
    setIf(f, 'grid-template-columns', 'minmax(0, 1fr)', true);
    // 结构法：定位中心列（含聊天流/会话），隐藏框架其余非定位子元素（侧栏列/详情列）
    let center = null;
    const flow = f.querySelector('[data-chat-flow]') || f.querySelector('[data-phase]');
    if (flow) {
      let n = flow;
      while (n && n.parentElement && n.parentElement !== f) n = n.parentElement;
      if (n && n.parentElement === f) center = n;
    }
    // 保护：中心列未定位到就不做结构隐藏，避免整面板空白
    if (center) {
      const kids = f.children;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c === center) continue;
        let pos = 'static';
        try { pos = getComputedStyle(c).position; } catch (e) { warnOnce("main", e) }
        if (pos === 'absolute') continue;
        setIf(c, 'display', 'none', true);
      }
    }
    f.querySelectorAll('[data-side="sidebar"], [data-side="details"], [data-width-handle]').forEach(function (h) {
      setIf(h, 'display', 'none', true);
    });
    f.querySelectorAll('[data-phase]').forEach(function (r) {
      // ⚠ 老代码这里往 [data-phase] 上写 --dsh-chat-content-width；本版 [data-phase] 是连接状态小圆点，
      //   写在上面的变量到不了会话列（实测列仍被钉在 887px）。宽度改由上面的 HARNESS_WIDE_PIN_JS 负责，
      //   **不再依赖 [data-phase] 这个会随版本漂移的锚点**。
      // 隐藏不含聊天流的子元素（即会话顶栏；body 含 [data-chat-flow]，保留）
      const kids = r.children;
      let hasFlow = false;
      for (let j = 0; j < kids.length; j++) {
        if (kids[j].querySelector('[data-chat-flow]')) { hasFlow = true; break; }
      }
      if (!hasFlow) return;
      for (let j = 0; j < kids.length; j++) {
        const c = kids[j];
        if (c.querySelector('[data-chat-flow]')) continue;
        setIf(c, 'display', 'none', true);
      }
    });
    if (flow) {
      const sc = flow.parentElement;
      if (sc && sc.firstElementChild && sc.firstElementChild !== flow) {
        setIf(sc.firstElementChild, 'display', 'none', true);
      }
    }
    return true;
  };
  fix();
  // 幂等守卫：主进程也会 dom-ready/did-finish-load 各投一次，不守卫就会攒出多个 MutationObserver + 定时器。
  if (window.__kunActive === undefined) window.__kunActive = true;
  window.__kunSetActive = function (on) {
    window.__kunActive = !!on;
    if (on && window.__kunScheduleFix) { try { window.__kunScheduleFix(); } catch (e) { window.__kunErr = e; } }
  };
  if (!window.__kunFixOn) {
    window.__kunFixOn = 1;
    let fixPending = false;
    const scheduleFix = () => {
      if (fixPending) return;
      fixPending = true;
      setTimeout(() => {
        fixPending = false;
        if (window.__kunActive === false) return;
        try { fix(); } catch (e) { window.__kunErr = e; }
      }, 350);
    };
    window.__kunScheduleFix = scheduleFix;
    try { new MutationObserver(scheduleFix).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }); } catch (e) { warnOnce("main", e) }
    setInterval(() => { if (window.__kunActive === false) return; scheduleFix(); }, 4000);
  }
  const all = document.querySelectorAll('[style*="grid-template-columns"]');
  const f2 = pick();
  const vals = [];
  for (let i = 0; i < all.length && i < 5; i++) vals.push(all[i].style.gridTemplateColumns);
  const rootEl = document.getElementById('root') || document.body;
  let rect = null;
  if (f2) { const r = f2.getBoundingClientRect(); rect = { x: r.x, y: r.y, w: r.width, h: r.height }; }
  const kidsInfo = [];
  if (f2) {
    const kk = f2.children;
    for (let i = 0; i < kk.length && i < 8; i++) {
      const c = kk[i];
      let pos = 'static', cr = { x: -1, w: -1 };
      try { pos = getComputedStyle(c).position; cr = { x: Math.round(c.getBoundingClientRect().x), w: Math.round(c.getBoundingClientRect().width) }; } catch (e) { warnOnce("main", e) }
      kidsInfo.push({ i: i, cls: (c.className && c.className.toString().slice(0, 30) || c.tagName), pos: pos, x: cr.x, w: cr.w, vis: c.offsetParent !== null });
    }
  }
  window.__fixDiag = JSON.stringify({
    found: !!f2,
    grid: f2 ? f2.style.gridTemplateColumns : '',
    grids: all.length,
    vals: vals,
    iframes: document.querySelectorAll('iframe').length,
    hasPhase: document.querySelectorAll('[data-phase]').length,
    hasChatFlow: document.querySelectorAll('[data-chat-flow]').length,
    wide: window.__wideTxt || '',   // 铺满实测：「1列 1576/1592px」= 铺满几列 · 列宽/可用宽（只差十几像素＝已铺满）
    rootKids: rootEl ? rootEl.children.length : -1,
    frameTag: f2 ? f2.tagName : '',
    frameCls: f2 ? (f2.className && f2.className.toString().slice(0, 60) || '') : '',
    frameRect: rect,
    kidsInfo: kidsInfo,
    sidebarEls: f2 ? f2.querySelectorAll('[data-side="sidebar"]').length : 0,
    winW: window.innerWidth,
    winH: window.innerHeight,
    title: document.title,
    url: location.href,
    pinDiag: (() => {
      const T = 'oa系统运维';
      const hits = [];
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        const t = (e.textContent || '');
        if (t.indexOf(T) < 0) continue;
        hits.push({ tag: e.tagName, cls: String(e.className || '').slice(0, 40), len: t.replace(/\\s+/g, ' ').trim().length, vis: e.offsetParent !== null });
        if (hits.length >= 8) break;
      }
      hits.sort(function (a, b) { return a.len - b.len; });
      return { total: hits.length, top3: hits.slice(0, 3), selected: !!document.querySelector('[aria-selected="true"]') };
    })()
  });
})();
// ---- 钉住会话：已移交渲染层（renderer/renderers.js 的 HARNESS_PIN_JS）单独负责 ----
// 原因（2026-09 根治）：这里原来还有一份"扫全文档模糊匹配 → 点击"的旧实现，每 4s 点一次，
// 与渲染层新逻辑并存 → 两个循环抢着点，渲染层刚钉对的会话会被这里点到聊天记录里
// 含同名字样的任意元素上，表现为「切场景后 AI 面板会话错乱 / 切不到对应会话」。
// 现在分工：main 只负责插入布局精简 CSS、执行布局修复 JS、截图与日志；
// 选会话/绑定会话 id 全部由渲染层完成（只在会话列表区域内匹配 + 绑定 id + 按 id 精确点）。
`;
// 2026-11-20 卡顿治理：每次注入都截图 + 落盘 + insertCSS + 全量诊断日志，是启动与切场景时最重的一串 I/O。
//   现在按 webContents 记状态：截图 20 秒最多一张（且窗口不可见不截）、CSS 每页只插一次
//   （重复 insertCSS 会在页面里叠同样规则，越叠越慢）、诊断只在内容变化时写日志。
const wvInjectState = new Map();   // webContentsId -> { capAt, cssAt, diag, hooked }
ipcMain.handle('harness:wv:inject', (e, webContentsId, pinTarget) => {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) {
    log('[wv:inject] webContents 不存在: ' + webContentsId);
    return { ok: false, err: 'no-webcontents' };
  }
  const st = wvInjectState.get(Number(webContentsId)) || { capAt: 0, cssAt: 0, diag: '', hooked: false };
  wvInjectState.set(Number(webContentsId), st);
  if (!st.hooked) {
    st.hooked = true;
    try { wc.once('destroyed', function () { wvInjectState.delete(Number(webContentsId)); }); } catch (ex) { warnOnce("main", ex) }
  }
  // 顺手截一张面板实况图（覆盖保存），便于排查"注入成功但界面没变"；限流 + 不可见不截
  try {
    const win = BrowserWindow.fromWebContents(wc);
    const now = Date.now();
    if ((!win || win.isVisible()) && now - st.capAt > 20000) {
      st.capAt = now;
      wc.capturePage().then(function (img) {
        if (img && !img.isEmpty()) {
          try {
            const dir = path.join(__dirname, 'captures');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'panel-latest.png'), img.toPNG());
            log('[wv:inject] 截图已保存 panel-latest.png');
          } catch (ex) { warnOnce("main", ex) }
        }
      }, function () { /* ignore */ });
    }
  } catch (ex) { warnOnce("main", ex) }
  try {
    if (!st.cssAt) {
      st.cssAt = 1;   // 每页只插一次；页面重载由渲染层 dom-ready / did-finish-load 那条链路重新插
      const p = wc.insertCSS(HARNESS_CHAT_CSS);
      if (p && typeof p.catch === 'function') p.catch(function (err) { log('[wv:inject] insertCSS 拒绝: ' + (err && err.message || err)); });
    }
  } catch (ex) { log('[wv:inject] insertCSS 失败: ' + (ex && ex.message || ex)); }
  try {
    // 钉住目标由调用方决定（OA 'oa系统运维' / 个人站 '个人站' / 分析助手 ['<机主>看盘助手','<机主>']）
    // 支持字符串或字符串数组（多候选）；以 JSON 数组字面量注入，避免引号转义问题
    const targets = (Array.isArray(pinTarget) ? pinTarget : [pinTarget])
      .map(function (t) { return String(t == null ? '' : t).trim(); })
      .filter(Boolean);
    const fixJs = HARNESS_FIX_JS.split('__DSH_PIN_TARGET__').join(JSON.stringify(targets.length ? targets : ['oa系统运维']));
    wc.executeJavaScript(fixJs).then(
      function (r) {
        log('[wv:inject] js 结果: ' + String(r));
        // 诊断信息挂在 window.__fixDiag（executeJavaScript 只返回最后表达式值，诊断用全局变量取回）
        try {
          wc.executeJavaScript('window.__fixDiag || null').then(
            function (d) {
              if (!d) return;
              const s = String(d).slice(0, 900);
              if (s === st.diag) return;   // 内容没变就不写日志（同一个面板每 2 秒一行会把 server.log 灌爆）
              st.diag = s;
              log('[wv:inject] diag: ' + s);
            },
            function () { /* ignore */ }
          );
        } catch (ex) { warnOnce("main", ex) }
      },
      function (err) { log('[wv:inject] js 失败: ' + (err && err.message || err)); }
    );
  } catch (ex) { log('[wv:inject] exec 异常: ' + (ex && ex.message || ex)); }
  return { ok: true };
});
ipcMain.handle('scenarios:list', () => listScenarios());
ipcMain.handle('scenario:get', (e, id) => getScenario(id));
// ---- 程序开发 · 项目下拉（2026-11-11）----
// 三个通道：列项目 / 切项目 / 接入新目录。写盘与判断全在 项目切换.js，这里只负责
// 「首次接入」时跑既有脚本（工作区 + 会话 + 改名 + 项目记忆），不另写一套 onboarding。
function runOnboardProject(root) {
  return new Promise(function (resolve) {
    const script = path.join(__dirname, 'scripts', '接入项目.mjs');
    if (!fs.existsSync(script)) { resolve({ ok: false, err: '找不到接入脚本：' + script }); return; }
    const nodeExe = resolveNodeExe();
    // 脚本按 DSH_GUI_BASE 的端口取 token、按 DSH_HOME 找会话：显式给一遍，别让它退回 3080 或 C 盘
    const env = scriptEnv({ DSH_GUI_BASE: BASE, DSH_HOME: DSH_HOME, DSH_LOG: LOG_FILE });
    let cmd = nodeExe, args = [script, '--root', root];
    if (!nodeExe) { env.ELECTRON_RUN_AS_NODE = '1'; cmd = process.execPath; }
    execFile(cmd, args, { cwd: __dirname, env: env, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      function (err, stdout, stderr) {
        const out = String(stdout || '') + (stderr ? '\n' + String(stderr) : '');
        if (err) { resolve({ ok: false, err: '接入脚本失败：' + ((err && err.message) || err), log: out.slice(-2000) }); return; }
        resolve({ ok: true, log: out.slice(-2000) });
      });
  });
}
ipcMain.handle('scene:projects', (e, scene, panelId) => {
  try { return projectSwitchSvc.list(String(scene || ''), String(panelId || '')); }
  catch (ex) { return { ok: false, err: '项目列表读取失败：' + String((ex && ex.message) || ex) }; }
});
ipcMain.handle('scene:switch-project', async (e, scene, panelId, root) => {
  const sid = String(scene || ''), pid = String(panelId || ''), wantRoot = String(root || '');
  let r;
  try { r = projectSwitchSvc.switchTo(sid, pid, wantRoot); }
  catch (ex) { return { ok: false, err: '切换失败：' + String((ex && ex.message) || ex) }; }
  if (!r || r.ok || !r.needOnboard) return r;
  // 这个目录还没接入（没工作区/没会话）⇒ 先按既有流程接入，成功后再切一次
  const on = await runOnboardProject(r.root || wantRoot);
  if (!on.ok) return { ok: false, err: on.err, log: on.log };
  try { r = projectSwitchSvc.switchTo(sid, pid, r.root || wantRoot); }
  catch (ex) { return { ok: false, err: '接入成功但切换失败：' + String((ex && ex.message) || ex), log: on.log }; }
  return Object.assign({ onboarded: true, log: on.log }, r);
});
ipcMain.handle('scene:add-project', async (e, scene, panelId) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!win) return { ok: false, err: '没有窗口' };
  let pick;
  try {
    pick = await dialog.showOpenDialog(win, {
      title: '选择要接入「程序开发」的项目目录',
      buttonLabel: '接入这个目录',
      properties: ['openDirectory']
    });
  } catch (ex) { return { ok: false, err: '打开目录选择框失败：' + String((ex && ex.message) || ex) }; }
  if (!pick || pick.canceled || !pick.filePaths || !pick.filePaths.length) return { ok: false, canceled: true };
  const root = pick.filePaths[0];
  const sid = String(scene || ''), pid = String(panelId || '');
  // 已经接入过的目录（有会话）直接切，不再建第二条会话；
  // 不在项目表里的目录（对话框选的、父目录也不在同级）同样要走接入。
  let first = null;
  try { first = projectSwitchSvc.switchTo(sid, pid, root); } catch (ex) { first = { ok: false, err: String((ex && ex.message) || ex) }; }
  if (first && first.ok) return first;
  if (first && !first.needOnboard && !first.notListed) return first;
  const on = await runOnboardProject(root);
  if (!on.ok) return { ok: false, err: on.err, log: on.log };
  let r;
  try { r = projectSwitchSvc.switchTo(sid, pid, root); }
  catch (ex) { return { ok: false, err: '接入成功但切换失败：' + String((ex && ex.message) || ex), log: on.log }; }
  return Object.assign({ onboarded: true, log: on.log }, r);
});
// ---- 场景内多会话（2026-11-13）：列会话 / 建临时会话 ----
// 口径：一个场景 = 一条主会话（面板 json 里那条，唯一写场景记忆）+ N 条临时会话（同 cwd、同一套场景身份，用完归档）。
// 这里只做「读列表」「建一条」；切到哪条由渲染层在自己分区里记（写会话键 + 重载 webview），不改场景配置。
const SESSION_CACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
function sessJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function sessNorm(p) { return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }
// 1. 会话索引快照：逐会话缓存是真源，总表补齐（与 工具\派发-公共.mjs 同一口径，别另立一套）
function sessAll() {
  const out = new Map();
  if (fs.existsSync(SESSION_CACHE_DIR)) {
    for (const f of fs.readdirSync(SESSION_CACHE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const rec = (sessJson(path.join(SESSION_CACHE_DIR, f)) || {}).record;
      const rows = (rec && rec.rows) || null;
      if (!rows) continue;
      const id = f.replace(/\.json$/, '');
      out.set(id, {
        id,
        title: String((rows.title && rows.title.val) || '').trim(),
        cwd: String((rec.identity && rec.identity.cwd) || ''),
        at: Number((rec.identity && rec.identity.createdAt) || 0)
      });
    }
  }
  const total = ((sessJson(path.join(DSH_HOME, 'storages', 'session_projcache.json')) || {}).tables || {}).sessions || {};
  for (const id of Object.keys(total)) {
    if (out.has(id)) continue;
    const v = total[id] || {};
    const rows = v.rows || {};
    out.set(id, {
      id,
      title: String((rows.title && rows.title.val) || '').trim(),
      cwd: String((v.identity && v.identity.cwd) || ''),
      at: Number((v.identity && v.identity.createdAt) || 0)
    });
  }
  return out;
}
function sessArchived() {
  const ws = sessJson(path.join(DSH_HOME, 'storages', 'workspace.json')) || {};
  return new Set((((ws.global || {}).archivedSessionIds) || []).map(String));
}
// 2. 面板 → 主会话 + 它所在目录（临时会话必须同 cwd，才带同一套场景身份）
function sessPanelOf(scene, panelId) {
  const sc = getScenario(String(scene || ''));
  const panel = (((sc && sc.panels) || []).filter((p) => p && String(p.id) === String(panelId || ''))[0]) || null;
  return { sc, panel };
}
function sessCwdOf(panel, all) {
  const bound = all.get(String((panel && panel.sessionId) || '')) || null;
  if (bound && bound.cwd) return bound.cwd;
  if (panel && panel.cwd) return String(panel.cwd);
  return path.join(path.dirname(__dirname), '工作区');
}
ipcMain.handle('scene:sessions', (e, scene, panelId) => {
  const { sc, panel } = sessPanelOf(scene, panelId);
  if (!panel) return { ok: false, err: '场景里没有面板「' + String(panelId || '') + '」（场景：' + String(scene || '') + '）' };
  const all = sessAll();
  const cwd = sessCwdOf(panel, all);
  const archived = sessArchived();
  const sceneName = String((sc && (sc.name || sc.id)) || scene || '');
  // 归属判定：主会话永远在表里；其余必须「同 cwd + 标题属于本场景」。
  // 为什么不能只按 cwd：6 个单场景面板的 cwd 都是同一个「工作区」，只按 cwd 会把人格会话、
  // 别的场景的会话一起端上来 ⇒ 场景身份当场失效。标题归属 = `<场景名>` 或 `<场景名>-…`
  // （新建临时会话就按 `<场景名>-临时-<用途>-<MMDDHHmm>` 命名，见 scene:new-session）。
  const owned = (t) => {
    const s = String(t || '').replace(/^已归档\s*·\s*/, '');
    if (!sceneName) return false;
    return s === sceneName || s.indexOf(sceneName + '-') === 0;
  };
  const rows = [];
  for (const s of all.values()) {
    const t = String(s.title || '');
    const isPrimary = String(s.id) === String(panel.sessionId || '');
    if (!isPrimary) {
      if (sessNorm(s.cwd) !== sessNorm(cwd)) continue;   // 别的项目目录：不归这个面板
      if (!owned(t)) continue;                           // 别的场景的会话：绝不列出来
    }
    rows.push({
      id: s.id,
      title: t || '(未命名)',
      primary: isPrimary,
      archived: archived.has(String(s.id)),
      temp: t.indexOf('-临时-') >= 0,
      at: s.at
    });
  }
  // 主会话永远在表里（索引还没落到缓存时也要能显示「主」）
  if (panel.sessionId && !rows.some((r) => r.primary)) {
    rows.push({ id: String(panel.sessionId), title: String(panel.sessionTitle || '(主会话)'), primary: true, archived: false, temp: false, at: 0 });
  }
  // 排序：主会话置顶，其余按创建时间新→旧
  rows.sort((a, b) => (Number(b.primary) - Number(a.primary)) || (b.at - a.at));
  return { ok: true, cwd, scene: sceneName, sessions: rows, bound: { id: String(panel.sessionId || ''), title: String(panel.sessionTitle || '') } };
});
// 3. 建一条临时会话：走 建会话.mjs（与 换会话 同一套 token→cookie→RPC），不自造通道；
//    --no-seed 跳过「塞开场消息再取消」那 10 秒 —— 建完立刻由面板打开，侧边栏自然会显示。
function sessStamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()); }
function sessionCreate(title, cwd) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'scripts', '建会话.mjs');
    if (!fs.existsSync(script)) { resolve({ ok: false, err: '找不到建会话脚本：' + script }); return; }
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) { warnOnce("main", e) }
    const nodeExe = resolveNodeExe();
    const env = scriptEnv({ DSH_GUI_BASE: BASE, DSH_HOME: DSH_HOME, DSH_LOG: LOG_FILE });
    let cmd = nodeExe, args = [script, '--title', title, '--cwd', cwd, '--no-seed'];
    if (!nodeExe) { env.ELECTRON_RUN_AS_NODE = '1'; cmd = process.execPath; }
    execFile(cmd, args, { cwd: __dirname, env, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '') + (stderr ? '\n' + String(stderr) : '');
        if (err) { resolve({ ok: false, err: '建会话失败：' + ((err && err.message) || err), log: out.slice(-2000) }); return; }
        const m = out.match(/sessionId\s*=\s*(session-[0-9a-fA-F-]+)/);
        if (!m) { resolve({ ok: false, err: '建会话成功但没解析到 sessionId', log: out.slice(-2000) }); return; }
        resolve({ ok: true, id: m[1], log: out.slice(-2000) });
      });
  });
}
ipcMain.handle('scene:new-session', async (e, scene, panelId, purpose) => {
  const { sc, panel } = sessPanelOf(scene, panelId);
  if (!panel) return { ok: false, err: '场景里没有面板「' + String(panelId || '') + '」' };
  const all = sessAll();
  const cwd = sessCwdOf(panel, all);
  const sceneName = String((sc && (sc.name || sc.id)) || scene || '场景');
  // 标题即归属：`<场景>-临时-<用途>-<MMDDHHmm>`（桌宠/派发按标题认人，命名要可读可辨）
  const clean = String(purpose || '').replace(/[\r\n\t]+/g, ' ').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 24) || '临时';
  const base = sceneName + '-临时-' + clean + '-' + sessStamp();
  // 同一分钟同用途再点一次 ⇒ 加序号，别造出两条同名会话（同名会让派发/桌宠认错人）
  let title = base, n = 1;
  while ([...all.values()].some((s) => String(s.title) === title)) { n += 1; title = base + '-' + n; }
  const r = await sessionCreate(title, cwd);
  if (!r.ok) return r;
  log('[scene:sessions] 新建临时会话「' + title + '」 ' + r.id + ' cwd=' + cwd);
  return { ok: true, id: r.id, title, cwd, log: r.log };
});
// 场景标签顺序（拖拽换位）：渲染层拖完报上来，下次开机 / 其它窗口都读它
ipcMain.handle('scenes:order:get', () => ({ saved: fs.existsSync(SCENE_ORDER_FILE), ids: readSceneTabOrder() }));
ipcMain.handle('scenes:order:set', (e, ids) => saveSceneTabOrder(ids));

// ---- 宿主通用能力（不属于任何场景）：打开/定位任意路径 ----
// 之前各场景为了"打开文件夹"互相借用通道（例如 OA 文件面板去调 app.site），
// 造成场景间耦合。这里提供一个平台级通道，任何场景都可以用，互不依赖。
// 安全：只允许打开「存在且非可执行」的路径，或 http(s)/mailto 链接。
ipcMain.handle('app:open-path', (e, target) => {
  const t = String(target || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    if (/^(https?:|mailto:)/i.test(t)) { shell.openExternal(t); return { ok: true }; }
    if (!fs.existsSync(t)) return { ok: false, err: '路径不存在：' + t };
    shell.openPath(t);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
ipcMain.handle('app:reveal-path', (e, target) => {
  const t = String(target || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    if (!fs.existsSync(t)) return { ok: false, err: '路径不存在：' + t };
    shell.showItemInFolder(t);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// ---- 宿主通用能力：读写文本文件（2026-09-20 加，给「预览面板 / 流程画布节点」用）----
// 为什么必须放主进程：渲染层在 file:// 下拿不到任意路径的文件内容（fetch 被禁、<webview> 只能看不能存），
// 而"画布上一个节点 = 一个真实文件（文案.md / 字幕.srt …）"这套玩法必须能读、能改、能存。
// 规矩：① 读任意存在的文件，但限大小（4 MB 以内，再大不给编辑器看）；
//       ② **写只允许 <盘根>:\ 或 <盘根>:\**（本机铁律：产物/素材不进 C 盘）；
//       ③ 先写 <文件>.kun-tmp 再改名覆盖 —— 避免写一半失败留下半个文件（原文件永远还在）。
// 面板侧封装：preload 暴露成 app.file.{read,write,stat}；没有这个接口 = 主进程还没重启过。
const FILE_TEXT_MAX = 4 * 1024 * 1024;
ipcMain.handle('kun:file:stat', async (e, p) => {
  const t = String(p || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    const st = await fs.promises.stat(t);
    return { ok: true, exists: true, isDir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  } catch (ex) {
    return { ok: true, exists: false, isDir: false, size: 0, mtime: 0 };
  }
});
ipcMain.handle('kun:file:read', async (e, p) => {
  const t = String(p || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    const st = await fs.promises.stat(t);
    if (st.isDirectory()) return { ok: false, err: '这是文件夹，不是文件' };
    if (st.size > FILE_TEXT_MAX) return { ok: false, err: '文件太大（' + (st.size / 1048576).toFixed(1) + ' MB），编辑器只开到 4 MB' };
    const text = await fs.promises.readFile(t, 'utf8');
    return { ok: true, path: t, text: text, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  } catch (ex) { return { ok: false, err: '读不到：' + String((ex && ex.message) || ex) }; }
});
ipcMain.handle('kun:file:write', async (e, p, text) => {
  const t = String(p || '');
  if (!t) return { ok: false, err: 'empty' };
  if (!/^[DE]:[\\/]/i.test(t)) return { ok: false, err: '只允许写到 D: 或 E: 盘：' + t };
  try {
    await fs.promises.mkdir(path.dirname(t), { recursive: true });
    const tmp = t + '.kun-tmp';
    await fs.promises.writeFile(tmp, String(text == null ? '' : text), 'utf8');
    await fs.promises.rename(tmp, t);
    const st = await fs.promises.stat(t);
    return { ok: true, path: t, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  } catch (ex) { return { ok: false, err: '写不了：' + String((ex && ex.message) || ex) }; }
});
// ---- 宿主通用能力：选文件夹（2026-09-23 加，画布节点的「生成路径（文件夹）」用）----
// 走系统对话框（openDirectory + createDirectory，可现场新建文件夹）：返回选中的文件夹绝对路径，取消返回 null。
// 按发起方窗口寻址（分离窗口也能用），拿不到就退回主窗口。
ipcMain.handle('kun:pick-folder', async (e) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!win) return null;
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择生成路径（文件夹）',
      buttonLabel: '选这个文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths[0];
  } catch (ex) { return null; }
});
// ---- 宿主通用能力：选具体文件（2026-09-23 第十一轮加，参考素材节点的「路径」用）----
// 与 pick-folder 对称：openFile，返回选中的文件绝对路径，取消返回 null。
ipcMain.handle('kun:pick-file', async (e) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!win) return null;
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择素材文件',
      buttonLabel: '选这个文件',
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths[0];
  } catch (ex) { return null; }
});
// ---- 独立窗口置顶（2026-09-23 第十一轮）：分离窗口顶部菜单栏的「📌 置顶」按钮用 ----
// win.setAlwaysOnTop(true/false)：窗口浮在最上层，缩小独立窗口后点主窗口/其它页面也不被遮挡。
ipcMain.handle('kun:set-always-on-top', (e, flag) => {
  const win = windowOfEvent(e);
  if (!win || win.isDestroyed()) return { ok: false };
  try {
    win.setAlwaysOnTop(!!flag);
    return { ok: true, on: !!flag };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// ---- 宿主通用能力：看本机某个端口在不在（2026-09-20 加，流程画布的「工具节点」状态点用）----
// 为什么用 TCP connect 而不是像 site:probe 那样发 HTTP：
//   ① 节点只需要"在不在跑"这一个事实，不需要页面内容；
//   ② ComfyUI 控制台(8189)/工作台(8188) 都是本机 HTTP 服务，端口连得上 = 已经起来了；
//   ③ HTTP 要等响应头，TCP 握手一成功就能返回，红点（没运作）也不会拖到几秒。
// 两个坑写在这儿免得以后又踩：
//   ① 本机开着 360 主动防御时，"连一个没人听的端口"要 ~2 秒才回（不是我们的锅，是它拦了一下），
//      所以默认超时压到 1200 ms，并且**永远 resolve、从不 reject** —— 面板要的是"当前状态"而非异常；
//   ② 只探测、不读也不写，参数校验到"是个端口号"为止（面板传的是场景里写死的本机端口）。
// ================= 本地电脑场景（原名电脑清理，2026-10-06 立）：本机磁盘分区容量 =================
// 用 Node 的 fs.statfsSync 只读算每个分区的总量/剩余（C/D/E/F；不存在的盘给 ok:false 而不是抛错）。
// 只读、只返回数字、不执行任何命令 —— 面板 renderers['pc-drives'] 每 10 秒调一次。
// ⚠ 这段在**主进程**里 ⇒ 改完要重启一次 GUI 才生效（面板本身是热更新的）。
ipcMain.handle('kun:sys:disks', () => {
  const drives = ['C', 'D', 'E', 'F'].map((letter) => {
    const root = letter + ':\\';
    const row = { drive: letter + ':', ok: false, total: 0, free: 0, used: 0, percent: 0, err: '' };
    try {
      const st = fs.statfsSync(root);
      const bsize = Number(st.bsize) || 0;
      const total = Number(st.blocks) * bsize;
      const free = Number(st.bavail) * bsize;
      if (!total) throw new Error('no-blocks');
      row.ok = true;
      row.total = total; row.free = free; row.used = Math.max(0, total - free);
      row.percent = Math.round(row.used / total * 1000) / 10;
    } catch (e) { row.err = (e && (e.code || e.message)) || 'unavailable'; }
    return row;
  });
  return { ok: true, at: Date.now(), drives };
});
ipcMain.handle('kun:net:probe', (e, host, port, timeoutMs) => {
  const h = String(host || '127.0.0.1');
  const p = Number(port) || 0;
  const wait = Math.max(120, Math.min(5000, Number(timeoutMs) || 1200));
  if (!p || p < 1 || p > 65535) return { ok: false, err: '端口不对：' + String(port) };
  return new Promise((resolve) => {
    const t0 = Date.now();
    let sock = null, done = false;
    const fin = (open) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch (x) { warnOnce("main", x) }
      resolve({ ok: true, host: h, port: p, open: !!open, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => fin(false), wait);
    try {
      sock = require('net').connect({ host: h, port: p });
      sock.setTimeout(wait);
      sock.on('connect', () => { clearTimeout(timer); fin(true); });
      sock.on('timeout', () => { clearTimeout(timer); fin(false); });
      sock.on('error', () => { clearTimeout(timer); fin(false); });
    } catch (ex) { clearTimeout(timer); fin(false); }
  });
});

// ---- 通用两个小工具（程序开发场景的「网址」面板 `code-urls` 在用，保留）----
// 2026-11-12：个人站的 site:preview / site:info / site:open-folder 已随面板删除，
//   只剩这两条：系统浏览器打开外链、主进程代发 HTTP 探测（绕开渲染器跨域限制）。
ipcMain.handle('site:open', (e, url) => {
  const u = String(url || '');
  if (/^(https?:|mailto:)/i.test(u)) { try { shell.openExternal(u); } catch (ex) { warnOnce("main", ex) } }
  return true;
});
// 网站可用性探测（我的网址状态；主进程发请求，绕开渲染器跨域限制）
ipcMain.handle('site:probe', (e, url) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, err: 'bad-url' };
  return new Promise((resolve) => {
    let mod = null, req = null, timer = null;
    // 2026-11-16：done / timer 必须提到 try 外 —— 原来 done 是 try 块里的 const，
    //   catch 里引用它就是 ReferenceError（探活一异常就变 reject），
    //   而且异常早于 timer 声明时还会在 clearTimeout(timer) 上再撞一次 TDZ。
    const done = (ok, status) => { if (timer) clearTimeout(timer); resolve({ ok: ok, status: status || 0 }); };
    try {
      mod = u.toLowerCase().indexOf('https:') === 0 ? require('https') : require('http');
      timer = setTimeout(() => { try { req && req.destroy(); } catch (x) { warnOnce("main", x) } done(false, 0); }, 6000);
      req = mod.get(u, { headers: { 'User-Agent': 'kun-probe/1.0' } }, (res) => {
        // 2xx / 3xx 视为在线
        const code = res.statusCode || 0;
        res.resume();
        done(code >= 200 && code < 400, code);
      });
      req.on('error', () => done(false, 0));
    } catch (ex) { done(false, 0); }
  });
});
// ---- 程序开发场景：把项目里的 H5 用「手机尺寸独立窗口」打开（400×830，独立持久会话 → 登录能记住）----
// 场景 json 的 code-urls 面板里给条目加 "phone": true 就会出现 📱 按钮；换项目只改 json。
ipcMain.handle('code:phone-window', (e, url, title) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, err: 'bad-url' };
  try {
    const win = new BrowserWindow({
      width: 400,
      height: 830,
      title: String(title || '手机预览'),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:code-phone-preview'
      }
    });
    win.setMenuBarVisibility(false);
    win.loadURL(u);
    return { ok: true };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});

// （2026-11-12 删除）个人站场景的本地文件浏览：site:files:local / site:open-file 两条 IPC 已移除。
//   它们只服务 personal-site 的「本地文件」面板（浏览根 SITE_BROWSE_DIR、点击交给系统程序），
//   面板删除后无调用方；同时移除的还有拖出功能 site:drag。


// ================= 自我复盘场景（独立命名空间 app.review，根＝<工作台>\自我复盘，只读） =================
// 需求：右上角浏览「自我复盘」镜像目录（主要都是 md），左上角大窗口"单击即预览"该文档。
// 为什么必须走主进程：渲染进程是 file:// 页面，fetch/XHR 读不了本地文件（图/视频能当子资源加载，
// 文本不能），所以目录列表与正文都由这里读盘；路径一律相对 REVIEW_DIR 解析并夹在本目录内。
// 只读：镜像是「<机主>-个人信息 / 我的知识库」的副本（技能 maben-profile 的默认只读约束），不提供任何写接口。
const REVIEW_DIR = process.env.REVIEW_DIR || path.resolve(__dirname, '..', '自我复盘');
const REVIEW_TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|log|ini|conf)$/i;
const REVIEW_MAX_BYTES = 4 * 1024 * 1024;   // 单篇上限 4 MB：超了只回前 4 MB，够看且不会把面板卡死

function resolveReviewPath(rel) {
  const root = path.resolve(REVIEW_DIR);
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = r ? path.resolve(root, r) : root;
  if (full !== root && !full.startsWith(root + path.sep)) return null;   // 越界 → null（不接受 .. 逃出）
  return { root: root, rel: r, full: full };
}

// 根目录是否存在（给面板显示"目录不见了"用）
ipcMain.handle('review:root', () => {
  const root = path.resolve(REVIEW_DIR);
  let exists = false;
  try { exists = fs.statSync(root).isDirectory(); } catch (ex) { exists = false; }
  return { ok: exists, root: root, label: REVIEW_DIR, exists: exists };
});

// 列目录：目录在前、中文按拼音排；text 标记可预览的文本类（md/txt/json…）
ipcMain.handle('review:files', (e, rel) => {
  const t = resolveReviewPath(rel);
  if (!t) return { ok: false, err: '越界路径：仅可浏览「自我复盘」目录' };
  let ents = [];
  try { ents = fs.readdirSync(t.full, { withFileTypes: true }); }
  catch (ex) { return { ok: false, err: '无法读取目录：' + t.full }; }
  const rows = ents
    .filter(en => !en.name.startsWith('.') && !en.name.startsWith('~$'))
    .map(en => {
      let isDir = en.isDirectory(), size = 0, mtime = 0;
      try {
        const st = fs.statSync(path.join(t.full, en.name));
        isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
      } catch (ex2) { warnOnce("main", ex2) }
      return { name: en.name, isDir: isDir, size: size, mtime: mtime, text: isDir || REVIEW_TEXT_EXT.test(en.name) };
    })
    .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return { ok: true, root: t.root, rel: t.rel, label: REVIEW_DIR, rows: rows };
});

// 读正文（utf8）：返回相对路径 / 绝对路径 / 大小 / 修改时间 / 内容 / 是否截断
ipcMain.handle('review:read', (e, rel) => {
  const t = resolveReviewPath(rel);
  if (!t) return { ok: false, err: '越界路径：仅可读取「自我复盘」目录' };
  if (t.full === t.root) return { ok: false, err: '这是根目录，不是文档' };
  try {
    const st = fs.statSync(t.full);
    if (st.isDirectory()) return { ok: false, err: '这是目录，不是文档' };
    if (st.size > 512 * 1024 * 1024) return { ok: false, err: '文件过大（>512MB），不预览' };
    const buf = fs.readFileSync(t.full);
    const cut = buf.length > REVIEW_MAX_BYTES;
    return {
      ok: true, rel: t.rel, path: t.full, size: st.size, mtime: Math.floor(st.mtimeMs / 1000),
      content: buf.slice(0, REVIEW_MAX_BYTES).toString('utf8'), cut: cut, text: REVIEW_TEXT_EXT.test(t.full)
    };
  } catch (ex) { return { ok: false, err: '读取失败：' + String((ex && ex.message) || ex) }; }
});

// ============ 通用：Office / WPS 文档 → PDF（预览面板内嵌显示用，2026-10-13 加）============
// 为什么这么做：Chromium 内核渲染不了 doc/docx/xls/xlsx/ppt/pptx，但**能渲染 PDF**（内核自带阅读器）。
//   本机装了 Microsoft Office ⇒ 借它的 COM 转一次 PDF，交给内核阅读器显示 ⇒ 版式是 Office 自己排的，最接近原样。
// 缓存：结果按「绝对路径 + 大小 + 修改时间」算 sha1，落在 %TEMP%\kun-office-pdf\；同一个文件第二次打开直接命中
//   （几百毫秒），不再起 Office。改过文件（大小或时间变了）⇒ 哈希变了 ⇒ 自动重转，不会看到旧版。
// 失败（.wps/.et/.dps 这类 WPS 私有格式 MS Office 打不开、或本机没装 Office）⇒ 明确回报错误，
//   预览层退回「用系统默认程序打开」的卡片，绝不白屏、绝不静默失败。
const OFFICE_PDF_DIR = path.join(os.tmpdir(), 'kun-office-pdf');
const OFFICE_PS1 = path.join(__dirname, 'scripts', 'office2pdf.ps1');
const OFFICE_KIND = {
  doc: 'word', docx: 'word', rtf: 'word', odt: 'word', wps: 'word',
  xls: 'excel', xlsx: 'excel', ods: 'excel', et: 'excel',
  ppt: 'ppt', pptx: 'ppt', odp: 'ppt', dps: 'ppt'
};
const officeJobs = {};          // key → Promise：同一个文件并发点两次只转一次
let officeSwept = false;

// 顺手清缓存：整个进程生命周期做一次，删掉 14 天没动过的（别让它无声长大）
function officeSweep() {
  if (officeSwept) return;
  officeSwept = true;
  try {
    const cut = Date.now() - 14 * 24 * 3600 * 1000;
    fs.readdirSync(OFFICE_PDF_DIR).forEach(function (f) {
      try {
        const p = path.join(OFFICE_PDF_DIR, f);
        if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p);
      } catch (e) { warnOnce("main", e) }
    });
  } catch (e) { warnOnce("main", e) }
}

function officeToPdf(src) {
  const ext = (path.extname(src).slice(1) || '').toLowerCase();
  const kind = OFFICE_KIND[ext];
  if (!kind) return Promise.resolve({ ok: false, err: '不是可转换的 Office 格式：.' + ext });
  let st = null;
  try { st = fs.statSync(src); } catch (e) { return Promise.resolve({ ok: false, err: '读不到文件：' + src }); }
  if (!st.isFile()) return Promise.resolve({ ok: false, err: '不是文件：' + src });
  if (st.size > 200 * 1024 * 1024) return Promise.resolve({ ok: false, err: '文件过大（>200MB），不做转换预览' });

  const key = crypto.createHash('sha1')
    .update(src.toLowerCase() + '|' + st.size + '|' + st.mtimeMs).digest('hex');
  const out = path.join(OFFICE_PDF_DIR, key + '.pdf');
  try { if (fs.statSync(out).size > 0) return Promise.resolve({ ok: true, pdf: out, cached: true }); }
  catch (e) { warnOnce("main", e) }
  if (officeJobs[key]) return officeJobs[key];

  officeSweep();
  const job = new Promise(function (resolve) {
    let settled = false;
    const finish = function (r) { if (!settled) { settled = true; resolve(r); } };
    try { fs.mkdirSync(OFFICE_PDF_DIR, { recursive: true }); }
    catch (e) { return finish({ ok: false, err: '建不了缓存目录：' + e.message }); }
    if (!fs.existsSync(OFFICE_PS1)) return finish({ ok: false, err: '缺少转换脚本 scripts\\office2pdf.ps1' });

    let ch = null;
    try {
      ch = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', OFFICE_PS1, '-In', src, '-Out', out, '-Kind', kind], { windowsHide: true });
    } catch (e) { return finish({ ok: false, err: '起不来 PowerShell：' + e.message }); }

    let so = '', se = '';
    if (ch.stdout) ch.stdout.on('data', function (d) { so += d.toString(); });
    if (ch.stderr) ch.stderr.on('data', function (d) { se += d.toString(); });
    // 90 秒兜底：Office 偶尔会卡在激活/字体对话框上，别让面板一直转圈
    const timer = setTimeout(function () { try { ch.kill(); } catch (e) { warnOnce("main", e) } }, 90000);
    ch.on('error', function (e) { clearTimeout(timer); finish({ ok: false, err: 'PowerShell 起不来：' + e.message }); });
    ch.on('close', function () {
      clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(out).size; } catch (e) { size = 0; }
      if (size > 0) return finish({ ok: true, pdf: out });
      const detail = String(se || so || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      finish({ ok: false, err: '转成 PDF 失败（' + kind + '）' + (detail ? '：' + detail : '') });
    });
  }).then(function (r) { delete officeJobs[key]; return r; });

  officeJobs[key] = job;
  return job;
}

// p 必须是绝对路径（渲染层给的是文件树里的真实路径）；这里不夹目录 —— 预览面板本来就能浏览任意盘
ipcMain.handle('kun:file:toPdf', function (e, p) {
  const t = String(p == null ? '' : p).trim();
  if (!t) return { ok: false, err: '空路径' };
  if (!path.isAbsolute(t)) return { ok: false, err: '需要绝对路径' };
  return officeToPdf(t);
});

// Electron 窗口句柄 -> 十进制字符串（代理侧按 int64 解析）
function windowHandleToDecimal(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length === 8) return buf.readBigUInt64LE(0).toString();
    return String(buf.readUInt32LE(0));
  } catch (e) { return '0'; }
}

// 面板给的是 CSS px（视口坐标），覆盖式内置用的是「屏幕物理像素」：
// 外挂窗口保持顶层（不 SetParent），所以坐标必须是屏幕坐标 —— 先加窗口内容区
// 在屏幕上的位置（DIP），再整体乘缩放比转成物理像素。
// 多窗口：坐标基准必须是「发起内置的那个窗口」（win），不能写死主窗口。
function toScreenPhysicalRect(r, win) {
  const base = (win && !win.isDestroyed()) ? win : mainWindow;
  let scale = 1, cb = { x: 0, y: 0 };
  try {
    if (base && !base.isDestroyed()) {
      cb = base.getContentBounds();
      scale = screen.getDisplayMatching(base.getBounds()).scaleFactor || 1;
    }
  } catch (e) { scale = 1; }
  const cssX = (r && r.x) || 0;
  const cssY = (r && r.y) || 0;
  return {
    x: Math.round((cb.x + cssX) * scale),
    y: Math.round((cb.y + cssY) * scale),
    w: Math.max(80, Math.round(((r && r.w) || 0) * scale)),
    h: Math.max(60, Math.round(((r && r.h) || 0) * scale))
  };
}

// ===== app-window：把任意工业软件窗口内置成面板（2026-10-28 · 客户「<客户>」）=====
// 与 app-embed-agent.ps1 的 owner-overlay 同一套思路（头部注释：⛔ 不用 SetParent）。
// 差异：目标进程名由渲染器传进来（Proc），一次只服务一个进程（换进程就重启 agent）。
const APPW_AGENT = path.join(__dirname, 'scripts', 'app-embed-agent.ps1');
const APPW_CMD = path.join(SHELL_DATA_DIR, 'appwin.cmd.json');
const APPW_RES = path.join(SHELL_DATA_DIR, 'appwin.res.json');
let appwProc = null, appwSeq = 0, appwProcName = '';
let appwCssRect = null, appwOwner = null, appwFollowTimer = null;

function startAppwAgent(procName) {
  const name = String(procName || '').trim();
  if (!name) return false;
  if (appwProc && appwProc.exitCode === null && appwProcName === name) return true;
  if (appwProc && appwProc.exitCode === null) { try { appwProc.kill(); } catch (e) { warnOnce("main", e) } appwProc = null; }
  if (!fs.existsSync(APPW_AGENT)) { log('[appwin] 内置代理缺失: ' + APPW_AGENT); return false; }
  try {
    try { fs.unlinkSync(APPW_RES); } catch (e) { warnOnce("main", e) }
    appwProcName = name;
    appwProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', APPW_AGENT,
        '-Cmd', APPW_CMD, '-Res', APPW_RES, '-ParentPid', String(process.pid), '-Proc', name],
      { windowsHide: true, stdio: 'ignore' });
    appwProc.on('exit', function (code) { log('[appwin] 内置代理退出 code=' + code); appwProc = null; });
    log('[appwin] 内置代理已启动 pid=' + appwProc.pid + ' · proc=' + name);
    return true;
  } catch (e) { log('[appwin] 内置代理启动失败: ' + ((e && e.message) || e)); return false; }
}

function appwCommand(payload, timeoutMs) {
  return new Promise(function (resolve) {
    if (!startAppwAgent(payload && payload.proc)) { resolve({ ok: false, err: 'agent-unavailable' }); return; }
    appwSeq += 1;
    const seq = appwSeq;
    try { fs.writeFileSync(APPW_CMD, JSON.stringify(Object.assign({}, payload, { seq: seq }))); }
    catch (e) { resolve({ ok: false, err: 'write-cmd-failed: ' + ((e && e.message) || e) }); return; }
    const limit = timeoutMs || 8000;
    const started = Date.now();
    (function poll() {
      if (Date.now() - started > limit) { resolve({ ok: false, err: 'timeout' }); return; }
      let txt = null;
      try { txt = fs.readFileSync(APPW_RES, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { txt = null; }
      if (txt) {
        let obj = null;
        try { obj = JSON.parse(txt); } catch (e) { obj = null; }
        if (obj && obj.seq === seq) { resolve(obj); return; }
      }
      setTimeout(poll, 120);
    })();
  });
}

function scheduleAppwFollow(win) {
  if (!appwCssRect) return;
  if (win && appwOwner && win !== appwOwner) return;
  if (appwFollowTimer) clearTimeout(appwFollowTimer);
  appwFollowTimer = setTimeout(function () {
    if (!appwCssRect) return;
    const p = toScreenPhysicalRect(appwCssRect, appwOwner || mainWindow);
    appwCommand({ cmd: 'move', proc: appwProcName, x: p.x, y: p.y, w: p.w, h: p.h }, 4000);
  }, 120);
}

ipcMain.handle('appwin:status', (e, procName) => appwCommand({ cmd: 'status', proc: String(procName || '') }, 4000));

ipcMain.handle('appwin:launch', (e, exe, args) => {
  const p = String(exe || '').trim();
  if (!p) return { ok: false, err: 'no-exe' };
  if (!fs.existsSync(p)) return { ok: false, err: 'exe-not-found', path: p };
  try {
    const child = spawn(p, Array.isArray(args) ? args : [], { detached: true, stdio: 'ignore', cwd: path.dirname(p) });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) { return { ok: false, err: String((err && err.message) || err) }; }
});

ipcMain.handle('appwin:embed', async (e, procName, rect) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!win) return { ok: false, err: 'no-window' };
  if (appwOwner && appwOwner !== win && !appwOwner.isDestroyed()) return { ok: false, err: '已在另一个窗口内置' };
  const p = toScreenPhysicalRect(rect || {}, win);
  const res = await appwCommand({
    cmd: 'embed', proc: String(procName || ''), parent: windowHandleToDecimal(win),
    x: p.x, y: p.y, w: p.w, h: p.h
  }, 12000);
  if (res && res.ok) { appwCssRect = rect || null; appwOwner = win; log('[appwin] 已贴到面板: ' + (win.kunScene || 'main')); }
  return res || { ok: false, err: 'no-res' };
});

ipcMain.handle('appwin:move', async (e, rect) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!appwCssRect) return { ok: false, err: 'not-embedded' };
  const p = toScreenPhysicalRect(rect || {}, win || appwOwner || mainWindow);
  appwCssRect = rect || null;
  return appwCommand({ cmd: 'move', proc: appwProcName, x: p.x, y: p.y, w: p.w, h: p.h }, 4000);
});

ipcMain.handle('appwin:release', async () => {
  appwCssRect = null; appwOwner = null;
  return appwCommand({ cmd: 'release', proc: appwProcName }, 6000);
});

// ---- 派发巡检面板（总入口「胡闹的大肥鱼」· type=dispatch-board）----
// 判据只有一份：调用 工具\看门狗.mjs，壳只负责起进程 + 把 JSON 摊给面板（不在这里复制一套判定，免得两处漂移）。
// ⛔ 巡检只读；「补投回执」必须人点按钮（走 等回执.mjs --once），不自动补、不改任何派发单。
const DISPATCH_DIR = path.join(DSH_HOME, '派发');
const DOG_TOOL = path.join(__dirname, '..', '工具', '看门狗.mjs');
const DOG_WAIT_TOOL = path.join(__dirname, '..', '工具', '等回执.mjs');
const DISPATCH_STUCK_MIN = Math.max(3, Number(MACHINE.dispatchStuckMin) || 15);

// 1. 起一次工具进程（看门狗 / 等回执共用）；失败把 stderr 原样带出，不吞
function runToolSync(tool, args, timeoutMs) {
  if (!fs.existsSync(tool)) return { ok: false, err: '缺工具：' + tool };
  const nodeExe = resolveNodeExe();
  const r = spawnSync(nodeExe || process.execPath, [tool, ...args], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true,
    timeout: timeoutMs || 20000,
    env: nodeExe ? process.env : Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
  });
  if (r.error) return { ok: false, err: String(r.error.message || r.error) };
  return { ok: true, code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

// 2. 面板拉一次：--all 让「已回执」也带回来，显示哪几条由面板决定。
//    阈值走机器配置 dispatchStuckMin（默认 15 分；err = 2 倍），
//    免得"顶栏弹了卡住、面板却还写着在跑"两套口径打架。
ipcMain.handle('dispatch:dog', () => {
  const r = runToolSync(DOG_TOOL, [
    '--json', '--all',
    '--warn', String(DISPATCH_STUCK_MIN),
    '--err', String(DISPATCH_STUCK_MIN * 2)
  ], 30000);
  if (!r.ok) return r;
  let data = null;
  try { data = JSON.parse(r.out); } catch (ex) { data = null; }
  if (!data) return { ok: false, err: r.err || r.out || ('退出码 ' + r.code) };
  return { ok: true, at: Math.floor(Date.now() / 1000), data: data };
});

// 3. 补投回执：只对点中的那一单起 等回执 --once；失败把最后一行原因带回来
ipcMain.handle('dispatch:dogFix', (e, id) => {
  const key = String(id || '').trim();
  if (!key || !/^[\w-]+$/.test(key)) return { ok: false, err: '单号不合法' };
  const file = path.join(DISPATCH_DIR, key + '.json');
  if (!fs.existsSync(file)) return { ok: false, err: '找不到派发单：' + key };
  const r = runToolSync(DOG_WAIT_TOOL, ['--ticket', file, '--once'], 120000);
  if (!r.ok) return r;
  if (/已回执/.test(r.out)) return { ok: true, msg: '已补投回执' };
  return { ok: false, err: (r.out || r.err || '').split('\n').filter(Boolean).slice(-1)[0] || '这一单还没跑完，暂时补不了' };
});

// 4. 打开单子：只认派发目录下的单号，别让面板传任意路径过来
ipcMain.handle('dispatch:dogOpen', async (e, id) => {
  const key = String(id || '').trim();
  if (!key || !/^[\w-]+$/.test(key)) return { ok: false, err: '单号不合法' };
  const file = path.resolve(DISPATCH_DIR, key + '.json');
  if (!file.startsWith(path.resolve(DISPATCH_DIR) + path.sep) || !fs.existsSync(file)) return { ok: false, err: '找不到派发单：' + key };
  const err = await shell.openPath(file);
  return err ? { ok: false, err: err } : { ok: true };
});

// ---- 待批准 / 定时触发（2026-11-14）----
// confirm 级不再靠「聊天里点头」：派发工具把未确认的派发落进 待批准.json，面板点【批准】当场派出。
// 触发（Trigger）：定时.json 里到点的任务自动走 桌宠.mjs 派；confirm 级会自然落进待批准，仍由人一键放行。
const PET_TOOL = path.join(__dirname, '..', '工具', '桌宠.mjs');
const APPROVAL_FILE = path.join(SHELL_DATA_DIR, 'pet', '待批准.json');
const TIMER_FILE = path.join(SHELL_DATA_DIR, 'pet', '定时.json');
const TIMER_STATE = path.join(SHELL_DATA_DIR, 'pet', '定时-已跑.json');
const TIMER_DEFAULT = path.join(__dirname, 'pet', '定时.默认.json');

// 待批准条数：桌面身体的气泡/状态用它；与 桌宠.mjs 读同一个文件，不另存一份账
function pendingApprovalCount() {
  try {
    const list = readJsonSafe(APPROVAL_FILE, []);
    return (Array.isArray(list) ? list : []).filter((x) => x && x.state === 'pending').length;
  } catch (e) { return 0; }
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (ex) { return fallback; }   // 不存在/写坏都退回默认，别让面板炸
}
function writeJsonSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// 1. 待批准队列：与 桌宠.mjs 读写同一个文件（判据只有一份，壳不复制一套规则）
ipcMain.handle('dispatch:approvals', () => {
  const list = readJsonSafe(APPROVAL_FILE, []);
  return { ok: true, list: (Array.isArray(list) ? list : []).filter((x) => x && x.state === 'pending') };
});

// 2. 批准 / 忽略：起一次 桌宠.mjs（真正的派发逻辑在那边，壳只转发结果）
ipcMain.handle('dispatch:approve', (e, id) => {
  const key = String(id || '').trim();
  if (!key || !/^ap[\w-]+$/.test(key)) return { ok: false, err: '待批准号不合法' };
  const r = runToolSync(PET_TOOL, ['批准', key], 90000);
  if (!r.ok) return r;
  if (r.code === 0) return { ok: true, msg: r.out.split('\n').filter(Boolean).pop() || '已批准' };
  return { ok: false, err: r.err || r.out || ('退出码 ' + r.code) };
});

ipcMain.handle('dispatch:drop', (e, id) => {
  const key = String(id || '').trim();
  if (!key || !/^ap[\w-]+$/.test(key)) return { ok: false, err: '待批准号不合法' };
  const r = runToolSync(PET_TOOL, ['忽略', key], 20000);
  if (!r.ok) return r;
  return r.code === 0 ? { ok: true } : { ok: false, err: r.err || r.out || ('退出码 ' + r.code) };
});

// 3. 定时任务（Trigger）：读写 定时.json；没有这个文件时按 pet\定时.默认.json 的示例显示（默认全关）
ipcMain.handle('dispatch:timers', () => {
  const def = readJsonSafe(TIMER_DEFAULT, { tasks: [] });
  const cfg = readJsonSafe(TIMER_FILE, def);
  return { ok: true, tasks: (cfg && cfg.tasks) || [] };
});

ipcMain.handle('dispatch:timerToggle', (e, id, on) => {
  const def = readJsonSafe(TIMER_DEFAULT, { tasks: [] });
  const cfg = readJsonSafe(TIMER_FILE, def);
  const tasks = (cfg && cfg.tasks) || [];
  const hit = tasks.find((x) => x && String(x.id) === String(id));
  if (!hit) return { ok: false, err: '没有这个定时任务：' + id };
  hit.enabled = !!on;
  writeJsonSafe(TIMER_FILE, { tasks });
  return { ok: true, tasks };
});

// 4. 到点触发：每 30 秒对一次表，同一任务同一天只跑一次；异步起进程，不阻塞界面
//    带 --自动：桌宠.mjs 会先过「主动性 / 免打扰 / 每小时上限」三闸，不过就跳过不派（2026-11-18）
function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
function timerTick() {
  const cfg = readJsonSafe(TIMER_FILE, { tasks: [] });
  const tasks = (cfg && cfg.tasks || []).filter((x) => x && x.enabled && /^\d{2}:\d{2}$/.test(String(x.time || '')));
  if (!tasks.length) return;
  const now = new Date();
  const hm = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  const day = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  const seen = readJsonSafe(TIMER_STATE, {});
  for (const t of tasks) {
    if (String(t.time) !== hm) continue;
    const key = String(t.id) + '@' + day;
    if (seen[key]) continue;
    seen[key] = Date.now();
    writeJsonSafe(TIMER_STATE, seen);
    const nodeExe = resolveNodeExe();
    const child = spawn(nodeExe || process.execPath, [PET_TOOL, '派', '--文本', String(t.text || ''), '--超时', '600', '--自动'], {
      cwd: path.join(__dirname, '..'), detached: true, stdio: 'ignore', windowsHide: true,
      env: nodeExe ? process.env : Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
    });
    child.unref();
    console.log('[timer] ' + t.id + ' 到点触发：' + t.text);
  }
}
setInterval(timerTick, 30000);

// （2026-11-12 删除）个人站的「拖出去」功能：siteIcon / site:drag 已随本地文件面板一并移除。


// ---- 股票助手：本地存储（记忆 / 聊天 / 行情缓存）----
// 场景隔离强化：stock:chat:* / stock:mem:* 的 scenario 参数统一白名单归一化——
// 只允许 stock / oa-ops / personal-site 三个场景，非法/未传值一律落回 'stock'，
// 从主进程侧杜绝渲染层误传或越权把数据写进其他场景（三场景硬隔离）。
const STOCK_SCENARIOS = ['stock', 'oa-ops', 'personal-site'];
function normScenario(s) {
  return STOCK_SCENARIOS.indexOf(String(s || '')) >= 0 ? String(s) : 'stock';
}
ipcMain.handle('stock:mem:add', (e, m) => stockStore.addMemory(Object.assign({}, m || {}, { scenario: normScenario(m && m.scenario) })));
// 场景透传：不传时默认 'stock'，OA 场景必须显式传 'oa-ops'，避免串读
ipcMain.handle('stock:mem:list', (e, kind, scenario) => stockStore.listMemories(kind, normScenario(scenario)));
ipcMain.handle('stock:mem:update', (e, id, patch) => stockStore.updateMemory(id, patch));
ipcMain.handle('stock:mem:delete', (e, id) => stockStore.deleteMemory(id));
ipcMain.handle('stock:chat:create', (e, scenario, title) => stockStore.createSession(normScenario(scenario), title));
ipcMain.handle('stock:chat:list', (e, scenario) => stockStore.listSessions(normScenario(scenario)));
ipcMain.handle('stock:chat:messages', (e, sid) => stockStore.getMessages(sid));
ipcMain.handle('stock:chat:send', (e, sid, role, content) => stockStore.addMessage(sid, role, content));
ipcMain.handle('stock:chat:delete', (e, sid) => stockStore.deleteSession(sid));
ipcMain.handle('stock:chat:rename', (e, sid, title) => stockStore.renameSession(sid, title));

// ---- OA 运维场景：数据读写（D 盘 data/oa.db，与股票完全隔离）----
// 服务器状态 / 操作日志 / 文件 / 网页站点 / 一键操作 / 终端 / 配置 / SSH
let oaStatusCache = { ts: 0, data: null };
let oaStatusError = null;

// ---- OA 采集缓存（TTL + 单飞）----
// 目的：面板高频轮询不再直接打 SSH（每次 SSH 采集要新起 Python + 新握手，实测约 0.74s，其中 82% 花在建通道）。
// 策略：TTL 略小于面板轮询间隔 → 每次轮询都能拿到"新鲜"数据，但同一时刻的重复触发（手动刷新+定时）只采一次。
// 规则：TTL 内直接命中缓存；同一 key 并发请求共享同一次采集（单飞）；手动刷新传 force 绕过。
const oaCache = new Map();      // key -> { ts, val }
const oaInflight = new Map();   // key -> Promise（单飞）
const OA_TTL = { status: 15000, logs: 8000, files: 25000, sync: 55000, web: 20000 };
function cachedOa(key, ttlMs, fn, force) {
  const now = Date.now();
  const hit = oaCache.get(key);
  if (!force && hit && (now - hit.ts) < ttlMs) return Promise.resolve(hit.val);
  const flying = oaInflight.get(key);
  if (flying) return flying;
  const p = Promise.resolve().then(fn).then((val) => {
    oaCache.set(key, { ts: Date.now(), val: val });
    oaInflight.delete(key);
    return val;
  }).catch((err) => {
    oaInflight.delete(key);
    throw err;
  });
  oaInflight.set(key, p);
  return p;
}
function invalidateOaCache(prefix) {
  for (const k of Array.from(oaCache.keys())) if (!prefix || k.indexOf(prefix) === 0) oaCache.delete(k);
}

// 读取状态：已配置 SSH 且缓存超 60s 时通过真实 SSH 采集并写库；未配置/失败回退存储快照（演示数据）
async function getOaStatus(force) {
  if (!oaSsh.isReady()) return oaStore.getStatus();
  try {
    const r = await cachedOa('status', OA_TTL.status, () => oaSsh.collectStatus(), force);
    if (r && r.ok && r.status) {
      oaStore.setStatus(r.status);
      oaStatusError = null;
      return r.status;
    }
    oaStatusError = (r && r.err) || '未知错误';
  } catch (ex) {
    oaStatusError = String((ex && ex.message) || ex);
  }
  const hit = oaCache.get('status');
  if (hit && hit.val && hit.val.status) return hit.val.status;
  return oaStore.getStatus();
}
ipcMain.handle('oa:status', (e, force) => getOaStatus(!!force));
ipcMain.handle('oa:logs', (e, limit) => oaStore.getLogs(limit));
// 真实日志：SSH 已连接 → 抓取 pm2 后端 / nginx / mysql 日志；结果缓存供 AI 上下文引用（面板轮询 30s + 30s TTL）
let oaLogsCache = null;
ipcMain.handle('oa:logs:real', async (e, kinds, lines, force) => {
  if (!oaSsh.isReady()) return { ok: false, err: '未连接服务器', demo: true, rows: oaStore.getLogs(Number(lines) || 12) };
  const key = 'logs:' + String(kinds) + ':' + String(lines || 12);
  try {
    const r = await cachedOa(key, OA_TTL.logs, () => oaSsh.fetchLogs(kinds, lines), !!force);
    if (r && r.ok) {
      oaLogsCache = { ts: Date.now(), sources: r.sources || {} };
      return { ok: true, sources: r.sources || {}, ts: Date.now() };
    }
    return { ok: false, err: (r && r.err) || '日志抓取失败', demo: true, rows: oaStore.getLogs(Number(lines) || 12) };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex), demo: true, rows: oaStore.getLogs(Number(lines) || 12) };
  }
});
// 云端文件：SSH 已连接 → 真实 SFTP 列表（60s TTL）；否则回退演示缓存
ipcMain.handle('oa:files', async (e, remotePath, force) => {
  const base = remotePath || oaStore.getConfig('oa.path.code') || '/opt/langchen_oa';
  if (oaSsh.isReady()) {
    try {
      const r = await cachedOa('files:' + base, OA_TTL.files, () => oaSsh.listDir(base), !!force);
      if (r && r.ok) return { ok: true, base: base, rows: r.entries || [], real: true };
    } catch (ex) { warnOnce("main", ex) }
    return { ok: false, err: '列表获取失败', base: base, rows: oaStore.getFiles(base).rows, real: false };
  }
  const f = oaStore.getFiles(base);
  return { ok: true, base: f.base, rows: f.rows, real: false };
});
// ---- 列目录时问 git：这些条目里哪些是「被 .gitignore 忽略」的（降噪用）----
//   为什么要放主进程：只有这里能起子进程读 .gitignore 规则；渲染层拿不到规则本身。
//   口径：base 不在 git 仓库里 / 本机没装 git ⇒ 一律当"没有忽略项"（原样全显示，行为不变）。
//   为什么一次问一批：一屏几十个条目逐个起 git 会卡；`check-ignore --stdin -z` 一次问完（约 40ms）。
//   为什么目录要带尾斜杠：规则常写成 `node_modules/`（只匹配目录），不带斜杠问会漏。
//   退出码说明：0 = 有命中、1 = 一个都没命中（正常）、128 = 不在仓库里 —— 都只按 stdout 取结果。
function gitIgnoredNames(base, names) {
  return new Promise((resolve) => {
    const empty = () => new Set();
    if (!names || !names.length) return resolve(empty());
    let cp = null, out = '', settled = false, timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch (e) { warnOnce("main", e) }
      const set = new Set();
      // -z 输出是 NUL 分隔的裸路径（不带引号转义），目录会带尾斜杠 ⇒ 去掉斜杠还原成条目名
      String(out).split('\u0000').forEach((s) => {
        const n = s.replace(/[\\/]+$/, '');
        if (n) set.add(n);
      });
      resolve(set);
    };
    try {
      cp = spawn('git', ['-C', base, 'check-ignore', '--stdin', '-z'], { windowsHide: true });
    } catch (e) { return resolve(empty()); }
    timer = setTimeout(() => { try { cp.kill(); } catch (e) { warnOnce("main", e) } done(); }, 6000);
    cp.on('error', () => { out = ''; done(); });          // 没装 git ⇒ 全放行
    cp.stdout.on('data', (d) => { out += String(d); });
    cp.on('close', () => done());
    try {
      cp.stdin.on('error', () => { /* stdin 提前关闭不算错 */ });
      cp.stdin.end(names.join('\u0000') + '\u0000');
    } catch (e) { done(); }
  });
}
// 公开版：OA / 行情 / SSH 业务实现不随包发布（保留空桩，等价于「未连接 / 无数据」）
function __stubModule() { return new Proxy(function () {}, { get: () => () => undefined, apply: () => undefined }); }
const stockStore = __stubModule();
const oaStore = __stubModule();
const oaSsh = __stubModule();
// 本地文件：项目目录浏览（与云端无关，始终可用）
//   降噪（2026-11-13 用户要求）：默认不显示被 .gitignore 忽略的目录/文件（node_modules、引擎、工作区…一列就是一屏），
//   面板标题行给一个「已忽略 N」开关，点开才显示；不在 git 仓库里的普通目录行为一个字不变。
ipcMain.handle('oa:files:local', async (e, localPath, opts) => {
  const base = localPath || oaStore.getConfig('oa.path.local') || '<资料库>';
  const showIgnored = !!(opts && opts.showIgnored);
  try {
    // 1) 读目录（异步）
    const ents = await fs.promises.readdir(base, { withFileTypes: true });
    // 2) 问一次 git：哪些条目被忽略（目录带尾斜杠问，否则 `xxx/` 这类规则匹配不上）
    const ignored = await gitIgnoredNames(base, ents.map((en) => en.name + (en.isDirectory() ? '/' : '')));
    // 3) 并行 stat：不再阻塞主进程（原来用 readdirSync/statSync，大目录会卡住整个界面）
    const rows = await Promise.all(ents.map(async (en) => {
      let isDir = en.isDirectory(), size = 0, mtime = 0;
      try {
        const st = await fs.promises.stat(path.join(base, en.name));
        isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
      } catch (err) { warnOnce("main", err) }
      return { name: en.name, isDir: isDir, size: size, mtime: mtime };
    }));
    rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
    // 4) 分「藏起来」与「显示」：`.git` 目录本身也不用给人看（始终归到"可隐藏"这一类）
    const isNoise = (r) => ignored.has(r.name) || r.name === '.git';
    const hidden = rows.filter(isNoise).length;
    let shown = rows;
    if (showIgnored) {
      // 点开开关时照样显示，但打标记 ⇒ 面板把这一行画淡，一眼分出"这是被忽略的"
      rows.forEach((r) => { if (ignored.has(r.name)) r.ign = true; });
    } else {
      shown = rows.filter((r) => !isNoise(r));
    }
    return { ok: true, base: base, rows: shown, ignored: hidden, showIgnored: showIgnored };
  } catch (ex) {
    return { ok: false, err: '无法读取目录: ' + base, base: base, rows: [] };
  }
});
ipcMain.handle('oa:paths', () => {
  const mp = scenarioMeta().paths || {};
  return {
    localRoot: mp.local || oaStore.getConfig('oa.path.local') || '<资料库>',
    code: mp.code || oaStore.getConfig('oa.path.code') || '/opt/langchen_oa',
    www: mp.www || oaStore.getConfig('oa.path.www') || '/var/www',
    backups: mp.backups || oaStore.getConfig('oa.path.backups') || '/opt/langchen_oa_backups',
    mappings: oaSsh.getMappings()
  };
});
// 切换当前 OA 场景（多公司模板：切换后 SSH/服务/映射/日志/网址 全部随场景走）
ipcMain.handle('oa:set-scenario', (e, sid) => applyOaScenario(sid));
// 实时同步状态（本地 ↔ 云端 mtime+size 比对）；结果缓存 120s 供 AI 上下文引用，避免每次对话/轮询都全量比对
let oaSyncCache = null;
// ★ 原生拖拽：把面板里的文件拖到资源管理器 / 别的窗口
ipcMain.on('oa:dragstart', (event, filePath) => {
  // ★ 任何一步异常都不能外抛，否则主进程崩溃 = 整个工作台退出
  try {
    const fp = String(filePath || '');
    if (!fp || !fs.existsSync(fp)) return;
    // 图标必须是非空 NativeImage；空图会让 startDrag 直接抛异常
    let icon = null;
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
      if (img && !img.isEmpty()) icon = img.resize({ width: 64 });
    } catch (e) { icon = null; }
    const payload = { file: fp };
    if (icon && !icon.isEmpty()) payload.icon = icon;
    event.sender.startDrag(payload);
  } catch (ex) {
    try { console.error('[oa:dragstart] 已忽略错误：', ex && ex.message); } catch (e2) { warnOnce("main", e2) }
  }
});
// ★ 读图（返回 dataURL，供面板大图显示）：支持本地绝对路径
ipcMain.handle('oa:image', async (e, p) => {
  try {
    const fp = String(p || '');
    if (!fp || !fs.existsSync(fp)) return { ok: false, err: '文件不存在' };
    const st = fs.statSync(fp);
    if (st.size > 12 * 1024 * 1024) return { ok: false, err: '图片过大（>12MB）' };
    const ext = path.extname(fp).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
    const b64 = fs.readFileSync(fp).toString('base64');
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + b64, name: path.basename(fp) };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
// ★ OA 场景专用：打开本地文件夹 / 打开本地文件（保持场景隔离，只用 oa 命名空间）
ipcMain.handle('oa:openFolder', async (e, dir) => {
  try {
    const d = String(dir || '');
    if (!d || !fs.existsSync(d)) return { ok: false, err: '目录不存在: ' + d };
    const r = await shell.openPath(d);
    return r ? { ok: false, err: r } : { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
ipcMain.handle('oa:openPath', async (e, p) => {
  try {
    const t = String(p || '');
    if (!t) return { ok: false, err: 'empty' };
    if (/^https?:\/\//i.test(t)) { shell.openExternal(t); return { ok: true }; }
    if (!fs.existsSync(t)) return { ok: false, err: '文件不存在: ' + t };
    const r = await shell.openPath(t);
    return r ? { ok: false, err: r } : { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
ipcMain.handle('oa:upload', async (e, localPath, remoteDir) => oaSsh.putFile(localPath, remoteDir));
ipcMain.handle('oa:download', async (e, remotePath, localDir) => oaSsh.getFile(remotePath, localDir));
ipcMain.handle('oa:sync:status', async (e, force) => {
  try {
    const r = await cachedOa('syncstatus', OA_TTL.sync, () => oaSsh.syncStatus(), !!force);
    if (r && r.ok) oaSyncCache = r;
    return r;
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});
// 一键推送 / 拉取（与云控台同步规则一致；执行后刷新同步状态与操作日志）
async function runSyncTransfer(mode, key) {
  if (!oaSsh.isReady()) return { ok: false, err: '未连接服务器（配置 SSH 后可用）' };
  const r = await oaSsh.syncTransfer(mode, key);
  const m = oaSsh.getMappings().find(x => x.key === key);
  const label = (m && m.label) || key;
  const arrow = mode === 'push' ? '推送' : '拉取';
  if (r && r.ok) {
    // 同步完成 → 让文件/同步状态缓存立即失效，面板下次刷新拿到真实结果
    invalidateOaCache('files:');
    invalidateOaCache('syncstatus');
    oaStore.addLog('info', 'sync', arrow + '「' + label + '」完成：更新 ' + r.total + ' 个文件' + (r.changed && r.changed.length ? '（' + r.changed.slice(0, 5).join(', ') + (r.total > 5 ? ' …' : '') + '）' : ''));
    const st = await oaSsh.syncStatus();
    if (st && st.ok) { oaSyncCache = st; oaCache.set('syncstatus', { ts: Date.now(), val: st }); }
    return { ok: true, mode: mode, key: key, label: label, total: r.total, changed: r.changed || [] };
  }
  oaStore.addLog('err', 'sync', arrow + '「' + label + '」失败：' + ((r && r.err) || '未知'));
  return { ok: false, mode: mode, key: key, label: label, err: (r && r.err) || '未知错误' };
}
ipcMain.handle('oa:sync:push', (e, key, via) => {
  // via='ai' 表示由 AI 助手触发：受 AI 同步权限约束；用户手动点击按钮不受限
  if (via === 'ai' && !getAiPermissions().sync) return { ok: false, err: 'AI 同步权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  return runSyncTransfer('push', key);
});
ipcMain.handle('oa:sync:pull', (e, key, via) => {
  if (via === 'ai' && !getAiPermissions().sync) return { ok: false, err: 'AI 同步权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  return runSyncTransfer('pull', key);
});
ipcMain.handle('oa:web:list', () => oaStore.listWebSites());

// ---- OA 相关网址（管理后台/教师端/家长端/官网/APK，来自云控台 config.json urls）----
function oaUrls() {
  const m = scenarioMeta();
  // ① 场景 meta.urls 优先：多公司模板下，每家公司自带网址清单（含备用/附加链接）
  if (Array.isArray(m.urls) && m.urls.length) {
    return m.urls.filter(u => u && u.url).map(u => {
      const it = { name: u.name || u.url, url: u.url };
      if (u.backup) it.backup = u.backup;
      if (Array.isArray(u.links) && u.links.length) it.links = u.links;
      return it;
    });
  }
  // ② 缺省：<客户>默认清单（可被 oa.db 的 oa.url.* 覆盖）
  const def = [
    { name: '管理后台', url: 'http://example.com:8083' },
    { name: '教师端', url: 'http://example.com:8081' },
    { name: '家长端', url: 'http://example.com:8082' },
    // ★ 2026-09-28 新增教务端；★ 2026-09-29 用户要求标题去掉「·手机版」后缀 —— 就叫「教务端」（地址仍是 /m/ 手机版 H5）
    { name: '教务端', url: 'http://example.com:8083/m/' },
    {
      name: '<客户>官网', url: 'http://example.com:8084',
      links: [
        { label: '备用1', url: 'http://example.com:8081/site/' },
        { label: '备用2', url: 'http://example.com:8082/site/' },
        { label: '备用3', url: 'http://example.com:8083/site/' }
      ]
    },
    {
      name: 'APK 下载', url: 'http://example.com:8081/apk/teacher.apk',
      links: [
        { label: '教师端', url: 'http://example.com:8081/apk/teacher.apk' },
        { label: '家长端', url: 'http://example.com:8082/apk/parent.apk' },
        // ★ 2026-09-29 新增教务端 APK（首个教务端包，2026-09-29 上架；官网上也已加教务端入口）
        { label: '教务端', url: 'http://example.com:8083/apk/admin.apk' }
      ]
    }
  ];
  const out = [];
  ['admin', 'teacher', 'parent', 'mobile', 'site', 'apk'].forEach((k, i) => {
    const v = oaStore.getConfig('oa.url.' + k);
    const item = { name: def[i].name, url: v || def[i].url };
    if (def[i].backup) item.backup = def[i].backup;   // 官网备用入口（点卡片走主地址，点备用行走备用）
    if (def[i].links) item.links = def[i].links;      // 附加链接（APK：教师端/家长端 共用一个卡片）
    out.push(item);
  });
  return out;
}
// 单 URL HTTP 探测（code + 延迟）
// ⚠️ 必须只取响应头：APK 等大文件若读正文，每轮探测都会下载整个包（31MB+，15 秒一次 → 每天数百 MB）
// 策略：优先 HEAD（nginx 支持 → 正文 0 字节）；遇 405/501 再回退 GET 并在收到响应头后立即断开
// 另：带 DSH-OA-Probe UA（服务器端可据此不写访问日志 → 真实流量更易检测）+ keep-alive 复用连接
const PROBE_UA = 'DSH-OA-Probe/1.0';
const probeAgent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
function httpProbe(url, timeoutMs) {
  const timeout = timeoutMs || 6000;
  const once = (method) => new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let req;
    try {
      req = http.request(String(url), {
        method: method,
        timeout: timeout,
        agent: probeAgent,
        headers: { 'User-Agent': PROBE_UA, 'Accept-Encoding': 'identity', 'Connection': 'keep-alive' }
      }, (res) => {
        const code = res.statusCode;
        const ms = Date.now() - started;
        try { res.destroy(); } catch (e) { warnOnce("main", e) }   // 不读正文
        finish({ ok: code >= 200 && code < 500, code: code, ms: ms });
      });
    } catch (ex) {
      finish({ ok: false, code: null, ms: Date.now() - started, err: String((ex && ex.message) || ex) });
      return;
    }
    req.on('error', (ex) => finish({ ok: false, code: null, ms: Date.now() - started, err: String((ex && ex.message) || ex) }));
    req.on('timeout', () => { req.destroy(); finish({ ok: false, code: null, ms: Date.now() - started, err: '超时' }); });
    req.end();
  });
  return once('HEAD').then((r) => ((r.code === 405 || r.code === 501) ? once('GET') : r));
}
// 实时监控网址状态（并发探测主地址 + 备用地址 + 附加链接；结果回写 oa.db web_sites，供窗口5与 AI 上下文使用）
async function webCheck(urls) {
  const list = (urls && urls.length) ? urls : oaUrls();
  const out = await Promise.all(list.map(async (u) => {
    const jobs = [httpProbe(u.url, 6000)];
    if (u.backup) jobs.push(httpProbe(u.backup, 6000));
    (u.links || []).forEach(lk => jobs.push(httpProbe(lk.url, 6000)));
    const rs = await Promise.all(jobs);
    let i = 0;
    const item = Object.assign({ name: u.name, url: u.url }, rs[i++]);
    if (u.backup) {
      const b = rs[i++];
      item.backup = u.backup;
      item.backupOk = b.ok;
      item.backupCode = b.code;
      item.backupMs = b.ms;
      item.backupErr = b.err;
    }
    if (u.links && u.links.length) {
      item.links = u.links.map(lk => {
        const r = rs[i++];
        return Object.assign({}, lk, { ok: r.ok, code: r.code, ms: r.ms, err: r.err });
      });
    }
    return item;
  }));
  oaStore.syncWebSites(out.map(o => ({
    name: o.name, url: o.url,
    status: o.ok ? '正常' : '异常',
    note: (o.ok ? ('HTTP ' + o.code + ' · ' + o.ms + 'ms') : (o.err || '离线'))
      + (o.backup ? ('｜备用 ' + (o.backupOk ? ('HTTP ' + o.backupCode + ' · ' + o.backupMs + 'ms') : (o.backupErr || '离线'))) : '')
      + ((o.links && o.links.length)
        ? ('｜' + o.links.map(lk => lk.label + ' ' + (lk.ok ? ('HTTP ' + lk.code) : (lk.err || '离线'))).join('｜'))
        : '')
  })));
  return out;
}
ipcMain.handle('oa:urls', () => oaUrls());
ipcMain.handle('oa:web:check', (e, urls, force) => cachedOa('webcheck', OA_TTL.web, () => webCheck(urls), !!force));
ipcMain.handle('oa:open', (e, url) => {
  try { shell.openExternal(String(url)); return { ok: true }; }
  catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// ---- 「手机预览」：按 界面预览\打开*.bat 的配方把线上站点开成手机尺寸独立窗口（2026-09-18）----
// 为什么要单开一条 IPC：面板点击走 shell.openExternal，只能呼出系统默认浏览器 ——
// 既做不到 400×830 的手机窗口，也做不到「独立配置目录记住登录」（每次都要重新登录）。
// ★ 2026-09-23 改版：窗口打开的是**本地包装页**（127.0.0.1:PREVIEW_PORT），包装页里 iframe 嵌线上站点，
//   顶部左侧有一个 📌 置顶按钮 —— 按钮在窗口**内部**（不占场景面板），点它调本地 /api/pin → SetWindowPos 置顶。
//   为什么包装页：外部浏览器 --app= 窗口没有"往窗口里加按钮"的通道，只能往页面内容里注入；
//   包装页同时保留独立配置目录（--user-data-dir 不变，登录照样记住）。
const PREVIEW_ROOT = '<资料库>';
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || machinePort('preview', 31240));
const PREVIEW_APPS = {
  parent: { name: '家长端', url: 'http://example.com:8082/', x: 70, y: 60 },
  teacher: { name: '教师端', url: 'http://example.com:8081/', x: 510, y: 60 },
  // ★ 2026-09-28 新增「教务端」＝教务后台**手机版 H5**（挂在 8083 的 /m/ 子路径，不是独立端口）
  jiaowu: { name: '教务端', url: 'http://example.com:8083/m/', x: 950, y: 60 }
};
// ★ 2026-09-23 「置顶」：记住每个端最近一次打开的预览窗口 pid，切换置顶时按 pid 找窗口
const PREVIEW_PIDS = {};   // which -> pid（每次打开都覆盖；窗口关了 pid 就失效，pin 会返回"找不到"）
let PREVIEW_PINNED = {};   // which -> true/false（包装页按钮状态回显用）
let previewServer = null;

// 包装页 HTML：顶部一条**顶栏**（右侧 📌 置顶按钮，紧挨系统缩小/放大/关闭那排按钮的下方）+ 下方 iframe 嵌线上站点。
// 2026-09-23 按反馈改：按钮不悬浮（悬浮会挡 iframe 内容），而是做进顶栏 —— 顶栏右侧就是"缩小按键旁边"。
// 系统窗口按钮画在系统标题栏（页面内容上方），本页顶栏贴在标题栏正下方，按钮放顶栏右端，视觉上紧挨那排按钮。
function previewShellHtml(which) {
  const app = PREVIEW_APPS[String(which)] || PREVIEW_APPS.parent;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${app.name} · 预览</title>
<style>
  html, body { margin:0; padding:0; height:100%; background:#fff; overflow:hidden; }
  #bar {
    position:fixed; left:0; right:0; top:0; height:34px; z-index:9999;
    display:flex; align-items:center; justify-content:flex-end; gap:8px;
    padding:0 8px; box-sizing:border-box;
    background:linear-gradient(180deg,#f5f5f5,#e9e9e9);
    border-bottom:1px solid rgba(0,0,0,.12);
    -webkit-app-region:no-drag;
  }
  #barTitle {
    margin-right:auto; font-size:12px; color:#666;
    font-family:"Microsoft YaHei",sans-serif; user-select:none;
  }
  #pinBtn {
    display:flex; align-items:center; gap:4px;
    padding:4px 10px; font-size:12px; line-height:1;
    font-family:"Microsoft YaHei",sans-serif; cursor:pointer;
    background:#fff; color:#555;
    border:1px solid rgba(0,0,0,.22); border-radius:999px;
    box-shadow:0 1px 2px rgba(0,0,0,.12);
    user-select:none; -webkit-user-select:none;
  }
  #pinBtn:hover { background:#fafafa; color:#333; }
  #pinBtn.on { background:#f59e0b; border-color:#d97706; color:#fff; box-shadow:0 1px 6px rgba(217,119,6,.45); }
  iframe { position:fixed; left:0; right:0; top:34px; bottom:0; width:100%; height:calc(100% - 34px); border:0; }
</style>
</head>
<body>
<div id="bar">
  <span id="barTitle">${app.name} · 预览</span>
  <button id="pinBtn" title="置顶预览窗口（浮在最上层，边聊天边看）">📌 置顶</button>
</div>
<iframe src="${app.url}" allow="geolocation; camera; microphone"></iframe>
<script>
(function () {
  var btn = document.getElementById('pinBtn');
  var on = false;
  function paint() { btn.classList.toggle('on', on); btn.textContent = on ? '📌 已置顶' : '📌 置顶'; }
  function setState(s) { on = !!s; paint(); }
  function callPin(next) {
    fetch('http://127.0.0.1:${PREVIEW_PORT}/api/pin?which=${which}&on=' + (next ? 1 : 0))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) setState(!!d.pinned); })
      .catch(function () { /* 服务不在（GUI 已关）就不动状态 */ });
  }
  btn.addEventListener('click', function () { callPin(!on); });
  // 打开时回显主进程记住的置顶状态（同一窗口重开 / 从面板重开都准）
  fetch('http://127.0.0.1:${PREVIEW_PORT}/api/pin-state?which=${which}')
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.ok) setState(!!d.pinned); })
    .catch(function () {});
})();
</script>
</body>
</html>`;
}

// 本地预览服务：出包装页 + /api/pin + /api/pin-state（跨域放开，因为包装页 fetch 自带的 origin）
function startPreviewServer() {
  if (previewServer) return;
  previewServer = http.createServer(function (req, res) {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    const q = (req.url || '').split('?')[1] || '';
    const get = (k) => { const m = new RegExp('[?&]' + k + '=([^&]*)').exec('?' + q); return m ? decodeURIComponent(m[1]) : ''; };
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u === '/api/pin') {
      const which = get('which');
      const on = get('on') === '1';
      const app = PREVIEW_APPS[which];
      if (!app) { res.writeHead(400); res.end('bad which'); return; }
      doPinPreview(which, on).then(function (r) {
        res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r));
      }).catch(function (ex) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, err: String((ex && ex.message) || ex) }));
      });
      return;
    }
    if (u === '/api/pin-state') {
      const which = get('which');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pinned: !!PREVIEW_PINNED[which], pid: PREVIEW_PIDS[which] || 0 }));
      return;
    }
    const which = u.replace(/^\//, '').replace(/\.html$/, '');
    if (PREVIEW_APPS[which]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(previewShellHtml(which));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  // ★ 2026-09-26：同机多壳（dev 工作台 + 安装版）时端口只能被一个占住 —— 占不到就**安静退让**，
  //   别抛未捕获的 EADDRINUSE（那会弹「DSH 引擎 出错」框，实测被多开实例触发过）。
  previewServer.on('error', function (e) {
    log('[preview] 端口 ' + PREVIEW_PORT + ' 没占上（' + ((e && e.code) || e) + '）⇒ 本实例不提供预览包装页，'
      + '由已在跑的那个壳提供');
    previewServer = null;
  });
  previewServer.listen(PREVIEW_PORT, '127.0.0.1', function () {
    log('[preview] 预览包装页服务已就绪: http://127.0.0.1:' + PREVIEW_PORT + '/parent（教师端 /teacher）');
  });
}
// .bat 的浏览器查找顺序：Edge(x86) → Edge → Chrome → Chrome(x86) → Chrome(用户级)
function findBrowser() {
  const cands = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { warnOnce("main", e) } }
  return '';
}
ipcMain.handle('oa:appWindow', (e, which) => {
  try {
    const app = PREVIEW_APPS[String(which)];
    if (!app) return { ok: false, err: '未知的预览端：' + which };
    const exe = findBrowser();
    if (!exe) return { ok: false, err: '没找到 Edge / Chrome，请先装一个浏览器' };
    startPreviewServer();   // 包装页服务：窗口内容走本地页（含 📌 置顶按钮）
    const prof = path.join(PREVIEW_ROOT, 'data', String(which));
    try { if (!fs.existsSync(prof)) fs.mkdirSync(prof, { recursive: true }); } catch (ex) { warnOnce("main", ex) }
    const args = [
      '--app=http://127.0.0.1:' + PREVIEW_PORT + '/' + String(which),
      '--window-size=400,830',
      '--window-position=' + app.x + ',' + app.y,
      '--user-data-dir=' + prof,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate,msEdgeSidebarV2,msEdgeBingSidebar',
      '--hide-crash-restore-bubble', '--disable-sync'
    ];
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    // ★ 2026-09-23 记住 pid：置顶开关要用它找窗口
    PREVIEW_PIDS[which] = child.pid;
    // 重新打开 = 新窗口：置顶状态还原成"没置顶"，由包装页按钮重新决定
    PREVIEW_PINNED[which] = false;
    return { ok: true, name: app.name, url: app.url, exe: path.basename(exe), pid: child.pid };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});

// ★ 2026-09-23 「置顶预览窗口」核心：按 pid 找窗口句柄，调 user32.SetWindowPos 切 HWND_TOPMOST/NOTOPMOST。
// 为什么用 powershell：Node 里没有现成的 Win32 绑定；不引第三方依赖，调系统 PowerShell 一行脚本最稳。
// 失败场景（返回 ok:false 但不算崩溃）：窗口已关（pid 无效）、或窗口还没有可见句柄（正在启动）。
// 两个入口共用：① 包装页按钮 → 本地 /api/pin；② IPC oa:appWindow:pin（保留，面板侧万一要用）。
function doPinPreview(which, wantPin) {
  return new Promise(function (resolve) {
    try {
      const app = PREVIEW_APPS[String(which)];
      if (!app) return resolve({ ok: false, err: '未知的预览端：' + which });
      const pid = PREVIEW_PIDS[String(which)];
      if (!pid) return resolve({ ok: false, err: '还没打开过' + app.name + '预览' });
      const ps = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
'@
$found = [IntPtr]::Zero
$cb = [W+EnumWindowsProc]{ param($h, $lp)
  $p = 0
  [W]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq $env:pid) { $script:found = $h; return $false }
  return $true
}
[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($script:found -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 0 }
$top = if ($env:want -eq '1') { [IntPtr]-1 } else { [IntPtr]-2 }
$r = [W]::SetWindowPos($script:found, $top, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)
Write-Output ($(if ($r) { 'OK' } else { 'FAIL' }))`
      ];
      const { execFile } = require('child_process');
      execFile('powershell.exe', ps, { windowsHide: true, timeout: 12000, env: Object.assign({}, process.env, { pid: String(pid), want: wantPin ? '1' : '0' }) },
        (err, stdout) => {
          const out = String(stdout || '').trim();
          if (err && !out) return resolve({ ok: false, err: '置顶失败（powershell 未响应）' });
          if (out.indexOf('NO_WINDOW') >= 0) return resolve({ ok: false, err: '预览窗口已关闭（重新打开再置顶）' });
          if (out.indexOf('OK') < 0) return resolve({ ok: false, err: '置顶失败（窗口句柄未就绪？）' });
          PREVIEW_PINNED[String(which)] = wantPin;
          return resolve({ ok: true, pinned: wantPin, pid: pid });
        });
    } catch (ex) {
      return resolve({ ok: false, err: String((ex && ex.message) || ex) });
    }
  });
}
ipcMain.handle('oa:appWindow:pin', (e, which, on) => doPinPreview(which, !!on));
ipcMain.handle('oa:appWindow:pinState', (e, which) => ({ ok: true, pinned: !!PREVIEW_PINNED[String(which)], pid: PREVIEW_PIDS[String(which)] || 0 }));

// ---- AI 助手权限：读代码 / 改代码 / 同步 开关 + 确认模式（ask 写入同步确认｜auto 全自动｜strict 全确认） ----
const AI_PERM_DEFAULTS = { read: true, write: true, sync: true, confirmMode: 'ask' };
function getAiPermissions() {
  const p = Object.assign({}, AI_PERM_DEFAULTS);
  try {
    const raw = oaStore.getConfig('ai.permission');
    if (raw) Object.assign(p, JSON.parse(raw));
  } catch (e) { warnOnce("main", e) }
  return p;
}
function saveAiPermissions(p) {
  const clean = {
    read: !!(p && p.read), write: !!(p && p.write), sync: !!(p && p.sync),
    confirmMode: p && ['ask', 'auto', 'strict'].indexOf(p.confirmMode) >= 0 ? p.confirmMode : 'ask'
  };
  oaStore.setConfig('ai.permission', JSON.stringify(clean));
  return clean;
}
ipcMain.handle('oa:ai:perms', () => getAiPermissions());
ipcMain.handle('oa:ai:perms:set', (e, p) => saveAiPermissions(p || {}));

// ---- AI 代码修改（安全边界：仅 backend/ 与 web/ 源码；禁止 .env；写入前自动备份到 D 盘 data/oa-code-backups） ----
const OA_CODE_ROOTS = ['backend', 'web'];
const OA_CODE_BACKUP_DIR = path.join(SHELL_DATA_DIR, 'oa-code-backups');
function resolveOaCodePath(rel) {
  const root = oaStore.getConfig('oa.path.local') || '<资料库>';
  const r = String(rel || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (!r || r === '.' || r.startsWith('..') || r.indexOf('/../') >= 0 || r.indexOf('\0') >= 0) return null;
  const seg = r.split('/')[0];
  if (OA_CODE_ROOTS.indexOf(seg) < 0) return null;
  const rootRes = path.resolve(root);
  const full = path.resolve(root, r);
  if (full !== rootRes && !full.startsWith(rootRes + path.sep)) return null;
  if (/(^|[\\/])\.env($|\.)/.test(full)) return null;
  return full;
}
ipcMain.handle('oa:code:read', (e, rel) => {
  if (!getAiPermissions().read) return { ok: false, err: 'AI 读取代码权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  const full = resolveOaCodePath(rel);
  if (!full) return { ok: false, err: '路径不允许：仅可读写 backend/ 与 web/ 源码，禁止 .env' };
  try {
    const content = fs.readFileSync(full, 'utf8');
    return { ok: true, rel: String(rel), path: full, lines: content.split('\n').length, content };
  } catch (ex) {
    return { ok: false, err: '读取失败：' + String((ex && ex.message) || ex) };
  }
});
ipcMain.handle('oa:code:write', (e, rel, content) => {
  if (!getAiPermissions().write) return { ok: false, err: 'AI 修改代码权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  const full = resolveOaCodePath(rel);
  if (!full) return { ok: false, err: '路径不允许：仅可读写 backend/ 与 web/ 源码，禁止 .env' };
  const body = String(content == null ? '' : content);
  const newLines = body.split('\n').length;
  try {
    let backupRel = null;
    if (fs.existsSync(full)) {
      const orig = fs.readFileSync(full, 'utf8');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeName = String(rel).replace(/[\\/]+/g, '__');
      backupRel = ts + '__' + safeName;
      fs.mkdirSync(OA_CODE_BACKUP_DIR, { recursive: true });
      fs.writeFileSync(path.join(OA_CODE_BACKUP_DIR, backupRel), orig, 'utf8');
    }
    fs.writeFileSync(full, body, 'utf8');
    oaStore.addLog('info', 'code', 'AI 修改文件 ' + rel + '（新 ' + newLines + ' 行）' + (backupRel ? '，已备份' : '（新建）'));
    return { ok: true, rel: String(rel), path: full, lines: newLines, backup: backupRel };
  } catch (ex) {
    return { ok: false, err: '写入失败：' + String((ex && ex.message) || ex) };
  }
});
ipcMain.handle('oa:backups', (e, limit) => oaStore.listBackups(limit));
ipcMain.handle('oa:action:list', () => oaStore.listActions());
ipcMain.handle('oa:action:run', (e, id) => runOaAction(id));
ipcMain.handle('oa:shell:exec', (e, cmd) => runOaShell(cmd));
ipcMain.handle('oa:shell:history', (e, limit) => oaStore.getShellHistory(limit));
// ---- 助手→SSH 终端可见通道：助手把命令写入 inbox，SSH 面板拾取后走与手动输入相同的执行路径，结果回写 outbox ----
const AGENT_INBOX = path.join(SHELL_DATA_DIR, 'agent-shell-inbox.jsonl');
const AGENT_OUTBOX = path.join(SHELL_DATA_DIR, 'agent-shell-outbox.jsonl');
const agentReadLines = (f) => {
  try {
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
};
const agentWriteLines = (f, arr) => {
  try { fs.writeFileSync(f, arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : ''), 'utf8'); } catch (e) { warnOnce("main", e) }
};
ipcMain.handle('oa:agent:dequeue', () => {
  const lines = agentReadLines(AGENT_INBOX);
  if (!lines.length) return null;
  const first = lines[0];
  agentWriteLines(AGENT_INBOX, lines.slice(1)); // 取出即移除，防重复执行
  return { seq: String(first.seq || ''), cmd: String(first.cmd || '') };
});
ipcMain.handle('oa:agent:ack', (e, r) => {
  if (!r || !r.seq) return false;
  const arr = agentReadLines(AGENT_OUTBOX);
  arr.push({ seq: String(r.seq), ok: !!r.ok, out: String(r.out || ''), err: String(r.err || ''), ts: Date.now() });
  agentWriteLines(AGENT_OUTBOX, arr);
  return true;
});
ipcMain.handle('oa:config:get', (e, key) => oaStore.getConfig(key));
ipcMain.handle('oa:config:set', (e, key, value) => oaStore.setConfig(key, value));
ipcMain.handle('oa:ssh:status', () => {
  const cfg = oaSsh.getConfig();
  return {
    ready: oaSsh.isReady(),
    connected: oaSsh.isReady(),
    host: cfg.host,
    user: cfg.user,
    port: cfg.port,
    auth: cfg.auth,
    passwordSet: cfg.passwordSet,
    passwordEnv: cfg.envSource,
    lastError: oaStatusError
  };
});

// ================= OA 运维：上下文收集 / 系统提示 / 动作执行 / 终端执行 =================
// 只读 oa-store（D 盘 data/oa.db），绝不含任何股票数据；接入真实 SSH 后采集器把真实数据写入 oa.db。
function collectOaContext() {
  const st = oaStore.getStatus();
  const logs = oaStore.getLogs(12);
  const web = oaStore.listWebSites();
  const bks = oaStore.listBackups(5);
  const urls = oaUrls();
  const syncBrief = oaSyncCache && oaSyncCache.ok
    ? oaSyncCache.mappings.map(m => ({ label: m.label, status: m.status, inSync: m.inSync, pushTotal: m.pushTotal, pullTotal: m.pullTotal }))
    : null;
  // 最近一次真实日志抓取（后端 + nginx 各取末尾若干行），供 AI 按需诊断
  const realLogs = {};
  if (oaLogsCache && oaLogsCache.sources) {
    if (oaLogsCache.sources.backend) realLogs.backend = oaLogsCache.sources.backend.slice(-15);
    if (oaLogsCache.sources.nginx) realLogs.nginx = oaLogsCache.sources.nginx.slice(-15);
    if (oaLogsCache.sources['nginx-error'] && oaLogsCache.sources['nginx-error'].length) realLogs['nginx-error'] = oaLogsCache.sources['nginx-error'].slice(-15);
    if (oaLogsCache.sources.mysql && oaLogsCache.sources.mysql.length) realLogs.mysql = oaLogsCache.sources.mysql.slice(-15);
  }
  return {
    connected: oaStore.sshConnected(),
    host: oaStore.getConfig('ssh.host'),
    user: oaStore.getConfig('ssh.user'),
    port: oaStore.getConfig('ssh.port'),
    backupStrategy: oaStore.getConfig('backup.strategy'),
    status: st,
    logs: logs,
    web: web,
    backups: bks,
    urls: urls,
    sync: syncBrief,
    realLogs: realLogs
  };
}

// <客户>教务 OA 项目内置信息（与项目 README/云控台一致；作为助手对项目的固有认知）
function oaProjectBrief() {
  const localRoot = oaStore.getConfig('oa.path.local') || '<资料库>';
  const code = oaStore.getConfig('oa.path.code') || '/opt/langchen_oa';
  const www = oaStore.getConfig('oa.path.www') || '/var/www';
  return [
    '【项目】<客户>教务内部管理系统（<客户>教育 OA）',
    '- 端：Web 管理后台（Vue3 + Element Plus + Vite + Pinia）；教师移动端 App（uni-app）；家长移动端 App（uni-app）',
    '- 后端：Node.js + Express + JWT；数据库 MySQL 8.0；部署 Nginx 反向代理 + HTTPS + pm2（应用名 langchen-oa，端口 3000）',
    '- 角色权限硬隔离：超级管理员 / 教务专员 / 授课教师',
    '- 功能边界：教务管理与教学管理；不含财务/报销/人事/采购/收费/家长端功能',
    '- 账号由后台手动创建，禁止自助注册',
    '- 本地代码：' + localRoot + '；云端代码：' + code + '；站点目录：' + www + '（admin/teacher/parent 三个站点）',
    '- 同步映射（本地 ↔ 云端）：后端 ' + localRoot + '\\backend ↔ ' + code + '/backend；管理后台 ' + localRoot + '\\web\\dist ↔ ' + www + '/admin；教师端/家长端 H5 构建产物 ↔ ' + www + '/teacher|parent（与云控台 push/pull 增量同步一致，排除 node_modules/.git/dist/.env/*.log）',
    '- 运维：pm2 管理后端进程（重启/日志），nginx 管理三个站点，MySQL 8.0 数据库备份'
  ].join('\n');
}

// OA 助手系统提示（像普通对话一样自由；项目背景仅供参考，不设束缚性规则）
function buildOaSystem(c) {
  const L = [];
  L.push('你是用户「<客户>教务内部管理系统」（<客户>教育 OA）项目的专职维护与更新助手。本项目是你在本对话中的长期职责：帮用户维护、排查、修改、同步这个项目的代码、数据与部署。项目源码在本机 ' + (oaStore.getConfig('oa.path.local') || '<资料库>') + '（全部在 D/E 盘，绝不碰 C 盘）。');
  L.push('你可以像普通对话一样自由聊天、帮忙分析问题、给出建议、协助改代码，不必拘泥于运维话术。');
  L.push('下面是该项目（<客户>教育 OA）的背景信息与当前状态，回答项目相关问题时可作参考。');
  L.push('');
  L.push(oaProjectBrief());
  L.push('');
  // 项目主上下文（oa-context.md）：自动注入，助手直接掌握项目全貌，无需临时翻文件
  try {
    const ctxPath = path.join(__dirname, 'scenarios', 'oa-context.md');
    if (fs.existsSync(ctxPath)) {
      const ctx = fs.readFileSync(ctxPath, 'utf8').trim();
      if (ctx) {
        L.push('【项目速查（自动注入）】');
        L.push(ctx);
        L.push('');
      }
    }
  } catch (e) { warnOnce("main", e) }
  if (c.connected) {
    L.push('【连接状态】已接入真实服务器 ' + (c.host || '') + (c.user ? '（' + c.user + '@' + (c.host || '') + '）' : ''));
  } else {
    L.push('【连接状态】尚未接入真实服务器，当前为演示数据；回答时如实说明，并可给出接入真实数据后应执行的检查步骤。');
  }
  const st = c.status;
  if (st) {
    L.push('【服务器】' + (st.host || '未知') + ' · ' + (st.os || '') + ' · 运行 ' + (st.uptime || '') +
      ' · CPU ' + (st.cpu != null ? st.cpu + '%' : '--') + ' / 内存 ' + (st.mem != null ? st.mem + '%' : '--') +
      ' / 磁盘 ' + (st.disk != null ? st.disk + '%' : '--'));
    if (Array.isArray(st.services) && st.services.length) {
      L.push('【服务状态】' + st.services.map(s =>
        s.name + ' ' + (s.ok ? '✓' : '✗') + (s.state ? '(' + s.state + ')' : '')).join('；'));
    }
  }
  if (Array.isArray(c.urls) && c.urls.length) {
    L.push('【相关网址】' + c.urls.map(u => u.name + ' ' + u.url).join('；'));
  }
  if (Array.isArray(c.web) && c.web.length) {
    L.push('【网页状态(实时探测)】' + c.web.map(w => w.name + ' ' + w.url + ' [' + w.status + (w.note ? ' ' + w.note : '') + ']').join('；'));
  }
  if (Array.isArray(c.logs) && c.logs.length) {
    L.push('【最近操作日志(最近 ' + c.logs.length + ' 条)】');
    c.logs.slice(0, 10).forEach(l => L.push('- ' + (l.ts || '').slice(5, 16) + ' [' + l.level + '] ' + l.msg));
  }
  if (c.realLogs && (c.realLogs.backend || c.realLogs.nginx || c.realLogs['nginx-error'] || c.realLogs.mysql)) {
    L.push('【真实日志(最近一次抓取的末尾片段)】');
    if (c.realLogs.backend && c.realLogs.backend.length) {
      L.push('— 后端(pm2 langchen-oa)：');
      c.realLogs.backend.slice(-12).forEach(x => L.push('  ' + x));
    }
    if (c.realLogs['nginx-error'] && c.realLogs['nginx-error'].length) {
      L.push('— Nginx 错误：');
      c.realLogs['nginx-error'].slice(-8).forEach(x => L.push('  ' + x));
    }
    if (c.realLogs.nginx && c.realLogs.nginx.length) {
      L.push('— Nginx 访问(最近 ' + Math.min(8, c.realLogs.nginx.length) + ' 条)：');
      c.realLogs.nginx.slice(-8).forEach(x => L.push('  ' + x));
    }
    if (c.realLogs.mysql && c.realLogs.mysql.length) {
      L.push('— MySQL：');
      c.realLogs.mysql.slice(-8).forEach(x => L.push('  ' + x));
    }
    L.push('（日志由窗口4实时抓取缓存；如需更完整日志，可让用户在窗口2执行 tail/pm2 logs 查看）');
  }
  if (Array.isArray(c.sync) && c.sync.length) {
    L.push('【本地↔云端同步(最近一次比对)】' + c.sync.map(s =>
      s.label + ' ' + (s.inSync ? '已同步' : ('待同步 推送' + (s.pushTotal || 0) + '/拉取' + (s.pullTotal || 0)))).join('；'));
  }
  if (Array.isArray(c.backups) && c.backups.length) {
    L.push('【数据库备份】最近：' + c.backups.slice(0, 3).map(b => b.name + ' ' + (b.size || '')).join('、') +
      (c.backupStrategy ? '；策略：' + c.backupStrategy : ''));
  }
  L.push('');
  L.push('回答时自然、直接、友好，用简体中文；涉及项目实时数据时以上面给出的信息为准，不确定就如实说明不确定，不要编造。');
  L.push('');
  L.push('如果你需要修改项目代码或执行本地↔云端同步，可以用下面的工具语法，系统会自动执行并在对话里展示结果（写入与同步前会请用户确认）：');
  L.push('- 读取文件：[工具 read:backend/src/xxx.js]');
  L.push('- 修改文件：[工具 write:backend/src/xxx.js] 后紧跟一个代码块 ```js 完整新内容 ```（每次一个文件，输出完整内容）');
  L.push('- 同步：[工具 sync:push:backend] / [工具 sync:pull:backend]');
  L.push('只允许 backend/ 与 web/ 下的源码文件，禁止 .env；写入前系统会自动备份原文件到 D 盘 data/oa-code-backups/。');
  return L.join('\n');
}

// 执行一键操作（当前为演示：记录到操作日志；接入真实 SSH 后改为远程执行）
// 执行一键操作：已配置 SSH → 真实远程执行；否则演示模式（记录到操作日志）
async function runOaAction(id) {
  const a = oaStore.getAction(id);
  if (!a) return { ok: false, err: '未知操作: ' + id };
  if (oaSsh.isReady()) {
    const r = await oaSsh.exec(a.cmd);
    oaStore.addLog('info', 'action', '执行操作「' + a.name + '」：' + a.cmd + (r && r.ok ? '' : '（失败：' + ((r && r.err) || '未知') + '）'));
    return {
      ok: !!(r && r.ok), id: a.id, name: a.name, cmd: a.cmd, danger: !!a.danger, demo: false,
      out: (r && r.out) || '', err: (r && r.err) || '',
      result: (r && r.ok) ? '已通过 SSH 执行：' + a.cmd : '执行失败：' + ((r && r.err) || '未知错误')
    };
  }
  oaStore.addLog('info', 'action', '执行操作「' + a.name + '」：' + a.cmd + '（演示模式）');
  return {
    ok: true, id: a.id, name: a.name, cmd: a.cmd, danger: !!a.danger, demo: true,
    result: '演示模式：已记录到操作日志。接入真实服务器后该操作将经 SSH 执行。'
  };
}

// 终端执行：已配置 SSH → 真实远程执行；否则演示模式（常见命令给模拟输出并记录）
async function runOaShell(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return { ok: false, err: '空命令' };
  if (oaSsh.isReady()) {
    const r = await oaSsh.exec(c);
    oaStore.addShell(c, (r && (r.out || r.err)) || '');
    oaStore.addLog('info', 'shell', '执行命令：' + c + (r && r.ok ? '' : '（失败：' + ((r && r.err) || '未知') + '）'));
    return { ok: !!(r && r.ok), cmd: c, out: (r && r.out) || '', err: (r && r.err) || '', demo: false };
  }
  const lc = c.toLowerCase();
  let out = '';
  if (/^(uptime|w)$/.test(lc)) {
    out = ' 10:24:01 up 36 days,  4:12,  2 users,  load average: 0.23, 0.31, 0.27';
  } else if (lc.indexOf('df') === 0) {
    out = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        80G   46G   34G  58% /data';
  } else if (lc.indexOf('free') === 0) {
    out = '              total        used        free      shared  buff/cache   available\nMem:           7.8G        3.2G        1.1G        210M        3.5G        4.2G';
  } else if (lc.indexOf('systemctl status') === 0) {
    out = '● oa-app.service - OA Application (gunicorn)\n   Loaded: loaded (/etc/systemd/system/oa-app.service; enabled)\n   Active: active (running) since Tue 2026-08-03 06:00:12 UTC; 36 days ago';
  } else if (lc.indexOf('ls') === 0) {
    out = 'config/  logs/  app.py  settings.py  requirements.txt  .env  deploy.sh';
  } else if (lc.indexOf('cat ') === 0) {
    out = '（演示模式）未接入真实服务器，无法读取远程文件内容。';
  } else {
    out = '（演示模式）命令已记录：' + c + '\n接入真实服务器后将通过 SSH 执行并返回真实输出。';
  }
  oaStore.addShell(c, out);
  oaStore.addLog('info', 'shell', '执行命令：' + c);
  return { ok: true, cmd: c, out: out, demo: true };
}


ipcMain.handle('stock:watch:set', (e, code, name) => stockStore.setWatch(code, name));
ipcMain.handle('stock:watch:list', () => stockStore.listWatch());
ipcMain.handle('stock:watch:remove', (e, code) => stockStore.removeWatch(code));
ipcMain.handle('stock:pos:set', (e, code, name, shares, cost) => stockStore.setPosition(code, name, shares, cost));
ipcMain.handle('stock:pos:list', () => stockStore.listPositions());
ipcMain.handle('stock:pos:update', (e, code, patch) => stockStore.updatePosition(code, patch));
ipcMain.handle('stock:pos:remove', (e, code) => stockStore.removePosition(code));
// ---- 交易（同花顺口径：费用 / 摊薄成本 / T+1 / 已实现盈亏）----
ipcMain.handle('stock:trade:buy', (e, code, name, shares, price) => stockStore.buyStock(code, name, shares, price));
ipcMain.handle('stock:trade:sell', (e, code, name, shares, price) => stockStore.sellStock(code, name, shares, price));
ipcMain.handle('stock:trade:close', (e, code, price) => stockStore.closePosition(code, price));
ipcMain.handle('stock:trade:list', (e, limit) => stockStore.listTrades(limit));
ipcMain.handle('stock:trade:stats', () => stockStore.tradeStats());
// 费率设置（佣金/印花税/过户费）
ipcMain.handle('stock:fee:get', () => stockStore.getFeeConfig());
ipcMain.handle('stock:fee:set', (e, patch) => stockStore.setFeeConfig(patch));
ipcMain.handle('stock:quote:cache', (e, code, payload) => stockStore.cacheQuote(code, payload));
ipcMain.handle('stock:quote:latest', (e, code) => stockStore.latestQuote(code));
ipcMain.handle('stock:kline:cache', (e, code, period, payload) => stockStore.cacheKline(code, period, payload));
ipcMain.handle('stock:kline:latest', (e, code, period) => stockStore.latestKline(code, period));
// ---- 板块每日快照（趋势看板历史数据：按 市场+日期 存当天各板块行情概况）----
ipcMain.handle('stock:sector:daily:set', (e, market, date, snapshots) => {
  // snapshots = { sectorId: { avg, up, down, quotes } }
  if (!snapshots || typeof snapshots !== 'object') return { ok: false };
  Object.keys(snapshots).forEach(sid => {
    try { stockStore.cacheSectorDaily(market, date, sid, snapshots[sid]); } catch (ex) { warnOnce("main", ex) }
  });
  return { ok: true, n: Object.keys(snapshots).length };
});
ipcMain.handle('stock:sector:daily:get', (e, market, date) => stockStore.getSectorDaily(market, date));
ipcMain.handle('stock:sector:daily:history', (e, market, sectorId, limit) => stockStore.listSectorDaily(market, sectorId, limit));
// ---- 账户 / 总资产（现金、资产快照）----
ipcMain.handle('stock:acct:init', (e, amount) => stockStore.initCash(amount));
ipcMain.handle('stock:acct:cash', () => stockStore.getCash());
ipcMain.handle('stock:acct:account', () => stockStore.getAccount());
ipcMain.handle('stock:acct:set-total', (e, amount) => stockStore.setTotalAsset(amount));
ipcMain.handle('stock:acct:set-cash', (e, amount) => stockStore.setCash(amount));
ipcMain.handle('stock:acct:adjust', (e, delta) => stockStore.adjustCash(delta));
ipcMain.handle('stock:acct:snapshot', (e, snap) => stockStore.addAssetSnapshot(snap));
ipcMain.handle('stock:acct:snapshots', (e, limit) => stockStore.listAssetSnapshots(limit));

// ---- 股票助手：运行 Python 数据脚本（akshare / baostock）----
const PYTHON = '<盘根>:\\software\\yuyanhuanjing\\python\\python.exe';
ipcMain.handle('stock:script:run', (e, script) => new Promise((resolve) => {
  if (!script || typeof script !== 'string') return resolve({ ok: false, out: '', err: '脚本为空' });
  // 用 utf-8 环境变量避免中文乱码
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, out, err: err + '\n[超时 30s 已终止]' }); }, 30000);
  proc.on('close', code => {
    clearTimeout(timer);
    resolve({ ok: code === 0, out, err });
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    resolve({ ok: false, out, err: String(ex && ex.message || ex) });
  });
}));

// ---- 股票助手：真实行情（腾讯行情接口，批量 0.5s 级）----
ipcMain.handle('stock:quote:realtime', (e, codes) => new Promise((resolve) => {
  const list = Array.isArray(codes) ? codes.filter(c => typeof c === 'string' && c) : [];
  if (!list.length) return resolve({ ok: true, quotes: {} });
  const script = `
import json, requests, concurrent.futures
def conv(code):
    code = str(code).strip().upper()
    if code.endswith('.SH'): return 'sh' + code[:-3]
    if code.endswith('.SZ'): return 'sz' + code[:-3]
    if code.isdigit():
        return ('sh' if code[0] in '569' else 'sz') + code
    if code.startswith('US'): return 'us' + code[2:]   # 美股：qt.gtimg.cn 要求 usAAPL（代码保持大写）
    if code.startswith('HK'): return 'hk' + code[2:]
    if code.startswith(('SH','SZ')): return code.lower()
    return 'us' + code
codes = [conv(c) for c in "__CODES__"]
H = {'User-Agent': 'Mozilla/5.0'}
def fetch(batch):
    url = 'https://qt.gtimg.cn/q=' + ','.join(batch)
    r = requests.get(url, timeout=8, headers=H)
    r.encoding = 'gbk'
    out = {}
    for line in r.text.strip().split(';'):
        if '=' not in line: continue
        sym = line.split('=')[0].strip()
        if sym.startswith('v_'): sym = sym[2:]
        parts = line.split('=')[1].strip().strip('"').split('~')
        if len(parts) > 45:
            out[sym] = {
                'name': parts[1], 'price': parts[3], 'preclose': parts[4],
                'open': parts[5], 'chg': parts[31], 'pct': parts[32],
                'high': parts[33], 'low': parts[34],
                'vol': parts[36], 'amount': parts[37], 'turn': parts[38],
                'mcap': parts[45],
                'bid': [[parts[9+2*k], parts[10+2*k]] for k in range(5)],
                'ask': [[parts[19+2*k], parts[20+2*k]] for k in range(5)]
            }
    return out
batches = [codes[i:i+60] for i in range(0, len(codes), 60)]
out = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    for r in ex.map(fetch, batches):
        out.update(r)
print(json.dumps({'ok': True, 'quotes': out}, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script.replace('"__CODES__"', JSON.stringify(list))], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, quotes: {}, err: err + '\n[超时 15s]' }); }, 15000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const data = JSON.parse(out.trim().split('\n').pop());
      resolve(data);
    } catch (ex) {
      resolve({ ok: false, quotes: {}, err: out + err });
    }
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    resolve({ ok: false, quotes: {}, err: String(ex && ex.message || ex) });
  });
}));

// ---- K线缓存的时效判定（★2026-10-15 加）----
// 原来缓存命中只看"非空"⇒ 日/周/月K 一旦写过就**永不回源**（实测 660 行 day 缓存里 633 行早于当天），
// 打开老票看到的是几天前的K线，选股器「波段启动」的 60 日位置 / 距 MA20 也跟着算错。
// 规则：① 缓存里最后一根K线的日期 ≥ "最近一个应当已有K线的交易日" ⇒ 新鲜；
//       ② 这一行缓存本身是今天写的（今天已经问过上游，它就给到这儿）⇒ 也算新鲜，避免节假日/停牌反复白拉。
function bjDayStr(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600e3 - (offsetDays || 0) * 86400e3);
  return d.toISOString().slice(0, 10);
}
function expectedBarDate() {
  const bj = new Date(Date.now() + 8 * 3600e3);
  const hm = bj.getUTCHours() * 100 + bj.getUTCMinutes();
  const isDay = (x) => x.getUTCDay() >= 1 && x.getUTCDay() <= 5;
  let d = new Date(bj.getTime());
  if (!isDay(d) || hm < 930) d = new Date(d.getTime() - 86400e3);   // 今天还没开盘（或本来不是交易日）⇒ 从昨天起找
  for (let i = 0; i < 7 && !isDay(d); i++) d = new Date(d.getTime() - 86400e3);
  return d.toISOString().slice(0, 10);
}
function klineCacheFresh(cached) {
  if (!cached || !cached.ok || !cached.kline || !cached.kline.length) return false;
  const last = cached.kline[cached.kline.length - 1];
  const lastDay = String((last && last[0]) || '');
  if (lastDay && lastDay >= expectedBarDate()) return true;
  return String(cached._ts || '').slice(0, 10) === bjDayStr(0);
}

// ---- K线历史数据（腾讯接口：日/周/月 K + 当日分时），供 K线图表面板 ----
// 持久缓存：先读 data/market.db 的 kline_cache（按 code+period），命中直接返回；
// 未命中才请求腾讯接口，成功后写入缓存，下次秒开。
ipcMain.handle('stock:kline:history', (e, code, period, count, force) => new Promise((resolve) => {
  const sym = String(code || '').trim();
  if (!sym) return resolve({ ok: false, err: 'empty code' });
  const per = ['day', 'week', 'month'].includes(period) ? period : 'day';
  const cnt = Math.max(10, Math.min(500, Number(count) || 120));
  // 1) 先读本地持久缓存（分时周期 force=true 强制拉最新：分时只在当天有效）
  const cached = stockStore.latestKline(sym, per);
  if (!force && klineCacheFresh(cached)) {
    // 分时只在当天有效，缓存里有则带上；没有则置空由前端重取
    return resolve(cached);
  }
  // 2) 未命中 → 请求腾讯接口
  // 代码转腾讯格式：600519 -> sh600519；000001.SH -> sh000001；美股 AAPL -> usAAPL
  let tk = sym.toUpperCase();
  if (tk.endsWith('.SH')) tk = 'sh' + tk.slice(0, -3);
  else if (tk.endsWith('.SZ')) tk = 'sz' + tk.slice(0, -3);
  else if (/^\d+$/.test(tk)) tk = (tk[0] === '6' || tk[0] === '9' ? 'sh' : 'sz') + tk;
  else if (/^(SH|SZ|HK)\d+/.test(tk)) tk = tk.toLowerCase();   // 已带 A股/港股前缀(如 SH600519)
  else tk = 'us' + tk;   // 纯字母美股 ticker（SHOP/USB 等以 sh/us 开头也是美股）
  const fq = 'qfq';   // 前复权
  const script = `
import json, requests
# tk 已由 Node 侧转成腾讯格式（sh600519 / usAAPL），这里不再二次转换
# （之前 conv() 会把小写转大写，腾讯接口大小写敏感导致 K线永远拉空）
sym = '${tk}'
H = {'User-Agent': 'Mozilla/5.0'}
out = {'ok': True, 'code': sym, 'kline': [], 'minute': None, 'date': None}
try:
    # 日/周/月 K 线（前复权）。主域名偶发 501 反爬（返回 JS 跳转页 → json() 抛错），
    # 自动换备用域名 proxy.finance.qq.com 重试（接口路径一致，返回结构相同）
    host = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
    fallback = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get'
    node = {}
    for u in [host, fallback]:
        try:
            url = '%s?param=%s,%s,,,%d,%s' % (u, sym, '${per}', ${cnt}, '${fq}')
            d = requests.get(url, timeout=8, headers=H).json()
            node = d.get('data', {}).get(sym, {})
            if isinstance(node, dict) and node:
                break
            node = {}
        except Exception:
            node = {}
    if isinstance(node, dict):
        key = 'qfq%s' % '${per}' if 'qfq%s' % '${per}' in node else '${per}'
        out['kline'] = node.get(key, [])
except Exception as ex:
    out['err'] = str(ex)[:200]
try:
    # 当日分时（data.data 才是数组，data.date 是日期）
    u2 = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=%s' % sym
    m = requests.get(u2, timeout=8, headers=H).json()
    node2 = m.get('data', {}).get(sym, {})
    if isinstance(node2, dict):
        inner = node2.get('data', {})
        if isinstance(inner, dict):
            out['minute'] = inner.get('data', [])
            out['date'] = inner.get('date', '')
except Exception as ex:
    out['minute'] = None
print(json.dumps(out, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, err: err + '\n[超时 12s]' }); }, 12000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const data = JSON.parse(out.trim().split('\n').pop());
      // 3) 成功后写入持久缓存（kline 非空才写）
      if (data && data.ok && data.kline && data.kline.length) {
        try { stockStore.cacheKline(sym, per, data); } catch (ex) { warnOnce("main", ex) }
      }
      resolve(data);
    }
    catch (ex) { resolve({ ok: false, err: out + err }); }
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    resolve({ ok: false, err: String(ex && ex.message || ex) });
  });
}));

// ---- 批量日K线（选股器打分用）：优先读缓存，未命中并发拉腾讯，返回 { ok, data: { code: kline } } ----
ipcMain.handle('stock:kline:batch', (e, codes, count) => new Promise((resolve) => {
  const list = (Array.isArray(codes) ? codes : []).filter(c => typeof c === 'string' && /^[\w.\-]+$/.test(c)).slice(0, 24);
  if (!list.length) return resolve({ ok: false, data: {} });
  const cnt = Math.max(30, Math.min(180, Number(count) || 120));
  const out = {};
  const need = [];
  list.forEach(code => {
    const cached = stockStore.latestKline(code, 'day');
    // ★2026-10-15：批量路径也要判时效 —— 这里喂的是选股器打分（超跌反弹 / 波段启动的均线、60 日位置），
    //   原来只要求"≥40 根"就算命中 ⇒ 拿到几天前的K线照算，特征全是旧的。
    if (cached && cached.kline && cached.kline.length >= 40 && klineCacheFresh(cached)) out[code] = cached.kline;
    else need.push(code);
  });
  if (!need.length) return resolve({ ok: true, data: out, fromCache: true });
  const tks = need.map(code => {
    let tk = String(code).toUpperCase();
    if (tk.endsWith('.SH')) tk = 'sh' + tk.slice(0, -3);
    else if (tk.endsWith('.SZ')) tk = 'sz' + tk.slice(0, -3);
    else if (/^\d+$/.test(tk)) tk = (tk[0] === '6' || tk[0] === '9' ? 'sh' : 'sz') + tk;
    else if (/^(SH|SZ|HK)\d+/.test(tk)) tk = tk.toLowerCase();
    else tk = 'us' + tk;
    return tk;
  });
  const script = `
import json, requests, concurrent.futures
H = {'User-Agent': 'Mozilla/5.0'}
TKS = ${JSON.stringify(tks)}
CNT = ${cnt}
def fetch(tk):
    # 主域名偶发 501 反爬 → 自动换备用域名重试（2026-09-18）
    hosts = ['https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
             'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get']
    for u in hosts:
        try:
            url = '%s?param=%s,day,,,%d,qfq' % (u, tk, CNT)
            d = requests.get(url, timeout=8, headers=H).json()
            node = d.get('data', {}).get(tk, {})
            if isinstance(node, dict):
                k = node.get('qfqday') or node.get('day') or []
                if k:
                    return (tk, k)
        except Exception:
            pass
    return (tk, [])
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    raw = dict(ex.map(fetch, TKS))
print(json.dumps(raw, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let outp = '', errs = '';
  proc.stdout.on('data', d => { outp += String(d); });
  proc.stderr.on('data', d => { errs += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, data: out, err: errs + ' [batch超时]' }); }, 15000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const raw = JSON.parse(outp.trim().split('\n').pop());
      Object.keys(raw).forEach((tk, i) => {
        const code = need[i];
        if (raw[tk] && raw[tk].length) {
          out[code] = raw[tk];
          try { stockStore.cacheKline(code, 'day', { ok: true, code: tk, kline: raw[tk], minute: [], date: '' }); } catch (ex) { warnOnce("main", ex) }
        }
      });
      resolve({ ok: true, data: out });
    } catch (ex) { resolve({ ok: false, data: out, err: String(ex && ex.message || ex) }); }
  });
  proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, data: out, err: String(ex && ex.message || ex) }); });
}));

// ---- 全市场排名（东方财富 clist：涨幅榜/跌幅榜双向扫描）----
// 供选股器使用：情绪（涨跌家数/涨停数）、超跌反弹（60日跌幅榜）、波段启动（涨幅榜）。
// 返回 { ok, type, list: [{code,name,price,pct,chg,vol,turn,mcap,totalMcap}], ts }
ipcMain.handle('stock:market:rank', (e, opts) => new Promise((resolve) => {
  // type: up|down（今日涨跌幅方向）；sort: 'pct'（默认，按今日涨跌幅）| 'r60'（按 60 日涨跌幅）
  const o = Object.assign({ type: 'down', pages: 2, sort: 'pct' }, opts || {});
  // ★ 2026-09-21 字段勘误（实测东财 clist，fltt=2）：
  //   f24 = 60 日涨跌幅（百分比，如 -56.68 即 -56.68%），与腾讯日K实算 60 日涨跌幅 24/25 只精确吻合 → 「超跌」必须用它；
  //   f22 ≠ 60 日涨跌幅（多数标的恒为 0，全市场极值仅 ±2%），旧代码用 f22 且再乘 100，
  //      导致「60日 -11%」实际是 -0.11%，超跌反弹引擎的「超跌深度」从根上就是假的。
  //   fltt=2 已返回百分比，禁止再乘 100。
  const fields = 'f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f24,f25,f62';
  // 已移除 f22：它常被误当成"60日涨跌幅"，实测多数标的恒为 0、全市场极值仅 ±2%，无用。
  // f15 = 当日最高价（用于判定"是否封在涨停板上"，见下方 atLimit）
  // 排序方向由服务端 po 参数决定：po=1 降序 / po=0 升序
  // 注意：之前恒用 po=1，导致"跌幅榜"实际返回的是涨幅榜，超跌反弹引擎拿到错误数据。
  // 东财对极简 UA（Mozilla/5.0）会直接断连，必须用完整浏览器 UA + 重试
  const byR60 = o.sort === 'r60';
  const sort = byR60 ? 'f24' : 'f3';
  // 按 60 日排序时：永远取"跌得最深"的一批（升序），与 up/down 无关
  const order = byR60 ? 'asc' : (o.type === 'up' ? 'desc' : 'asc');
  const po = byR60 ? '0' : (o.type === 'up' ? '1' : '0');
  // 缓存键带上排序维度，避免两种榜单互相覆盖
  const cacheKey = byR60 ? 'r60' : String(o.type || 'down');
  const script = `
import json, requests, concurrent.futures, time
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<IP> Safari/537.36',
     'Referer': 'https://quote.eastmoney.com/',
     'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
     'Connection': 'keep-alive'}
FIELDS = '${fields}'
# 东财会对部分入口域名直接断连（push2 实测 RemoteDisconnected）→ 多域名依次重试，任一可用即可
HOSTS = ['push2.eastmoney.com', 'push2delay.eastmoney.com', '82.push2.eastmoney.com']
def fetch(page):
    for host in HOSTS:
        url = ('https://%s/api/qt/clist/get?pn=%d&pz=60&po=${po}&np=1&fltt=2&invt=2'
               '&fid=%s&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=%s') % (host, page, '${sort}', FIELDS)
        # ★2026-10-16：东财被 WAF 掐时是**秒断**（实测 3 个域名各 ~0.4s 就 RemoteDisconnected），
        #   而这里原来"每域名重试 2 次 + 每次 sleep 1 秒 + 逐页串行"⇒ pages=4 的 60 日榜必然跑满
        #   外层 20 秒超时，面板就一直显示「⏳ 扫描中…」（用户截图里就是这个状态）。
        #   现改成：每域名只试一次、sleep 0.2、**多页并行** ⇒ 东财不通时 ~1 秒就返回空、立刻走新浪兜底。
        for attempt in range(1):
            try:
                r = requests.get(url, timeout=6, headers=H)
                diff = (r.json().get('data') or {}).get('diff', []) or []
                if diff:
                    return diff
            except Exception:
                pass
            time.sleep(0.2)
    return []
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as _ex:
    pages = list(_ex.map(fetch, range(1, ${Math.max(1, o.pages || 2)} + 1)))
rows = []
for pg in pages:
    for d in pg:
        code = d.get('f12') or ''
        if not code: continue
        try:
            price = float(d.get('f2') if d.get('f2') not in (None, '-') else 0)
        except Exception: price = 0
        try:
            pct = float(d.get('f3') if d.get('f3') not in (None, '-') else 0)
        except Exception: pct = 0
        try:
            # f24 = 60日涨跌幅，fltt=2 下已是百分比数值（-56.68 即 -56.68%），不可再乘 100
            r60 = float(d.get('f24') if d.get('f24') not in (None, '-') else 0)
        except Exception: r60 = 0
        try:
            mv = float(d.get('f62')) if d.get('f62') not in (None, '-') else 0
        except Exception:
            mv = 0
        try:
            hi = float(d.get('f15') if d.get('f15') not in (None, '-') else 0)
        except Exception: hi = 0
        # 涨停识别：涨跌幅上限随板块不同（主板 10% / 创业板·科创板 20% / 北交所 30% / **ST 5%**），
        # 用固定 9.8% 一刀切会把 20% 限制板上的 +11% 误判成"已封板买不进"。
        # ★2026-10-15 补 ST 分支：mkt-fallback.py 的 limit_pct() 早就有 ST=5%，两边口径必须一致
        #   （否则同一只 ST 票在主通道与兜底通道下 atLimit/分档 会不一样）。
        _nm = str(d.get('f14') or '')
        lim = 5.0 if ('ST' in _nm.upper() or '退' in _nm) else (30.0 if code[:2] in ('43', '83', '87', '92') else (20.0 if code[:3] in ('300', '301', '688', '689') else 10.0))
        # price == high 即"当前价即当日最高"（封在板上 / 或最高价回落前的高点），10 元股容差约 0.03%
        atLimit = bool(hi > 0 and price >= hi * 0.9997 and pct >= lim * 0.92)
        rows.append({
            'code': code, 'name': d.get('f14') or '', 'price': price, 'pct': pct,
            'chg': d.get('f4'), 'vol': d.get('f5'), 'amount': d.get('f6'),
            'turn': d.get('f8'), 'mcap': d.get('f20'), 'r60': r60,
            'high': hi, 'limitPct': lim, 'atLimit': atLimit,
            'high52': d.get('f15'), 'low52': d.get('f16'),
            'main': mv
        })
# 本地二次排序（接口已排序，但保险）：按 r60 时以 60 日涨跌幅升序
if '${byR60 ? 'r60' : order}' == 'r60':
    rows.sort(key=lambda x: x['r60'])
elif '${order}' == 'asc':
    rows.sort(key=lambda x: x['pct'])
else:
    rows.sort(key=lambda x: x['pct'], reverse=True)
print(json.dumps({'ok': True, 'type': '${o.type}', 'list': rows, 'ts': __import__('time').time()}, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => {
    proc.kill();
    // 超时：回退到本地缓存（避免接口限流时白屏）
    const cached = stockStore.latestRank(cacheKey);
    if (cached && cached.list && cached.list.length) {
      resolve(Object.assign({ ok: true, fromCache: true }, cached));
    } else {
      resolve({ ok: false, list: [], err: err + '\n[超时 20s]' });
    }
  }, 20000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const data = JSON.parse(out.trim().split('\n').pop());
      if (data.ok && data.list && data.list.length) {
        try { stockStore.cacheRank(cacheKey, { list: data.list, ts: data.ts }); } catch (ex) { warnOnce("main", ex) }
      } else {
        // 拉取失败但缓存有 → 用缓存
        const cached = stockStore.latestRank(cacheKey);
        if (cached && cached.list && cached.list.length) {
          return resolve(Object.assign({ ok: true, fromCache: true }, cached));
        }
      }
      resolve(data);
    } catch (ex) {
      const cached = stockStore.latestRank(cacheKey);
      if (cached && cached.list && cached.list.length) {
        resolve(Object.assign({ ok: true, fromCache: true }, cached));
      } else {
        resolve({ ok: false, list: [], err: out + err });
      }
    }
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    const cached = stockStore.latestRank(cacheKey);
    if (cached && cached.list && cached.list.length) {
      resolve(Object.assign({ ok: true, fromCache: true }, cached));
    } else {
      resolve({ ok: false, list: [], err: String(ex && ex.message || ex) });
    }
  });
}));

// ---- 插件 / 模型 面板（只读；数据全部来自项目文件夹，核心原则：不落 C 盘） ----
// 插件源：源码版在 <工作台>\插件（与 引擎 同级、不在引擎里）；安装版由 extraResources 放到 resources\插件。
// 引擎升级只替换 引擎 目录，插件留在原地，所以这里不再写死 HARNESS_DIR\插件。
const PLUGINS_DIR = fs.existsSync(path.join(HARNESS_DIR, '插件'))
  ? path.join(HARNESS_DIR, '插件')
  : path.join(__dirname, '..', '插件');
const DSH_DATA_DIR = path.join(HARNESS_DIR, '.dsh');
const SETTINGS_PATH = path.join(DSH_DATA_DIR, 'settings.yaml');

// 已安装插件清单：扫描 dsh 项目的「插件」目录（每个子目录一个插件，含 package.json 元信息）
ipcMain.handle('plugins:list', () => {
  const out = {
    pluginsDir: PLUGINS_DIR,
    dataDir: DSH_DATA_DIR,
    plugins: [],
    builtinDir: path.join(HARNESS_DIR, 'packages'),
    builtinCount: 0
  };
  try {
    if (fs.existsSync(PLUGINS_DIR)) {
      for (const d of fs.readdirSync(PLUGINS_DIR)) {
        const dir = path.join(PLUGINS_DIR, d);
        let st = null;
        try { st = fs.statSync(dir); } catch (e) { continue; }
        if (!st.isDirectory()) continue;   // 跳过 开发约定.md 等文件
        let name = d, version = null, description = '';
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            name = pkg.name || d;
            version = pkg.version || null;
            description = pkg.description || '';
          } catch (e) { warnOnce("main", e) }
        }
        const plugin = { name, displayName: d, version, description, path: dir };
        // 插件自身的 缓存/ 与 配置/ 目录（展示本地化数据位置）
        for (const sub of ['缓存', 'data', 'cache']) {
          const sp = path.join(dir, sub);
          try { if (fs.statSync(sp).isDirectory()) { plugin.cacheDir = sp; break; } } catch (e) { warnOnce("main", e) }
        }
        for (const sub of ['配置', 'config']) {
          const sp = path.join(dir, sub);
          try { if (fs.statSync(sp).isDirectory()) { plugin.configDir = sp; break; } } catch (e) { warnOnce("main", e) }
        }
        out.plugins.push(plugin);
      }
    }
    // 内置插件包数量（packages/client + packages/host 下的包）
    let n = 0;
    for (const base of [path.join(HARNESS_DIR, 'packages', 'client'), path.join(HARNESS_DIR, 'packages', 'host')]) {
      try {
        n += fs.readdirSync(base).filter(x => { try { return fs.statSync(path.join(base, x)).isDirectory(); } catch (e) { return false; } }).length;
      } catch (e) { warnOnce("main", e) }
    }
    out.builtinCount = n;
  } catch (e) { warnOnce("main", e) }
  return out;
});

// ---- 技能（Skill）清单：扫描 DSH 技能根目录 ----
// 约定来源 @deepseek-ai/dsh-skill-filesystem：
//   用户级 <dshHome>/skills（本机 = <工作台>\引擎\.dsh\skills）
//   项目级 <项目根>/.dsh/skills 与 <项目根>/.agents/skills
//   自定义 settings.yaml 的 customSkillDirs
// 技能格式（只在根目录顶层被发现）：<名字>/SKILL.md 目录包，或 <名字>.md 单文件；
// SKILL.md 顶部 YAML frontmatter 必需 name + description，可选 whenToUse 等。
// 2026-11-12 修（用户报「技能面板空」）：技能根必须跟**引擎 home**。
//   原来用 DSH_DATA_DIR = <外壳同级>\引擎\.dsh，而启动.vbs 用 DSH_CUSTOMER_HOME 把 home 指到 引擎数据\.dsh
//   ⇒ 扫的是不存在的目录，面板恒 0 个；DSH_HOME 已经是「env 优先」的那个值。
const SKILLS_DIR = path.join(DSH_HOME, 'skills');

// 极简 frontmatter 解析：只取 --- 块里的 name / description / whenToUse（其余字段忽略）
function parseSkillFrontmatter(text) {
  const meta = {};
  const m = String(text || '').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    val = val.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
    if (key === 'name' || key === 'description' || key === 'whenToUse') meta[key] = val;
  }
  return meta;
}

// 读取一个技能（目录包或单文件），返回目录条目
function readSkill(file, dirPath, format) {
  const entry = {
    name: '', description: '', whenToUse: '',
    file: file, dir: dirPath, format: format, valid: false, error: ''
  };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const meta = parseSkillFrontmatter(text);
    entry.name = meta.name || '';
    entry.description = meta.description || '';
    entry.whenToUse = meta.whenToUse || '';
    const st = fs.statSync(file);
    entry.mtime = st.mtimeMs;
    entry.size = st.size;
    if (!entry.name || !entry.description) {
      entry.error = 'frontmatter 缺少 name 或 description（引擎会丢弃该技能）';
    } else {
      entry.valid = true;
    }
  } catch (e) {
    entry.error = '读取失败：' + (e && e.message || e);
  }
  return entry;
}

ipcMain.handle('skills:list', () => {
  const out = { skillsDir: SKILLS_DIR, roots: [], skills: [] };
  // 扫描根：用户级 + 项目级（工作台所在目录）+ 自定义目录
  const roots = [
    { source: 'user-dsh', rank: 400, dir: SKILLS_DIR },
    { source: 'project-dsh', rank: 100, dir: path.join(__dirname, '.dsh', 'skills') },
    { source: 'project-agents', rank: 200, dir: path.join(__dirname, '.agents', 'skills') }
  ];
  for (const r of roots) {
    let exists = false;
    try { exists = fs.statSync(r.dir).isDirectory(); } catch (e) { exists = false; }
    out.roots.push({ source: r.source, rank: r.rank, dir: r.dir, exists: exists });
    if (!exists) continue;
    let names = [];
    try { names = fs.readdirSync(r.dir); } catch (e) { continue; }
    for (const n of names) {
      if (n === '.system' || n === '.git' || n.startsWith('_') || n.startsWith('.')) continue;   // 跳过系统/说明目录
      const full = path.join(r.dir, n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        const entryFile = path.join(full, 'SKILL.md');
        if (!fs.existsSync(entryFile)) continue;   // 目录包必须有 SKILL.md
        const entry = readSkill(entryFile, full, 'bundle');
        if (!entry.name) entry.name = n;
        entry.source = r.source;
        out.skills.push(entry);
      } else if (st.isFile() && /\.md$/i.test(n)) {
        const entry = readSkill(full, r.dir, 'flat');
        if (!entry.name) entry.name = n.replace(/\.md$/i, '');
        entry.source = r.source;
        out.skills.push(entry);
      }
    }
  }
  // 优先级高（rank 小）的排前面；同名去重，保留优先级高的
  out.skills.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const seen = {};
  out.skills = out.skills.filter(s => {
    const key = String(s.name || '').toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
  return out;
});

// 打开技能目录 / 打开单个技能正文（系统默认程序）
ipcMain.handle('skills:open', (e, target) => {
  const p = target ? String(target) : SKILLS_DIR;
  try { if (fs.existsSync(p)) { shell.openPath(p); return { ok: true, path: p }; } } catch (ex) { warnOnce("main", ex) }
  return { ok: false, err: '路径不存在：' + p };
});

// ---- 设置：读取 / 打开 Harness 配置文件（.dsh/settings.yaml + .credentials.yaml，凭据脱敏）----
const CREDENTIALS_PATH = path.join(DSH_DATA_DIR, '.credentials.yaml');
ipcMain.handle('settings:list', () => {
  const out = { settingsPath: SETTINGS_PATH, credentialsPath: CREDENTIALS_PATH, files: {} };
  try { if (fs.existsSync(SETTINGS_PATH)) out.files.settings = fs.readFileSync(SETTINGS_PATH, 'utf8'); } catch (e) { warnOnce("main", e) }
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      let t = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      // 脱敏：把行尾 12+ 位长的值（密钥/token）打码，保留短配置项
      t = t.replace(/(:\s*)(["']?)([A-Za-z0-9_\-.]{12,})(["']?)(\s*(#.*)?)$/gm, '$1$2••••••（已隐藏）$4$5');
      out.files.credentials = t;
    }
  } catch (e) { warnOnce("main", e) }
  return out;
});
ipcMain.handle('settings:open', (e, which) => {
  const f = which === 'credentials' ? CREDENTIALS_PATH : SETTINGS_PATH;
  if (fs.existsSync(f)) {
    try { shell.openPath(f); return { ok: true }; } catch (ex) { return { ok: false, err: ex.message }; }
  }
  return { ok: false, err: '文件不存在' };
});

// ---- 余额实时显示：DeepSeek 平台余额（API 密钥只留在主进程，渲染层永远拿不到明文）----
// 数据源优先级：① 「余额显示」插件（引擎侧 GET /plugins/deepseek-balance/balance）
//               ② 插件未加载/不可用时回退主进程直连 https://api.deepseek.com/user/balance
// 点击余额打开 https://platform.deepseek.com/usage
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const BALANCE_PLUGIN_URL = BASE + '/plugins/deepseek-balance/balance';
const BALANCE_PAGE = 'https://platform.deepseek.com/usage';
const BALANCE_INTERVAL = 10000;   // 每 10 秒刷新一次
let balanceTimer = null;
let lastBalance = null;
let balanceVia = '';              // 最近一次取数来源：plugin / direct

// 首选：走「余额显示」插件；插件未加载时返回 null（由调用方回退直连）
function fetchBalanceViaPlugin() {
  return new Promise(function (resolve) {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(BALANCE_PLUGIN_URL, { timeout: 8000 }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        try {
          const j = JSON.parse(data || '{}');
          if (j && j.ok) {
            return finish({
              ok: true, ts: j.ts || Date.now(), isAvailable: !!j.isAvailable,
              currency: j.currency || 'CNY', total: j.total,
              granted: j.granted, toppedUp: j.toppedUp
            });
          }
        } catch (e) { warnOnce("main", e) }
        finish(null);   // 插件返回失败 → 交给直连路径
      });
    });
    req.on('timeout', function () { req.destroy(); finish(null); });
    req.on('error', function () { finish(null); });
  });
}

// 解析 DeepSeek 密钥：按「引擎真正的 home」顺序找 .credentials.yaml 的 refs.DEEPSEEK_API_KEY，最后看环境变量
// 2026-11-12 修（用户报「右上角余额显示不出来，只显示 ¥ --」）：
//   启动.vbs 用 DSH_CUSTOMER_HOME 把 home 指到「引擎数据\.dsh」，而这里从前只读 DSH_DATA_DIR（引擎\.dsh）——
//   那个目录在本机根本不存在 ⇒ 取不到密钥 ⇒ 余额一直停在「未配置 DEEPSEEK_API_KEY」的失败态。
const CRED_FILES = [path.join(DSH_HOME, '.credentials.yaml'), path.join(DSH_DATA_DIR, '.credentials.yaml')];
function readDeepseekKey() {
  for (const cred of CRED_FILES) {
    try {
      if (!fs.existsSync(cred)) continue;
      const m = fs.readFileSync(cred, 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/);
      const k = m && m[1] ? m[1].replace(/^["']|["']$/g, '') : '';
      if (k) return k;
    } catch (e) { warnOnce("main", e) }
  }
  return process.env.DEEPSEEK_API_KEY || '';
}

async function fetchDeepseekBalance() {
  // ① 优先「余额显示」插件（引擎侧实现，插件未加载时静默回退）
  try {
    const viaPlugin = await fetchBalanceViaPlugin();
    if (viaPlugin) { balanceVia = 'plugin'; return viaPlugin; }
  } catch (e) { warnOnce("main", e) }
  balanceVia = 'direct';

  const key = readDeepseekKey();
  if (!key) return { ok: false, err: '未配置 DEEPSEEK_API_KEY（已查 ' + CRED_FILES.join(' / ') + ' 与环境变量）', ts: Date.now() };
  const ctl = new AbortController();
  const to = setTimeout(() => { try { ctl.abort(); } catch (e) { warnOnce("main", e) } }, 15000);
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: ctl.signal
    });
    clearTimeout(to);
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status, ts: Date.now() };
    const j = await res.json();
    const list = Array.isArray(j && j.balance_infos) ? j.balance_infos : [];
    const info = list.find(function (x) { return x && x.currency === 'CNY'; }) || list[0];
    if (!info) return { ok: false, err: '响应无余额信息', ts: Date.now() };
    return {
      ok: true, ts: Date.now(), isAvailable: !!(j && j.is_available),
      currency: info.currency || 'CNY',
      total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance
    };
  } catch (ex) {
    clearTimeout(to);
    const msg = (ex && ex.name === 'AbortError') ? '请求超时' : (ex && ex.message || String(ex));
    return { ok: false, err: msg, ts: Date.now() };
  }
}

function pushBalance(v) {
  lastBalance = v;
  try {
    // 余额要发全部窗口：分离出去的场景窗口也显示余额条
    try { broadcast('balance:update', v); } catch (e) { warnOnce("main", e) }
  } catch (e) { warnOnce("main", e) }
  return v;
}

function startBalancePoll() {
  if (balanceTimer) clearInterval(balanceTimer);
  const tick = async function () { pushBalance(await fetchDeepseekBalance()); };
  tick();
  balanceTimer = setInterval(tick, BALANCE_INTERVAL);
}

ipcMain.handle('balance:get', async () => lastBalance || await fetchDeepseekBalance());
ipcMain.handle('balance:refresh', async () => pushBalance(await fetchDeepseekBalance()));

// ============ 手机远程访问（dsh-plugin-remote-access）============
// 数据源：插件路由 /plugins/remote-access/*（插件内部放行 loopback 调用，故主进程可直接取）
const REMOTE_BASE = BASE + '/plugins/remote-access';

/** 向远程访问插件发一个请求；asBuffer=true 时保留原始 Buffer（取 PNG 二维码）。 */
function remoteAccessHttp(method, urlPath, asBuffer) {
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(REMOTE_BASE + urlPath); } catch (e) { return resolve({ status: 0, error: '地址无效' }); }
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method, timeout: 15000
    }, function (res) {
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        finish({ status: res.statusCode, buf: buf, text: asBuffer ? '' : buf.toString('utf8') });
      });
    });
    req.on('timeout', function () { req.destroy(); finish({ status: 0, error: '请求超时' }); });
    req.on('error', function (e) { finish({ status: 0, error: e.message }); });
    req.end();
  });
}

ipcMain.handle('remoteAccess:status', async () => {
  const r = await remoteAccessHttp('GET', '/status');
  try { return JSON.parse(r.text); } catch (e) { return { ok: false, error: r.error || ('HTTP ' + r.status) }; }
});

ipcMain.handle('remoteAccess:qr', async () => {
  const r = await remoteAccessHttp('GET', '/qr.png', true);
  return (r.status === 200 && r.buf && r.buf.length)
    ? ('data:image/png;base64,' + r.buf.toString('base64'))
    : '';
});

// 引导第一步用的静态图：手机 WireGuard 配置二维码
ipcMain.handle('remoteAccess:guideImage', async () => {
  try {
    const p = path.join(PLUGINS_DIR, '手机远程访问', 'runtime', '手机导入.png');
    if (fs.existsSync(p)) return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) { warnOnce("main", e) }
  return '';
});

ipcMain.handle('remoteAccess:action', async (e, action) => {
  if (action !== 'refresh' && action !== 'restart') return { ok: false, error: '未知操作' };
  const r = await remoteAccessHttp('POST', '/' + action);
  try { return JSON.parse(r.text); } catch (err) { return { ok: false, error: r.error || ('HTTP ' + r.status) }; }
});
// 外观：窗口底色随主题（浅色 #fafafa / 深色 #0a0a0a），避免缩放重绘闪黑
ipcMain.handle('theme:set-window-bg', (e, color) => {
  const v = String(color || '');
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    try { const w = windowOfEvent(e); if (w) w.setBackgroundColor(v); } catch (ex) { warnOnce("main", ex) }
  }
  return true;
});
ipcMain.handle('balance:open', () => {
  try { shell.openExternal(BALANCE_PAGE); } catch (e) { warnOnce("main", e) }
  return true;
});

// 模型与提供方：解析**引擎真正在用的配置**
//   ★ 2026-10-15 修：旧版死读 .dsh\settings.yaml，而 0.2.1 起该文件根本不存在
//     ⇒ 弹窗必然显示「当前默认模型 —」「未发现自定义提供方」（用户报的"模型提供方不显示"）。
//   现在改为按**结构**解析（不认行号、不认固定缩进）：
//     · profiles\<名字>\cordis.patch.yml 里任意 `providers:` 块 ⇒ 每个子键一个提供方（含 models 列表）
//     · `- id: agent-default-model` / `agent-default-model:` 块 ⇒ 默认模型
//     · 密钥是否已配 = 环境变量 或 .credentials.yaml 的 refs:（引擎把密钥存这，环境变量里通常没有）
const MODEL_PATCH_FILES = () => {
  const out = [];
  try {
    const base = path.join(DSH_DATA_DIR, 'profiles');
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        const p = path.join(base, d, 'cordis.patch.yml');
        if (fs.existsSync(p)) out.push(p);
      }
    }
    const top = path.join(DSH_DATA_DIR, 'cordis.patch.yml');
    if (fs.existsSync(top)) out.push(top);
    if (fs.existsSync(SETTINGS_PATH)) out.push(SETTINGS_PATH);   // 旧引擎口径，留着兼容
  } catch (e) { warnOnce("main", e) }
  return out;
};

function parseModelConfig(text) {
  const providers = [];
  const def = {};
  const lines = String(text).split(/\r?\n/);
  let provIndent = -1;                       // providers: 的缩进，-1 = 不在块里
  let cur = null;
  let inModels = false;
  let inDef = false, defIndent = -1;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = (line.match(/^ */) || [''])[0].length;
    const t = line.trim();
    // 默认模型（三种写法都认：`- id: agent-default-model` ← 当前引擎实际写法 / `agent-default-model:` / `id: ...`）
    if (/^(?:-\s*)?(?:id:\s*)?agent-default-model:?\s*$/.test(t)) {
      inDef = true; defIndent = indent; provIndent = -1; cur = null; inModels = false; continue;
    }
    if (inDef) {
      if (indent <= defIndent) { inDef = false; }
      else {
        const m = t.match(/^(provider|model|reasoningEffort):\s*(.+)$/);
        if (m) def[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        continue;
      }
    }
    if (/^providers:\s*$/.test(t)) { provIndent = indent; cur = null; inModels = false; continue; }
    if (provIndent < 0) continue;
    if (indent <= provIndent) { provIndent = -1; cur = null; inModels = false; continue; }
    if (indent === provIndent + 2 && /^[A-Za-z0-9_.\-]+:\s*$/.test(t)) {
      cur = { id: t.slice(0, -1), models: [] };
      providers.push(cur); inModels = false; continue;
    }
    if (!cur) continue;
    if (inModels) {
      const m = t.match(/^-?\s*id:\s*(.+)$/);
      if (m) cur.models.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^models:\s*$/.test(t)) { inModels = true; continue; }
    const m2 = t.match(/^(displayName|apiKeyEnv|api|baseURL):\s*(.+)$/);
    if (m2) cur[m2[1]] = m2[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { def, providers };
}

ipcMain.handle('models:list', () => {
  const files = MODEL_PATCH_FILES();
  const out = { settingsPath: files[0] || SETTINGS_PATH, default: null, providers: [], sourceFiles: files };
  try {
    // 引擎已登记的密钥名（.credentials.yaml 的 refs: 段）
    const refs = new Set();
    try {
      if (fs.existsSync(CREDENTIALS_PATH)) {
        const ct = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        for (const l of ct.split(/\r?\n/)) {
          const m = l.match(/^\s{2}([A-Za-z0-9_]+):/);
          if (m) refs.add(m[1]);
        }
      }
    } catch (e) { warnOnce("main", e) }
    const def = {};
    const merged = new Map();
    for (const f of files) {
      let r;
      try { r = parseModelConfig(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
      Object.assign(def, r.def);
      for (const p of r.providers) {
        const old = merged.get(p.id);
        if (!old) { merged.set(p.id, p); continue; }
        for (const k of Object.keys(p)) {
          if (k === 'models') continue;
          if (p[k]) old[k] = p[k];
        }
        for (const m of p.models) if (old.models.indexOf(m) < 0) old.models.push(m);
      }
    }
    out.default = Object.keys(def).length ? def : null;
    out.providers = Array.from(merged.values()).map(p => ({
      id: p.id,
      displayName: p.displayName || p.id,
      apiKeyEnv: p.apiKeyEnv || null,
      apiKeySet: p.apiKeyEnv ? (!!process.env[p.apiKeyEnv] || refs.has(p.apiKeyEnv)) : false,
      baseURL: p.baseURL || null,
      models: p.models || []
    }));
  } catch (e) { warnOnce("main", e) }
  return out;
});

// ===========================================================================
// 顶栏状态区（2026-10-16 新增：① 上下文压力灯 ② 谁在等我 ③ 快照/回滚）
//   **纯增量**：不动任何现有按钮 / IPC；渲染层在 renderer\topbar-status.js，读不到这组桥就不显示。
//   为什么放主进程：只有这里能读文件、能 spawn 脚本（渲染层没有 fs）。
// ===========================================================================
const TOPBAR_CTX = path.join(HARNESS_DIR, '.dsh', 'skills', 'context-overflow', 'ctx.mjs');
const TOPBAR_MEM = path.join(HARNESS_DIR, '场景项目信息');
const TOPBAR_CARD = path.join(__dirname, 'scenarios', 'dsh-gui-context.md');
const TOPBAR_BK = path.join(SHELL_DATA_DIR, 'backups');
const TOPBAR_ROOT = path.dirname(__dirname);   // <工作台>

// 跑 node 脚本：本体是 Electron，没有独立 node ⇒ 先试 ELECTRON_RUN_AS_NODE，失败再退回 PATH 上的 node
function topbarRun(script, args, timeout) {
  const tries = [
    { exe: process.execPath, env: scriptEnv({ ELECTRON_RUN_AS_NODE: '1' }) },
    { exe: 'node', env: scriptEnv() }
  ];
  let last = '';
  for (const t of tries) {
    try {
      const r = spawnSync(t.exe, [script].concat(args || []), {
        encoding: 'utf8', windowsHide: true, timeout: timeout || 90000,
        env: t.env, maxBuffer: 16 * 1024 * 1024
      });
      const out = String(r.stdout || '') + String(r.stderr || '');
      if (r.status === 0 && String(r.stdout || '').length) return { ok: true, out: String(r.stdout) };
      last = out || ('exit ' + r.status);
    } catch (e) { last = String((e && e.message) || e); }
  }
  return { ok: false, out: last };
}

// 工作台 10 条常驻会话：sessionId → 属于哪个场景/面板（压力灯用它把裸会话名翻译成"我的哪块面板"）
function topbarWorkbenchSessions() {
  const out = [];
  try {
    const dir = path.join(__dirname, 'scenarios');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      for (const p of (Array.isArray(j.panels) ? j.panels : [])) {
        if (p && p.sessionId) out.push({ scene: j.title || j.id || f, panel: p.title || p.id || '', sessionId: p.sessionId });
      }
    }
  } catch (e) { warnOnce("main", e) }
  return out;
}

// 异步版（压力灯每 90s 刷一次，**必须**用它）：⛔ spawnSync 是同步的，会把主进程连整个窗口的
// IPC/拖拽一起卡住 —— 实测 ctx.mjs --all 要 0.3s，那就是每 90 秒卡 0.3 秒。异步则零感知。
function topbarRunAsync(script, args, timeout) {
  return new Promise((resolve) => {
    const tries = [
      { exe: process.execPath, env: scriptEnv({ ELECTRON_RUN_AS_NODE: '1' }) },
      { exe: 'node', env: scriptEnv() }
    ];
    let last = '';
    const attempt = (i) => {
      if (i >= tries.length) return resolve({ ok: false, out: last });
      const t = tries[i];
      let out = '', settled = false, cp = null;
      try {
        cp = spawn(t.exe, [script].concat(args || []), { windowsHide: true, env: t.env });
      } catch (e) { last = String((e && e.message) || e); return attempt(i + 1); }
      const timer = setTimeout(() => { try { cp.kill(); } catch (e) { warnOnce("main", e) } }, timeout || 120000);
      cp.stdout.on('data', (d) => { out += d; });
      cp.stderr.on('data', (d) => { out += d; });
      cp.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); last = String((e && e.message) || e); attempt(i + 1); });
      cp.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0 && out) resolve({ ok: true, out });
        else { last = out || ('exit ' + code); attempt(i + 1); }
      });
    };
    attempt(0);
  });
}

// ⑦ 最近打开的文件夹（Windows 自己的"最近使用"记录，只读）
//   主数据源：%APPDATA%\Microsoft\Windows\Recent\*.lnk —— Explorer 每打开一个文件/文件夹就写一条，按 .lnk 的 mtime 倒序。
//   .lnk 的目标**直接从二进制里抠**（不依赖 COM/PowerShell，快且不弹窗）：
//     先按 UTF-16LE 找 `X 00 : 00 \ 00`，再按 ANSI/GBK 找 `<盘根>:\`；抠出来用 fs 验证「存在且是目录」⇒ 自动滤掉最近打开的**文件**。
//   结果缓存 60 秒，且只在用户点开 📁 胶囊时才跑（不常驻扫盘）。
let topbarRecentCache = { at: 0, rows: [] };
function topbarLnkTarget(p) {
  let buf = null;
  try { buf = fs.readFileSync(p); } catch (e) { return null; }
  if (buf.length < 80) return null;
  const cands = [];
  try {
    for (let i = 0; i + 6 < buf.length; i++) {                       // ① UTF-16LE：X 00 : 00 \ 00
      if (buf[i + 1] === 0 && buf[i + 2] === 0x3A && buf[i + 3] === 0 && buf[i + 4] === 0x5C && buf[i + 5] === 0) {
        let end = i;
        while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
        const s = buf.slice(i, end).toString('utf16le');
        if (s.length > 3) cands.push(s);
        i = end;
      }
    }
    for (let i = 0; i + 3 < buf.length; i++) {                       // ② ANSI / GBK：<盘根>:\
      const c = buf[i];
      if (buf[i + 1] === 0x3A && buf[i + 2] === 0x5C && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
        let end = i;
        while (end < buf.length && buf[end] !== 0 && buf[end] >= 0x20) end++;
        const seg = buf.slice(i, end);
        let s = '';
        try { s = new TextDecoder('gbk').decode(seg); } catch (e) { s = seg.toString('latin1'); }
        if (s.length > 3) cands.push(s);
        i = end;
      }
    }
  } catch (e) { warnOnce("main", e) }
  for (const c of cands) {
    const t = String(c).replace(/\0+$/, '').trim();
    if (!/^[A-Za-z]:\\/.test(t)) continue;
    try { if (fs.existsSync(t) && fs.statSync(t).isDirectory()) return t; } catch (e) { warnOnce("main", e) }
  }
  return null;
}
function topbarRecentFolders(limit) {
  const want = limit || 6;
  const now = Date.now();
  if (now - topbarRecentCache.at < 60000 && topbarRecentCache.rows.length) return topbarRecentCache.rows.slice(0, want);
  const cands = new Map();                       // 路径(小写) → { path, src, at }
  const add = (p, src) => {
    if (!p) return;
    const t = String(p).trim().replace(/[\u0000\s]+$/, '').replace(/\\+$/, '');
    if (!/^[A-Za-z]:\\/.test(t) || t.length > 240) return;
    let st = null;
    try { st = fs.statSync(t); } catch (e) { return; }     // 只留**真的还在**的目录（旧根路径会被自动滤掉）
    if (!st.isDirectory()) return;
    const k = t.toLowerCase();
    if (!cands.has(k)) cands.set(k, { path: t, src: src, at: st.mtimeMs });
  };
  // ① 主力：资源管理器跳转列表 —— 真正"最近打开过"的地方（Recent 里的 .lnk 常被清理工具删掉，所以不能只靠它）
  try {
    const ad = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent', 'AutomaticDestinations');
    for (const n of fs.readdirSync(ad)) {
      if (!/\.automaticDestinations-ms$/i.test(n)) continue;
      let buf = null;
      try { buf = fs.readFileSync(path.join(ad, n)); } catch (e) { continue; }
      const m = buf.toString('utf16le').match(/[A-Za-z]:\\[^\u0000-\u001f]{2,180}/g) || [];
      for (const s of m) add(s, '资源管理器最近');
    }
  } catch (e) { warnOnce("main", e) }
  // ② 补充：%APPDATA%\…\Recent\*.lnk（系统开着"显示最近使用的文件"时才有）
  try {
    const rd = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent');
    for (const n of fs.readdirSync(rd)) {
      if (!/\.lnk$/i.test(n)) continue;
      add(topbarLnkTarget(path.join(rd, n)), '最近使用');
    }
  } catch (e) { warnOnce("main", e) }
  // ③ 补充：地址栏里敲过的路径（注册表 TypedPaths，reg.exe 查一次，几十毫秒）
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\TypedPaths'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
      const m = line.match(/REG_SZ\s+(.+)$/);
      if (m) add(m[1], '地址栏敲过');
    }
  } catch (e) { warnOnce("main", e) }
  // 排序：按**文件夹自己的最后修改时间**从新到旧（跳转列表里没有时间戳，这是最接近"最近用过"的可靠口径）
  const rows = Array.from(cands.values()).sort((a, b) => b.at - a.at).slice(0, want);
  topbarRecentCache = { at: now, rows };
  return rows;
}
ipcMain.handle('topbar:recent-folders', () => {
  try { return { ok: true, at: Date.now(), rows: topbarRecentFolders(6) }; }
  catch (e) { return { ok: false, rows: [], error: String((e && e.message) || e) }; }
});

// ① 上下文压力：跑 ctx.mjs --panels --json（名册里的 10 面板 + 5 帮手；只回传渲染层要的字段）
//   ⛔ 必须走异步版：spawnSync 会把主进程连整个窗口一起卡住（实测 0.3s/次 × 每 90s 一次）
// 2026-10-19（宿主）：「负载胶囊」取数 —— CPU% 用 os.cpus() 差值（零子进程），GPU 用 nvidia-smi 一次读数（约 40ms）。
//   ★ 资源纪律：渲染层只在**窗口有焦点**时每 5 秒调一次 ⇒ 不在前台时这个 IPC 一次都不跑（不额外养进程/定时器）。
let __loadCpuPrev = null;
function loadCpuPercent() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  const prev = __loadCpuPrev;
  __loadCpuPrev = { idle, total };
  if (!prev) return null;                       // 第一次没有差值可算 ⇒ 返回 null，下次就有了
  const di = idle - prev.idle, dt = total - prev.total;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : null;
}
function nvidiaSmiOnce() {
  return new Promise((resolve) => {
    const exe = 'C:\\Windows\\System32\\nvidia-smi.exe';
    let out = '', done = false, cp = null;
    try { cp = spawn(exe, ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true }); }
    catch (e) { return resolve(null); }
    const t = setTimeout(() => { try { cp.kill(); } catch (e) { warnOnce("main", e) } if (!done) { done = true; resolve(null); } }, 3000);
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', () => { /* 没 N 卡会往 stderr 写，忽略 */ });
    cp.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    cp.on('close', () => { if (done) return; done = true; clearTimeout(t); resolve(out); });
  });
}
ipcMain.handle('kun:sys:load', async () => {
  const out = { ok: true, at: Date.now(), cpu: null, gpu: null };
  try { out.cpu = loadCpuPercent(); } catch (e) { warnOnce("main", e) }
  // 2026-10-20（宿主：顶栏加内存）—— os.totalmem/freemem ⇒ 已用百分比 + GB（零子进程）
  try {
    const tot = os.totalmem(), free = os.freemem();
    out.mem = { usedPct: Math.round((1 - free / tot) * 100), usedGB: Math.round((tot - free) / 1073741824 * 10) / 10, totalGB: Math.round(tot / 1073741824 * 10) / 10 };
  } catch (e) { warnOnce("main", e) }
  try {
    const raw = await nvidiaSmiOnce();
    if (raw) {
      const p = String(raw).trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
      if (p.length >= 5 && p[1] !== '' && !isNaN(Number(p[1]))) {
        out.gpu = { name: p[0], util: Number(p[1]), temp: Number(p[2]), memUsed: Number(p[3]), memTotal: Number(p[4]) };
      }
    }
  } catch (e) { warnOnce("main", e) }
  return out;
});
// ==========================================================================================
// 2026-10-20（宿主：把常用网站的"智能抠图"做成**本地**工具）—— 本地 rembg，图片不出本机。
//   引擎在 <工作台>\工具\抠图\venv（Python + rembg + onnxruntime CPU），模型放同目录 models（U2NET_HOME）。
//   ⚠ 这两条在主进程 ⇒ 加完要**重启一次工作台**才会出现（渲染层会先显示"要重启"提示，不会白屏）。
//   资源纪律：跑一张图起一次进程，算完就退（不常驻）；模型只在第一次用时下载。
// ==========================================================================================
/* 开源版：本地抠图（IPC + Python 引擎）已移除 */
;
ipcMain.handle('topbar:pressure', async () => {
  // 2026-10-16 23:3x 按 dg-dsh 派单：取数由 --all 改成 **--panels** ——
  //   --all 有门控（只列 ≥60%），低压力会话被藏起来 ⇒ 面板/帮手匹配不上，只能显示 —；
  //   --panels 固定列 10 个面板 + 5 个帮手（不管压力高低），且带 role/panel/scene/noData/belowGate。
  const r = await topbarRunAsync(TOPBAR_CTX, ['--panels', '--json'], 120000);
  if (!r.ok) return { ok: false, error: String(r.out).slice(0, 300), rows: [], total: 0, at: Date.now() };
  let arr = null;
  try { arr = JSON.parse(r.out); } catch (e) { return { ok: false, error: 'JSON 解析失败: ' + e.message, rows: [], total: 0, at: Date.now() }; }
  if (!Array.isArray(arr)) return { ok: false, error: 'ctx.mjs 返回的不是数组', rows: [], total: 0, at: Date.now() };
  const map = new Map();
  for (const m of topbarWorkbenchSessions()) map.set(m.sessionId, m);
  // 2026-10-16 晚（按 dg-dsh 的嵌套合同）：{version,note,updated,scenes:[{scene,sceneName,panel,bossSessionId,helpers:[{title,sessionId,since,handover,note}]}]}
  //   ⛔ 不是数组、也不是顶层 {helpers:[…]}。容错：缺 scenes 但有顶层 helpers ⇒ 退化成扁平 + 留一行警告。
  const helperIds = new Set();
  const helperMeta = new Map();
  try {
    const hf = path.join(SHELL_DATA_DIR, '助手会话.json');
    if (fs.existsSync(hf)) {
      const hj = JSON.parse(fs.readFileSync(hf, 'utf8'));
      const scenes = Array.isArray(hj && hj.scenes) ? hj.scenes : null;
      const addOne = (h, sceneId, sceneName, panel) => {
        if (!h) return;
        const sid = String(h.sessionId || h.id || '');
        if (!sid) return;
        helperIds.add(sid);
        helperMeta.set(sid, { sceneId: sceneId || '', sceneName: sceneName || '', panel: panel || '',
          title: h.title || h.name || '', since: h.since || '', note: h.note || '' });
      };
      if (scenes) {
        for (const s of scenes) {
          if (!s) continue;
          const sName = s.sceneName || s.scene || '';
          for (const h of (Array.isArray(s.helpers) ? s.helpers : [])) addOne(h, s.scene || '', sName, s.panel || '');
        }
      } else if (Array.isArray(hj && hj.helpers)) {
        log('[助手会话] ⚠ 登记表缺 scenes ⇒ 退化成顶层 helpers 扁平读法（建议用 助手会话.mjs 重写一遍）');
        for (const h of hj.helpers) addOne(h, h.scene || '', h.sceneName || h.scene || '', h.panel || '');
      }
    }
  } catch (e) { log('[助手会话] 登记表读不动：' + ((e && e.message) || e)); }
  const rows = [];
  const seen = new Set();
  for (const x of arr) {
    if (!x || !x.fullId) continue;
    const m = map.get(x.fullId);
    if (!m) continue;                       // 只列工作台自己的会话（全机还有几十条别的）
    seen.add(x.fullId);
    rows.push({
      id: x.id, fullId: x.fullId, title: x.title || '',
      pct: (x.pct === null || x.pct === undefined) ? null : (x.pct || 0),   // noData ⇒ null ⇒ 渲染成 —（别假 0%）
      noData: !!x.noData, belowGate: !!x.belowGate, line: x.line || 0, win: x.win || 0,
      projected: x.projected || 0, turns: x.turns || 0, model: x.model || '', scene: m.scene, panel: m.panel
    });
  }
  rows.sort((a, b) => ((b.pct == null ? -1 : b.pct) - (a.pct == null ? -1 : a.pct)));   // 有数据的在前，—的沉底
  // ctx.mjs 只列"有 projcache 数据"的会话 ⇒ 从没用过/刚建的新会话可能不在里面；明确报出来，别让它静默消失
  const missing = [];
  for (const m of map.values()) if (!seen.has(m.sessionId)) missing.push({ scene: m.scene, panel: m.panel });
  // ① 登记表里的**每一行都要出**（哪怕引擎还没给它建用量数据）⇒ pct 取不到就给 null，渲染成 "—"
  const helpers = [];
  const byId = new Map();
  for (const x of arr) if (x && x.fullId) byId.set(String(x.fullId), x);
  for (const [sid, m] of helperMeta) {
    const x = byId.get(sid) || null;
    helpers.push({
      id: x ? x.id : '', fullId: sid, title: m.title || (x && x.title) || '',
      sceneId: m.sceneId || '', sceneName: m.sceneName || '', panel: m.panel || '',
      since: m.since || '', note: m.note || '',
      pct: x ? (x.pct || 0) : null, line: x ? (x.line || 0) : 0,
      projected: x ? (x.projected || 0) : 0, turns: x ? (x.turns || 0) : 0, model: x ? (x.model || '') : ''
    });
  }  return { ok: true, at: Date.now(), rows, total: arr.length, mine: map.size, missing, helpers, helperReg: helperIds.size };
});

// ---- 会话用量（2026-11-11）----
// 数据面在 用量.js（读引擎投影缓存，算上下文 / 每步重发 / 重放率 / 分档），这里只接 IPC。
// 为什么要它：2026-11-11 统计出 6 条会话一天烧 2.95 亿 token、99.3% 是每一步重读历史；
//   而顶栏的「压力」胶囊 2026-10-23 已按用户要求删掉，之后没有任何地方能看见「这条会话有多贵」。
// 只读：不写场景、不碰会话；越线提示由渲染层 用量面板.js 负责。
const usageSvc = require('./用量').createService({
  scenariosDir: SCENARIOS_DIR,
  dshHome: DSH_HOME,
  fsx: {
    readText: function (p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
    readDir: function (p) { try { return fs.readdirSync(p); } catch (e) { return []; } },
    exists: function (p) { try { return fs.existsSync(p); } catch (e) { return false; } }
  }
});
ipcMain.handle('usage:list', () => usageSvc.list());

// ---- 社交场景「消息流」（2026-11-13）----
// 数据面在 社交.js（读社交会话的 transcript + 探 OneBot 3000/3001 + 看两个 IM 插件装没装），这里只接 IPC。
// 为什么要它：通道（协议端 / dsh-im 凭据）是别人的活，但**在面板里看得见**是本工作台的活 ——
//   没有这一格，社交场景只剩一个 AI 对话框，用户说的「割裂感」就在这里。
// 只读：不写会话、不改场景、不启停引擎；通道没通就诚实地显示没通，渲染层不许把它画成绿的。
const socialService = socialSvc.createService({ dshHome: DSH_HOME });
ipcMain.handle('social:flow', (e, args) => socialService.flow(args || {}));

// ---- 通用社交回复策略（2026-11-19）----
// 微信 / QQ / 飞书共用一套语气、emoji、表情包频率；通道只声明能力，不各装一套开关。
// 这里读写的是 外壳\data\社交回复.json；DSH_HOME 显式传入，避免主进程环境变量
// 只给引擎子进程设了 DSH_HOME、外壳自己读不到镜像路径。
const socialReplySvc = require('./社交回复');
ipcMain.handle('social:reply-policy-get', () => socialReplySvc.settingsGet(DSH_HOME));
ipcMain.handle('social:reply-policy-save', (e, patch) => socialReplySvc.settingsSave(patch || {}, DSH_HOME));

// ---- QQ 私聊 / 群聊独立会话（2026-11-19）----
// 用户原话：QQ 也要私聊群聊独立会话，不然会串数据。这里只改 Q 桥接的 routes，
// 建会话走 建会话.mjs；写配置优先走插件 /api/qq-bridge/save 热生效，失败才落文件等重启。
const qqChatService = qqChatSvc.createService({
  dshHome: DSH_HOME,
  scenariosDir: SCENARIOS_DIR,
  base: BASE,
  getToken: function () { return harnessToken; },
  env: function (extra) { return scriptEnv(extra); },
  log: log
});
ipcMain.handle('qq-chat:status', () => qqChatService.status());
ipcMain.handle('qq-chat:ensure', () => qqChatService.ensureAll());
ipcMain.handle('qq-chat:add', (e, args) => qqChatService.add(args || {}));
ipcMain.handle('qq-chat:remove', (e, args) => qqChatService.remove(args || {}));
ipcMain.handle('qq-chat:contacts', () => qqChatService.contacts());

// ---- QQ 媒体能力（2026-11-19）----
// 语音转写 / 语音合成统一在这里；不写进 dsh-onebot-channel，
// 插件升级不会被覆盖，群聊随机接话和 QQ 卡片共用同一份状态。
const qqMediaService = qqMediaSvc.createService({ dshHome: DSH_HOME, log: log });
ipcMain.handle('qq-media:status', () => qqMediaService.status());
ipcMain.handle('qq-media:settings-save', (e, patch) => qqMediaService.settingsSave(patch || {}));
ipcMain.handle('qq-media:tts-test', (e, args) => qqMediaService.synthesizeVoice(String((args && args.text) || '').slice(0, 200)));

// ---- QQ 群聊旁听 / 随机接话（2026-11-19）----
// 普通 @ 仍由 dsh-onebot-channel 走原路由；这里只旁听没被 @ 的群消息，
// 按概率和闸门决定是否在那个群的独立 DSH 会话里生成一句，再用 OneBot 发出去。
const qqGroupService = qqGroupSvc.createService({
  dshHome: DSH_HOME,
  base: BASE,
  getToken: function () { return harnessToken; },
  media: qqMediaService,
  // 外发闸门在下方创建（outGateService）；这里延迟取，群消息发送时它一定已就绪。
  gate: {
    sendGroupText: function (groupId, text) { return outGateService.sendQqGroupText(groupId, text); },
    sendGroupMessage: function (groupId, parts) { return outGateService.sendQqGroupMessage(groupId, parts); }
  },
  log: log
});
ipcMain.handle('qq-group:status', () => qqGroupService.statusGet());
ipcMain.handle('qq-group:settings-get', () => qqGroupService.settingsGet());
ipcMain.handle('qq-group:settings-save', (e, patch) => qqGroupService.settingsSave(patch || {}));
ipcMain.handle('qq-group:refresh', () => qqGroupService.refreshGroups());

// ---- 聊天长期档案（2026-11-19）----
// 数据面在 社交档案.js：读 SnowLuma 的 messages.db（只读），写 引擎数据\.dsh\社交档案\chat-archive.db。
// 普通闲聊不查；只有 DSH 工具在「昨天/上次/谁说过/原话」这类历史意图时按需查。
// 不含任何发送动作；同步失败把原因写进状态，面板显示红项，不静默当「没消息」。
const chatArchiveService = chatArchiveSvc.createService({
  dshHome: DSH_HOME,
  log: log
});
ipcMain.handle('archive:status', () => chatArchiveService.statusGet());
ipcMain.handle('archive:settings-get', () => chatArchiveService.settingsGet());
ipcMain.handle('archive:settings-save', (e, patch) => chatArchiveService.settingsSave(patch || {}));
ipcMain.handle('archive:sync', () => chatArchiveService.syncOnce('manual'));
ipcMain.handle('archive:chats', () => chatArchiveService.listChats());
ipcMain.handle('archive:recent', (e, args) => chatArchiveService.recent(args || {}));
ipcMain.handle('archive:search', (e, args) => chatArchiveService.search(args || {}));
ipcMain.handle('archive:quote', (e, args) => chatArchiveService.quote(args || {}));
ipcMain.handle('archive:daily', (e, args) => chatArchiveService.daily(args || {}));
ipcMain.handle('archive:memories', (e, args) => chatArchiveService.memories(args || {}));
ipcMain.handle('archive:memory-add', (e, args) => chatArchiveService.memoryAdd(args || {}));

// 关系与情绪：面板是唯一人工入口；所有写操作都落 外壳\data\，并同步镜像给 DSH 插件。
// 出错返回 { ok:false, error }，不 throw；面板用顶栏 toast 报，不静默。
function socialSafe(fn, args) {
  try {
    const out = fn(args || {});
    return out && typeof out.then === 'function' ? out : Promise.resolve(out);
  } catch (e) {
    return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
  }
}
ipcMain.handle('social:relation-get', () => socialSafe(() => socialStateSvc.inspect()));
ipcMain.handle('social:relation-save-person', (e, args) => socialSafe(() => socialStateSvc.savePerson(args || {}), args));
ipcMain.handle('social:relation-reset-person', (e, args) => socialSafe(() => socialStateSvc.resetPerson(args || {}), args));
ipcMain.handle('social:relation-config-save', (e, args) => socialSafe(() => socialStateSvc.saveConfig(args || {}), args));
ipcMain.handle('social:relation-seed', (e, args) => socialSafe(() => socialStateSvc.seedFromArchive(args || {}), args));
ipcMain.handle('social:relation-patrol', () => socialSafe(() => socialStateSvc.patrol()));
ipcMain.handle('social:relation-preview', (e, args) => socialSafe(() => socialStateSvc.preview(args || {}), args));
ipcMain.handle('social:mood-set', (e, args) => socialSafe(() => socialStateSvc.setMood(args || {}), args));
ipcMain.handle('social:mood-reset', () => socialSafe(() => socialStateSvc.resetMood()));

// ---- 社交消息流的视图偏好（2026-11-17）----
// 只存两个值：时间范围（today/7/30/all）+ 归档游标（毫秒）。为什么放主进程 userData：
//   localStorage 可能被清理软件连带清掉；这里丢了也只是回默认，不影响消息源（transcript 只读）。
// 不引入 SQLite：消息缓存是进程内派生数据，重启重算一次即可，这点量级用不着数据库。
const SOCIAL_RANGES = ['today', '7', '30', 'all'];
function socialViewFile() { return path.join(app.getPath('userData'), 'social-view.json'); }
function readSocialView() {
  const def = { range: '7', archivedBefore: 0, exists: false };
  try {
    const o = JSON.parse(fs.readFileSync(socialViewFile(), 'utf8'));
    return {
      range: SOCIAL_RANGES.indexOf(o.range) >= 0 ? o.range : '7',
      archivedBefore: Number.isFinite(Number(o.archivedBefore)) ? Math.max(0, Number(o.archivedBefore)) : 0,
      exists: true
    };
  } catch (e) {
    if (e && e.code !== 'ENOENT') warnOnce('main', e);   // 文件不存在是正常态（第一次跑）
    return def;
  }
}
function writeSocialView(patch) {
  const cur = readSocialView();
  const p = patch || {};
  const next = {
    range: SOCIAL_RANGES.indexOf(p.range) >= 0 ? p.range : cur.range,
    archivedBefore: p.archivedBefore !== undefined && Number.isFinite(Number(p.archivedBefore))
      ? Math.max(0, Number(p.archivedBefore)) : cur.archivedBefore
  };
  try {
    fs.mkdirSync(path.dirname(socialViewFile()), { recursive: true });
    fs.writeFileSync(socialViewFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (e) { warnOnce('main', e); }
  return Object.assign({}, next, { exists: true });
}
ipcMain.handle('social:view-get', () => readSocialView());
ipcMain.handle('social:view-set', (e, patch) => writeSocialView(patch));

// ---- QQ 个人号桥接（SnowLuma，2026-11-13）----
// 用户要求：随工作台一起启动、省掉单独启动；控制台不常驻面板，由「社交」场景里的齿轮按钮按需开窗。
// 生命周期归壳（和引擎同一条规矩）：壳退出时把子进程一起收掉，不在壳外单开一只。
// 只读状态 + 两个动作：status / start / stop；协议本身（QQ 注入、OneBot 端口）在 SnowLuma 控制台里配。
// 2026-11-19：注入不再交给 SnowLuma 的「全量 autoLoad」，由本壳按 QQ 号挑（bridge:qq-autoload-*）。
const bridgeService = bridgeSvc.createService();
ipcMain.handle('bridge:snowluma-status', () => bridgeService.status());
ipcMain.handle('bridge:snowluma-start', () => bridgeService.start());
ipcMain.handle('bridge:snowluma-stop', () => bridgeService.stop());
ipcMain.handle('bridge:qq-autoload-status', () => bridgeService.qqAutoLoadStatus());
ipcMain.handle('bridge:qq-autoload-set', (e, patch) => bridgeService.qqAutoLoadSet(patch));

// ---- 外发安全闸门（2026-11-18）----
// 用户要求：只写提示词不够，要有机制；机制要可配置。落位：
//   · 判定唯一出处：外壳\外发闸门.js（工具\外发闸门.mjs 只是命令行壳）
//   · QQ：本机代理 3100 → SnowLuma 的 OneBot HTTP；把插件 onebotHttp 指过来，发送必经这里
//   · 微信：createService 时把 gate 注入微信通道，_reply() 返回正文前过闸
//   · 飞书：dsh-im 直连云端，出站不可拦，开关默认关；接线前要先换成自己的发送器
// 生命周期归壳：起代理 / 退出收掉；代理起不来写日志 + 状态给面板（不许静默当没事）。
const outGateService = outGateSvc.createService({
  dshHome: DSH_HOME,
  base: BASE,
  getToken: function () { return harnessToken; },
  media: qqMediaService,
  log: log
});
ipcMain.handle('outbound:get', () => outGateService.getSettings());
ipcMain.handle('outbound:set', (e, patch) => outGateService.saveSettings(patch || {}));
ipcMain.handle('outbound:status', () => outGateService.status());
ipcMain.handle('outbound:audit', (e, n) => ({ ok: true, rows: outGateService.auditTail(n) }));
ipcMain.handle('outbound:assets-refresh', () => outGateService.refreshAssets());
ipcMain.handle('outbound:qq-apply', () => outGateService.applyQqProxy());
ipcMain.handle('outbound:qq-restore', () => outGateService.restoreQqProxy());
ipcMain.handle('outbound:selfcheck', () => outGateService.selfCheck());
ipcMain.handle('outbound:test', (e, args) => {
  const a = args || {};
  const r = outGateService.testText(String(a.text || ''), String(a.channel || 'qq'));
  return { ok: true, result: r };
});
ipcMain.handle('outbound:open-dir', function () {
  const dir = path.join(SHELL_DATA_DIR, '安全闸门');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { warnOnce('outbound', e); }
  try { shell.openPath(dir); } catch (e) { warnOnce('outbound', e); }
  return { ok: true, dir: dir };
});

// ---- 微信个人号通道（whale_girl，2026-11-18）----
// 定位：鲸鲸只做微信收发，回复由 DSH「胡闹的大肥鱼」会话生成（换脑插件把消息转到 31241 适配器）。
// 生命周期归壳：start 拉起鲸鲸内核/桥接/适配器，stop 只杀自己拉起的子进程；外部已起的实例只复用、不杀。
// 状态与自检走 IPC；社交卡片读 外壳\data\微信通道\状态.json（10 秒刷新）画「通/待/无」。
const wechatService = wechatSvc.createService({
  dshHome: DSH_HOME,
  base: BASE,
  getToken: function () { return harnessToken; },
  gate: outGateService,
  // 微信入站/出站都写聊天档案；档案故障只记日志，不影响回消息。
  archive: function (msg) {
    try { return chatArchiveService.archiveWechat(msg); } catch (e) { log('[wechat] 档案写入异常：' + ((e && e.message) || e)); return null; }
  },
  log: log
});
ipcMain.handle('wechat:status', () => wechatService.status());
ipcMain.handle('wechat:start', () => wechatService.start());
ipcMain.handle('wechat:stop', () => wechatService.stop());
ipcMain.handle('wechat:selfcheck', () => wechatService.selfCheck());
ipcMain.handle('wechat:send-test', (e, args) => wechatService.sendTest(args || {}));
ipcMain.handle('wechat:pin-account', (e, args) => wechatService.pinAccount(args || {}));
ipcMain.handle('wechat:settings-get', () => wechatService.settingsGet());
ipcMain.handle('wechat:settings-save', (e, args) => wechatService.saveSettings(args || {}));
// QQ 卡片里的「语音合成服务」是全局唯一真源；这个 IPC 只把它同步到 WhaleLauncher，
// 渲染层不持有完整 Key，主进程内部取 qqMediaService 的配置后直接落盘。
ipcMain.handle('wechat:sync-breeze', () => wechatService.syncBreeze(qqMediaService.breezeConfig()));
ipcMain.handle('wechat:vision-test', () => wechatService.visionTest());
ipcMain.handle('wechat:sticker-generate', (e, args) => wechatService.stickerGenerate(args || {}));
ipcMain.handle('wechat:sticker-send', (e, args) => wechatService.stickerSend(args || {}));
ipcMain.handle('wechat:moments-read', (e, args) => wechatService.momentsRead(args || {}));
ipcMain.handle('wechat:moments-action', (e, args) => wechatService.momentsAction(args || {}));
ipcMain.handle('wechat:moments-result', (e, args) => wechatService.momentsResult((args && args.id) || ''));
ipcMain.handle('wechat:moments-snapshot', () => wechatService.momentsSnapshot());
ipcMain.handle('wechat:diary-generate', () => wechatService.diaryGenerate());
ipcMain.handle('wechat:diary-read', () => wechatService.diaryRead());
ipcMain.handle('wechat:reminders-list', () => wechatService.remindersList());
ipcMain.handle('wechat:reminder-cancel', (e, args) => wechatService.reminderCancel((args && args.id) || ''));
ipcMain.handle('clipboard:write', (e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
ipcMain.handle('shell:open-path', async (e, p) => {
  const target = String(p || '');
  if (!target) return { ok: false, error: '空路径' };
  try {
    if (/^https?:/i.test(target)) { shell.openExternal(target); return { ok: true }; }
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (ex) { return { ok: false, error: String((ex && ex.message) || ex) }; }
});

// ---- 桌宠设置（胡闹的大肥鱼，2026-11-13）----
// 用户要求：桌宠不是一堆散文件，要有一个可看可改的面板。参数落在 外壳\data\pet\设置.json（本机不入库），
//   默认值在 外壳\pet\设置.默认.json；这里只做读写 + 展示最近派发记录，不碰引擎、不启停通道。
ipcMain.handle('pet:settings-get', () => ({
  settings: petSvc.getSettings(),
  files: { 默认值: petSvc.DEFAULT_FILE, 运行值: petSvc.DATA_FILE },
  session: petSvc.petSession(),
  stats: petSvc.personaStats(),      // 人格卡现状：记了多少条、待办几件、开场注入多大
  scenes: petSvc.listScenes()      // 设置弹窗「派给谁」下拉用：真实存在的场景会话，别手写标题
}));
ipcMain.handle('pet:settings-set', (e, patch) => {
  const r = petSvc.setSettings(patch || {});
  // 形象开关保存后即时生效：停用就清定时器，换 base/pet 就重连；不用重启整壳
  if (r && r.ok && patch && patch.body !== undefined) {
    try { restartPetBodyBridge(); } catch (e2) { warnOnce('pet-body-restart', e2); }
  }
  return r;
});
ipcMain.handle('pet:log-tail', (e, n) => ({ file: petSvc.logPath(), rows: petSvc.tailLog(n) }));
// 桌面身体（dsh-pet）的只读状态：设置弹窗里能看到「插件在不在 / 上一帧推了什么 / 为什么没生效」。
ipcMain.handle('pet:body-status', () => ({
  ...(petBodyClient ? petBodyClient.state() : { base: '', pet: '', available: null, lastState: '', lastTask: '', lastError: '' }),
  timer: !!petBodyTimer,
  settings: ((petSvc.getSettings() || {}).body) || {},
}));
// 手动说一句：只搬运文本，不生成；用于设置弹窗的「试一下」和以后审批提醒。
ipcMain.handle('pet:body-say', (e, args) => {
  if (!petBodyClient) return { ok: false, reason: '未启动（body.enabled=false 或引擎未就绪）' };
  return petBodyClient.say(String((args && args.text) || ''), args || {});
});
// 语音：dsh-pet 自带 TTS 的开关与音色。BreezeBlue 的 key 在 QQ 能力里，暂不混进这里，
// 避免工作台语音和 QQ 语音共用一份配置、互相覆盖。
ipcMain.handle('pet:voice-get', async () => {
  if (!petBodyClient) return { ok: false, reason: '桌面身体未启动', voice: null };
  try { return await petBodyClient.getVoice(); } catch (e) { return { ok: false, reason: String((e && e.message) || e), voice: null }; }
});
ipcMain.handle('pet:voice-set', async (e, args) => {
  if (!petBodyClient) return { ok: false, reason: '桌面身体未启动' };
  try { return await petBodyClient.setVoice(args || {}); } catch (e2) { return { ok: false, reason: String((e2 && e2.message) || e2) }; }
});
// 语音试听：走 dsh-pet 的 broadcast + speak，让它用自己的 TTS 念一句（不改人格、不生成内容）。
ipcMain.handle('pet:voice-test', async (e, args) => {
  if (!petBodyClient) return { ok: false, reason: '桌面身体未启动' };
  const text = String((args && args.text) || '我是大肥鱼，语音已经接上了。').slice(0, 100);
  try { return await petBodyClient.say(text, { duration: 12000, anim: true, speak: true }); }
  catch (e2) { return { ok: false, reason: String((e2 && e2.message) || e2) }; }
});

// ② 谁在等我：共用定位卡 §六 未办结行 + 各场景记忆 §〇 的「卡点」+ 桌宠待办
ipcMain.handle('topbar:pending', async () => {
  const items = [];
  try {
    const t = fs.readFileSync(TOPBAR_CARD, 'utf8');
    const after = t.split(/\n##\s*六、/)[1];
    const seg = after ? after.split(/\n##\s*七、/)[0] : '';
    for (const line of seg.split(/\r?\n/)) {
      const s = line.trim();
      if (s.charAt(0) !== '|') continue;
      const cells = s.split('|').map((x) => x.trim()).filter((x) => x.length);
      if (cells.length < 4) continue;
      if (/^-+$/.test(cells[0]) || cells[0] === '日期') continue;   // 分隔行与表头行都不算待办
      const status = cells[cells.length - 1];
      if (/^✅/.test(status) || /已办结|已关闭|不用做/.test(status)) continue;   // 只留"真的还没办"的
      items.push({
        kind: 'card', date: cells[0], from: cells[1], status,
        text: cells[2].replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 220), file: TOPBAR_CARD
      });
    }
  } catch (e) { warnOnce("main", e) }
  try {
    for (const d of fs.readdirSync(TOPBAR_MEM)) {
      const f = path.join(TOPBAR_MEM, d, '项目信息.md');
      if (!fs.existsSync(f)) continue;
      let head = '';
      try {
        const fd = fs.openSync(f, 'r');
        const b = Buffer.alloc(12000);
        const n = fs.readSync(fd, b, 0, b.length, 0);
        fs.closeSync(fd);
        head = b.slice(0, n).toString('utf8');
      } catch (e) { continue; }
      const m = head.match(/卡点[：:]\s*([^\n\r]{2,200})/);
      if (m) items.push({ kind: 'scene', date: '', from: d, status: '卡点', text: m[1].replace(/\*\*/g, '').trim(), file: f });
    }
  } catch (e) { warnOnce("main", e) }
  // ③ 桌宠待办：dsh-pet 的 /todos 是唯一真源；只取未办结的，显示在顶栏「待办」弹层
  if (petBodyClient) {
    try {
      const tr = await petBodyClient.todos();
      if (tr && tr.ok && Array.isArray(tr.todos)) {
        for (const t of tr.todos) {
          if (!t || t.done) continue;
          const text = String(t.text || '').replace(/\s+/g, ' ').slice(0, 220);
          if (!text) continue;
          items.push({
            kind: 'pet-todo', id: String(t.id || ''), date: t.dueAt ? new Date(Number(t.dueAt)).toISOString().slice(0, 10) : '',
            from: '桌宠', status: '未办', text, file: '', dueAt: t.dueAt || null
          });
        }
      }
    } catch (e) { warnOnce('pet-todos', e); }
  }
  return { ok: true, at: Date.now(), items };
});

// ②.1 桌宠待办写操作：列表 / 新增 / 办结 / 删除；写操作成功后让顶栏自己刷新
ipcMain.handle('topbar:pet-todo', async (e, args) => {
  if (!petBodyClient) return { ok: false, error: '桌面身体未启动（设置里启用后才会接待办）' };
  const a = args || {};
  const op = String(a.op || '');
  try {
    if (op === 'add') return await petBodyClient.todoAdd(String(a.text || ''));
    if (op === 'toggle') return await petBodyClient.todoToggle(String(a.id || ''), !!a.done);
    if (op === 'remove') return await petBodyClient.todoRemove(String(a.id || ''));
    if (op === 'list') return await petBodyClient.todos();
    return { ok: false, error: 'unknown-op' };
  } catch (e2) { return { ok: false, error: String((e2 && e2.message) || e2) }; }
});

// ③ 快照：列最近 12 份 / 立即打一份 / 回滚到指定那份（回滚前弹原生确认框）
ipcMain.handle('topbar:snapshots', () => {
  try {
    const names = fs.readdirSync(TOPBAR_BK)
      .filter((n) => n.indexOf('gui-') === 0 && fs.statSync(path.join(TOPBAR_BK, n)).isDirectory());
    const rows = names.map((n) => ({ name: n, at: fs.statSync(path.join(TOPBAR_BK, n)).mtimeMs, pre: n.indexOf('gui-prerestore-') === 0 }))
      .sort((a, b) => b.at - a.at);
    return { ok: true, dir: TOPBAR_BK, rows: rows.slice(0, 5), total: rows.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), rows: [], total: 0, dir: TOPBAR_BK }; }
});
ipcMain.handle('topbar:snapshot', () => {
  const r = topbarRun(path.join(__dirname, 'scripts', 'backup-gui.mjs'), [], 180000);
  const out = String(r.out || '');
  const m = out.match(/快照完成[:：]\s*(.+)/);
  return { ok: r.ok, name: m ? m[1].trim() : null, error: r.ok ? null : out.slice(0, 300) };
});
ipcMain.handle('topbar:restore', (e, name) => {
  const n = String(name || '');
  if (!/^gui-[A-Za-z0-9._-]+$/.test(n)) return { ok: false, error: '快照名不合法' };
  if (!fs.existsSync(path.join(TOPBAR_BK, n))) return { ok: false, error: '找不到这个快照：' + n };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到这个界面', '取消'], defaultId: 1, cancelId: 1,
      title: '界面回退',
      message: '回到界面版本 ' + n + ' ？',
      detail: '只覆盖工作台的界面与脚本源码（main.js / preload.js / renderer\\ / scenarios\\ / scripts\\）。'
        + '回退前会先用当前界面记一份 gui-prerestore-*，还能再回来；不动数据和对话。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(path.join(__dirname, 'scripts', 'restore-gui.mjs'), [n], 240000);
  const tail = String(r.out || '').trim().split(/\r?\n/).slice(-5).join(' | ');
  return { ok: r.ok, error: r.ok ? null : tail.slice(0, 400), out: tail.slice(0, 600) };
});
ipcMain.handle('topbar:engine-status', () => {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(SHELL_DATA_DIR, 'engine-good', 'meta.json'), 'utf8'));
    return { ok: true, meta };
  } catch (e) { return { ok: false, error: '还没有“正常点”（先打一份）', meta: null }; }
});
ipcMain.handle('topbar:engine-snapshot', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  const r = topbarRun(tool, ['--save'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 500), error: r.ok ? null : String(r.out || '').slice(0, 300) };
});
ipcMain.handle('topbar:engine-restore', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到上次正常配置', '取消'], defaultId: 1, cancelId: 1,
      title: '引擎回退', message: '回到上次能正常启动的引擎配置？',
      detail: '只回退 17 个启动配置（cordis.patch.yml / settings / 插件接线），不碰源码与构建产物。\n'
        + '回退前会把当前配置另存到 data\\engine-good\\pre-restore-*。回退后请重启工作台。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(tool, ['--restore', '--yes'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 600), error: r.ok ? null : String(r.out || '').slice(0, 400) };
});
// ===== 2026-10-24（宿主）：「引擎回退也能记录，上限 5 份」 =====
// 工具（工具\引擎快照.mjs）早就支持多代（--list / --restore-gen），这里只把清单翻译成结构化数据给界面。
ipcMain.handle('topbar:engine-gens', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs', rows: [] };
  const r = topbarRun(tool, ['--list'], 20000);
  const rows = [];
  String(r.out || '').split(/\r?\n/).forEach((ln) => {
    // 形如：- gen-20261023175458 · 2026-10-23 17:54:58 · 引擎 0.2.1-rc.2 · HEAD 687f282e
    const m = ln.match(/^-\s*(gen-\d+)\s*·\s*([^·]*?)\s*·\s*引擎\s*([^·]*?)\s*·\s*HEAD\s*(\S*)/);
    if (m) rows.push({ gen: m[1].trim(), at: m[2].trim(), ver: m[3].trim(), head: m[4].trim() });
  });
  return { ok: r.ok, rows: rows.slice(0, 5), error: r.ok ? null : String(r.out || '').slice(0, 300) };
});
ipcMain.handle('topbar:engine-restore-gen', (e, gen) => {
  const g = String(gen || '');
  if (!/^gen-\d{8,}$/.test(g)) return { ok: false, error: '这一代的编号不合法：' + g };
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到这一代配置', '取消'], defaultId: 1, cancelId: 1,
      title: '引擎回退（指定代）',
      message: '回到引擎配置 ' + g + ' ？',
      detail: '只回退启动配置（不碰源码与构建产物）。\n回退前会把当前配置另存到 data\\engine-good\\pre-restore-*。\n回退后请重启工作台。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(tool, ['--restore-gen', g, '--yes'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 600), error: r.ok ? null : String(r.out || '').slice(0, 400) };
});

// ⑥ 环境适配（2026-11-12）：换机器 / 换盘符后的自检与自愈
//   跑 外壳\scripts\环境适配.mjs --json，把结构化结果交给顶栏「⋯ 更多 → 环境适配」渲染。
//   ⛔ 界面不给 --rotate：它会归档现有会话，只能由用户在命令行显式跑。
function envRun(mode) {
  const script = path.join(__dirname, 'scripts', '环境适配.mjs');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, rows: [], error: '找不到 外壳\\scripts\\环境适配.mjs' });
  const args = [(mode === 'apply' ? '--apply' : '--check'), '--json'];
  return topbarRunAsync(script, args, 180000).then((r) => {
    // 有 ✗ 时进程退出码为 1，但 stdout 里仍是完整 JSON ⇒ 从第一个 { 起解析
    const txt = String((r && r.out) || '');
    const i = txt.indexOf('{');
    if (i >= 0) {
      try {
        const j = JSON.parse(txt.slice(i));
        return { ok: !!j.ok, rows: Array.isArray(j.rows) ? j.rows : [], at: Date.now(), mode };
      } catch (e) { warnOnce("main", e) }
    }
    return { ok: false, rows: [], at: Date.now(), mode, error: txt.slice(0, 400) || '脚本没有输出' };
  });
}
ipcMain.handle('topbar:env-check', () => envRun('check'));
ipcMain.handle('topbar:env-apply', () => envRun('apply'));

// ⑥b 记忆包（2026-11-13）：顶栏「记忆包」胶囊 —— 打包/核对/恢复/升版 全走 工具\记忆打包.mjs。
//   包目录 = <工作台>\记忆包（.gitignore 已挡）；恢复是覆盖写，工具侧会先自动快照当前（可回滚）。
function memPkgTool() {
  const t = path.join(TOPBAR_ROOT, '工具', '记忆打包.mjs');
  return fs.existsSync(t) ? t : '';
}
// 列记忆包目录（记忆包-* 与 恢复前备份-*）；名字带时间戳 ⇒ 字典序即时间倒序
function memPkgList() {
  const dir = path.join(TOPBAR_ROOT, '记忆包');
  try {
    if (!fs.existsSync(dir)) return { ok: true, rows: [], dir };
    const rows = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (e.name.startsWith('记忆包-') || e.name.startsWith('恢复前备份-')))
      .map((e) => ({ name: e.name, kind: e.name.startsWith('恢复前备份-') ? 'backup' : 'pkg' }))
      .sort((a, b) => b.name.localeCompare(a.name));
    return { ok: true, rows, dir };
  } catch (e) { return { ok: false, rows: [], dir, error: String((e && e.message) || e) }; }
}
// 只允许「记忆包」目录下真实存在的目录名（空 = 最新一份包）；拒绝路径分隔与上级跳转，防路径穿越
function memPkgResolve(name) {
  const dir = path.join(TOPBAR_ROOT, '记忆包');
  const n = String(name || '');
  if (!n) {
    const p = (memPkgList().rows || []).find((x) => x.kind === 'pkg');
    return p ? path.join(dir, p.name) : '';
  }
  if (n.includes('\\') || n.includes('/') || n.includes('..')) return '';
  const t = path.join(dir, n);
  return fs.existsSync(t) ? t : '';
}
ipcMain.handle('topbar:mem-packages', () => memPkgList());
ipcMain.handle('topbar:mem-pack', () => {
  const tool = memPkgTool();
  if (!tool) return { ok: false, error: '找不到 工具\\记忆打包.mjs' };
  return topbarRunAsync(tool, ['打包'], 300000).then((r) => ({ ok: r.ok, out: String(r.out || '').slice(0, 800) }));
});
ipcMain.handle('topbar:mem-check', (e, name) => {
  const tool = memPkgTool();
  if (!tool) return { ok: false, error: '找不到 工具\\记忆打包.mjs' };
  const target = memPkgResolve(name);
  if (!target) return { ok: false, error: '还没有记忆包（先点「打包」），或找不到选中的包' };
  return topbarRunAsync(tool, ['核对', '--包', target], 300000).then((r) => ({ ok: r.ok, out: String(r.out || '').slice(0, 1200) }));
});
ipcMain.handle('topbar:mem-restore', (e, name) => {
  const tool = memPkgTool();
  if (!tool) return { ok: false, error: '找不到 工具\\记忆打包.mjs' };
  const target = memPkgResolve(name);
  if (!target) return { ok: false, error: '还没有记忆包（先点「打包」），或找不到选中的包' };
  return topbarRunAsync(tool, ['恢复', '--包', target], 300000).then((r) => ({ ok: r.ok, out: String(r.out || '').slice(0, 1200) }));
});
ipcMain.handle('topbar:mem-schema', () => {
  const tool = memPkgTool();
  if (!tool) return { ok: false, error: '找不到 工具\\记忆打包.mjs' };
  return topbarRunAsync(tool, ['升版'], 60000).then((r) => ({ ok: r.ok, out: String(r.out || '').slice(0, 400) }));
});

// ⑥c 引擎更新（2026-11-13）：查版本 → 下载装配 → 替换 → 回退
//   工具（工具\引擎更新.mjs）只认 registry 的 dist-tags，**不写死版本号**；官方以后怎么发版都走这一套。
//   ⛔ 替换必须停机：引擎整目录被运行中的 node 占着（Windows 文件锁）。所以「立即更新」的真实动作是：
//      起一个脱离 Electron 的子进程 → 主进程退出 → 子进程等端口释放 → 备份 → 换入 → 探活 → 把工作台拉起来。
//      子进程负责验收与自动回退，所以主进程退出不会把"半坏状态"留在盘上。
function updateScript() {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎更新.mjs');
  return fs.existsSync(tool) ? tool : '';
}
// 把脚本 stdout 里第一个 { 起的 JSON 翻成对象（退出码非 0 也翻，里面带 error）
function updateParse(r) {
  const txt = String((r && r.out) || '');
  const i = txt.indexOf('{');
  if (i < 0) return { ok: false, error: txt.slice(0, 600) || '脚本没有输出' };
  try {
    const j = JSON.parse(txt.slice(i));
    return { ok: !!j.ok, data: j.data || null, error: j.error || null };
  } catch (e) {
    return { ok: false, error: '脚本输出不是完整 JSON：' + txt.slice(0, 400) };
  }
}
function updateRun(args, timeout) {
  const tool = updateScript();
  if (!tool) return Promise.resolve({ ok: false, error: '找不到 工具\\引擎更新.mjs' });
  return topbarRunAsync(tool, args, timeout || 60000).then(updateParse);
}
// 脱离主进程跑 apply / rollback，然后自己退出——停机替换只能这么干
function updateSpawnDetached(args) {
  const node = resolveNodeExe();
  const env = Object.assign({}, process.env);
  let cmd = node;
  let full = args;
  if (!node) { env.ELECTRON_RUN_AS_NODE = '1'; cmd = process.execPath; }
  try {
    const cp = spawn(cmd, full, { cwd: TOPBAR_ROOT, detached: true, stdio: 'ignore', windowsHide: true, env });
    cp.unref();
  } catch (e) {
    return { ok: false, error: '起不来更新进程：' + String((e && e.message) || e) };
  }
  log('[update] 已切到停机更新，主进程准备退出');
  setTimeout(() => { try { app.quit(); } catch (e) { log('[update] quit 失败：' + e.message); } }, 700);
  return { ok: true, willRestart: true };
}
ipcMain.handle('topbar:update-status', () => updateRun(['status', '--json'], 30000));
ipcMain.handle('topbar:update-check', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎更新检查.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎更新检查.mjs' };
  return topbarRunAsync(tool, ['--json'], 120000).then((r) => {
    const txt = String((r && r.out) || '');
    const i = txt.indexOf('{');
    let j = null;
    if (i >= 0) { try { j = JSON.parse(txt.slice(i)); } catch (e) { j = null; } }
    if (!j) return { ok: false, error: txt.slice(0, 600) || '脚本没有输出' };
    return { ok: true, check: j };
  });
});
ipcMain.handle('topbar:update-prepare', (e, ver) => {
  const args = ['prepare', '--json'];
  if (ver) args.push('--version', String(ver));
  return updateRun(args, 900000);
});
function updateConfirm(title, message, detail, okText) {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = { type: 'warning', buttons: [okText, '取消'], defaultId: 1, cancelId: 1, title, message, detail };
    return (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (e) { return false; }
}
ipcMain.handle('topbar:update-apply', (e, ver) => {
  const tool = updateScript();
  if (!tool) return { ok: false, error: '找不到 工具\\引擎更新.mjs' };
  const go = updateConfirm('引擎更新', '换上新引擎并重启工作台？',
    '会先整目录备份当前引擎（约 500 MB），换入后跑环境适配与探活。\n任一步不合格会自动退回旧引擎，不会留下半坏状态。\n换的过程中工作台会关掉；验收通过会自动重新打开。', '现在就换（会关掉工作台）');
  if (!go) return { ok: false, error: '已取消' };
  const args = [tool, 'apply', '--json', '--wait', '150', '--then-start'];
  if (ver) args.push('--version', String(ver));
  return updateSpawnDetached(args);
});
ipcMain.handle('topbar:update-rollback', (e, name) => {
  const tool = updateScript();
  if (!tool) return { ok: false, error: '找不到 工具\\引擎更新.mjs' };
  const go = updateConfirm('引擎回退（换版本）', '回到 ' + (name ? String(name) : '最近一份备份') + ' ？',
    '会先把现在这份另存为 failed-*（不删），再把备份换回来，然后跑环境适配与探活。\n回退同样要停机，工作台会重开。', '现在回退（会关掉工作台）');
  if (!go) return { ok: false, error: '已取消' };
  const args = [tool, 'rollback', '--json', '--wait', '150', '--then-start'];
  if (name) args.push('--to', String(name));
  return updateSpawnDetached(args);
});
ipcMain.handle('topbar:update-clean', (e, keep) => updateRun(['clean', '--json', '--keep', String(keep || 2)], 60000));

// ⑥d 自动检查（2026-11-13）：查版本这件事归壳自己干，不依赖任何外部定时任务。
//   启动后 40 秒跑一次，之后每 6 小时看一眼；24 小时内查过的不重复联网（registry 没必要反复打）。
//   结果落 引擎更新/check.json（不入库）：界面展开「引擎更新」时先读它，所以不点按钮也知道有没有新版。
//   ⛔ 跟 ⑥c 一样只读：这里只跑检查脚本，不下载、不替换。
const UPDATE_CHECK_FILE = path.join(TOPBAR_ROOT, '引擎更新', 'check.json');
const UPDATE_CHECK_GAP = 24 * 3600 * 1000;
function updateReadCheck() {
  try {
    const j = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf8'));
    return { ok: true, check: j.check || null, at: j.at || 0 };
  } catch (e) {
    return { ok: false, error: '还没查过', check: null, at: 0 };
  }
}
function updateFetchCheck() {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎更新检查.mjs');
  if (!fs.existsSync(tool)) return Promise.resolve({ ok: false, error: '找不到 工具\\引擎更新检查.mjs' });
  return topbarRunAsync(tool, ['--json'], 120000).then((r) => {
    const txt = String((r && r.out) || '');
    const i = txt.indexOf('{');
    let j = null;
    if (i >= 0) { try { j = JSON.parse(txt.slice(i)); } catch (e) { j = null; } }
    if (!j) return { ok: false, error: txt.slice(0, 600) || '检查脚本没有输出' };
    const rec = { at: Date.now(), check: j };
    try {
      fs.mkdirSync(path.dirname(UPDATE_CHECK_FILE), { recursive: true });
      fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify(rec, null, 2), 'utf8');
    } catch (e) { log('[update] check.json 写不进去：' + e.message); }
    return { ok: true, cached: false, check: j, at: rec.at };
  });
}
function updateAutoCheck(force) {
  const last = updateReadCheck();
  if (!force && last.ok && (Date.now() - last.at) < UPDATE_CHECK_GAP) {
    return Promise.resolve({ ok: true, cached: true, check: last.check, at: last.at });
  }
  return updateFetchCheck();
}
ipcMain.handle('topbar:update-last', () => updateReadCheck());
ipcMain.handle('topbar:update-auto', (e, force) => updateAutoCheck(!!force));
setTimeout(() => { updateAutoCheck(false).catch(() => {}); }, 40000);
setInterval(() => { updateAutoCheck(false).catch(() => {}); }, 6 * 3600 * 1000);


// ===== 2026-10-24（宿主）：「升级中途不小心关闭 ⇒ 自动回滚到上次正常」 =====
// 每次启动先落一枚"这次开过、还没正常退出"的哨（clean:false）；正常退出时改写成 clean:true。
// 下次启动若发现上次 clean:false（崩溃 / 被强关 / 升级中途关掉），60 秒后探一次引擎：
//   · 引擎起来了  → 什么都不做；
//   · 引擎没起来 且 有"正常点" → 自动 引擎快照.mjs --restore --yes，并给界面推一条 toast。
// ⛔ 只回「启动配置」，不碰源码/构建产物（源码坏了要走 git，这个工具做不到，也不该自动做）。
const GUARD_FILE = path.join(SHELL_DATA_DIR, 'start-guard.json');
function readGuard() { try { return JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8')); } catch (e) { return null; } }
function writeGuard(obj) { try { fs.writeFileSync(GUARD_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8'); } catch (e) { warnOnce("main", e) } }
function engineLastGood() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(SHELL_DATA_DIR, 'engine-good', 'meta.json'), 'utf8'));
    return (m && m.savedAt) ? m : null;
  } catch (e) { return null; }
}
async function guardCheckAfterBoot() {
  const prev = readGuard();
  writeGuard({ clean: false, at: Date.now(), pid: process.pid, appVersion: app.getVersion(), note: '开机登记' });
  if (!prev || prev.clean !== false) return;                 // 上次是正常退出
  if (!autoMaintConfig().rollback.enabled) { log('[guard] 自动回滚已关，跳过'); return; }
  const good = engineLastGood();
  log('[guard] 上次没正常退出（' + (prev.at ? new Date(prev.at).toLocaleString() : '?') + '）⇒ 60 秒后查引擎');
  await sleep(60000);
  let up = false;
  try { up = await probe(); } catch (e) { up = false; }
  if (up) { log('[guard] 引擎正常，不做回退'); writeGuard({ clean: false, at: Date.now(), pid: process.pid, note: '引擎正常' }); return; }
  if (!good) { log('[guard] 引擎没起来，但还没有"正常点"，无法自动回退'); return; }
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  let ok = false;
  try {
    const r = topbarRun(tool, ['--restore', '--yes'], 120000);
    ok = !!(r && r.ok);
    log('[guard] 自动回退引擎配置 ' + (ok ? '成功' : '失败') + '：' + String((r && r.out) || '').slice(0, 200));
  } catch (e) { log('[guard] 自动回退异常：' + ((e && e.message) || e)); }
  writeGuard({ clean: false, at: Date.now(), pid: process.pid, autoRolledBack: { at: Date.now(), ok, to: good.savedAt } });
  try {
    broadcast('topbar:toast', {
      text: ok ? ('上次没正常退出、引擎也没起来 ⇒ 已自动回到 ' + good.savedAt + ' 的配置，请重启一次工作台')
               : '上次没正常退出、引擎也没起来，自动回退没成功 —— 看 server.log 或手动「引擎回退」',
      bad: !ok, ms: 20000
    });
  } catch (e2) { warnOnce("main", e2) }
}

// ---- 工具清单（2026-11-12 改为实时扫描：新增工具 = 引擎里多一个 dsh-tool-* 包，不再靠人维护 json）----
// 扫描逻辑在 外壳\工具清单.js（可脱离 Electron 单测：node 外壳\工具清单.js）：
//   ① 启用名单 = <引擎>\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml 里未 disabled 的 dsh-tool-* 行；
//   ② 中文名/说明 = 每个工具包自带 locale\zh.json 的 meta.title / meta.description；
//   ③ 兜底 = 包 package.json 的 description；装了但没在默认 profile 启用的包也列出并标「未启用」。
ipcMain.handle('tools:catalog', () => {
  // 1. 有手写清单就用它（需要人工「大白话补充」的场合；路径不变）
  // 2. 没有就实时扫描 —— 不再报 ENOENT，也不用人补 json（2026-11-12 用户质疑「为什么要维护」）
  const p = path.join(SHELL_DATA_DIR, '工具清单.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return { updated: null, groups: [], error: String((e && e.message) || e) }; }
  }
  try { return require('./工具清单').buildCatalog({ harnessDir: HARNESS_DIR, extraPatches: [path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')] }); }
  catch (e) { return { updated: null, groups: [], error: '扫描引擎工具包失败：' + String((e && e.message) || e) }; }
});

// ---- 功能台（2026-11-14）：把「只能命令行」的功能接出界面入口（场景「工作台控制台」）----
// 登记表与执行都在 外壳\功能台.js（可脱离 Electron 自测：node 外壳\功能台.js）
//   界面只传 id / action / 白名单输入项；主进程照登记表 spawn 脚本，参数逐项进 argv，不拼命令行。
//   五个插件开关的当下状态不让界面猜：一律跑脚本 --status / --check（feature:status，60 秒内复用）。
const featureDesk = require('./功能台');
ipcMain.handle('feature:list', () => featureDesk.list());
ipcMain.handle('feature:run', (e, id, actionId, inputs) => featureDesk.run(id, actionId, inputs));
ipcMain.handle('feature:status', () => featureDesk.status());
ipcMain.handle('feature:config:get', () => featureDesk.configGet());
ipcMain.handle('feature:config:set', (e, patch) => featureDesk.configSet(patch));
ipcMain.handle('feature:kill', (e, id, actionId) => featureDesk.kill(id, actionId));

// ---- 面板「换会话」按钮（2026-11-12）----
// 一次跑完：写交接（默认从 transcript 摘录，秒级）→ 建新会话 → 场景 json 三字段 + 定位卡 + 身份索引改绑
//   → 旧会话真归档 → 写 reload-panels.cmd 让面板重载。
// 安全：只接受场景 json 里真实登记的 harness 面板 id；命令与参数写死，不拼接用户输入。
// 2026-11-12 二次改版（用户报「点了十几秒没反应」）：默认不再让旧会话跑一整轮 LLM，改由脚本摘录；
// 2026-11-12 三次改版（宿主硬要求）：P| 步骤只落 外壳\data\换会话日志.txt，界面结果统一走顶栏 toast。

// 工具脚本必须用**系统 Node**，不能用 process.execPath（= electron.exe）：
//   Electron 43 内置 Node 24.18 的 zstd 只解 transcript 第一帧（实测 2 MB 只出 217 B、0 个 turn），
//   换会话脚本会永远等不到 turn/end（2026-11-12 一次 10 秒的交接被拖满 600 秒的根因）。
function toolNode() {
  if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE;
  const cands = [];
  if (process.env.NVM_SYMLINK) cands.push(path.join(process.env.NVM_SYMLINK, 'node.exe'));
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
  if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'));
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (e) { warnOnce("main", e) } }
  return 'node';   // 交给 PATH；找不到时 spawn 会报 ENOENT，界面会显示原因
}

// 2026-11-12（宿主）：面板上的操作反馈一律走 toast，这里只留痕迹 —— 每次换会话逐步写一行，
//   事后能查「交接 / 建会话 / 换绑 / 重载 / 耗时」到底卡在哪一步。
function rotateLogStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
// 2026-11-12 五改：日志改 JSONL（一行一个事件），并用 String() 兜底 ——
//   旧 txt 里出现过 3 行只写 "undefined"，事后根本查不出卡在哪一步。
//   现在能按 panel / stage / code 过滤；超过 1 MB 只留上一份，不再无限长。
function rotateJournal(ev) {
  try {
    const f = path.join(SHELL_DATA_DIR, '换会话日志.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      if (fs.statSync(f).size > 1024 * 1024) {
        try { fs.rmSync(f + '.prev', { force: true }); } catch (e) { warnOnce("main", e) }
        try { fs.renameSync(f, f + '.prev'); } catch (e) { warnOnce("main", e) }
      }
    } catch (e) { warnOnce("main", e) }
    const rec = Object.assign({ ts: rotateLogStamp() }, ev || {});
    for (const k of Object.keys(rec)) rec[k] = typeof rec[k] === 'string' ? rec[k] : String(rec[k]);
    fs.appendFileSync(f, JSON.stringify(rec) + '\r\n', 'utf8');
  } catch (e) { warnOnce("main", e) }
}

// 进程树杀（Windows）：child.kill() 只结束直接子进程，孙子（sessions.mjs / 归档会话.mjs）会继续跑 ⇒
//   上层已经判"超时失败"，json 和归档还在被改，用户看到状态自己跳变。taskkill /T 才杀得干净。
function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
  catch (e) { try { process.kill(pid); } catch (e2) { warnOnce("main", e2) } }
}

// 面板 → 场景。互斥锁用 sceneId 当 key：同一场景可能挂两块 AI 面板（程序开发 = 工作区 + 项目），
//   它们写同一份 scenarios\*.json，并发点两个按钮必然互相覆盖（旧实现固定 .tmp 文件名更会直接踩踏）。
function sceneInfoOf(panelId) {
  const dir = path.join(__dirname, 'scenarios');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.charAt(0) === '_') continue;
      const sc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const p of (sc.panels || [])) {
        if (p.type === 'harness' && String(p.id) === panelId) {
          return {
            sceneId: String(sc.id || f.replace(/\.json$/, '')),
            sceneName: String(sc.name || ''),
            boundId: String(p.sessionId || ''),
            file: f,
          };
        }
      }
    }
  } catch (e) { return null; }
  return null;
}

// 会话压力 / 轮次 / 最后落盘：自动换会话的判据（口径与 scripts/换会话.mjs 的 pressures() 一致）。
function sessionStatOf(sid) {
  const base = path.join(DSH_HOME, 'storages');
  try {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, 'sessions', sid + '.json');
      if (!fs.existsSync(f)) continue;
      let rec = {};
      try { rec = (JSON.parse(fs.readFileSync(f, 'utf8')) || {}).record || {}; } catch (e) { return null; }
      const pv = rec.rows && rec.rows.contextPressure && rec.rows.contextPressure.val;
      const ts = rec.rows && rec.rows.sessionStats && rec.rows.sessionStats.val;
      let pct = null;
      if (pv) {
        const line = Math.floor((pv.contextWindow || 160000) * 0.8);
        const projected = pv.pressureTokens > 0
          ? Math.round(pv.pressureTokens + (pv.surfaceTokens || 0) - ((pv.sampledSurfaceTokens ?? pv.surfaceTokens) || 0))
          : Math.round(pv.surfaceTokens || 0);
        pct = Math.round(projected / line * 100);
      }
      let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch (e) { warnOnce("main", e) }
      return { pct: pct, turns: (ts && ts.turns) ?? null, mtime: mtime };
    }
  } catch (e) { return null; }
  return null;
}

// ---- 到期自动换会话（2026-11-12 用户要求「完全自动化」）----
// 默认开：压力 ≥88% + ≥20 轮 + 空闲 ≥10 分钟 + 同面板 30 分钟冷却 + 每个 tick 最多换一个。
// 关掉：外壳\data\自动换会话.json 里把 enabled 改成 false（文件不存在时按默认建一份，方便你改）。
// 坏 JSON 只提示一次，5 分钟一 tick 别刷屏
let AUTO_ROTATE_BAD = false;
function autoRotateConfig() {
  const f = path.join(SHELL_DATA_DIR, '自动换会话.json');
  const def = { enabled: true, threshold: 88, minTurns: 20, idleMin: 10, cooldownMin: 30 };
  try {
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(def, null, 2) + '\r\n', 'utf8');
      return def;
    }
    const c = Object.assign({}, def, JSON.parse(fs.readFileSync(f, 'utf8')) || {});
    // 手改也可能写错：超出范围就回默认，避免「0 轮 / 200%」把自动换会话变成随机行为
    c.threshold = (Number(c.threshold) >= 50 && Number(c.threshold) <= 100) ? Number(c.threshold) : def.threshold;
    c.minTurns = (Number(c.minTurns) >= 1 && Number(c.minTurns) <= 200) ? Number(c.minTurns) : def.minTurns;
    c.idleMin = (Number(c.idleMin) >= 1 && Number(c.idleMin) <= 1440) ? Number(c.idleMin) : def.idleMin;
    c.cooldownMin = (Number(c.cooldownMin) >= 1 && Number(c.cooldownMin) <= 1440) ? Number(c.cooldownMin) : def.cooldownMin;
    c.enabled = !/^(false|off|0|no|关)$/i.test(String(c.enabled).trim());
    return c;
  } catch (e) {
    // 坏 JSON 不静默回到 enabled:true —— 那等于用户想关掉却继续自动换会话。
    if (!AUTO_ROTATE_BAD) {
      AUTO_ROTATE_BAD = true;
      log('[auto] 自动换会话.json 解析失败 ⇒ 本轮停用自动换会话：' + ((e && e.message) || e));
      try {
        broadcast('topbar:toast', {
          text: '自动换会话.json 解析失败 ⇒ 本轮已停用自动换会话；改好或删掉该文件再重启',
          bad: true, ms: 20000,
        });
      } catch (e2) { warnOnce('auto-rotate', e2); }
    }
    return Object.assign({}, def, { enabled: false, error: String((e && e.message) || e) });
  }
}

// ---- 换会话执行体（按钮 IPC 和「到期自动换」共用一套）----
// 2026-11-12 五改：把这些事实一次讲清 ——
//   ① 互斥按 sceneId（同场景两块 AI 面板写同一份 json，绝不能并发）
//   ② 超时用进程树杀（child.kill() 杀不掉孙子脚本，会留下"已判失败却还在改文件"的幽灵进程）
//   ③ 阶段（1/3 交接 · 2/3 建会话 · 3/3 换绑）实时推给界面，按钮标签跟着走
//   ④ JSONL 证据链（panel / stage / code / newId / reason 各一列，事后能查）
//   ⑤ 命令与参数写死，只接受场景 json 里真实登记的面板 id
const ROTATING = new Map();   // sceneId -> { panelId, stage, startedAt, auto }

function runRotate(panelId, opts, onStage) {
  // 1. 定位面板与场景；不存在就直接拒（互斥由调用方负责）
  return new Promise((resolve) => {
    const id = String(panelId || '').trim();
    const info = sceneInfoOf(id);
    if (!info) return resolve({ ok: false, stage: '校验', err: '不是已登记的 AI 面板：' + id });

    // 2. json 绑的会话已归档 ⇒ 只提示、不拦（轮换本身能从归档态重建绑定）
    let archivedNote = '';
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'));
      if (info.boundId && ((ws.global || {}).archivedSessionIds || []).indexOf(info.boundId) >= 0) {
        archivedNote = '（提示：场景 json 原先绑的会话已归档，本次会重建绑定；不是壳没重启）';
      }
    } catch (e) { warnOnce("main", e) }

    // 3. 选脚本：handover = 先写交接（transcript 摘录，秒级）；否则直接换（--force 跳过 2 小时闸）
    const handover = String((opts && opts.mode) || '') === 'handover';
    const auto = !!(opts && opts.auto);
    const script = handover
      ? path.join(__dirname, '..', '工具', '交接并换会话.mjs')
      : path.join(__dirname, 'scripts', '换会话.mjs');
    const scriptArgs = handover
      ? [script, '--panel', id, '--mode', 'transcript']
      : [script, id, '--go', '--force'];
    if (!fs.existsSync(script)) return resolve({ ok: false, stage: '校验', err: '缺脚本：' + script });

    const t0 = Date.now();
    let stage = '1/3', out = '', errOut = '', buf = '', done = false, timedOut = false, child = null;
    const setStage = (s, text) => {
      if (s) stage = s;
      const cur = ROTATING.get(info.sceneId);
      if (cur && s) cur.stage = s;
      try { if (onStage) onStage(s || stage, text || ''); } catch (e) { warnOnce("main", e) }
    };
    rotateJournal({ ev: 'start', panel: id, scene: info.sceneId, old: info.boundId, mode: handover ? 'transcript' : 'direct', auto: auto });

    try {
      child = spawn(toolNode(), scriptArgs, {
        cwd: __dirname,
        // DSH_ROTATE_SELF_RELOAD=0：GUI 模式下脚本不写 reload-panels.cmd，由渲染层只重载本面板；
        //   命令行手动跑时没有渲染层，脚本才写 cmd 让壳帮忙（那时才用 all）。
        env: scriptEnv({ DSH_HOME: DSH_HOME, DSH_ROTATE_SELF_RELOAD: '0' }),
        windowsHide: true,
      });
    } catch (e) {
      rotateJournal({ ev: 'spawn-fail', panel: id, err: (e && e.message) || e });
      return resolve({ ok: false, stage: '校验', err: '启动脚本失败：' + ((e && e.message) || e), out: '', warn: '' });
    }

    const finish = (code, errMsg) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      const all = out + (errOut ? '\n' + errOut : '');
      const ok = code === 0;
      // 失败时只挑「真正原因」给按钮显示（整段 stdout 会被 CSS 省略成一行，用户看不到真因）
      // 2026-11-17：原来 /^\s*[·✗]/ 会把 1/3 的良性提示（「· 记忆库未安装…交接本身已完成」）
      //   也当成失败原因，于是 toast 读起来像「失败：记忆库未安装」——把成功信息读成了失败。
      //   改成：先取 ✗ 行；没有再取「先别急」下面列出的闸门问题；最后才退到通用过滤。
      const NOISE = /记忆库未安装|跳过入库|交接本身已完成|·\s*(跳过|项目记忆体检：跳过)/;
      let reason = '';
      if (!ok) {
        const lines = all.split(/\r?\n/);
        const errs = lines.filter((l) => /^\s*✗/.test(l));
        if (errs.length) reason = errs.slice(0, 2).join(' ');
        else {
          const gi = lines.findIndex((l) => /先别急/.test(l));
          const gate = gi >= 0 ? lines.slice(gi + 1).filter((l) => /^\s*·/.test(l)) : [];
          if (gate.length) reason = gate.slice(0, 3).map((l) => l.trim()).join(' ');
        }
        reason = reason || lines.filter((l) => /^\s*[·✗]/.test(l) && !NOISE.test(l)).slice(0, 3).join(' ') || errMsg || ('脚本退出码 ' + code);
      }
      reason = String(reason || '').slice(0, 300);
      const warn = ok ? (((all.match(/^WARN:\s*(.+)$/m) || [])[1]) || '').trim() : '';
      const newId = ((all.match(/^NEWID:\s*(session-[0-9a-f-]{8,})\s*$/m) || [])[1]
        || (all.match(/新会话已建[：:]\s*(session-[0-9a-f-]{8,})/) || [])[1] || '').trim();
      const elapsed = ((all.match(/^ELAPSED:\s*([\d.]+)\s*$/m) || [])[1] || ((Date.now() - t0) / 1000).toFixed(1)).trim();
      log('[harness:rotate] ' + id + ' code=' + (code == null ? 'ERR' : code) + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      rotateJournal({ ev: ok ? 'done' : 'fail', panel: id, scene: info.sceneId, code: code == null ? 'ERR' : code, stage: ok ? '完成' : stage, newId: newId, elapsed: elapsed, warn: warn, reason: reason });
      resolve({ ok: ok, code: ok ? 0 : (code || 1), stage: ok ? '完成' : stage, reason: archivedNote + reason, out: archivedNote + all.slice(-6000), warn: warn, newId: newId, elapsed: elapsed });
    };

    // 4. 超时 240 秒（比脚本内部 180 秒长一档：让脚本自己先报原因，别被上层抢先杀掉）
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { killTree(child.pid); } catch (e) { warnOnce("main", e) }
    }, 240000);

    // 5. 脚本用 `P|1/3 交接 · …` 报阶段 ⇒ 实时推给界面 + 进日志
    const onLine = (line) => {
      if (!line.trim()) return;
      const m = line.match(/^P\|(\d\/\d)\s*(.*)$/);
      if (m) setStage(m[1], (m[2] || '').trim());
      else if (line.startsWith('P|')) setStage('', line.slice(2).trim());
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (e) => { finish(null, '脚本启动失败：' + ((e && e.message) || e)); });
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      if (timedOut) errOut += '\n✗ 超时（240 秒）已中止（进程树已结束）';
      finish(timedOut ? null : code, timedOut ? '超时（240 秒）已中止（进程树已结束）' : '');
    });
  });
}

ipcMain.handle('harness:rotate', async (event, panelId, opts) => {
  const id = String(panelId || '').trim();
  const info = sceneInfoOf(id);
  if (!info) return { ok: false, err: '不是已登记的 AI 面板：' + id };
  if (ROTATING.has(info.sceneId)) {
    const cur = ROTATING.get(info.sceneId);
    return { ok: false, code: 'busy', stage: cur.stage, err: '这个场景正在换会话（面板 ' + cur.panelId + ' · ' + cur.stage + '）—— 等它跑完再点；并发会写坏同一份场景 json' };
  }
  ROTATING.set(info.sceneId, { panelId: id, stage: '1/3', startedAt: Date.now(), auto: false });
  const onStage = (s, text) => {
    try { event.sender.send('harness:rotate-progress', { panelId: id, sceneId: info.sceneId, stage: s, text: String(text || '') }); } catch (e) { warnOnce("main", e) }
  };
  try {
    return await runRotate(id, opts, onStage);
  } finally {
    ROTATING.delete(info.sceneId);
  }
});

// ---- 到期自动换会话（「完全自动化」的那一半）----
// 判据（全满足才动）：压力 ≥ 阈值 + 轮次 ≥ 下限 + 会话空闲 ≥ idleMin 分钟 + 同面板冷却期已过。
// 每 5 分钟最多换一个 ⇒ 不会同时改多份场景 json；失败只记日志，下一个 tick 再评估。
const AUTO_LAST = new Map();
setInterval(function () {
  const cfg = autoRotateConfig();
  if (!cfg.enabled || ROTATING.size) return;
  const panels = [];
  try {
    const dir = path.join(__dirname, 'scenarios');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.charAt(0) === '_') continue;
      const sc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const p of (sc.panels || [])) {
        if (p.type === 'harness' && p.sessionId) panels.push({ id: String(p.id), sid: String(p.sessionId), sceneId: String(sc.id || f.replace(/\.json$/, '')) });
      }
    }
  } catch (e) { return; }
  for (const p of panels) {
    const st = sessionStatOf(p.sid);
    if (!st || st.pct == null || st.pct < cfg.threshold) continue;
    if ((st.turns || 0) < cfg.minTurns) continue;
    if (st.mtime && (Date.now() - st.mtime) < cfg.idleMin * 60 * 1000) continue;   // 正在用：别打断
    if (Date.now() - (AUTO_LAST.get(p.id) || 0) < cfg.cooldownMin * 60 * 1000) continue;
    ROTATING.set(p.sceneId, { panelId: p.id, stage: '自动', startedAt: Date.now(), auto: true });
    rotateJournal({ ev: 'auto-trigger', panel: p.id, scene: p.sceneId, pct: st.pct, turns: st.turns });
    runRotate(p.id, { mode: 'handover', auto: true }, function (s, text) {
      broadcast('harness:rotate-progress', { panelId: p.id, sceneId: p.sceneId, stage: s, text: '自动换会话 · ' + (text || '') });
    }).then(function (r) {
      ROTATING.delete(p.sceneId);
      AUTO_LAST.set(p.id, Date.now());
      if (r && r.ok) broadcast('harness:rotated', { panelId: p.id, sceneId: p.sceneId, auto: true, newId: r.newId || '' });
      rotateJournal({ ev: r && r.ok ? 'auto-done' : 'auto-fail', panel: p.id, newId: (r && r.newId) || '', reason: (r && r.reason) || '' });
    }).catch(function (e) {
      ROTATING.delete(p.sceneId);
      rotateJournal({ ev: 'auto-crash', panel: p.id, err: (e && e.message) || e });
    });
    return;   // 一个 tick 只换一个
  }
}, 5 * 60 * 1000);
ipcMain.handle('topbar:open', (e, p) => {
  const f = path.resolve(String(p || ''));
  if (f.indexOf(TOPBAR_ROOT) !== 0) return { ok: false, error: '只允许打开项目根目录里的文件' };   // 白名单：别让它变成任意路径打开器
  try { shell.openPath(f); return { ok: true }; } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// 选股器秒开：直接返回本地缓存的最近一次全市场排名（不发网络请求）
ipcMain.handle('stock:market:rankCached', (e, type) => stockStore.latestRank(type));

// ---- 窗口控制（自定义标题栏用）----
// ★按发起方寻址★：分离窗口上的按钮必须动它自己 —— 若仍用 mainWindow，
// 分离窗口点「关闭」会把主窗口关掉（= 整个应用退出），是这套功能里最危险的坑。
// 2026-10-20（宿主报「点最小化没反应」）—— 实测：**Electron 最大化态下 win.minimize() 偶发无效**
//   （点击到、IPC 也 resolve，但窗口不 iconic；Win32 SW_MINIMIZE 却能；unmaximize 后再 minimize 就正常）。
//   这里加一层兜底：先 minimize，300ms 后还是没最小化 ⇒ 先 unmaximize + minimize，并记住"本来是最大化"，
//   恢复（restore）时再 maximize 回去。日志写 server.log，便于以后核对。
ipcMain.handle('window:minimize', (e) => {
  const w = windowOfEvent(e) || mainWindow;
  if (!w) { log('[win] minimize: 没有窗口'); return { ok: false, err: 'no-window' }; }
  let wasMax = false;
  try { wasMax = w.isMaximized(); w.minimize(); } catch (err) {
    log('[win] minimize 抛错: ' + ((err && err.message) || err));
    return { ok: false, err: String((err && err.message) || err) };
  }
  setTimeout(function () {
    try {
      if (w.isMinimized()) {
        log('[win] minimize ok（wasMax=' + wasMax + '）');
        return;
      }
      if (!wasMax) { log('[win] minimize 之后仍未最小化（非最大化态） visible=' + w.isVisible()); return; }
      log('[win] minimize 在最大化态无效 ⇒ 退回 unmaximize + minimize');
      try {
        w.unmaximize();
        w.minimize();
        w.once('restore', function () { try { w.maximize(); } catch (e3) { warnOnce("main", e3) } });
      } catch (e2) { log('[win] 兜底也失败: ' + ((e2 && e2.message) || e2)); }
    } catch (e) { warnOnce("main", e) }
  }, 300);
  return { ok: true };
});
ipcMain.handle('window:toggle-maximize', (e) => {
  const w = windowOfEvent(e) || mainWindow;
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return w.isMaximized();
});
ipcMain.handle('window:is-maximized', (e) => { const w = windowOfEvent(e) || mainWindow; return !!w && w.isMaximized(); });
ipcMain.handle('window:close', (e) => { const w = windowOfEvent(e) || mainWindow; if (w) w.close(); });

// ---- 多窗口（场景分离）：我是谁 / 开场景窗口 / 关自己 / 哪些场景已分离 ----
ipcMain.handle('window:info', (e) => {
  const w = windowOfEvent(e);
  const isMain = !w || w.kunRole !== 'scene';
  return {
    role: isMain ? 'main' : 'scene',
    isMain: isMain,
    scene: (w && w.kunScene) || '',
    sceneName: (w && w.kunScene) ? sceneNameOf(w.kunScene) : '',
    maximized: !!w && w.isMaximized(),
    detached: detachedSceneIds()
  };
});
ipcMain.handle('window:scenes', () => detachedSceneIds());
ipcMain.handle('window:open-scene', (e, sceneId) => openSceneWindow(sceneId));
ipcMain.handle('window:close-self', (e) => { const w = windowOfEvent(e); if (w) w.close(); return { ok: true }; });

// ---- 启动页 IPC：当前进度快照 / 失败后重试 ----
ipcMain.handle('boot:state', () => lastBoot);
let bootRunning = false;
ipcMain.handle('boot:retry', async () => {
  if (bootRunning) return { ok: false, err: '正在启动中，请稍候' };
  bootRunning = true;
  try {
    const ok = await startServer();
    if (ok) broadcast('harness:ready');   // 所有窗口都要知道引擎就绪（分离窗口也要开始加载 webview）
    return { ok: ok };
  } catch (e) {
    sendBoot({ stage: 'error', pct: 100, text: '重试失败', detail: (e && e.message) || String(e) });
    return { ok: false, err: (e && e.message) || String(e) };
  } finally {
    bootRunning = false;
  }
});

// ---- 首启下载引擎（2026-11-20）：安装包不随引擎分发，缺引擎时由启动页按下载源补齐 ----
function engineSourceNow() {
  return engineBoot.readSource({
    configPath: MACHINE_FILE_EARLY,
    shippedPath: path.join(__dirname, '引擎源.json')
  });
}
ipcMain.handle('engine:status', () => {
  const d = engineBoot.detect(HARNESS_DIR);
  const s = engineSourceNow();
  return {
    installed: d.ok, version: d.version || '', layout: d.layout || '', reason: d.reason || '', text: d.text,
    source: { ok: s.ok, url: s.url, version: s.version, problems: s.problems }
  };
});
let engineDownloading = false;

// 进度映射：下载 0–80%，校验 84 / 解包 88 / 安装 92
function engineBootProgress(p) {
  if (p.phase !== 'download') {
    log('[engine] 首启引擎：' + p.phase + ' ' + (p.pct || 0) + '% ' + (p.text || ''));
  }
  if (p.phase === 'download') {
    sendBoot({
      stage: 'engine-download', pct: Math.round((p.pct || 0) * 0.8),
      text: '正在下载 DSH 引擎…',
      detail: (p.bytes ? (p.bytes / 1048576).toFixed(1) : '0') + ' / ' +
        (p.total ? (p.total / 1048576).toFixed(1) : '?') + ' MB' +
        (p.speed ? ' · ' + (p.speed / 1048576).toFixed(1) + ' MB/s' : '')
    });
  } else if (p.phase === 'verify') {
    sendBoot({ stage: 'engine-install', pct: 84, text: '校验引擎包…', detail: 'sha256' });
  } else if (p.phase === 'extract') {
    sendBoot({ stage: 'engine-install', pct: 88, text: '解包引擎…', detail: p.text || '' });
  } else if (p.phase === 'install') {
    sendBoot({ stage: 'engine-install', pct: 92, text: '安装引擎…', detail: p.text || '' });
  }
}

// 装好直接起：下载与「选本地包」共用这一段（保证两条路走同一套校验与启动）
async function installEngineThenStart(src, force) {
  const r = await engineBoot.ensure({
    root: HARNESS_DIR, source: src, force: !!force, onProgress: engineBootProgress
  });
  if (!r.ok) {
    sendBoot({ stage: 'engine-missing', pct: 0, text: '引擎安装失败', detail: r.err || '' });
    return { ok: false, err: r.err || '安装失败' };
  }
  sendBoot({ stage: 'spawn', pct: 14, text: '引擎已装好，正在启动…', detail: r.version ? 'v' + r.version : '' });
  const ok = await startServer();       // 重新探测端口 / 选启动方式
  if (ok) broadcast('harness:ready');
  return { ok: ok, version: r.version || '' };
}

ipcMain.handle('engine:download', async () => {
  if (engineDownloading) return { ok: false, err: '正在下载中，请稍候' };
  engineDownloading = true;
  try {
    // 1. 源必须齐：url + sha256（没配就把原因原样给启动页，别静默）
    const src = engineSourceNow();
    if (!src.ok) {
      sendBoot({ stage: 'engine-missing', pct: 0, text: '下载源未配置', detail: src.problems.join('；') });
      return { ok: false, err: src.problems.join('；') };
    }
    return await installEngineThenStart(src, false);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('[engine] 首启下载失败: ' + msg);
    sendBoot({ stage: 'engine-missing', pct: 0, text: '引擎下载失败', detail: msg });
    return { ok: false, err: msg };
  } finally {
    engineDownloading = false;
  }
});

// 没有下载源 / 内网离线：直接选本机引擎包（同一套 sha256 + 解包 + 替换）
ipcMain.handle('engine:pick-local', async () => {
  if (engineDownloading) return { ok: false, err: '正在安装中，请稍候' };
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: '选择 DSH 引擎包（.tar.gz）',
    filters: [{ name: '引擎包', extensions: ['gz', 'tgz', 'tar'] }]
  });
  if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
  const file = picked.filePaths[0];
  engineDownloading = true;
  try {
    // 1. 本地包没有发布方给的 sha256，就算一份当完整性基线（防拷坏，不证明来源）
    sendBoot({ stage: 'engine-install', pct: 0, text: '校验本地引擎包…', detail: path.basename(file) });
    const sha = await engineBoot.sha256File(file, function (p) {
      sendBoot({
        stage: 'engine-install', pct: Math.round((p.pct || 0) * 0.8),
        text: '校验本地引擎包…', detail: path.basename(file) + ' · ' + (p.bytes / 1048576).toFixed(1) + ' MB'
      });
    });
    return await installEngineThenStart({ ok: true, url: file, sha256: sha, version: '', origin: ['local'] }, true);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('[engine] 本地引擎包安装失败: ' + msg);
    sendBoot({ stage: 'engine-missing', pct: 0, text: '本地引擎包安装失败', detail: msg });
    return { ok: false, err: msg };
  } finally {
    engineDownloading = false;
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async function () {
  // 【已移除】任务栏角标（原来显示"当前窗口数"）：2026-10-15 按用户要求删除。
  //   原因：这台机器上 Windows 的徽章层会压过应用自画的叠加图标（TaskbarBadges=1 时永远显示系统的「1」），
  //   而关掉系统徽章后应用叠加图标也一并不显示 ⇒ 「角标 = 窗口数」在 Windows 这一层做不到 ✗。
  //   想数窗口时：鼠标悬停任务栏那颗按钮，Windows 会弹出各窗口的缩略图 ✓（详见 项目信息.md §47 补3）。
    // 启动流程整体兜底：任何一步抛错都不会变成"静默打不开"——
    // 先尽力保证有一个可见窗口，再弹一次错误提示（含日志路径与回滚方法）。
    loadWinLayout();   // 上次退出时的窗口布局：主窗口位置 + 分离出去的场景窗口
    try {
      createWindow({ isMain: true, saved: layoutCache.main });
    } catch (err) {
      reportFatal('创建主窗口失败', err);
      try { createWindow({ isMain: true }); } catch (e2) { reportFatal('重试创建主窗口仍失败', e2); }
    }
    // 恢复上次分离出去的场景窗口（场景 json 可能已被删 → 校验后只开仍然存在的）
    try {
      const known = listScenarios().map(function (s) { return s.id; });
      Object.keys(layoutCache.detached).forEach(function (sid) {
        if (known.indexOf(sid) < 0) { delete layoutCache.detached[sid]; return; }
        try { createWindow({ scene: sid, saved: layoutCache.detached[sid] }); }
        catch (e) { log('[win] 恢复场景窗口失败 ' + sid + ': ' + ((e && e.message) || e)); }
      });
    } catch (err) { log('[win] 恢复场景窗口异常: ' + ((err && err.message) || err)); }
    try {
      startSiteServer();   // 保命入口服务（/chat + 桌宠 3D）；个人站官网预览已于 2026-11-12 删除
    } catch (err) { reportFatal('启动本地静态服务失败', err); }
    try {
      startBalancePoll();  // 余额实时显示：每 10s 拉取 DeepSeek 平台余额
    } catch (err) { reportFatal('启动余额轮询失败', err); }
    // 外发安全闸门：先把 QQ 代理拉起来（端口在听之前，插件哪怕先发也不会漏）。
    // 起不来不阻塞主流程 —— 原因进日志 + 状态文件，面板「安全闸门」里能看到红项。
    try {
      outGateService.start().catch(function (e) { log('[gate] 随壳启动失败: ' + ((e && e.message) || e)); });
    } catch (err) { log('[gate] 随壳启动异常: ' + ((err && err.message) || err)); }
    // QQ 个人号桥接（SnowLuma）：跟着工作台一起起，别让用户再单独开一只。
    // 起不来不阻塞主流程 —— 原因写日志，面板按钮上也能看到（不许静默）。
    try {
      bridgeService.autoStart().catch(function (e) { log('[bridge] 随壳启动失败: ' + ((e && e.message) || e)); });
    } catch (err) { log('[bridge] 随壳启动异常: ' + ((err && err.message) || err)); }
    // 微信个人号通道（whale_girl）：默认 autoStart=false（先在鲸鲸里登录小号，再点卡片「启动」）。
    // 这里先写一份状态文件，社交卡片一打开就能看到「未启动 / 缺哪一步」，不用等用户点。
    try {
      wechatService.autoStart().catch(function (e) { log('[wechat] 随壳启动失败: ' + ((e && e.message) || e)); });
      wechatService.status().catch(function (e) { log('[wechat] 初始状态失败: ' + ((e && e.message) || e)); });
    } catch (err) { log('[wechat] 随壳启动异常: ' + ((err && err.message) || err)); }
    // 聊天长期档案：跟着工作台起。它只读 SnowLuma 的 messages.db，不需要等引擎 token；
    // 先给桥接 8 秒把 SnowLuma 拉起来，再开始首轮回填；失败不阻塞主流程，状态里能看见。
    setTimeout(function () {
      try {
        chatArchiveService.start();
        log('[archive] 随壳启动（只读 SnowLuma messages.db → 本地档案库）');
      } catch (e) {
        log('[archive] 随壳启动失败: ' + ((e && e.message) || e));
      }
      // QQ 群旁听也等桥接把 SnowLuma 拉起来；没有绑定群时只保持 WS，不接话。
      try {
        const gr = qqGroupService.start();
        log('[qq-group] 随壳启动旁听：' + JSON.stringify(gr && (gr.skipped || gr.error || { started: gr.started, connected: gr.connected }) || {}));
      } catch (e) {
        log('[qq-group] 随壳启动失败: ' + ((e && e.message) || e));
      }
    }, 8000);
    let ok = false;
    // 2026-11-14：起引擎之前先收拾"孤儿 staging"（不动 state 指向的那份），失败不影响启动
    try { cleanOrphanStaging(); } catch (e) { warnOnce("auto-staging", e); }
    try {
      ok = await startServer();
    } catch (err) {
      reportFatal('启动 Harness 引擎失败', err);
      ok = false;
    }
    if (!ok) {
      // 不再弹框退出：保留窗口，由首屏加载页显示失败态与「重试」（进度条不会空白）
      log('startServer failed — 保留窗口，等待用户重试');
      return;
    }
    log('[boot] 引擎就绪总耗时 ' + ((Date.now() - APP_T0) / 1000).toFixed(1) + 's');
    // 引擎起来后再挂桌面身体桥：dsh-pet 路由依赖 DSH web 端口，早挂只会多几行未就绪日志
    try { startPetBodyBridge(); } catch (e) { warnOnce('pet-body-start', e); }
    // 2026-11-14：后台巡检（60s 后跑，每天最多一次；只在有失败时弹通知）
    try { scheduleAutoInspection(); } catch (e) { warnOnce("auto-inspect", e); }
    // 2026-11-14：记忆整理（90s 后跑，每周最多一次；整理前后都留痕）
    try { scheduleAutoMemoryTidy(); } catch (e) { warnOnce("auto-tidy", e); }
    // 判据留痕：这一行说明「端口先通、token 后到」，渲染层会等它（见 harness:ready 的 3s 有界等待）
    if (!engineIsForeign && !harnessToken) log('[boot] token 行尚未到达（端口先通）⇒ 渲染层会等待并重试');
    // 通知渲染层：Harness 已就绪（所有窗口的 webview 都可以加载了）
    try {
      broadcast('harness:ready');
    } catch (err) { log('[boot] 通知渲染层失败: ' + ((err && err.message) || err)); }
    // 引擎就绪后再接管 QQ：插件保存接口要换 cookie；没就绪就先写文件，标「重启整壳后生效」。
    try {
      outGateService.ensureQqProxy().then(function (r) {
        if (!r || r.ok === false) log('[gate] QQ 接管未完成: ' + ((r && r.error) || '未知原因'));
        else if (r.restartRequired) log('[gate] QQ 已写指闸门，需重启整壳生效: ' + (r.error || ''));
        else if (r.applied) log('[gate] QQ 已过闸门（热生效）');
        else if (r.skipped) log('[gate] QQ 未接管: ' + r.skipped);
      }).catch(function (e) { log('[gate] QQ 接管失败: ' + ((e && e.message) || e)); });
      // 首轮失败（引擎 token 还没抓到）再试一次，仍失败就留给面板上的按钮
      setTimeout(function () {
        outGateService.ensureQqProxy().catch(function (e) { log('[gate] QQ 接管重试失败: ' + ((e && e.message) || e)); });
      }, 20000);
    } catch (err) { log('[gate] QQ 接管异常: ' + ((err && err.message) || err)); }
    // QQ 私聊/群聊独立会话：引擎就绪后把共用/重复的 routes 迁成各自会话。
    // 5 秒先试一次；token 行有时比端口晚到，20 秒再兜一次（幂等，迁过就不会重复建）。
    function ensureQqChatRoutes(why) {
      qqChatService.ensureAll().then(function (r) {
        if (r && r.changed) log('[qq-chat] 启动迁移完成（' + why + '）：' + JSON.stringify(r.status || {}));
      }).catch(function (e) { log('[qq-chat] 启动迁移失败（' + why + '）: ' + ((e && e.message) || e)); });
    }
    setTimeout(function () { ensureQqChatRoutes('5s'); }, 5000);
    setTimeout(function () { ensureQqChatRoutes('20s'); }, 20000);
    // 2026-10-24：升级/崩溃保险 —— 后台跑，引擎 60 秒没起来就自动回退（不阻塞启动）
    guardCheckAfterBoot().catch(function (e) { log('[guard] 检查自身失败：' + ((e && e.message) || e)); });
  }).catch(function (err) {
    reportFatal('whenReady 启动链失败', err);
  });
  app.on('window-all-closed', function () {
    killServer();
    app.quit();
  });
  app.on('before-quit', function () {
    quitRequested = true;      // 保留"下次恢复"的布局：整体退出 ≠ 用户关掉某个场景窗口
    // 2026-11-14：退出后自动清缓存（拉起分离进程，等本进程退出 + 端口空后再删；超阈值才清）
    try { scheduleAutoCacheCleanup(); } catch (e) { warnOnce("auto-clean", e); }
    // 2026-10-24：正常退出 ⇒ 给保险哨子盖章（下次启动不会误判成"升级中途被关掉"）
    try { writeGuard({ clean: true, at: Date.now(), pid: process.pid }); } catch (e) { warnOnce("main", e) }
    try { saveWinLayout(); } catch (e) { warnOnce("main", e) }
    killServer();
    try { bridgeService.stop(); } catch (e) { warnOnce("main", e) }
    try { wechatService.stop(); } catch (e) { warnOnce("main", e) }
    try { chatArchiveService.close(); } catch (e) { warnOnce("main", e) }
    try { qqGroupService.stop(); } catch (e) { warnOnce("main", e) }
    try { outGateService.stop(); } catch (e) { warnOnce("main", e) }
  });
}

// ===== 内置网页版 AI 桥：让任何会话/脚本能“免费问顶栏那 5 个网页版”（2026-09-21 第 10 轮）=====
// 需求：会话想省钱 / API 额度用完时，把活儿外包给免费网页版（DeepSeek·豆包·通义·智谱·Kimi）。
// 链路：脚本 → POST http://127.0.0.1:31239/webai/ask → broadcast('webai:task')
//      → 渲染层 renderer\webai-bridge.js 在对应 <webview> 里输入问题、等回答 → IPC webai:done → 回包。
// 为什么这么绕：会话（引擎侧）只会跑命令，进程外只有 HTTP 进得来；而网页版是**渲染层**的 <webview>
//   （partition=persist:webai-<key>，登录态在那儿），主进程碰不到它的 DOM —— 所以必须借渲染层的手。
// 安全：只监听 127.0.0.1，不对外；claim 机制保证多窗口时只有一个窗口干活（不会问两遍）。
const WEB_AI_PORT = Number(process.env.WEB_AI_PORT || machinePort('webAi', 31239));
const WEB_AI_KEYS = [
  { key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { key: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
  { key: 'tongyi', name: '通义千问', url: 'https://tongyi.aliyun.com/qianwen/' },
  { key: 'chatglm', name: '智谱清言', url: 'https://chatglm.cn/main/alltoolsdetail' },
  { key: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/' }
];   // ⚠ 这份表必须和 renderer\renderers.js 的 WEB_AI 一致（check-gui.mjs 会比对）
const webAiPending = new Map();
let webAiSeq = 0;
let lastFocusedWin = null;      // 由 createWindow 的 focus 事件维护（见上面那段注释：为什么必须定向派发）
// ★多窗口安全（v3.17，2026-09-23）★
// 每个窗口都是**独立一整套壳**（自带 preload + 渲染器 + 一份 webai-bridge.js），而分离窗口那份桥
// 只在它自己那次加载/⟳ 时才更新 —— 用户分屏常驻时它可能很久都是旧代码。旧桥的判正文逻辑是老的，
// 抢到活就把正文切错（实测：菜单墙 / 页脚 / 上一轮内容，现象像"你刚改的判据坏了"，能白查一整轮）。
// 所以派发**必须挑窗口**，三道闸：
//   闸 1：窗口加载完（did-finish-load）问一次它的桥版本；只挑**版本相等**的 ⇒ 旧桥窗口直接出局。
//   闸 2：抢单必须来自派发目标。闸 3：交卷也必须来自派发目标（旧桥不一定申报）。
const WEB_AI_BRIDGE_MIN = '3.17';               // 桥的**最低**可用版本（真正的派活基准见 WEB_AI_WANT）
const webAiWinVer = new Map();                  // webContents.id → { ver, title }
// ★2026-09-26★ 派活基准改成**动态 = 见过的最新桥版本**。
//   原来拿上面那个常量判等 ⇒ 桥一升版（今天 3.17→3.24），所有新窗口都被判成"旧桥、不再派活"，
//   现象却是"`[[peek]]` 偶尔能通、一打字必失败"，查了半天才发现是这儿 ⇒ 桥升级不该再改主进程。
let WEB_AI_WANT = WEB_AI_BRIDGE_MIN;
function webAiVerNum(v) { return String(v || '').split('.').map(function (x) { return parseInt(x, 10) || 0; }); }
function webAiVerGt(a, b) {
  const x = webAiVerNum(a), y = webAiVerNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
// 派发目标：**主窗口优先**（用户 2026-09-23 定的口径：分屏时以主窗口为基准）→ 聚焦 → 最后聚焦 → 任意
// 为什么不再"聚焦优先"：分屏时焦点常在别的场景窗口上，任务就被派给那份可能很旧的桥了。
function webAiTargetWindow() {
  const E = require('electron').BrowserWindow;
  const alive = function (w) { return w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed(); };
  const ready = function (w) {
    if (!alive(w)) return false;
    const rec = webAiWinVer.get(w.webContents.id);
    return !!rec && rec.ver === WEB_AI_WANT;   // 没申报 / 不是最新版 = 不派（基准是动态的最新版）
  };
  const cands = [mainWindow, E.getFocusedWindow(), lastFocusedWin];
  const all = E.getAllWindows().filter(alive);
  for (let i = 0; i < all.length; i++) cands.push(all[i]);
  for (let i = 0; i < cands.length; i++) if (ready(cands[i])) return cands[i];
  // 一个都没申报（比如刚启动还在加载）：退回旧口径，让闸 2/闸 3 去挡 —— 总比"没窗口可用"强
  for (let i = 0; i < cands.length; i++) if (alive(cands[i])) return cands[i];
  return null;
}
function webAiAsk(key, text, opts) {
  return new Promise(function (resolve) {
    const k = String(key || '').trim();
    const known = WEB_AI_KEYS.map(function (s) { return s.key; });
    if (known.indexOf(k) < 0) { resolve({ ok: false, key: k, err: '不认识的 key：' + k + '（可用：' + known.join(' / ') + '）' }); return; }
    const t = String(text || '');
    if (!t.trim()) { resolve({ ok: false, key: k, err: '问题是空的' }); return; }
    const target = webAiTargetWindow();
    if (!target) { resolve({ ok: false, key: k, err: '工作台窗口还没起来（GUI 正在启动？）' }); return; }
    const targetId = target.webContents.id;
    const targetTitle = (function () { try { return target.getTitle(); } catch (e) { return ''; } })();
    const id = 'w' + (++webAiSeq) + '-' + Date.now().toString(36);
    const timeoutMs = Math.max(5000, Math.min(600000, Number((opts && opts.timeoutMs) || 180000)));
    const timer = setTimeout(function () {
      if (!webAiPending.has(id)) return;
      webAiPending.delete(id);
      resolve({ ok: false, id: id, key: k, err: '超时（' + Math.round(timeoutMs / 1000) + 's）：网页版没回完话，或那个窗口没在跑' });
    }, timeoutMs + 8000);
    webAiPending.set(id, { id: id, key: k, text: t, t0: Date.now(), resolve: resolve, timer: timer, claimed: false, winId: targetId, winTitle: targetTitle });
    try { target.webContents.send('webai:task', { id: id, key: k, text: t, timeoutMs: timeoutMs }); }
    catch (e) {
      clearTimeout(timer); webAiPending.delete(id);
      resolve({ ok: false, key: k, err: '派发失败：' + String((e && e.message) || e) });
      return;
    }
    // 日志里带上窗口标题：多窗口时这一行就是"谁在抢单"的铁证
    log('[webai] → ' + k + ' 任务 ' + id + '（' + t.slice(0, 24) + '…）→ 窗口「' + targetTitle + '」');
  });
}
ipcMain.handle('webai:ask', function (e, key, text, opts) { return webAiAsk(key, text, opts); });
ipcMain.handle('webai:claim', function (e, id) {
  const t = webAiPending.get(String(id || ''));
  if (!t || t.claimed) return false;          // 只有一个窗口能抢到
  // 只认派发目标的抢单：旧版桥（别的窗口）就算收到了也不让它接活
  if (t.winId && e.sender.id !== t.winId) {
    log('[webai] ⛔ 忽略抢单：窗口 id ' + e.sender.id + ' ≠ 目标 ' + t.winId +
      '（那是**旧桥**，正文可能被切错；关掉那个窗口再重开、或点它上面的 ⟳）');
    return false;
  }
  t.claimed = true; t.winId = e.sender.id;
  return true;
});
// 窗口加载完就来申报自己的桥版本 ⇒ 派发时只挑"版本相等"的窗口（旧桥窗口直接出局，不用等它抢单才发现）
ipcMain.handle('webai:bridge', function (e, ver) {
  const E = require('electron').BrowserWindow;
  const w = E.fromWebContents(e.sender);
  let title = '';
  try { title = w ? w.getTitle() : ''; } catch (x) { warnOnce("main", x) }
  const v = String(ver || '?');
  const prev = webAiWinVer.get(e.sender.id);
  webAiWinVer.set(e.sender.id, { ver: v, title: title });
  if (webAiVerGt(v, WEB_AI_WANT)) WEB_AI_WANT = v;   // ★动态基准：谁报得比基准新，以后就派给这个版本
  const isMain = !!w && w === mainWindow;
  if (!prev || prev.ver !== v) {
    log('[webai] 窗口申报桥版本 v' + v + (isMain ? '（主窗口）' : '（场景窗口）') + '：' + title +
      (v === WEB_AI_WANT ? ' ✓' : ' ⚠ 低于当前基准 v' + WEB_AI_WANT + ' ⇒ 不派活给它（点它的 ⟳ 或关掉重开）'));
  }
  return { ver: v, want: WEB_AI_WANT, ok: v === WEB_AI_WANT, isMain: isMain };
});
// 体检用：谁申报了什么版本、当前会派给谁 —— 排障时一条命令看清，不用靠猜
ipcMain.handle('webai:who', function () {
  const E = require('electron').BrowserWindow;
  const list = [];
  webAiWinVer.forEach(function (rec, id) { list.push({ id: id, ver: rec.ver, title: rec.title, ok: rec.ver === WEB_AI_WANT }); });
  const t = webAiTargetWindow();
  let tTitle = ''; try { tTitle = t ? t.getTitle() : ''; } catch (e) { warnOnce("main", e) }
  return { want: WEB_AI_WANT, windows: list, target: tTitle, pending: webAiPending.size };
});
ipcMain.handle('webai:done', function (e, id, r) {
  const t = webAiPending.get(String(id || ''));
  if (!t) return false;
  // 闸 3：交卷也必须来自派发目标 —— 旧桥可能压根不申报、直接干完就交（那就把它的结果扔掉）
  if (t.winId && e.sender.id !== t.winId) {
    log('[webai] ⛔ 忽略交卷：窗口 id ' + e.sender.id + ' ≠ 目标 ' + t.winId + '（旧桥给的结果不可信，已丢弃）');
    return false;
  }
  clearTimeout(t.timer);
  webAiPending.delete(t.id);
  log('[webai] ← ' + t.key + ' 任务 ' + t.id + '：' + (r && r.ok ? '成功 ' + String((r && r.text) || '').length + ' 字' : '失败 ' + ((r && r.err) || '')));
  t.resolve(Object.assign({ id: t.id, key: t.key, elapsedMs: Date.now() - t.t0 }, r || {}));
  return true;
});
ipcMain.handle('webai:state', function () {
  return {
    port: WEB_AI_PORT,
    keys: WEB_AI_KEYS.map(function (s) { return s.key; }),
    pending: Array.from(webAiPending.values()).map(function (t) {
      return { id: t.id, key: t.key, claimed: t.claimed, ageMs: Date.now() - t.t0, winTitle: t.winTitle || '', text: t.text.slice(0, 40) };
    })
  };
});
const webAiServer = http.createServer(function (req, res) {
  const json = function (code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const u = (req.url || '/').split('?')[0];
  if (u === '/webai/keys' && req.method === 'GET') { json(200, { keys: WEB_AI_KEYS }); return; }
  if (u === '/webai/state' && req.method === 'GET') {
    json(200, {
      port: WEB_AI_PORT,
      pending: Array.from(webAiPending.values()).map(function (t) { return { id: t.id, key: t.key, claimed: t.claimed, ageMs: Date.now() - t.t0 }; })
    });
    return;
  }
  // 排障：谁申报了哪个版本的桥、现在会派给哪个窗口（= 分屏/多窗口时"到底谁在答"，一条命令看清）
  if (u === '/webai/who' && req.method === 'GET') {
    const E = require('electron').BrowserWindow;
    const list = [];
    webAiWinVer.forEach(function (rec, id) { list.push({ id: id, ver: rec.ver, title: rec.title, ok: rec.ver === WEB_AI_WANT }); });
    const t = webAiTargetWindow();
    let tTitle = ''; try { tTitle = t ? t.getTitle() : ''; } catch (e) { warnOnce("main", e) }
    json(200, { want: WEB_AI_WANT, windows: list, target: tTitle, stale: list.filter(function (x) { return !x.ok; }).length });
    return;
  }
  if (u === '/webai/ask') {
    if (req.method !== 'POST') { json(405, { ok: false, err: '这个端点要用 POST' }); return; }
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async function () {
      let p = null;
      try { p = JSON.parse(body || '{}'); } catch (e) { json(400, { ok: false, err: '请求体不是 JSON' }); return; }
      const r = await webAiAsk(p.key, p.text, p);
      json(r.ok ? 200 : 502, r);
    });
    return;
  }
  json(404, { ok: false, err: '没有这个端点', endpoints: ['GET /webai/keys', 'GET /webai/state', 'GET /webai/who', 'POST /webai/ask {key,text,timeoutMs}'] });
});
webAiServer.on('error', function (e) { log('[webai] 桥服务起不来（端口 ' + WEB_AI_PORT + '）：' + e.message); });
// 2026-11-04：自动更新 / 强制更新模块不随公开版发布（文件已删除）。

// ===== 原生浏览器侧栏挂载（官方 apps/desktop 能力搬迁 ③ · 2026-09-26）=====
// 独立模块 scripts/sidebar.js：WebContentsView 贴到主窗口 contentView（官方 platform-view.ts 同款做法）。
// ★ 未 attach 时对工作台零影响；不碰场景 json / sessionId / 渲染层注入。
// 会话入口：node scripts\浏览器侧栏.mjs [open|close|url|bounds|state]
try {
  require('./scripts/sidebar.js').install({ log: log });
} catch (e) {
  log('[sidebar] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 崩溃上报 + 版本策略挂载（官方 apps/desktop 能力搬迁 ④ · 2026-09-26）=====
// 独立模块 crash.js：本地崩溃转储（不上传）+ 主进程异常流水 data\crash-log.jsonl + 版本策略 data\version-policy.json。
// 全部 try/catch 吞掉 ⇒ 记不下来也不影响使用；不弹窗、不拦启动。
try {
  require('./crash.js').install({ log: log, appendLog: function (m) { try { log(m) } catch (e) { warnOnce("main", e) } } });
} catch (e) {
  log('[crash] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 外部刷新通道（2026-09-26 立；AI 会话自助刷新，不再让用户手点 ⟳）=====
// 背景：工作台是「零构建 + 单文件渲染器 + ⟳ 热更」，而 ⟳ 以前只能人手点 ⇒ 每次改完 renderer 都要用户动手。
// 现在：任何进程写 data/reload-panels.cmd（内容 all 或场景 id）⇒ 本进程 500ms 内重载匹配的 webview 面板。
// 会话用法：node scripts\刷新面板.mjs all
const RELOAD_CMD = path.join(SHELL_DATA_DIR, 'reload-panels.cmd');
// 2026-10-16：顶栏状态区文件的"版本哨"——启动时先记一份 mtime，之后只要它变了就把主窗口整页重载一次
// （不这样记，第一条刷新命令只会"记录"、第二条才重载，白等一轮）。
try { global.__dshTopbarMtime = fs.statSync(path.join(__dirname, 'renderer', 'topbar-status.js')).mtimeMs; }
catch (e) { global.__dshTopbarMtime = undefined; }
setInterval(function () {
  try {
    if (!fs.existsSync(RELOAD_CMD)) return;
    var target = String(fs.readFileSync(RELOAD_CMD, 'utf8')).trim() || 'all';
    fs.unlinkSync(RELOAD_CMD);
    var views = webContents.getAllWebContents().filter(function (wc) {
      try { return wc.getType() === 'webview' && !wc.isDestroyed(); } catch (e) { return false; }
    });
    var hit = target === 'all' ? views : views.filter(function (wc) {
      try { var u = String(wc.getURL()); return u.indexOf(target) >= 0 || u.indexOf(encodeURIComponent(target)) >= 0; } catch (e) { return false; }
    });
    hit.forEach(function (wc) { try { wc.reload(); } catch (e) { warnOnce("main", e) } });

    // 2026-10-16 补（界面侧）：顶栏状态区 `renderer\topbar-status.js` 是靠 index.html 的 <script> 加载的，
    //   而下面那条"主窗口热更新"只 executeJavaScript(reloadScene()) ⇒ **不会重新执行页面脚本** ⇒ 改了它主窗口永远不变
    //   （当天实测：连改 4 轮、顶栏一动不动，全是这个原因）。
    //   办法：记一份它的 mtime，**只有它变了**才整页重载主窗口；其余情况照旧走 reloadScene（不打扰 Harness 对话）。
    try {
      var tf = path.join(__dirname, 'renderer', 'topbar-status.js');
      var tm = fs.statSync(tf).mtimeMs;
      if (global.__dshTopbarMtime === undefined) {
        global.__dshTopbarMtime = tm;
      } else if (global.__dshTopbarMtime !== tm) {
        global.__dshTopbarMtime = tm;
        log('[reload-panels] topbar-status.js 变了 ⇒ 整页重载主窗口（让它重新执行）');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
      }
    } catch (e) { warnOnce("main", e) }

    // 2026-09-27 补：<客户> OA 这类「同页 div 面板」不是 webview，上面那条重载碰不到它们。
    // 再让窗口跑一次它自己的热更新（重灌带时间戳的 renderers.js，**不重载页面** ⇒ Harness 对话不断）。
    // 2026-09-29 修：以前只热更新 mainWindow ⇒ 跑在**独立场景窗口**里的面板永远刷不到
    //   （主窗口对"已分离"的场景只画一张占位卡然后 return，所以 renderer 改动在那边全都不生效——
    //    当天就撞上：改了 renderers.js，独立窗口里的「<机主>的分析助手」既不换标题也没有新页签）。
    //   现在按 target 选窗口：场景 id ⇒ 该场景的独立窗口 + 主窗口（主窗口自己判断要不要重建，currentTab 是渲染层状态）；
    //   all ⇒ 所有窗口。**不顺手重建无关窗口**——那会把别的窗口里的 AI 面板一起重建。
    try {
      var js = '(function(){try{ if (typeof reloadScene === "function") { reloadScene(); return "ok"; }'
        + ' if (window.__dshReloadScene) { window.__dshReloadScene(); return "ok-hook"; } return "no-fn"; }'
        + 'catch(e){ return "err:" + ((e && e.message) || e); }})()';
      var wins = allWindows();
      var targets = wins.filter(function (w) {
        if (target === 'all') return true;
        if (w === mainWindow) return true;                    // 主窗口的重建交给它自己的 reloadScene
        try { return String(w.kunScene || '') === target; } catch (e) { return false; }
      });
      targets.forEach(function (w) {
        var tag;
        try { tag = (w === mainWindow) ? '主窗口' : ('独立窗口[' + (w.kunScene || '') + ']'); } catch (e) { tag = '窗口'; }
        w.webContents.executeJavaScript(js).then(function (r) {
          log('[reload-panels] ' + tag + ' 热更新结果: ' + r);
          // 2026-09-27：CSP 是 script-src 'self'（无 unsafe-eval）⇒ eval 这条路随时可能被挡，
          // 一旦够不着（no-fn / err:…）就退回整页重载：不依赖 eval、不依赖动态插 script，必然读到新 renderers.js。
          if (r === 'no-fn' || String(r).indexOf('err:') === 0) {
            log('[reload-panels] ' + tag + ' 热更新够不着 ⇒ 整页重载该窗口');
            try { w.webContents.reloadIgnoringCache(); } catch (e2) { warnOnce("main", e2) }
          }
        }).catch(function (e) {
          log('[reload-panels] ' + tag + ' executeJavaScript 被拒（多半是 CSP）⇒ 整页重载该窗口: ' + ((e && e.message) || e));
          try { w.webContents.reloadIgnoringCache(); } catch (e2) { warnOnce("main", e2) }
        });
      });
      log('[reload-panels] 同页面板热更新窗口: ' + targets.length + '/' + wins.length + ' 个');
    } catch (e) { warnOnce("main", e) }
    log('[reload-panels] ' + target + ' ⇒ 重载 ' + hit.length + '/' + views.length + ' 个面板');
  } catch (e) { warnOnce("main", e) }
}, 500);

webAiServer.listen(WEB_AI_PORT, '127.0.0.1', function () {
  log('[webai] 网页版 AI 桥已就绪: http://127.0.0.1:' + WEB_AI_PORT + '/webai/keys（会话可用 scripts\\webai.mjs 问免费网页版）');
});

// ---- git 面板（程序开发场景，只读）：分支 / 工作区变更 / 最近提交 ----
//   为什么放主进程：渲染层没有 Node、也不该自己拼 shell。这里一律 execFile('git', [...])，不经 shell。
//   只读：不 add / commit / push —— 提交仍由会话按项目的 doc\提交准则.md 走。
//   缺这段 = 主进程是旧的 ⇒ 面板显示「重启一次工作台」，不会白屏。
ipcMain.handle('kun:git:panel', async (_e, repo) => {
  const dir = String(repo || '').trim();
  if (!dir) return { ok: false, err: '面板没配仓库路径（场景 json 的 meta.repo）' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const run = (args) => new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, ...args],
      { windowsHide: true, maxBuffer: 8 << 20, timeout: 20000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  const [head, changes, log, stat, unmerged, gitDir] = await Promise.all([
    run(['status', '--porcelain=v1', '--ignored=no', '-b']),
    // 2026-11-19 用户报「未跟踪里冒出两个目录行、看不到具体文件」：git 默认 -unormal 会把整个
    // 未跟踪目录折叠成一行 "?? dir/"（面板只能画成 · 徽标的目录行，也没法单独勾选提交）。
    // 这里加 --untracked-files=all 展开到具体文件，与合并预检（下方 status -z -uall）口径一致。
    run(['status', '--porcelain=v1', '--ignored=no', '--untracked-files=all']),
    run(['log', '-60', '--date=format:%m-%d %H:%M', '--pretty=%H|%h|%an|%ad|%p|%s']),
    run(['diff', '--shortstat']),
    run(['ls-files', '-u', '-z']),
    run(['rev-parse', '--git-dir'])
  ]);
  if (!head.ok) {
    const msg = String(head.err || '').trim();
    return { ok: false, err: /not a git repository/i.test(msg) ? '不是 git 仓库：' + dir : (msg || 'git 调用失败（本机装了 git 吗？）') };
  }
  // 1) 首行形如：## main...origin/main [ahead 2, behind 1]
  const first = String(head.out).split(/\r?\n/)[0] || '';
  const branch = (first.match(/^## ([^.\s]+)/) || [null, ''])[1];
  const upstream = (first.match(/\.\.\.([^\s\[]+)/) || [null, ''])[1];
  const ahead = Number((first.match(/ahead (\d+)/) || [null, 0])[1]);
  const behind = Number((first.match(/behind (\d+)/) || [null, 0])[1]);
  // 2) 变更清单：XY 路径（最多 60 条，面板不再往下拉）
  //    X = 暂存区、Y = 工作区，两位原样交给面板 —— 面板靠它分「已暂存 / 未暂存」；
  //    trim 掉会把 " M" 和 "M " 抹成一样，就分不出暂存没暂存了（显示时面板自己归一成一位）。
  //    2026-11-13 用户要求：被 .gitignore 忽略的目录与文件不在面板上出现。
  //      上面已加 --ignored=no（git 正常不会吐 `!!`）；这里再兜一道 —— 万一本机 git 版本或配置
  //      把 ignored 条目带回来，也不让它进清单（`.dsh/`、`引擎/`、`node_modules/` 这类一屏全是噪音）。
  const items = String(changes.out).split(/\r?\n/).filter(Boolean)
    .filter((l) => !l.startsWith('!!'))
    .slice(0, 60)
    .map((l) => ({ code: l.slice(0, 2) || '?', path: l.slice(3) }));
  // 3) 最近 8 条提交：hash|date|subject
  const commits = String(log.out).split(/\r?\n/).filter(Boolean).map((l) => {
    const p = l.split('|');
    return { full: p[0], hash: p[1], author: p[2], date: p[3], parents: p[4] || '', subject: p.slice(5).join('|') };
  });
  // 4) 分支：本地（带 upstream 与领先/落后）+ 远程（含 origin/HEAD 之外的引用）
  const [cur, locals, remotes] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:relative)|%(subject)', 'refs/heads']),
    run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)|%(committerdate:relative)|%(subject)', 'refs/remotes'])
  ]);
  const track = (t) => ({ ahead: Number((String(t).match(/ahead (\d+)/) || [null, 0])[1]), behind: Number((String(t).match(/behind (\d+)/) || [null, 0])[1]) });
  const local = String(locals.out).split(/\r?\n/).filter(Boolean).map((l) => {
    const p = l.split('|'); const t = track(p[2] || '');
    return { name: p[0], upstream: p[1] || '', ahead: t.ahead, behind: t.behind, when: p[3] || '', subject: p[4] || '' };
  });
  const remote = String(remotes.out).split(/\r?\n/).filter(Boolean)
    .filter((l) => { const n = l.split('|')[0] || ''; return n.indexOf('/') > 0 && !/\/HEAD$/.test(n); })
    .map((l) => { const p = l.split('|'); return { name: p[0], when: p[1] || '', subject: p[2] || '' }; });
  const current = String(cur.out || '').trim();
  // 5) 合并没收尾？（MERGE_HEAD 在 = 上次 merge 留了冲突）：面板要靠它常驻一条「解决冲突」入口，
  //    否则冲突现场只能靠命令行收，宿主说「让我通过工具先解决冲突再合并」就落不了地。
  const gdRaw = String(gitDir.out || '').trim();
  const gd = gdRaw ? (path.isAbsolute(gdRaw) ? gdRaw : path.join(dir, gdRaw)) : path.join(dir, '.git');
  const mergeFiles = [];
  splitZ(unmerged.out).forEach((rec) => {
    const tab = rec.indexOf('\t');
    if (tab < 0) return;
    const p = rec.slice(tab + 1);
    if (p && !mergeFiles.some((x) => x.path === p)) mergeFiles.push({ path: p, code: '' });
  });
  const codeMap = {};
  items.forEach((c) => { codeMap[c.path] = c.code; });
  mergeFiles.forEach((f) => { f.code = codeMap[f.path] || 'UU'; });
  // 合并冲突有两种现场：① MERGE_HEAD 在（合并本身没提交）；② 合并已提交、--autostash 恢复本地改动时撞车
  //   （没有 MERGE_HEAD，但 stash 顶部是 autostash）。第二种以前会被当成「工作区干净」，冲突看不见。
  const mergeHead = fs.existsSync(path.join(gd, 'MERGE_HEAD'));
  let autostash = mergeHead ? fs.existsSync(path.join(gd, 'MERGE_AUTOSTASH')) : false;
  // 第二种现场没有 MERGE_HEAD、冲突也可能已经全部标记解决，但 stash 顶部还压着 autostash ——
  //   必须继续算「未收尾」，否则卡片一消失，「完成」没得点，autostash 永远留在 stash 里。
  if (!mergeHead) {
    const hasStash = fs.existsSync(path.join(gd, 'refs', 'stash')) || fs.existsSync(path.join(gd, 'logs', 'refs', 'stash'));
    if (hasStash) {
      const sl = await run(['stash', 'list']);
      const first = String(sl.out || '').split(/\r?\n/).filter(Boolean)[0] || '';
      autostash = first.replace(/^stash@\{\d+\}:\s*/, '').trim() === 'autostash';
    }
  }
  const kind = mergeHead ? 'merge' : (autostash ? 'local' : (mergeFiles.length ? 'unmerged' : ''));
  const active = mergeHead || mergeFiles.length > 0 || autostash;
  return {
    ok: true, repo: dir, branch, upstream, ahead, behind, current, branches: { local, remote },
    changes: items, commits, diffStat: String(stat.out || '').trim(),
    merge: { active, kind, files: mergeFiles, autostash }
  };
});

// ---- git 单文件 diff（审查用）：把 未暂存 + 已暂存 两段差异写成临时文本，交给预览面板打开 ----
//   为什么落地成文件：预览面板是按"路径"取内容的，写一份临时 .txt 最省事，也不改仓库任何东西。
ipcMain.handle('kun:git:diff', async (_e, repo, file, hash) => {
  const dir = String(repo || '').trim();
  const rel = String(file || '').trim();
  if (!dir || !rel) return { ok: false, err: '缺少仓库或文件路径' };
  // 1. 先备好跑 git 的壳子：下面「指定提交」那段也要用它（以前它声明在后面，
  //    历史页双击文件看改动会踩 TDZ ⇒ ReferenceError，表现就是「点了没反应」）
  const run = (args) => new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, ...args],
      { windowsHide: true, maxBuffer: 16 << 20, timeout: 20000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  // 指定了提交 ⇒ 看那次提交里这个文件的改动（历史详情用）
  if (hash) {
    const rr = await run(['show', '--no-renames', '--no-color', String(hash), '--', rel]);
    if (!rr.ok) return { ok: false, err: String(rr.err || '').trim() || 'git show 失败' };
    const p2 = path.join(os.tmpdir(), 'dsh-git-diff-' + crypto.createHash('sha1').update(dir + '|' + hash + '|' + rel).digest('hex').slice(0, 10) + '.txt');
    fs.writeFileSync(p2, '# ' + rel + ' @ ' + hash + '\n\n' + rr.out, 'utf8');
    return { ok: true, path: p2, bytes: Buffer.byteLength(rr.out) };
  }
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const [unstaged, staged, st] = await Promise.all([
    run(['diff', '--no-color', '--', rel]),
    run(['diff', '--cached', '--no-color', '--', rel]),
    run(['status', '--porcelain=v1', '--', rel])
  ]);
  if (!unstaged.ok) return { ok: false, err: unstaged.err || 'git diff 失败' };
  const parts = [];
  if (staged.out.trim()) parts.push('### 已暂存（staged）\n' + staged.out.trim());
  if (unstaged.out.trim()) parts.push('### 未暂存（working tree）\n' + unstaged.out.trim());
  // 未跟踪文件没有 diff：直接给前 400 行，标成新增
  if (!parts.length && /^\?\?/m.test(st.out)) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) {
      const body = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(0, 400).map((l) => '+ ' + l).join('\n');
      parts.push('### 新文件（未跟踪）\n' + body);
    }
  }
  if (!parts.length) return { ok: false, err: '这个文件没有可显示的差异（可能没改动，或整份都是二进制）' };
  const head = '# ' + rel + '\n# 仓库：' + dir + '\n\n';
  const outPath = path.join(os.tmpdir(), 'dsh-git-diff-' + crypto.createHash('sha1').update(dir + '|' + rel).digest('hex').slice(0, 10) + '.txt');
  fs.writeFileSync(outPath, head + parts.join('\n\n'), 'utf8');
  return { ok: true, path: outPath, bytes: Buffer.byteLength(parts.join('\n')) };
});

// ---- git 切分支 / fetch（写操作：只动工作区，不改远程）----
//   工作区有未提交改动时默认拒绝（force=true 才继续）——切分支会覆盖/带走改动，不能默默来。
ipcMain.handle('kun:git:switch', async (_e, repo, name, opts) => {
  const dir = String(repo || '').trim();
  const target = String(name || '').trim();
  const force = !!(opts && opts.force);
  if (!dir || !target) return { ok: false, err: '缺少仓库或分支名' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const run = (args) => new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, ...args],
      { windowsHide: true, maxBuffer: 8 << 20, timeout: 60000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  const st = await run(['status', '--porcelain=v1']);
  const dirty = String(st.out).split(/\r?\n/).filter(Boolean).length;
  if (dirty && !force) return { ok: false, code: 'dirty', dirty, err: '工作区有 ' + dirty + ' 处未提交改动' };
  const isRemote = target.indexOf('/') > 0;                      // origin/xxx
  const localName = isRemote ? target.split('/').slice(1).join('/') : target;
  const r = isRemote ? await run(['switch', '-c', localName, '--track', target]) : await run(['switch', target]);
  if (!r.ok) return { ok: false, err: String(r.err || '').trim() || '切换失败' };
  return { ok: true, branch: localName, dirty, fromRemote: isRemote };
});

// ---- git 远端操作公共件（2026-11-18 宿主：fetch 要真有用、拉取要自己判冲突）----
//   1. 一律 execFile（不经 shell），参数逐个传；超时 / maxBuffer 统一，失败原样交回 git 的 stderr
//   2. --no-optional-locks：只读查询不抢 index.lock，别和外部编辑器 / 命令行的 git 打架
function gitRun(dir, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, ...args],
      { windowsHide: true, maxBuffer: 16 << 20, timeout: timeoutMs || 60000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}
// porcelain v1 -z：一条 = "XY 路径\0"；重命名/复制后面还跟一个「原路径」字段，必须一起读掉，
//   否则下一条会被错位当成路径。中文、空格路径只有 -z 读法可靠，别用按行切。
function parseStatusZ(out) {
  const parts = String(out || '').split('\0');
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const code = rec.slice(0, 2);
    const p = rec.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++;      // 跳过紧随其后的原路径
    rows.push({ code, path: p });
  }
  return rows;
}
// NUL 分隔的路径清单（diff --name-only -z / ls-files -u -z 都用它）
function splitZ(out) { return String(out || '').split('\0').filter(Boolean); }
// 当前没标记解决的冲突文件（ls-files -u：record = "mode oid stage\tpath"）
async function unmergedPaths(dir) {
  const r = await gitRun(dir, ['ls-files', '-u', '-z']);
  const rows = [];
  splitZ(r.out).forEach((rec) => {
    const tab = rec.indexOf('\t');
    if (tab >= 0) rows.push(rec.slice(tab + 1));
  });
  return Array.from(new Set(rows));
}
// git merge-tree（2.38+）：**不碰工作区、不动索引**地试算一次合并，exit 1 = 有冲突。
//   返回 { supported, conflicts }；老 git 不认 --write-tree ⇒ supported=false，交给真合并兜底。
async function mergeTreeConflicts(dir, upstream) {
  const r = await gitRun(dir, ['merge-tree', '--write-tree', '--no-messages', '-z', 'HEAD', upstream], 60000);
  if (r.ok) return { supported: true, conflicts: [] };
  const err = String(r.err || '');
  if (/unknown option|unknown switch|usage: git merge-tree/i.test(err)) return { supported: false, conflicts: [] };
  const rows = [];
  String(r.out || '').split('\0').forEach((rec, idx) => {
    if (!rec || idx === 0) return;                    // 第 1 段是试算出来的树 OID
    const tab = rec.indexOf('\t');
    if (tab >= 0) rows.push(rec.slice(tab + 1));      // "mode oid stage\tpath"
  });
  return { supported: true, conflicts: Array.from(new Set(rows)) };
}
// .git 目录的绝对路径（工作树里的 .git 可能是文件；rev-parse 已经处理好这种情况）
async function gitDirPath(dir) {
  const r = await gitRun(dir, ['rev-parse', '--git-dir'], 30000);
  const raw = String(r.out || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(dir, raw);
}
// autostash（git merge --autostash 自己压的那条暂存）：恢复时撞车会留在 stash 顶部，主题固定是 autostash。
//   用户自己的 stash 可能就在它下面，所以只认「顶部主题恰好是 autostash」这一条，绝不 stash pop 到别人的。
async function stashTopIsAutostash(dir) {
  // 注意：别用 --format=%s —— stash 的 %s 是提交主题「On main: autostash」，
  //   默认 `git stash list` 输出的才是 reflog 消息「stash@{0}: autostash」，这里按后者认。
  const r = await gitRun(dir, ['stash', 'list'], 30000);
  const first = String(r.out || '').split(/\r?\n/).filter(Boolean)[0] || '';
  const msg = first.replace(/^stash@\{\d+\}:\s*/, '').trim();
  return r.ok && msg === 'autostash';
}
async function dropAutostashIfAny(dir) {
  if (!(await stashTopIsAutostash(dir))) return false;
  const r = await gitRun(dir, ['stash', 'drop'], 30000);
  return !!r.ok;
}

ipcMain.handle('kun:git:fetch', async (_e, repo) => {
  const dir = String(repo || '').trim();
  if (!dir || !fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  // 1) 当前分支；detached 没有跟踪关系可认 ⇒ 退回 fetch 所有远端
  const br = await gitRun(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = String(br.out || '').trim();
  const detached = !branch || branch === 'HEAD';
  // 2) **只 fetch 当前分支跟踪的那一个远端**：原来的 --all 会把无关 remote（本仓的 upstream 是原项目）
  //    也拉一遍，任意一个慢 / 要凭据就整体失败，宿主体感就是「fetch 没用」。
  let remote = '';
  if (!detached) remote = String((await gitRun(dir, ['config', '--get', 'branch.' + branch + '.remote'])).out || '').trim();
  const args = remote ? ['fetch', '--prune', remote] : ['fetch', '--prune', '--all'];
  const f = await gitRun(dir, args, 120000);
  if (!f.ok) return { ok: false, err: String(f.err || '').trim() || 'fetch 失败（网络或凭据？）' };
  // 3) fetch 完再算「本地缺哪些提交」：面板能说人话、还能列出取到了什么
  let upstream = '', behind = 0, ahead = 0, incoming = [];
  if (!detached) {
    upstream = String((await gitRun(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).out || '').trim();
    if (upstream) {
      const cnt = await gitRun(dir, ['rev-list', '--left-right', '--count', upstream + '...HEAD']);
      const nums = String(cnt.out || '').trim().split(/\s+/);
      behind = Number(nums[0] || 0); ahead = Number(nums[1] || 0);
      if (behind) {
        const lg = await gitRun(dir, ['log', '--date=format:%m-%d %H:%M', '--pretty=%H|%h|%an|%ad|%s', 'HEAD..' + upstream, '-20']);
        incoming = String(lg.out || '').split(/\r?\n/).filter(Boolean).map((l) => {
          const p = l.split('|');
          return { full: p[0], hash: p[1], author: p[2], date: p[3], subject: p.slice(4).join('|') };
        });
      }
    }
  }
  return { ok: true, branch: detached ? '' : branch, remote: remote || '(all remotes)', upstream, behind, ahead, incoming, out: String(f.out || '').trim() };
});

// ---- git push / pull（右键菜单的 Push / Update）----
//   为什么单开两条：提交区的「Commit and Push」只覆盖“先提交再推”；从别的分支切过来、
//   或本地早有提交只想推上去 / 只想把远程更新拉下来时，需要一个不碰工作区的独立入口。
//   push：有 upstream 直接 push，没 upstream 就 -u origin <当前分支>；detached HEAD 拒绝（推不出去，也不知道推哪条）。
//   pull（Update）：具体判定见下面 kun:git:pull 的注释（先判冲突，无冲突直接合）。
ipcMain.handle('kun:git:push', async (_e, repo) => {
  const dir = String(repo || '').trim();
  if (!dir) return { ok: false, err: '缺少仓库路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const run = (args) => new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, ...args],
      { windowsHide: true, maxBuffer: 16 << 20, timeout: 120000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  const br = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = String(br.out || '').trim();
  if (!branch || branch === 'HEAD') return { ok: false, code: 'detached', err: '当前是 detached HEAD，先切到分支再推' };
  const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = String(up.out || '').trim();
  const hasUp = up.ok && !!upstream;
  const p = hasUp ? await run(['push']) : await run(['push', '-u', 'origin', branch]);
  if (!p.ok) {
    const err = String(p.err || '').trim() || 'git push 失败（网络或凭据？）';
    // 非快进 = 远程有本地没有的提交，界面提示先 Update，不替用户强制推
    const code = /non-fast-forward|fetch first|rejected|behind/i.test(err) ? 'behind' : 'err';
    return { ok: false, code, err };
  }
  return { ok: true, branch, upstream: hasUp ? upstream : ('origin/' + branch), newUpstream: !hasUp, out: String(p.out || '').trim() };
});

// ---- git pull（Update）：先 fetch，再**先判冲突**；没冲突直接合，有冲突交给面板解决 ----
//   宿主 2026-11-18：「有冲突让我通过工具先解决冲突再合并，没有冲突就直接合并，不用询问」。
//   所以不再因为「工作区脏」整单拒绝：
//     ① 远程改动没碰到的本地未提交文件 ⇒ 合并根本不会碰它们，直接合；
//     ② 会碰到的 ⇒ 回 code=conflict + 文件清单，工作区一个字不动；
//     ③ 提交级冲突 ⇒ git merge-tree 试算（不碰工作区）先列出来，别等合到一半才发现。
//   allowConflict=true（面板「合并并解决冲突」按钮）才真的合入并留下冲突标记，供面板逐个处理。
ipcMain.handle('kun:git:pull', async (_e, repo, opts) => {
  const dir = String(repo || '').trim();
  const o = opts || {};
  const mode = o.mode === 'rebase' ? 'rebase' : 'merge';   // 默认合并：不再问「合并还是变基」
  const allowConflict = !!o.allowConflict;
  if (!dir) return { ok: false, err: '缺少仓库路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  // 0) 上一次拉取还留着合并现场 / autostash：先收尾，别再叠一次 merge --autostash
  const gd0 = await gitDirPath(dir);
  if (gd0 && fs.existsSync(path.join(gd0, 'MERGE_HEAD'))) return { ok: false, code: 'merging', err: '上一次合并还没收尾：先在冲突卡里完成或放弃，再更新' };
  if (await stashTopIsAutostash(dir)) return { ok: false, code: 'merging', err: '上一次拉取留下的本地改动还没收尾：先在冲突卡里完成或放弃更新，再更新' };
  // 1) 分支与 upstream：detached / 没跟踪就没法拉
  const br = await gitRun(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = String(br.out || '').trim();
  if (!branch || branch === 'HEAD') return { ok: false, code: 'detached', err: '当前是 detached HEAD，先切到分支再拉' };
  const up = await gitRun(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = String(up.out || '').trim();
  if (!up.ok || !upstream) return { ok: false, code: 'no-upstream', err: '当前分支没有 upstream；先 Push 一次建立跟踪' };
  // 2) fetch 当前分支跟踪的远端（同 fetch 的口径，不用 --all）
  const remote = String((await gitRun(dir, ['config', '--get', 'branch.' + branch + '.remote'])).out || '').trim();
  const f = await gitRun(dir, ['fetch', '--prune', remote || 'origin'], 120000);
  if (!f.ok) return { ok: false, code: 'fetch', err: String(f.err || '').trim() || 'fetch 失败（网络或凭据？）' };
  // 3) 引用层面算落后/领先（和工作区脏不脏无关）
  const cnt = await gitRun(dir, ['rev-list', '--left-right', '--count', upstream + '...HEAD']);
  const nums = String(cnt.out || '').trim().split(/\s+/);
  const behind = Number(nums[0] || 0);
  const ahead = Number(nums[1] || 0);
  if (!behind) return { ok: true, upToDate: true, branch, upstream, behind: 0, ahead, mode };
  // 4) 冲突预检：三类会让 git 拒绝合并 / 留冲突的情况
  //    4.1 本地未提交 vs 远程改动（以 merge-base 为界，只看远程这侧改了哪些文件）
  const diffHead = await gitRun(dir, ['diff', '--name-only', '--no-renames', '-z', 'HEAD...' + upstream]);
  if (!diffHead.ok) return { ok: false, code: 'err', behind, ahead, err: String(diffHead.err || '').trim() || '两段历史没有共同起点，git 拒绝合并' };
  const incomingChanged = splitZ(diffHead.out);
  const incomingAdded = splitZ((await gitRun(dir, ['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', 'HEAD...' + upstream])).out);
  const st = parseStatusZ((await gitRun(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).out);
  const dirtyMap = new Map(), untrackedMap = new Map();
  st.forEach((r) => { if (r.code === '??') untrackedMap.set(r.path, 1); else dirtyMap.set(r.path, r.code); });
  const dirtyHit = incomingChanged.filter((p) => dirtyMap.has(p));
  const untrackedHit = incomingAdded.filter((p) => untrackedMap.has(p));
  //    4.2 提交级冲突：merge-tree 试算（不创建工作区改动）；快进时不可能冲突，跳过省一次进程
  const mt = ahead ? await mergeTreeConflicts(dir, upstream) : { supported: true, conflicts: [] };
  const commitConflicts = mt.conflicts;
  const hasBlock = dirtyHit.length || untrackedHit.length || commitConflicts.length;
  if (hasBlock && !allowConflict) {
    return {
      ok: false, code: 'conflict', branch, upstream, behind, ahead, mode,
      dirtyHit, untrackedHit, commitConflicts,
      // 已跟踪的脏改动可以靠 merge --autostash 带进合并、事后在冲突卡里解决；
      // 未跟踪文件 autostash 管不到（会被远程新增覆盖），只能先提交/改名；变基模式不接 autostash。
      canForceMerge: mode === 'merge' && !untrackedHit.length,
      err: '拉取会冲突：' + (dirtyHit.length + untrackedHit.length + commitConflicts.length) + ' 个文件'
    };
  }
  // 5) 没冲突（或用户明确要「合入后解决」）：直接合；分叉默认 merge，不再弹合并/变基
  //    本地已跟踪的脏改动用 --autostash：Git 自己暂存 → 合并 → 自动恢复；恢复撞车会留冲突 + autostash，
  //    由下面的 code=local-conflict 交给面板逐个文件解决（不丢本地改动）。
  const useAuto = mode === 'merge' && dirtyHit.length > 0;
  const autoArg = useAuto ? ['--autostash'] : [];
  const args = mode === 'rebase' ? ['rebase', upstream]
    : (ahead ? ['merge', ...autoArg, '--no-edit', upstream] : ['merge', ...autoArg, '--ff-only', upstream]);
  const m = await gitRun(dir, args, 120000);
  if (!m.ok) {
    const err = String(m.err || '').trim() || '更新失败';
    if (mode === 'rebase') {
      await gitRun(dir, ['rebase', '--abort']);
      return { ok: false, code: 'rebase-conflict', behind, ahead, err };
    }
    // merge 留下的冲突：**保留现场**，面板能逐个文件解决（不自动 abort 把现场丢掉）
    const unmerged = await unmergedPaths(dir);
    if (unmerged.length) {
      return { ok: false, code: 'conflict', mergeInProgress: true, behind, ahead, mode, dirtyHit: [], untrackedHit: [], commitConflicts: [], unmerged, stashed: useAuto, err };
    }
    // 工作区挡住（本地改动 / 未跟踪文件被覆盖）或其它失败：回滚，别留半截合并
    await gitRun(dir, ['merge', '--abort']);
    const code = /would be overwritten|commit your changes|Please commit/i.test(err) ? 'worktree' : 'err';
    return { ok: false, code, behind, ahead, err };
  }
  // 6) 合并成功 ≠ 收工：--autostash 在恢复本地改动时可能撞车（Git 退出码仍是 0），
  //    留下未合并条目 + stash 顶部 autostash ⇒ 走「本地改动冲突」卡，不能当成已更新。
  if (useAuto) {
    const unmerged = await unmergedPaths(dir);
    if (unmerged.length) {
      return { ok: false, code: 'local-conflict', mergeInProgress: false, behind, ahead, mode, unmerged, stashed: true, err: '本地改动和拉取结果冲突：' + unmerged.length + ' 个文件' };
    }
  }
  return { ok: true, branch, upstream, behind, ahead, mode: (mode === 'rebase' ? 'rebase' : (ahead ? 'merge' : 'ff')), out: String(m.out || '').trim() };
});

// ---- git 冲突解决（合并留在工作区时，面板逐个文件处理）----
//   take：用某一侧整份覆盖（ours = 本地分支，theirs = 远程被合进来的那份），再 git add 标记已解决。
//   只动冲突文件，不碰别的路径；路径逐个走 argv，不经 shell。
ipcMain.handle('kun:git:conflict:take', async (_e, repo, file, side) => {
  const dir = String(repo || '').trim();
  const rel = String(file || '').trim();
  const which = side === 'theirs' ? '--theirs' : '--ours';
  if (!dir || !rel) return { ok: false, err: '缺少仓库或文件路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  // 0) 先确认它现在真的是冲突文件（ui 可能停在旧一帧，别对着普通文件乱 checkout / rm）
  const stages = await gitRun(dir, ['ls-files', '-u', '-z', '--', rel], 60000);
  const recs = splitZ(stages.out);
  if (!recs.length) return { ok: false, err: '这个文件当前没有冲突标记（可能已在别处解决）' };
  // 1) 这一侧有没有版本？stage 2 = 本地（ours），stage 3 = 远程（theirs）。
  //    没有版本 = 那一侧把这个文件删了 ⇒「取这一侧」就是删除（删除/修改型冲突也才能收尾）。
  const want = which === '--ours' ? '2' : '3';
  let hasSide = false;
  recs.forEach((rec) => {
    const tab = rec.indexOf('\t');
    if (tab < 0) return;
    const meta = rec.slice(0, tab).split(' ');
    if (meta[2] === want) hasSide = true;
  });
  if (!hasSide) {
    const rm = await gitRun(dir, ['rm', '-f', '--', rel], 60000);
    if (!rm.ok) return { ok: false, err: String(rm.err || '').trim() || '删除该侧版本失败' };
    return { ok: true, path: rel, side: which === '--theirs' ? 'theirs' : 'ours', deleted: true };
  }
  const t = await gitRun(dir, ['checkout', which, '--', rel], 60000);
  if (!t.ok) return { ok: false, err: String(t.err || '').trim() || '取该版本失败' };
  const a = await gitRun(dir, ['add', '-A', '--', rel], 60000);
  if (!a.ok) return { ok: false, err: String(a.err || '').trim() || 'git add 失败' };
  return { ok: true, path: rel, side: which === '--theirs' ? 'theirs' : 'ours' };
});
ipcMain.handle('kun:git:conflict:mark', async (_e, repo, file) => {
  const dir = String(repo || '').trim();
  const rel = String(file || '').trim();
  if (!dir || !rel) return { ok: false, err: '缺少仓库或文件路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const a = await gitRun(dir, ['add', '-A', '--', rel], 60000);
  if (!a.ok) return { ok: false, err: String(a.err || '').trim() || 'git add 失败' };
  return { ok: true, path: rel };
});
ipcMain.handle('kun:git:conflict:continue', async (_e, repo) => {
  const dir = String(repo || '').trim();
  if (!dir) return { ok: false, err: '缺少仓库路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  // 1) 还有没标记解决的冲突 ⇒ 拒绝：不能把半截合并提交上去
  const unmerged = await unmergedPaths(dir);
  if (unmerged.length) return { ok: false, code: 'unmerged', files: unmerged, err: '还有 ' + unmerged.length + ' 个文件没标记已解决' };
  const gd = await gitDirPath(dir);
  // 2) 没有 MERGE_HEAD = 拉取已经完成，只是 --autostash 恢复本地改动时撞了：
  //    全部标记解决 ⇒ 丢掉 autostash（内容已经在工作区 / 索引里），不需要再提交。
  if (!gd || !fs.existsSync(path.join(gd, 'MERGE_HEAD'))) {
    const had = await stashTopIsAutostash(dir);
    const dropped = await dropAutostashIfAny(dir);
    if (had && !dropped) return { ok: false, err: '冲突已解决，但 autostash 没删掉（可能被锁）；再点一次「完成」' };
    return { ok: true, concluded: 'local', dropped };
  }
  // 3) 真正的合并现场：git commit --no-edit 收尾（Git 此时会把 autostash 一并恢复）
  const c = await gitRun(dir, ['commit', '--no-edit'], 120000);
  if (!c.ok) {
    // 提交失败，但 autostash 可能已经应用并留下冲突（Git 有时退出码仍是 0，所以下面再查一次）
    const afterErr = await unmergedPaths(dir);
    if (afterErr.length) return { ok: false, code: 'local-conflict', mergeInProgress: false, unmerged: afterErr, stashed: true, err: '合并已提交，但本地改动恢复时冲突：' + afterErr.length + ' 个文件' };
    return { ok: false, err: String(c.err || '').trim() || '合并收尾失败' };
  }
  // 4) 提交成功后再查：autostash 在提交之后才应用，撞车会留下未合并条目
  const after = await unmergedPaths(dir);
  if (after.length) return { ok: false, code: 'local-conflict', mergeInProgress: false, unmerged: after, stashed: true, err: '合并已提交，但本地改动恢复时冲突：' + after.length + ' 个文件' };
  const had = await stashTopIsAutostash(dir);
  const dropped = await dropAutostashIfAny(dir);
  if (had && !dropped) return { ok: false, err: '合并已完成，但 autostash 没删掉（可能被锁）；再点一次「完成」' };
  return { ok: true, concluded: 'merge', dropped, out: String(c.out || '').trim() };
});
ipcMain.handle('kun:git:conflict:abort', async (_e, repo) => {
  const dir = String(repo || '').trim();
  if (!dir) return { ok: false, err: '缺少仓库路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const gd = await gitDirPath(dir);
  // 1) 合并还没提交：merge --abort（Git 会把 autostash 一起还回来）
  if (gd && fs.existsSync(path.join(gd, 'MERGE_HEAD'))) {
    const r = await gitRun(dir, ['merge', '--abort'], 60000);
    if (!r.ok) return { ok: false, err: String(r.err || '').trim() || '放弃合并失败' };
    return { ok: true, undone: 'merge' };
  }
  // 2) 合并已提交、只是本地改动恢复时冲突：回到合并前的 ORIG_HEAD，再把 autostash 恢复出来
  //    冲突可能已经全部标记解决（unmerged 为空）但「完成」还没点 ⇒ 同样允许放弃（丢掉解决结果、恢复脏改动）。
  if (!(await stashTopIsAutostash(dir))) return { ok: false, err: '当前没有可放弃的更新' };
  const origR = await gitRun(dir, ['rev-parse', 'ORIG_HEAD'], 30000);
  const orig = String(origR.out || '').trim();
  if (!orig) return { ok: false, err: '读不到合并前的 ORIG_HEAD，无法自动撤回' };
  const anc = await gitRun(dir, ['merge-base', '--is-ancestor', orig, 'HEAD'], 30000);
  if (!anc.ok) return { ok: false, err: 'ORIG_HEAD 不在当前历史里（之后可能又做过别的操作），为安全不自动 reset' };
  const rs = await gitRun(dir, ['reset', '--hard', orig], 60000);
  if (!rs.ok) return { ok: false, err: String(rs.err || '').trim() || '回到合并前失败' };
  const pop = await gitRun(dir, ['stash', 'pop'], 120000);
  if (!pop.ok) return { ok: false, undone: 'partial', err: '已回到拉取前，但本地改动恢复失败（autostash 还在，别丢）：' + (String(pop.err || '').trim() || 'stash pop 失败') };
  return { ok: true, undone: 'local' };
});

// ---- git 单次提交的文件清单（历史详情用）：git show --name-status ----
ipcMain.handle('kun:git:show', async (_e, repo, hash) => {
  const dir = String(repo || '').trim();
  const h = String(hash || '').trim();
  if (!dir || !h) return { ok: false, err: '缺少仓库或提交号' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const out = await new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, 'show', '--no-renames', '--name-status', '--format=', h],
      { windowsHide: true, maxBuffer: 16 << 20, timeout: 20000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  if (!out.ok) return { ok: false, err: String(out.err || '').trim() || 'git show 失败' };
  const files = String(out.out).split(/\r?\n/).filter(Boolean).map((l) => {
    const p = l.split('\t');
    return { code: (p[0] || '').slice(0, 1) || 'M', path: p[1] || '' };
  }).filter((x) => x.path);
  return { ok: true, hash: h, files };
});

// ---- git checkout 某个提交（detached HEAD）：右键菜单用 ----
ipcMain.handle('kun:git:checkout', async (_e, repo, rev, opts) => {
  const dir = String(repo || '').trim();
  const target = String(rev || '').trim();
  const force = !!(opts && opts.force);
  if (!dir || !target) return { ok: false, err: '缺少仓库或提交号' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const run = (args) => new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, ...args],
      { windowsHide: true, maxBuffer: 8 << 20, timeout: 60000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  const st = await run(['status', '--porcelain=v1']);
  const dirty = String(st.out).split(/\r?\n/).filter(Boolean).length;
  if (dirty && !force) return { ok: false, code: 'dirty', dirty, err: '工作区有 ' + dirty + ' 处未提交改动' };
  const r = await run(['switch', '--detach', target]);
  if (!r.ok) return { ok: false, err: String(r.err || '').trim() || 'checkout 失败' };
  return { ok: true, rev: target, dirty };
});

// ---- git commit / commit and push（IDEA Local Changes 的提交区）----
//   只提交勾选的路径：先 git add -A -- <paths>，再 git commit -F <msg> -- <paths>，
//   这样不会把别人已暂存的内容带进来。
//   消息不校验格式：面板是给人手写的，写什么就提交什么；type(scope) 只约束 AI 代办的提交。
ipcMain.handle('kun:git:commit', async (_e, repo, files, message, opts) => {
  const dir = String(repo || '').trim();
  const o = opts || {};
  const paths = (Array.isArray(files) ? files : []).map(String).filter(Boolean);
  const msg = String(message || '').trim();
  if (!dir) return { ok: false, err: '缺少仓库路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  if (!paths.length) return { ok: false, err: '没有勾选要提交的文件' };
  if (!msg && !o.amend) return { ok: false, err: '提交信息不能为空' };
  // 合并没收尾时拒绝提交：git commit -- <paths> 会把半截合并提交上去，先让面板把冲突处理完
  const gd = await gitDirPath(dir);
  if (gd && fs.existsSync(path.join(gd, 'MERGE_HEAD'))) return { ok: false, code: 'merging', err: '合并还没收尾：先在冲突卡里完成或放弃合并，再提交' };
  // autostash 还压在 stash 顶部 = 拉取的本地改动没收尾（冲突可能已全部标记，但没点「完成」）
  if (await stashTopIsAutostash(dir)) return { ok: false, code: 'merging', err: '拉取留下的本地改动还没收尾：先在冲突卡里点「完成」或「放弃更新」，再提交' };
  const run = (args) => new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, ...args],
      { windowsHide: true, maxBuffer: 16 << 20, timeout: 120000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  const add = await run(['add', '-A', '--', ...paths]);
  if (!add.ok) return { ok: false, err: String(add.err || '').trim() || 'git add 失败' };
  const msgFile = path.join(os.tmpdir(), 'dsh-git-msg-' + Date.now() + '.txt');
  fs.writeFileSync(msgFile, msg, 'utf8');
  const args = ['commit'];
  if (msg) args.push('-F', msgFile);
  else args.push('--no-edit');
  if (o.amend) args.push('--amend');
  args.push('--', ...paths);
  const c = await run(args);
  try { fs.unlinkSync(msgFile); } catch (e) { warnOnce("main", e) }
  if (!c.ok) return { ok: false, err: String(c.err || '').trim() || 'git commit 失败' };
  let pushed = null;
  let pushErr = '';
  if (o.push) {
    const br = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = String(br.out || '').trim();
    if (!branch || branch === 'HEAD') return { ok: true, pushed: false, pushErr: '当前是 detached HEAD，不能 push' };
    const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const hasUp = up.ok && String(up.out || '').trim();
    const p = hasUp ? await run(['push']) : await run(['push', '-u', 'origin', branch]);
    pushed = !!p.ok;
    pushErr = p.ok ? '' : (String(p.err || '').trim() || 'git push 失败');
  }
  return { ok: true, pushed: pushed, pushErr: pushErr };
});

// ---- 按分支/引用取历史（分支下拉双击 = 看该分支的提交）----
ipcMain.handle('kun:git:log', async (_e, repo, rev) => {
  const dir = String(repo || '').trim();
  const ref = String(rev || '').trim() || 'HEAD';
  if (!dir) return { ok: false, err: '缺少仓库路径' };
  if (!fs.existsSync(dir)) return { ok: false, err: '仓库目录不存在：' + dir };
  const r = await new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', dir, 'log', ref, '-60', '--date=format:%m-%d %H:%M', '--pretty=%H|%h|%an|%ad|%p|%s'],
      { windowsHide: true, maxBuffer: 16 << 20, timeout: 20000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
  if (!r.ok) return { ok: false, err: String(r.err || '').trim() || '读不到该分支的历史' };
  const commits = String(r.out).split(/\r?\n/).filter(Boolean).map((l) => {
    const p = l.split('|');
    return { full: p[0], hash: p[1], author: p[2], date: p[3], parents: p[4] || '', subject: p.slice(5).join('|') };
  });
  return { ok: true, rev: ref, commits };
});

// ---- git 面板的本机配置：变更单（自定义命名的文件分组）+ 不参与提交的路径规则 ----
//   2026-11-17 宿主：「idea 里的 new changelist」+「指定某个区域的文件不参与提交」。
//   落 外壳\data\git-变更单.json（本机运行数据，不入库，.gitignore 已挡 data/）；按仓库绝对路径分桶，切项目不串。
const GIT_CFG_FILE = path.join(SHELL_DATA_DIR, 'git-变更单.json');
async function readGitCfg() {
  try {
    const o = JSON.parse(await fs.promises.readFile(GIT_CFG_FILE, 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : { v: 1, repos: {} };
  } catch (e) {
    // 文件不存在 = 还没建过，按空配置起；读坏了（半截 JSON / 权限）要留痕，别让人以为配置自己没了
    if (e && e.code !== 'ENOENT') warnOnce('git-变更单', e);
    return { v: 1, repos: {} };
  }
}
ipcMain.handle('kun:git:lists-get', async () => ({ ok: true, data: await readGitCfg() }));
ipcMain.handle('kun:git:lists-set', async (_e, repo, one) => {
  const key = String(repo || '').trim();
  if (!key) return { ok: false, err: '缺少仓库路径' };
  if (!one || typeof one !== 'object' || Array.isArray(one)) return { ok: false, err: '配置格式不对（要一个对象）' };
  // 读-改-写：只覆盖本仓库这一桶，另一个窗口管别的仓库时不会被我这边的旧快照冲掉
  const all = await readGitCfg();
  if (!all.repos || typeof all.repos !== 'object' || Array.isArray(all.repos)) all.repos = {};
  all.repos[key] = one;
  all.v = 1;
  let text = '';
  try { text = JSON.stringify(all, null, 2); } catch (e) { return { ok: false, err: '配置序列化失败：' + String((e && e.message) || e) }; }
  if (text.length > (2 << 20)) return { ok: false, err: '配置过大（>2MB），没有写入' };
  try {
    await fs.promises.mkdir(path.dirname(GIT_CFG_FILE), { recursive: true });
    // 1) 先写临时文件再 rename：写到一半断电也不会留下半截 JSON
    const tmp = GIT_CFG_FILE + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, GIT_CFG_FILE);
    return { ok: true };
  } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
});
