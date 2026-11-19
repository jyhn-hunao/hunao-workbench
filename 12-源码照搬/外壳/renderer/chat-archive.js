'use strict';
// 聊天档案 · 面板（2026-11-19）
//
// 入口常驻在「社交 → 通道」标题行，不藏在齿轮/右键/长弹层里。
// 这里只做观察和查询：默认不选任何聊天、不自动发消息、不自动改档案；搜索/读日摘要/看记忆各占一个页签。
// 数据全来自 window.app.chatArchive；缺这个命名空间就明确提示重启，不画假数据。

(function () {
  var api = window.app && window.app.chatArchive;
  var singleton = null;

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

  function hhmm(ts) {
    var n = Number(ts);
    if (!n) return '还没有';
    try {
      return new Date(n).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return new Date(n).toLocaleString(); }
  }

  function dayDefault(offset) {
    var d = new Date(Date.now() + 8 * 3600 * 1000 - (offset || 0) * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function shortName(c) {
    var n = String((c && (c.displayName || c.chatId)) || '');
    var t = c && c.chatType === 'group' ? '群' : '私聊';
    return n + ' · ' + t + (c && c.messageCount ? ' · ' + c.messageCount + ' 条' : '');
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
    hw.appendChild(mk('div', 'wxs-title', '聊天档案'));
    hw.appendChild(mk('div', 'wxs-sub', '原文长期归档 · 按需查询 · 普通闲聊不注入；微信 / QQ 私聊、群聊各自独立'));
    head.appendChild(hw);
    var x = mk('button', 'wxs-x', '✕');
    x.type = 'button';
    x.title = '关闭';
    x.addEventListener('click', close);
    head.appendChild(x);
    dlgEl.appendChild(head);

    var sum = mk('div', 'wxs-sum');
    var sumText = mk('span', 'wxs-sum-text', '读取中…');
    sum.appendChild(sumText);
    dlgEl.appendChild(sum);

    var body = mk('div', 'wxs-body');
    dlgEl.appendChild(body);

    var top = mk('div', 'arc-top');
    var syncBtn = mk('button', 'wxs-btn', '立即同步');
    syncBtn.type = 'button';
    syncBtn.title = '读 QQ 源库并导入微信群聊旁听；只读，不会发消息';
    var syncInfo = mk('div', 'arc-sync-info', '');
    top.appendChild(syncBtn);
    top.appendChild(syncInfo);
    body.appendChild(top);

    var tabs = mk('div', 'arc-tabs');
    var tabSearch = mk('button', 'arc-tab is-on', '搜索');
    var tabDaily = mk('button', 'arc-tab', '按天读');
    var tabMem = mk('button', 'arc-tab', '聊天记忆');
    tabs.appendChild(tabSearch); tabs.appendChild(tabDaily); tabs.appendChild(tabMem);
    body.appendChild(tabs);

    var chatRow = mk('div', 'arc-row');
    var chatLab = mk('div', 'arc-lab', '聊天');
    var chatSel = mk('select', 'wxs-select arc-chat');
    chatSel.title = '默认不选；选了才查这个聊天。群聊和私聊分开列。';
    chatRow.appendChild(chatLab); chatRow.appendChild(chatSel);
    body.appendChild(chatRow);

    // ---------- 搜索 ----------
    var paneSearch = mk('div', 'arc-pane');
    var qRow = mk('div', 'arc-row');
    var qLab = mk('div', 'arc-lab', '关键词');
    var q = mk('input', 'wxs-select arc-q');
    q.type = 'text';
    q.placeholder = '例：集合 / 带伞 / 你叫什么名字';
    var qBtn = mk('button', 'wxs-btn', '查');
    qBtn.type = 'button';
    qBtn.title = '按关键词查原文；精确原话可换更短的词';
    qRow.appendChild(qLab); qRow.appendChild(q); qRow.appendChild(qBtn);
    paneSearch.appendChild(qRow);
    var sHint = mk('div', 'arc-hint', '普通闲聊不会自动查；这里只在你要翻旧消息时查。');
    paneSearch.appendChild(sHint);
    var sResult = mk('div', 'arc-result');
    paneSearch.appendChild(sResult);
    body.appendChild(paneSearch);

    // ---------- 按天读 ----------
    var paneDaily = mk('div', 'arc-pane is-hide');
    var dRow = mk('div', 'arc-row');
    var dLab = mk('div', 'arc-lab', '日期');
    var dateInp = mk('input', 'wxs-select arc-date');
    dateInp.type = 'date';
    dateInp.value = dayDefault(1);
    var dBtn = mk('button', 'wxs-btn', '读当天');
    dBtn.type = 'button';
    dRow.appendChild(dLab); dRow.appendChild(dateInp); dRow.appendChild(dBtn);
    paneDaily.appendChild(dRow);
    var dHint = mk('div', 'arc-hint', '分页读完整当天；页面只负责翻页，不替你下结论。');
    paneDaily.appendChild(dHint);
    var dResult = mk('div', 'arc-result');
    paneDaily.appendChild(dResult);
    var dMore = mk('button', 'wxs-btn is-hide', '加载下一页');
    dMore.type = 'button';
    paneDaily.appendChild(dMore);
    body.appendChild(paneDaily);

    // ---------- 聊天记忆 ----------
    var paneMem = mk('div', 'arc-pane is-hide');
    var mHint = mk('div', 'arc-hint', '这里只放「以后还要用」的事实/偏好/约定；完整原文在「搜索 / 按天读」里查。');
    paneMem.appendChild(mHint);
    var mResult = mk('div', 'arc-result');
    paneMem.appendChild(mResult);
    body.appendChild(paneMem);

    // ---------- 状态 ----------
    var foot = mk('div', 'arc-foot');
    var footText = mk('div', 'arc-foot-text', '');
    foot.appendChild(footText);
    dlgEl.appendChild(foot);

    state.chats = [];
    state.cursor = 0;
    state.dailyDay = dateInp.value;
    state.busy = false;

    function setBusy(b) {
      state.busy = !!b;
      syncBtn.disabled = !!b;
      qBtn.disabled = !!b;
      dBtn.disabled = !!b;
      dMore.disabled = !!b;
    }

    function loadStatus() {
      return Promise.resolve(api.status()).then(function (r) {
        if (!r || r.ok === false && !r.db) {
          sumText.textContent = '档案状态读不到：' + ((r && r.error) || '主进程没返回');
          footText.textContent = '需要重启一次工作台：主进程/preload 还是旧的（没有 chatArchive.status）';
          return r;
        }
        var db = r.db || {};
        var by = db.channels || {};
        var chText = [];
        if (by.wechat) chText.push('微信 ' + Number(by.wechat.chats || 0) + ' 个聊天 / ' + Number(by.wechat.messages || 0) + ' 条');
        if (by.qq) chText.push('QQ ' + Number(by.qq.chats || 0) + ' 个聊天 / ' + Number(by.qq.messages || 0) + ' 条');
        sumText.textContent = '档案 ' + Number(db.messages || 0) + ' 条 · ' + Number(db.chats || 0) + ' 个聊天'
          + (chText.length ? ' · ' + chText.join(' · ') : '')
          + (db.firstDay ? ' · 覆盖 ' + db.firstDay + ' 至 ' + db.lastDay : '')
          + (db.bytes ? ' · ' + Math.round(Number(db.bytes) / 1024) + ' KB' : '');
        var st = r;
        var accounts = (st.accounts || []).map(function (a) {
          return a.account + (a.ok === false ? '（失败）' : (' ' + Number(a.inserted || 0) + ' 条'));
        });
        syncInfo.textContent = (st.lastSyncAt ? '上次同步 ' + hhmm(st.lastSyncAt) : '还没同步')
          + ' · ' + (st.liveConnected ? '实时在听' : '实时未连（靠回填）')
          + (accounts.length ? ' · 账号 ' + accounts.join(' / ') : '')
          + (st.lastError ? ' · ' + st.lastError : '')
          + (!st.liveConnected && st.liveError ? ' · ' + st.liveError : '');
        footText.textContent = (st.settings && st.settings.enabled === false ? '档案已关闭；' : '')
          + (st.db && st.db.sessionMapped ? ('其中 ' + st.db.sessionMapped + ' 个聊天已绑 DSH 会话；') : '')
          + (st.wechatImported ? ('微信旁听已导入 ' + Number(st.wechatImported) + ' 条；') : '')
          + 'QQ 回填 + 微信实时归档；不会发消息。';
        return r;
      }).catch(function (e) {
        sumText.textContent = '档案状态读不到：' + String((e && e.message) || e);
        return null;
      });
    }

    function loadChats() {
      return Promise.resolve(api.chats()).then(function (r) {
        if (!r || r.ok === false) {
          chatSel.textContent = '';
          var op = mk('option', '', '读取失败：' + ((r && r.error) || '主进程没返回'));
          op.value = '';
          chatSel.appendChild(op);
          return;
        }
        state.chats = Array.isArray(r.chats) ? r.chats : [];
        chatSel.textContent = '';
        var op0 = mk('option', '', state.chats.length ? '全部聊天（只读）' : '还没有归档到聊天');
        op0.value = '';
        chatSel.appendChild(op0);
        state.chats.forEach(function (c) {
          var op = mk('option', '', shortName(c));
          op.value = c.chatKey;
          chatSel.appendChild(op);
        });
      }).catch(function (e) {
        chatSel.textContent = '';
        var op = mk('option', '', '读取失败：' + String((e && e.message) || e));
        op.value = '';
        chatSel.appendChild(op);
      });
    }

    function selectedChat() {
      return String(chatSel.value || '');
    }

    function renderMatches(list, emptyText) {
      sResult.textContent = '';
      if (!Array.isArray(list) || !list.length) {
        sResult.appendChild(mk('div', 'arc-empty', emptyText || '没有命中；换更短的关键词再试。'));
        return;
      }
      list.forEach(function (m) {
        var row = mk('div', 'arc-msg');
        var meta = mk('div', 'arc-meta', '[' + (m.day || '') + ' ' + (m.time || '') + '] ' + (m.sender || ''));
        var txt = mk('div', 'arc-text', m.text || '');
        row.appendChild(meta); row.appendChild(txt);
        (m.before || []).forEach(function (b) {
          row.appendChild(mk('div', 'arc-ctx', '↑ ' + (b.time || '') + ' ' + (b.sender || '') + '：' + (b.text || '')));
        });
        (m.after || []).forEach(function (b) {
          row.appendChild(mk('div', 'arc-ctx', '↓ ' + (b.time || '') + ' ' + (b.sender || '') + '：' + (b.text || '')));
        });
        sResult.appendChild(row);
      });
    }

    function doSearch() {
      if (state.busy) return;
      var query = String(q.value || '').trim();
      if (!query) { toast('先填一个关键词', true); return; }
      setBusy(true);
      sResult.textContent = '';
      sResult.appendChild(mk('div', 'arc-empty', '查询中…'));
      Promise.resolve(api.search({ chat: selectedChat(), query: query, limit: 30, context: 1 })).then(function (r) {
        setBusy(false);
        if (!r || r.ok === false) {
          sResult.textContent = '';
          sResult.appendChild(mk('div', 'arc-empty is-bad', '查询失败：' + ((r && r.error) || '主进程没返回')));
          return;
        }
        renderMatches(r.matches, '没有命中；换更短的关键词再试。');
      }).catch(function (e) {
        setBusy(false);
        sResult.textContent = '';
        sResult.appendChild(mk('div', 'arc-empty is-bad', '查询失败：' + String((e && e.message) || e)));
      });
    }

    function renderDaily(page, append) {
      if (!append) dResult.textContent = '';
      if (!page) return;
      var list = page.messages || [];
      if (!list.length && !append) {
        dResult.appendChild(mk('div', 'arc-empty', '这一天没有归档消息。'));
      }
      list.forEach(function (m) {
        var row = mk('div', 'arc-msg');
        var meta = mk('div', 'arc-meta', '[' + (m.time || '') + '] ' + (m.sender || '') + ' · ' + (m.chatKey || ''));
        var txt = mk('div', 'arc-text', m.text || '');
        row.appendChild(meta); row.appendChild(txt);
        dResult.appendChild(row);
      });
      var head = mk('div', 'arc-daily-head', page.day + ' · 共 ' + Number(page.total || 0) + ' 条'
        + (page.done ? ' · 已到末页' : ' · 还有下一页'));
      if (!append) dResult.insertBefore(head, dResult.firstChild);
      dMore.classList.toggle('is-hide', !!page.done);
      state.cursor = Number(page.nextCursor || 0);
      state.dailyDay = String(page.day || state.dailyDay);
    }

    function doDaily(append) {
      if (state.busy) return;
      var date = String(dateInp.value || '').trim() || dayDefault(1);
      var cursor = append ? state.cursor : 0;
      if (!append) state.cursor = 0;
      setBusy(true);
      Promise.resolve(api.daily({ chat: selectedChat(), date: date, cursor: cursor, limit: 200 })).then(function (r) {
        setBusy(false);
        if (!r || r.ok === false) {
          if (!append) dResult.textContent = '';
          dResult.appendChild(mk('div', 'arc-empty is-bad', '读当天失败：' + ((r && r.error) || '主进程没返回')));
          return;
        }
        renderDaily(r.page, !!append);
      }).catch(function (e) {
        setBusy(false);
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
        mResult.appendChild(mk('div', 'arc-empty', '这个聊天还没有沉淀记忆。等 DSH 明确说「记住」时再写，不自动抓闲聊。'));
        return;
      }
      list.forEach(function (m) {
        var row = mk('div', 'arc-msg');
        row.appendChild(mk('div', 'arc-meta', '#' + m.id + ' · ' + (m.kind || 'fact') + ' · 置信 ' + Math.round(Number(m.confidence || 0) * 100) + '%'));
        row.appendChild(mk('div', 'arc-text', m.text || ''));
        if (m.evidenceIds && m.evidenceIds.length) row.appendChild(mk('div', 'arc-ctx', '证据消息 id：' + m.evidenceIds.join(' / ')));
        mResult.appendChild(row);
      });
    }

    function loadMemories() {
      if (state.busy) return;
      if (!selectedChat()) { mResult.textContent = ''; mResult.appendChild(mk('div', 'arc-empty', '先在上面选一个聊天；不指定时记忆按当前 DSH 会话取。')); return; }
      setBusy(true);
      Promise.resolve(api.memories({ chat: selectedChat(), limit: 10 })).then(function (r) {
        setBusy(false);
        renderMemories(r);
      }).catch(function (e) {
        setBusy(false);
        mResult.textContent = '';
        mResult.appendChild(mk('div', 'arc-empty is-bad', '读取失败：' + String((e && e.message) || e)));
      });
    }

    function switchTab(which) {
      [tabSearch, tabDaily, tabMem].forEach(function (t) { t.classList.remove('is-on'); });
      [paneSearch, paneDaily, paneMem].forEach(function (p) { p.classList.add('is-hide'); });
      if (which === 'daily') {
        tabDaily.classList.add('is-on'); paneDaily.classList.remove('is-hide');
        doDaily(false);
      } else if (which === 'mem') {
        tabMem.classList.add('is-on'); paneMem.classList.remove('is-hide');
        loadMemories();
      } else {
        tabSearch.classList.add('is-on'); paneSearch.classList.remove('is-hide');
      }
    }

    tabSearch.addEventListener('click', function () { switchTab('search'); });
    tabDaily.addEventListener('click', function () { switchTab('daily'); });
    tabMem.addEventListener('click', function () { switchTab('mem'); });
    qBtn.addEventListener('click', doSearch);
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    dBtn.addEventListener('click', function () { doDaily(false); });
    dMore.addEventListener('click', function () { doDaily(true); });
    syncBtn.addEventListener('click', function () {
      if (state.busy) return;
      setBusy(true);
      syncInfo.textContent = '同步中…（只读 SnowLuma messages.db）';
      Promise.resolve(api.sync()).then(function (r) {
        setBusy(false);
        if (!r || r.ok === false) toast('同步失败：' + ((r && r.error) || (r && r.status && r.status.lastError) || '未知原因'), true);
        else toast('同步完成：新归档 ' + Number(r.inserted || 0) + ' 条');
        return loadStatus().then(loadChats);
      }).catch(function (e) {
        setBusy(false);
        toast('同步失败：' + String((e && e.message) || e), true);
      });
    });
    chatSel.addEventListener('change', function () {
      sResult.textContent = '';
      dResult.textContent = '';
      mResult.textContent = '';
      if (tabMem.classList.contains('is-on')) loadMemories();
    });

    body.appendChild(mk('div', 'arc-note', '档案库位置：引擎数据\\.dsh\\社交档案\\chat-archive.db（WAL，不进 git）；原文只进本地库，不往任何外部服务发。'));
    document.body.appendChild(mask);
    setBusy(false);
    loadStatus().then(loadChats);
  }

  window.openChatArchive = function () {
    if (singleton) return Promise.resolve(false);
    if (!api || typeof api.status !== 'function') {
      toast('聊天档案还没接上：重启一次工作台（preload/renderer 是旧的）', true);
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
  window.__chatArchiveAvailable = !!api;
})();
