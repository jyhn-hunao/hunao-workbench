/* 用量面板.js —— 顶栏「省 token」提示（2026-11-11）
 *
 * 干什么：把「这条会话已经有多贵」摆到眼前 —— 只在越线时才冒一个胶囊，点开是明细。
 *   · 2026-11-11 实测：6 条会话一天烧 2.95 亿 token，99.3% 是每一步重读历史；
 *   · 顶栏原来的「压力」胶囊 2026-10-23 按用户要求删掉了，之后没人看得见这个数；
 *   · 这里不复活那个胶囊：**默认什么都不显示**，只有某条会话越过阈值才出现。
 *
 * 规矩（照「自我复盘」§五 第 60 条：看不见就别做视觉改动）：
 *   · 只读：不改场景 JSON、不改会话、不写任何文件；
 *   · 不碰 styles.css，配色只用 CSS 变量 + 内联兜底；
 *   · 所有动态文字走 textContent，不拼 innerHTML（会话标题里可能有尖括号）。
 *
 * 数据：window.app.topbar.usage()（主进程 IPC → 外壳\用量.js → 引擎投影缓存）。
 * 生效：本文件是独立 <script>，改完跑 `node 外壳\scripts\刷新面板.mjs` 再整页重载即可。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__dshUsagePanel) return;
  window.__dshUsagePanel = true;

  var K = window.app || {};
  var TB = K.topbar || null;
  var POLL_MS = 90000;

  var state = { rows: [], worst: null, err: null, busy: false, at: 0, open: false };
  var chip = null;
  var pop = null;

  // ---------- 小工具 ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function wan(n) {
    n = Number(n) || 0;
    if (n >= 10000) return Math.round(n / 10000) + ' 万';
    return String(Math.round(n));
  }

  function levelColor(level) {
    if (level === 'over') return '#ff6b6b';
    if (level === 'warn') return '#f0b429';
    return '#8b949e';
  }

  // ---------- 取数 ----------
  function fetchUsage() {
    if (!TB || typeof TB.usage !== 'function') return Promise.resolve(null);
    if (state.busy) return Promise.resolve(null);
    state.busy = true;
    return Promise.resolve().then(function () { return TB.usage(); }).then(function (r) {
      state.busy = false;
      if (!r || r.ok === false) {
        state.err = (r && r.error) || '取不到用量';
        return state;
      }
      state.err = null;
      state.rows = r.rows || [];
      state.worst = r.worst || null;
      state.at = r.at || Date.now();
      return state;
    }).catch(function (e) {
      state.busy = false;
      state.err = String((e && e.message) || e);
      return state;
    });
  }

  // ---------- 胶囊 ----------
  function buildChip() {
    var c = el('button', 'balance-chip', '⚡ —');
    c.id = 'usage-chip';
    c.type = 'button';
    c.style.cursor = 'pointer';
    c.style.display = 'none';
    c.title = '省 token：这条会话每步要重发多少';
    c.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (state.open) closePanel(); else openPanel();
    });
    return c;
  }

  function mount() {
    if (chip) return true;
    var host = null;
    try {
      host = document.querySelector('#scenebar .scenebar-right');
    } catch (e) { host = null; }
    if (!host) return false;                       // 页还没搭好：等下一次
    chip = buildChip();
    var balance = document.getElementById('balance-chip');
    if (balance && balance.parentNode === host) host.insertBefore(chip, balance);
    else host.insertBefore(chip, host.firstChild);
    return true;
  }

  function paintChip() {
    if (!chip) return;
    var w = state.worst;
    // 一条数据都没有（新装的壳 / 引擎没写过用量）⇒ 不显示，别拿 0% 骗人
    if (!w || !w.hasData) { chip.style.display = 'none'; return; }
    if (w.level === 'ok') { chip.style.display = 'none'; return; }
    chip.style.display = '';
    chip.textContent = '⚡ ' + w.pct + '%';
    chip.style.color = levelColor(w.level);
    chip.style.borderColor = levelColor(w.level);
    chip.title = (w.sessionTitle || w.sceneName || '会话') + '：' + w.advice + '（点开看明细）';
  }

  // ---------- 明细浮层 ----------
  function closePanel() {
    state.open = false;
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
  }

  function copyText(t) {
    var done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t);
        done = true;
      }
    } catch (e) { done = false; }
    if (done) return true;
    try {                                          // 老壳兜底：临时 textarea + execCommand
      var ta = el('textarea', '', t);
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) { return false; }
  }

  function handoffText(row) {
    var name = (row && (row.sessionTitle || row.sceneName)) || '这条会话';
    return [
      '「' + name + '」已经跑了 ' + ((row && row.steps) || '?') + ' 步、每步要重发 ' + wan(row && row.perStep) + ' token，先收尾：',
      '1. 把结论写回项目记忆（memory\\）与场景记忆的 §〇 / §五；',
      '2. 出一份交接：已做成什么、下一步、卡点；',
      '3. 本轮到此结束，我开新会话继续。'
    ].join('\n');
  }

  function buildRow(r) {
    var box = el('div');
    box.style.padding = '7px 10px';
    box.style.borderTop = '1px solid rgba(255,255,255,0.07)';
    var head = el('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '6px';
    var dot = el('span', '', '●');
    dot.style.color = levelColor(r.level);
    dot.style.fontSize = '10px';
    head.appendChild(dot);
    var name = el('span', '', (r.sceneName || '') + ' · ' + (r.sessionTitle || r.panelTitle || '未命名会话'));
    name.style.fontWeight = '600';
    name.style.color = '#e6edf3';
    name.style.overflow = 'hidden';
    name.style.textOverflow = 'ellipsis';
    name.style.whiteSpace = 'nowrap';
    head.appendChild(name);
    box.appendChild(head);

    var meta = el('div', '', r.hasData
      ? (r.steps + ' 步 · 上下文 ' + r.pct + '% · 每步重发 ' + wan(r.perStep) + ' · 重放 ' + r.replayPct + '%')
      : '还没数据（引擎没给这条会话写过用量）');
    meta.style.marginTop = '3px';
    meta.style.fontSize = '11.5px';
    meta.style.color = '#8b949e';
    meta.style.fontFamily = 'var(--mono, monospace)';
    box.appendChild(meta);

    if (r.hasData) {
      var adv = el('div', '', r.advice);
      adv.style.marginTop = '2px';
      adv.style.fontSize = '11.5px';
      adv.style.color = levelColor(r.level);
      box.appendChild(adv);
    }
    return box;
  }

  function openPanel() {
    closePanel();
    state.open = true;
    pop = el('div');
    pop.id = 'usage-pop';
    pop.style.position = 'fixed';
    pop.style.zIndex = '9999';
    pop.style.width = '420px';
    pop.style.maxHeight = '60vh';
    pop.style.overflow = 'auto';
    pop.style.background = 'var(--bg-panel, #161b22)';
    pop.style.border = '1px solid var(--border, rgba(255,255,255,0.15))';
    pop.style.borderRadius = '8px';
    pop.style.boxShadow = '0 8px 28px rgba(0,0,0,0.45)';
    pop.style.fontSize = '12.5px';
    pop.style.color = '#e6edf3';

    // 标题
    var bar = el('div');
    bar.style.display = 'flex';
    bar.style.alignItems = 'center';
    bar.style.justifyContent = 'space-between';
    bar.style.padding = '8px 10px';
    var ttl = el('span', '', '省 token · 各场景会话的用量');
    ttl.style.fontWeight = '600';
    bar.appendChild(ttl);
    var close = el('button', '', '✕');
    close.style.background = 'transparent';
    close.style.border = '0';
    close.style.color = '#8b949e';
    close.style.cursor = 'pointer';
    close.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
    bar.appendChild(close);
    pop.appendChild(bar);

    // 说明（口径一句话，省得下次又要解释）
    var hint = el('div', '', '口径：上下文 / 窗口（本机 1M）；每步重发 = 累计(缓存重读+新增输入) / 步数。越线才在这里排前面。');
    hint.style.padding = '0 10px 8px';
    hint.style.fontSize = '11px';
    hint.style.color = '#8b949e';
    pop.appendChild(hint);

    if (state.err) {
      var err = el('div', '', '取数失败：' + state.err);
      err.style.padding = '8px 10px';
      err.style.color = '#ff6b6b';
      pop.appendChild(err);
    } else if (!state.rows.length) {
      var empty = el('div', '', '还没有会话：等引擎给某条会话写过用量之后再看。');
      empty.style.padding = '8px 10px';
      empty.style.color = '#8b949e';
      pop.appendChild(empty);
    } else {
      for (var i = 0; i < state.rows.length; i++) pop.appendChild(buildRow(state.rows[i]));
    }

    // 底栏：复制交接指令 / 刷新
    var foot = el('div');
    foot.style.display = 'flex';
    foot.style.gap = '8px';
    foot.style.padding = '8px 10px';
    foot.style.borderTop = '1px solid rgba(255,255,255,0.07)';
    var cp = el('button', '', '复制交接指令');
    cp.style.flex = '1';
    cp.style.cursor = 'pointer';
    cp.addEventListener('click', function (e) {
      e.stopPropagation();
      var target = state.worst || state.rows[0] || null;
      var ok = copyText(handoffText(target));
      cp.textContent = ok ? '已复制，粘给 AI' : '复制失败，手动抄一下';
      setTimeout(function () { cp.textContent = '复制交接指令'; }, 1800);
    });
    foot.appendChild(cp);
    var rf = el('button', '', '刷新');
    rf.style.cursor = 'pointer';
    rf.addEventListener('click', function (e) {
      e.stopPropagation();
      rf.textContent = '…';
      fetchUsage().then(function () { paintChip(); rf.textContent = '刷新'; if (state.open) openPanel(); });
    });
    foot.appendChild(rf);
    pop.appendChild(foot);

    document.body.appendChild(pop);
    // 位置：贴在胶囊下面，右侧对齐
    try {
      var r = chip && chip.getBoundingClientRect ? chip.getBoundingClientRect() : null;
      if (r && r.width) {
        pop.style.top = Math.round(r.bottom + 6) + 'px';
        pop.style.left = Math.max(8, Math.round(r.right - 420)) + 'px';
      } else {
        pop.style.top = '44px';
        pop.style.right = '16px';
      }
    } catch (e) { pop.style.top = '44px'; pop.style.right = '16px'; }

    setTimeout(function () {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function onDocClick(ev) {
    if (!pop) return;
    if (pop.contains(ev.target) || (chip && chip === ev.target)) return;
    closePanel();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') closePanel();
  }

  // ---------- 启动 ----------
  function tick() {
    if (!mount()) return;                          // 顶栏还没搭好：下次再来
    fetchUsage().then(function () { paintChip(); });
  }

  function boot() {
    if (!TB || typeof TB.usage !== 'function') return;   // 老宿主没有这组 IPC ⇒ 整块不出现
    tick();
    try { setInterval(tick, POLL_MS); } catch (e) { /* ignore */ }
    // 切回窗口时刷一次（切场景/换会话后不用等 90 秒）
    try { window.addEventListener('focus', tick); } catch (e) { /* ignore */ }
    // 别跟整页首次渲染抢时间：挂到下一个宏任务
    try { setTimeout(tick, 4000); } catch (e) { /* ignore */ }
  }

  // 供自检/调试用（只读：调用它只会重新取数）
  window.USAGE_PANEL = {
    refresh: function () { return fetchUsage().then(function (s) { paintChip(); return s; }); },
    state: state,
    wan: wan
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
