'use strict';
// 关系与情绪设置（2026-11-20，2026-11-24 改）
//
// 反黑盒约定：
//   · 入口常驻在「胡闹的大肥鱼 → 设置」，文字按钮「关系与情绪」；
//   · 每个人的熟悉度、好感、档位、事件、来源都能看见；
//   · 分数 / 曲线 / 情绪联动表由代码固定成一套标准，面板只读，不提供手动加减分或调参；
//   · 称呼 / 身份 / 标签 / 备注仍可改，属于人物资料，不碰分数；
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
    hw.appendChild(mk('div', 'wxs-sub', '对每个人的熟悉度 / 好感，和她自己此刻的情绪；分数和曲线由一套固定标准自动推进，面板只观察。称呼 / 身份 / 标签 / 备注仍可改。'));
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
      ['standard', '标准'],
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
        render();
      });
      tabs.appendChild(b);
    });

    var body = mk('div', 'wxs-body');
    dlg.appendChild(body);

    var foot = mk('div', 'wxs-foot');
    var fh = mk('div', 'wxs-fh', '称呼 / 标签 / 备注保存后下一轮生效；分数与情绪由固定标准自动推进。');
    foot.appendChild(fh);
    var seedBtn = mk('button', 'wxs-btn', '重建档案');
    seedBtn.type = 'button';
    seedBtn.title = '按聊天档案的消息数 / 互动天数重算熟悉度；好感、标签、备注都保留';
    seedBtn.addEventListener('click', function () {
      if (!api || typeof api.relationSeed !== 'function') { toast('接口没接上：重启一次工作台', true); return; }
      if (!window.confirm('会按聊天档案重算熟悉度（消息数 × 权重 + 互动天数 × 权重）。\n好感、称呼、身份、标签、备注都保留；熟悉度按档案和固定标准推进。继续？')) return;
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
        '<span class="wxs-pill is-ok">标准：固定</span>' +
        '<span class="wxs-pill">人数 ' + Number((d.people || []).length) + '</span>' +
        '<span class="wxs-pill">聊天 ' + Number((d.chats || []).length) + '</span>' +
        '<span class="wxs-pill ' + (d.mood && d.mood.visible ? 'is-warn' : '') + '">心情：' + String((d.mood && d.mood.label) || '平静') +
          (d.mood && d.mood.visible ? ' ' + Number(d.mood.intensity) + '/100' : '') + '</span>' +
        '<span class="wxs-pill ' + (d.config.inject ? 'is-ok' : 'is-bad') + '">注入：' + (d.config.inject ? '开' : '关') + '</span>';
      tabs.querySelectorAll('.wxs-tab').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.tab === state.tab);
      });
      body.innerHTML = '';
      if (state.tab === 'people') renderPeople();
      else if (state.tab === 'mood') renderMood();
      else if (state.tab === 'standard') renderStandard();
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
      filterBar.appendChild(mk('span', 'wxs-hint', '点人名展开编辑称呼 / 身份 / 标签 / 备注；分数由固定标准自动推进。'));
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
      var addSec = section('手动建档 / 补录', '用于飞书等没有聊天档案的通道，或档案里还没出现的人。建档按固定标准 60 / 60 开始；名字命中主人别名会直接按主人 100 / 100。');
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
        ' · 来源 ' + (p.manual && (p.manual.familiarity !== null || p.manual.affinity !== null) ? '自动统计 + 事件（旧手动值）' : '自动统计 + 事件'));
      bodyEl.appendChild(meta);
      var curveText = (p.curves || []).map(function (x) {
        return x.days + 'd ' + fmtNum(x.familiarity) + '/' + fmtAff(x.affinity);
      }).join(' · ');
      if (curveText) bodyEl.appendChild(mk('div', 'wxs-note', '未来曲线：' + curveText));

      var draft = {
        preferredName: p.preferredName || '',
        role: p.role || '',
        tags: (p.tags || []).join('|'),
        note: ''
      };
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
      sec.appendChild(mk('div', 'wxs-note', '情绪只由事件和 ' + Number(m.halfLife || 90) + ' 分钟半衰期自动推进；面板不提供手动设置，下面「最近情绪事件」能看到每次变化和原因。'));
      body.appendChild(sec);

      var evSec = section('最近情绪事件', '按时间倒序；自动事件与系统记录都在这里，来源可审计。');
      var evBox = mk('div', 'wxs-events');
      (d.moodEvents || []).forEach(function (e) {
        evBox.appendChild(mk('div', 'wxs-ev', hhmm(e.at) + ' · ' + (e.kind || '') + ' ' + ((e.delta || 0) > 0 ? '+' : '') + (e.delta || 0) +
          ' · ' + (e.source || '') + (e.reason ? ' · ' + e.reason : '')));
      });
      if (!(d.moodEvents || []).length) evBox.appendChild(mk('div', 'wxs-note', '还没有情绪事件'));
      evSec.appendChild(evBox);
      body.appendChild(evSec);
    }

    // ---------- 标准（只读） ----------
    // 2026-11-24：分数 / 曲线 / 情绪联动表由 社交状态.js 的 DEFAULT_CONFIG 固定；
    // 面板只展示标准，不提供输入框；要改标准走代码评审，避免两套口径。
    function renderStandard() {
      var d = state.data;
      var c = d.config || {};
      var fam = (c.curves && c.curves.familiarity) || {};
      var aff = (c.curves && c.curves.affinity) || {};
      var mood = (c.curves && c.curves.mood) || {};
      var labels = d.moodLabels || ['平静', '开心', '兴奋', '得意', '低落', '委屈', '烦躁', '疲惫', '心虚'];

      function block(title, hint, lines) {
        var sec = section(title, hint);
        lines.forEach(function (line) {
          var n = mk('div', 'wxs-note', line);
          n.style.marginTop = '6px';
          sec.appendChild(n);
        });
        return sec;
      }

      body.appendChild(block('关系分怎么走', '全部由代码标准自动推进；面板不提供加减分或曲线输入。', [
        '新建档案：私聊 / 群 ' + fmtNum(c.privateFamiliarity) + ' / ' + fmtNum(c.privateAffinity) + '；主人 ' + fmtNum(c.ownerFamiliarity) + ' / ' + fmtNum(c.ownerAffinity) + '（按别名或 senderId 认人）。',
        '熟悉度：每条消息 +' + fmtNum(c.familiarityMsgWeight) + '，每个互动日 +' + fmtNum(c.familiarityDayWeight) + '；按饱和曲线向 100 靠近，单日最多 +' + fmtNum(fam.dailyGainCap) + '；' + fmtNum(fam.graceDays) + ' 天不聊后，按 ' + fmtNum(fam.decayHalfLifeDays) + ' 天半衰期回落到 ' + fmtNum(fam.floor) + ' 下限。',
        '好感：单次事件最多 ±' + fmtNum(c.affinityEventMax) + '，踩雷 -2，严重负向 -' + fmtNum(c.affinitySevereMax) + '，单日净变化 ±' + fmtNum(c.affinityDailyCap) + '；' + fmtNum(aff.graceDays) + ' 天不互动后，正向 ' + fmtNum(aff.positiveHalfLifeDays) + ' 天 / 负向 ' + fmtNum(aff.negativeHalfLifeDays) + ' 天半衰期回 0；严重负向后 ' + fmtNum(aff.repairPenaltyHours) + ' 小时内修复只算 ' + fmtNum(aff.repairEfficiency) + '。',
        '档位：认识 ' + fmtNum(c.stageKnown) + ' / 普通朋友 ' + fmtNum(c.stageFriend) + ' / 熟 ' + fmtNum(c.stageClose) + ' / 自己人 ' + fmtNum(c.stageInner) + '；熟需好感 ' + fmtNum(c.stageCloseAffinity) + '，自己人需 ' + fmtNum(c.stageInnerAffinity) + '；边界 ' + fmtNum(c.stageHysteresis) + ' 点滞回。'
      ]));

      body.appendChild(block('情绪分怎么走', '模型只报情绪标签，分数按固定表折算；面板不提供手动设置。', [
        '一次事件：开心 +4 / 兴奋 +8 / 得意 +3 / 低落 -4 / 委屈 -6 / 烦躁 -6 / 疲惫 -4 / 心虚 -3 / 平静 0。',
        '单次最多 ±' + fmtNum(mood.eventMax) + '，单日最多 ' + fmtNum(mood.dailyCap) + '；强度按 ' + fmtNum(mood.halfLifeMin) + ' 分钟半衰期回落；正向封顶 ' + fmtNum(mood.positiveMax) + '，负向封顶 ' + fmtNum(mood.negativeMax) + '；低于 ' + fmtNum(mood.visible) + ' 不写进关系卡。',
        '换标签：新信号至少达到当前强度 ' + Math.round(Number(mood.switchMargin || 0) * 100) + '% 才换，避免一句话来回跳。'
      ]));

      var fsec = section('情绪表达（固定表）', '每个标签只调表达上限，不改事实、边界；表由代码固定。');
      var table = mk('table', 'wxs-mood-table');
      var thead = mk('thead');
      var hr = mk('tr');
      ['情绪', '字数上限', '句数上限', 'emoji 权重', '贴纸权重', '语音权重', '群接话权重'].forEach(function (t) {
        hr.appendChild(mk('th', '', t));
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = mk('tbody');
      labels.forEach(function (label) {
        var e = (c.moodEffects && c.moodEffects[label]) || {};
        var tr = mk('tr');
        tr.appendChild(mk('td', 'wxs-mood-name', label));
        [e.maxChars, e.maxSentences].forEach(function (v) {
          tr.appendChild(mk('td', '', Number(v) ? ('≤ ' + Number(v)) : '不限'));
        });
        [e.emojiFactor, e.stickerFactor, e.voiceFactor, e.groupFactor].forEach(function (v) {
          tr.appendChild(mk('td', '', '×' + fmtNum(v === undefined ? 1 : v)));
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      fsec.appendChild(table);
      fsec.appendChild(mk('div', 'wxs-note', '低落 / 委屈 / 烦躁 / 疲惫默认不发贴纸、不发语音、少接话；心虚会收一点；对方明确要求语音仍优先。'));
      body.appendChild(fsec);

      var g = c.groupBias || {};
      var stageText = (d.stages || []).map(function (s) {
        return s.label + ' ' + fmtNum(g[s.key] === undefined ? 1 : g[s.key]);
      }).join(' / ');
      body.appendChild(block('群接话', '只调接不接的小幅权重，原概率仍归 QQ 群聊自己的设置。', [
        '总系数区间 ' + fmtNum(c.groupBiasMin) + '–' + fmtNum(c.groupBiasMax) + '；档位系数：' + stageText + '。',
        '被 @ / 被直接问仍必须回，好感再低也不许骂人；群接话只影响随机接话。'
      ]));

      var foot = section('怎么改这套标准', '面板只读，不提供加减分、曲线、情绪联动表的输入框。');
      foot.appendChild(mk('div', 'wxs-note', '标准写在「外壳\\社交状态.js」的 DEFAULT_CONFIG；要调整就改代码并跑测试，避免面板、CLI、文件三套口径。'));
      body.appendChild(foot);
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

      var noteSec = section('最近事件', '模型提的事件与旧版手动改值都在这里，来源可审计。');
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

