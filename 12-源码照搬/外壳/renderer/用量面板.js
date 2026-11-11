/* 用量面板.js —— 顶栏「省 token」提示（2026-11-11）
 *
 * 干什么：把「这条会话已经有多贵」摆到眼前 —— 顶栏一颗常驻胶囊，点开是明细。
 *   · 2026-11-11 实测：6 条会话一天烧 2.95 亿 token，99.3% 是每一步重读历史；
 *   · 顶栏原来的「压力」胶囊 2026-10-23 按用户要求删掉了，之后没人看得见这个数；
 *   · 2026-11-11 晚（用户反馈「省 token 按钮和面板不见了」）：原来「越线才出现」，
 *     而浮层只能从胶囊打开 ⇒ 换会话后用量掉到 8%，入口和面板一起消失、再也打不开。
 *     现在改成**常驻**：平时低对比显示 ⚡ 8%，只有越过阈值才换成 warn / err 色。
 *
 * 规矩（照「自我复盘」§五 第 60 条：看不见就别做视觉改动）：
 *   · 只读：不改场景 JSON、不改会话、不写任何文件；
 *   · 样式走 styles.css 里的 .upop* 组件类（2026-11-11 起）——**不再内联写死颜色**：
 *     深色常量（#e6edf3 / #8b949e）在浅色主题下是白字白底，用户直接截图说看不见；
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

  // 颜色一律给**令牌**（--err / --warn / --text-dim），浅色/深色主题各自解析；
  // 以前写死 #ff6b6b / #8b949e，浅色主题下基本看不见（2026-11-11 用户截图反馈）。
  function levelColor(level) {
    if (level === 'over') return 'var(--err)';
    if (level === 'warn') return 'var(--warn)';
    return 'var(--text-dim)';
  }

  function levelClass(level) {
    if (level === 'over') return 'is-over';
    if (level === 'warn') return 'is-warn';
    return '';
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
    // 1. 入口常驻：不管有没有数据、档位高低，胶囊都留在顶栏（浮层唯一的入口）
    chip.style.display = '';
    var w = state.worst;

    // 2. 一条数据都没有（新装的壳 / 引擎没写过用量）⇒ 显示 ⚡ —，但别拿 0% 骗人
    if (!w || !w.hasData) {
      chip.textContent = '⚡ —';
      chip.style.color = 'var(--text-dim)';
      chip.style.borderColor = 'var(--border)';
      chip.title = '省 token：还没有会话用量（引擎还没给任何会话写过）';
      return;
    }

    // 3. 有数据：百分比常显；ok 档用 --text-dim 弱化，越线才换 warn / err 色
    chip.textContent = '⚡ ' + w.pct + '%';
    chip.style.color = levelColor(w.level);
    chip.style.borderColor = w.level === 'ok' ? 'var(--border)' : levelColor(w.level);
    chip.title = (w.sessionTitle || w.sceneName || '会话') + '：' + w.advice + '（点开看明细）';
  }

  // ---------- 明细浮层 ----------
  function closePanel() {
    state.open = false;
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
    // 监听只挂一次、关掉就摘：反复开合不会把 document 上的处理器越堆越多
    try {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    } catch (e) { /* ignore */ }
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
    var box = el('div', 'upop-row');
    var head = el('div', 'upop-row-head');
    head.appendChild(el('span', 'upop-dot ' + levelClass(r.level), '●'));
    head.appendChild(el('span', 'upop-name', (r.sceneName || '') + ' · ' + (r.sessionTitle || r.panelTitle || '未命名会话')));
    box.appendChild(head);

    box.appendChild(el('div', 'upop-meta', r.hasData
      ? (r.steps + ' 步 · 上下文 ' + r.pct + '% · 每步重发 ' + wan(r.perStep) + ' · 重放 ' + r.replayPct + '%')
      : '还没数据（引擎没给这条会话写过用量）'));

    if (r.hasData) box.appendChild(el('div', 'upop-adv ' + levelClass(r.level), r.advice));
    return box;
  }
  function openPanel() {
    closePanel();
    state.open = true;
    pop = el('div', 'upop');
    pop.id = 'usage-pop';

    // 标题栏
    var bar = el('div', 'upop-head');
    bar.appendChild(el('span', 'upop-title', '省 token · 各场景会话的用量'));
    var close = el('button', 'upop-x', '✕');
    close.type = 'button';
    close.title = '关闭';
    close.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
    bar.appendChild(close);
    pop.appendChild(bar);

    // 口径（一句话，省得下次又要解释）
    pop.appendChild(el('div', 'upop-hint',
      '口径：上下文 / 窗口（本机 1M）；每步重发 = 累计(缓存重读+新增输入) / 步数。越线才在这里排前面。'));

    if (state.err) {
      pop.appendChild(el('div', 'upop-msg is-err', '取数失败：' + state.err));
    } else if (!state.rows.length) {
      pop.appendChild(el('div', 'upop-msg', '还没有会话：等引擎给某条会话写过用量之后再看。'));
    } else {
      for (var i = 0; i < state.rows.length; i++) pop.appendChild(buildRow(state.rows[i]));
    }

    // 底栏：复制交接指令（主操作）+ 刷新（次操作）—— 用 .upop-btn，别再裸 <button>（会渲染成系统灰按钮）
    var foot = el('div', 'upop-foot');
    var cp = el('button', 'upop-btn is-primary', '复制交接指令');
    cp.type = 'button';
    cp.addEventListener('click', function (e) {
      e.stopPropagation();
      var target = state.worst || state.rows[0] || null;
      var ok = copyText(handoffText(target));
      cp.textContent = ok ? '已复制，粘给 AI' : '复制失败，手动抄一下';
      setTimeout(function () { cp.textContent = '复制交接指令'; }, 1800);
    });
    foot.appendChild(cp);
    var rf = el('button', 'upop-btn', '刷新');
    rf.type = 'button';
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
        pop.style.left = Math.max(8, Math.round(r.right - 440)) + 'px';
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
