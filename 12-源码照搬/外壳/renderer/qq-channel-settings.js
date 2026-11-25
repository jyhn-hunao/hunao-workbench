'use strict';
// QQ 接入设置弹窗（2026-11-24）
// 背景：通道卡片原来把「默认接入 QQ 号 / 会话路由」整段铺在面板里，社交场景三列并排时
// 只剩文字墙。现在面板只回答「通没通、最近有没有消息」，接入类配置统一收进这里。
//
// 为什么单独一个弹窗、不塞进「群聊与语音」：
//   群聊与语音（qq-reply-settings.js）管的是「收到消息怎么回」；这里管的是「接哪个号、哪个聊天进哪条会话」。
//   跨通道的回复语气在「胡闹的大肥鱼 → 设置 → 表达」，不在这两处。
//   两件事分开，用户改群旁听参数时不会误碰路由，改路由时也不会碰到回复语气。
//
// 数据面（都不新增 IPC）：
//   window.app.bridge.qqAutoLoadStatus / qqAutoLoadSet  → 外壳\data\桥接.json 的 autoLoadMode / autoLoadUin
//   window.app.qqChats.status / ensure / add / remove    → qq-bridge.config.json 的 routes
// 交互约定：每一项动作即时写盘 + 顶栏提示结果，不攒批量保存（避免「表单改了、磁盘没改」的第二套真源）。
//           移除路由只解除路由，不删聊天记录；它会先确认范围。

(function () {
  var chatApi = window.app && window.app.qqChats;
  var bridgeApi = window.app && window.app.bridge;

  function toast(msg, bad, ms) {
    try {
      if (typeof window.__tbsToast === 'function') {
        window.__tbsToast(msg, !!bad, ms || (bad ? 8000 : 3000));
        return;
      }
    } catch (e) { console.warn('[qq-settings] 顶栏通知不可用', e); }
    try { console.log('[qq-settings] ' + msg); } catch (e2) { console.warn('[qq-settings] 日志不可用', e2); }
  }
  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }

  // 一行「标题 + 说明 + 控件」，和鲸鲸设置同一种排版，用户不用重新学一套界面。
  function row(label, hint, ctrl) {
    var r = mk('div', 'wxs-row');
    var w = mk('div', 'wxs-lab-wrap');
    w.appendChild(mk('div', 'wxs-lab', label));
    if (hint) w.appendChild(mk('div', 'wxs-hint', hint));
    var c = mk('div', 'wxs-ctrl');
    c.appendChild(ctrl);
    r.appendChild(w);
    r.appendChild(c);
    return r;
  }

  function build(auto0, routes0) {
    var auto = auto0 || {};
    var routes = routes0 || {};
    var activeTab = 'account';
    var busy = '';               // 'auto' / 'ensure' / 'add' / 'remove'
    var reloading = false;
    var closed = false;
    // 草稿只保存用户正在改的那几个值；其它一律以刚拉到的状态为准。
    var draft = {
      mode: String(auto.mode || 'uin'),
      uin: String(auto.targetUin || ''),
      kind: 'private',
      id: '',
      name: ''
    };

    var mask = mk('div', 'wxs-mask qqcs-mask');
    var dlg = mk('div', 'wxs-dlg');
    mask.appendChild(dlg);

    var head = mk('div', 'wxs-head');
    var hw = mk('div', 'wxs-hw');
    hw.appendChild(mk('div', 'wxs-title', 'QQ 接入设置'));
    hw.appendChild(mk('div', 'wxs-sub', '接哪个 QQ 号、哪个聊天进哪条会话。回复语气在「胡闹的大肥鱼 → 设置 → 表达」；QQ 群聊与语音在「设置 → QQ 群聊与语音」；桥接进程在 SnowLuma 控制台。'));
    head.appendChild(hw);
    var x = mk('button', 'wxs-x', '✕');
    x.type = 'button';
    x.title = '关闭（每项都已即时保存，没有未保存草稿）';
    head.appendChild(x);
    dlg.appendChild(head);

    var sum = mk('div', 'wxs-sum');
    dlg.appendChild(sum);

    var tabs = mk('div', 'wxs-tabs');
    var tabDefs = [['account', '账号与接入'], ['routes', '会话路由']];
    var tabBtns = {};
    tabDefs.forEach(function (t) {
      var b = mk('button', 'wxs-tab', t[1]);
      b.type = 'button';
      b.addEventListener('click', function () { activeTab = t[0]; renderTabs(); });
      tabBtns[t[0]] = b;
      tabs.appendChild(b);
    });
    dlg.appendChild(tabs);

    var body = mk('div', 'wxs-body');
    dlg.appendChild(body);

    var secAccount = mk('div', 'wxs-sec is-on');
    var secRoutes = mk('div', 'wxs-sec');
    body.appendChild(secAccount);
    body.appendChild(secRoutes);

    var foot = mk('div', 'wxs-foot');
    var fh = mk('div', 'wxs-fh', '每项改完即时生效');
    foot.appendChild(fh);
    var reloadBtn = mk('button', 'wxs-btn', '刷新状态');
    reloadBtn.type = 'button';
    reloadBtn.title = '重新读桥接注入状态与 QQ 路由；不改变任何配置';
    var closeBtn = mk('button', 'wxs-btn', '关闭');
    closeBtn.type = 'button';
    foot.appendChild(reloadBtn);
    foot.appendChild(closeBtn);
    dlg.appendChild(foot);

    // ---------- 摘要：一眼看出接的哪个号、多少聊天在独立会话 ----------
    function renderSum() {
      sum.textContent = '';
      var mode = String(auto.mode || '');
      pill('默认接入：' + (mode === 'uin' ? ('指定 ' + (auto.targetUin || '未填'))
        : mode === 'all' ? '本机全部' : mode === 'off' ? '不自动' : '未读取'),
        mode === 'uin' && auto.targetUin ? 'is-ok' : (mode === 'all' ? 'is-warn' : ''));
      pill('私聊 ' + (Number(routes.privates) || 0), '');
      pill('群 ' + (Number(routes.groups) || 0), '');
      pill('独立会话 ' + (Number(routes.independent) || 0), Number(routes.independent) ? 'is-ok' : '');
      if (Number(routes.shared)) pill('共用主会话 ' + routes.shared, 'is-warn');
    }
    function pill(text, cls) { sum.appendChild(mk('span', 'wxs-pill ' + (cls || ''), text)); }

    // ---------- 账号与接入 ----------
    function renderAccount() {
      secAccount.textContent = '';
      secAccount.appendChild(mk('div', 'wxs-sec-title', '默认接入 QQ 号'));
      secAccount.appendChild(mk('div', 'wxs-sec-hint',
        '双开时只注入指定号，另一个号不会被挂上 Hook；「全部」会把两个号都接上，「不自动」则到 5099 控制台手动加载。'));

      var sel = mk('select', 'wxs-select');
      sel.title = '只接指定号：其它号自动卸载；全部：双开都接；不自动：进 SnowLuma 控制台手动加载';
      [['uin', '只接指定 QQ 号'], ['all', '本机全部 QQ（双开都接）'], ['off', '不自动接（手动加载）']].forEach(function (o) {
        var op = mk('option', '', o[1]);
        op.value = o[0];
        sel.appendChild(op);
      });
      sel.value = draft.mode;
      sel.disabled = !!busy;
      sel.addEventListener('change', function () {
        draft.mode = sel.value;
        renderAccount();
      });

      var uin = mk('input', 'wxs-in');
      uin.type = 'text';
      uin.inputMode = 'numeric';
      uin.placeholder = '要接的 QQ 号，例：2531357970';
      uin.value = draft.uin;
      uin.disabled = !!busy || draft.mode !== 'uin';
      uin.title = '只接这个 QQ 号；5–12 位数字';
      uin.classList.add('qqcs-uin');
      uin.addEventListener('input', function () { draft.uin = uin.value; });
      uin.addEventListener('blur', function () { draft.uin = digits(uin.value); uin.value = draft.uin; });

      secAccount.appendChild(row('接入方式', '默认「只接指定 QQ 号」；这是防双开接错号的主开关。', sel));
      secAccount.appendChild(row('QQ 号', '只在这里填一个号；换号后要同步插件 selfUin（下面会给提醒）。', uin));

      var act = mk('div', 'wxs-action-bar');
      var save = mk('button', 'wxs-btn is-primary', busy === 'auto' ? '保存中…' : '保存接入设置');
      save.type = 'button';
      save.disabled = !!busy;
      save.title = '写入本机桥接配置并立即按新策略重新识别 QQ 进程';
      save.addEventListener('click', saveAuto);
      act.appendChild(save);
      secAccount.appendChild(act);

      // 只读观察区：写盘之后到底接没接上，看这里而不是翻日志。
      var box = mk('div', 'wxs-subsec');
      box.appendChild(mk('div', 'wxs-subsec-title', '当前注入结果（只读）'));
      var st = String(auto.status || '');
      var line1 = st === 'connected' ? '● 已接：' + (auto.uin || auto.targetUin || '')
        : st === 'probing' ? '○ 正在识别 QQ 进程…'
          : st === 'error' ? '× 接入出错'
            : '· 等 QQ 上线';
      box.appendChild(mk('div', 'wxs-hint', line1 + (auto.detail ? ' · ' + auto.detail : '')));
      if (auto.pid) box.appendChild(mk('div', 'wxs-hint', '进程 ' + auto.pid));
      var cs = Array.isArray(auto.candidates) ? auto.candidates : [];
      if (cs.length) {
        box.appendChild(mk('div', 'wxs-hint', '本机 QQ：' + cs.map(function (c) {
          return 'pid ' + c.pid + (c.loggedIn ? '（' + c.uin + ' 在线）' : (c.injected ? '（已注入）' : '（未接）'));
        }).join(' · ')));
      }
      if (!cs.length && !auto.detail) {
        box.appendChild(mk('div', 'wxs-hint', '还没有检测到 QQ 进程；先登录 QQ，或到 SnowLuma 控制台看桥接。'));
      }
      if (auto.error) box.appendChild(mk('div', 'wxs-note is-bad', auto.error));
      if (auto.targetUin && auto.selfUin && String(auto.selfUin) !== String(auto.targetUin)) {
        box.appendChild(mk('div', 'wxs-note is-warn',
          '桥接插件的 selfUin 还是 ' + auto.selfUin + '，和要接的 ' + auto.targetUin + ' 不一致。'
          + '换号要同步改 ~/.dsh/qq-bridge.config.json 的 selfUin，否则会把自己的消息当别人。'));
      }
      secAccount.appendChild(box);
    }

    function saveAuto() {
      if (busy) return;
      var m = draft.mode;
      var u = digits(draft.uin);
      if (m === 'uin' && !/^\d{5,12}$/.test(u)) { toast('要接的 QQ 号要 5–12 位数字', true); return; }
      if (!bridgeApi || typeof bridgeApi.qqAutoLoadSet !== 'function') {
        toast('接入设置没接上：主进程/preload 还是旧的，重启一次工作台', true);
        return;
      }
      if (m === 'all') {
        var okAll = true;
        try { okAll = window.confirm('「本机全部 QQ」会把双开的主号和小号都注入 Hook，确定？'); } catch (e) { console.warn('[qq-settings] 确认框不可用', e); }
        if (!okAll) return;
      }
      busy = 'auto';
      renderAccount();
      Promise.resolve(bridgeApi.qqAutoLoadSet({ mode: m, uin: m === 'uin' ? u : '' })).then(function (r) {
        busy = '';
        if (!r || r.ok === false) {
          toast('保存失败：' + ((r && r.error) || '未知原因'), true);
          renderAccount();
          return;
        }
        var msg = '已保存：' + (r.detail || '接入策略已更新');
        toast(msg + (r.note ? '；' + r.note : ''), !!(r.note), r.note ? 9000 : 4000);
        reload();
      }).catch(function (e) {
        busy = '';
        toast('保存失败：' + String((e && e.message) || e), true);
        renderAccount();
      });
    }

    // ---------- 会话路由 ----------
    function renderRoutes() {
      secRoutes.textContent = '';
      secRoutes.appendChild(mk('div', 'wxs-sec-title', '会话路由（一个聊天一条 DSH 会话）'));
      secRoutes.appendChild(mk('div', 'wxs-sec-hint',
        '只有在这里接入过的私聊/群才会被监听。每个聊天首条需要回的消息会用它自己的会话，不再共用「胡闹的大肥鱼」；接入和移除都不动聊天记录。'));

      var summary = mk('div', 'wxs-hint',
        '私聊 ' + (Number(routes.privates) || 0) + ' · 群 ' + (Number(routes.groups) || 0)
        + ' · 独立 ' + (Number(routes.independent) || 0)
        + (Number(routes.shared) ? ' · 共用主会话 ' + routes.shared : ''));
      secRoutes.appendChild(summary);

      if (Number(routes.shared)) {
        var act0 = mk('div', 'wxs-action-bar');
        var ensure = mk('button', 'wxs-btn is-primary', busy === 'ensure' ? '迁移中…' : '把共用路由迁成独立会话');
        ensure.type = 'button';
        ensure.disabled = !!busy;
        ensure.title = '给每个还在共用主会话的 QQ 私聊/群建一条独立 DSH 会话并改绑 routes；不会动聊天记录';
        ensure.addEventListener('click', function () {
          if (busy || !chatApi || typeof chatApi.ensure !== 'function') return;
          busy = 'ensure';
          renderRoutes();
          Promise.resolve(chatApi.ensure()).then(function (x) {
            busy = '';
            if (!x || x.ok === false) { toast('迁移失败：' + ((x && x.error) || '未知原因'), true); }
            else {
              var note = x.saved && x.saved.restartRequired ? '；配置已落文件，重启整壳后生效' : '';
              toast((x.changed ? '已迁成独立会话' : '已经都是独立会话') + note, !!note);
            }
            reload();
          }).catch(function (e) {
            busy = '';
            toast('迁移失败：' + String((e && e.message) || e), true);
            renderRoutes();
          });
        });
        act0.appendChild(ensure);
        secRoutes.appendChild(act0);
      }

      // 新增聊天：必须手动填号，明确「加了才监听」；不做静默全量接入。
      var form = mk('div', 'wxs-subsec');
      form.appendChild(mk('div', 'wxs-subsec-title', '接一个新聊天'));
      var kind = mk('select', 'wxs-select');
      kind.title = '私聊：单个 QQ 号；群聊：QQ 群号';
      [['private', '私聊'], ['group', '群聊']].forEach(function (o) {
        var op = mk('option', '', o[1]);
        op.value = o[0];
        kind.appendChild(op);
      });
      kind.value = draft.kind;
      kind.disabled = !!busy;
      kind.addEventListener('change', function () { draft.kind = kind.value; });

      var idInp = mk('input', 'wxs-in');
      idInp.type = 'text';
      idInp.inputMode = 'numeric';
      idInp.placeholder = 'QQ 号 / 群号，例：2310468741';
      idInp.value = draft.id;
      idInp.disabled = !!busy;
      idInp.addEventListener('input', function () { draft.id = idInp.value; });

      var nameInp = mk('input', 'wxs-in');
      nameInp.type = 'text';
      nameInp.placeholder = '备注名（可选，方便认人）';
      nameInp.value = draft.name;
      nameInp.disabled = !!busy;
      nameInp.addEventListener('input', function () { draft.name = nameInp.value; });

      var kindRow = row('类型', '', kind);
      kindRow.classList.add('qqcs-kind-row');
      form.appendChild(kindRow);
      form.appendChild(row('号码', '接入后插件才会监听这个聊天。', idInp));
      form.appendChild(row('备注名', '只用于界面识别，不会发给对方。', nameInp));

      var act1 = mk('div', 'wxs-action-bar');
      var add = mk('button', 'wxs-btn is-primary', busy === 'add' ? '接入中…' : '接入并建独立会话');
      add.type = 'button';
      add.disabled = !!busy;
      add.title = '先建一条独立 DSH 会话，再把这类聊天的 routes 指过去；建成功才算接通';
      add.addEventListener('click', function () {
        if (busy) return;
        var id = digits(draft.id);
        if (!/^\d{5,12}$/.test(id)) { toast('QQ 号/群号要 5–12 位数字', true); return; }
        if (!chatApi || typeof chatApi.add !== 'function') {
          toast('会话路由没接上：主进程/preload 还是旧的，重启一次工作台', true);
          return;
        }
        busy = 'add';
        renderRoutes();
        Promise.resolve(chatApi.add({ kind: draft.kind, id: id, name: draft.name })).then(function (x) {
          busy = '';
          if (!x || x.ok === false) { toast('接入失败：' + ((x && x.error) || '未知原因'), true); }
          else {
            draft.id = '';
            draft.name = '';
            var note = x.saved && x.saved.restartRequired ? '；配置已落文件，重启整壳后生效' : '';
            toast((x.reused ? '这个聊天已经有独立会话，已复用' : '已建独立会话并接入 QQ') + note, !!note);
          }
          reload();
        }).catch(function (e) {
          busy = '';
          toast('接入失败：' + String((e && e.message) || e), true);
          renderRoutes();
        });
      });
      act1.appendChild(add);
      form.appendChild(act1);
      secRoutes.appendChild(form);

      // 已接入清单：一行一个聊天，状态用文字，不只靠颜色。
      var listBox = mk('div', 'wxs-subsec');
      listBox.appendChild(mk('div', 'wxs-subsec-title', '已接入的聊天（' + (Array.isArray(routes.routes) ? routes.routes.length : 0) + '）'));
      var list = Array.isArray(routes.routes) ? routes.routes : [];
      if (!list.length) {
        listBox.appendChild(mk('div', 'wxs-hint', '还没有 QQ 聊天路由。上面接一个 QQ 号或群号，插件才会开始监听。'));
      } else {
        list.forEach(function (r0) {
          var word = r0.kind === 'group' ? '群' : '私聊';
          var line = mk('div', 'qqcs-route');
          var info = mk('div', 'qqcs-route-info');
          var chatName = String(r0.chatTitle || '');
          info.appendChild(mk('div', 'qqcs-route-name', word + ' ' + r0.id + (chatName ? ' · ' + chatName : '')));
          info.appendChild(mk('div', 'wxs-hint',
            (r0.independent ? '独立会话' : (r0.shared ? '共用人格主会话' : '未绑定会话'))
            + (r0.sessionTitle && r0.sessionTitle !== chatName ? ' · ' + r0.sessionTitle : '')));
          line.title = 'DSH 会话：' + (r0.sessionId || '（空）');
          line.appendChild(info);
          var del = mk('button', 'wxs-btn wxs-mini', '移除');
          del.type = 'button';
          del.disabled = !!busy;
          del.title = '只解除这个聊天的路由，不删除聊天记录与会话';
          del.addEventListener('click', function () {
            if (busy) return;
            var ok = true;
            try {
              ok = window.confirm('解除「' + word + ' ' + r0.id + '」的 QQ 路由？\n只改路由，不删聊天记录；之后这个聊天不会再自动进来。');
            } catch (e) { console.warn('[qq-settings] 确认框不可用', e); }
            if (!ok) return;
            if (!chatApi || typeof chatApi.remove !== 'function') {
              toast('会话路由没接上：主进程/preload 还是旧的，重启一次工作台', true);
              return;
            }
            busy = 'remove';
            renderRoutes();
            Promise.resolve(chatApi.remove({ kind: r0.kind, id: r0.id })).then(function (x) {
              busy = '';
              var note = x && x.saved && x.saved.restartRequired ? '；配置已落文件，重启整壳后生效' : '';
              toast(x && x.ok === false ? ('移除失败：' + ((x && x.error) || '未知原因')) : ('已解除该聊天的路由' + note), !!(x && x.ok === false) || !!note);
              reload();
            }).catch(function (e) {
              busy = '';
              toast('移除失败：' + String((e && e.message) || e), true);
              renderRoutes();
            });
          });
          line.appendChild(del);
          listBox.appendChild(line);
        });
      }
      secRoutes.appendChild(listBox);
    }

    function renderTabs() {
      tabDefs.forEach(function (t) { tabBtns[t[0]].classList.toggle('is-on', t[0] === activeTab); });
      secAccount.classList.toggle('is-on', activeTab === 'account');
      secRoutes.classList.toggle('is-on', activeTab === 'routes');
    }

    function reload(syncDraft) {
      if (closed) return Promise.resolve(false);
      if (reloading) return Promise.resolve(false);
      reloading = true;
      reloadBtn.disabled = true;
      var ps = [];
      ps.push(bridgeApi && typeof bridgeApi.qqAutoLoadStatus === 'function'
        ? Promise.resolve(bridgeApi.qqAutoLoadStatus())
        : Promise.resolve({ ok: false, error: '没有 bridge.qqAutoLoadStatus（重启一次工作台）' }));
      ps.push(chatApi && typeof chatApi.status === 'function'
        ? Promise.resolve(chatApi.status())
        : Promise.resolve({ ok: false, error: '没有 qqChats.status（重启一次工作台）' }));
      return Promise.all(ps).then(function (rs) {
        var a = rs[0] || {};
        var r = rs[1] || {};
        if (a && a.ok !== false) {
          auto = a;
          // 只有写入后（或第一次打开）才把磁盘值回填草稿；手动点「刷新」不覆盖正在输入的号。
          if (syncDraft) {
            draft.mode = String(a.mode || draft.mode);
            draft.uin = String(a.targetUin || '');
          }
        }
        if (r && r.ok !== false) routes = r;
        reloading = false;
        reloadBtn.disabled = false;
        renderSum();
        renderAccount();
        renderRoutes();
        return true;
      }).catch(function (e) {
        reloading = false;
        reloadBtn.disabled = false;
        toast('刷新失败：' + String((e && e.message) || e), true, 10000);
        return false;
      });
    }

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      try { mask.remove(); } catch (e) { console.warn('[qq-settings] 弹窗移除失败', e); }
    }
    function onKey(e) {
      if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); e.stopPropagation(); close(); }
    }

    reloadBtn.addEventListener('click', function () { reload(false); });
    closeBtn.addEventListener('click', close);
    x.addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey, true);

    renderTabs();
    renderSum();
    renderAccount();
    renderRoutes();
    document.body.appendChild(mask);
    try { closeBtn.focus(); } catch (e) { console.warn('[qq-settings] 初始焦点失败', e); }
    return true;
  }

  window.openQqChannelSettings = function () {
    if (!bridgeApi || typeof bridgeApi.qqAutoLoadStatus !== 'function'
      || !chatApi || typeof chatApi.status !== 'function') {
      toast('QQ 接入设置没接上：主进程/preload 还是旧的，重启一次工作台', true, 10000);
      return Promise.resolve(false);
    }
    if (document.querySelector('.qqcs-mask')) return Promise.resolve(false);
    if (document.querySelector('.wxs-mask')) {
      toast('已有一个通道设置弹窗打开，先关掉它再开 QQ 接入设置', true);
      return Promise.resolve(false);
    }
    return Promise.all([bridgeApi.qqAutoLoadStatus(), chatApi.status()]).then(function (rs) {
      var a = rs && rs[0];
      var r = rs && rs[1];
      if (!a || a.ok === false) { toast('读不到默认接入状态：' + ((a && a.error) || '未知原因'), true, 10000); return false; }
      if (!r || r.ok === false) { toast('读不到 QQ 会话路由：' + ((r && r.error) || '未知原因'), true, 10000); return false; }
      return build(a, r);
    }).catch(function (e) {
      toast('读不到 QQ 接入设置：' + String((e && e.message) || e), true, 10000);
      return false;
    });
  };
})();
