'use strict';
// 聊天档案库 · 面板（2026-11-19 重设计）
//
// 定位：这是「聊天档案库」的数据库视图，不是会话列表。
//   会话分类已经在社交场景的「全部消息」里，这里默认展示：
//   库规模、时间跨度、存储结构、最近入库、按原文检索、按天浏览、记忆表。
//
// 入口常驻在「社交 → 通道」标题行，不藏在齿轮/右键/长弹层里。
// 默认不预选任何聊天、不自动发消息、不自动改库；所有结果来自 window.app.chatArchive。
// 缺接口时明确提示重启，不画假数据。

(function () {
  var api = window.app && window.app.chatArchive;
  var singleton = null;
  var DEFAULT_LIMIT = 60;

  function toast(msg, bad, ms) {
    try {
      if (typeof window.__tbsToast === 'function') {
        window.__tbsToast(msg, !!bad, ms || (bad ? 8000 : 3000));
        return;
      }
    } catch (e) { console.warn('[chat-archive] 顶栏通知不可用', e); }
    try { console.log('[chat-archive] ' + msg); } catch (e2) { console.warn('[chat-archive] 日志不可用', e2); }
  }

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function fmtInt(n) {
    var x = Number(n);
    if (!isFinite(x)) return '0';
    try { return x.toLocaleString('zh-CN'); } catch (e) { return String(x); }
  }

  function fmtBytes(n) {
    var x = Number(n);
    if (!x || !isFinite(x)) return '0 B';
    if (x < 1024) return x + ' B';
    if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
    if (x < 1024 * 1024 * 1024) return (x / 1024 / 1024).toFixed(1) + ' MB';
    return (x / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function hhmm(ts) {
    var n = Number(ts);
    if (!n) return '还没有';
    try {
      return new Date(n).toLocaleString('zh-CN', {
        hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      try { return new Date(n).toLocaleString(); } catch (e2) { return '—'; }
    }
  }

  function dayDefault(offset) {
    var d = new Date(Date.now() + 8 * 3600 * 1000 - (offset || 0) * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function chatTag(key) {
    var p = String(key || '').split(':');
    var ch = p[0] === 'qq' ? 'QQ' : (p[0] === 'wechat' ? '微信' : (p[0] === 'feishu' ? '飞书' : (p[0] || '库')));
    if (p[1] === 'group') ch += '群';
    else if (p[1] === 'private') ch += '私聊';
    return ch;
  }

  function field(label, input, hint) {
    var w = mk('div', 'arc-field');
    w.appendChild(mk('div', 'arc-field-k', label));
    w.appendChild(input);
    if (hint) w.appendChild(mk('div', 'arc-field-h', hint));
    return w;
  }

  function statCard(label, sub) {
    var box = mk('div', 'arc-stat');
    var v = mk('div', 'arc-stat-v', '—');
    box.appendChild(mk('div', 'arc-stat-k', label));
    box.appendChild(v);
    box.appendChild(mk('div', 'arc-stat-s', sub));
    return { box: box, value: v };
  }

  function build(dlg, state) {
    var mask = mk('div', 'wxs-mask');
    mask.dataset.chatArchive = '1';
    var dlgEl = mk('div', 'wxs-dlg is-archive');
    mask.appendChild(dlgEl);

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      document.removeEventListener('keydown', onKey);
      singleton = null;
      if (state.resolve) state.resolve(true);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey);

    var head = mk('div', 'wxs-head');
    var hw = mk('div', 'wxs-hw');
    hw.appendChild(mk('div', 'wxs-title', '聊天档案库'));
    hw.appendChild(mk('div', 'wxs-sub', 'SQLite 原文库 · FTS5 trigram 全文索引 · 长期本地保存 · 只读查询'));
    head.appendChild(hw);
    var x = mk('button', 'wxs-x', '✕');
    x.type = 'button';
    x.title = '关闭';
    x.addEventListener('click', close);
    head.appendChild(x);
    dlgEl.appendChild(head);

    var body = mk('div', 'wxs-body');
    dlgEl.appendChild(body);

    var top = mk('div', 'arc-top');
    var refreshBtn = mk('button', 'wxs-btn', '刷新状态');
    refreshBtn.type = 'button';
    refreshBtn.title = '重新读数据库统计和最近入库；不写入、不发消息';
    var syncBtn = mk('button', 'wxs-btn', '同步外部源');
    syncBtn.type = 'button';
    syncBtn.title = '只读 SnowLuma messages.db 和微信群聊旁听，导入档案库；不会发消息';
    var syncInfo = mk('div', 'arc-sync-info', '');
    top.appendChild(refreshBtn);
    top.appendChild(syncBtn);
    top.appendChild(syncInfo);
    body.appendChild(top);

    var tabs = mk('div', 'arc-tabs');
    var tabOverview = mk('button', 'arc-tab is-on', '库概览');
    var tabQuery = mk('button', 'arc-tab', '原文查询');
    var tabDaily = mk('button', 'arc-tab', '按天浏览');
    var tabMem = mk('button', 'arc-tab', '记忆表');
    [tabOverview, tabQuery, tabDaily, tabMem].forEach(function (t) { t.type = 'button'; });
    tabs.appendChild(tabOverview); tabs.appendChild(tabQuery);
    tabs.appendChild(tabDaily); tabs.appendChild(tabMem);
    body.appendChild(tabs);

    // ---------- 库概览 ----------
    var paneOverview = mk('div', 'arc-pane');
    var stats = mk('div', 'arc-stats');
    var stMessages = statCard('原文条数', 'messages');
    var stChats = statCard('会话键', 'chats');
    var stDays = statCard('覆盖天数', 'distinct day');
    var stBytes = statCard('数据库体积', 'chat-archive.db');
    var stSpan = statCard('时间跨度', 'firstDay → lastDay');
    stSpan.value.classList.add('is-span');
    var stMapped = statCard('已绑 DSH 会话', 'current_session_id');
    [stMessages, stChats, stDays, stBytes, stSpan, stMapped].forEach(function (x) { stats.appendChild(x.box); });
    paneOverview.appendChild(stats);

    var dbLine = mk('div', 'arc-db-line');
    var dbLineText = mk('div', 'arc-db-line-text', '读取库状态…');
    dbLine.appendChild(dbLineText);
    paneOverview.appendChild(dbLine);

    var secSchema = mk('div', 'arc-section');
    var schemaHead = mk('div', 'arc-section-head');
    schemaHead.appendChild(mk('div', 'arc-section-title', '存储结构'));
    schemaHead.appendChild(mk('div', 'arc-section-hint', '库里的表与索引；这里看的是保存层，不是聊天分类'));
    secSchema.appendChild(schemaHead);
    var schemaTable = mk('div', 'arc-schema');
    function schemaRow(table, role, value) {
      var row = mk('div', 'arc-schema-row');
      row.appendChild(mk('div', 'arc-schema-table', table));
      row.appendChild(mk('div', 'arc-schema-role', role));
      var val = mk('div', 'arc-schema-value', value);
      row.appendChild(val);
      schemaTable.appendChild(row);
      return val;
    }
    var schemaMessages = schemaRow('messages', '原文主表 · 按 ts / day / sender 建索引', '—');
    var schemaChats = schemaRow('chats', '会话键索引 · 记录首末时间与消息数', '—');
    schemaRow('messages_fts', 'FTS5 trigram 全文索引 · 随原文触发器同步', '已建');
    schemaRow('memories', '长期记忆条目 · 按需写入，不自动抓闲聊', '按需');
    secSchema.appendChild(schemaTable);
    secSchema.appendChild(mk('div', 'arc-schema-note', 'WAL 模式；原文只写入本地库，不向任何外部服务发送。'));
    paneOverview.appendChild(secSchema);

    var secRecent = mk('div', 'arc-section');
    var recentHead = mk('div', 'arc-section-head');
    var recentTitle = mk('div', 'arc-section-title', '最近入库');
    recentHead.appendChild(recentTitle);
    var recentInfo = mk('div', 'arc-section-hint', '按 ts 倒序读取档案库');
    recentHead.appendChild(recentInfo);
    var recentBtn = mk('button', 'wxs-btn', '刷新');
    recentBtn.type = 'button';
    recentBtn.title = '重新读取最近入库记录';
    recentHead.appendChild(recentBtn);
    secRecent.appendChild(recentHead);
    var recentResult = mk('div', 'arc-result');
    secRecent.appendChild(recentResult);
    paneOverview.appendChild(secRecent);
    body.appendChild(paneOverview);

    // ---------- 原文查询 ----------
    var paneQuery = mk('div', 'arc-pane is-hide');
    var qRow = mk('div', 'arc-filter');
    var q = mk('input', 'arc-input');
    q.type = 'text';
    q.placeholder = '例：集合 / 带伞 / 你叫什么名字';
    var mode = mk('select', 'arc-input');
    var modeKw = mk('option', '', '关键词（FTS5）');
    modeKw.value = 'fts';
    var modeQuote = mk('option', '', '原话（精确匹配）');
    modeQuote.value = 'quote';
    mode.appendChild(modeKw); mode.appendChild(modeQuote);
    var qBtn = mk('button', 'wxs-btn', '查原文');
    qBtn.type = 'button';
    qRow.appendChild(field('关键词', q, '必填；FTS5 查关键词，精确模式查连续原话'));
    qRow.appendChild(field('匹配方式', mode, ''));
    qRow.appendChild(qBtn);
    paneQuery.appendChild(qRow);

    var qRow2 = mk('div', 'arc-filter');
    var scope = mk('input', 'arc-input');
    scope.type = 'text';
    scope.placeholder = '留空 = 全库；可填群名 / 昵称 / chat_key';
    var from = mk('input', 'arc-input');
    from.type = 'date';
    from.value = '';
    var to = mk('input', 'arc-input');
    to.type = 'date';
    to.value = '';
    qRow2.appendChild(field('限定范围（可选）', scope, '这里是自由文本过滤，不是会话列表；留空就查全库'));
    qRow2.appendChild(field('起始日期', from, ''));
    qRow2.appendChild(field('结束日期', to, ''));
    paneQuery.appendChild(qRow2);

    var qRow3 = mk('div', 'arc-filter');
    var sender = mk('input', 'arc-input');
    sender.type = 'text';
    sender.placeholder = '例：饭团 / 群友昵称';
    var clearQ = mk('button', 'wxs-btn', '清空条件');
    clearQ.type = 'button';
    qRow3.appendChild(field('发言人（可选）', sender, '按昵称或发送者 id 过滤'));
    qRow3.appendChild(clearQ);
    paneQuery.appendChild(qRow3);

    var qHint = mk('div', 'arc-hint', '默认全库；不预选聊天、不自动查询。填条件后由 SQLite / FTS5 返回原文，不改库、不发消息。');
    paneQuery.appendChild(qHint);
    var qInfo = mk('div', 'arc-result-head', '');
    paneQuery.appendChild(qInfo);
    var qResult = mk('div', 'arc-result');
    paneQuery.appendChild(qResult);
    body.appendChild(paneQuery);

    // ---------- 按天浏览 ----------
    var paneDaily = mk('div', 'arc-pane is-hide');
    var dRow = mk('div', 'arc-filter');
    var dateInp = mk('input', 'arc-input');
    dateInp.type = 'date';
    dateInp.value = dayDefault(1);
    var dBtn = mk('button', 'wxs-btn', '读当天');
    dBtn.type = 'button';
    dRow.appendChild(field('日期', dateInp, '默认打开最近有数据的一天'));
    dRow.appendChild(dBtn);
    paneDaily.appendChild(dRow);
    var dHint = mk('div', 'arc-hint', '按 messages.day 读取；分页读完整当天，页面只负责翻页，不替你下结论。');
    paneDaily.appendChild(dHint);
    var dInfo = mk('div', 'arc-result-head', '');
    paneDaily.appendChild(dInfo);
    var dResult = mk('div', 'arc-result');
    paneDaily.appendChild(dResult);
    var dMore = mk('button', 'wxs-btn is-hide', '加载下一页');
    dMore.type = 'button';
    dMore.classList.add('arc-more');
    paneDaily.appendChild(dMore);
    body.appendChild(paneDaily);

    // ---------- 记忆表 ----------
    var paneMem = mk('div', 'arc-pane is-hide');
    var mRow = mk('div', 'arc-filter');
    var mScope = mk('input', 'arc-input');
    mScope.type = 'text';
    mScope.placeholder = '群名 / 昵称 / chat_key';
    var mQuery = mk('input', 'arc-input');
    mQuery.type = 'text';
    mQuery.placeholder = '可选：按内容过滤';
    var mBtn = mk('button', 'wxs-btn', '查记忆');
    mBtn.type = 'button';
    mRow.appendChild(field('聊天范围', mScope, '必填；记忆按聊天归属，不自动扫全库'));
    mRow.appendChild(field('内容过滤', mQuery, ''));
    mRow.appendChild(mBtn);
    paneMem.appendChild(mRow);
    var mHint = mk('div', 'arc-hint', '这里展示 memories 表里 active 的条目；证据 id 指回原文 messages，不把闲聊自动变成记忆。');
    paneMem.appendChild(mHint);
    var mInfo = mk('div', 'arc-result-head', '');
    paneMem.appendChild(mInfo);
    var mResult = mk('div', 'arc-result');
    paneMem.appendChild(mResult);
    body.appendChild(paneMem);

    var foot = mk('div', 'arc-foot');
    var footText = mk('div', 'arc-foot-text', '');
    foot.appendChild(footText);
    dlgEl.appendChild(foot);

    state.status = null;
    state.busy = false;
    state.tab = 'overview';
    state.recentLoaded = false;
    state.recentLoading = false;
    state.dateTouched = false;
    state.dailyCursor = 0;
    state.dailyMessages = [];

    function setBusy(b) {
      state.busy = !!b;
      [refreshBtn, syncBtn, qBtn, clearQ, dBtn, mBtn, dMore].forEach(function (btn) {
        if (btn) btn.disabled = !!b;
      });
    }

    function setStat(ref, value) {
      if (ref && ref.value) ref.value.textContent = value == null ? '—' : String(value);
    }

    function renderStatus(r) {
      var db = (r && r.db) || {};
      var file = String(db.file || '');
      setStat(stMessages, fmtInt(db.messages));
      setStat(stChats, fmtInt(db.chats));
      setStat(stDays, fmtInt(db.days));
      setStat(stBytes, fmtBytes(db.bytes));
      setStat(stSpan, db.firstDay && db.lastDay ? (db.firstDay + ' → ' + db.lastDay) : '—');
      setStat(stMapped, fmtInt(db.sessionMapped));
      stBytes.box.title = file || 'chat-archive.db';
      schemaMessages.textContent = fmtInt(db.messages) + ' 条';
      schemaChats.textContent = fmtInt(db.chats) + ' 个';

      var live = r && r.liveConnected ? '实时写入已连' : '实时未连（靠回填）';
      var lastSync = r && r.lastSyncAt ? ('上次同步 ' + hhmm(r.lastSyncAt)) : '还没同步';
      var accounts = Array.isArray(r && r.accounts) ? r.accounts : [];
      var acText = accounts.map(function (a) {
        return a.account + (a.ok === false ? '（失败）' : (' +' + fmtInt(a.inserted || 0)));
      }).join(' / ');
      var liveError = r && r.liveError ? String(r.liveError) : '';
      syncInfo.textContent = live + ' · ' + lastSync
        + (acText ? ' · 外部源 ' + acText : '')
        + (r && r.lastError ? ' · ' + r.lastError : '')
        + (r && !r.liveConnected && liveError ? ' · ' + liveError : '');

      dbLineText.textContent = 'FTS5 trigram · 数据库'
        + (db.ok === false ? '错误：' + (db.error || '未知') : '正常')
        + (r && r.lastError ? ' · 最近错误：' + r.lastError : '');
      dbLineText.classList.toggle('is-bad', !!(db.ok === false || (r && r.lastError)));

      footText.textContent = '库文件：' + (file || 'chat-archive.db') + ' · 只读查看，不发消息；原文不进 git。'
        + (r && r.settings && r.settings.enabled === false ? ' 档案已关闭。' : '')
        + (db.sessionMapped ? ' ' + fmtInt(db.sessionMapped) + ' 个聊天已绑 DSH 会话。' : '');
    }

    function loadStatus() {
      if (!api || typeof api.status !== 'function') {
        syncInfo.textContent = '档案状态读不到：接口未接上';
        footText.textContent = '需要重启一次工作台：preload / 主进程还是旧的';
        return Promise.resolve(null);
      }
      syncInfo.textContent = '正在读数据库状态…';
      return Promise.resolve(api.status()).then(function (r) {
        if (!r || (r.ok === false && !r.db)) {
          syncInfo.textContent = '档案状态读不到：' + ((r && r.error) || '主进程没返回');
          footText.textContent = '需要重启一次工作台：主进程 / preload 还是旧的';
          return r;
        }
        state.status = r;
        renderStatus(r);
        var db = r.db || {};
        if (!state.dateTouched && db.lastDay) dateInp.value = db.lastDay;
        if (!state.recentLoaded && !state.recentLoading) loadRecent();
        return r;
      }).catch(function (e) {
        syncInfo.textContent = '档案状态读不到：' + String((e && e.message) || e);
        footText.textContent = '读取状态失败；看顶栏通知或日志。';
        return null;
      });
    }

    function renderMessageTable(container, list, opts) {
      var o = opts || {};
      container.textContent = '';
      if (!Array.isArray(list) || !list.length) {
        container.appendChild(mk('div', 'arc-empty', o.empty || '没有记录。'));
        return;
      }
      var wrap = mk('div', 'arc-table-wrap');
      var table = mk('table', 'arc-db-table');
      var thead = mk('thead');
      var hr = mk('tr');
      ['ID', '时间', '范围', '发言人', '原文'].forEach(function (h) { hr.appendChild(mk('th', '', h)); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = mk('tbody');
      list.forEach(function (m) {
        var tr = mk('tr');
        tr.appendChild(mk('td', 'arc-cell-id', '#' + String(m.id || '—')));
        tr.appendChild(mk('td', 'arc-cell-time', (m.day || '') + (m.day && m.time ? ' ' : '') + (m.time || '')));
        var rangeCell = mk('td', 'arc-cell-range');
        var tag = mk('span', 'arc-key-ch', chatTag(m.chatKey));
        var key = mk('span', 'arc-key', m.chatKey || '—');
        key.title = m.chatKey || '—';
        rangeCell.appendChild(tag);
        rangeCell.appendChild(key);
        tr.appendChild(rangeCell);
        var senderCell = mk('td', 'arc-cell-sender', (m.sender || '未知')
          + (m.direction === 'out' ? ' · 发出' : ''));
        tr.appendChild(senderCell);
        var textCell = mk('td', 'arc-cell-text');
        textCell.appendChild(mk('div', 'arc-text', m.text || ''));
        if (o.context) {
          (m.before || []).forEach(function (b) {
            textCell.appendChild(mk('div', 'arc-ctx', '↑ ' + (b.time || '') + ' ' + (b.sender || '') + '：' + (b.text || '')));
          });
          (m.after || []).forEach(function (b) {
            textCell.appendChild(mk('div', 'arc-ctx', '↓ ' + (b.time || '') + ' ' + (b.sender || '') + '：' + (b.text || '')));
          });
        }
        tr.appendChild(textCell);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      container.appendChild(wrap);
    }

    function loadRecent() {
      if (!api || typeof api.recent !== 'function') {
        recentInfo.textContent = '接口没有 recent：重启一次工作台';
        recentResult.textContent = '';
        recentResult.appendChild(mk('div', 'arc-empty is-bad', 'preload / 主进程还是旧的，没有最近入库接口。'));
        return;
      }
      if (state.recentLoading) return;
      state.recentLoading = true;
      recentInfo.textContent = '读取最近入库…';
      Promise.resolve(api.recent({ limit: DEFAULT_LIMIT })).then(function (r) {
        state.recentLoading = false;
        state.recentLoaded = true;
        if (!r || r.ok === false) {
          recentInfo.textContent = '最近入库读取失败';
          recentResult.textContent = '';
          recentResult.appendChild(mk('div', 'arc-empty is-bad', '读取失败：' + ((r && r.error) || '主进程没返回')));
          return;
        }
        var list = Array.isArray(r.messages) ? r.messages : [];
        recentInfo.textContent = '最近 ' + list.length + ' 条 · 按 ts 倒序 · 最多 ' + DEFAULT_LIMIT + ' 条';
        renderMessageTable(recentResult, list, { empty: '档案库还没有原文；点「同步外部源」或等聊天写入。' });
      }).catch(function (e) {
        state.recentLoading = false;
        recentInfo.textContent = '最近入库读取失败';
        recentResult.textContent = '';
        recentResult.appendChild(mk('div', 'arc-empty is-bad', '读取失败：' + String((e && e.message) || e)));
      });
    }

    function doSearch() {
      if (state.busy) return;
      var query = String(q.value || '').trim();
      if (!query) { toast('先填一个关键词', true); q.focus(); return; }
      setBusy(true);
      qInfo.textContent = '查询中…';
      qResult.textContent = '';
      qResult.appendChild(mk('div', 'arc-empty', '正在查 SQLite / FTS5…'));
      var started = Date.now();
      var args = {
        query: query,
        chat: String(scope.value || '').trim(),
        from: from.value || '',
        to: to.value || '',
        sender: String(sender.value || '').trim(),
        limit: DEFAULT_LIMIT,
        context: 1
      };
      var promise = mode.value === 'quote'
        ? api.quote({ phrase: query, chat: args.chat, from: args.from, to: args.to, sender: args.sender, limit: args.limit, context: 1 })
        : api.search(args);
      Promise.resolve(promise).then(function (r) {
        setBusy(false);
        if (!r || r.ok === false) {
          qInfo.textContent = '查询失败';
          qResult.textContent = '';
          qResult.appendChild(mk('div', 'arc-empty is-bad', '查询失败：' + ((r && r.error) || '主进程没返回')));
          if (r && r.candidates && r.candidates.length) {
            qResult.appendChild(mk('div', 'arc-empty', '匹配到多个聊天：' + r.candidates.map(function (x) { return x.chatKey; }).join(' / ')));
          }
          return;
        }
        var list = Array.isArray(r.matches) ? r.matches : [];
        var ms = Date.now() - started;
        qInfo.textContent = '命中 ' + list.length + ' 条 · ' + ms + ' ms · '
          + (mode.value === 'quote' ? '精确原话' : 'FTS5 / LIKE');
        renderMessageTable(qResult, list, { context: true, empty: '没有命中；换更短的关键词，或把范围留空再试。' });
      }).catch(function (e) {
        setBusy(false);
        qInfo.textContent = '查询失败';
        qResult.textContent = '';
        qResult.appendChild(mk('div', 'arc-empty is-bad', '查询失败：' + String((e && e.message) || e)));
      });
    }

    function renderDaily(page, append) {
      if (!append) {
        dResult.textContent = '';
        state.dailyMessages = [];
      }
      if (!page) return;
      var list = page.messages || [];
      state.dailyMessages = (state.dailyMessages || []).concat(list);
      renderMessageTable(dResult, state.dailyMessages, { empty: '这一天没有归档消息。' });
      var head = mk('div', 'arc-daily-head', page.day + ' · 共 ' + fmtInt(page.total || 0) + ' 条'
        + (page.done ? ' · 已到末页' : ' · 还有下一页'));
      dResult.insertBefore(head, dResult.firstChild);
      dMore.classList.toggle('is-hide', !!page.done);
      state.dailyCursor = Number(page.nextCursor || 0);
      state.dailyDay = String(page.day || state.dailyDay || '');
    }

    function doDaily(append) {
      if (state.busy) return;
      var date = String(dateInp.value || '').trim() || dayDefault(1);
      var cursor = append ? state.dailyCursor : 0;
      if (!append) state.dailyCursor = 0;
      setBusy(true);
      dInfo.textContent = '读取中…';
      Promise.resolve(api.daily({ date: date, cursor: cursor, limit: 200 })).then(function (r) {
        setBusy(false);
        if (!r || r.ok === false) {
          dInfo.textContent = '读取失败';
          if (!append) dResult.textContent = '';
          dResult.appendChild(mk('div', 'arc-empty is-bad', '读当天失败：' + ((r && r.error) || '主进程没返回')));
          return;
        }
        dInfo.textContent = '按 messages.day 读取';
        renderDaily(r.page, !!append);
      }).catch(function (e) {
        setBusy(false);
        dInfo.textContent = '读取失败';
        if (!append) dResult.textContent = '';
        dResult.appendChild(mk('div', 'arc-empty is-bad', '读当天失败：' + String((e && e.message) || e)));
      });
    }

    function renderMemories(r) {
      mResult.textContent = '';
      if (!r || r.ok === false) {
        mResult.appendChild(mk('div', 'arc-empty is-bad', '读取失败：' + ((r && r.error) || '主进程没返回')));
        return;
      }
      var list = r.memories || [];
      if (!list.length) {
        mResult.appendChild(mk('div', 'arc-empty', '这个范围还没有沉淀记忆。等 DSH 明确说「记住」时再写，不自动抓闲聊。'));
        return;
      }
      var wrap = mk('div', 'arc-table-wrap');
      var table = mk('table', 'arc-db-table arc-mem-table');
      var thead = mk('thead');
      var hr = mk('tr');
      ['ID', '范围', '类型', '置信', '内容', '证据'].forEach(function (h) { hr.appendChild(mk('th', '', h)); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = mk('tbody');
      list.forEach(function (m) {
        var tr = mk('tr');
        tr.appendChild(mk('td', 'arc-cell-id', '#' + String(m.id || '—')));
        var rangeCell = mk('td', 'arc-cell-range');
        rangeCell.appendChild(mk('span', 'arc-key-ch', chatTag(m.chatKey)));
        rangeCell.appendChild(mk('span', 'arc-key', m.chatKey || '（通用）'));
        tr.appendChild(rangeCell);
        tr.appendChild(mk('td', '', m.kind || 'fact'));
        tr.appendChild(mk('td', '', Math.round(Number(m.confidence || 0) * 100) + '%'));
        tr.appendChild(mk('td', 'arc-cell-text', m.text || ''));
        tr.appendChild(mk('td', 'arc-cell-evidence', (m.evidenceIds && m.evidenceIds.length) ? m.evidenceIds.join(' / ') : '—'));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      mResult.appendChild(wrap);
    }

    function loadMemories() {
      if (state.busy) return;
      var scopeText = String(mScope.value || '').trim();
      if (!scopeText) {
        mInfo.textContent = '需要先填聊天范围';
        mResult.textContent = '';
        mResult.appendChild(mk('div', 'arc-empty', '记忆表按聊天归属；填群名 / 昵称 / chat_key 后再查，避免把全库记忆一次铺开。'));
        mScope.focus();
        return;
      }
      setBusy(true);
      mInfo.textContent = '读取 memories 表…';
      Promise.resolve(api.memories({
        chat: scopeText,
        query: String(mQuery.value || '').trim(),
        limit: 20
      })).then(function (r) {
        setBusy(false);
        if (!r || r.ok === false) {
          mInfo.textContent = '读取失败';
          mResult.textContent = '';
          mResult.appendChild(mk('div', 'arc-empty is-bad', '读取失败：' + ((r && r.error) || '主进程没返回')));
          if (r && r.candidates && r.candidates.length) {
            mResult.appendChild(mk('div', 'arc-empty', '匹配到多个聊天：' + r.candidates.map(function (x) { return x.chatKey; }).join(' / ')));
          }
          return;
        }
        mInfo.textContent = 'memories 表 · active · ' + (r.memories || []).length + ' 条';
        renderMemories(r);
      }).catch(function (e) {
        setBusy(false);
        mInfo.textContent = '读取失败';
        mResult.textContent = '';
        mResult.appendChild(mk('div', 'arc-empty is-bad', '读取失败：' + String((e && e.message) || e)));
      });
    }

    function switchTab(which) {
      [tabOverview, tabQuery, tabDaily, tabMem].forEach(function (t) { t.classList.remove('is-on'); });
      [paneOverview, paneQuery, paneDaily, paneMem].forEach(function (p) { p.classList.add('is-hide'); });
      state.tab = which;
      if (which === 'query') {
        tabQuery.classList.add('is-on'); paneQuery.classList.remove('is-hide');
        q.focus();
      } else if (which === 'daily') {
        tabDaily.classList.add('is-on'); paneDaily.classList.remove('is-hide');
        if (!dResult.childNodes.length) doDaily(false);
      } else if (which === 'mem') {
        tabMem.classList.add('is-on'); paneMem.classList.remove('is-hide');
      } else {
        tabOverview.classList.add('is-on'); paneOverview.classList.remove('is-hide');
        if (!state.recentLoaded) loadRecent();
      }
    }

    tabOverview.addEventListener('click', function () { switchTab('overview'); });
    tabQuery.addEventListener('click', function () { switchTab('query'); });
    tabDaily.addEventListener('click', function () { switchTab('daily'); });
    tabMem.addEventListener('click', function () { switchTab('mem'); });
    qBtn.addEventListener('click', doSearch);
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    dBtn.addEventListener('click', function () { doDaily(false); });
    dMore.addEventListener('click', function () { doDaily(true); });
    mBtn.addEventListener('click', loadMemories);
    mScope.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); loadMemories(); } });
    dateInp.addEventListener('change', function () { state.dateTouched = true; });
    clearQ.addEventListener('click', function () {
      q.value = ''; scope.value = ''; from.value = ''; to.value = ''; sender.value = '';
      qInfo.textContent = '';
      qResult.textContent = '';
      q.focus();
    });
    recentBtn.addEventListener('click', function () {
      state.recentLoaded = false;
      loadRecent();
    });
    refreshBtn.addEventListener('click', function () {
      if (state.busy) return;
      setBusy(true);
      state.recentLoaded = false;
      loadStatus().then(function () {
        setBusy(false);
        toast('档案状态已刷新', false, 2000);
      }).catch(function (e) {
        setBusy(false);
        toast('刷新失败：' + String((e && e.message) || e), true);
      });
    });
    syncBtn.addEventListener('click', function () {
      if (state.busy) return;
      setBusy(true);
      syncInfo.textContent = '同步中…（只读 SnowLuma messages.db / 微信旁听）';
      Promise.resolve(api.sync()).then(function (r) {
        setBusy(false);
        if (!r || r.ok === false) {
          toast('同步失败：' + ((r && r.error) || (r && r.status && r.status.lastError) || '未知原因'), true);
        } else {
          toast('同步完成：新归档 ' + fmtInt(r.inserted || 0) + ' 条', false, 3000);
        }
        state.recentLoaded = false;
        return loadStatus().then(function () {
          if (state.tab === 'daily') doDaily(false);
        });
      }).catch(function (e) {
        setBusy(false);
        toast('同步失败：' + String((e && e.message) || e), true);
      });
    });

    document.body.appendChild(mask);
    setBusy(false);
    loadStatus();
  }

  window.openChatArchive = function () {
    if (singleton) return Promise.resolve(false);
    if (!api || typeof api.status !== 'function' || typeof api.recent !== 'function') {
      toast('聊天档案接口是旧的：重启一次工作台（preload / 主进程需要更新）', true);
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      singleton = { resolve: resolve };
      try {
        build(null, singleton);
      } catch (e) {
        singleton = null;
        resolve(false);
        toast('打开聊天档案失败：' + String((e && e.message) || e), true);
      }
    });
  };

  // 供 renderer 的按钮做能力探测：函数存在但 API 缺失时仍会给出明确提示。
  window.__chatArchiveAvailable = !!api && typeof api.status === 'function' && typeof api.recent === 'function';
})();
