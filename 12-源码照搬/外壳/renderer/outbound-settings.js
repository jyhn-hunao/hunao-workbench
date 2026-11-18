'use strict';
// 安全闸门设置弹窗（2026-11-18）
//
// 用户要求：「这个机制要做成可配置的界面」。入口常驻在「社交 → 通道」面板标题行，
// 不改场景 JSON、不新增面板；低频配置收在一个弹窗里，按「总览 / 规则 / 审计 / 高级」切换。
//
// 数据面：window.app.outbound（主进程 外壳\外发闸门.js）。
// 交互约定：
//   · 打开时读真实配置；改动只进表单，点「保存」才落盘；
//   · 保存会即时生效（QQ 走插件保存接口热切换；引擎没起来则写文件并标「重启整壳后生效」）；
//   · 危险动作（关闭总开关、恢复 QQ 直连）单独确认；
//   · 审计不回显原文，只显示渠道 / 结论 / 规则码；被拦原文只在本机目录，按钮打开。
//   · 所有看着像「安全状态」的字都来自主进程探测，不在前端猜。

(function () {
  var api = window.app && window.app.outbound;

  function toast(msg, bad, ms) {
    try {
      if (typeof window.__tbsToast === 'function') {
        window.__tbsToast(msg, !!bad, ms || (bad ? 8000 : 3000));
        return;
      }
    } catch (e) { console.warn('[outbound-settings] 顶栏通知不可用', e); }
    try { console.log('[outbound-settings] ' + msg); } catch (e2) { console.warn('[outbound-settings] 日志不可用', e2); }
  }
  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function has(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function get(obj, p) {
    var parts = String(p).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function put(obj, p, val) {
    var parts = String(p).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
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
    Object.keys(fb).forEach(function (k) { if (!has(fa, k)) out.push(k); });
    return out;
  }
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || '');
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    } catch (e) { return String(iso || ''); }
  }
  function verdictWord(v) {
    return ({ pass: '放行', redact: '打码后发', block: '拦截' }[v]) || String(v || '');
  }
  function channelWord(c) {
    return ({ wechat: '微信', qq: 'QQ', feishu: '飞书', unknown: '未知' }[c]) || String(c || '');
  }

  function viewToForm(c) {
    var ch = (c && c.channels) || {};
    var ac = (c && c.action) || {};
    var qq = (c && c.qq) || {};
    return {
      enabled: bool(c && c.enabled, true),
      mode: String((c && c.mode) || 'enforce') === 'shadow' ? 'shadow' : 'enforce',
      channels: {
        wechat: bool(ch.wechat, true),
        qq: bool(ch.qq, true),
        // 飞书出站还没接闸门，界面永远显示关（后端 normalizeConfig 也会按 false 落盘）
        feishu: false
      },
      action: {
        ip: String(ac.ip || 'block'),
        path: String(ac.path || 'block'),
        host: String(ac.host || 'block'),
        user: String(ac.user || 'block'),
        secret: String(ac.secret || 'block'),
        account: String(ac.account || 'redact'),
        attachment: String(ac.attachment || 'block')
      },
      replyFallback: String((c && c.replyFallback) || '这个我在这儿不方便说～'),
      allowPhrases: (Array.isArray(c && c.allowPhrases) ? c.allowPhrases : []).slice(),
      storeBlockedText: bool(c && c.storeBlockedText, true),
      unknownAction: String((c && c.unknownAction) || 'block') === 'pass' ? 'pass' : 'block',
      qq: {
        proxy: bool(qq.proxy, true),
        listenPort: num(qq.listenPort, 3100, 1, 65535),
        upstream: String(qq.upstream || 'http://127.0.0.1:3000/')
      }
    };
  }

  function formToPayload(f) {
    return {
      enabled: !!f.enabled,
      mode: f.mode === 'shadow' ? 'shadow' : 'enforce',
      channels: { wechat: !!f.channels.wechat, qq: !!f.channels.qq, feishu: false },
      action: {
        ip: f.action.ip, path: f.action.path, host: f.action.host, user: f.action.user,
        secret: f.action.secret, account: f.action.account, attachment: f.action.attachment
      },
      replyFallback: String(f.replyFallback || '').slice(0, 200),
      allowPhrases: String(f._allowText || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean),
      storeBlockedText: !!f.storeBlockedText,
      unknownAction: f.unknownAction === 'pass' ? 'pass' : 'block',
      qq: {
        proxy: !!f.qq.proxy,
        listenPort: num(f.qq.listenPort, 3100, 1, 65535),
        upstream: String(f.qq.upstream || '').trim()
      }
    };
  }

  function build(data) {
    var cfg = data.config || {};
    var form = viewToForm(cfg);
    form._allowText = (form.allowPhrases || []).join('\n');
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
    dlg.setAttribute('aria-labelledby', 'ogs-title');
    mask.appendChild(dlg);

    // ---------- 头 ----------
    var head = mk('div', 'wxs-head');
    var hw = mk('div', 'wxs-hw');
    var title = mk('div', 'wxs-title', '安全闸门');
    title.id = 'ogs-title';
    var sub = mk('div', 'wxs-sub', '所有发到 QQ / 微信 / 飞书的消息 · 出口唯一 · 判不清就不发');
    hw.appendChild(title); hw.appendChild(sub);
    var closeBtn = mk('button', 'wxs-x', '✕');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（未保存的修改会先确认）';
    head.appendChild(hw); head.appendChild(closeBtn);
    dlg.appendChild(head);

    var sum = mk('div', 'wxs-sum');
    dlg.appendChild(sum);

    // ---------- 页签 ----------
    var tabBar = mk('div', 'wxs-tabs');
    var tabs = [
      ['ov', '总览', '开关 / 模式 / 渠道 / 回话'],
      ['rules', '规则', '每类敏感信息的动作'],
      ['audit', '审计', '最近拦了谁、命中什么规则'],
      ['advanced', '高级', 'QQ 接管 / 资产指纹 / 自检']
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
    var saveBtn = mk('button', 'wxs-btn is-primary', '保存');
    discard.type = saveBtn.type = 'button';
    foot.appendChild(footHint); foot.appendChild(discard); foot.appendChild(saveBtn);
    dlg.appendChild(foot);

    var prevFocus = document.activeElement;
    var closed = false;

    function addSec(key, titleText, hintText) {
      var card = mk('div', 'wxs-sec');
      card.appendChild(mk('div', 'wxs-sec-title', titleText));
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
    function selectRow(label, hint, options, getVal, setVal) {
      var sel = mk('select', 'ogs-sel');
      options.forEach(function (o) {
        var op = mk('option', '', o[1]);
        op.value = o[0];
        sel.appendChild(op);
      });
      sel.value = String(getVal());
      sel.addEventListener('change', function () { setVal(sel.value); footError = ''; refreshDirty(); });
      return { row: row(label, hint, sel), input: sel };
    }
    function numberInput(label, hint, getVal, setVal, lo, hi) {
      var input = mk('input', 'wxs-num');
      input.type = 'number';
      input.min = String(lo); input.max = String(hi); input.step = '1';
      input.value = String(getVal());
      input.addEventListener('input', function () {
        var n = Number(input.value);
        if (!Number.isFinite(n)) return;
        setVal(n); footError = ''; refreshDirty();
      });
      input.addEventListener('blur', function () {
        var n = Number(input.value);
        if (!Number.isFinite(n)) { input.value = String(getVal()); return; }
        var v = Math.max(lo, Math.min(hi, Math.round(n)));
        input.value = String(v); setVal(v); refreshDirty();
      });
      return { row: row(label, hint, input), input: input };
    }
    function textInput(label, hint, getVal, setVal, placeholder) {
      var input = mk('input', 'ogs-text');
      input.type = 'text';
      input.value = String(getVal() || '');
      if (placeholder) input.placeholder = placeholder;
      input.addEventListener('input', function () { setVal(input.value); footError = ''; refreshDirty(); });
      return { row: row(label, hint, input), input: input };
    }

    // ---------- 状态摘要 ----------
    function stateText(st) {
      var on = !!st.enabled;
      var listening = !!st.listening;
      var qqOn = !(st.channels && st.channels.qq === false);
      var qqApplied = !!(st.qq && st.qq.applied);
      return '闸门 ' + (on ? '开' : '关')
        + ' · 模式 ' + (st.mode === 'shadow' ? '只记录' : '真拦')
        + ' · QQ ' + (qqApplied ? '已过闸门' : (qqOn && st.qq && st.qq.proxy ? '待接管' : '直连'))
        + ' · 代理 ' + (listening ? ('在听 ' + st.port) : '未起')
        + ' · 上游 ' + (st.upstreamOk ? '通' : '不通')
        + ' · 今日 检查 ' + ((st.today && st.today.checked) || 0)
        + ' / 拦 ' + ((st.today && st.today.blocked) || 0)
        + ' / 打码 ' + ((st.today && st.today.redacted) || 0);
    }
    function renderSummary() {
      sum.textContent = '';
      var line = mk('div', 'ogs-state', stateText(status));
      line.classList.add('is-' + (status.enabled ? ((status.listening || !status.qq || !status.qq.proxy) && status.upstreamOk !== false ? 'ok' : 'warn') : 'off'));
      sum.appendChild(line);
      if (status.lastError) sum.appendChild(mk('div', 'ogs-err', status.lastError));
    }

    // ---------- 总览 ----------
    var ov = addSec('ov', '总开关', '关掉等于所有通道都不设防；只建议临时排查时关');
    var master = switchRow('启用外发闸门', '关闭后消息原样发出，不再判定（仍然写审计的一条 disabled 记录不会出现）',
      function () { return form.enabled; }, function (v) { form.enabled = v; }, function () {
        if (!form.enabled) {
          var ok = window.confirm('关闭安全闸门后，她的回复不再检查 IP / 路径 / 密钥 / 账号。\n\n建议改用「只记录（shadow）」而不是直接关。仍然关闭？');
          if (!ok) { master.input.checked = true; form.enabled = true; }
        }
      });
    ov.appendChild(master.row);
    var modeSel = selectRow('模式', '真拦 = 命中就拦；只记录 = 照常发但写审计（不建议长期开）',
      [['enforce', '真拦（推荐）'], ['shadow', '只记录，不拦']],
      function () { return form.mode; }, function (v) { form.mode = v; });
    ov.appendChild(modeSel.row);

    var chSec = addSec('ch', '渠道', '每个通道单独开关；飞书出站还没接进闸门，默认关');
    var chWx = switchRow('微信', '微信的回复在微信通道.js 的 _reply() 里过闸；sendTest 也过',
      function () { return form.channels.wechat; }, function (v) { form.channels.wechat = v; });
    chSec.appendChild(chWx.row);
    var chQq = switchRow('QQ', 'QQ 走本机代理；插件 onebotHttp 指向闸门端口才生效',
      function () { return form.channels.qq; }, function (v) { form.channels.qq = v; });
    chSec.appendChild(chQq.row);
    var chFs = switchRow('飞书（未接，不能启用）', 'dsh-im 直连 open.feishu.cn，出站拦不到；接线前保持关，别把「没闸门」当安全',
      function () { return false; }, function () { /* 未接出站，永远不置 true */ });
    chFs.input.disabled = true;
    chFs.input.title = '飞书出站还没接入闸门：等自有发送器或带自检的补丁接上再开放';
    chSec.appendChild(chFs.row);

    var replySec = addSec('reply', '被拦后回什么', '群聊里也用它；不要写「已屏蔽」「系统提示」这类暴露机制的话');
    var fb = textInput('安全回话', '命中 block 时替换成的固定一句；留空 = 这条不回（不推荐）',
      function () { return form.replyFallback; }, function (v) { form.replyFallback = v; }, '这个我在这儿不方便说～');
    replySec.appendChild(fb.row);

    // ---------- 规则 ----------
    var ruleSec = addSec('rules', '每类信息的动作', '阻断 = 整条不发；打码 = 掩码后发；放行 = 不检查这一类（不推荐）');
    var ruleCtrls = {};
    (data.categories || []).forEach(function (cat) {
      var r = selectRow(cat.label, cat.hint,
        [['block', '阻断'], ['redact', '打码后发'], ['pass', '放行']],
        function () { return form.action[cat.key]; }, function (v) { form.action[cat.key] = v; });
      ruleSec.appendChild(r.row);
      ruleCtrls[cat.key] = r.input;
    });

    var allowSec = addSec('allow', '白名单短语', '一行一条；正文里出现就先把这段摘掉再判。只放「确实要发」的固定短语，别放 IP');
    var allowArea = mk('textarea', 'ogs-area');
    allowArea.rows = 4;
    allowArea.value = String(form._allowText || '');
    allowArea.placeholder = '例如：我们公司官网（一行一条）';
    allowArea.addEventListener('input', function () { form._allowText = allowArea.value; footError = ''; refreshDirty(); });
    allowSec.appendChild(allowArea);

    var storeRow = switchRow('被拦原文存本机', '只写到 外壳\\data\\安全闸门\\拦截\\，不进审计、不外发；关掉后只留 hash',
      function () { return form.storeBlockedText; }, function (v) { form.storeBlockedText = v; });
    allowSec.appendChild(storeRow.row);

    // ---------- 审计 ----------
    var auditSec = addSec('audit', '最近的外发审计', '只显示结论与规则码，不回显原文；原文在「拦截」目录（仅本机）');
    var auditBar = mk('div', 'ogs-bar');
    var auditList = mk('div', 'ogs-list');
    var refreshAuditBtn = mk('button', 'wxs-btn', '刷新');
    var openDirBtn = mk('button', 'wxs-btn', '打开审计目录');
    refreshAuditBtn.type = openDirBtn.type = 'button';
    auditBar.appendChild(refreshAuditBtn); auditBar.appendChild(openDirBtn);
    auditSec.appendChild(auditBar);
    auditSec.appendChild(auditList);

    function renderAudit(rows) {
      auditList.textContent = '';
      if (!rows || !rows.length) {
        auditList.appendChild(mk('div', 'ogs-empty', '还没有非放行记录 —— 要么没人发敏感内容，要么闸门还没生效。'));
        return;
      }
      rows.slice().reverse().forEach(function (r) {
        var line = mk('div', 'ogs-audit-row');
        var t = mk('span', 'ogs-audit-time', fmtTime(r.ts));
        var c = mk('span', 'ogs-audit-ch', channelWord(r.channel));
        var v = mk('span', 'ogs-badge is-' + String(r.verdict || 'pass'), verdictWord(r.verdict));
        if (r.shadow) v.textContent = '只记录 · ' + (r.would ? verdictWord(r.would) : '');
        var rules = mk('span', 'ogs-audit-rules', (r.rules && r.rules.length) ? r.rules.join(' / ') : '—');
        line.appendChild(t); line.appendChild(c); line.appendChild(v); line.appendChild(rules);
        auditList.appendChild(line);
      });
    }
    function loadAudit() {
      if (!api || typeof api.audit !== 'function') { renderAudit([]); return Promise.resolve(); }
      refreshAuditBtn.disabled = true;
      return Promise.resolve(api.audit(40)).then(function (r) {
        refreshAuditBtn.disabled = false;
        renderAudit((r && r.rows) || []);
      }).catch(function (e) {
        refreshAuditBtn.disabled = false;
        toast('读审计失败：' + String((e && e.message) || e), true);
      });
    }
    refreshAuditBtn.addEventListener('click', loadAudit);
    openDirBtn.addEventListener('click', function () {
      if (!api || typeof api.openDir !== 'function') { toast('打开目录接口没接上：重启一次工作台', true); return; }
      Promise.resolve(api.openDir()).catch(function (e) { toast('打开目录失败：' + String((e && e.message) || e), true); });
    });

    // ---------- 高级 ----------
    var secQq = addSec('qq', 'QQ 接管', '开关在下面；「立即接管」会调插件保存接口热生效，失败则写文件并提示重启整壳');
    var qqProxyRow = switchRow('QQ 走闸门代理', '关掉 = QQ 直连协议端，不经过内容判定',
      function () { return form.qq.proxy; }, function (v) { form.qq.proxy = v; }, function () {
        if (!form.qq.proxy) {
          var ok = window.confirm('关闭后 QQ 消息不再过内容闸门（IP / 路径 / 密钥都不查）。仍然关闭？');
          if (!ok) { qqProxyRow.input.checked = true; form.qq.proxy = true; }
        }
      });
    secQq.appendChild(qqProxyRow.row);
    var portRow = numberInput('闸门监听端口', '只监听 127.0.0.1；改端口后需要让插件重新指过来（保存时会自动做）',
      function () { return form.qq.listenPort; }, function (v) { form.qq.listenPort = v; }, 1, 65535);
    secQq.appendChild(portRow.row);
    var upRow = textInput('协议端地址（上游）', 'SnowLuma 的 OneBot HTTP，默认 http://127.0.0.1:3000/',
      function () { return form.qq.upstream; }, function (v) { form.qq.upstream = v; }, 'http://127.0.0.1:3000/');
    secQq.appendChild(upRow.row);

    var qqBar = mk('div', 'ogs-bar');
    var applyBtn = mk('button', 'wxs-btn', '立即接管 QQ');
    var restoreBtn = mk('button', 'wxs-btn', '恢复 QQ 直连');
    var qqResult = mk('div', 'ogs-note', '');
    applyBtn.type = restoreBtn.type = 'button';
    qqBar.appendChild(applyBtn); qqBar.appendChild(restoreBtn);
    secQq.appendChild(qqBar);
    secQq.appendChild(qqResult);

    applyBtn.addEventListener('click', function () {
      if (!api || typeof api.qqApply !== 'function') { toast('接管接口没接上：重启一次工作台', true); return; }
      applyBtn.disabled = true;
      Promise.resolve(api.qqApply()).then(function (r) {
        applyBtn.disabled = false;
        if (!r || r.ok === false) {
          qqResult.textContent = '接管失败：' + ((r && r.error) || '未知原因');
          qqResult.className = 'ogs-note is-err';
          toast('QQ 接管失败：' + ((r && r.error) || '未知原因'), true);
          return;
        }
        qqResult.textContent = r.restartRequired
          ? '已写进 QQ 桥接配置，但引擎没就绪：重启整壳后生效（' + (r.error || '') + '）'
          : 'QQ 已指向闸门：' + (r.url || '');
        qqResult.className = 'ogs-note' + (r.restartRequired ? ' is-warn' : ' is-ok');
        toast(r.restartRequired ? '已保存；重启整壳后 QQ 才走闸门' : 'QQ 已接管', !!r.restartRequired);
        // 接管是持久动作：同步表单与基线，别让界面还显示「关」或「有未保存修改」
        form.qq.proxy = true; qqProxyRow.input.checked = true;
        form.channels.qq = true; chQq.input.checked = true;
        if (baseForm.qq) baseForm.qq.proxy = true;
        if (baseForm.channels) baseForm.channels.qq = true;
        refreshDirty();
        if (typeof api.status === 'function') Promise.resolve(api.status()).then(function (s) { if (s) { status = s; renderSummary(); } });
      }).catch(function (e) {
        applyBtn.disabled = false;
        qqResult.textContent = '接管失败：' + String((e && e.message) || e);
        qqResult.className = 'ogs-note is-err';
        toast('QQ 接管失败：' + String((e && e.message) || e), true);
      });
    });
    restoreBtn.addEventListener('click', function () {
      if (!window.confirm('把 QQ 桥接地址恢复成直连（不经闸门）？恢复后 QQ 消息不再检查内容。')) return;
      if (!api || typeof api.qqRestore !== 'function') { toast('恢复接口没接上：重启一次工作台', true); return; }
      restoreBtn.disabled = true;
      Promise.resolve(api.qqRestore()).then(function (r) {
        restoreBtn.disabled = false;
        if (!r || r.ok === false) {
          qqResult.textContent = '恢复失败：' + ((r && r.error) || '未知原因');
          qqResult.className = 'ogs-note is-err';
          return;
        }
        qqResult.textContent = r.restartRequired
          ? '已写回直连地址，重启整壳后生效（' + (r.error || '') + '）'
          : 'QQ 已恢复直连：' + (r.url || '');
        qqResult.className = 'ogs-note' + (r.restartRequired ? ' is-warn' : ' is-ok');
        // 恢复是持久动作：后端已把 qq.proxy 落成 false，表单同步，避免显示「还开着」
        form.qq.proxy = false; qqProxyRow.input.checked = false;
        if (baseForm.qq) baseForm.qq.proxy = false;
        refreshDirty();
        if (typeof api.status === 'function') Promise.resolve(api.status()).then(function (s) { if (s) { status = s; renderSummary(); } });
      }).catch(function (e) {
        restoreBtn.disabled = false;
        qqResult.textContent = '恢复失败：' + String((e && e.message) || e);
        qqResult.className = 'ogs-note is-err';
      });
    });

    var secAssets = addSec('assets', '本机资产指纹', '启动时采集网卡 IP、主机名、用户名、路径、通道 token；换 WiFi / 开 VPN 后点一次刷新');
    var assetLine = mk('div', 'ogs-note', '');
    var assetBar = mk('div', 'ogs-bar');
    var assetBtn = mk('button', 'wxs-btn', '刷新资产');
    assetBtn.type = 'button';
    assetBar.appendChild(assetBtn);
    secAssets.appendChild(assetLine);
    secAssets.appendChild(assetBar);
    function renderAssets(a) {
      var x = a || data.assets || {};
      var kinds = x.kinds || {};
      assetLine.textContent = '共 ' + (x.count || 0) + ' 项 · '
        + Object.keys(kinds).map(function (k) { return k + ' ' + kinds[k]; }).join(' · ')
        + (x.generatedAt ? ' · ' + fmtTime(new Date(x.generatedAt).toISOString()) : '');
      assetLine.className = 'ogs-note';
    }
    renderAssets();
    assetBtn.addEventListener('click', function () {
      if (!api || typeof api.assetsRefresh !== 'function') { toast('刷新接口没接上：重启一次工作台', true); return; }
      assetBtn.disabled = true;
      Promise.resolve(api.assetsRefresh()).then(function (r) {
        assetBtn.disabled = false;
        if (!r || r.ok === false) { toast('刷新资产失败：' + ((r && r.error) || '未知原因'), true); return; }
        renderAssets(r);
        toast('已重新采集本机资产（' + r.count + ' 项）');
      }).catch(function (e) {
        assetBtn.disabled = false;
        toast('刷新资产失败：' + String((e && e.message) || e), true);
      });
    });

    var secCheck = addSec('selfcheck', '行为自检', '规则用例 + 代理用例；有 ✗ 就说明这套闸门现在拦不住，先修再信');
    var checkBar = mk('div', 'ogs-bar');
    var checkBtn = mk('button', 'wxs-btn', '跑一遍自检');
    var checkOut = mk('div', 'ogs-list');
    checkBtn.type = 'button';
    checkBar.appendChild(checkBtn);
    secCheck.appendChild(checkBar);
    secCheck.appendChild(checkOut);
    checkBtn.addEventListener('click', function () {
      if (!api || typeof api.selfCheck !== 'function') { toast('自检接口没接上：重启一次工作台', true); return; }
      checkBtn.disabled = true;
      checkOut.textContent = '跑着……';
      Promise.resolve(api.selfCheck()).then(function (r) {
        checkBtn.disabled = false;
        checkOut.textContent = '';
        var head2 = mk('div', 'ogs-note ' + (r && r.ok ? 'is-ok' : 'is-err'),
          '规则 ' + ((r && r.total) || 0) + ' 条：' + (((r && r.total) || 0) - ((r && r.failed) || 0)) + ' 通过 / ' + ((r && r.failed) || 0) + ' 失败');
        checkOut.appendChild(head2);
        ((r && r.results) || []).forEach(function (x) {
          if (x.ok) return;
          var line = mk('div', 'ogs-audit-row');
          line.appendChild(mk('span', 'ogs-badge is-fail', '✗'));
          line.appendChild(mk('span', 'ogs-audit-rules', x.name + '：期望 ' + x.want + '，实际 ' + x.got + '（' + (x.rules || []).join(' / ') + '）'));
          checkOut.appendChild(line);
        });
      }).catch(function (e) {
        checkBtn.disabled = false;
        checkOut.textContent = '自检失败：' + String((e && e.message) || e);
      });
    });

    var secTest = addSec('test', '试审一条', '不发送，只用当前规则与资产判一条，看看会不会被拦 / 打码');
    var testInput = mk('textarea', 'ogs-area');
    testInput.rows = 3;
    testInput.placeholder = '粘贴一句准备发出去的话，例如：我这台机器在 192.168.1.23 上';
    var testBar = mk('div', 'ogs-bar');
    var testSel = mk('select', 'ogs-sel');
    [['qq', 'QQ'], ['wechat', '微信'], ['feishu', '飞书']].forEach(function (o) {
      var op = mk('option', '', o[1]); op.value = o[0]; testSel.appendChild(op);
    });
    var testBtn = mk('button', 'wxs-btn', '审一下');
    var testOut = mk('div', 'ogs-note', '');
    testBtn.type = 'button';
    testBar.appendChild(testSel); testBar.appendChild(testBtn);
    secTest.appendChild(testInput); secTest.appendChild(testBar); secTest.appendChild(testOut);
    testBtn.addEventListener('click', function () {
      if (!api || typeof api.test !== 'function') { toast('试审接口没接上：重启一次工作台', true); return; }
      var text = String(testInput.value || '');
      if (!text.trim()) { testOut.textContent = '先写一句话'; testOut.className = 'ogs-note is-warn'; return; }
      testBtn.disabled = true;
      Promise.resolve(api.test(text, testSel.value)).then(function (r) {
        testBtn.disabled = false;
        var x = (r && r.result) || {};
        testOut.textContent = '判定：' + verdictWord(x.verdict)
          + (x.shadow ? '（只记录 · ' + verdictWord(x.would) + '）' : '')
          + ' · 规则：' + ((x.rules && x.rules.length) ? x.rules.join(' / ') : '无')
          + (x.verdict === 'redact' ? '\n打码后：' + x.text : '');
        testOut.className = 'ogs-note ' + (x.verdict === 'pass' ? 'is-ok' : (x.verdict === 'redact' ? 'is-warn' : 'is-err'));
      }).catch(function (e) {
        testBtn.disabled = false;
        testOut.textContent = '试审失败：' + String((e && e.message) || e);
        testOut.className = 'ogs-note is-err';
      });
    });

    var secPath = addSec('paths', '文件位置（只读）', '全部在本机；外壳\\data\\ 已被 .gitignore 挡住，不会进仓库');
    var pathBox = mk('div', 'ogs-paths');
    [['配置', paths.config], ['资产', paths.assets], ['审计', paths.audit], ['拦截原文', paths.blocked], ['QQ 配置', paths.qqConfig]].forEach(function (p) {
      if (!p[1]) return;
      var line = mk('div', 'ogs-path-row');
      line.appendChild(mk('span', 'ogs-path-k', p[0]));
      line.appendChild(mk('span', 'ogs-path-v', p[1]));
      pathBox.appendChild(line);
    });
    secPath.appendChild(pathBox);

    // ---------- 页签切换 ----------
    function setTab(key) {
      Object.keys(tabBtns).forEach(function (k) { tabBtns[k].classList.toggle('is-on', k === key); });
      Object.keys(secs).forEach(function (k) {
        var sec = secs[k];
        // 组归属：key 以所属页签开头
        var owner = k === 'ov' || k === 'ch' || k === 'reply' ? 'ov'
          : (k === 'rules' || k === 'allow' ? 'rules'
            : (k === 'audit' ? 'audit' : 'advanced'));
        sec.classList.toggle('is-on', owner === key);
      });
      if (key === 'audit') loadAudit();
    }

    // ---------- 脏检查 / 保存 ----------
    function refreshDirty() {
      var n = diffKeys(form, baseForm).length;
      if (!footError) {
        footHint.textContent = n ? ('有 ' + n + ' 项未保存修改') : '没有未保存修改';
        footHint.classList.toggle('is-dirty', !!n);
        footHint.classList.remove('is-err');
      } else {
        footHint.textContent = footError;
        footHint.classList.add('is-err');
        footHint.classList.remove('is-dirty');
      }
      discard.disabled = saving || n === 0;
      saveBtn.disabled = saving || n === 0;
      saveBtn.textContent = saving ? '保存中…' : '保存';
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
      try { mask.remove(); } catch (e) { console.warn('[outbound-settings] 弹窗移除失败', e); }
      try { if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus(); } catch (e2) { console.warn('[outbound-settings] 焦点恢复失败', e2); }
    }
    function onKey(e) {
      if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); e.stopPropagation(); close(); }
    }

    function save() {
      if (saving) return;
      if (form.enabled && form.mode === 'shadow') {
        var okShadow = window.confirm('当前是「只记录，不拦」：敏感内容仍然会发出去。确定用这个模式？');
        if (!okShadow) return;
      }
      saving = true; setError('');
      refreshDirty();
      var payload = formToPayload(form);
      Promise.resolve(api.set(payload)).then(function (r) {
        saving = false;
        if (!r || r.ok === false) {
          setError('保存失败：' + ((r && r.error) || '主进程没有返回结果'));
          toast('保存失败：' + ((r && r.error) || '主进程没有返回结果'), true);
          refreshDirty();
          return;
        }
        if (r.status) status = r.status;
        if (r.applied && r.applied.restartRequired) {
          toast('设置已保存；QQ 要重启整壳后才走闸门（' + (r.applied.error || '') + '）', true, 10000);
        } else {
          toast('设置已保存并生效');
        }
        // 以主进程归一化后的配置为准重建表单：端口夹紧、飞书强制关、恢复直连后 proxy=false
        // 都在后端决定，前端不能拿旧表单覆盖它。
        if (r.config) {
          form = viewToForm(r.config);
          form._allowText = (form.allowPhrases || []).join('\n');
        } else {
          form.allowPhrases = payload.allowPhrases.slice();
        }
        baseForm = clone(form);
        applyFormToInputs();
        renderSummary();
        refreshDirty();
      }).catch(function (e) {
        saving = false;
        setError('保存失败：' + String((e && e.message) || e));
        toast('保存失败：' + String((e && e.message) || e), true);
        refreshDirty();
      });
    }

    discard.addEventListener('click', function () {
      form = clone(baseForm);
      applyFormToInputs();
      footError = '';
      refreshDirty();
    });
    saveBtn.addEventListener('click', save);
    closeBtn.addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    function applyFormToInputs() {
      master.input.checked = !!form.enabled;
      modeSel.input.value = form.mode;
      chWx.input.checked = !!form.channels.wechat;
      chQq.input.checked = !!form.channels.qq;
      chFs.input.checked = !!form.channels.feishu;
      fb.input.value = String(form.replyFallback || '');
      Object.keys(ruleCtrls).forEach(function (k) { ruleCtrls[k].value = form.action[k]; });
      allowArea.value = String(form._allowText != null ? form._allowText : (form.allowPhrases || []).join('\n'));
      storeRow.input.checked = !!form.storeBlockedText;
      qqProxyRow.input.checked = !!form.qq.proxy;
      portRow.input.value = String(form.qq.listenPort);
      upRow.input.value = String(form.qq.upstream || '');
    }

    renderSummary();
    applyFormToInputs();
    refreshDirty();
    setTab('ov');
    document.body.appendChild(mask);
    document.addEventListener('keydown', onKey, true);
    try { closeBtn.focus(); } catch (e) { console.warn('[outbound-settings] 初始焦点失败', e); }
    return true;
  }

  window.openOutboundSettings = function () {
    if (!api || typeof api.get !== 'function') {
      toast('安全闸门设置没接上：主进程 / preload 还是旧的，重启一次工作台。', true);
      return Promise.resolve(false);
    }
    if (document.querySelector('.wxs-mask')) return Promise.resolve(false);
    return Promise.resolve(api.get()).then(function (r) {
      if (!r || r.ok === false) {
        toast('读不到安全闸门配置：' + ((r && r.error) || '未知原因'), true, 10000);
        return false;
      }
      return build(r);
    }).catch(function (e) {
      toast('读不到安全闸门配置：' + String((e && e.message) || e), true, 10000);
      return false;
    });
  };

  // 通道面板的常驻状态条用：轻量读状态（不打开弹窗）
  window.__outboundStatus = function () {
    if (!api || typeof api.status !== 'function') return Promise.resolve(null);
    return Promise.resolve(api.status()).catch(function () { return null; });
  };
})();
