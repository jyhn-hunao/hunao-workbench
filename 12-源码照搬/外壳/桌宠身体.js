// 桌宠身体.js（2026-11-20）——dsh-pet 0.4.9 的本机 HTTP 客户端（只借身体，不借大脑）。
//
// 分工：
//   · 状态：主进程算好 6 态 + 任务文案，POST /dsh-pet-7340/work-status；空闲时 DELETE 清外部槽。
//   · 说话：需要锁；POST /lock → POST /broadcast → POST /lock/release。锁期间宠物会冻结，所以只做短气泡。
//   · 绝不调用它的 /chat、/whisper、/balance：人格、记忆、余额仍归工作台，避免两套人格/两套账。
//
// 接口口径（dsh-pet API.md / openapi.yaml，2026-11-20 核对）：
//   GET  /state                         读状态（探活；pets.<id> 存在 = 插件已加载）
//   POST /work-status  {state, task}    只接受 thinking/working/result/waiting/success/error
//   DELETE /work-status                 清空外部槽回空闲
//   POST /lock?pet=&surface=desktop     {ttl} → {ok,lockId,petId,expiresAt}
//   POST /broadcast?pet=&surface=desktop&lock=<id>  {text, duration?, anim?, speak?}
//   POST /lock/release?pet=             {lockId}
//
// 只监听 127.0.0.1，且它本身没有鉴权；这里不把端口转发出去，也不把 token 写进日志。
'use strict';

function createClient(opts) {
  const o = opts || {};
  const base = String(o.base || '').replace(/\/+$/, '');
  const pet = String(o.pet || 'main');
  const token = String(o.token || '');
  let available = null;        // null=还没探过 / true / false
  let lastProbeAt = 0;
  let lastState = '';
  let lastTask = '';
  let lastError = '';

  function withQuery(path) {
    if (!token) return path;
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    return path + sep + 'token=' + encodeURIComponent(token);
  }

  // 1. 薄 HTTP：业务失败也是 200，所以只把网络/协议错误当异常；业务结论看 json.ok / json.reason
  async function request(method, path, body, timeoutMs) {
    if (!base) return { status: 0, ok: false, error: 'no-base' };
    try {
      const res = await fetch(base + withQuery(path), {
        method: method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 3000),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      if (res.status === 200 && json && json.ok === false) {
        return { status: res.status, ok: false, json: json, text: text, reason: String(json.reason || json.message || '') };
      }
      return { status: res.status, ok: res.ok, json: json, text: text };
    } catch (e) {
      return { status: 0, ok: false, error: String((e && e.message) || e) };
    }
  }

  // 2. 探活：GET /state；有 sections = 插件路由已挂（/state 的 pets 只列「有活动数据」的宠物，
  //    刚起来/刚重载时可能是空对象，不能拿 pets[pet] 判定插件在不在）
  async function probe(force) {
    if (!force && available !== null && Date.now() - lastProbeAt < 60000) return available;
    lastProbeAt = Date.now();
    const r = await request('GET', '/state', undefined, 2500);
    if (r.status !== 200 || !r.json || !r.json.sections) {
      available = false;
      lastError = r.error || (r.status ? ('HTTP ' + r.status + (r.json ? '' : ' 非 JSON')) : 'no-state');
      return available;
    }
    available = true;
    lastError = '';
    return available;
  }

  // 3. 推状态：相同 state+task 不重复写；idle 用 DELETE 清外部槽
  async function push(state, task) {
    const s = String(state || 'idle');
    const t = String(task || '');
    if (!base) return { ok: false, reason: 'no-base' };
    if (await probe(false) === false) return { ok: false, reason: 'not-available', error: lastError };

    if (s === 'idle') {
      if (lastState === 'idle') return { ok: true, skipped: true };
      const r = await request('DELETE', '/work-status', undefined, 2500);
      if (r.status === 204 || r.ok) {
        lastState = 'idle';
        lastTask = '';
        return { ok: true };
      }
      return { ok: false, reason: r.reason || r.error || ('HTTP ' + r.status) };
    }

    if (s === lastState && t === lastTask) return { ok: true, skipped: true };
    const r = await request('POST', '/work-status', { state: s, task: t || null }, 2500);
    if (r.status === 200 && (!r.json || r.json.ok !== false)) {
      lastState = s;
      lastTask = t;
      return { ok: true };
    }
    return { ok: false, reason: r.reason || r.error || ('HTTP ' + r.status) };
  }

  // 4. 说一句：只搬运文本，不生成；锁 30 秒，播完即放。失败不抛，交给调用方决定要不要提示。
  async function say(text, sayOpts) {
    const so = sayOpts || {};
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: 'empty-text' };
    if (await probe(false) === false) return { ok: false, reason: 'not-available', error: lastError };

    const lock = await request('POST', '/lock?pet=' + encodeURIComponent(pet) + '&surface=desktop', { ttl: 30000 }, 3000);
    if (lock.status !== 200 || !lock.json || !lock.json.lockId) {
      return { ok: false, reason: lock.reason || lock.error || 'lock-failed' };
    }
    const lockId = String(lock.json.lockId);
    try {
      const r = await request(
        'POST',
        '/broadcast?pet=' + encodeURIComponent(pet) + '&surface=desktop&lock=' + encodeURIComponent(lockId),
        { text: t, duration: Number(so.duration) || 10000, anim: so.anim !== false, speak: !!so.speak },
        3000
      );
      return { ok: r.status === 200 && (!r.json || r.json.ok !== false), reason: r.reason || r.error || '' };
    } finally {
      await request('POST', '/lock/release?pet=' + encodeURIComponent(pet), { lockId: lockId }, 2500);
    }
  }

  // 5. 长轮询：顶栏通知靠它；since 用上一次的全局 counter，timeout 最大 10 秒（与 dsh-pet 契约一致）
  async function waitState(since, timeoutMs) {
    const q = '/state?since=' + encodeURIComponent(String(since || 0))
      + '&timeout=' + encodeURIComponent(String(Math.max(0, Number(timeoutMs) || 0)));
    const r = await request('GET', q, undefined, Math.max(3000, Number(timeoutMs) + 1500));
    if (r.status !== 200 || !r.json) return { ok: false, reason: r.reason || r.error || ('HTTP ' + r.status) };
    return { ok: true, json: r.json };
  }

  // 6. 待办：dsh-pet 的 todos.json 是唯一真源；顶栏只做展示与办结，不另存一份
  async function todos() {
    const r = await request('GET', '/todos', undefined, 2500);
    if (r.status !== 200 || !r.json || r.json.ok === false) {
      return { ok: false, reason: r.reason || r.error || ('HTTP ' + r.status), todos: [] };
    }
    return { ok: true, todos: Array.isArray(r.json.todos) ? r.json.todos : [] };
  }
  async function todoAdd(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: 'empty-text' };
    const r = await request('POST', '/todos', { text: t }, 3000);
    return { ok: r.status === 200 && (!r.json || r.json.ok !== false), todo: (r.json && r.json.todo) || null, reason: r.reason || r.error || '' };
  }
  async function todoToggle(id, done) {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, reason: 'empty-id' };
    const r = await request('PATCH', '/todos/' + encodeURIComponent(tid), { done: !!done }, 3000);
    return { ok: r.status === 200 && (!r.json || r.json.ok !== false), todo: (r.json && r.json.todo) || null, reason: r.reason || r.error || '' };
  }
  async function todoRemove(id) {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, reason: 'empty-id' };
    const r = await request('DELETE', '/todos/' + encodeURIComponent(tid), undefined, 3000);
    return { ok: r.status === 200 && (!r.json || r.json.ok !== false), reason: r.reason || r.error || '' };
  }

  // 7. 右键菜单：owner 级整体覆盖；查询即清空，所以由主进程持续长轮询
  const MENU_OWNER = 'workbench';
  async function setMenuItems(labels) {
    const arr = Array.isArray(labels) ? labels : [];
    const r = await request('POST', '/menu/item', { owner: MENU_OWNER, labels: arr, target: 'desktop' }, 3000);
    return { ok: r.status === 200 && (!r.json || r.json.ok !== false), reason: r.reason || r.error || '', owner: MENU_OWNER };
  }
  async function pollMenu(waitMs) {
    const w = Math.min(10000, Math.max(0, Number(waitMs) || 0));
    const r = await request(
      'GET',
      '/menu/events?owner=' + encodeURIComponent(MENU_OWNER) + '&wait=' + encodeURIComponent(String(w)),
      undefined,
      w + 1500
    );
    if (r.status !== 200 || !r.json) return { ok: false, reason: r.reason || r.error || ('HTTP ' + r.status), events: {} };
    if (r.json.ok === false) return { ok: false, reason: r.reason || 'menu-failed', events: {} };
    return { ok: true, events: (r.json.events && typeof r.json.events === 'object') ? r.json.events : {}, owner: MENU_OWNER };
  }

  // 8. 配置 / 语音：dsh-pet 的 /config 是唯一真源；PUT 只带白名单字段，其余由它自己保留
  function pickMainConfig(json) {
    if (!json || typeof json !== 'object') return null;
    if (json[pet] && Array.isArray(json[pet].pets)) return json[pet];
    for (const key of Object.keys(json)) {
      if (json[key] && Array.isArray(json[key].pets)) return json[key];
    }
    return null;
  }
  async function getConfig() {
    const r = await request('GET', '/config', undefined, 2500);
    if (r.status !== 200 || !r.json) return { ok: false, reason: r.reason || r.error || ('HTTP ' + r.status), config: null };
    return { ok: true, config: r.json, main: pickMainConfig(r.json) };
  }
  function voiceOf(main) {
    const m = main || {};
    return {
      enabled: m.voiceEnabled === true,
      name: String(m.voiceName || 'edge/zh-CN-XiaoyiNeural'),
      volume: Number.isFinite(Number(m.voiceVolume)) ? Number(m.voiceVolume) : 1,
      whisper: m.voiceWhisperEnabled === true,
      todo: m.voiceTodoEnabled === true,
      notify: m.voiceNotifyEnabled === true,
      notificationsEnabled: m.notificationsEnabled !== false
    };
  }
  async function getVoice() {
    const c = await getConfig();
    if (!c.ok) return { ok: false, reason: c.reason, voice: voiceOf(null) };
    return { ok: true, voice: voiceOf(c.main), source: c.main ? 'dsh-pet' : 'default' };
  }
  async function setVoice(v) {
    const o = v || {};
    const c = await getConfig();
    if (!c.ok || !c.main || !Array.isArray(c.main.pets) || !c.main.pets.length) {
      return { ok: false, reason: c.reason || 'config-unreadable' };
    }
    const body = { pets: c.main.pets };
    if (o.enabled !== undefined) body.voiceEnabled = !!o.enabled;
    if (o.name !== undefined) body.voiceName = String(o.name || '').trim() || 'edge/zh-CN-XiaoyiNeural';
    if (o.volume !== undefined) body.voiceVolume = Math.min(1, Math.max(0, Number(o.volume) || 0));
    if (o.whisper !== undefined) body.voiceWhisperEnabled = !!o.whisper;
    if (o.todo !== undefined) body.voiceTodoEnabled = !!o.todo;
    if (o.notify !== undefined) body.voiceNotifyEnabled = !!o.notify;
    if (o.notificationsEnabled !== undefined) body.notificationsEnabled = !!o.notificationsEnabled;
    body.speechProvider = 'dsh';
    const r = await request('PUT', '/config', body, 8000);
    if (r.status !== 200 || (r.json && r.json.ok === false)) {
      return { ok: false, reason: r.reason || r.error || ('HTTP ' + r.status) };
    }
    return { ok: true, voice: voiceOf(c.main) };
  }

  // 9. 给主进程/设置面板看的当前客户端状态（不暴露 token）
  function state() {
    return { base: base, pet: pet, available: available, lastState: lastState, lastTask: lastTask, lastError: lastError };
  }

  return {
    push: push, say: say, probe: probe, state: state,
    waitState: waitState,
    todos: todos, todoAdd: todoAdd, todoToggle: todoToggle, todoRemove: todoRemove,
    setMenuItems: setMenuItems, pollMenu: pollMenu,
    getVoice: getVoice, setVoice: setVoice, getConfig: getConfig
  };
}

module.exports = { createClient };
