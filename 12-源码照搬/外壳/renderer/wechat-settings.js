'use strict';
// 鲸鲸设置弹窗（2026-11-18）
// 为什么不做成 top-level 面板：用户已经要求通道不要一块一块占区域；设置是低频动作，
// 入口常驻在微信卡标题行，打开后按「连接 / 群聊 / 功能 / 回复 / 高级」切换，一次只改一块。
//
// 数据面：window.app.wechat.settingsGet / settingsSave（主进程只收白名单字段）。
// 账号不混进批量保存——账号必须走 pinAccount（同时钉窗口、重启桥接），否则会选错号。
// 交互约定：默认值来自真实配置；改动只进表单，点保存才写盘；有未保存修改时关窗先确认；
// 危险项（关掉必须 @、关掉后台发送、打开主动点赞/日记外发）单独确认；「只保存」不会偷偷重启通道。
// 会话隔离是只读状态：每个私聊/群聊独立 DSH 会话，首条需要回的消息自动建，不允许在这里手填 id。

(function () {
  var api = window.app && window.app.wechat;

  function toast(msg, bad, ms) {
    try {
      if (typeof window.__tbsToast === 'function') {
        window.__tbsToast(msg, !!bad, ms || (bad ? 8000 : 3000));
        return;
      }
    } catch (e) { console.warn('[wechat-settings] 顶栏通知不可用', e); }
    try { console.log('[wechat-settings] ' + msg); } catch (e2) { console.warn('[wechat-settings] 日志不可用', e2); }
  }
  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function bool(v, dflt) {
    if (v === undefined || v === null) return !!dflt;
    return v !== false && v !== 0 && !/^(?:false|0|off|no)$/i.test(String(v).trim());
  }
  function num(v, dflt, lo, hi) {
    var n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function has(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function put(obj, path, val) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }
  function get(obj, path) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function flat(o, prefix, out) {
    out = out || {};
    if (!o || typeof o !== 'object') return out;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      var p = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, p, out);
      else out[p] = v;
    });
    return out;
  }
  function diffKeys(a, b) {
    var fa = flat(a, '', {});
    var fb = flat(b, '', {});
    var out = [];
    Object.keys(fa).forEach(function (k) {
      if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) out.push(k);
    });
    Object.keys(fb).forEach(function (k) {
      if (!has(fa, k)) out.push(k);
    });
    return out;
  }
  function viewToForm(c) {
    var g = (c && c.group) || {};
    var w = (c && c.wechat) || {};
    var n = (c && c.native) || {};
    return {
      autoStart: bool(c && c.autoStart, true),
      maxChars: num(c && c.maxChars, 300, 60, 2000),
      group: {
        requireAt: bool(g.requireAt, true),
        freeChat: bool(g.freeChat, false),
        freeChatChance: num(g.freeChatChance, 6, 0, 100),
        engagedMinutes: num(g.engagedMinutes, 6, 1, 120),
        silentMinutes: num(g.silentMinutes, 30, 1, 240),
        cooldownSec: num(g.cooldownSec, 0, 0, 3600),
        maxRepliesPerMinute: num(g.maxRepliesPerMinute, 15, 1, 120)
      },
      wechat: {
        backgroundSend: bool(w.backgroundSend, true),
        accountGuard: bool(w.accountGuard, true),
        quoteReply: bool(w.quoteReply, false)
      },
      native: {
        voice: bool(n.voice, true),
        vision: bool(n.vision, true),
        links: bool(n.links, true),
        websearch: bool(n.websearch, true),
        stickers: bool(n.stickers, true),
        diary: bool(n.diary, true),
        diarySend: bool(n.diarySend, true),
        momentsAutoRead: num(n.momentsAutoRead, 6, 0, 24),
        momentsAutoLike: bool(n.momentsAutoLike, true),
        voiceReply: bool(n.voiceReply, true),
        voiceReplyPrivate: bool(n.voiceReplyPrivate, true),
        voiceReplyGroups: bool(n.voiceReplyGroups, false),
        voiceReplyChance: num(n.voiceReplyChance, 0, 0, 100),
        groupAddressGuard: bool(n.groupAddressGuard, true),
        apiKey: '',
        visionApiKey: '',
        voiceApiKey: '',
        apiKeyConfigured: bool(n.apiKeyConfigured, false),
        visionKeyConfigured: bool(n.visionKeyConfigured, false),
        voiceKeyConfigured: bool(n.voiceKeyConfigured, false),
        provider: String(n.provider || 'deepseek')
      },
      stickerGen: {
        apiKey: '',
        apiKeyConfigured: bool(c && c.stickerGen && c.stickerGen.apiKeyConfigured, false),
        model: String((c && c.stickerGen && c.stickerGen.model) || 'qwen-image-2.1-pro'),
        category: String((c && c.stickerGen && c.stickerGen.category) || '鲸鲸千问'),
        chat: String((c && c.stickerGen && c.stickerGen.chat) || '静音胡闹'),
        auto: bool(c && c.stickerGen && c.stickerGen.auto, true),
        autoMax: num(c && c.stickerGen && c.stickerGen.autoMax, 8, 1, 30)
      }
    };
  }
  function formToPayload(f) {
    var nativeOut = {
      voice: !!f.native.voice,
      links: !!f.native.links,
      websearch: !!f.native.websearch,
      stickers: !!f.native.stickers,
      diary: !!f.native.diary,
      diarySend: !!f.native.diarySend,
      momentsAutoRead: num(f.native.momentsAutoRead, 6, 0, 24),
      momentsAutoLike: !!f.native.momentsAutoLike,
      voiceReply: !!f.native.voiceReply,
      voiceReplyPrivate: !!f.native.voiceReplyPrivate,
      voiceReplyGroups: !!f.native.voiceReplyGroups,
      voiceReplyChance: num(f.native.voiceReplyChance, 0, 0, 100),
      groupAddressGuard: !!f.native.groupAddressGuard,
      accountGuard: !!f.wechat.accountGuard,
      backgroundSend: !!f.wechat.backgroundSend,
      quoteReply: !!f.wechat.quoteReply
    };
    // 密钥只在用户输入新值时提交；空串 = 保持原值，不在前端回显。
    if (String(f.native.apiKey || '').trim()) nativeOut.apiKey = String(f.native.apiKey).trim();
    if (String(f.native.visionApiKey || '').trim()) nativeOut.visionApiKey = String(f.native.visionApiKey).trim();
    if (String(f.native.voiceApiKey || '').trim()) nativeOut.voiceApiKey = String(f.native.voiceApiKey).trim();
    return {
      autoStart: !!f.autoStart,
      maxChars: num(f.maxChars, 300, 60, 2000),
      group: {
        requireAt: !!f.group.requireAt,
        freeChat: !!f.group.freeChat,
        freeChatChance: num(f.group.freeChatChance, 6, 0, 100),
        engagedMinutes: num(f.group.engagedMinutes, 6, 1, 120),
        silentMinutes: num(f.group.silentMinutes, 30, 1, 240),
        cooldownSec: num(f.group.cooldownSec, 0, 0, 3600),
        maxRepliesPerMinute: num(f.group.maxRepliesPerMinute, 15, 1, 120)
      },
      wechat: {
        backgroundSend: !!f.wechat.backgroundSend,
        accountGuard: !!f.wechat.accountGuard,
        quoteReply: !!f.wechat.quoteReply
      },
      native: nativeOut,
      stickerGen: {
        apiKey: String(f.stickerGen.apiKey || '').trim() || undefined,
        model: String(f.stickerGen.model || 'qwen-image-2.1-pro'),
        category: String(f.stickerGen.category || '鲸鲸千问'),
        chat: String(f.stickerGen.chat || ''),
        auto: !!f.stickerGen.auto,
        autoMax: num(f.stickerGen.autoMax, 8, 1, 30)
      }
    };
  }
  function summaryOf(st) {
    if (!st || (st.ok === false && !st.state)) return '通道状态读取失败';
    var run = st.running ? '运行中' : '未运行';
    var acct = st.accountLabel || st.pinnedAccountLabel || '未上报账号';
    var br = (st.bridge && st.bridge.online === true) ? '桥接在线' : '桥接离线';
    var mis = st.accountMismatch ? ' · 账号与钉住不一致' : '';
    return run + ' · ' + acct + ' · ' + br + mis;
  }

  function build(data) {
    var cfg = data.config || {};
    var form = viewToForm(cfg);
    var baseForm = clone(form);
    var status = data.status || {};
    var paths = data.paths || {};
    var saving = false;
    var footError = '';

    var mask = mk('div', 'wxs-mask');
    mask.setAttribute('role', 'presentation');
    var dlg = mk('div', 'wxs-dlg');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'wxs-title');
    mask.appendChild(dlg);

    var head = mk('div', 'wxs-head');
    var hw = mk('div', 'wxs-hw');
    var title = mk('div', 'wxs-title', '鲸鲸设置');
    title.id = 'wxs-title';
    var sub = mk('div', 'wxs-sub', '微信通道 · 只改通道层，不改 DSH 人格');
    hw.appendChild(title); hw.appendChild(sub);
    var closeBtn = mk('button', 'wxs-x', '✕');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（未保存的修改会先确认）';
    head.appendChild(hw); head.appendChild(closeBtn);
    dlg.appendChild(head);

    var sum = mk('div', 'wxs-sum');
    dlg.appendChild(sum);

    var tabBar = mk('div', 'wxs-tabs');
    var tabs = [
      ['conn', '连接', '账号 / 自动启动'],
      ['group', '群聊', '隔离 / 触发 / 接话'],
      ['features', '功能', '语音 / 贴纸 / 朋友圈 / 日记'],
      ['reply', '回复', '长度 / 后台发送'],
      ['advanced', '高级', '路径 / 重启 / 只读项']
    ];
    var tabBtns = {};
    tabs.forEach(function (t) {
      var b = mk('button', 'wxs-tab', t[1]);
      b.type = 'button';
      b.title = t[2];
      b.dataset.tab = t[0];
      b.addEventListener('click', function () { setTab(t[0]); });
      tabBar.appendChild(b);
      tabBtns[t[0]] = b;
    });
    dlg.appendChild(tabBar);

    var body = mk('div', 'wxs-body');
    dlg.appendChild(body);
    var secs = {};

    var foot = mk('div', 'wxs-foot');
    var footHint = mk('div', 'wxs-fh', '');
    var discard = mk('button', 'wxs-btn', '放弃修改');
    var saveOnly = mk('button', 'wxs-btn', '只保存');
    var apply = mk('button', 'wxs-btn is-primary', '保存并应用');
    discard.type = saveOnly.type = apply.type = 'button';
    foot.appendChild(footHint);
    foot.appendChild(discard);
    foot.appendChild(saveOnly);
    foot.appendChild(apply);
    dlg.appendChild(foot);

    var prevFocus = document.activeElement;
    var closed = false;

    function addSec(key, titleText, hintText) {
      var card = mk('div', 'wxs-sec');
      var t = mk('div', 'wxs-sec-title', titleText);
      card.appendChild(t);
      if (hintText) card.appendChild(mk('div', 'wxs-sec-hint', hintText));
      body.appendChild(card);
      secs[key] = card;
      return card;
    }
    function row(label, hint, control) {
      var r = mk('div', 'wxs-row');
      var l = mk('div', 'wxs-lab-wrap');
      l.appendChild(mk('div', 'wxs-lab', label));
      if (hint) l.appendChild(mk('div', 'wxs-hint', hint));
      r.appendChild(l);
      if (control) {
        var c = mk('div', 'wxs-ctrl');
        c.appendChild(control);
        r.appendChild(c);
      }
      return r;
    }
    function switchRow(label, hint, getVal, setVal, after) {
      var input = mk('input');
      input.type = 'checkbox';
      input.checked = !!getVal();
      var sw = mk('label', 'wxs-switch');
      var slider = mk('span', 'wxs-slider');
      sw.appendChild(input); sw.appendChild(slider);
      input.addEventListener('change', function () {
        setVal(input.checked);
        if (after) after();
        footError = '';
        refreshDirty();
      });
      return { row: row(label, hint, sw), input: input };
    }
    function numberRow(label, hint, path, lo, hi, unit, after) {
      var input = mk('input', 'wxs-num');
      input.type = 'number';
      input.min = String(lo); input.max = String(hi); input.step = '1';
      input.value = String(get(form, path));
      input.addEventListener('input', function () {
        var n = Number(input.value);
        if (!Number.isFinite(n)) return;
        put(form, path, n);
        if (after) after();
        footError = '';
        refreshDirty();
      });
      input.addEventListener('blur', function () {
        var n = Number(input.value);
        if (!Number.isFinite(n)) { input.value = String(get(form, path)); return; }
        var v = Math.max(lo, Math.min(hi, Math.round(n)));
        input.value = String(v);
        put(form, path, v);
        if (after) after();
        footError = '';
        refreshDirty();
      });
      var wrap = mk('div', 'wxs-num-wrap');
      wrap.appendChild(input);
      wrap.appendChild(mk('span', 'wxs-unit', unit));
      return { row: row(label, hint, wrap), input: input };
    }
    function pathRow(label, value, hint) {
      var v = mk('div', 'wxs-path', value || '—');
      return row(label, hint || '', v);
    }
    function selectRow(label, hint, path, options, after) {
      var sel = mk('select', 'wxs-select');
      options.forEach(function (o) {
        var op = mk('option', '', o[1]);
        op.value = String(o[0]);
        sel.appendChild(op);
      });
      sel.value = String(get(form, path));
      sel.addEventListener('change', function () {
        put(form, path, Number(sel.value));
        if (after) after();
        footError = '';
        refreshDirty();
      });
      return { row: row(label, hint, sel), input: sel };
    }

    // ---------- 顶部状态 ----------
    function renderSummary() {
      sum.innerHTML = '';
      var okRun = !!(status && status.running);
      var br = status && status.bridge;
      var brOn = !!(br && br.online === true);
      var acct = status && (status.accountLabel || status.pinnedAccountLabel);
      var p1 = mk('span', 'wxs-pill ' + (okRun ? 'is-ok' : 'is-off'), okRun ? '通道运行中' : '通道未运行');
      var p2 = mk('span', 'wxs-pill', '账号 ' + (acct || '未上报'));
      if (status && status.accountMismatch) p2.className = 'wxs-pill is-bad';
      var p3 = mk('span', 'wxs-pill ' + (brOn ? 'is-ok' : 'is-warn'), brOn ? '桥接在线' : '桥接离线');
      sum.appendChild(p1); sum.appendChild(p2); sum.appendChild(p3);
      var iso = status && status.sessionIsolation;
      if (iso) {
        sum.appendChild(mk('span', 'wxs-pill ' + (iso.enabled ? 'is-ok' : 'is-bad'),
          iso.enabled ? ('会话隔离 · ' + (Number(iso.count) || 0) + ' 个独立') : '会话隔离未生效'));
      }
      sum.appendChild(mk('span', 'wxs-sum-text', summaryOf(status)));
    }

    // ---------- 连接 ----------
    var conn = addSec('conn', '连接', '账号和启动方式。账号只接小号；主号不要选。');
    var accWrap = mk('div', 'wxs-account');
    var accSel = mk('select', 'wxs-select');
    accSel.title = '选择要接的微信账号；不选 = 自动按最近活跃（双开可能选错）';
    var accounts = Array.isArray(status.accounts) ? status.accounts.slice() : [];
    var want = String(status.pinnedAccount || cfg.account || '');
    if (want && !accounts.some(function (a) {
      return String(a.account || '') === want || String(a.wxid || '') === want;
    })) accounts.push({ account: want, label: want, current: false, pinned: true });
    var autoOpt = mk('option', '', '自动：最近活跃（双开可能选错）');
    autoOpt.value = '';
    accSel.appendChild(autoOpt);
    var selectedAccountValue = '';
    accounts.forEach(function (a) {
      var v = String(a.account || a.wxid || '');
      if (!v) return;
      var o = mk('option', '', String(a.label || a.nick || v));
      if (a.current) o.textContent = String(a.label || a.nick || v) + '（当前）';
      if (a.pinned) o.textContent = String(a.label || a.nick || v) + '（已钉）';
      o.value = v;
      accSel.appendChild(o);
      if (want && (String(a.account || '') === want || String(a.wxid || '') === want)) selectedAccountValue = v;
    });
    accSel.value = selectedAccountValue;
    accSel.disabled = !accounts.length;
    var accBtn = mk('button', 'wxs-btn', '保存账号');
    accBtn.type = 'button';
    accBtn.disabled = !accounts.length;
    accBtn.title = '保存后会把桥接重启一次；主号不要选';
    function saveAccount() {
      if (!api || typeof api.pinAccount !== 'function') { toast('账号保存没接上：重启一次工作台', true); return; }
      var chosen = String(accSel.value || '');
      var label = chosen;
      try {
        if (accSel.selectedIndex >= 0) label = String(accSel.options[accSel.selectedIndex].textContent || chosen);
      } catch (e) { console.warn('[wechat-settings] 读账号标签失败', e); }
      var msg = chosen
        ? ('把「' + label + '」钉成要接的微信小号？\n会重启一次桥接；如果这是主号，先取消并换小号。')
        : '改成「自动：最近活跃」？\n双开时可能自动选到主号，建议手动选小号。';
      if (!window.confirm(msg)) return;
      accBtn.disabled = true;
      Promise.resolve(api.pinAccount(chosen)).then(function (r) {
        accBtn.disabled = false;
        if (!r || r.ok === false) { toast('保存账号失败：' + ((r && r.error) || '未知原因'), true); return; }
        if (status) {
          status.pinnedAccount = String(r.account || '');
          status.pinnedAccountLabel = String(r.accountLabel || r.account || '');
          status.accountLabel = String(r.accountLabel || status.accountLabel || '');
        }
        toast('已保存账号：' + (r.accountLabel || r.account || '自动（最近活跃）') + (r.note ? '；' + r.note : ''));
        renderSummary();
      }).catch(function (e) {
        accBtn.disabled = false;
        toast('保存账号失败：' + String((e && e.message) || e), true);
      });
    }
    accBtn.addEventListener('click', saveAccount);
    accWrap.appendChild(accSel); accWrap.appendChild(accBtn);
    conn.appendChild(row('微信账号', '双开时只接小号；账号保存和下面的批量设置分开，避免误存。', accWrap));
    var auto = switchRow('随工作台启动', '关闭后壳启动不会自动接微信；手动点启动仍可用。', function () { return form.autoStart; }, function (v) {
      form.autoStart = !!v;
    });
    conn.appendChild(auto.row);
    var guard = switchRow('窗口守卫（双开钉账号）', '同时登两个微信时只从钉住的窗口发送；认不出账号宁可不发。关掉会把消息发到前台窗口，双开时很危险。', function () { return form.wechat.accountGuard; }, function (v) {
      form.wechat.accountGuard = !!v;
    });
    conn.appendChild(guard.row);
    var winText = String((cfg.wechat && cfg.wechat.windowHwnd) || '启动通道时重扫主窗');
    conn.appendChild(pathRow('当前微信主窗', winText, '自动识别唯一可见主窗；双开时先关掉另一个窗口。'));
    conn.appendChild(pathRow('微信数据目录', cfg.wechat && cfg.wechat.dbDir, '鲸鲸读取本地 SQLite 的目录；Junction 已按真实路径处理。'));

    // ---------- 群聊 ----------
    var groupSec = addSec('group', '群聊', '先看会话隔离是否真的生效，再决定“什么时候接”。默认每个私聊 / 每个群一条独立 DSH 会话，不再共用工作台人格会话。');

    // 会话隔离是只读观察区：映射由通道在首条消息时自动建，界面只展示，不手填 id。
    var isoCard = mk('div', 'wxs-iso');
    groupSec.appendChild(isoCard);
    function fmtWhen(ms) {
      var n = Number(ms);
      if (!n) return '';
      try {
        return new Date(n).toLocaleString('zh-CN', { hour12: false });
      } catch (e) { console.warn('[wechat-settings] 时间格式化失败', e); return ''; }
    }
    function renderIsolation() {
      isoCard.textContent = '';
      var iso = status && status.sessionIsolation;
      var on = !!(iso && iso.enabled);
      isoCard.className = 'wxs-iso ' + (on ? 'is-on' : 'is-off');
      var head = mk('div', 'wxs-iso-head');
      head.appendChild(mk('span', 'wxs-iso-dot', ''));
      var ht = mk('div', 'wxs-iso-h');
      ht.appendChild(mk('div', 'wxs-iso-title', '会话隔离：' + (on ? '已生效' : (iso ? '未生效' : '状态未上报'))));
      ht.appendChild(mk('div', 'wxs-iso-sub', iso
        ? ('每个私聊 / 每个群各自一条 DSH 会话；首条需要工作台回的消息自动建。当前群 ' + (Number(iso.groups) || 0) + ' / 私聊 ' + (Number(iso.privates) || 0) + ' / 共 ' + (Number(iso.count) || 0) + ' 条。')
        : '当前壳还没返回会话隔离状态；重启一次工作台/通道再刷新。'));
      head.appendChild(ht);
      var ref = mk('button', 'wxs-btn wxs-iso-refresh', '刷新映射');
      ref.type = 'button';
      ref.title = '只刷新这里的会话列表，不会覆盖你正在改的表单';
      ref.addEventListener('click', refreshIsolation);
      head.appendChild(ref);
      isoCard.appendChild(head);
      if (!iso) {
        isoCard.appendChild(mk('div', 'wxs-note', '没有隔离状态时不要判断“已生效”；先重启通道，再发一条私聊/群聊。'));
        return;
      }
      var items = Array.isArray(iso.items) ? iso.items : [];
      if (!items.length) {
        isoCard.appendChild(mk('div', 'wxs-iso-empty', '还没有微信独立会话。给饭团发一条需要回的私聊，或在群里 @ 它一次，首条消息会自动建对应会话。'));
        return;
      }
      var list = mk('div', 'wxs-map');
      var headRow = mk('div', 'wxs-map-row wxs-map-head');
      headRow.appendChild(mk('span', 'wxs-map-name', '会话'));
      headRow.appendChild(mk('span', 'wxs-map-id', 'DSH 会话'));
      headRow.appendChild(mk('span', 'wxs-map-time', '最近'));
      list.appendChild(headRow);
      items.forEach(function (it) {
        var r = mk('div', 'wxs-map-row');
        var name = mk('div', 'wxs-map-name');
        name.appendChild(mk('div', 'wxs-map-title', (it.chatType === 'group' ? '群 · ' : '私聊 · ') + (it.chatTitle || it.chatId || '未命名')));
        name.appendChild(mk('div', 'wxs-map-sub', it.title || ''));
        r.appendChild(name);
        var sid = mk('span', 'wxs-map-id', String(it.sessionId || '').slice(0, 14) || '—');
        sid.title = it.sessionId || '';
        r.appendChild(sid);
        r.appendChild(mk('span', 'wxs-map-time', fmtWhen(it.lastAt || it.createdAt) || '—'));
        list.appendChild(r);
      });
      isoCard.appendChild(list);
      isoCard.appendChild(mk('div', 'wxs-iso-note', '这里只读：会话由通道自动建/认回。一个群或一个私聊只对应一条会话；要重置就换会话后用新映射，别手改 id。'));
    }
    function refreshIsolation() {
      if (!api || typeof api.status !== 'function') {
        toast('状态接口没接上：重启一次工作台', true);
        return;
      }
      Promise.resolve(api.status()).then(function (s) {
        if (s && s.sessionIsolation && status) status.sessionIsolation = s.sessionIsolation;
        renderIsolation();
        renderSummary();
      }).catch(function (e) { toast('刷新会话映射失败：' + String((e && e.message) || e), true); });
    }
    renderIsolation();

    var mode = mk('div', 'wxs-mode', '');
    var req = switchRow('必须 @ 或叫名字才回', '关掉后不再要求 @，群消息会按下面概率主动接话，可能误接/刷屏。', function () { return form.group.requireAt; }, function (v) {
      form.group.requireAt = !!v;
    }, updateGroupUi);
    groupSec.appendChild(req.row);
    var free = switchRow('允许偶尔主动接话', '只在群聊生效；按概率抽，不是每条都回。要求 @ 时也可以开，用来偶尔插话。', function () { return form.group.freeChat; }, function (v) {
      form.group.freeChat = !!v;
    }, updateGroupUi);
    groupSec.appendChild(free.row);
    var chance = numberRow('主动接话概率', '每次群消息的抽中概率；只在“允许主动接话”或“不要求 @”时生效。', 'group.freeChatChance', 0, 100, '%', updateGroupUi);
    groupSec.appendChild(chance.row);
    var eng = numberRow('接话窗口', '被叫到后，同一个人在这段时间内继续问，不 @ 也接；超过窗口的旁人闲聊不回。', 'group.engagedMinutes', 1, 120, '分钟');
    groupSec.appendChild(eng.row);
    var silent = numberRow('静默后重置接话窗口', '群里超过这段时间没消息，就认为上一轮话题结束，不继续接旧话。', 'group.silentMinutes', 1, 240, '分钟');
    groupSec.appendChild(silent.row);
    var addr = switchRow('群地址判断', '别人互相骂、@ 别人或说第三人称时不插嘴；这是鲸鲸原生的“这句话在说谁”判断。', function () { return form.native.groupAddressGuard; }, function (v) { form.native.groupAddressGuard = !!v; });
    groupSec.appendChild(addr.row);
    var isoG = status && status.sessionIsolation;
    var gl = status && status.groupListen;
    var glText = '群聊旁听状态未上报（启动通道后刷新本页）';
    if (gl && gl.records > 0) {
      glText = '已记录 ' + (Number(gl.groups) || 0) + ' 个群 / ' + (Number(gl.records) || 0) + ' 条' +
        (gl.latestAt ? (' · 最近 ' + new Date(Number(gl.latestAt)).toLocaleTimeString('zh-CN')) : '');
    } else if (gl) {
      glText = '钩子已挂，还没有群消息；群里发一条（不 @ 也行）就会落盘';
    }
    var glWrap = mk('div', 'wxs-key-wrap');
    var glPill = mk('span', 'wxs-pill ' + (gl && gl.records > 0 ? 'is-ok' : 'is-warn'), glText);
    var glRefresh = mk('button', 'wxs-btn', '刷新');
    glRefresh.type = 'button';
    glRefresh.title = '只刷新旁听记录数，不动你正在改的表单';
    glRefresh.addEventListener('click', function () {
      if (!api || typeof api.status !== 'function') { toast('状态接口没接上：重启一次工作台', true); return; }
      Promise.resolve(api.status()).then(function (s) {
        var next = (s && s.groupListen) || {};
        if (status) status.groupListen = next;
        var text = Number(next.records) > 0
          ? ('已记录 ' + (Number(next.groups) || 0) + ' 个群 / ' + (Number(next.records) || 0) + ' 条' +
            (next.latestAt ? (' · 最近 ' + new Date(Number(next.latestAt)).toLocaleTimeString('zh-CN')) : ''))
          : '钩子已挂，还没有群消息；群里发一条（不 @ 也行）就会落盘';
        glPill.textContent = text;
        glPill.className = 'wxs-pill ' + (Number(next.records) > 0 ? 'is-ok' : 'is-warn');
        toast('旁听状态已刷新');
      }).catch(function (e) { toast('刷新旁听状态失败：' + String((e && e.message) || e), true); });
    });
    glWrap.appendChild(glPill);
    glWrap.appendChild(glRefresh);
    groupSec.appendChild(row('群聊旁听记忆 · 实际记录',
      '不 @ 她的群消息也会进旁听记录；每个群一条独立 DSH 会话，不会和私聊串。' +
      (isoG ? (' 独立群会话 ' + (Number(isoG.groups) || 0) + ' 个。') : ''),
      glWrap));
    var cool = numberRow('最短冷却', '两次群回复之间至少隔几秒；0 = 不额外冷却（仍受下面每分钟上限约束）。', 'group.cooldownSec', 0, 3600, '秒');
    groupSec.appendChild(cool.row);
    var cap = numberRow('每分钟最多回', '单个群每分钟回复上限，防刷屏。', 'group.maxRepliesPerMinute', 1, 30, '条');
    groupSec.appendChild(cap.row);
    groupSec.appendChild(mk('div', 'wxs-note', '注意：名字触发会命中账号昵称和别名（饭团 / 大肥鱼 / 肥鱼 / 鲸鲸等），名字出现在句子中间也算。只想 @ 时，不能只靠这个开关，还要收窄别名。'));
    function updateGroupUi() {
      var strict = form.group.requireAt && !form.group.freeChat;
      free.input.disabled = !form.group.requireAt;
      chance.input.disabled = strict;
      var pct = num(form.group.freeChatChance, 6, 0, 100);
      if (form.group.requireAt) {
        mode.textContent = '当前：只 @ / 叫名字时回' + (form.group.freeChat ? '；其他消息有 ' + pct + '% 概率主动接话' : '。');
      } else {
        mode.textContent = '当前：不要求 @；每条群消息有 ' + pct + '% 概率接话' + (pct === 0 ? '（等于不回）' : '。');
      }
    }
    updateGroupUi();

    // ---------- 功能（鲸鲸原生能力）----------
    var featSec = addSec('features', '功能', '这些是鲸鲸自己的原生能力，不是 DSH 的；开关打开只代表通道允许，模型 Key / 贴纸素材缺失时仍不会真正生成。');
    var featTop = mk('div', 'wxs-feat-state ' + (form.native.apiKeyConfigured ? 'is-ok' : 'is-warn'));
    featTop.appendChild(mk('div', 'wxs-feat-title', form.native.apiKeyConfigured ? '模型 Key 已配置' : '模型 Key 未配置'));
    featTop.appendChild(mk('div', 'wxs-feat-sub', form.native.apiKeyConfigured
      ? ('provider=' + form.native.provider + '；语音识别 / 日记 / 朋友圈文案可用。图片理解看下面的视觉 Key。')
      : '语音识别、日记、朋友圈、贴纸生成会失败或退回演示；DSH 文字回复不受影响。把聊天 Key 填到下面即可。'));
    featSec.appendChild(featTop);

    var voiceSw = switchRow('语音转文字', '收到语音后先转文字再进 DSH；语音识别复用聊天 Key（DeepSeek ASR），不需要另填 Key。', function () { return form.native.voice; }, function (v) { form.native.voice = !!v; });
    featSec.appendChild(voiceSw.row);
    var vr = switchRow('语音回复', '用户明确说“发语音/语音回我”时合成语音；打开不等于每条都发语音。', function () { return form.native.voiceReply; }, function (v) { form.native.voiceReply = !!v; }, updateVoiceReplyUi);
    featSec.appendChild(vr.row);
    var vrp = switchRow('私聊可发语音', '只影响私聊；关闭后私聊只回文字。', function () { return form.native.voiceReplyPrivate; }, function (v) { form.native.voiceReplyPrivate = !!v; }, updateVoiceReplyUi);
    featSec.appendChild(vrp.row);
    var vrg = switchRow('群聊可发语音', '群聊默认只回文字；打开后群里被明确要求语音才发，避免刷屏。', function () { return form.native.voiceReplyGroups; }, function (v) { form.native.voiceReplyGroups = !!v; }, updateVoiceReplyUi);
    featSec.appendChild(vrg.row);
    var vrc = numberRow('主动加语音概率', '0 = 只有明确要求才发语音；大于 0 时会随机把文字改成语音（会打扰，慎重）。', 'native.voiceReplyChance', 0, 100, '%', updateVoiceReplyUi);
    featSec.appendChild(vrc.row);
    var vpInfo = (data.nativeState && data.nativeState.voicePolicy) || {};
    featSec.appendChild(pathRow('语音回复策略', vpInfo.exists
      ? ('Enabled=' + (vpInfo.enabled ? 'true' : 'false') + ' · Private=' + (vpInfo.private ? 'true' : 'false') + ' · Groups=' + (vpInfo.groups ? 'true' : 'false') + ' · 概率=' + (Number(vpInfo.probability) || 0) + '%')
      : '尚未生成（保存一次或重启通道后生成 data\\voice-send.json）',
      '策略文件由桥接读取；这里改完保存即写，不必重启通道。'));
    function updateVoiceReplyUi() {
      var on = !!form.native.voiceReply;
      vrp.input.disabled = !on;
      vrg.input.disabled = !on;
      vrc.input.disabled = !on;
    }
    updateVoiceReplyUi();

    // 鲸鲸原生视觉没有总开关：配了 Key 就生效，没 Key 就跟随聊天服务商。
    // 这里不再给假开关，只显示「常开 + 当前可用状态」，避免用户以为关掉就不看图。
    featSec.appendChild(row('图片理解（原生视觉 · 常开）',
      '收到图片/贴纸会先调视觉接口；有专属视觉 Key 就用专属的，没有就跟随聊天服务商的视觉模型。鲸鲸没有关闭视觉的开关，所以这里不放假开关。',
      mk('span', 'wxs-pill ' + (form.native.visionKeyConfigured ? 'is-ok' : 'is-warn'),
        form.native.visionKeyConfigured ? '视觉可用 · 生效' : '聊天服务商没有视觉模型')));
    var visionKeyWrap = mk('div', 'wxs-key-wrap');
    var visionKey = mk('input', 'wxs-key');
    visionKey.type = 'password';
    visionKey.autocomplete = 'off';
    visionKey.placeholder = form.native.visionKeyConfigured ? '可留空；视觉已可用（专属或同源）' : '未配置（可填智谱/自定义视觉 Key）';
    visionKey.addEventListener('input', function () {
      form.native.visionApiKey = String(visionKey.value || '').trim();
      footError = '';
      refreshDirty();
    });
    visionKeyWrap.appendChild(visionKey);
    visionKeyWrap.appendChild(mk('span', 'wxs-key-state ' + (form.native.visionKeyConfigured ? 'is-ok' : 'is-warn'),
      form.native.visionKeyConfigured ? '可用' : '缺 Key'));
    featSec.appendChild(row('视觉 Key（专属，可留空）',
      '留空时鲸鲸会跟随聊天服务商（DeepSeek 会自动用 deepseek-flash 看图）；填了则走专属视觉接口。旧 Key 不回显。',
      visionKeyWrap));
    var visionTestBtn = mk('button', 'wxs-btn', '测试看图');
    visionTestBtn.type = 'button';
    visionTestBtn.title = '用内置 64x64 小图测试视觉接口，不会发微信消息';
    visionTestBtn.addEventListener('click', function () {
      if (!api || typeof api.visionTest !== 'function') { toast('视觉测试接口没接上：重启一次工作台', true); return; }
      visionTestBtn.disabled = true;
      visionTestBtn.textContent = '测试中…';
      Promise.resolve(api.visionTest()).then(function (r) {
        if (r && r.ok) toast('视觉可用：' + String(r.sample || '已识别').slice(0, 60), false, 8000);
        else toast('视觉不可用：' + String((r && r.error) || '未知错误'), true, 10000);
      }).catch(function (e) {
        toast('视觉测试失败：' + String((e && e.message) || e), true, 10000);
      }).then(function () {
        visionTestBtn.disabled = false;
        visionTestBtn.textContent = '测试看图';
      });
    });
    featSec.appendChild(row('测试图片理解', '只发内置测试图给视觉接口，不碰微信、不发消息；结果走顶栏通知。', visionTestBtn));
    var linksSw = switchRow('链接解析', '消息里有链接时抓标题/正文摘要，不打开浏览器。', function () { return form.native.links; }, function (v) { form.native.links = !!v; });
    featSec.appendChild(linksSw.row);
    var webSw = switchRow('第三方搜索 API（热榜 / 网页）', '本地搜索常开；这个开关只控制第三方搜索 API。关闭后仍会做本地搜索，只是没有热榜和外部网页结果。', function () { return form.native.websearch; }, function (v) { form.native.websearch = !!v; });
    featSec.appendChild(webSw.row);
    var stickerSw = switchRow('贴纸', '允许鲸鲸发送/收集贴纸；DSH 在回复末尾写 [[sticker:开心]] 等分类名时会真的补图。', function () { return form.native.stickers; }, function (v) { form.native.stickers = !!v; });
    featSec.appendChild(stickerSw.row);
    var stickerInfo = (data.nativeFiles && data.nativeFiles.stickers) || {};
    featSec.appendChild(pathRow('贴纸素材',
      (Number(stickerInfo.count) || 0) + ' 个（' + (stickerInfo.dir || 'data\\stickers') + '）',
      Number(stickerInfo.count) ? '素材已有；DSH 写标记后由鲸鲸剥标记并补图。' : '当前 0 个：把 PNG/JPG/GIF/WEBP 放进这个目录，缺口不静默。'));

    // ---- 千问表情包：生成和发送都走工作台通道 ----
    var sg = form.stickerGen;
    var sgBox = mk('div', 'wxs-subsec');
    sgBox.appendChild(mk('div', 'wxs-subsec-title', '表情包生成（已停用）'));
    sgBox.appendChild(mk('div', 'wxs-subsec-hint', '个性化形象（pet3d 概念图 / 表情包图库）已于 2026-11-23 移除，表情包生成不再可用。'));

    var sgKey = mk('input', 'wxs-in');
    sgKey.type = 'password';
    sgKey.autocomplete = 'off';
    sgKey.placeholder = sg.apiKeyConfigured ? '已配置；留空不改' : '未配置（千问 sk-ws Key）';
    var sgKeyWrap = mk('div', 'wxs-key-wrap');
    sgKeyWrap.appendChild(sgKey);
    sgKeyWrap.appendChild(mk('span', 'wxs-key-state ' + (sg.apiKeyConfigured ? 'is-ok' : 'is-warn'),
      sg.apiKeyConfigured ? '已配置' : '未配置'));
    sgKey.addEventListener('input', function () {
      form.stickerGen.apiKey = String(sgKey.value || '').trim();
      footError = '';
      refreshDirty();
    });
    sgBox.appendChild(row('千问 API Key', '只用于生成表情，和 DeepSeek 聊天 Key 分开；留空不改，旧 Key 不回显。', sgKeyWrap));

    var sgModel = mk('select', 'wxs-select');
    [['qwen-image-2.1-pro', 'qwen-image-2.1-pro（推荐，角色一致）'],
      ['qwen-image-3.0-pro', 'qwen-image-3.0-pro（更精细）'],
      ['qwen-image-3.0', 'qwen-image-3.0']].forEach(function (x) {
      var o = mk('option', '', x[1]); o.value = x[0]; sgModel.appendChild(o);
    });
    sgModel.value = sg.model || 'qwen-image-2.1-pro';
    sgModel.addEventListener('change', function () {
      form.stickerGen.model = String(sgModel.value || 'qwen-image-2.1-pro');
      footError = '';
      refreshDirty();
    });
    sgBox.appendChild(row('生成模型', '默认用 qwen-image-2.1-pro；换模型只影响生成质量，不影响已经入库的表情。', sgModel));

    var sgCat = mk('input', 'wxs-in');
    sgCat.type = 'text';
    sgCat.value = sg.category || '鲸鲸千问';
    sgCat.placeholder = '鲸鲸千问';
    sgCat.addEventListener('input', function () {
      form.stickerGen.category = String(sgCat.value || '').trim();
      footError = '';
      refreshDirty();
    });
    sgBox.appendChild(row('表情分类', '生成图会进这个分类；斜杠、冒号等非法字符会被去掉。', sgCat));

    var sgChat = mk('input', 'wxs-in');
    sgChat.type = 'text';
    sgChat.value = sg.chat || '静音胡闹';
    sgChat.placeholder = '私聊昵称（例：静音胡闹）';
    sgChat.addEventListener('input', function () {
      form.stickerGen.chat = String(sgChat.value || '').trim();
      footError = '';
      refreshDirty();
    });
    sgBox.appendChild(row('发送目标', '私聊显示名；发送前会再确认一次，不会发到群聊。', sgChat));

    var sgAutoSw = switchRow('按需生成新表情',
      '模型想用图库没有的情绪时，按当前对话生成一张并入库；本条先按已有图回复，生成完成后下一轮起可用。关闭后只使用固定分类。',
      function () { return form.stickerGen.auto; },
      function (v) { form.stickerGen.auto = !!v; });
    sgBox.appendChild(sgAutoSw.row);
    var sgAutoMax = numberRow('每日按需生成上限',
      '防止意外消耗；达到上限后只发已有表情。固定四张套装不计入这个上限。',
      'stickerGen.autoMax', 1, 30, '张');
    sgBox.appendChild(sgAutoMax.row);
    var sgAutoInfo = (data.config && data.config.stickerGen) || {};
    sgBox.appendChild(mk('div', 'wxs-note',
      '今日已按需生成 ' + Number(sgAutoInfo.autoDoneToday || 0) + ' / ' + Number(form.stickerGen.autoMax || 8) + ' 张' +
      (Number(sgAutoInfo.autoPending || 0) ? '；进行中 ' + Number(sgAutoInfo.autoPending) + ' 张' : '') +
      (sgAutoInfo.lastAuto && sgAutoInfo.lastAuto.ok === false ? '；上次失败：' + String(sgAutoInfo.lastAuto.error || '').slice(0, 60) : '') +
      '。固定四张套装不占这个额度。'));

    var sgEmotion = mk('input', 'wxs-key');
    sgEmotion.type = 'text';
    sgEmotion.placeholder = '例：惊讶 / 无语 / 得意';
    var sgEmotionWrap = mk('div', 'wxs-key-wrap');
    sgEmotionWrap.appendChild(sgEmotion);
    var sgMake = mk('button', 'wxs-btn', '补一张');
    sgMake.type = 'button';
    sgMake.title = '按这个情绪生成一张，加入同名分类，之后模型可以继续用；不发微信消息';
    sgEmotionWrap.appendChild(sgMake);
    var sgEmotionRow = row('按情绪补一张', '手动补图库缺口；生成后自动入同名分类，不发送到微信。', sgEmotionWrap);
    sgBox.appendChild(sgEmotionRow);
    sgMake.addEventListener('click', function () {
      var emo = String(sgEmotion.value || '').trim();
      if (!emo) { toast('先填一个情绪名，例：惊讶', true); return; }
      if (!api || typeof api.stickerGenerate !== 'function') {
        toast('表情包接口没接上：重启一次工作台', true);
        return;
      }
      if (!form.stickerGen.apiKey && !form.stickerGen.apiKeyConfigured) {
        toast('先填千问 API Key 并保存', true);
        return;
      }
      sgMake.disabled = true;
      sgMake.textContent = '生成中…';
      sgState.className = 'wxs-note';
      sgState.textContent = '正在按「' + emo + '」生成一张…';
      Promise.resolve(api.stickerGenerate({
        emotion: emo,
        category: emo,
        model: form.stickerGen.model,
        apiKey: form.stickerGen.apiKey || ''
      })).then(function (r) {
        if (!r || r.ok === false) throw new Error((r && r.error) || '未知原因');
        sgState.className = 'wxs-note is-ok';
        sgState.textContent = '已生成并入库：分类「' + (r.category || emo) + '」· 之后可直接用';
        toast('已补一张：' + (r.category || emo));
      }).catch(function (e) {
        sgState.className = 'wxs-note is-bad';
        sgState.textContent = '生成失败：' + String((e && e.message) || e);
        toast(sgState.textContent, true, 10000);
      }).then(function () {
        sgMake.disabled = false;
        sgMake.textContent = '补一张';
      });
    });

    var sgState = mk('div', 'wxs-note', '');
    var sgBar = mk('div', 'wxs-action-bar');
    function sgBtn(label, fn) {
      var b = mk('button', 'wxs-btn', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      sgBar.appendChild(b);
      return b;
    }
    function sgReady() {
      if (!api || typeof api.stickerGenerate !== 'function' || typeof api.stickerSend !== 'function') {
        toast('表情包接口没接上：重启一次工作台', true);
        return false;
      }
      if (!form.stickerGen.apiKey && !form.stickerGen.apiKeyConfigured) {
        toast('先填千问 API Key；也可以先点下面的「保存」', true);
        return false;
      }
      if (!String(form.stickerGen.chat || '').trim()) {
        toast('先填目标私聊昵称', true);
        return false;
      }
      return true;
    }
    function sgRun(sendAfter) {
      if (!sgReady()) return;
      if (sendAfter && !window.confirm('生成一套表情，并挑一张发到私聊「' + form.stickerGen.chat + '」？\n这会真的产生微信消息。')) return;
      sgState.className = 'wxs-note';
      sgState.textContent = '正在生成四张表情…（千问图像接口，通常几十秒）';
      Promise.resolve(api.stickerGenerate({
        model: form.stickerGen.model,
        apiKey: form.stickerGen.apiKey || '',
        category: form.stickerGen.category
      })).then(function (r) {
        if (!r || r.ok === false) {
          sgState.className = 'wxs-note is-bad';
          sgState.textContent = '生成失败：' + ((r && r.error) || '未知原因');
          toast(sgState.textContent, true);
          return null;
        }
        sgState.className = 'wxs-note is-ok';
        sgState.textContent = '已生成并入库：' + (r.files || []).length + ' 张 → 分类「' + (r.category || form.stickerGen.category) + '」';
        if (!sendAfter) return null;
        sgState.textContent += '；正在排队发送…';
        return api.stickerSend({
          category: r.category || form.stickerGen.category,
          chat: form.stickerGen.chat
        });
      }).then(function (s) {
        if (!s) return;
        if (s.ok === true) {
          sgState.className = 'wxs-note is-ok';
          sgState.textContent = '已发送到「' + s.chat + '」：' + (s.status || '已确认') + (s.job && s.job.path ? (' · ' + String(s.job.path).split(/[\\/]/).pop()) : '');
          toast('表情已发送到「' + s.chat + '」');
        } else {
          sgState.className = 'wxs-note is-bad';
          sgState.textContent = '发送未确认：' + ((s && (s.status || s.error)) || '未知原因');
          toast(sgState.textContent, true, 10000);
        }
      }).catch(function (e) {
        sgState.className = 'wxs-note is-bad';
        sgState.textContent = '表情操作失败：' + String((e && e.message) || e);
        toast(sgState.textContent, true);
      });
    }
    sgBtn('生成一套（4 张）', function () { sgRun(false); });
    sgBtn('生成并发送一张', function () { sgRun(true); });
    sgBox.appendChild(sgBar);
    sgBox.appendChild(sgState);
    sgBox.appendChild(mk('div', 'wxs-note', '个性化形象已移除，生成接口已停用。'));
    featSec.appendChild(sgBox);

    var diarySw = switchRow('日记生成', '每天按鲸鲸原生时间生成一篇；生成不等于会发到微信。', function () { return form.native.diary; }, function (v) { form.native.diary = !!v; });
    featSec.appendChild(diarySw.row);
    var diarySendSw = switchRow('日记发到主人', '每天把日记主动发到「文件传输助手/主人」；这会真的产生微信消息。', function () { return form.native.diarySend; }, function (v) { form.native.diarySend = !!v; });
    featSec.appendChild(diarySendSw.row);
    var autoRead = selectRow('朋友圈自动读取', '每隔几小时读一次朋友圈；0 = 不自动读。读取本身不发消息。', 'native.momentsAutoRead', [
      [0, '不自动读'], [4, '每 4 小时'], [6, '每 6 小时'], [8, '每 8 小时'], [12, '每 12 小时']
    ]);
    featSec.appendChild(autoRead.row);
    var likeSw = switchRow('朋友圈自动点赞', '读取朋友圈时按鲸鲸原生规则自动点赞，每天最多 3 次；会真的对好友动态操作。', function () { return form.native.momentsAutoLike; }, function (v) { form.native.momentsAutoLike = !!v; });
    featSec.appendChild(likeSw.row);

    // ---- 朋友圈手动互动：读取 / 点赞 / 评论 / 回复 / 复制草稿 ----
    var momentBox = mk('div', 'wxs-subsec');
    momentBox.appendChild(mk('div', 'wxs-subsec-title', '朋友圈手动互动'));
    momentBox.appendChild(mk('div', 'wxs-subsec-hint', '目标先填发布者昵称 + 动态正文关键词；评论/回复会真的操作微信，点之前再确认一次。'));
    var mPub = mk('input', 'wxs-in');
    mPub.placeholder = '发布者昵称（例：张三）';
    var mKey = mk('input', 'wxs-in');
    mKey.placeholder = '动态正文关键词（例：今天天气）';
    var mContent = mk('input', 'wxs-in');
    mContent.placeholder = '评论内容 / 回复内容（复制草稿也用它）';
    var mReply = mk('input', 'wxs-in');
    mReply.placeholder = '被回复者昵称（仅“回复”需要）';
    [mPub, mKey, mContent, mReply].forEach(function (x) { x.type = 'text'; momentBox.appendChild(x); });
    var mBar = mk('div', 'wxs-action-bar');
    function mBtn(label, fn) {
      var b = mk('button', 'wxs-btn', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      mBar.appendChild(b);
      return b;
    }
    var mState = mk('div', 'wxs-note', '');
    momentBox.appendChild(mBar);
    momentBox.appendChild(mState);

    function mPayload(extra) {
      return Object.assign({
        publisher: String(mPub.value || '').trim(),
        keyword: String(mKey.value || '').trim(),
        content: String(mContent.value || '').trim(),
        replyTo: String(mReply.value || '').trim()
      }, extra || {});
    }
    function showMoment(r, label) {
      if (!r || r.ok === false) {
        mState.className = 'wxs-note is-bad';
        mState.textContent = label + '失败：' + ((r && r.error) || '未知原因');
        toast(mState.textContent, true);
        return;
      }
      var job = r.job || r;
      var id = job && job.id;
      mState.className = 'wxs-note is-ok';
      mState.textContent = label + '已提交' + (id ? '（任务 ' + String(id).slice(0, 12) + '）' : '') + '，等微信完成…';
      if (!id || !api || typeof api.momentsResult !== 'function') return;
      var tries = 0;
      function poll() {
        tries++;
        api.momentsResult(id).then(function (x) {
          if (!x || x.ok === false) { mState.className = 'wxs-note is-bad'; mState.textContent = label + '查询失败：' + ((x && x.error) || '未知'); return; }
          var st = String((x.job && x.job.status) || x.status || '');
          if (st === 'done' || st === 'failed' || st === 'expired') {
            mState.className = 'wxs-note ' + (st === 'done' ? 'is-ok' : 'is-bad');
            mState.textContent = label + '：' + st + ((x.job && x.job.error) ? (' · ' + x.job.error) : '');
            return;
          }
          if (tries < 25) setTimeout(poll, 900);
          else { mState.className = 'wxs-note is-warn'; mState.textContent = label + '仍在执行；稍后点「读取」查看快照。'; }
        }).catch(function (e) {
          mState.className = 'wxs-note is-bad'; mState.textContent = label + '查询失败：' + String((e && e.message) || e);
        });
      }
      setTimeout(poll, 700);
    }
    function mConfirm(text) { return !window.confirm || window.confirm(text); }

    mBtn('读取朋友圈', function () {
      if (!api || typeof api.momentsRead !== 'function') { toast('朋友圈接口没接上：重启一次工作台', true); return; }
      mState.className = 'wxs-note'; mState.textContent = '正在读取（会切到微信朋友圈，可能需要几秒）…';
      Promise.resolve(api.momentsRead({ limit: 20 })).then(function (r) { showMoment(r, '读取'); })
        .catch(function (e) { showMoment({ ok: false, error: String((e && e.message) || e) }, '读取'); });
    });
    mBtn('点赞', function () {
      if (!mConfirm('对这条朋友圈点赞？\n发布者：' + (mPub.value || '未填') + '\n关键词：' + (mKey.value || '未填'))) return;
      Promise.resolve(api.momentsAction(mPayload({ action: 'like' }))).then(function (r) { showMoment(r, '点赞'); })
        .catch(function (e) { showMoment({ ok: false, error: String((e && e.message) || e) }, '点赞'); });
    });
    mBtn('取消赞', function () {
      Promise.resolve(api.momentsAction(mPayload({ action: 'unlike' }))).then(function (r) { showMoment(r, '取消赞'); })
        .catch(function (e) { showMoment({ ok: false, error: String((e && e.message) || e) }, '取消赞'); });
    });
    mBtn('评论', function () {
      if (!String(mContent.value || '').trim()) { toast('先填评论内容；它也会作为「复制草稿」的内容', true); return; }
      if (!mConfirm('把这条评论真的发到朋友圈？\n内容：' + String(mContent.value || '').slice(0, 80))) return;
      Promise.resolve(api.momentsAction(mPayload({ action: 'comment' }))).then(function (r) { showMoment(r, '评论'); })
        .catch(function (e) { showMoment({ ok: false, error: String((e && e.message) || e) }, '评论'); });
    });
    mBtn('回复', function () {
      if (!String(mReply.value || '').trim()) { toast('回复需要填被回复者昵称', true); return; }
      if (!String(mContent.value || '').trim()) { toast('先填回复内容', true); return; }
      if (!mConfirm('把这条回复真的发到朋友圈？\n回复给：' + mReply.value)) return;
      Promise.resolve(api.momentsAction(mPayload({ action: 'reply' }))).then(function (r) { showMoment(r, '回复'); })
        .catch(function (e) { showMoment({ ok: false, error: String((e && e.message) || e) }, '回复'); });
    });
    mBtn('复制评论草稿', function () {
      var text = String(mContent.value || '').trim();
      if (!text) { toast('评论内容为空：先写一条，再复制', true); return; }
      if (!api || typeof api.copyText !== 'function') { toast('剪贴板接口没接上：重启一次工作台', true); return; }
      Promise.resolve(api.copyText(text)).then(function () { toast('评论草稿已复制到剪贴板'); })
        .catch(function (e) { toast('复制失败：' + String((e && e.message) || e), true); });
    });
    var snap = (data.nativeState && data.nativeState.moments) || null;
    momentBox.appendChild(mk('div', 'wxs-note', snap
      ? ('最近一次读取快照：' + (snap.status || '已读取') + ' · ' + (Array.isArray(snap.items) ? snap.items.length : 0) + ' 条')
      : '还没有朋友圈读取快照；点「读取朋友圈」会把结果写进这里。'));
    var pubDraft = (data.nativeState && data.nativeState.publish) || null;
    if (pubDraft && String(pubDraft.preview || '').trim()) {
      var pubWrap = mk('div', 'wxs-subsec');
      pubWrap.appendChild(mk('div', 'wxs-subsec-title', '朋友圈发布草稿（只读）'));
      pubWrap.appendChild(mk('div', 'wxs-pre', String(pubDraft.preview)));
      var copyPub = mk('button', 'wxs-btn', '复制朋友圈草稿');
      copyPub.type = 'button';
      copyPub.addEventListener('click', function () {
        if (!api || typeof api.copyText !== 'function') { toast('剪贴板接口没接上：重启一次工作台', true); return; }
        Promise.resolve(api.copyText(String(pubDraft.preview))).then(function () { toast('朋友圈草稿已复制'); })
          .catch(function (e) { toast('复制失败：' + String((e && e.message) || e), true); });
      });
      pubWrap.appendChild(copyPub);
      momentBox.appendChild(pubWrap);
    }
    featSec.appendChild(momentBox);

    var isoMem = status && status.sessionIsolation;
    featSec.appendChild(pathRow('记忆归属（唯一）',
      isoMem ? ('DSH 每聊天独立会话 · 共 ' + (Number(isoMem.count) || 0) + ' 条（群 ' + (Number(isoMem.groups) || 0) + ' / 私聊 ' + (Number(isoMem.privates) || 0) + '）；鲸鲸原生记忆快照已关闭') : '会话隔离状态未上报；鲸鲸原生记忆快照已关闭',
      '避免两套记忆：私聊和群聊都由各自的 DSH 会话记住；群聊旁听只作为本轮原始上下文补进提示词，不再另存一份鲸鲸记忆。'));

    // ---- 日记 / 提醒：状态可见 + 手动动作，避免“开关开了但不知道有没有产出” ----
    var diaryBox = mk('div', 'wxs-subsec');
    diaryBox.appendChild(mk('div', 'wxs-subsec-title', '日记与提醒'));
    var diaryState = (data.nativeState && data.nativeState.diary) || {};
    var latestDiary = diaryState.latest || null;
    diaryBox.appendChild(mk('div', 'wxs-note',
      latestDiary ? ('最近日记：' + latestDiary.name + ' · ' + fmtWhen(latestDiary.mtime)) : '还没有日记文件；到点会自动生成，或点下面「现在生成」。'));
    var dBar = mk('div', 'wxs-action-bar');
    var genBtn = mk('button', 'wxs-btn', '现在生成一篇');
    genBtn.type = 'button';
    genBtn.title = '会调用鲸鲸原生日记生成；可能耗时，生成后又按“日记发到主人”设置决定是否发微信';
    genBtn.addEventListener('click', function () {
      if (!window.confirm('现在生成一篇日记？\n如果「日记发到主人」开着，生成后可能真的发微信。')) return;
      if (!api || typeof api.diaryGenerate !== 'function') { toast('日记接口没接上：重启一次工作台', true); return; }
      genBtn.disabled = true;
      Promise.resolve(api.diaryGenerate()).then(function (r) {
        genBtn.disabled = false;
        toast(r && r.ok === false ? ('生成失败：' + (r.error || '未知')) : '已提交日记生成；稍后刷新状态', !!(r && r.ok === false));
      }).catch(function (e) { genBtn.disabled = false; toast('生成失败：' + String((e && e.message) || e), true); });
    });
    var readDiaryBtn = mk('button', 'wxs-btn', '查看最近一篇');
    readDiaryBtn.type = 'button';
    readDiaryBtn.addEventListener('click', function () {
      if (!api || typeof api.diaryRead !== 'function') { toast('日记接口没接上：重启一次工作台', true); return; }
      Promise.resolve(api.diaryRead()).then(function (r) {
        if (!r || r.ok === false) { toast('读取日记失败：' + ((r && r.error) || '未知'), true); return; }
        if (!r.text) { toast('还没有日记文件', true); return; }
        var d = mk('div', 'wxs-pre');
        d.textContent = r.text;
        var old = diaryBox.querySelector('.wxs-pre');
        if (old) old.remove();
        diaryBox.appendChild(d);
      }).catch(function (e) { toast('读取日记失败：' + String((e && e.message) || e), true); });
    });
    var openDiaryBtn = mk('button', 'wxs-btn', '打开日记目录');
    openDiaryBtn.type = 'button';
    openDiaryBtn.addEventListener('click', function () {
      if (!api || typeof api.openPath !== 'function') { toast('打开目录没接上：重启一次工作台', true); return; }
      Promise.resolve(api.openPath(paths.diaryDir || '')).then(function (r) {
        if (r && r.ok === false) toast('打开目录失败：' + (r.error || ''), true);
      }).catch(function (e) { toast('打开目录失败：' + String((e && e.message) || e), true); });
    });
    dBar.appendChild(genBtn); dBar.appendChild(readDiaryBtn); dBar.appendChild(openDiaryBtn);
    diaryBox.appendChild(dBar);

    var remState = (data.nativeState && data.nativeState.reminders) || {};
    diaryBox.appendChild(mk('div', 'wxs-subsec-title', '待发提醒'));
    var remList = Array.isArray(remState.items) ? remState.items : [];
    if (!remList.length) {
      diaryBox.appendChild(mk('div', 'wxs-note', '没有待发提醒。新建提醒直接在微信里对饭团说“10 分钟后提醒我…”；这里只列出并允许取消。'));
    } else {
      var remTable = mk('div', 'wxs-map');
      remList.forEach(function (it) {
        var r = mk('div', 'wxs-map-row');
        var name = mk('div', 'wxs-map-name');
        name.appendChild(mk('div', 'wxs-map-title', String(it.text || '（无正文）').slice(0, 60)));
        name.appendChild(mk('div', 'wxs-map-sub', fmtWhen(it.dueAt) || '无时间'));
        r.appendChild(name);
        var cancel = mk('button', 'wxs-btn wxs-mini', '取消');
        cancel.type = 'button';
        cancel.title = '只取消这条提醒，不发消息';
        cancel.addEventListener('click', function () {
          if (!window.confirm('取消这条提醒？\n' + String(it.text || '').slice(0, 60))) return;
          if (!api || typeof api.reminderCancel !== 'function') { toast('提醒接口没接上：重启一次工作台', true); return; }
          Promise.resolve(api.reminderCancel(it.id)).then(function (x) {
            if (!x || x.ok === false) { toast('取消失败：' + ((x && x.error) || '未知'), true); return; }
            r.remove(); toast('提醒已取消');
          }).catch(function (e) { toast('取消失败：' + String((e && e.message) || e), true); });
        });
        r.appendChild(cancel);
        remTable.appendChild(r);
      });
      diaryBox.appendChild(remTable);
    }
    featSec.appendChild(diaryBox);


    var keyWrap = mk('div', 'wxs-key-wrap');
    var keyInput = mk('input', 'wxs-key');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.placeholder = form.native.apiKeyConfigured ? '已配置；留空不改' : '未配置（DeepSeek Key）';
    keyInput.addEventListener('input', function () {
      form.native.apiKey = String(keyInput.value || '').trim();
      footError = '';
      refreshDirty();
    });
    keyWrap.appendChild(keyInput);
    keyWrap.appendChild(mk('span', 'wxs-key-state ' + (form.native.apiKeyConfigured ? 'is-ok' : 'is-warn'),
      form.native.apiKeyConfigured ? '已配置' : '未配置'));
    featSec.appendChild(row('模型 Key（' + form.native.provider + '）',
      '原生语音识别、日记、朋友圈文案和贴纸生成需要它；留空不改，旧 Key 不回显。DSH 文字回复不需要这个 Key。',
      keyWrap));
    featSec.appendChild(mk('div', 'wxs-note',
      '文字回复、语音识别、日记、朋友圈优先用聊天 Key；图片理解另需视觉 Key；贴纸素材必须非空。'));

    function renderFeatureState() {
      featTop.textContent = '';
      featTop.className = 'wxs-feat-state ' + (form.native.apiKeyConfigured ? 'is-ok' : 'is-warn');
      featTop.appendChild(mk('div', 'wxs-feat-title', form.native.apiKeyConfigured ? '模型 Key 已配置' : '模型 Key 未配置'));
      featTop.appendChild(mk('div', 'wxs-feat-sub', form.native.apiKeyConfigured
        ? ('provider=' + form.native.provider + '；语音识别 / 日记 / 朋友圈文案可用。图片理解看下面的视觉 Key。')
        : '语音识别、日记、朋友圈、贴纸生成会失败或退回演示；DSH 文字回复不受影响。把聊天 Key 填到下面即可。'));
    }
    renderFeatureState();

    // ---------- 回复 ----------
    var replySec = addSec('reply', '回复', '回复形态固定在通道层，避免鲸鲸自己的 140 字/多气泡先把内容切碎。');
    var max = numberRow('每条最多字数', 'DSH 提示词和鲸鲸发送都按它截；改大要确认群里能接受长消息。', 'maxChars', 60, 2000, '字');
    replySec.appendChild(max.row);
    var bg = switchRow('后台发送（不抢前台）', '关闭后每次发消息都会把微信拉到前台，可能打断你正在做的事；默认开。', function () { return form.wechat.backgroundSend; }, function (v) {
      form.wechat.backgroundSend = !!v;
    });
    replySec.appendChild(bg.row);
    replySec.appendChild(pathRow('消息形态', '单气泡 · 不引用原消息', '引用会抢前台，当前通道固定关闭；需要多条会由鲸鲸侧限制。'));

    // ---------- 高级 ----------
    var adv = addSec('advanced', '高级', '这里只读；改端口/插件/账号保护不是普通配置，避免把整条通道弄断。');
    adv.appendChild(pathRow('鲸鲸目录', paths.whaleHome, '官方安装目录，工作台不往里写业务代码。'));
    adv.appendChild(pathRow('鲸鲸配置', paths.configFile, '设置面板只写白名单字段；模型/人设等仍留在原生配置。'));
    adv.appendChild(pathRow('工作台通道配置', paths.shellConfig, '账号、端口、token 等运行参数在壳这边。'));
    var pluginOn = !!(cfg.features && cfg.features.javascriptPlugins);
    adv.appendChild(pathRow('换脑插件', pluginOn ? '已启用（chat.generate / chat.reply）' : '未启用（启动通道时会自动补上）', '关掉它微信会回到鲸鲸自己的模型，等于第二人格；面板不提供关闭。'));
    adv.appendChild(pathRow('账号保护', (cfg.wechat && cfg.wechat.accountGuard) ? '已开启（认不出账号宁可不发）' : '未开启', '不建议关闭；双开时这是防发错号的最后一道闸。'));
    adv.appendChild(pathRow('并发会话', String((cfg.wechat && cfg.wechat.pipelineWorkers) || 4) + ' 个（同会话串行）', '多人同时发消息时才会用到；改它需要重启通道。'));
    var restartBtn = mk('button', 'wxs-btn', '只重启通道');
    restartBtn.type = 'button';
    restartBtn.title = '不保存任何设置，只让当前配置重新加载';
    restartBtn.addEventListener('click', restartChannel);
    adv.appendChild(row('重启通道', '不保存设置，只让鲸鲸内核/桥接/适配器重新加载；会短暂中断收发。', restartBtn));
    if (paths.logDir) {
      var logBtn = mk('button', 'wxs-btn', '打开日志目录');
      logBtn.type = 'button';
      logBtn.addEventListener('click', function () {
        try {
          var a = window.app && window.app.app;
          if (!a || typeof a.revealPath !== 'function') { toast('打开目录没接上：重启一次工作台', true); return; }
          Promise.resolve(a.revealPath(paths.logDir)).catch(function (e) { toast('打开日志目录失败：' + String((e && e.message) || e), true); });
        } catch (e) { toast('打开日志目录失败：' + String((e && e.message) || e), true); }
      });
      adv.appendChild(row('日志目录', 'whale-kernel.log / whale-bridge.log / 通道.log 都在这里。', logBtn));
    }
    var diagBtn = mk('button', 'wxs-btn', '跑一次能力诊断');
    diagBtn.type = 'button';
    diagBtn.title = '复用微信卡的自检：通道、UIA、插件、适配器、会话隔离一次核对';
    diagBtn.addEventListener('click', function () {
      if (!api || typeof api.selfCheck !== 'function') { toast('自检接口没接上：重启一次工作台', true); return; }
      diagBtn.disabled = true;
      Promise.resolve(api.selfCheck()).then(function (r) {
        diagBtn.disabled = false;
        var s = (r && (r.summary || r.state)) || '无结果';
        toast('诊断：' + s, !(r && r.ok !== false && !/不通|失败/.test(s)), 9000);
      }).catch(function (e) { diagBtn.disabled = false; toast('诊断失败：' + String((e && e.message) || e), true); });
    });
    adv.appendChild(row('诊断', '只读核对，不向微信发消息；真实发送测试在微信卡单独点。', diagBtn));

    var updateBtn = mk('button', 'wxs-btn', '打开鲸鲸启动器（更新 / 原生设置）');
    updateBtn.type = 'button';
    updateBtn.title = '会打开 WhaleLauncher.exe；它可能再拉内核，必须先停通道';
    updateBtn.addEventListener('click', function () {
      if (!window.confirm('打开鲸鲸启动器？\n它会启动自己的内核/桥接；如果当前通道还在运行，会和 8787 端口冲突。\n建议先去微信卡点「停止」，再打开启动器。')) return;
      if (!api || typeof api.openPath !== 'function') { toast('打开启动器没接上：重启一次工作台', true); return; }
      Promise.resolve(api.openPath(paths.launcher || '')).then(function (r) {
        if (r && r.ok === false) toast('打开鲸鲸启动器失败：' + (r.error || ''), true);
        else toast('已打开鲸鲸启动器；更新/原生设置请在那里完成');
      }).catch(function (e) { toast('打开鲸鲸启动器失败：' + String((e && e.message) || e), true); });
    });
    adv.appendChild(row('鲸鲸更新入口', '工作台不伪造更新；更新走鲸鲸官方启动器。运行通道时会抢端口，先停通道。', updateBtn));
    adv.appendChild(pathRow('鲸鲸版本', ((data.nativeState && data.nativeState.version && data.nativeState.version.version) || '未读到') + ' · ' + ((data.nativeState && data.nativeState.version && data.nativeState.version.name) || 'whale-girl'), '版本来自鲸鲸 package.json；更新后重新跑一次能力诊断。'));

    adv.appendChild(mk('div', 'wxs-note', '不要同时在通道运行时打开 WhaleLauncher.exe：它会再拉一套内核/桥接，和壳抢 8787。要用原生设置，先停通道再开。'));

    // ---------- 页签 ----------
    function setTab(key) {
      Object.keys(secs).forEach(function (k) { secs[k].classList.toggle('is-on', k === key); });
      Object.keys(tabBtns).forEach(function (k) {
        var on = k === key;
        tabBtns[k].classList.toggle('is-on', on);
        tabBtns[k].setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    setTab('conn');

    // ---------- 校验 / 未保存 ----------
    function validate() {
      var m = num(form.maxChars, 300, 60, 2000);
      if (form.maxChars < 60 || form.maxChars > 2000) return '每条最多字数需在 60–2000 之间';
      if (form.group.freeChatChance < 0 || form.group.freeChatChance > 100) return '主动接话概率需在 0–100% 之间';
      if (form.group.engagedMinutes < 1 || form.group.engagedMinutes > 120) return '接话窗口需在 1–120 分钟之间';
      if (form.group.silentMinutes < 1 || form.group.silentMinutes > 240) return '静默重置需在 1–240 分钟之间';
      if (form.group.cooldownSec < 0 || form.group.cooldownSec > 3600) return '最短冷却需在 0–3600 秒之间';
      if (form.group.maxRepliesPerMinute < 1 || form.group.maxRepliesPerMinute > 30) return '每分钟上限需在 1–30 条之间';
      if (form.native.momentsAutoRead < 0 || form.native.momentsAutoRead > 24) return '朋友圈自动读取需在 0–24 小时之间';
      if (form.native.voiceReplyChance < 0 || form.native.voiceReplyChance > 100) return '主动加语音概率需在 0–100% 之间';
      if (m !== form.maxChars) return '每条最多字数需是整数';
      return '';
    }
    function needsRestart() {
      var keys = diffKeys(form, baseForm);
      return keys.some(function (k) {
        return k === 'maxChars' || k === 'wechat.backgroundSend' || k.indexOf('group.') === 0 || k.indexOf('native.') === 0;
      });
    }
    function riskMessages() {
      var out = [];
      if (baseForm.group.requireAt && !form.group.requireAt) {
        out.push('群聊将不再要求 @ / 叫名字，会按概率主动接话，可能误接或刷屏。');
      }
      if (!baseForm.group.freeChat && form.group.freeChat) {
        out.push('允许主动接话后，群里可能出现没人叫它也插话的情况。');
      }
      if (baseForm.wechat.backgroundSend && !form.wechat.backgroundSend) {
        out.push('关闭后台发送后，每次发消息都会把微信拉到前台，可能打断你正在做的事。');
      }
      if (!baseForm.native.diarySend && form.native.diarySend) {
        out.push('打开「日记发到主人」后，鲸鲸会每天主动发一条微信消息；确认这是你要的。');
      }
      if (!baseForm.native.momentsAutoLike && form.native.momentsAutoLike) {
        out.push('打开朋友圈自动点赞后，鲸鲸会真的对好友动态点赞（每天最多 3 次）。');
      }
      if (Number(baseForm.native.momentsAutoRead) === 0 && Number(form.native.momentsAutoRead) > 0) {
        out.push('开启朋友圈自动读取后，鲸鲸会定时读取好友动态；夜间频率由原生配置控制。');
      }
      return out;
    }
    function refreshDirty() {
      var n = diffKeys(form, baseForm).length;
      if (!footError) {
        footHint.textContent = n ? ('有 ' + n + ' 项未保存修改') : '没有未保存修改';
        footHint.classList.toggle('is-dirty', !!n);
        footHint.classList.toggle('is-err', false);
      } else {
        footHint.textContent = footError;
        footHint.classList.add('is-err');
      }
      var restart = needsRestart();
      discard.disabled = saving || n === 0;
      saveOnly.disabled = saving || n === 0 || !restart;
      saveOnly.style.display = restart ? '' : 'none';
      apply.disabled = saving || n === 0;
      apply.textContent = saving ? '处理中…' : (restart ? (status && status.running ? '保存并重启' : '保存并启动') : '保存');
    }
    function setError(msg) {
      footError = String(msg || '');
      refreshDirty();
    }
    function close() {
      if (saving || closed) return;
      if (diffKeys(form, baseForm).length && !window.confirm('有未保存的修改，确定放弃并关闭？')) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      try { mask.remove(); } catch (e) { console.warn('[wechat-settings] 弹窗移除失败', e); }
      try { if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus(); } catch (e2) { console.warn('[wechat-settings] 焦点恢复失败', e2); }
    }
    function onKey(e) {
      if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); e.stopPropagation(); close(); }
    }

    // ---------- 保存 ----------
    function save(doRestart) {
      if (saving) return;
      var err = validate();
      if (err) { setError(err); toast(err, true); return; }
      var n = diffKeys(form, baseForm).length;
      if (!n) return;
      var restart = needsRestart();
      var msgs = riskMessages();
      if (doRestart && restart) msgs.push(status && status.running
        ? '保存后会重启微信通道，期间收发会短暂中断，正在发送的消息可能失败。'
        : '微信通道当前未运行，保存后会启动它。');
      if (msgs.length && !window.confirm(msgs.join('\n\n'))) return;

      saving = true; setError('');
      var payload = formToPayload(form);
      payload.restart = !!(doRestart && restart);
      Promise.resolve(api.settingsSave(payload)).then(function (r) {
        saving = false;
        if (!r || (r.ok === false && r.saved !== true)) {
          setError('保存失败：' + ((r && r.error) || '主进程没有返回结果'));
          toast('保存失败：' + ((r && r.error) || '主进程没有返回结果'), true);
          return;
        }
        if (r.status) status = r.status;
        if (payload.native && payload.native.apiKey) {
          form.native.apiKeyConfigured = true;
          form.native.apiKey = '';
          keyInput.value = '';
          keyInput.placeholder = '已配置；留空不改';
          try { keyWrap.lastChild.textContent = '已配置'; keyWrap.lastChild.className = 'wxs-key-state is-ok'; } catch (e) { console.warn('[wechat-settings] 更新 Key 状态失败', e); }
          renderFeatureState();
        }
        if (payload.stickerGen && payload.stickerGen.apiKey) {
          form.stickerGen.apiKeyConfigured = true;
          form.stickerGen.apiKey = '';
          sgKey.value = '';
          sgKey.placeholder = '已配置；留空不改';
          try { sgKeyWrap.lastChild.textContent = '已配置'; sgKeyWrap.lastChild.className = 'wxs-key-state is-ok'; } catch (e) { console.warn('[wechat-settings] 更新千问 Key 状态失败', e); }
        }
        baseForm = clone(form);
        renderIsolation();
        if (r.ok === false) {
          setError(r.error || '已保存，但重启失败');
          toast(r.error || '已保存，但重启失败', true, 10000);
        } else if (r.restarted) {
          toast('设置已保存，通道已重启');
        } else if (r.restartRequired) {
          toast('设置已保存；重启通道后生效（可点“保存并重启”或高级页的“只重启通道”）');
        } else {
          toast('设置已保存');
        }
        renderSummary();
        refreshDirty();
      }).catch(function (e) {
        saving = false;
        setError('保存失败：' + String((e && e.message) || e));
        toast('保存失败：' + String((e && e.message) || e), true);
      });
    }

    function restartChannel() {
      if (!api || typeof api.start !== 'function' || typeof api.stop !== 'function') {
        toast('重启接口没接上：重启一次工作台', true);
        return;
      }
      var running = !!(status && status.running);
      if (!window.confirm(running
        ? '只重启微信通道？不保存任何设置；收发会短暂中断。'
        : '微信通道当前未运行，现在启动它？')) return;
      restartBtn.disabled = true;
      var p = running
        ? Promise.resolve(api.stop()).then(function () { return new Promise(function (res) { setTimeout(res, 500); }); }).then(function () { return api.start(); })
        : Promise.resolve(api.start());
      Promise.resolve(p).then(function (r) {
        restartBtn.disabled = false;
        if (!r || r.ok === false) { toast('重启失败：' + ((r && r.error) || '未知原因'), true); return; }
        if (r.status) status = r.status;
        toast(running ? '微信通道已重启' : '微信通道已启动');
        renderSummary();
        refreshDirty();
      }).catch(function (e) {
        restartBtn.disabled = false;
        toast('重启失败：' + String((e && e.message) || e), true);
      });
    }

    discard.addEventListener('click', function () {
      if (saving) return;
      form = clone(baseForm);
      rebindForm();
      setError('');
      refreshDirty();
    });
    saveOnly.addEventListener('click', function () { save(false); });
    apply.addEventListener('click', function () { save(true); });
    closeBtn.addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey, true);

    // 放弃修改后要把所有控件拉回基线（不重建 DOM，避免页面跳动）。
    function rebindForm() {
      var pinned = String((status && (status.pinnedAccount || status.pinnedAccountLabel)) || '');
      var pinnedValue = '';
      accounts.some(function (a) {
        if (String(a.account || '') === pinned || String(a.wxid || '') === pinned) {
          pinnedValue = String(a.account || a.wxid || '');
          return true;
        }
        return false;
      });
      accSel.value = pinnedValue;
      auto.input.checked = !!form.autoStart;
      req.input.checked = !!form.group.requireAt;
      free.input.checked = !!form.group.freeChat;
      chance.input.value = String(form.group.freeChatChance);
      eng.input.value = String(form.group.engagedMinutes);
      cool.input.value = String(form.group.cooldownSec);
      cap.input.value = String(form.group.maxRepliesPerMinute);
      max.input.value = String(form.maxChars);
      bg.input.checked = !!form.wechat.backgroundSend;
      voiceSw.input.checked = !!form.native.voice;
      linksSw.input.checked = !!form.native.links;
      webSw.input.checked = !!form.native.websearch;
      stickerSw.input.checked = !!form.native.stickers;
      sgModel.value = String(form.stickerGen.model || 'qwen-image-2.1-pro');
      sgCat.value = String(form.stickerGen.category || '鲸鲸千问');
      sgChat.value = String(form.stickerGen.chat || '静音胡闹');
      sgKey.value = '';
      diarySw.input.checked = !!form.native.diary;
      diarySendSw.input.checked = !!form.native.diarySend;
      autoRead.input.value = String(form.native.momentsAutoRead);
      likeSw.input.checked = !!form.native.momentsAutoLike;
      keyInput.value = '';
      renderFeatureState();
      updateGroupUi();
    }

    renderSummary();
    refreshDirty();
    document.body.appendChild(mask);
    try { closeBtn.focus(); } catch (e) { console.warn('[wechat-settings] 初始焦点失败', e); }
    return true;
  }

  window.openWechatSettings = function () {
    if (!api || typeof api.settingsGet !== 'function') {
      toast('鲸鲸设置没接上：主进程/preload 还是旧的，重启一次工作台。', true);
      return Promise.resolve(false);
    }
    if (document.querySelector('.wxs-mask')) return Promise.resolve(false);
    return Promise.resolve(api.settingsGet()).then(function (r) {
      if (!r || r.ok === false) {
        toast('读不到鲸鲸设置：' + ((r && r.error) || '未知原因'), true, 10000);
        return false;
      }
      return build(r);
    }).catch(function (e) {
      toast('读不到鲸鲸设置：' + String((e && e.message) || e), true, 10000);
      return false;
    });
  };
})();
