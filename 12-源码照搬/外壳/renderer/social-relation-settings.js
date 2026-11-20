'use strict';
// 关系与情绪设置（2026-11-20）
//
// 反黑盒约定：
//   · 入口常驻在社交通道标题行，文字按钮「关系与情绪」，不藏齿轮 / 右键 / 长弹层；
//   · 每个人的熟悉度、好感、档位、事件、来源都能看见；滑块改的是手动值，可一键解锁回自动；
//   · 所有规则参数（初始值、熟悉 / 好感 / 情绪三条曲线、群接话系数）都在「规则」页可改；
//   · 「预览」页显示下一轮模型实际会看到的关系卡，字数和人数都写出来；
//   · 不改人格底线：这里只调表达，不提供「骂人 / 无视正事 / 越过安全规则」的开关。

(function () {
  var api = window.app && window.app.social;

  function toast(msg, bad, ms) {
    try {
      if (typeof window.__tbsToast === 'function') {
        window.__tbsToast(msg, !!bad, ms || (bad ? 8000 : 3000));
        return;
      }
    } catch (e) { console.warn('[social-relation] 顶栏通知不可用', e); }
    try { console.log('[social-relation] ' + msg); } catch (e2) { console.warn('[social-relation] 日志不可用', e2); }
  }

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function num(v, dflt, lo, hi) {
    var n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function fmtNum(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return '0';
    return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
  }

  function fmtAff(v) {
    var n = Number(v) || 0;
    return (n >= 0 ? '+' : '') + fmtNum(n);
  }

  function hhmm(ts) {
    var n = Number(ts);
    if (!n) return '还没有';
    try {
      return new Date(n).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return new Date(n).toLocaleString(); }
  }

  function channelName(k) {
    return ({ wechat: '微信', qq: 'QQ', feishu: '飞书' })[String(k || '')] || String(k || '其他');
  }

  function stageClass(key) {
    if (key === 'hate') return 'is-bad';
    if (key === 'cold') return 'is-warn';
    if (key === 'inner') return 'is-ok';
    return '';
  }

  function parseChat(chatKey) {
    var m = /^([^:]+):(private|group):(.*)$/.exec(String(chatKey || ''));
    if (!m) return null;
    return { channel: m[1], chatType: m[2], chatId: m[3] };
  }

  function build(data) {
    if (!data || data.ok === false) throw new Error((data && data.error) || '读不到关系数据');

    var state = {
      tab: 'people',
      filter: '',
      openKey: '',
      deleteKey: '',
      dirty: false,
      draft: clone(data.config || {}),
      data: data
    };

    var mask = mk('div', 'wxs-mask');
    mask.dataset.socialRelation = '1';
    var dlg = mk('div', 'wxs-dlg');
    dlg.style.width = 'min(940px, 96vw)';
    mask.appendChild(dlg);

    function close() {
      if (state.dirty && !window.confirm('还有没保存的修改，关掉就丢了。确定关闭？')) return;
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey);

    var head = mk('div', 'wxs-head');
    var hw = mk('div', 'wxs-hw');
    hw.appendChild(mk('div', 'wxs-title', '关系与情绪 · 内部状态'));
    hw.appendChild(mk('div', 'wxs-sub', '对每个人的熟悉度 / 好感，和她自己此刻的情绪；只调表达，不改事实、边界和安全规则。所有人可见、可改。'));
    head.appendChild(hw);
    var x = mk('button', 'wxs-x', '✕');
    x.type = 'button';
    x.title = '关闭（有未保存修改会先确认）';
    x.addEventListener('click', close);
    head.appendChild(x);
    dlg.appendChild(head);

    var sum = mk('div', 'wxs-sum');
    dlg.appendChild(sum);

    var tabs = mk('div', 'wxs-tabs');
    dlg.appendChild(tabs);
    var tabDefs = [
      ['people', '关系'],
      ['mood', '情绪'],
      ['rules', '规则'],
      ['preview', '预览']
    ];
    tabDefs.forEach(function (t) {
      var b = mk('button', 'wxs-tab', t[1]);
      b.type = 'button';
      b.dataset.tab = t[0];
      b.addEventListener('click', function () {
        if (state.tab === t[0]) return;
        if (state.dirty && !window.confirm('当前页还有没保存的修改，切走就丢了。确定切换？')) return;
        state.tab = t[0];
        state.dirty = false;
        state.draft = clone(state.data.config || {});
        render();
      });
      tabs.appendChild(b);
    });

    var body = mk('div', 'wxs-body');
    dlg.appendChild(body);

    var foot = mk('div', 'wxs-foot');
    var fh = mk('div', 'wxs-fh', '保存后下一轮生效；不重启通道、不重启引擎。');
    foot.appendChild(fh);
    var seedBtn = mk('button', 'wxs-btn', '重建档案');
    seedBtn.type = 'button';
    seedBtn.title = '按聊天档案的消息数 / 互动天数重算熟悉度；好感、标签、备注都保留';
    seedBtn.addEventListener('click', function () {
      if (!api || typeof api.relationSeed !== 'function') { toast('接口没接上：重启一次工作台', true); return; }
      if (!window.confirm('会按聊天档案重算熟悉度（消息数 × 权重 + 互动天数 × 权重）。\n好感、标签、备注、手动锁定都保留。继续？')) return;
      seedBtn.disabled = true;
      Promise.resolve(api.relationSeed({})).then(function (r) {
        seedBtn.disabled = false;
        if (!r || r.ok === false) { toast('重建失败：' + String((r && r.error) || '未知原因'), true); return; }
        toast('已重建：' + Number(r.chats || 0) + ' 个聊天 / ' + Number(r.people || 0) + ' 人（新增 ' + Number(r.created || 0) + '）', false, 5000);
        reload();
      }).catch(function (e) {
        seedBtn.disabled = false;
        toast('重建失败：' + String((e && e.message) || e), true);
      });
    });
    foot.appendChild(seedBtn);

    var patrolBtn = mk('button', 'wxs-btn', '巡检');
    patrolBtn.type = 'button';
    patrolBtn.title = '重算熟悉度 + 写回当前档位 + 让情绪按半衰期回落';
    patrolBtn.addEventListener('click', function () {
      if (!api || typeof api.relationPatrol !== 'function') { toast('接口没接上：重启一次工作台', true); return; }
      patrolBtn.disabled = true;
      Promise.resolve(api.relationPatrol()).then(function (r) {
        patrolBtn.disabled = false;
        if (!r || r.ok === false) { toast('巡检失败：' + String((r && r.error) || '未知原因'), true); return; }
        toast('巡检完成；心情 ' + String((r.mood && r.mood.label) || '') + '（' + Number((r.mood && r.mood.intensity) || 0) + '/100）', false, 4000);
        reload();
      }).catch(function (e) {
        patrolBtn.disabled = false;
        toast('巡检失败：' + String((e && e.message) || e), true);
      });
    });
    foot.appendChild(patrolBtn);

    var cancel = mk('button', 'wxs-btn', '关闭');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    foot.appendChild(cancel);
    dlg.appendChild(foot);

    function reload(silent) {
      return Promise.resolve(api.relationGet()).then(function (d) {
        if (!d || d.ok === false) throw new Error((d && d.error) || '读不到关系数据');
        state.data = d;
        state.draft = clone(d.config || {});
        state.dirty = false;
        render();
        if (!silent) fh.textContent = '已刷新；保存后下一轮生效。';
        fh.className = 'wxs-fh';
      }).catch(function (e) {
        fh.textContent = '刷新失败';
        fh.className = 'wxs-fh is-err';
        toast('刷新失败：' + String((e && e.message) || e), true);
      });
    }

    function render() {
      var d = state.data;
      sum.innerHTML =
        '<span class="wxs-pill ' + (d.config.inject ? 'is-ok' : 'is-bad') + '">注入：' + (d.config.inject ? '开' : '关') + '</span>' +
        '<span class="wxs-pill">人数 ' + Number((d.people || []).length) + '</span>' +
        '<span class="wxs-pill">聊天 ' + Number((d.chats || []).length) + '</span>' +
        '<span class="wxs-pill ' + (d.mood && d.mood.visible ? 'is-warn' : '') + '">心情：' + String((d.mood && d.mood.label) || '平静') +
          (d.mood && d.mood.visible ? ' ' + Number(d.mood.intensity) + '/100' : '') + '</span>' +
        '<span class="wxs-pill ' + (d.config.modelNotesEnabled ? 'is-ok' : 'is-warn') + '">模型事件：' + (d.config.modelNotesEnabled ? '开' : '关') + '</span>' +
        '<span class="wxs-pill">群接话系数：' + (d.config.groupBiasEnabled ? '开' : '关') + '</span>';
      tabs.querySelectorAll('.wxs-tab').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.tab === state.tab);
      });
      body.innerHTML = '';
      if (state.tab === 'people') renderPeople();
      else if (state.tab === 'mood') renderMood();
      else if (state.tab === 'rules') renderRules();
      else renderPreview();
    }

    function markDirty() {
      state.dirty = true;
      fh.textContent = '有未保存修改；点本页保存才写盘。';
      fh.className = 'wxs-fh is-dirty';
    }

    function section(title, hint) {
      var s = mk('div', 'wxs-sec is-on');
      s.appendChild(mk('div', 'wxs-sec-title', title));
      if (hint) s.appendChild(mk('div', 'wxs-sec-hint', hint));
      return s;
    }

    // 配置允许嵌套（curves.familiarity.*）；点号路径读写，避免面板只能改顶层 key。
    function readPath(obj, key) {
      var parts = String(key || '').split('.');
      var cur = obj;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    }
    function writePath(obj, key, value) {
      var parts = String(key || '').split('.');
      var cur = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }

    function numRow(label, hint, obj, key, lo, hi, step, unit) {
      var row = mk('div', 'wxs-row');
      var lw = mk('div', 'wxs-lab-wrap');
      lw.appendChild(mk('div', 'wxs-lab', label));
      if (hint) lw.appendChild(mk('div', 'wxs-hint', hint));
      row.appendChild(lw);
      var cw = mk('div', 'wxs-ctrl');
      var input = mk('input', 'wxs-num');
      input.type = 'number';
      input.min = String(lo); input.max = String(hi); input.step = String(step);
      var current = readPath(obj, key);
      input.value = String(current === undefined ? '' : current);
      input.addEventListener('input', function () {
        var old = readPath(obj, key);
        writePath(obj, key, num(input.value, old, lo, hi));
        markDirty();
      });
      cw.appendChild(input);
      if (unit) cw.appendChild(mk('span', 'wxs-unit', unit));
      row.appendChild(cw);
      return row;
    }

    function switchRow(label, hint, obj, key) {
      var row = mk('div', 'wxs-row');
      var lw = mk('div', 'wxs-lab-wrap');
      lw.appendChild(mk('div', 'wxs-lab', label));
      if (hint) lw.appendChild(mk('div', 'wxs-hint', hint));
      row.appendChild(lw);
      var cw = mk('div', 'wxs-ctrl');
      var sw = mk('label', 'wxs-switch');
      var cb = mk('input');
      cb.type = 'checkbox';
      cb.checked = obj[key] !== false;
      cb.addEventListener('change', function () { obj[key] = !!cb.checked; markDirty(); });
      sw.appendChild(cb);
      sw.appendChild(mk('span', 'wxs-slider'));
      cw.appendChild(sw);
      row.appendChild(cw);
      return row;
    }

    // 主人 / 称呼这类是文本，不是数字；单独做一行，保存时仍走同一个 config。
    function textRow(label, hint, obj, key, placeholder, maxLen) {
      var row = mk('div', 'wxs-row');
      var lw = mk('div', 'wxs-lab-wrap');
      lw.appendChild(mk('div', 'wxs-lab', label));
      if (hint) lw.appendChild(mk('div', 'wxs-hint', hint));
      row.appendChild(lw);
      var cw = mk('div', 'wxs-ctrl');
      var input = mk('input', 'wxs-num');
      input.type = 'text';
      input.maxLength = maxLen || 40;
      input.style.width = '220px';
      input.placeholder = placeholder || '';
      input.value = String(obj[key] === undefined ? '' : obj[key]);
      input.addEventListener('input', function () { obj[key] = input.value.trim(); markDirty(); });
      cw.appendChild(input);
      row.appendChild(cw);
      return row;
    }

    function listRow(label, hint, obj, key, placeholder) {
      var row = mk('div', 'wxs-row');
      var lw = mk('div', 'wxs-lab-wrap');
      lw.appendChild(mk('div', 'wxs-lab', label));
      if (hint) lw.appendChild(mk('div', 'wxs-hint', hint));
      row.appendChild(lw);
      var cw = mk('div', 'wxs-ctrl');
      var input = mk('input', 'wxs-num');
      input.type = 'text';
      input.style.width = '260px';
      input.placeholder = placeholder || '';
      input.value = (Array.isArray(obj[key]) ? obj[key] : []).join('|');
      input.addEventListener('input', function () {
        obj[key] = input.value.split(/[|,，]/).map(function (x) { return String(x || '').trim(); }).filter(Boolean).slice(0, 12);
        markDirty();
      });
      cw.appendChild(input);
      row.appendChild(cw);
      return row;
    }

    // 情绪联动表：9 个标签 × 6 个通道参数，全部在这里改；不在代码里藏第二套默认值。
    function moodEffectTable(c) {
      var sec = section('情绪联动表', '每个标签对回复的实际影响；字/句 0 表示不额外限长，系数 0 表示不发，1 表示不改变原通道概率。改完点本页「保存规则」。');
      if (!c.moodEffects || typeof c.moodEffects !== 'object') c.moodEffects = {};
      var labels = state.data.moodLabels || ['平静', '开心', '兴奋', '得意', '低落', '委屈', '烦躁', '疲惫', '心虚'];
      var table = mk('table', 'wxs-mood-table');
      var head = mk('thead');
      var hr = mk('tr');
      ['情绪', '字数上限', '句数上限', 'emoji 权重', '贴纸权重', '语音权重', '群接话权重'].forEach(function (t) {
        hr.appendChild(mk('th', '', t));
      });
      head.appendChild(hr);
      table.appendChild(head);
      var tb = mk('tbody');
      labels.forEach(function (label) {
        var e = c.moodEffects[label];
        if (!e || typeof e !== 'object') {
          e = { maxChars: 0, maxSentences: 0, emojiFactor: 1, stickerFactor: 1, voiceFactor: 1, groupFactor: 1 };
          c.moodEffects[label] = e;
        }
        var tr = mk('tr');
        tr.appendChild(mk('td', 'wxs-mood-name', label));
        function cell(key, lo, hi, step) {
          var td = mk('td');
          var input = mk('input', 'wxs-num is-mini');
          input.type = 'number';
          input.min = String(lo); input.max = String(hi); input.step = String(step);
          input.value = String(e[key] === undefined ? (key.indexOf('Factor') >= 0 ? 1 : 0) : e[key]);
          input.addEventListener('input', function () {
            e[key] = num(input.value, e[key], lo, hi);
            markDirty();
          });
          td.appendChild(input);
          return td;
        }
        tr.appendChild(cell('maxChars', 0, 300, 1));
        tr.appendChild(cell('maxSentences', 0, 10, 1));
        tr.appendChild(cell('emojiFactor', 0, 2, 0.1));
        tr.appendChild(cell('stickerFactor', 0, 2, 0.1));
        tr.appendChild(cell('voiceFactor', 0, 2, 0.1));
        tr.appendChild(cell('groupFactor', 0, 2, 0.1));
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      sec.appendChild(table);
      sec.appendChild(mk('div', 'wxs-note', '语音权重只乘在「主动发语音」的概率上；对方明确要求语音仍优先。负向情绪默认不发贴纸、不发语音、少接话。'));
      return sec;
    }

    // ---------- 关系 ----------
    function renderPeople() {
      var d = state.data;
      var filterBar = mk('div', 'wxs-sum');
      filterBar.style.margin = '0 0 10px';
      var lab = mk('span', 'wxs-hint', '聊天：');
      filterBar.appendChild(lab);
      var sel = mk('select', 'wxs-select');
      var optAll = mk('option', '', '全部聊天');
      optAll.value = '';
      sel.appendChild(optAll);
      (d.chats || []).forEach(function (c) {
        var o = mk('option', '', c.label + '（' + c.count + ' 人）');
        o.value = c.chatKey;
        sel.appendChild(o);
      });
      sel.value = state.filter;
      sel.addEventListener('change', function () { state.filter = sel.value; state.openKey = ''; render(); });
      filterBar.appendChild(sel);
      filterBar.appendChild(mk('span', 'wxs-hint', '点心人展开编辑；滑块一改就是手动锁定值，点「解锁」回到自动统计。'));
      body.appendChild(filterBar);

      var groups = {};
      (d.people || []).forEach(function (p) {
        if (state.filter && p.chatKey !== state.filter) return;
        if (!groups[p.chatKey]) groups[p.chatKey] = [];
        groups[p.chatKey].push(p);
      });
      var chatOrder = (d.chats || []).map(function (c) { return c.chatKey; });
      Object.keys(groups).sort(function (a, b) {
        var ai = chatOrder.indexOf(a); var bi = chatOrder.indexOf(b);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      }).forEach(function (chatKey) {
        var meta = (d.chats || []).filter(function (c) { return c.chatKey === chatKey; })[0] || { label: chatKey, count: groups[chatKey].length, averageFamiliarity: 0, averageAffinity: 0 };
        var sec = section(meta.label + ' · ' + meta.count + ' 人', '平均熟悉 ' + meta.averageFamiliarity + ' / 平均好感 ' + fmtAff(meta.averageAffinity) + '；群接话只受熟悉度和好感的小幅加权，不吃掉通道原概率。');
        groups[chatKey].forEach(function (p) {
          sec.appendChild(personCard(p));
        });
        body.appendChild(sec);
      });
      if (!Object.keys(groups).length) {
        var empty = section('还没有关系档案', '先点底部「重建档案」：按聊天档案的消息数和互动天数建；也可以在下面手动给某个人建档。');
        body.appendChild(empty);
      }

      // 手动建档：聊天键 + 名字；避免只能从档案里等人出现
      var addSec = section('手动建档 / 补录', '用于飞书等没有聊天档案的通道，或档案里还没出现的人。建档按规则页的初始值开始；名字命中主人别名会直接按主人初始值。');
      var addRow = mk('div', 'wxs-row');
      var al = mk('div', 'wxs-lab-wrap');
      al.appendChild(mk('div', 'wxs-lab', '聊天键 + 名字'));
      al.appendChild(mk('div', 'wxs-hint', '格式 channel:private|group:chatId，例 qq:group:123；名字写对方在群里的显示名。'));
      addRow.appendChild(al);
      var ac = mk('div', 'wxs-ctrl');
      var keyIn = mk('input', 'wxs-num');
      keyIn.style.width = '230px';
      keyIn.placeholder = 'qq:group:123';
      var nameIn = mk('input', 'wxs-num');
      nameIn.style.width = '100px';
      nameIn.placeholder = '对方名字';
      var addBtn = mk('button', 'wxs-btn', '建档');
      addBtn.type = 'button';
      addBtn.addEventListener('click', function () {
        if (!parseChat(keyIn.value)) { toast('聊天键格式应为 channel:private|group:chatId', true); return; }
        if (!String(nameIn.value || '').trim()) { toast('名字不能为空', true); return; }
        addBtn.disabled = true;
        Promise.resolve(api.relationSavePerson({ chatKey: keyIn.value.trim(), name: nameIn.value.trim() })).then(function (r) {
          addBtn.disabled = false;
          if (!r || r.ok === false) { toast('建档失败：' + String((r && r.error) || '未知原因'), true); return; }
          toast('已建档：' + (r.person && r.person.name ? r.person.name : nameIn.value), false, 3000);
          reload();
        }).catch(function (e) {
          addBtn.disabled = false;
          toast('建档失败：' + String((e && e.message) || e), true);
        });
      });
      ac.appendChild(keyIn); ac.appendChild(nameIn); ac.appendChild(addBtn);
      addRow.appendChild(ac);
      addSec.appendChild(addRow);
      body.appendChild(addSec);
    }

    function personCard(p) {
      var st = p.stage || {};
      var open = state.openKey === p.key;
      var shown = p.preferredName || p.name || p.senderId || '无名';
      var card = mk('div', 'wxs-person');
      var head = mk('div', 'wxs-person-head');
      head.appendChild(mk('span', 'wxs-person-name', shown));
      head.appendChild(mk('span', 'wxs-pill ' + stageClass(st.key), st.label || '—'));
      head.appendChild(mk('span', 'wxs-person-meta', '熟悉 ' + fmtNum(st.familiarity) + ' · 好感 ' + fmtAff(st.affinity)));
      if (p.preferredName && p.name && p.preferredName !== p.name) {
        head.appendChild(mk('span', 'wxs-person-meta', '原名 ' + p.name));
      }
      if (p.role) head.appendChild(mk('span', 'wxs-pill is-warn', p.role));
      if (p.manual && (p.manual.familiarity !== null || p.manual.affinity !== null)) {
        head.appendChild(mk('span', 'wxs-pill is-warn', '手动锁定'));
      }
      if (p.lockUntil && p.lockUntil > Date.now()) head.appendChild(mk('span', 'wxs-pill is-bad', '严重负向 24h 锁'));
      if (p.repairUntil && p.repairUntil > Date.now()) head.appendChild(mk('span', 'wxs-pill is-warn', '修复惩罚期'));
      if (p.tags && p.tags.length) head.appendChild(mk('span', 'wxs-person-meta', p.tags.join('、')));
      var right = mk('span', 'wxs-person-meta', open ? '收起 ▲' : '展开 ▼');
      right.style.marginLeft = 'auto';
      head.appendChild(right);
      head.addEventListener('click', function () {
        if (state.dirty && !window.confirm('当前编辑还没保存，切换就丢了。继续？')) return;
        state.dirty = false;
        state.openKey = open ? '' : p.key;
        state.deleteKey = '';
        render();
      });
      card.appendChild(head);
      if (!open) return card;

      var bodyEl = mk('div', 'wxs-person-body');
      var meta = mk('div', 'wxs-note', '消息 ' + Number(p.stats.messages || 0) + ' · 互动 ' + Number(p.stats.days || 0) + ' 天 · 最近 ' + hhmm(p.stats.lastAt) +
        ' · 基础值 熟悉 ' + fmtNum(p.stage.rawFamiliarity) + ' / 好感 ' + fmtAff(p.stage.rawAffinity) +
        (p.stage.decayed && (p.stage.decayed.familiarity || p.stage.decayed.affinity) ? '（冷落衰减 -' + fmtNum(p.stage.decayed.familiarity) + ' / -' + fmtNum(p.stage.decayed.affinity) + '）' : '') +
        ' · 来源 ' + (p.manual && (p.manual.familiarity !== null || p.manual.affinity !== null) ? '手动' : '自动统计 + 事件'));
      bodyEl.appendChild(meta);
      var curveText = (p.curves || []).map(function (x) {
        return x.days + 'd ' + fmtNum(x.familiarity) + '/' + fmtAff(x.affinity);
      }).join(' · ');
      if (curveText) bodyEl.appendChild(mk('div', 'wxs-note', '未来曲线：' + curveText));

      var draft = {
        familiarity: Math.round(Number(st.familiarity) || 0),
        affinity: Math.round(Number(st.affinity) || 0),
        preferredName: p.preferredName || '',
        role: p.role || '',
        tags: (p.tags || []).join('|'),
        note: '',
        lockFamiliarity: false,
        lockAffinity: false
      };
      function sliderRow(label, hint, key, lo, hi) {
        var row = mk('div', 'wxs-row');
        var lw = mk('div', 'wxs-lab-wrap');
        lw.appendChild(mk('div', 'wxs-lab', label));
        lw.appendChild(mk('div', 'wxs-hint', hint));
        row.appendChild(lw);
        var cw = mk('div', 'wxs-ctrl');
        cw.style.maxWidth = '62%';
        var range = mk('input');
        range.type = 'range'; range.min = String(lo); range.max = String(hi); range.step = '1';
        range.value = String(draft[key]);
        range.style.width = '220px';
        var val = mk('span', 'wxs-unit', String(draft[key]));
        range.addEventListener('input', function () {
          draft[key] = Math.round(Number(range.value) || 0);
          if (key === 'familiarity') draft.lockFamiliarity = true;
          if (key === 'affinity') draft.lockAffinity = true;
          val.textContent = String(draft[key]);
          markDirty();
        });
        cw.appendChild(range); cw.appendChild(val);
        row.appendChild(cw);
        return row;
      }
      bodyEl.appendChild(sliderRow('熟悉度', '决定主动程度、能不能用昵称 / 开玩笑；0–100。只有拖动这个滑块才会手动锁定这一项。', 'familiarity', 0, 100));
      bodyEl.appendChild(sliderRow('好感', '决定耐心、热络和玩笑深度；-100–+100。只有拖动这个滑块才会手动锁定这一项。', 'affinity', -100, 100));
      bodyEl.appendChild(textRow('称呼', '发消息时模型会叫这个；留空就用原显示名。例：胡闹。', draft, 'preferredName', '胡闹', 24));
      bodyEl.appendChild(textRow('身份', '写进关系卡；例：主人。只影响称呼与表达，不改安全规则。', draft, 'role', '主人', 12));

      var tagRow = mk('div', 'wxs-row');
      var tl = mk('div', 'wxs-lab-wrap');
      tl.appendChild(mk('div', 'wxs-lab', '标签'));
      tl.appendChild(mk('div', 'wxs-hint', '用 | 分隔，最多 8 个；例：爱开玩笑|夜猫子|别催他。'));
      tagRow.appendChild(tl);
      var tc = mk('div', 'wxs-ctrl');
      var tagIn = mk('input', 'wxs-num');
      tagIn.style.width = '260px';
      tagIn.value = draft.tags;
      tagIn.addEventListener('input', function () { draft.tags = tagIn.value; markDirty(); });
      tc.appendChild(tagIn);
      tagRow.appendChild(tc);
      bodyEl.appendChild(tagRow);

      var noteRow = mk('div', 'wxs-row');
      var nl = mk('div', 'wxs-lab-wrap');
      nl.appendChild(mk('div', 'wxs-lab', '追加一条备注'));
      nl.appendChild(mk('div', 'wxs-hint', '手动备注会进档案，卡里只挑「雷点」优先展示；不要写指令性文字。'));
      noteRow.appendChild(nl);
      var nc = mk('div', 'wxs-ctrl');
      var noteIn = mk('input', 'wxs-num');
      noteIn.style.width = '260px';
      noteIn.placeholder = '例：不喜欢被问「在吗」';
      noteIn.addEventListener('input', function () { draft.note = noteIn.value; markDirty(); });
      nc.appendChild(noteIn);
      noteRow.appendChild(nc);
      bodyEl.appendChild(noteRow);

      if (p.notes && p.notes.length) {
        bodyEl.appendChild(mk('div', 'wxs-note', '已有备注：' + p.notes.map(function (n) { return '[' + n.kind + '] ' + n.text; }).join('；')));
      }
      if (p.events && p.events.length) {
        var evBox = mk('div', 'wxs-events');
        p.events.slice().reverse().forEach(function (e) {
          evBox.appendChild(mk('div', 'wxs-ev', hhmm(e.at) + ' · ' + (e.kind || '') + ' ' + (e.delta ? (e.delta > 0 ? '+' : '') + e.delta : '') +
            ' · ' + (e.source || '') + (e.applied === false ? '（未应用）' : '') + (e.reason ? ' · ' + e.reason : '')));
        });
        bodyEl.appendChild(evBox);
      }

      var btns = mk('div', 'wxs-ctrl');
      btns.style.justifyContent = 'flex-start';
      btns.style.marginTop = '8px';
      var save = mk('button', 'wxs-btn is-primary', '保存');
      save.type = 'button';
      save.addEventListener('click', function () {
        save.disabled = true;
        var payload = {
          key: p.key,
          preferredName: String(draft.preferredName || '').trim(),
          role: String(draft.role || '').trim(),
          tags: draft.tags,
          note: String(draft.note || '').trim()
        };
        if (draft.lockFamiliarity) payload.familiarity = draft.familiarity;
        if (draft.lockAffinity) payload.affinity = draft.affinity;
        Promise.resolve(api.relationSavePerson(payload)).then(function (r) {
          save.disabled = false;
          if (!r || r.ok === false) { toast('保存失败：' + String((r && r.error) || '未知原因'), true); return; }
          toast('已保存：' + shown + ' · ' + (r.stage && r.stage.label ? r.stage.label : ''), false, 3000);
          state.openKey = p.key;
          reload(true);
        }).catch(function (e) {
          save.disabled = false;
          toast('保存失败：' + String((e && e.message) || e), true);
        });
      });
      btns.appendChild(save);

      var unlock = mk('button', 'wxs-btn', '解锁回自动');
      unlock.type = 'button';
      unlock.title = '清掉手动值；熟悉度回到档案公式，好感回到事件累计';
      unlock.addEventListener('click', function () {
        unlock.disabled = true;
        Promise.resolve(api.relationSavePerson({ key: p.key, familiarity: null, affinity: null })).then(function (r) {
          unlock.disabled = false;
          if (!r || r.ok === false) { toast('解锁失败：' + String((r && r.error) || '未知原因'), true); return; }
          toast('已解锁：' + shown, false, 3000);
          reload(true);
        }).catch(function (e) {
          unlock.disabled = false;
          toast('解锁失败：' + String((e && e.message) || e), true);
        });
      });
      btns.appendChild(unlock);

      var reset = mk('button', 'wxs-btn', '重置');
      reset.type = 'button';
      reset.title = '回到默认生人值，清空标签 / 备注 / 事件；聊天记录不动';
      reset.addEventListener('click', function () {
        if (!window.confirm('重置 ' + shown + '：清空熟悉度/好感/标签/备注/事件，聊天记录不动。继续？')) return;
        Promise.resolve(api.relationResetPerson({ key: p.key })).then(function (r) {
          if (!r || r.ok === false) { toast('重置失败：' + String((r && r.error) || '未知原因'), true); return; }
          toast('已重置：' + shown, false, 3000);
          reload(true);
        }).catch(function (e) { toast('重置失败：' + String((e && e.message) || e), true); });
      });
      btns.appendChild(reset);

      var del = mk('button', 'wxs-btn', state.deleteKey === p.key ? '再点一次确认删除' : '删除档案');
      del.type = 'button';
      del.style.color = 'var(--err)';
      del.addEventListener('click', function () {
        if (state.deleteKey !== p.key) {
          state.deleteKey = p.key;
          del.textContent = '再点一次确认删除';
          del.title = '只删关系档案，不删聊天记录；再点一次才执行';
          return;
        }
        Promise.resolve(api.relationResetPerson({ key: p.key, hard: true })).then(function (r) {
          if (!r || r.ok === false) { toast('删除失败：' + String((r && r.error) || '未知原因'), true); return; }
          toast('已删除档案：' + shown + '（聊天记录没动）', false, 4000);
          state.deleteKey = '';
          state.openKey = '';
          reload(true);
        }).catch(function (e) { toast('删除失败：' + String((e && e.message) || e), true); });
      });
      btns.appendChild(del);
      bodyEl.appendChild(btns);
      card.appendChild(bodyEl);
      return card;
    }

    // ---------- 情绪 ----------
    function renderMood() {
      var d = state.data;
      var m = d.mood || {};
      var sec = section('她自己的情绪', '当前状态会按半衰期自动回平静；只影响语气长短、主动度和贴纸，不改事实与边界。');
      var box = mk('div', 'wxs-sec');
      box.style.padding = '10px 0';
      box.appendChild(mk('div', 'wxs-sec-title', m.label + ' · ' + Number(m.intensity || 0) + '/100'));
      var bar = mk('div');
      bar.style.height = '8px';
      bar.style.background = 'var(--border)';
      bar.style.borderRadius = '999px';
      bar.style.overflow = 'hidden';
      bar.style.margin = '6px 0 8px';
      var fill = mk('div');
      fill.style.height = '100%';
      fill.style.width = Math.max(0, Math.min(100, Number(m.intensity) || 0)) + '%';
      fill.style.background = (m.valence || 0) < 0 ? 'var(--warn)' : 'var(--ok)';
      bar.appendChild(fill);
      box.appendChild(bar);
      box.appendChild(mk('div', 'wxs-note', '原因：' + (m.cause || '没写原因') + ' · 来源：' + (m.source || '无') +
        ' · 剩余：' + (m.remainingMin ? (m.remainingMin + ' 分钟后回平静') : '已经平静') +
        ' · 基线强度 ' + Number(m.baseIntensity || 0) + ' / 半衰期 ' + Number(m.halfLife || 0) + ' 分钟'));
      var plan = d.moodPlan || {};
      var planLine = '本轮联动：文字 ' + (Number(plan.maxChars) ? ('≤ ' + Number(plan.maxChars) + ' 字') : '不额外限长') +
        ' · 句子 ' + (Number(plan.maxSentences) ? ('≤ ' + Number(plan.maxSentences) + ' 句') : '不限') +
        ' · emoji ×' + fmtNum(plan.emojiFactor || 0) +
        ' · 贴纸 ×' + fmtNum(plan.stickerFactor || 0) +
        ' · 语音 ×' + fmtNum(plan.voiceFactor || 0) +
        ' · 群接话 ×' + fmtNum(plan.groupFactor || 0) +
        ' · ' + (plan.stickerAllowed === false ? '不发表情包' : '可发表情包') + '/' + (plan.voiceAllowed === false ? '不发语音' : '可发语音');
      var pn = mk('div', 'wxs-note', planLine);
      pn.style.marginTop = '6px';
      box.appendChild(pn);
      sec.appendChild(box);

      var draft = { label: m.label || '平静', intensity: Math.round(Number(m.intensity) || 0), cause: m.cause || '' };
      var row1 = mk('div', 'wxs-row');
      var l1 = mk('div', 'wxs-lab-wrap');
      l1.appendChild(mk('div', 'wxs-lab', '手动设置情绪'));
      l1.appendChild(mk('div', 'wxs-hint', '只认白名单；强度 0–100。手动设置优先于自动事件，直到下一次自动事件或巡检。'));
      row1.appendChild(l1);
      var c1 = mk('div', 'wxs-ctrl');
      c1.style.maxWidth = '66%';
      var sel = mk('select', 'wxs-select');
      (d.moodLabels || []).forEach(function (lab) {
        var o = mk('option', '', lab); o.value = lab; sel.appendChild(o);
      });
      sel.value = draft.label;
      sel.addEventListener('change', function () { draft.label = sel.value; markDirty(); });
      c1.appendChild(sel);
      var range = mk('input');
      range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1';
      range.value = String(draft.intensity);
      range.style.width = '180px';
      var val = mk('span', 'wxs-unit', String(draft.intensity));
      range.addEventListener('input', function () { draft.intensity = Math.round(Number(range.value) || 0); val.textContent = String(draft.intensity); markDirty(); });
      c1.appendChild(range); c1.appendChild(val);
      row1.appendChild(c1);
      sec.appendChild(row1);

      var row2 = mk('div', 'wxs-row');
      var l2 = mk('div', 'wxs-lab-wrap');
      l2.appendChild(mk('div', 'wxs-lab', '原因'));
      l2.appendChild(mk('div', 'wxs-hint', '一句人话，面板和注入卡都会显示；不要写「系统要求」。'));
      row2.appendChild(l2);
      var c2 = mk('div', 'wxs-ctrl');
      var cause = mk('input', 'wxs-num');
      cause.style.width = '260px';
      cause.placeholder = '例：被连着催了两次';
      cause.value = draft.cause;
      cause.addEventListener('input', function () { draft.cause = cause.value; markDirty(); });
      c2.appendChild(cause);
      row2.appendChild(c2);
      sec.appendChild(row2);

      var btns = mk('div', 'wxs-ctrl');
      btns.style.justifyContent = 'flex-start';
      var save = mk('button', 'wxs-btn is-primary', '保存情绪');
      save.type = 'button';
      save.addEventListener('click', function () {
        save.disabled = true;
        Promise.resolve(api.moodSet({ label: draft.label, intensity: draft.intensity, cause: draft.cause })).then(function (r) {
          save.disabled = false;
          if (!r || r.ok === false) { toast('保存情绪失败：' + String((r && r.error) || '未知原因'), true); return; }
          toast('情绪已保存：' + (r.mood && r.mood.label ? r.mood.label : draft.label), false, 3000);
          reload(true);
        }).catch(function (e) { save.disabled = false; toast('保存情绪失败：' + String((e && e.message) || e), true); });
      });
      btns.appendChild(save);
      var reset = mk('button', 'wxs-btn', '回平静');
      reset.type = 'button';
      reset.addEventListener('click', function () {
        Promise.resolve(api.moodReset()).then(function (r) {
          if (!r || r.ok === false) { toast('回平静失败：' + String((r && r.error) || '未知原因'), true); return; }
          toast('已回平静', false, 2500);
          reload(true);
        }).catch(function (e) { toast('回平静失败：' + String((e && e.message) || e), true); });
      });
      btns.appendChild(reset);
      sec.appendChild(btns);
      body.appendChild(sec);

      var evSec = section('最近情绪事件', '按时间倒序；自动事件与手动设置都在这里，来源可审计。');
      var evBox = mk('div', 'wxs-events');
      (d.moodEvents || []).forEach(function (e) {
        evBox.appendChild(mk('div', 'wxs-ev', hhmm(e.at) + ' · ' + (e.kind || '') + ' ' + ((e.delta || 0) > 0 ? '+' : '') + (e.delta || 0) +
          ' · ' + (e.source || '') + (e.reason ? ' · ' + e.reason : '')));
      });
      if (!(d.moodEvents || []).length) evBox.appendChild(mk('div', 'wxs-note', '还没有情绪事件'));
      evSec.appendChild(evBox);
      body.appendChild(evSec);
    }

    // ---------- 规则 ----------
    function renderRules() {
      var d = state.data;
      var c = state.draft;
      // 老数据迁到 v3 前可能没有 curves；先补空对象，numRow 仍按点号路径写。
      if (!c.curves) c.curves = {};
      ['familiarity', 'affinity', 'mood'].forEach(function (k) {
        if (!c.curves[k]) c.curves[k] = {};
      });
      var sec1 = section('总开关', '关掉注入：下一轮不再追加关系卡；已有数据不动，面板仍可看。');
      sec1.appendChild(switchRow('启用关系与情绪', '总开关；关掉后所有通道都不追加。', c, 'enabled'));
      sec1.appendChild(switchRow('注入到提示词', '关掉只保留数据，不注入；排查时可先关这里。', c, 'inject'));
      sec1.appendChild(switchRow('允许模型记事件', '关掉后 social_note 直接拒绝；已记的事件保留。', c, 'modelNotesEnabled'));
      body.appendChild(sec1);

      var sec2 = section('注入预算', '控制模型每轮多看到多少；群名单最多 10 人，当前说话人始终保留。');
      sec2.appendChild(numRow('群名单最多几人', '按熟悉度降序；当前说话人不在前列也会被替换进来。', c, 'groupRosterLimit', 1, 30, 1, '人'));
      sec2.appendChild(numRow('关系卡最多字符', '超预算先砍非当前说话人的名单行。', c, 'cardMaxChars', 120, 1200, 10, 'B'));
      sec2.appendChild(numRow('情绪可见阈值', '强度低于这个值就不写进卡，避免每轮都「有点烦」。', c, 'curves.mood.visible', 0, 100, 1, ''));
      body.appendChild(sec2);

      var sec3 = section('初始值', '只用于新建档案的起点，不是永远不变；已有关系不会被覆盖，之后仍按公式 / 事件 / 冷落衰减继续走。');
      sec3.appendChild(numRow('私聊初始好感', '新私聊档案从 60 开始；之后仍可变。', c, 'privateAffinity', -100, 100, 1, ''));
      sec3.appendChild(numRow('群成员初始好感', '新群成员档案从 60 开始；之后仍可变。', c, 'groupAffinity', -100, 100, 1, ''));
      sec3.appendChild(numRow('私聊初始熟悉度', '新私聊档案从 60 开始；之后仍可变。', c, 'privateFamiliarity', 0, 100, 1, ''));
      sec3.appendChild(numRow('群成员初始熟悉度', '新群成员档案从 60 开始；之后仍可变。', c, 'groupFamiliarity', 0, 100, 1, ''));
      body.appendChild(sec3);

      var ownerSec = section('主人', '认人、称呼、初始值都可改；只影响表达与初始分，不改事实、边界和安全规则。');
      ownerSec.appendChild(textRow('称呼', '发消息时模型用这个称呼；默认「胡闹」，不要叫原显示名。', c, 'ownerPreferredName', '胡闹', 24));
      ownerSec.appendChild(textRow('身份', '写进关系卡；默认「主人」。', c, 'ownerRole', '主人', 12));
      ownerSec.appendChild(listRow('认人的别名', '用 | 分隔；命中任一个就按主人处理。', c, 'ownerAliases', '静音胡闹|胡闹'));
      ownerSec.appendChild(listRow('认人的 senderId', '可选；用 | 分隔。名字不稳定时靠它认人。', c, 'ownerSenderIds', 'wxid_...|2310468741'));
      ownerSec.appendChild(numRow('主人初始熟悉度', '主人档案创建时直接到 100；之后仍可手动解锁。', c, 'ownerFamiliarity', 0, 100, 1, ''));
      ownerSec.appendChild(numRow('主人初始好感', '主人档案创建时直接到 +100；之后仍可手动解锁。', c, 'ownerAffinity', -100, 100, 1, ''));
      body.appendChild(ownerSec);

      var sec4 = section('熟悉度曲线', '慢饱和上升：越接近 100 越难涨；冷落 21 天后按 120 天半衰期回落，但不会掉成生人。');
      var formula = mk('div', 'wxs-note', '上升：F新 = 100 - (100 - F旧) × exp(-d / ' + fmtNum(c.curves.familiarity.gainScale) + ')，d = 每条消息 × ' + fmtNum(c.familiarityMsgWeight) + ' + 每个互动日 × ' + fmtNum(c.familiarityDayWeight) + '，单日最多 +' + fmtNum(c.curves.familiarity.dailyGainCap) + '。');
      formula.style.marginBottom = '4px';
      sec4.appendChild(formula);
      var formula2 = mk('div', 'wxs-note', '下降：冷落满 ' + fmtNum(c.curves.familiarity.graceDays) + ' 天后，F(t) = 下限 + (F0 - 下限) × 2^(-(t-' + fmtNum(c.curves.familiarity.graceDays) + ')/' + fmtNum(c.curves.familiarity.decayHalfLifeDays) + ')。');
      formula2.style.marginBottom = '6px';
      sec4.appendChild(formula2);
      sec4.appendChild(numRow('每条消息权重', '只进熟悉度增量 d，不直接加分；刷屏不会无限涨。', c, 'familiarityMsgWeight', 0, 10, 0.1, ''));
      sec4.appendChild(numRow('每个互动日权重', '有聊过的那一天算一天，不看消息多少。', c, 'familiarityDayWeight', 0, 30, 0.1, ''));
      sec4.appendChild(numRow('饱和尺度', 'd 到这个量时，离 100 的差距约掉 63%；越小涨得越快。', c, 'curves.familiarity.gainScale', 1, 500, 1, ''));
      sec4.appendChild(numRow('单日最多涨', '同一个人一天最多加这么多，避免刷屏冲顶。', c, 'curves.familiarity.dailyGainCap', 0, 50, 1, '点'));
      sec4.appendChild(numRow('冷落多少天开始降', '宽限期内不降；超过后按半衰期连续回落，不是每 60 天跳一格。', c, 'curves.familiarity.graceDays', 0, 3650, 1, '天'));
      sec4.appendChild(numRow('回落半衰期', '每过这么多天，离下限的差距减半。', c, 'curves.familiarity.decayHalfLifeDays', 1, 3650, 1, '天'));
      sec4.appendChild(numRow('熟悉度下限', '长期冷落也不低于这里；同时不允许高于「认识」门槛，避免 floor 把生人直接抬档。', c, 'curves.familiarity.floor', 0, 100, 1, ''));
      sec4.appendChild(numRow('建档最少消息', '少于这个数不自动建档，防止大群撑爆；手动建档不受限。', c, 'seedMinMessages', 1, 200, 1, '条'));
      sec4.appendChild(numRow('认识 阈值', '熟悉度到多少算「认识」。', c, 'stageKnown', 1, 99, 1, ''));
      sec4.appendChild(numRow('普通朋友 阈值', '', c, 'stageFriend', 2, 99, 1, ''));
      sec4.appendChild(numRow('熟 阈值', '', c, 'stageClose', 3, 100, 1, ''));
      sec4.appendChild(numRow('自己人 阈值', '', c, 'stageInner', 4, 100, 1, ''));
      sec4.appendChild(numRow('熟 需要好感', '熟悉到了但好感不够，只到「普通朋友」，防止一边熟一边冷。', c, 'stageCloseAffinity', 0, 100, 1, ''));
      sec4.appendChild(numRow('自己人 需要好感', '', c, 'stageInnerAffinity', 0, 100, 1, ''));
      sec4.appendChild(numRow('档位滞回', '边界上下 5 点内不换档，防止一句话跨档；0 表示不滞回。', c, 'stageHysteresis', 0, 20, 1, '点'));
      body.appendChild(sec4);

      var sec5 = section('好感曲线', '慢涨快跌：分越高越难涨、也越容易跌；长期不互动只向 0 回落，不穿 0。');
      var affFormula = mk('div', 'wxs-note', '涨：A新 = A旧 + δ×(1 - ' + fmtNum(c.curves.affinity.positiveDiminish) + '×max(A旧,0)/100)；跌：A新 = A旧 + δ×(1 + ' + fmtNum(c.curves.affinity.negativeAmplify) + '×max(A旧,0)/100)。');
      affFormula.style.marginBottom = '4px';
      sec5.appendChild(affFormula);
      var affFormula2 = mk('div', 'wxs-note', '回落：宽限 ' + fmtNum(c.curves.affinity.graceDays) + ' 天后，正向按 ' + fmtNum(c.curves.affinity.positiveHalfLifeDays) + ' 天半衰期、负向按 ' + fmtNum(c.curves.affinity.negativeHalfLifeDays) + ' 天半衰期向 0 走。');
      affFormula2.style.marginBottom = '6px';
      sec5.appendChild(affFormula2);
      sec5.appendChild(numRow('单次好感上限', '模型写 +10 会被夹到这个值。', c, 'affinityEventMax', 0, 20, 1, ''));
      sec5.appendChild(numRow('单日净变化上限', '同一个人一天最多涨/跌这么多；只统计好感类事件。', c, 'affinityDailyCap', 0, 100, 1, ''));
      sec5.appendChild(numRow('严重负向上限', '辱骂 / 人身攻击一次最多扣多少；同时锁 24h 不接受正向抵消。', c, 'affinitySevereMax', 0, 100, 1, ''));
      sec5.appendChild(numRow('高分涨势折扣', '0 表示线性；0.5 表示 100 分时同样的好事只加一半。', c, 'curves.affinity.positiveDiminish', 0, 1, 0.05, ''));
      sec5.appendChild(numRow('高分跌势放大', '0 表示线性；0.5 表示 100 分时同样的坏事多跌 50%。', c, 'curves.affinity.negativeAmplify', 0, 2, 0.05, ''));
      sec5.appendChild(numRow('冷落多少天开始回落', '宽限期内不回落。', c, 'curves.affinity.graceDays', 0, 3650, 1, '天'));
      sec5.appendChild(numRow('正向回落半衰期', '没有新互动时，正好感每过这么多天减半。', c, 'curves.affinity.positiveHalfLifeDays', 1, 3650, 1, '天'));
      sec5.appendChild(numRow('负向回落半衰期', '负好感也向 0 走，不永久记仇；但比正向慢。', c, 'curves.affinity.negativeHalfLifeDays', 1, 3650, 1, '天'));
      sec5.appendChild(numRow('严重负向修复惩罚', '严重负向之后这段时间内，正向修复只按折扣算。', c, 'curves.affinity.repairPenaltyHours', 0, 720, 1, '小时'));
      sec5.appendChild(numRow('修复效率', '惩罚期内的正向事件乘这个系数；0.5 = 只算一半。', c, 'curves.affinity.repairEfficiency', 0, 1, 0.05, ''));
      body.appendChild(sec5);

      var sec6 = section('情绪曲线', '快起慢落：事件先抵消当前方向，再按上限饱和；低于阈值回平静。');
      var moodFormula = mk('div', 'wxs-note', '上升：M新 = min(上限, M旧 + δ×(1 - M旧/上限))；下降：M(t) = M0 × 2^(-t/' + fmtNum(c.curves.mood.halfLifeMin) + '分钟)。');
      moodFormula.style.marginBottom = '6px';
      sec6.appendChild(moodFormula);
      sec6.appendChild(numRow('半衰期', '强度掉一半需要的分钟数；默认 90。', c, 'curves.mood.halfLifeMin', 5, 1440, 5, '分钟'));
      sec6.appendChild(numRow('正向强度上限', '开心 / 兴奋最高到多少。', c, 'curves.mood.positiveMax', 0, 100, 1, ''));
      sec6.appendChild(numRow('负向强度上限', '烦躁 / 委屈最高到多少。', c, 'curves.mood.negativeMax', 0, 100, 1, ''));
      sec6.appendChild(numRow('单次情绪上限', '一次事件最多 ±多少。', c, 'curves.mood.eventMax', 0, 30, 1, ''));
      sec6.appendChild(numRow('单日情绪上限', '一天累计最多变化多少；手动设置不算模型额度。', c, 'curves.mood.dailyCap', 0, 200, 1, ''));
      sec6.appendChild(numRow('换标签门槛', '新信号至少达到当前强度的这个比例才换标签；0.6 = 60%。', c, 'curves.mood.switchMargin', 0, 1, 0.05, '×'));
      body.appendChild(sec6);
      body.appendChild(moodEffectTable(c));

      var sec7 = section('群接话系数', '只调「接不接」的小幅权重，原概率仍由 QQ 群聊自己的设置决定；反感和生人不会因为这里调高就话痨。');
      sec7.appendChild(switchRow('启用关系加权', '关掉后所有档位系数按 1 计算。', c, 'groupBiasEnabled'));
      sec7.appendChild(numRow('系数下限', '', c, 'groupBiasMin', 0, 5, 0.05, '×'));
      sec7.appendChild(numRow('系数上限', '', c, 'groupBiasMax', 0, 5, 0.05, '×'));
      (d.stages || []).forEach(function (s) {
        if (!c.groupBias) c.groupBias = {};
        sec7.appendChild(numRow(s.label + ' 的系数', '', c.groupBias, s.key, 0, 5, 0.05, '×'));
      });
      body.appendChild(sec7);

      var footRow = mk('div', 'wxs-ctrl');
      footRow.style.justifyContent = 'flex-start';
      footRow.style.marginTop = '8px';
      var save = mk('button', 'wxs-btn is-primary', '保存规则');
      save.type = 'button';
      save.addEventListener('click', function () {
        save.disabled = true;
        Promise.resolve(api.relationConfigSave(state.draft)).then(function (r) {
          save.disabled = false;
          if (!r || r.ok === false) { toast('保存规则失败：' + String((r && r.error) || '未知原因'), true); return; }
          state.dirty = false;
          toast('规则已保存；下一轮生效', false, 3000);
          reload(true);
        }).catch(function (e) { save.disabled = false; toast('保存规则失败：' + String((e && e.message) || e), true); });
      });
      footRow.appendChild(save);
      var revert = mk('button', 'wxs-btn', '还原为当前已保存值');
      revert.type = 'button';
      revert.addEventListener('click', function () {
        if (state.dirty && !window.confirm('丢掉本页未保存修改，回到已保存值？')) return;
        state.draft = clone(state.data.config || {});
        state.dirty = false;
        render();
      });
      footRow.appendChild(revert);
      body.appendChild(footRow);
    }

    // ---------- 预览 ----------
    function renderPreview() {
      var d = state.data;
      var sec = section('下一轮注入预览', '这就是模型实际会看到的全文，追加在【社交回复规范】后面；字数含换行。');
      var row = mk('div', 'wxs-row');
      var lw = mk('div', 'wxs-lab-wrap');
      lw.appendChild(mk('div', 'wxs-lab', '选聊天 + 当前说话人'));
      lw.appendChild(mk('div', 'wxs-hint', '说话人决定「当前说话人」那一行；不填就只给名单。'));
      row.appendChild(lw);
      var cw = mk('div', 'wxs-ctrl');
      cw.style.maxWidth = '70%';
      var sel = mk('select', 'wxs-select');
      (d.chats || []).forEach(function (c) {
        var o = mk('option', '', c.label + '（' + c.count + ' 人）');
        o.value = c.chatKey;
        sel.appendChild(o);
      });
      if (!(d.chats || []).length) {
        var o0 = mk('option', '', '先重建档案或手动建档');
        o0.value = '';
        sel.appendChild(o0);
      }
      var person = mk('input', 'wxs-num');
      person.style.width = '120px';
      person.placeholder = '说话人（可空）';
      cw.appendChild(sel); cw.appendChild(person);
      row.appendChild(cw);
      sec.appendChild(row);

      var textRow = mk('div', 'wxs-row');
      var tl = mk('div', 'wxs-lab-wrap');
      tl.appendChild(mk('div', 'wxs-lab', '本轮正文（可选）'));
      tl.appendChild(mk('div', 'wxs-hint', '有些通道从正文里识别发言人；贴一句能验证识别是否命中。'));
      textRow.appendChild(tl);
      var tc = mk('div', 'wxs-ctrl');
      var textIn = mk('input', 'wxs-num');
      textIn.style.width = '300px';
      textIn.placeholder = '例：（现在，何笙 说：今天好累）';
      tc.appendChild(textIn);
      textRow.appendChild(tc);
      sec.appendChild(textRow);

      var run = mk('button', 'wxs-btn is-primary', '生成预览');
      run.type = 'button';
      var outBox = mk('div', 'wxs-pre', '点「生成预览」看下一轮模型实际会读到的关系卡。');
      var meta = mk('div', 'wxs-note', '');
      run.addEventListener('click', function () {
        var p = parseChat(sel.value);
        if (!p) { toast('先选一个聊天', true); return; }
        run.disabled = true;
        Promise.resolve(api.relationPreview({
          channel: p.channel,
          chatType: p.chatType,
          chatId: p.chatId,
          senderName: person.value.trim(),
          text: textIn.value.trim()
        })).then(function (r) {
          run.disabled = false;
          if (!r || r.ok === false) { toast('预览失败：' + String((r && r.error) || '未知原因'), true); return; }
          outBox.textContent = r.text || '（这一轮不会注入关系段：没数据或开关关着）';
          var plan = r.moodPlan || {};
          meta.textContent = '字数 ' + Number(r.chars || 0) + ' B · 人数 ' + Number(r.peopleCount || 0) + ' · 心情 ' + String((r.mood && r.mood.label) || '平静') +
            (r.mood && r.mood.visible ? '（' + Number(r.mood.intensity) + '/100）' : '') +
            ' · 联动 文字≤' + Number(plan.maxChars || 0) + ' / 句子≤' + Number(plan.maxSentences || 0) +
            ' / emoji×' + fmtNum(plan.emojiFactor || 0) + ' / 贴纸×' + fmtNum(plan.stickerFactor || 0) +
            ' / 语音×' + fmtNum(plan.voiceFactor || 0) + ' / 群接话×' + fmtNum(plan.groupFactor || 0);
        }).catch(function (e) {
          run.disabled = false;
          toast('预览失败：' + String((e && e.message) || e), true);
        });
      });
      sec.appendChild(run);
      sec.appendChild(meta);
      sec.appendChild(outBox);
      body.appendChild(sec);

      var curveSec = section('未来曲线（不加新事件，只按时间走）', '现在 / 1 天 / 7 天 / 30 天 / 90 天；只用于解释趋势，不会自己加分或扣分。');
      (d.people || []).forEach(function (p) {
        var pts = (p.curves || []).map(function (x) {
          return x.days + 'd ' + fmtNum(x.familiarity) + '/' + fmtAff(x.affinity);
        }).join(' · ');
        curveSec.appendChild(mk('div', 'wxs-note', (p.chatLabel ? '[' + p.chatLabel + '] ' : '') +
          String(p.preferredName || p.name || p.senderId || '') + '：' + (pts || '无曲线数据')));
      });
      (d.moodForecast || []).forEach(function (x, i) {
        if (i === 0) curveSec.appendChild(mk('div', 'wxs-note', '心情：'));
        curveSec.appendChild(mk('div', 'wxs-note', '  ' + x.days + 'd · ' + x.label + ' ' + fmtNum(x.intensity) + '/100'));
      });
      body.appendChild(curveSec);

      var logSec = section('最近实际注入', '外壳与 DSH 插件都会记一条；能看见注入了几人、什么心情、关系卡多少字节。');
      var logBox = mk('div', 'wxs-events');
      (d.recentCards || []).forEach(function (r) {
        logBox.appendChild(mk('div', 'wxs-ev', String(r.at || '') + ' · ' + channelName(r.channel) + ' ' + (r.chatType === 'group' ? '群聊' : '私聊') +
          ' · 名单 ' + Number(r.people || 0) + ' 人 · 心情 ' + String(r.mood || '无') + ' · 关系卡 ' + Number(r.relationChars || 0) + ' B'));
      });
      if (!(d.recentCards || []).length) logBox.appendChild(mk('div', 'wxs-note', '还没有注入记录；发一条社交消息或换一台绑定会话再看。'));
      logSec.appendChild(logBox);
      body.appendChild(logSec);

      var noteSec = section('最近事件', '模型提的事件与手动改值都在这里，来源可审计。');
      var noteBox = mk('div', 'wxs-events');
      (d.recentNotes || []).forEach(function (r) {
        noteBox.appendChild(mk('div', 'wxs-ev', String(r.at || '') + ' · ' + String(r.kind || '') + ' · ' + String(r.person || '') +
          (r.delta !== undefined && r.delta !== null ? ' ' + String(r.delta) : '') + (r.reason ? ' · ' + String(r.reason) : '')));
      });
      if (!(d.recentNotes || []).length) noteBox.appendChild(mk('div', 'wxs-note', '还没有事件记录'));
      noteSec.appendChild(noteBox);
      body.appendChild(noteSec);
    }

    render();
    document.body.appendChild(mask);
    return true;
  }

  function open() {
    if (document.querySelector('.wxs-mask[data-social-relation="1"]')) return Promise.resolve(true);
    if (!api || typeof api.relationGet !== 'function') {
      toast('关系与情绪还没接上：重启一次工作台（preload / main 是旧的）', true);
      return Promise.resolve(false);
    }
    return Promise.resolve(api.relationGet()).then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.error) || '读不到关系数据');
      build(data);
      return true;
    }).catch(function (e) {
      toast('打开关系与情绪失败：' + String((e && e.message) || e), true);
      return false;
    });
  }

  window.openSocialRelationSettings = open;
})();

