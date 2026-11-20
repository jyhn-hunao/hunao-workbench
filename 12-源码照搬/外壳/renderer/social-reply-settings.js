'use strict';
// 通用社交回复设置弹窗（2026-11-19）
// 为什么单独一个弹窗：微信设置里已经有一堆微信专属项；语气 / emoji / 表情包频率
// 是微信、QQ、飞书共用的回复机制，不能塞进微信页里变成「只对微信生效」的假通用。
//
// 交互约定：
//   · 入口常驻在社交通道标题行，不藏在齿轮 / 右键 / 长弹层里；
//   · 只编辑「通用表达」这一层；通道能力只读展示，不画假开关；
//   · 改动只进表单，点保存才写 data/社交回复.json；有未保存修改时关窗先确认；
//   · 不重启工作台、不重启通道；微信提示词每轮现读，保存后下一条消息即生效。
//   · 会话登记是观察区：能看见哪些 chat 绑到哪个 DSH 会话，不提供手填 id。

(function () {
  var api = window.app && window.app.social;

  function toast(msg, bad, ms) {
    try {
      if (typeof window.__tbsToast === 'function') {
        window.__tbsToast(msg, !!bad, ms || (bad ? 8000 : 3000));
        return;
      }
    } catch (e) { console.warn('[social-reply] 顶栏通知不可用', e); }
    try { console.log('[social-reply] ' + msg); } catch (e2) { console.warn('[social-reply] 日志不可用', e2); }
  }

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function pct(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n * 100)));
  }

  function num(v, dflt, lo, hi) {
    var n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  function hhmm(ts) {
    var n = Number(ts);
    if (!n) return '还没有';
    try {
      var d = new Date(n);
      return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return new Date(n).toLocaleString(); }
  }

  function channelName(k) {
    return ({ wechat: '微信', qq: 'QQ', feishu: '飞书' })[String(k || '')] || String(k || '其他');
  }

  function capText(v) {
    if (v === false) return '不支持';
    if (v === null) return '未验证';
    if (v === 'native') return '原生控制';
    return '支持';
  }

  function capPill(v, label) {
    var cls = v === false ? 'is-bad' : ((v === null || v === 'native') ? 'is-warn' : 'is-ok');
    return '<span class="wxs-pill ' + cls + '">' + label + '：' + capText(v) + '</span>';
  }

  function build(dlg, data) {
    var policy = (data && data.policy) || {};
    var g = policy.global || {};
    var emoji = g.emoji || {};
    var sticker = g.sticker || {};
    var state = {
      tone: String(g.tone || ''),
      emojiPct: pct(emoji.chance),
      emojiMax: num(emoji.maxPerReply, 1, 1, 3),
      stickerPct: pct(sticker.chance),
      stickerMax: num(sticker.maxPerReply, 1, 1, 2),
      suppress: sticker.seriousSuppress !== false
    };
    var initial = JSON.stringify(state);

    var mask = mk('div', 'wxs-mask');
    mask.dataset.socialReply = '1';
    var dlgEl = mk('div', 'wxs-dlg');
    mask.appendChild(dlgEl);

    function close() {
      if (JSON.stringify(state) !== initial) {
        if (!window.confirm('还有没保存的修改，关掉就丢了。确定关闭？')) return;
      }
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey);

    var head = mk('div', 'wxs-head');
    var hw = mk('div', 'wxs-hw');
    hw.appendChild(mk('div', 'wxs-title', '回复风格 · 通用社交'));
    hw.appendChild(mk('div', 'wxs-sub', '微信 / QQ / 飞书共用这一套语气、emoji、表情包频率；通道只负责传输和原生能力。'));
    head.appendChild(hw);
    var x = mk('button', 'wxs-x', '✕');
    x.type = 'button';
    x.title = '关闭（有未保存修改会先确认）';
    x.addEventListener('click', close);
    head.appendChild(x);
    dlgEl.appendChild(head);

    var sum = mk('div', 'wxs-sum');
    var sessions = (data && data.sessions) || {};
    var by = sessions.byChannel || {};
    sum.innerHTML =
      '<span class="wxs-pill is-ok">策略 v1</span>' +
      '<span class="wxs-pill">会话 ' + Number(sessions.total || 0) + '</span>' +
      '<span class="wxs-pill">微信 ' + Number(by.wechat || 0) + '</span>' +
      '<span class="wxs-pill">QQ ' + Number(by.qq || 0) + '</span>' +
      '<span class="wxs-pill">飞书 ' + Number(by.feishu || 0) + '</span>' +
      '<span class="wxs-sum-text">保存后提示词层下一条生效；不重启工作台。</span>';
    dlgEl.appendChild(sum);

    var body = mk('div', 'wxs-body');
    dlgEl.appendChild(body);

    // 1. 通用表达：只放真正跨通道的项；最大字数 / 群节奏仍归各通道原生设置。
    var sec1 = mk('div', 'wxs-sec is-on');
    sec1.appendChild(mk('div', 'wxs-sec-title', '通用表达'));
    sec1.appendChild(mk('div', 'wxs-sec-hint', '这段语气会进入每个社交会话的提示词；不覆盖通道原生的 @ 触发、发送窗口和账号选择。'));
    var rowTone = mk('div', 'wxs-row');
    var lw = mk('div', 'wxs-lab-wrap');
    lw.appendChild(mk('div', 'wxs-lab', '说话语气'));
    lw.appendChild(mk('div', 'wxs-hint', '短句优先；不要客服腔、不要解释系统或工具。'));
    rowTone.appendChild(lw);
    var cw = mk('div', 'wxs-ctrl');
    var ta = mk('textarea', 'wxs-select');
    ta.rows = 3;
    ta.style.minWidth = '300px';
    ta.style.height = '74px';
    ta.style.resize = 'vertical';
    ta.value = state.tone;
    ta.addEventListener('input', function () { state.tone = String(ta.value || ''); });
    cw.appendChild(ta);
    rowTone.appendChild(cw);
    sec1.appendChild(rowTone);
    body.appendChild(sec1);

    // 2. 表情与贴纸：频率 / 上限 / 严肃抑制；不装「表情包总开关」——
    //    微信是否允许贴纸仍归鲸鲸设置的 native.stickers，避免两套同名开关打架。
    var sec2 = mk('div', 'wxs-sec is-on');
    sec2.appendChild(mk('div', 'wxs-sec-title', '表情与贴纸'));
    sec2.appendChild(mk('div', 'wxs-sec-hint', '普通闲聊按概率偶尔带；对方难过、求助、正事或严肃时不发。'));
    var rowEmoji = mk('div', 'wxs-row');
    var el = mk('div', 'wxs-lab-wrap');
    el.appendChild(mk('div', 'wxs-lab', 'emoji / 颜文字频率'));
    el.appendChild(mk('div', 'wxs-hint', '0 表示不主动加；语义合适的 emoji 仍可能被保留。'));
    rowEmoji.appendChild(el);
    var ec = mk('div', 'wxs-ctrl');
    var ei = mk('input', 'wxs-num');
    ei.type = 'number'; ei.min = '0'; ei.max = '100'; ei.step = '1'; ei.value = String(state.emojiPct);
    ei.addEventListener('input', function () { state.emojiPct = num(ei.value, 0, 0, 100); });
    ec.appendChild(ei);
    ec.appendChild(mk('span', 'wxs-unit', '% 的回复'));
    ec.appendChild(mk('span', 'wxs-unit', '最多'));
    var em = mk('input', 'wxs-num');
    em.type = 'number'; em.min = '1'; em.max = '3'; em.step = '1'; em.value = String(state.emojiMax);
    em.addEventListener('input', function () { state.emojiMax = num(em.value, 1, 1, 3); });
    ec.appendChild(em);
    ec.appendChild(mk('span', 'wxs-unit', '个'));
    rowEmoji.appendChild(ec);
    sec2.appendChild(rowEmoji);

    var rowSticker = mk('div', 'wxs-row');
    var sl = mk('div', 'wxs-lab-wrap');
    sl.appendChild(mk('div', 'wxs-lab', '表情包频率'));
    sl.appendChild(mk('div', 'wxs-hint', '微信固定图库有开心 / 傲娇 / 炸毛 / 鲸鲸千问；开启「按需生成」后，图库没有的合理情绪由微信功能页的千问补图并入库。QQ 用原生表情语法；飞书暂不支持贴纸包。'));
    rowSticker.appendChild(sl);
    var sc = mk('div', 'wxs-ctrl');
    var si = mk('input', 'wxs-num');
    si.type = 'number'; si.min = '0'; si.max = '100'; si.step = '1'; si.value = String(state.stickerPct);
    si.addEventListener('input', function () { state.stickerPct = num(si.value, 0, 0, 100); });
    sc.appendChild(si);
    sc.appendChild(mk('span', 'wxs-unit', '% 的回复'));
    sc.appendChild(mk('span', 'wxs-unit', '最多'));
    var sm = mk('input', 'wxs-num');
    sm.type = 'number'; sm.min = '1'; sm.max = '2'; sm.step = '1'; sm.value = String(state.stickerMax);
    sm.addEventListener('input', function () { state.stickerMax = num(sm.value, 1, 1, 2); });
    sc.appendChild(sm);
    sc.appendChild(mk('span', 'wxs-unit', '张'));
    rowSticker.appendChild(sc);
    sec2.appendChild(rowSticker);

    var rowSuppress = mk('div', 'wxs-row');
    var upl = mk('div', 'wxs-lab-wrap');
    upl.appendChild(mk('div', 'wxs-lab', '严肃场景不发表情包'));
    upl.appendChild(mk('div', 'wxs-hint', '对方说难过、求助、正事时，只回文字。'));
    rowSuppress.appendChild(upl);
    var uc = mk('div', 'wxs-ctrl');
    var sw = mk('label', 'wxs-switch');
    var cb = mk('input');
    cb.type = 'checkbox'; cb.checked = state.suppress;
    cb.addEventListener('change', function () { state.suppress = !!cb.checked; });
    sw.appendChild(cb);
    sw.appendChild(mk('span', 'wxs-slider'));
    uc.appendChild(sw);
    rowSuppress.appendChild(uc);
    sec2.appendChild(rowSuppress);
    body.appendChild(sec2);

    // 3. 通道能力：只读。通道不支持的项不生成标记，也不在这里画可点的开关。
    var sec3 = mk('div', 'wxs-sec is-on');
    sec3.appendChild(mk('div', 'wxs-sec-title', '通道能力（只读）'));
    sec3.appendChild(mk('div', 'wxs-sec-hint', '触发归通道原生逻辑；这里只声明传输能力，避免出现第二套同名开关。'));
    var caps = data.capabilities || {};
    ['wechat', 'qq', 'feishu'].forEach(function (key) {
      var c = caps[key] || {};
      var r = mk('div', 'wxs-row');
      var l = mk('div', 'wxs-lab-wrap');
      l.appendChild(mk('div', 'wxs-lab', channelName(key)));
      var sub = key === 'wechat'
        ? '微信个人号：文本 / 分条 / 原生贴纸 / 语音 / 引用；发送走鲸鲸后台窗口。'
        : (key === 'qq'
          ? 'QQ：文本 / 分条 / OneBot 原生表情 / 引用 / 语音（Breeze 或 SAPI）；具体回复开关在 QQ 卡标题行的「⚙ 回复设置」里。'
          : '飞书：文本 / 分条 / 语音 / 引用；不支持贴纸包，出站闸门尚未接入。');
      l.appendChild(mk('div', 'wxs-hint', sub));
      r.appendChild(l);
      var cr = mk('div', 'wxs-ctrl');
      var pill = mk('div', 'wxs-sum-text');
      pill.innerHTML = capPill(c.text, '文本') + ' ' + capPill(c.sticker, '贴纸') + ' ' +
        capPill(c.voice, '语音') + ' ' + capPill(c.quote, '引用');
      cr.appendChild(pill);
      r.appendChild(cr);
      sec3.appendChild(r);
    });
    var note = mk('div', 'wxs-note', '飞书出站闸门当前未接入（dsh-im 直连 open.feishu.cn），界面不把它画成“已保护”；QQ / 微信的闸门状态看通道卡片。');
    sec3.appendChild(note);
    body.appendChild(sec3);

    // 4. 会话登记：只读观察。发现两聊天共用一个 DSH 会话时，提示串聊风险。
    var sec4 = mk('div', 'wxs-sec is-on');
    sec4.appendChild(mk('div', 'wxs-sec-title', '社交会话登记'));
    sec4.appendChild(mk('div', 'wxs-sec-hint', 'chatId → DSH 会话总表；微信 / QQ 已自动登记，飞书等 dsh-im 通道在会话绑定时自动登记。'));
    var recent = Array.isArray(data.recent) ? data.recent : [];
    if (!recent.length) {
      var empty = mk('div', 'wxs-iso-empty');
      empty.textContent = '还没有登记到社交会话。微信收到第一条要回的消息、QQ 路由被读到时会自动登记。';
      sec4.appendChild(empty);
    } else {
      var map = mk('div', 'wxs-map');
      var headRow = mk('div', 'wxs-map-row wxs-map-head');
      headRow.innerHTML = '<span>聊天 / 标题</span><span>通道</span><span>会话</span>';
      map.appendChild(headRow);
      var seen = {};
      var dup = {};
      recent.forEach(function (r) {
        var sid = String(r.sessionId || '');
        if (seen[sid]) dup[sid] = (dup[sid] || 1) + 1;
        seen[sid] = true;
      });
      recent.forEach(function (r) {
        var rr = mk('div', 'wxs-map-row');
        var name = mk('div', 'wxs-map-name');
        name.appendChild(mk('div', 'wxs-map-title', String(r.chatTitle || r.title || r.chatId || '未命名聊天')));
        name.appendChild(mk('div', 'wxs-map-sub', String(r.chatType === 'group' ? '群聊' : '私聊') + ' · ' + String(r.chatId || '') + (r.auto ? ' · 自动登记' : '')));
        if (dup[String(r.sessionId || '')]) {
          var warn = mk('div', 'wxs-pill is-bad', '串聊风险');
          warn.title = '这个 DSH 会话被多个 chatId 共用，消息会混';
          name.appendChild(warn);
        }
        rr.appendChild(name);
        rr.appendChild(mk('div', 'wxs-map-id', channelName(r.channel)));
        var sidCell = mk('div', 'wxs-map-time', String(r.sessionId || '').slice(0, 18));
        sidCell.title = String(r.sessionId || '');
        rr.appendChild(sidCell);
        map.appendChild(rr);
      });
      sec4.appendChild(map);
    }
    var st = data.status || {};
    var statusLine = mk('div', 'wxs-note', '最近一次实际回复：' + (st.last
      ? hhmm(st.last.at) + ' · ' + channelName(st.last.channel) + ' · ' + Number(st.last.chars || 0) + ' 字 · 表情 ' + (Array.isArray(st.last.stickers) ? st.last.stickers.length : 0) + ' 张' +
        (Array.isArray(st.last.pending) && st.last.pending.length ? ' · 待按需生成 ' + st.last.pending.join('、') : '') +
        (Array.isArray(st.last.dropped) && st.last.dropped.length ? ' · 裁掉 ' + st.last.dropped.join('、') : '')
      : '还没有（通道回复后这里会出现）'));
    sec4.appendChild(statusLine);
    var dsh = data.dsh || null;
    var dshLine = mk('div', 'wxs-note');
    if (dsh && dsh.at) {
      var dshWhere = dsh.channel ? channelName(dsh.channel) + ' · ' + (dsh.chatType === 'group' ? '群聊' : '私聊') : '';
      if (dsh.kind === 'mount') {
        dshLine.textContent = 'DSH 策略：已挂载，等待下一条社交消息' + (dsh.mode === 'shadow' ? '（影子模式，不注入）' : '');
      } else if (dsh.kind === 'inject') {
        dshLine.textContent = 'DSH 注入：已生效 · ' + hhmm(dsh.at) + (dshWhere ? ' · ' + dshWhere : '') + (dsh.title ? ' · ' + dsh.title : '') + ' · ' + Number(dsh.chars || 0) + ' B';
      } else if (dsh.kind === 'shadow') {
        dshLine.textContent = 'DSH 注入：影子模式（只记日志，未注入） · ' + hhmm(dsh.at) + (dshWhere ? ' · ' + dshWhere : '');
      } else if (dsh.kind === 'bind') {
        dshLine.textContent = 'DSH 自动登记：' + hhmm(dsh.at) + (dshWhere ? ' · ' + dshWhere : '') + ' · 已写入会话总表';
      } else if (dsh.kind === 'unbind') {
        dshLine.textContent = 'DSH 解除登记：' + hhmm(dsh.at) + (dshWhere ? ' · ' + dshWhere : '') + ' · 已从会话总表移除';
      } else {
        dshLine.textContent = 'DSH 策略：' + hhmm(dsh.at);
      }
      dshLine.title = 'dsh-social-policy 插件写入的最近一次状态；每轮注入只写一次，不会每步刷新。';
    } else {
      dshLine.textContent = 'DSH 注入：暂无记录（插件未装 / 未重启整壳 / 还没有社交消息）。';
    }
    sec4.appendChild(dshLine);
    body.appendChild(sec4);

    var foot = mk('div', 'wxs-foot');
    var fh = mk('div', 'wxs-fh', '保存到 data/社交回复.json；不重启通道。');
    foot.appendChild(fh);
    var save = mk('button', 'wxs-btn is-primary', '保存');
    save.type = 'button';
    save.addEventListener('click', function () {
      if (!api || typeof api.replyPolicySave !== 'function') {
        toast('保存接口还没接上：重启一次工作台（preload / main 是旧的）', true);
        return;
      }
      save.disabled = true;
      fh.textContent = '保存中…';
      fh.className = 'wxs-fh';
      Promise.resolve(api.replyPolicySave({
        tone: state.tone,
        emoji: { chance: state.emojiPct / 100, maxPerReply: state.emojiMax },
        sticker: { chance: state.stickerPct / 100, maxPerReply: state.stickerMax, seriousSuppress: !!state.suppress }
      })).then(function (res) {
        save.disabled = false;
        if (!res || res.ok === false) {
          fh.textContent = '保存失败';
          fh.className = 'wxs-fh is-err';
          toast('保存失败：' + String((res && res.error) || '未知原因'), true);
          return;
        }
        initial = JSON.stringify(state);
        fh.textContent = '已保存；下一条消息生效（不重启通道）';
        fh.className = 'wxs-fh';
        toast('回复风格已保存；下一条消息生效', false, 3000);
      }).catch(function (e) {
        save.disabled = false;
        fh.textContent = '保存失败';
        fh.className = 'wxs-fh is-err';
        toast('保存失败：' + String((e && e.message) || e), true);
      });
    });
    foot.appendChild(save);
    var cancel = mk('button', 'wxs-btn', '关闭');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    foot.appendChild(cancel);
    dlgEl.appendChild(foot);

    body.addEventListener('input', function () {
      fh.textContent = JSON.stringify(state) !== initial ? '有未保存修改' : '保存到 data/社交回复.json；不重启通道。';
      fh.className = 'wxs-fh' + (JSON.stringify(state) !== initial ? ' is-dirty' : '');
    });

    mask.addEventListener('mousedown', function (e) {
      if (e.target === mask) close();
    });
    document.body.appendChild(mask);
  }

  function open() {
    if (document.querySelector('.wxs-mask[data-social-reply="1"]')) return Promise.resolve(true);
    if (!api || typeof api.replyPolicyGet !== 'function') {
      toast('通用回复设置还没接上：重启一次工作台（preload / main 是旧的）', true);
      return Promise.resolve(false);
    }
    return Promise.resolve(api.replyPolicyGet()).then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.error) || '读不到回复策略');
      build(null, data);
      return true;
    }).catch(function (e) {
      toast('打开回复风格设置失败：' + String((e && e.message) || e), true);
      return false;
    });
  }

  window.openSocialReplySettings = open;
})();
