'use strict';
// QQ自动注入.js —— 按「指定 QQ 号」在 SnowLuma 里挑进程注入（2026-11-19）
//
// 为什么不用 SnowLuma 自带的 hookAutoLoad：那个开关是「发现 QQ 主进程就注入」，
// 双开时会把主号和小号一起挂上（用户明确说「两个都接是不对的」）。
// 这一层用 SnowLuma 的 WebUI API（默认 5099）自己挑：
//   ① 进程列表里带 `--from-multiple-login <uin>` 的，直接认号；
//   ② 认不出的，按「最早启动优先」逐个试注入；登录出来的号不是目标就卸载，试下一个；
//   ③ 目标已经在线上（loggedIn 且 uin 对）→ 卸掉其它已注入的号，只留目标；
//   ④ 全部注入（autoLoadMode:'all'）保留，给单号/明确要全接的场景用。
//
// 配置在 `外壳\data\桥接.json`（本机文件，已 gitignore）：
//   autoLoadMode  'uin' | 'all' | 'off'（缺省按 autoLoadUin 是否有值推）
//   autoLoadUin   要接的 QQ 号（双开只留这个）
//   autoLoadProbe 认不出号时是否逐个试注入（默认 true；false = 只认命令行提示的号）
//   webuiPassword 5099 控制台密码（缺省用 bootstrapPassword；改过控制台密码就要填这个）
//
// 约束：只由 桥接.js 在 SnowLuma 起来后调用；不碰引擎、不碰 OneBot 端口（3000/3001 归 SnowLuma）。

const { execFile } = require('child_process');

const INTERVAL_MS = 8000;          // 进程发现轮询
const PROBE_WAIT_MS = 15000;       // 试注入后等登录的时间
const RETRY_MS = 60000;            // 没等到登录的进程，隔多久再试
const MAX_UNLOGGED_TRIES = 2;      // 没登录的进程最多试几次
const START_CACHE_MS = 30000;      // 读 QQ 启动时间的缓存
const LOGIN_BACKOFF_MS = [30000, 60000, 300000];

function createService(opts) {
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
  const baseUrl = String(opts.baseUrl || 'http://127.0.0.1:5099').replace(/\/+$/, '');
  const log = typeof opts.log === 'function' ? opts.log : function () {};

  let stopped = true;
  let timer = null;
  let ticking = false;
  let token = '';
  let loginFailCount = 0;
  let loginBlockUntil = 0;
  let probing = null;                 // { pid, deadline, known }
  let lastLogged = '';
  let startCacheAt = 0;
  let startCache = new Map();
  const ours = new Set();             // 本服务自动注入过的 pid
  const tried = new Map();            // pid -> { at, count, permanent }
  const state = {
    running: false, mode: 'off', targetUin: '', status: 'idle', detail: '',
    pid: 0, uin: '', at: 0, candidates: []
  };
  // 先把配置里的 mode/号写进状态：面板在第一次 tick 之前打开也能看到「只接 2531357970」
  const initial = normalizeConfig();
  state.mode = initial.mode;
  state.targetUin = initial.uin;

  // 1. 配置归一：显式 mode 优先；旧配置只有 autoLoadQq/autoLoadUin 时按值推
  function normalizeConfig() {
    const raw = getConfig() || {};
    let mode = String(raw.mode || '').toLowerCase();
    if (mode !== 'uin' && mode !== 'all' && mode !== 'off') {
      if (raw.enabled === false) mode = 'off';
      else if (String(raw.uin || '')) mode = 'uin';
      else mode = 'all';
    }
    return {
      mode: mode,
      uin: String(raw.uin || '').replace(/\D/g, ''),
      probe: raw.probe !== false,
      password: String(raw.password || '')
    };
  }

  // 2. 状态：只记变化，别让 8 秒轮询把日志刷满
  function setState(patch, candidates) {
    Object.assign(state, patch || {});
    if (Array.isArray(candidates)) {
      state.candidates = candidates.map((c) => ({
        pid: c.pid, uin: c.uin, injected: !!c.injected,
        loggedIn: !!c.loggedIn, connected: !!c.connected, status: c.status
      }));
    }
    state.at = Date.now();
    const key = [state.status, state.detail, state.uin, state.pid].join('|');
    if (key !== lastLogged) {
      lastLogged = key;
      if (state.detail) log(state.status + '：' + state.detail);
    }
  }

  function status() {
    return Object.assign({ ok: true, running: !stopped }, state);
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(function () { timer = null; tick(); }, ms);
    if (timer.unref) timer.unref();
  }

  // 3. HTTP：统一带 token；401 清 token 让下一轮重登
  async function request(pathname, method) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(baseUrl + pathname, {
      method: method || 'GET',
      headers: headers,
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(15000)
    });
    if (res.status === 401) { token = ''; throw new Error('unauthorized（控制台要重新登录）'); }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && (body.message || body.error)) || ('HTTP ' + res.status));
    return body || {};
  }

  // 4. 登录 5099：密码错了要退避，别把 5 次机会打光
  async function login(cfg) {
    if (!cfg.password) throw new Error('没配控制台密码：在 外壳\\data\\桥接.json 写 webuiPassword 或 bootstrapPassword');
    const res = await fetch(baseUrl + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: cfg.password }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.success === false || !body.token) {
      loginFailCount += 1;
      const wait = LOGIN_BACKOFF_MS[Math.min(loginFailCount - 1, LOGIN_BACKOFF_MS.length - 1)];
      loginBlockUntil = Date.now() + wait;
      throw new Error('控制台登录失败（密码不对？）：'
        + ((body && (body.message || body.error)) || ('HTTP ' + res.status))
        + '；' + Math.round(wait / 1000) + ' 秒后重试');
    }
    token = body.token;
    loginFailCount = 0;
    loginBlockUntil = 0;
  }

  async function listProcesses() {
    const body = await request('/api/processes');
    return Array.isArray(body.list) ? body.list : [];
  }

  async function loadPid(pid) {
    const body = await request('/api/processes/' + pid + '/load', 'POST');
    if (body.success === false) throw new Error((body.message || '注入失败') + '（pid=' + pid + '）');
    return body.process || {};
  }

  async function unloadPid(pid) {
    try {
      const body = await request('/api/processes/' + pid + '/unload', 'POST');
      if (body.success === false) throw new Error(body.message || '卸载失败');
      log('已卸载 pid=' + pid + '（不是要接的号 / 自动注入回退）');
    } catch (e) {
      log('卸载 pid=' + pid + ' 失败（可能进程已退出）：' + String((e && e.message) || e));
    }
    ours.delete(pid);
  }

  // 5. QQ 主进程启动时间：最早启动的一般是自动登录的那个号，优先试它
  function readStartTimes() {
    return new Promise(function (resolve) {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-Process -Name QQ -ErrorAction SilentlyContinue | Select-Object Id,StartTime | ConvertTo-Json -Compress"],
        { timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        function (err, stdout) {
          if (err) { resolve(new Map()); return; }
          const map = new Map();
          try {
            const text = String(stdout || '').trim();
            if (!text) { resolve(map); return; }
            const rows = JSON.parse(text);
            (Array.isArray(rows) ? rows : [rows]).forEach(function (row) {
              const pid = Number(row && row.Id);
              const t = Date.parse(row && row.StartTime);
              if (pid > 0 && Number.isFinite(t)) map.set(pid, t);
            });
          } catch (e) {
            log('解析 QQ 启动时间失败（按 pid 顺序挑）：' + String((e && e.message) || e));
          }
          resolve(map);
        });
    });
  }

  async function startTimes() {
    if (startCacheAt && Date.now() - startCacheAt < START_CACHE_MS) return startCache;
    const map = await readStartTimes();
    if (map.size) { startCache = map; startCacheAt = Date.now(); }
    return map;
  }

  function markTried(pid, permanent) {
    const prev = tried.get(pid) || { at: 0, count: 0 };
    tried.set(pid, {
      at: Date.now(),
      count: permanent ? MAX_UNLOGGED_TRIES : prev.count + 1,
      permanent: !!permanent
    });
  }

  // 6. 卸掉本次自动注入的其它进程（keepPid 保留）
  async function unloadOurs(keepPid) {
    const pids = Array.from(ours);
    for (const pid of pids) {
      if (pid === keepPid) continue;
      await unloadPid(pid);
    }
  }

  // 7. 只接指定号：卸掉所有已注入的非目标（含命令行认出来的、手动注入的）
  async function enforceOnlyTarget(candidates, targetUin, keepPid) {
    for (const c of candidates) {
      if (!c.injected || c.pid === keepPid) continue;
      if (c.uin === targetUin) continue;
      // uin=0 的未知进程：如果目标已经在线上，它就不可能是目标，一起卸
      await unloadPid(c.pid);
    }
  }

  // 8. 目标还没上线：只卸「已知不是目标」的和本次试注入的未知进程
  async function unloadKnownNonTarget(candidates, targetUin) {
    for (const c of candidates) {
      if (!c.injected) continue;
      if (c.uin === targetUin) continue;
      const knownWrong = c.uin !== '0';
      if (!knownWrong && !ours.has(c.pid)) continue;   // 别人手动注入的未知进程先不动
      await unloadPid(c.pid);
    }
  }

  // 9. 挑下一个试注入的：没注入、号未知、没在冷却期；最早启动优先
  function pickCandidate(candidates, targetUin, times) {
    const now = Date.now();
    const rows = candidates.filter(function (c) {
      if (c.injected) return false;
      if (c.uin !== '0') return false;               // 已知不是目标（命令行带号）就别碰
      if (ours.has(c.pid)) return false;
      const rec = tried.get(c.pid);
      if (!rec) return true;
      if (rec.permanent) return false;
      if (rec.count >= MAX_UNLOGGED_TRIES) return false;
      return now - rec.at >= RETRY_MS;
    });
    rows.sort(function (a, b) {
      const ta = times.get(a.pid) || Number.MAX_SAFE_INTEGER;
      const tb = times.get(b.pid) || Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.pid - b.pid;
    });
    return rows[0] || null;
  }

  // 10. 注入一个进程：known=true 表示命令行已经确认是目标，不因等不到登录而卸载
  async function inject(candidates, pid, targetUin, known) {
    await loadPid(pid);
    ours.add(pid);
    probing = { pid: pid, deadline: Date.now() + PROBE_WAIT_MS, known: !!known };
    const c = candidates.filter(function (x) { return x.pid === pid; })[0];
    setState({
      status: known ? 'loading' : 'probing',
      detail: known
        ? '已注入目标 ' + targetUin + '（pid=' + pid + '），等登录…'
        : '正在识别 QQ 进程 ' + pid + '（不是 ' + targetUin + ' 会自动卸载）',
      pid: pid,
      uin: c ? c.uin : ''
    });
  }

  // 11. 处理正在试注入的那个：返回 'wait' 表示本轮别挑下一个
  async function checkProbe(candidates, cfg) {
    const p = candidates.filter(function (c) { return c.pid === probing.pid; })[0];
    if (!p) {                          // 进程退出了
      ours.delete(probing.pid);
      probing = null;
      return 'next';
    }
    if (p.loggedIn) {
      if (p.uin === cfg.uin) {
        ours.add(p.pid);
        probing = null;
        setState({ status: 'connected', detail: '已接 ' + cfg.uin + '（只接这个号）', pid: p.pid, uin: p.uin });
        return 'done';
      }
      await unloadPid(p.pid);
      markTried(p.pid, true);          // 号已确认不是目标，本次运行不再试
      probing = null;
      setState({ status: 'waiting', detail: '进程 ' + p.pid + ' 登录的是 ' + p.uin + '，不是 ' + cfg.uin + '，已卸载', pid: 0, uin: '' });
      return 'next';
    }
    if (probing.known) {               // 命令行确认是目标：等它登录，不卸载
      setState({ status: 'loading', detail: '目标 ' + cfg.uin + ' 已注入（pid=' + p.pid + '），等登录…', pid: p.pid });
      return 'wait';
    }
    if (Date.now() > probing.deadline) {
      await unloadPid(p.pid);
      markTried(p.pid, false);
      probing = null;
      setState({ status: 'waiting', detail: '进程 ' + p.pid + ' 没等到登录，先卸载（稍后再试）', pid: 0, uin: '' });
      return 'next';
    }
    setState({ status: 'probing', detail: '正在识别 QQ 进程 ' + p.pid + '…', pid: p.pid });
    return 'wait';
  }

  // 12. 主循环：读配置 → 登录 → 拉进程 → 按模式挑/卸
  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // 12.1 配置
      const cfg = normalizeConfig();
      setState({ mode: cfg.mode, targetUin: cfg.uin, running: true });
      if (cfg.mode === 'off') {
        setState({ status: 'off', detail: '自动注入已关（要接就在 5099 控制台手动加载）' });
        return;
      }
      if (cfg.mode === 'uin' && !/^\d{5,12}$/.test(cfg.uin)) {
        setState({ status: 'error', detail: '还没填要接的 QQ 号（5–12 位数字）' });
        return;
      }
      if (Date.now() < loginBlockUntil) return;

      // 12.2 登录 + 拉进程
      if (!token) await login(cfg);
      const list = await listProcesses();
      const candidates = list.map(function (p) {
        return {
          pid: Number(p.pid) || 0,
          uin: String(p.uin || '0'),
          injected: !!p.injected,
          connected: !!p.connected,
          loggedIn: !!p.loggedIn,
          status: p.status
        };
      });
      setState({}, candidates);
      if (!candidates.length) {
        setState({ status: 'waiting', detail: '没发现 QQ 主进程（先开 QQ，登录后再等 8 秒）' });
        return;
      }

      // 12.3 指定号：目标已在线 → 只留它
      if (cfg.mode === 'uin') {
        const online = candidates.filter(function (c) { return c.loggedIn && c.uin === cfg.uin; })[0];
        if (online) {
          await unloadOurs(online.pid);
          await enforceOnlyTarget(candidates, cfg.uin, online.pid);
          setState({ status: 'connected', detail: '已接 ' + cfg.uin + '（只接这个号）', pid: online.pid, uin: online.uin });
          return;
        }
      }

      // 12.4 全部注入：没注入的都挂上（双开会都接，用户明确选才走这里）
      if (cfg.mode === 'all') {
        for (const c of candidates) {
          if (!c.injected) await inject(candidates, c.pid, '', false);
          if (probing) break;
        }
        const anyOnline = candidates.filter(function (c) { return c.loggedIn; })[0];
        setState({
          status: anyOnline ? 'connected' : 'waiting',
          detail: anyOnline ? '已接 ' + anyOnline.uin + '（全部模式）' : '已注入，等 QQ 登录…',
          pid: anyOnline ? anyOnline.pid : 0,
          uin: anyOnline ? anyOnline.uin : ''
        });
        return;
      }

      // 12.5 正在试注入的那个：本轮只处理它，别拿旧进程表接着卸（会重复调 unload）
      if (probing) {
        await checkProbe(candidates, cfg);
        return;
      }

      // 12.6 命令行已带目标号：直接注入，不用试
      const knownTarget = candidates.filter(function (c) { return c.uin === cfg.uin && !c.injected; })[0];
      if (knownTarget) {
        await inject(candidates, knownTarget.pid, cfg.uin, true);
        return;
      }

      // 12.7 目标已注入但还没登录：等
      const injectedTarget = candidates.filter(function (c) { return c.uin === cfg.uin && c.injected; })[0];
      if (injectedTarget) {
        setState({ status: 'loading', detail: '目标 ' + cfg.uin + ' 已注入（pid=' + injectedTarget.pid + '），等登录…', pid: injectedTarget.pid, uin: injectedTarget.uin });
        return;
      }

      // 12.8 目标还没出现：先清掉已知不是目标的，再挑一个未知的试
      await unloadKnownNonTarget(candidates, cfg.uin);
      if (!cfg.probe) {
        setState({ status: 'waiting', detail: '没找到带 QQ 号提示的进程；autoLoadProbe=false，不盲试（请在控制台手动加载）' });
        return;
      }
      const next = pickCandidate(candidates, cfg.uin, await startTimes());
      if (!next) {
        setState({ status: 'waiting', detail: '没找到 QQ ' + cfg.uin + '；等 QQ 登录或新实例（会继续等）' });
        return;
      }
      await inject(candidates, next.pid, cfg.uin, false);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/unauthorized/.test(msg)) token = '';
      setState({ status: 'error', detail: msg });
      log('出错：' + msg);
    } finally {
      ticking = false;
      if (!stopped) schedule(INTERVAL_MS);
    }
  }

  function start() {
    if (!stopped) return status();
    stopped = false;
    state.running = true;
    setState({ status: 'idle', detail: '已启动，等 SnowLuma 就绪…' });
    schedule(500);
    return status();
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    probing = null;
    state.running = false;
    setState({ status: 'off', detail: '自动注入已停（随桥接停止）' });
    return status();
  }

  // 13. 改了号/模式：把本次自动注入的旧号卸掉，再按新配置挑
  async function reconfigure() {
    const cfg = normalizeConfig();
    probing = null;
    tried.clear();
    const targetChanged = cfg.mode === 'uin' && cfg.uin !== state.targetUin;
    if (targetChanged) await unloadOurs(0);
    setState({ mode: cfg.mode, targetUin: cfg.uin, status: 'idle', detail: '配置已更新，重新识别…' });
    schedule(500);
    return status();
  }

  return { start: start, stop: stop, status: status, reconfigure: reconfigure };
}

module.exports = { createService: createService };
