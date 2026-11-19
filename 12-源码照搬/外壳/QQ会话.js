// QQ会话.js —— QQ 私聊 / 群聊的「一条聊天一条 DSH 会话」路由管理（2026-11-19）
//
// 背景：dsh-onebot-channel 的 routes.private/group 是「一个 QQ 号/群 → 一个 sessionId」。
// 之前工作台把 routes.private 全部指到人格主会话，结果 QQ 私聊之间、群聊和私聊之间会串上下文。
// 这层只做三件事：
//   1) 读现状：哪些聊天已有独立会话，哪些还共用主会话；
//   2) 把共用/重复的 route 迁成独立会话（建会话走 外壳\scripts\建会话.mjs）；
//   3) 给界面提供 add/remove，并且只改 Q 桥接的 routes，不碰其它配置。
// 不直接改第三方插件源码；写配置优先走插件的 /api/qq-bridge/save 热生效，失败才落文件等重启。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const socialReply = require('./社交回复');

const CONF_FILE = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json');
const PET_NAME = '胡闹的大肥鱼';
const QQ_KEY = 'qq';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

function writeAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function backup(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-qqchat-' + stamp());
  } catch (e) { /* 备份失败不阻塞主流程 */ }
}

function asRoutes(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (!c.routes || typeof c.routes !== 'object') c.routes = {};
  for (const k of ['private', 'group']) {
    if (!c.routes[k] || typeof c.routes[k] !== 'object') c.routes[k] = {};
  }
  return c;
}

function digits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function titleFor(kind, id, name) {
  const n = String(name || '').trim();
  return PET_NAME + ' · QQ ' + (kind === 'group' ? '群' : '私聊') + ' · ' + (n || id);
}

function chatTitleFor(kind, id, name) {
  const n = String(name || '').trim();
  return n || ('QQ ' + (kind === 'group' ? '群 ' : '私聊 ') + id);
}

function defaultPrefix(kind, cfg) {
  return kind === 'group' ? '（QQ 群）' : String((cfg && cfg.textPrefix) || '（QQ 私聊）');
}

function createService(options) {
  const opt = options || {};
  const dshHome = String(opt.dshHome || process.env.DSH_HOME || '');
  const scenariosDir = String(opt.scenariosDir || path.join(__dirname, 'scenarios'));
  // 端口真源由 main.js 传入（BASE）；独立跑时不写死 3083，缺省交给 DSH_GUI_BASE / DSH_WEB_URL。
  const base = String(opt.base || process.env.DSH_GUI_BASE || process.env.DSH_WEB_URL || '');
  const getToken = typeof opt.getToken === 'function' ? opt.getToken : function () { return process.env.DSH_TOKEN || ''; };
  const scriptEnv = typeof opt.env === 'function' ? opt.env : function (extra) { return Object.assign({}, process.env, extra || {}); };
  const log = typeof opt.log === 'function' ? opt.log : function () {};
  const builder = path.join(__dirname, 'scripts', '建会话.mjs');
  let cookieLib = null;
  let chain = Promise.resolve();

  function readConfig() {
    const c = asRoutes(readJson(CONF_FILE) || {});
    return c;
  }

  function socialMap() {
    const m = socialReply.readSessions();
    return m && m.sessions && typeof m.sessions === 'object' ? m : { version: 1, sessions: {} };
  }

  function petSessionId() {
    const p = readJson(path.join(scenariosDir, 'pet.json')) || {};
    const panel = (Array.isArray(p.panels) ? p.panels : []).filter(function (x) { return x && x.id === 'pet-ai'; })[0];
    return String((panel && panel.sessionId) || '');
  }

  function routeCounts(cfg) {
    const out = {};
    for (const kind of ['private', 'group']) {
      for (const id of Object.keys((cfg.routes && cfg.routes[kind]) || {})) {
        const sid = String(cfg.routes[kind][id] && cfg.routes[kind][id].sessionId || '');
        if (sid) out[sid] = (out[sid] || 0) + 1;
      }
    }
    return out;
  }

  function rowOf(cfg, kind, id, petSid, counts) {
    const r = (cfg.routes[kind] || {})[id] || {};
    const sid = String(r.sessionId || '');
    const m = socialMap().sessions[sid] || {};
    const shared = !!sid && (sid === petSid || (counts[sid] || 0) > 1);
    return {
      kind: kind,
      id: String(id),
      sessionId: sid,
      sessionTitle: String(m.title || m.sessionTitle || ''),
      chatTitle: String(m.chatTitle || r.prefix || ''),
      prefix: String(r.prefix || ''),
      independent: !!sid && !shared,
      shared: shared,
      unbound: !sid
    };
  }

  async function getCookie() {
    if (!cookieLib) {
      process.env.DSH_HOME = dshHome;
      process.env.DSH_WEB_URL = base;
      cookieLib = await import(pathToFileURL(path.join(__dirname, '..', '工具', '派发-公共.mjs')).href);
    }
    return cookieLib.getCookie();
  }

  async function saveRoutes(routes, groupUins) {
    // 1. 优先插件自己的保存接口：它同时改内存 + 文件，下一轮投递就生效
    try {
      const cookie = await getCookie();
      if (!cookie) throw new Error('换不到引擎 cookie（引擎没就绪或 token 失效）');
      const r = await fetch(base + '/api/qq-bridge/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', cookie: cookie },
        body: JSON.stringify({ routes: routes, groupUins: groupUins || [] })
      });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
      if (!r.ok || !j || j.ok !== true) throw new Error('QQ 桥接接口拒绝（HTTP ' + r.status + '）：' + String((j && j.error) || text).slice(0, 160));
      return { ok: true, live: true };
    } catch (e) {
      // 2. 接口不可用（例如引擎还没起）就写文件；明确标出来「要重启整壳」
      const cfg = readConfig();
      cfg.routes = routes;
      if (groupUins !== undefined) cfg.groupUins = groupUins;
      backup(CONF_FILE);
      writeAtomic(CONF_FILE, cfg);
      return { ok: true, live: false, restartRequired: true, error: String((e && e.message) || e) };
    }
  }

  function createSession(title, cwd) {
    return new Promise(function (resolve, reject) {
      const args = [builder, '--title', title];
      if (cwd) args.push('--cwd', cwd);
      const env = scriptEnv({ DSH_GUI_BASE: base, DSH_HOME: dshHome });
      execFile(process.execPath, args, {
        cwd: __dirname,
        env: env,
        timeout: 90000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      }, function (err, stdout, stderr) {
        if (err) {
          reject(new Error('建会话失败：' + String((stderr || stdout || err.message || err) || '').trim().slice(0, 300)));
          return;
        }
        const m = String((stdout || '').match(/sessionId\s*=\s*(\S+)/));
        if (!m || !m[1]) { reject(new Error('建会话没返回 sessionId：' + String(stdout || '').slice(-200))); return; }
        resolve(String(m[1]));
      });
    });
  }

  function markSession(sid, kind, id, chatTitle, sessionTitle, account) {
    const m = socialMap();
    m.sessions[sid] = {
      scene: PET_NAME,
      panel: '',
      channel: QQ_KEY,
      account: String(account || ''),
      chatType: kind,
      chatId: id,
      chatTitle: chatTitle,
      title: sessionTitle,
      senderName: '',
      chatMode: 'per-chat',
      updatedAt: Date.now()
    };
    socialReply.writeSessions(m, dshHome);
  }

  function dropSessionMark(sid) {
    const m = socialMap();
    if (sid && m.sessions[sid]) {
      delete m.sessions[sid];
      socialReply.writeSessions(m, dshHome);
    }
  }

  function status() {
    const cfg = readConfig();
    const petSid = petSessionId();
    const counts = routeCounts(cfg);
    const rows = [];
    for (const kind of ['private', 'group']) {
      for (const id of Object.keys((cfg.routes && cfg.routes[kind]) || {})) rows.push(rowOf(cfg, kind, id, petSid, counts));
    }
    return {
      ok: true,
      petSessionId: petSid,
      selfUin: String(cfg.selfUin || ''),
      routes: rows,
      shared: rows.filter(function (r) { return r.shared; }).length,
      independent: rows.filter(function (r) { return r.independent; }).length,
      groups: rows.filter(function (r) { return r.kind === 'group'; }).length,
      privates: rows.filter(function (r) { return r.kind === 'private'; }).length
    };
  }

  async function add(input) {
    const a = input || {};
    const kind = String(a.kind || 'private') === 'group' ? 'group' : 'private';
    const id = digits(a.id);
    const name = String(a.name || '').trim().slice(0, 40);
    if (!/^\d{5,12}$/.test(id)) throw new Error('QQ ' + (kind === 'group' ? '群号' : '号') + '要是 5–12 位数字');
    return run(async function () {
      const cfg = readConfig();
      const petSid = petSessionId();
      const counts = routeCounts(cfg);
      const old = cfg.routes[kind][id];
      const sid0 = String(old && old.sessionId || '');
      // 已经是唯一、非人格会话 ⇒ 复用，不重复建
      if (sid0 && sid0 !== petSid && (counts[sid0] || 0) === 1) {
        markSession(sid0, kind, id, chatTitleFor(kind, id, name), String((socialMap().sessions[sid0] || {}).title || titleFor(kind, id, name)), cfg.selfUin);
        return { ok: true, reused: true, route: rowOf(readConfig(), kind, id, petSid, routeCounts(readConfig())) };
      }
      const sessionTitle = titleFor(kind, id, name);
      const sid = await createSession(sessionTitle, String(cfg.workspaceCwd || ''));
      cfg.routes[kind][id] = Object.assign({}, old || {}, {
        sessionId: sid,
        prefix: String((old && old.prefix) || defaultPrefix(kind, cfg))
      });
      const groupUins = kind === 'group' ? Object.keys(cfg.routes.group) : cfg.groupUins;
      const saved = await saveRoutes(cfg.routes, groupUins);
      markSession(sid, kind, id, chatTitleFor(kind, id, name), sessionTitle, cfg.selfUin);
      try { socialReply.syncQqSessions(dshHome); } catch (e) { log('[qq-chat] 社交会话镜像同步失败: ' + ((e && e.message) || e)); }
      return { ok: true, created: true, route: rowOf(readConfig(), kind, id, petSid, routeCounts(readConfig())), saved: saved };
    });
  }

  async function ensureAll() {
    return run(async function () {
      const cfg = readConfig();
      const petSid = petSessionId();
      const counts = routeCounts(cfg);
      let changed = false;
      for (const kind of ['private', 'group']) {
        for (const id of Object.keys((cfg.routes && cfg.routes[kind]) || {})) {
          const r = cfg.routes[kind][id];
          const sid = String(r && r.sessionId || '');
          const isShared = !sid || sid === petSid || (counts[sid] || 0) > 1;
          if (!isShared) {
            // 已有独立会话：只补社交会话表（名字沿用旧表，避免每次启动把它改回默认前缀）
            const old = socialMap().sessions[sid] || {};
            const oldName = String(old.chatTitle || '');
            const name = oldName && !/^（QQ/.test(oldName) ? oldName : '';
            markSession(sid, kind, id,
              name || chatTitleFor(kind, id, ''),
              String(old.title || titleFor(kind, id, name)),
              cfg.selfUin);
            continue;
          }
          const old = socialMap().sessions[sid] || {};
          const oldName = String(old.chatTitle || '');
          const name = oldName && !/^（QQ/.test(oldName) ? oldName : '';
          const sessionTitle = titleFor(kind, id, name);
          const newSid = await createSession(sessionTitle, String(cfg.workspaceCwd || ''));
          cfg.routes[kind][id] = Object.assign({}, r, {
            sessionId: newSid,
            prefix: String(r.prefix || defaultPrefix(kind, cfg))
          });
          counts[newSid] = 1;
          markSession(newSid, kind, id,
            name || chatTitleFor(kind, id, ''),
            sessionTitle, cfg.selfUin);
          changed = true;
        }
      }
      let saved = null;
      if (changed) {
        const groupUins = Object.keys(cfg.routes.group);
        saved = await saveRoutes(cfg.routes, groupUins);
        try { socialReply.syncQqSessions(dshHome); } catch (e) { log('[qq-chat] 社交会话镜像同步失败: ' + ((e && e.message) || e)); }
        log('[qq-chat] 已把 ' + (changed ? '共用/重复路由迁成独立会话' : '路由') + '：' + JSON.stringify(saved));
      }
      return { ok: true, changed: changed, saved: saved, status: status() };
    });
  }

  async function remove(input) {
    const a = input || {};
    const kind = String(a.kind || 'private') === 'group' ? 'group' : 'private';
    const id = digits(a.id);
    return run(async function () {
      const cfg = readConfig();
      const old = (cfg.routes[kind] || {})[id];
      if (!old) return { ok: true, removed: false };
      delete cfg.routes[kind][id];
      const groupUins = kind === 'group' ? Object.keys(cfg.routes.group) : cfg.groupUins;
      const saved = await saveRoutes(cfg.routes, groupUins);
      // 只回收「这条 route 独占、且不是人格主会话」的社交会话标记；
      // 共用主会话 / 别的 route 还在用的 session 不能删，否则会把别人的名字/场景抹掉。
      const sid = String(old.sessionId || '');
      const stillUsed = ['private', 'group'].some(function (k) {
        return Object.keys(cfg.routes[k] || {}).some(function (x) {
          return String((cfg.routes[k][x] && cfg.routes[k][x].sessionId) || '') === sid;
        });
      });
      if (sid && sid !== petSessionId() && !stillUsed) dropSessionMark(sid);
      try { socialReply.syncQqSessions(dshHome); } catch (e) { log('[qq-chat] 社交会话镜像同步失败: ' + ((e && e.message) || e)); }
      return { ok: true, removed: true, saved: saved };
    });
  }

  function run(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(function () {});
    return next;
  }

  function contacts() {
    const cfg = readConfig();
    if (!cfg.onebotHttp) return Promise.resolve({ ok: false, error: 'QQ 协议端地址为空' });
    async function call(action) {
      const r = await fetch(String(cfg.onebotHttp), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(cfg.token || '') },
        body: JSON.stringify({ action: action }),
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) throw new Error('OneBot HTTP ' + r.status);
      const j = await r.json();
      if (j && j.retcode !== 0) throw new Error('OneBot ' + action + ' 返回 retcode ' + j.retcode);
      return Array.isArray(j && j.data) ? j.data : [];
    }
    return Promise.all([call('get_friend_list'), call('get_group_list')]).then(function (arr) {
      const friends = (arr[0] || []).map(function (x) {
        return { id: digits(x.user_id), name: String(x.nickname || x.remark || '') };
      }).filter(function (x) { return x.id; });
      const groups = (arr[1] || []).map(function (x) {
        return { id: digits(x.group_id), name: String(x.group_name || '') };
      }).filter(function (x) { return x.id; });
      return { ok: true, friends: friends, groups: groups };
    }).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
  }

  return { status: status, add: add, ensureAll: ensureAll, remove: remove, contacts: contacts, configFile: CONF_FILE };
}

module.exports = { createService: createService, CONF_FILE: CONF_FILE };
