'use strict';
// QQ 回复设置弹窗（2026-11-19）
// 为什么单独一个弹窗：QQ 卡片里原来挤着「群旁听 + 随机接话 + 语音 + 表情包 + Breeze
// + 试音 + 直接语音」十几种控件，通道面板应该只回答「通不通、策略概览」。
// 这里只编辑回复行为；QQ 会话路由仍在「QQ 会话隔离」块，不混进来。
//
// 交互约定：
//   · 入口常驻在 QQ 卡标题行，通道停着也能打开；
//   · 改动只进表单，点「保存设置」才写 QQ群聊.json / QQ能力.json；
//   · 有未保存修改时关窗先确认；打开主动接话、群语音、直接语音前单独说明影响；
//   · 不重启工作台；保存后下一轮消息按新设置走；
//   · 微信原生语音的 Breeze 同步按钮复用 QQ 的「语音合成服务」这一份 Key/音色，
//     不画第二套 Breeze 输入框。

(function () {
  var api = window.app || {};
  var mediaApi = api.qqMedia || null;
  var groupApi = api.qqGroups || null;

  function toast(msg, bad, ms) {
    try {
      if (typeof window.__tbsToast === 'function') {
        window.__tbsToast(msg, !!bad, ms || (bad ? 8000 : 3000));
        return;
      }
    } catch (e) { console.warn('[qq-reply] 顶栏通知不可用', e); }
    try { console.log('[qq-reply] ' + msg); } catch (e2) { console.warn('[qq-reply] 日志不可用', e2); }
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
  function num(v, dflt, lo, hi, step) {
    var n = Number(v);
    if (!Number.isFinite(n)) n = dflt;
    n = Math.max(lo, Math.min(hi, n));
    return step && step < 1 ? Math.round(n * 10) / 10 : Math.round(n);
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function timeText(ts) {
    var n = Number(ts);
    if (!n) return '还没有';
    try {
      return new Date(n).toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) { return new Date(n).toLocaleString(); }
  }

  function groupForm(s) {
    s = s || {};
    return {
      freeChat: bool(s.freeChat, false),
      chancePct: num(s.chancePct, 6, 0, 100, 0.1),
      engagedMinutes: num(s.engagedMinutes, 6, 1, 120),
      silentMinutes: num(s.silentMinutes, 30, 1, 240),
      cooldownSec: num(s.cooldownSec, 0, 0, 3600),
      maxRepliesPerMinute: num(s.maxRepliesPerMinute, 15, 1, 30),
      maxChars: num(s.maxChars, 70, 20, 300),
      addressGuard: bool(s.addressGuard, true)
    };
  }
  function mediaForm(c) {
    c = c || {};
    return {
      enabled: bool(c.enabled, true),
      voice: bool(c.voice, true),
      voiceListen: bool(c.voiceListen, true),
      voiceReply: bool(c.voiceReply, true),
      voiceReplyGroups: bool(c.voiceReplyGroups, false),
      voiceReplyChancePct: num(c.voiceReplyChancePct, 0, 0, 100, 0.1),
      voiceReplyMentions: bool(c.voiceReplyMentions, false),
      voiceReplyMentionsChancePct: num(c.voiceReplyMentionsChancePct, 100, 0, 100, 0.1),
      voiceReplyPrivate: bool(c.voiceReplyPrivate, false),
      voiceReplyPrivateChancePct: num(c.voiceReplyPrivateChancePct, 100, 0, 100, 0.1),
      voiceMaxChars: num(c.voiceMaxChars, 80, 10, 180),
      stickers: bool(c.stickers, true),
      stickerChancePct: num(c.stickerChancePct, 30, 0, 100, 0.1),
      stickerMaxPerReply: num(c.stickerMaxPerReply, 1, 1, 2),
      stickerDynamic: bool(c.stickerDynamic, true),
      ttsProvider: c.ttsProvider === 'breeze' ? 'breeze' : 'sapi',
      ttsVoice: String(c.ttsVoice || 'Microsoft Huihui Desktop'),
      breezeApiKey: '',
      breezeVoiceId: String(c.breezeVoiceId || ''),
      breezeVoiceName: String(c.breezeVoiceName || ''),
      breezeModel: String(c.breezeModel || 'breeze-tts-2'),
      breezeLanguage: String(c.breezeLanguage || 'zh'),
      breezeBaseUrl: String(c.breezeBaseUrl || 'https://api.breeze.blue'),
      breezeInstructions: String(c.breezeInstructions || ''),
      breezeFallback: bool(c.breezeFallback, true)
    };
  }

  function switchRow(label, hint, checked, onChange) {
    var r = mk('div', 'wxs-row');
    var l = mk('div', 'wxs-lab-wrap');
    l.appendChild(mk('div', 'wxs-lab', label));
    if (hint) l.appendChild(mk('div', 'wxs-hint', hint));
    r.appendChild(l);
    var c = mk('div', 'wxs-ctrl');
    var sw = mk('label', 'wxs-switch');
    var cb = mk('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.addEventListener('change', function () { onChange(!!cb.checked); });
    sw.appendChild(cb);
    sw.appendChild(mk('span', 'wxs-slider'));
    c.appendChild(sw);
    r.appendChild(c);
    return { row: r, input: cb };
  }

  function numRow(label, hint, value, min, max, step, unit, onChange) {
    var r = mk('div', 'wxs-row');
    var l = mk('div', 'wxs-lab-wrap');
    l.appendChild(mk('div', 'wxs-lab', label));
    if (hint) l.appendChild(mk('div', 'wxs-hint', hint));
    r.appendChild(l);
    var c = mk('div', 'wxs-ctrl');
    var i = mk('input', 'wxs-num');
    i.type = 'number';
    i.min = String(min);
    i.max = String(max);
    i.step = String(step || 1);
    i.value = String(value);
    i.addEventListener('input', function () { onChange(Number(i.value)); });
    c.appendChild(i);
    c.appendChild(mk('span', 'wxs-unit', unit || ''));
    r.appendChild(c);
    return { row: r, input: i };
  }

  function selectRow(label, hint, value, options, onChange) {
    var r = mk('div', 'wxs-row');
    var l = mk('div', 'wxs-lab-wrap');
    l.appendChild(mk('div', 'wxs-lab', label));
    if (hint) l.appendChild(mk('div', 'wxs-hint', hint));
    r.appendChild(l);
    var c = mk('div', 'wxs-ctrl');
    var s = mk('select', 'wxs-select');
    options.forEach(function (o) {
      var op = mk('option', '', o[1]);
      op.value = o[0];
      s.appendChild(op);
    });
    s.value = value;
    s.addEventListener('change', function () { onChange(s.value); });
    c.appendChild(s);
    r.appendChild(c);
    return { row: r, input: s };
  }

  function inputRow(label, hint, value, placeholder, type, multiline, onChange) {
    var r = mk('div', 'wxs-row');
    var l = mk('div', 'wxs-lab-wrap');
    l.appendChild(mk('div', 'wxs-lab', label));
    if (hint) l.appendChild(mk('div', 'wxs-hint', hint));
    r.appendChild(l);
    var c = mk('div', 'wxs-ctrl');
    var i = mk(multiline ? 'textarea' : 'input', multiline ? 'wxs-select' : 'wxs-key');
    if (multiline) { i.rows = 2; i.style.minWidth = '280px'; } else { i.type = type || 'text'; }
    i.value = value == null ? '' : String(value);
    i.placeholder = placeholder || '';
    i.autocomplete = 'off';
    i.addEventListener('input', function () { onChange(i.value); });
    c.appendChild(i);
    r.appendChild(c);
    return { row: r, input: i };
  }

  function build(mediaStatus, groupStatus) {
    var mc = (mediaStatus && mediaStatus.config) || {};
    var gs = (groupStatus && groupStatus.settings) || {};
    var baseGroup = groupForm(gs);
    var baseMedia = mediaForm(mc);
    var form = { group: clone(baseGroup), media: clone(baseMedia) };
    var closed = false;
    var saving = false;
    var activeTab = 'group';

    var mask = mk('div', 'wxs-mask');
    var dlg = mk('div', 'wxs-dlg');
    mask.appendChild(dlg);

    var head = mk('div', 'wxs-head');
    var hw = mk('div', 'wxs-hw');
    hw.appendChild(mk('div', 'wxs-title', 'QQ 回复设置'));
    hw.appendChild(mk('div', 'wxs-sub', '只改 QQ 收到消息后怎么回：群旁听、随机接话、语音、表情包和语音合成。会话路由在 QQ 卡片的「QQ 会话隔离」里。'));
    head.appendChild(hw);
    var x = mk('button', 'wxs-x', '✕');
    x.type = 'button';
    x.title = '关闭（有未保存修改会先确认）';
    head.appendChild(x);
    dlg.appendChild(head);

    var sum = mk('div', 'wxs-sum');
    dlg.appendChild(sum);

    var tabs = mk('div', 'wxs-tabs');
    var tabDefs = [['group', '群聊接话'], ['voice', '语音 / 表情']];
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

    // ---------- 群聊接话 ----------
    var secGroup = mk('div', 'wxs-sec');
    secGroup.appendChild(mk('div', 'wxs-sec-title', '群旁听与随机接话'));
    secGroup.appendChild(mk('div', 'wxs-sec-hint', '只对已绑定、没 @ 别人的群消息生效。随机接话默认关；打开后仍受概率、静默、冷却和每分钟上限约束。'));
    secGroup.appendChild(switchRow('群随机接话', '打开后，她可能在没有叫她的群里插话；默认关。', form.group.freeChat, function (v) { form.group.freeChat = v; renderSum(); }).row);
    secGroup.appendChild(numRow('接话概率', '只影响群随机接话；0 = 不主动接。', form.group.chancePct, 0, 100, 0.1, '%', function (v) { form.group.chancePct = num(v, 6, 0, 100, 0.1); }).row);
    secGroup.appendChild(numRow('接话窗口', '话题活跃后保持可接话的分钟数。', form.group.engagedMinutes, 1, 120, 1, '分钟', function (v) { form.group.engagedMinutes = num(v, 6, 1, 120); }).row);
    secGroup.appendChild(numRow('静默重置', '群里多久没人说话后退出接话窗口。', form.group.silentMinutes, 1, 240, 1, '分钟', function (v) { form.group.silentMinutes = num(v, 30, 1, 240); }).row);
    secGroup.appendChild(numRow('最短冷却', '两次接话之间至少隔多少秒。', form.group.cooldownSec, 0, 3600, 1, '秒', function (v) { form.group.cooldownSec = num(v, 0, 0, 3600); }).row);
    secGroup.appendChild(numRow('每分钟上限', '防止刷屏；到上限后本轮不再接话。', form.group.maxRepliesPerMinute, 1, 30, 1, '条', function (v) { form.group.maxRepliesPerMinute = num(v, 15, 1, 30); }).row);
    secGroup.appendChild(numRow('单条字数上限', '超过后截断，避免在群里刷长文。', form.group.maxChars, 20, 300, 1, '字', function (v) { form.group.maxChars = num(v, 70, 20, 300); }).row);
    secGroup.appendChild(switchRow('群地址保护', '开：消息在 @ 别人（含 @全体）时，这次不抢话。', form.group.addressGuard, function (v) { form.group.addressGuard = v; }).row);

    // 只读观察区：改完参数后不用翻日志，也能看出旁听有没有连上、最近一次为什么没接/接了。
    var obsG = mk('div', 'wxs-subsec');
    obsG.appendChild(mk('div', 'wxs-subsec-title', '当前观察（只读）'));
    var gst = groupStatus || {};
    var linesG = [
      'OneBot：' + (gst.connected ? '已连接' : '未连接')
        + ' · 旁听群：' + ((gst.groups || []).length) + ' 个'
        + ' · 已处理事件：' + Number((gst.counts && gst.counts.events) || 0),
      '最近判定：' + (gst.lastDecision
        ? (timeText(gst.lastDecision.at) + ' · ' + (gst.lastDecision.ok ? '准备接话' : ('跳过：' + (gst.lastDecision.reason || '未命中')))
          + ' · 概率 ' + Number(gst.lastDecision.chancePct || 0) + '%')
        : '还没有群里消息进入判定。'),
      '最近接话：' + (gst.lastReply
        ? (timeText(gst.lastReply.at) + ' · ' + (gst.lastReply.ok ? '成功' : ('失败：' + (gst.lastReply.reason || '未知')))
          + ' · 群 ' + (gst.lastReply.groupId || '—'))
        : '还没有成功接话记录。')
    ];
    if (gst.lastError) linesG.push('最近错误：' + gst.lastError);
    linesG.forEach(function (t) { obsG.appendChild(mk('div', 'wxs-hint', t)); });
    secGroup.appendChild(obsG);
    body.appendChild(secGroup);

    // ---------- 语音 / 表情 ----------
    var secVoice = mk('div', 'wxs-sec');
    secVoice.appendChild(mk('div', 'wxs-sec-title', '语音'));
    secVoice.appendChild(mk('div', 'wxs-sec-hint', '语音出站有三条：群随机接话、普通 @、私聊。三条都默认关；打开后按各自概率决定，不会默认制造语音噪音。'));

    secVoice.appendChild(switchRow('语音回复总开关', '关闭后所有语音出站都不发；正文仍正常发。', form.media.voiceReply, function (v) { form.media.voiceReply = v; }).row);
    secVoice.appendChild(switchRow('群随机接话带语音', '只影响群随机接话；打开后按下面概率把正文合成为语音。', form.media.voiceReplyGroups, function (v) { form.media.voiceReplyGroups = v; }).row);
    secVoice.appendChild(numRow('群随机语音概率', '群随机接话转成语音的比例。', form.media.voiceReplyChancePct, 0, 100, 0.1, '%', function (v) { form.media.voiceReplyChancePct = num(v, 0, 0, 100, 0.1); }).row);
    secVoice.appendChild(switchRow('普通 @ 直接语音', '普通群里被 @ 时，正文发完后按概率补一条语音。', form.media.voiceReplyMentions, function (v) { form.media.voiceReplyMentions = v; }).row);
    secVoice.appendChild(numRow('@ 语音概率', '@ 回复补语音的比例。', form.media.voiceReplyMentionsChancePct, 0, 100, 0.1, '%', function (v) { form.media.voiceReplyMentionsChancePct = num(v, 100, 0, 100, 0.1); }).row);
    secVoice.appendChild(switchRow('私聊直接语音', '私聊回复时，正文发完后按概率补一条语音。', form.media.voiceReplyPrivate, function (v) { form.media.voiceReplyPrivate = v; }).row);
    secVoice.appendChild(numRow('私聊语音概率', '私聊回复补语音的比例。', form.media.voiceReplyPrivateChancePct, 0, 100, 0.1, '%', function (v) { form.media.voiceReplyPrivateChancePct = num(v, 100, 0, 100, 0.1); }).row);
    secVoice.appendChild(numRow('语音字数上限', '超过就截断，避免一条语音太长。', form.media.voiceMaxChars, 10, 180, 1, '字', function (v) { form.media.voiceMaxChars = num(v, 80, 10, 180); }).row);
    secVoice.appendChild(switchRow('群旁听语音转写', '开：群里语音先转成文字再进旁听上下文；关：只留 [语音] 占位。', form.media.voiceListen, function (v) { form.media.voiceListen = v; }).row);

    var subTts = mk('div', 'wxs-subsec');
    subTts.appendChild(mk('div', 'wxs-subsec-title', '语音合成服务'));
    subTts.appendChild(mk('div', 'wxs-subsec-hint', 'QQ 和微信原生语音共用这一份 Breeze 配置；Key 只存在本机，界面只显示末尾四位。'));
    subTts.appendChild(selectRow('使用', 'BreezeBlue 是云端合成；Windows SAPI 是本机备选。', form.media.ttsProvider,
      [['sapi', 'Windows SAPI（本地）'], ['breeze', 'BreezeBlue（云端）']], function (v) { form.media.ttsProvider = v === 'breeze' ? 'breeze' : 'sapi'; renderSum(); }).row);
    subTts.appendChild(inputRow('Breeze API Key', '留空 = 不改已保存的 Key；不要把 Key 发到聊天里。', '',
      (mediaStatus && mediaStatus.tts && mediaStatus.tts.breeze && mediaStatus.tts.breeze.keyConfigured)
        ? ('已配置（' + ((mediaStatus.tts.breeze.keyMasked) || '••••') + '）；留空不改')
        : 'brz_...', 'password', false, function (v) { form.media.breezeApiKey = String(v || ''); }).row);
    subTts.appendChild(inputRow('音色 ID', 'Breeze 控制台的 voice_id。', form.media.breezeVoiceId, 'voc_...', 'text', false, function (v) { form.media.breezeVoiceId = String(v || ''); }).row);
    subTts.appendChild(inputRow('音色名称', '只用于界面识别，不发给服务端。', form.media.breezeVoiceName, '例如 大肥鱼（迷糊版）', 'text', false, function (v) { form.media.breezeVoiceName = String(v || ''); }).row);
    subTts.appendChild(inputRow('演绎指令', '用中文写语气、节奏和情绪；每次请求都会带上。', form.media.breezeInstructions, '用饭团的语气……', 'text', true, function (v) { form.media.breezeInstructions = String(v || ''); }).row);
    subTts.appendChild(switchRow('Breeze 失败回退 SAPI', 'Breeze 超时/额度不足时改走本机 SAPI；仍失败就只发正文。', form.media.breezeFallback, function (v) { form.media.breezeFallback = v; }).row);

    var action = mk('div', 'wxs-action-bar');
    var testText = mk('input', 'wxs-in');
    testText.placeholder = '试音文字，默认：你好，我是饭团';
    testText.maxLength = 80;
    testText.style.width = '220px';
    action.appendChild(testText);
    var testBtn = mk('button', 'wxs-btn wxs-mini', '试音');
    testBtn.type = 'button';
    testBtn.title = '使用已保存配置生成一条试音，只落本地，不发送到任何 QQ 聊天；先保存再试音';
    testBtn.addEventListener('click', function () {
      if (!mediaApi || typeof mediaApi.ttsTest !== 'function') { toast('试音接口没接上：重启一次工作台', true); return; }
      if (dirtyCount()) { toast('先保存当前 QQ 设置，再试音；试音读的是已保存配置', true); return; }
      testBtn.disabled = true;
      Promise.resolve(mediaApi.ttsTest({ text: String(testText.value || '').trim() || '你好，我是饭团。' })).then(function (r) {
        testBtn.disabled = false;
        if (!r || r.ok === false) toast('试音失败：' + ((r && r.error) || '主进程没返回'), true, 10000);
        else toast('试音成功：' + (r.provider || '') + ' · ' + (r.bytes || 0) + 'B' + (r.silk ? ' · SILK' : ' · WAV'));
      }).catch(function (e) {
        testBtn.disabled = false;
        toast('试音失败：' + String((e && e.message) || e), true, 10000);
      });
    });
    action.appendChild(testBtn);
    var syncBtn = mk('button', 'wxs-btn wxs-mini', '同步到微信原生语音');
    syncBtn.type = 'button';
    syncBtn.title = '把已保存的 Breeze Key / 音色 / 指令写入 WhaleLauncher；先保存上面的配置再同步';
    syncBtn.addEventListener('click', function () {
      var wx = window.app && window.app.wechat;
      if (!wx || typeof wx.syncBreeze !== 'function') { toast('微信语音同步入口没接上：重启一次工作台', true); return; }
      if (dirtyCount()) { toast('先保存当前 QQ 设置，再同步；同步读的是已保存配置', true); return; }
      syncBtn.disabled = true;
      Promise.resolve(wx.syncBreeze()).then(function (r) {
        syncBtn.disabled = false;
        if (!r || r.ok === false) toast('同步失败：' + ((r && r.error) || '主进程没返回'), true, 10000);
        else toast('微信原生语音已同步：' + (r.provider || 'breezeblue') + ' · ' + (r.voiceId || ''));
      }).catch(function (e) {
        syncBtn.disabled = false;
        toast('同步失败：' + String((e && e.message) || e), true, 10000);
      });
    });
    action.appendChild(syncBtn);
    subTts.appendChild(action);
    secVoice.appendChild(subTts);

    // 媒体观察：表情包图库数量、Breeze 最近一次成功/失败、直接语音最近一次。
    var obsM = mk('div', 'wxs-subsec');
    obsM.appendChild(mk('div', 'wxs-subsec-title', '当前观察（只读）'));
    var mst = mediaStatus || {};
    var breeze = (mst.tts && mst.tts.breeze) || {};
    var direct = (mst.directVoice && mst.directVoice.last) || null;
    var linesM = [
      'Breeze：' + (breeze.configured ? '已配置' : '未配置')
        + ' · 音色 ' + (breeze.voiceName || breeze.voiceId || '—')
        + ' · 最近 ' + (breeze.last && breeze.last.at
          ? (timeText(breeze.last.at) + (breeze.last.ok ? ' 成功 ' + Number(breeze.last.bytes || 0) + 'B' : ' 失败：' + (breeze.last.error || '未知')))
          : '还没有合成记录'),
      '直接语音最近：' + (direct && direct.at
        ? (timeText(direct.at) + ' · ' + (direct.ok ? '成功' : ('失败：' + (direct.error || '未知')))
          + ' · ' + (direct.chatType === 'group' ? '群' : '私聊') + ' ' + (direct.chatId || '—')
          + ' · ' + (direct.provider || '—') + ' · ' + Number(direct.bytes || 0) + 'B')
        : '还没有正文后补语音记录')
    ];
    linesM.forEach(function (t) { obsM.appendChild(mk('div', 'wxs-hint', t)); });
    secVoice.appendChild(obsM);
    body.appendChild(secVoice);

    var foot = mk('div', 'wxs-foot');
    var fh = mk('div', 'wxs-fh', '没有未保存修改');
    foot.appendChild(fh);
    var discard = mk('button', 'wxs-btn', '放弃修改');
    discard.type = 'button';
    var save = mk('button', 'wxs-btn is-primary', '保存设置');
    save.type = 'button';
    var closeBtn = mk('button', 'wxs-btn', '关闭');
    closeBtn.type = 'button';
    foot.appendChild(discard);
    foot.appendChild(save);
    foot.appendChild(closeBtn);
    dlg.appendChild(foot);

    function renderTabs() {
      tabDefs.forEach(function (t) { tabBtns[t[0]].classList.toggle('is-on', t[0] === activeTab); });
      secGroup.classList.toggle('is-on', activeTab === 'group');
      secVoice.classList.toggle('is-on', activeTab === 'voice');
    }
    function renderSum() {
      sum.innerHTML = '';
      function pill(text, cls) { sum.appendChild(mk('span', 'wxs-pill ' + (cls || ''), text)); }
      pill('群随机：' + (form.group.freeChat ? '开' : '关'), form.group.freeChat ? 'is-ok' : '');
      pill('语音总开关：' + (form.media.voiceReply ? '开' : '关'), form.media.voiceReply ? 'is-ok' : 'is-bad');
      pill('群语音：' + (form.media.voiceReplyGroups ? '开' : '关'), form.media.voiceReplyGroups ? 'is-warn' : '');
      pill('@ 语音：' + (form.media.voiceReplyMentions ? '开' : '关'), form.media.voiceReplyMentions ? 'is-warn' : '');
      pill('私聊语音：' + (form.media.voiceReplyPrivate ? '开' : '关'), form.media.voiceReplyPrivate ? 'is-warn' : '');
      pill('合成：' + (form.media.ttsProvider === 'breeze' ? 'BreezeBlue' : 'SAPI'), form.media.ttsProvider === 'breeze' ? 'is-ok' : '');
    }
    function dirtyCount() {
      return JSON.stringify(form.group) === JSON.stringify(baseGroup) && JSON.stringify(form.media) === JSON.stringify(baseMedia)
        ? 0 : 1;
    }
    function refreshDirty() {
      var n = dirtyCount();
      fh.textContent = n ? '有未保存修改' : '没有未保存修改';
      fh.classList.toggle('is-dirty', !!n);
      discard.disabled = saving || !n;
      save.disabled = saving || !n;
      save.textContent = saving ? '保存中…' : '保存设置';
    }
    function close() {
      if (saving || closed) return;
      if (dirtyCount() && !window.confirm('有未保存的修改，确定放弃并关闭？')) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      try { mask.remove(); } catch (e) { console.warn('[qq-reply] 弹窗移除失败', e); }
    }
    function onKey(e) {
      if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); e.stopPropagation(); close(); }
    }

    function groupPayload() {
      return {
        freeChat: form.group.freeChat,
        chancePct: form.group.chancePct,
        engagedMinutes: form.group.engagedMinutes,
        silentMinutes: form.group.silentMinutes,
        cooldownSec: form.group.cooldownSec,
        maxRepliesPerMinute: form.group.maxRepliesPerMinute,
        maxChars: form.group.maxChars,
        addressGuard: form.group.addressGuard
      };
    }
    function mediaPayload() {
      return {
        enabled: form.media.enabled,
        voice: form.media.voice,
        voiceListen: form.media.voiceListen,
        voiceReply: form.media.voiceReply,
        voiceReplyGroups: form.media.voiceReplyGroups,
        voiceReplyChancePct: form.media.voiceReplyChancePct,
        voiceReplyMentions: form.media.voiceReplyMentions,
        voiceReplyMentionsChancePct: form.media.voiceReplyMentionsChancePct,
        voiceReplyPrivate: form.media.voiceReplyPrivate,
        voiceReplyPrivateChancePct: form.media.voiceReplyPrivateChancePct,
        voiceMaxChars: form.media.voiceMaxChars,
        stickers: form.media.stickers,
        stickerChancePct: form.media.stickerChancePct,
        stickerMaxPerReply: form.media.stickerMaxPerReply,
        stickerDynamic: form.media.stickerDynamic,
        ttsProvider: form.media.ttsProvider,
        ttsVoice: form.media.ttsVoice,
        breezeApiKey: form.media.breezeApiKey,
        breezeVoiceId: form.media.breezeVoiceId,
        breezeVoiceName: form.media.breezeVoiceName,
        breezeModel: form.media.breezeModel,
        breezeLanguage: form.media.breezeLanguage,
        breezeBaseUrl: form.media.breezeBaseUrl,
        breezeInstructions: form.media.breezeInstructions,
        breezeFallback: form.media.breezeFallback
      };
    }
    function saveAll() {
      if (saving || !dirtyCount()) return;
      var notes = [];
      if (!baseGroup.freeChat && form.group.freeChat) notes.push('打开群随机接话后，她可能在没有叫她的群里插话。');
      if (!baseMedia.voiceReplyGroups && form.media.voiceReplyGroups) notes.push('打开群随机语音后，群里会出现语音消息。');
      if (!baseMedia.voiceReplyPrivate && form.media.voiceReplyPrivate) notes.push('打开私聊语音后，私聊回复可能变成语音。');
      if (!baseMedia.voiceReplyMentions && form.media.voiceReplyMentions) notes.push('打开普通 @ 语音后，群 @ 回复可能补发语音。');
      if (notes.length && !window.confirm(notes.join('\n\n'))) return;
      saving = true;
      refreshDirty();
      var p = [];
      if (JSON.stringify(form.group) !== JSON.stringify(baseGroup)) p.push(Promise.resolve(groupApi.settingsSave(groupPayload())));
      if (JSON.stringify(form.media) !== JSON.stringify(baseMedia)) p.push(Promise.resolve(mediaApi.settingsSave(mediaPayload())));
      Promise.all(p).then(function (rs) {
        saving = false;
        var bad = rs.find(function (r) { return r && r.ok === false; });
        if (bad) {
          toast('保存失败：' + (bad.error || '主进程没返回'), true, 10000);
          refreshDirty();
          return;
        }
        baseGroup = clone(form.group);
        baseMedia = clone(form.media);
        baseMedia.breezeApiKey = '';
        form.media.breezeApiKey = '';
        save.disabled = true;
        refreshDirty();
        toast('QQ 回复设置已保存；下一轮消息生效');
      }).catch(function (e) {
        saving = false;
        toast('保存失败：' + String((e && e.message) || e), true, 10000);
        refreshDirty();
      });
    }

    discard.addEventListener('click', function () {
      if (saving) return;
      // 放弃修改 = 回到磁盘上的值。直接重开一次弹窗，避免表单控件和 form 对象不同步；
      // 这里不再弹「未保存」确认，因为用户点的是明确的放弃。
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      try { mask.remove(); } catch (e) { console.warn('[qq-reply] 放弃时移除弹窗失败', e); }
      toast('已放弃未保存修改');
      Promise.resolve(window.openQqReplySettings()).catch(function () {});
    });
    save.addEventListener('click', saveAll);
    closeBtn.addEventListener('click', close);
    x.addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey, true);

    renderTabs();
    renderSum();
    refreshDirty();
    // 表单改动只更新摘要和「未保存」计数；不写盘、不重启。输入框事件冒泡到 body 即可。
    body.addEventListener('input', function () { renderSum(); refreshDirty(); });
    body.addEventListener('change', function () { renderSum(); refreshDirty(); });
    document.body.appendChild(mask);
    try { closeBtn.focus(); } catch (e) { console.warn('[qq-reply] 初始焦点失败', e); }
    return true;
  }

  window.openQqReplySettings = function () {
    if (!mediaApi || typeof mediaApi.status !== 'function' || !groupApi || typeof groupApi.status !== 'function') {
      toast('QQ 回复设置没接上：主进程/preload 还是旧的，重启一次工作台。', true, 10000);
      return Promise.resolve(false);
    }
    if (document.querySelector('.wxs-mask')) {
      toast('已有一个通道设置弹窗打开，先关掉它再开 QQ 回复设置', true);
      return Promise.resolve(false);
    }
    return Promise.all([mediaApi.status(), groupApi.status()]).then(function (rs) {
      var m = rs && rs[0];
      var g = rs && rs[1];
      if (!m || m.ok === false) { toast('读不到 QQ 语音/表情设置：' + ((m && m.error) || '未知原因'), true, 10000); return false; }
      if (!g || g.ok === false) { toast('读不到 QQ 群聊设置：' + ((g && g.error) || '未知原因'), true, 10000); return false; }
      return build(m, g);
    }).catch(function (e) {
      toast('读不到 QQ 回复设置：' + String((e && e.message) || e), true, 10000);
      return false;
    });
  };
})();
