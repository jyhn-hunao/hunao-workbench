// 程序开发场景「项目下拉」的后端：列出项目 → 把 AI 面板切到该项目的会话。
//
// 为什么单独一个文件（而不是继续往 main.js 里塞）：
//   ① main.js 已经 260KB，再加两百行没人能一眼看全；
//   ② 这里的判断要能脱离 Electron 单测（scripts\项目切换自检.mjs 直接 require 本文件）；
//   ③ 以后命令行脚本要复用同一套口径，不必复制粘贴。
//
// 口径（与 code-dev.json 的场景说明、场景私有记忆 2026-11-10 的决策一致）：
//   · 一个项目 = 一条会话，会话 cwd = 项目根（那个仓的 AGENTS.md 因此自动生效）；
//   · 「换项目」= 把场景 json 里 AI 面板的 sessionId / sessionTitle / pinTarget 指向那条会话，
//     同时把 Git 面板的 repo 换到项目根，并把定位卡与场景索引里的「当前项目 / 会话 id」同步掉；
//   · 没有会话的项目**不硬切**：返回 needOnboard，让人先跑 接入项目.mjs（不静默兜底）；
//   · 项目根不是 git 仓库时**不动 Git 面板**，把原因放进 warnings（不假装切好了）。
//
// 纯函数优先：文件读写由调用方注入 fsx（main 用 fs，测试用内存/临时目录），本文件不 require('fs')。
'use strict';

const path = require('path');

// ---------- 路径与 JSON ----------
function norm(p) {
  return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

function readJson(fsx, p) {
  const t = fsx.readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

function uniq(list) {
  const out = [];
  for (const x of list) {
    const v = String(x == null ? '' : x).trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

// ---------- 会话索引：逐会话文件（真源）+ 总表（补齐） ----------
function collectSessions(fsx, dshHome) {
  const out = new Map();
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  for (const f of (fsx.readDir(dir) || [])) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(fsx, path.join(dir, f));
    const rec = j && j.record;
    if (!rec) continue;
    const rows = rec.rows || {};
    out.set(f.replace(/\.json$/, ''), {
      id: f.replace(/\.json$/, ''),
      title: String((rows.title && rows.title.val) || '').trim(),
      cwd: String((rec.identity && rec.identity.cwd) || ''),
      createdAt: Number((rec.identity && rec.identity.createdAt) || 0)
    });
  }
  const total = readJson(fsx, path.join(dshHome, 'storages', 'session_projcache.json'));
  const tbl = total && total.tables && total.tables.sessions;
  if (tbl && typeof tbl === 'object') {
    for (const id of Object.keys(tbl)) {
      if (out.has(id)) continue;
      const v = tbl[id] || {};
      const rows = v.rows || {};
      out.set(id, {
        id,
        title: String((rows.title && rows.title.val) || '').trim(),
        cwd: String((v.identity && v.identity.cwd) || ''),
        createdAt: Number((v.identity && v.identity.createdAt) || 0)
      });
    }
  }
  return out;
}

// 一个项目该用哪条会话：① 面板当前会话（若属于这个项目，切回来不动）→ ② 标题与项目名逐字相等
// → ③ 与面板记着的会话标题相等 → ④ 标题包含关系唯一命中 → ⑤ 最近建的那条。
// 空标题的会话（引擎里叫「无标题」）排在最后：它没法当 pinTarget 用。
function pickSession(pool, name, currentId, currentTitle) {
  if (!pool.length) return null;
  if (currentId) {
    const hit = pool.filter((s) => s.id === currentId)[0];
    if (hit) return hit;
  }
  const titled = pool.filter((s) => s.title);
  const cand = titled.length ? titled : pool;
  const exact = cand.filter((s) => s.title === name);
  if (exact.length) return exact[0];
  if (currentTitle) {
    const byOld = cand.filter((s) => s.title === currentTitle)[0];
    if (byOld) return byOld;
  }
  const fuzzy = cand.filter((s) => s.title && (s.title.indexOf(name) >= 0 || name.indexOf(s.title) >= 0));
  if (fuzzy.length === 1) return fuzzy[0];
  return cand[0];
}

// ---------- 扫描同级目录：把"还没接入的项目"也列出来 ----------
// 为什么要有：只列已登记项目的话，用户装完这个功能也只看到一条（他自己只接了一个项目），
// 等于还是没法切。这里沿用 接入项目.mjs 的同一个根（项目父目录），只认有工程标志的目录。
var PROJECT_MARKERS = ['.git', 'AGENTS.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
function scanProjects(fsx, currentRoot, exclude) {
  if (!currentRoot) return [];
  const parent = path.dirname(currentRoot);
  if (!parent || parent === currentRoot) return [];
  const skip = new Set((exclude || []).map(norm));
  const kids = fsx.readDir(parent);
  if (!kids || !kids.length || kids.length > 200) return [];   // 盘根之类的大目录不扫
  const out = [];
  for (const name of kids) {
    if (/^[._]/.test(name) || name === 'node_modules') continue;
    const dir = path.join(parent, name);
    if (skip.has(norm(dir))) continue;                         // 壳自己 / 工作台根：不是"可干活的项目"
    let isDir = false;
    try { isDir = typeof fsx.isDir === 'function' ? fsx.isDir(dir) : true; } catch (e) { isDir = false; }
    if (!isDir) continue;
    let marker = false;
    for (const m of PROJECT_MARKERS) {
      try { if (fsx.exists(path.join(dir, m))) { marker = true; break; } } catch (e) { /* next */ }
    }
    if (!marker) continue;
    out.push({ name: name, root: dir });
  }
  return out;
}

// ---------- 场景 json 的定点改写 ----------
// 为什么不用 JSON.parse → stringify：那会把整个文件重排（pinTarget / homeFolders 这些行内数组会被拆成多行），
// 每次切换都产生一大片无意义 diff。这里只改目标面板对象里的那几个值，其余字节原样保留。
function findObjectRangeById(text, id) {
  const n = text.length;
  let inStr = false, esc = false, strStart = 0, key = null;
  const stack = [];
  let found = null;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c !== '"') continue;
      inStr = false;
      const s = text.slice(strStart, i);
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === ':') { key = s; continue; }          // 这是键
      if (key === 'id' && s === id && stack.length) {       // 这是目标对象的 id 值
        found = { start: stack[stack.length - 1], depth: stack.length };
      }
      key = null;
      continue;
    }
    if (c === '"') { inStr = true; esc = false; strStart = i + 1; continue; }
    if (c === '{') { stack.push(i); continue; }
    if (c === '}') {
      const depth = stack.length;
      stack.pop();
      if (found && depth === found.depth) return { start: found.start, end: i };
    }
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 在一个面板对象块里改若干字段；字段不存在就直接失败（宁可不写，也不留半个配置）。
function setKeys(block, values) {
  let out = block;
  for (const k of Object.keys(values)) {
    const re = new RegExp('("' + escapeRe(k) + '"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\]|true|false|null|-?\\d+(?:\\.\\d+)?)');
    if (!re.test(out)) return { ok: false, err: '这个面板没有 "' + k + '" 字段' };
    out = out.replace(re, function (m, head) { return head + values[k]; });
  }
  return { ok: true, text: out };
}

function patchScenario(text, opts) {
  let scene;
  try { scene = JSON.parse(text); } catch (e) { return { ok: false, err: '场景 JSON 解析失败：' + e.message }; }
  const panels = Array.isArray(scene.panels) ? scene.panels : [];
  const target = panels.filter((p) => p.type === 'harness' && (!opts.panelId || p.id === opts.panelId))[0]
    || panels.filter((p) => p.type === 'harness')[0];
  if (!target) return { ok: false, err: '场景里没有 harness 面板' };

  const warnings = [];
  const range = findObjectRangeById(text, target.id);
  if (!range) return { ok: false, err: '定位不到面板对象：' + target.id };

  // 按仓库现有写法（逗号后留一个空格）拼，避免切换一次就把整行格式改掉。
  // 第二项沿用 接入项目.mjs 的约定 = 场景名（程序开发），作为标题匹配不到时的兜底候选。
  const pin = '[' + uniq([opts.sessionTitle, opts.sceneName]).map(function (x) { return JSON.stringify(x); }).join(', ') + ']';
  const patched = setKeys(text.slice(range.start, range.end + 1), {
    sessionId: JSON.stringify(opts.sessionId),
    sessionTitle: JSON.stringify(opts.sessionTitle),
    pinTarget: pin
  });
  if (!patched.ok) return { ok: false, err: patched.err + '（面板 ' + target.id + '）' };

  let out = text.slice(0, range.start) + patched.text + text.slice(range.end + 1);

  // Git 面板：只在该项目根确实是 git 仓库时跟着换
  const isGit = typeof opts.isGit === 'function' ? opts.isGit(opts.gitRoot) : true;
  for (const g of panels.filter((p) => p.type === 'git')) {
    if (!Object.prototype.hasOwnProperty.call(g, 'repo')) continue;
    if (!isGit) { warnings.push('Git 面板仍指向 ' + g.repo + '（' + opts.gitRoot + ' 不是 git 仓库）'); continue; }
    const gr = findObjectRangeById(out, g.id);
    if (!gr) { warnings.push('Git 面板没定位到：' + g.id); continue; }
    const gp = setKeys(out.slice(gr.start, gr.end + 1), { repo: JSON.stringify(opts.gitRoot) });
    if (!gp.ok) { warnings.push('Git 面板没改：' + gp.err); continue; }
    out = out.slice(0, gr.start) + gp.text + out.slice(gr.end + 1);
  }

  // 写完先自证：JSON 仍合法且目标字段真的变了
  let check;
  try { check = JSON.parse(out); } catch (e) { return { ok: false, err: '改写后 JSON 不合法（未写入）：' + e.message }; }
  const p2 = (check.panels || []).filter((p) => p.id === target.id)[0];
  if (!p2 || p2.sessionId !== opts.sessionId || p2.sessionTitle !== opts.sessionTitle) {
    return { ok: false, err: '改写后的字段与预期不一致（未写入）' };
  }
  return { ok: true, text: out, warnings };
}

// ---------- 定位卡 / 场景索引的同步点 ----------
// 定位卡 §一 两行：当前项目、会话 id；场景索引表一行：会话名、会话 id。
// 只改这两处已知的行，其余正文（含历史记录里的旧 id）一律不动。
function patchContextCard(text, opts) {
  const name = String(opts.name || '').trim();
  const sid = String(opts.sessionId || '').trim();
  let out = text, changed = false;
  const notes = [];
  const nameRe = /(\|\s*当前项目（pinTarget 首项）\s*\|\s*`)([^`]*)`/;
  if (nameRe.test(out)) {
    const n = out.replace(nameRe, function (m, head) { return head + name + '`'; });
    if (n !== out) { out = n; changed = true; }
  } else {
    notes.push('定位卡里没有「当前项目（pinTarget 首项）」行');
  }
  const idRe = /(\|\s*会话 id\s*\|\s*`)([^`]*)`/;
  if (idRe.test(out)) {
    const n = out.replace(idRe, function (m, head) { return head + sid + '`'; });
    if (n !== out) { out = n; changed = true; }
  } else {
    notes.push('定位卡里没有「会话 id」行');
  }
  return { changed, text: out, notes };
}

function patchIdentityIndex(text, opts) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';   // 按原行尾回写：这个文件是 CRLF，整篇用 \n 拼会变成全文件 diff
  const lines = text.split(/\r?\n/);
  const tag = '`' + opts.sceneId + '`';
  const notes = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split('|');
    if (cells.length < 7) continue;
    if (cells[1].trim() !== tag) continue;
    cells[4] = ' ' + opts.name + ' ';
    cells[5] = ' `' + opts.sessionId + '` ';
    lines[i] = cells.join('|');
    return { changed: true, text: lines.join(eol), notes };
  }
  notes.push('场景索引表里没有 ' + opts.sceneId + ' 这一行');
  return { changed: false, text, notes };
}

// ---------- 服务：list / switchTo ----------
function createService(ctx) {
  const fsx = ctx.fsx;
  const scenariosDir = ctx.scenariosDir;
  const dshHome = ctx.dshHome;

  function projectList(sceneId, panelId) {
    const sceneFile = path.join(scenariosDir, sceneId + '.json');
    const sceneText = fsx.readText(sceneFile);
    if (sceneText == null) return { ok: false, err: '场景文件读不到：' + sceneFile };
    let scene;
    try { scene = JSON.parse(sceneText); } catch (e) { return { ok: false, err: '场景 JSON 解析失败：' + e.message }; }
    const sceneName = String(scene.name || sceneId);
    const panels = Array.isArray(scene.panels) ? scene.panels : [];
    const panel = (panelId && panels.filter((p) => p.id === panelId && p.type === 'harness')[0])
      || panels.filter((p) => p.type === 'harness')[0];
    if (!panel) return { ok: false, err: '场景 ' + sceneId + ' 里没有 harness 面板' };

    const reg = readJson(fsx, path.join(dshHome, '场景记忆', '_共享记忆', '项目.json')) || {};
    const ws = readJson(fsx, path.join(dshHome, 'storages', 'workspace.json')) || {};
    const sessions = collectSessions(fsx, dshHome);
    const archived = new Set((ws.global && ws.global.archivedSessionIds) || []);
    const wsTable = (ws.tables && ws.tables.workspaces) || {};

    const byRoot = new Map();
    for (const p of (reg.projects || [])) {
      const root = (p.paths || [])[0];
      if (!root) continue;
      const owner = String(p.owner || '');
      // 登记表是全局的；别的场景的项目不进本场景的下拉（owner 空 = 不挑场景）
      if (owner && owner !== sceneName && owner !== sceneId) continue;
      byRoot.set(norm(root), { name: String(p.name || path.basename(root)), root: root, registered: true, owner: owner });
    }
    for (const id of Object.keys(wsTable)) {
      const w = wsTable[id] || {};
      const root = String(w.path || '');
      if (!root) continue;
      const hit = byRoot.get(norm(root));
      const ids = Array.isArray(w.sessionIds) ? w.sessionIds : [];
      if (hit) { hit.workspaceId = id; hit.sessionIds = ids; }
      else byRoot.set(norm(root), { name: String(w.title || path.basename(root)), root: root, registered: false, owner: '', workspaceId: id, sessionIds: ids });
    }

    const currentId = String(panel.sessionId || '');
    const currentTitle = String(panel.sessionTitle || '').trim();

    // 扫同级目录：只补"还没有工作区/没登记"的项目；已有的不覆盖。
    // 目录来源 = 当前面板会话的 cwd（也就是当前项目根）的父目录。
    const curSession = sessions.get(currentId);
    const curRoot = (curSession && curSession.cwd) || '';
    if (curRoot && ctx.scan !== false) {
      for (const d of scanProjects(fsx, curRoot, ctx.exclude)) {
        const k = norm(d.root);
        if (byRoot.has(k)) continue;
        byRoot.set(k, { name: d.name, root: d.root, registered: false, discovered: true, owner: '', sessionIds: [] });
      }
    }

    const list = [];
    for (const item of byRoot.values()) {
      const pool = [];
      const seen = new Set();
      for (const [id, s] of sessions) {
        if (archived.has(id)) continue;
        const inWs = item.sessionIds && item.sessionIds.indexOf(id) >= 0;
        const sameCwd = s.cwd && norm(s.cwd) === norm(item.root);
        if (!inWs && !sameCwd) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        pool.push(s);
      }
      pool.sort((a, b) => b.createdAt - a.createdAt);
      const chosen = pickSession(pool, item.name, currentId, currentTitle);
      // 没标题的会话（引擎里的「无标题」）不能当钉子用：pinTarget 只能靠标题认人
      const usable = chosen && chosen.title ? chosen : null;
      list.push(Object.assign({}, item, {
        hasSession: !!usable,
        sessionId: usable ? usable.id : '',
        sessionTitle: usable ? usable.title : '',
        sessionCount: pool.length,
        current: !!usable && usable.id === currentId
      }));
    }
    list.sort(function (a, b) {
      if (a.registered !== b.registered) return a.registered ? -1 : 1;
      if (a.hasSession !== b.hasSession) return a.hasSession ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
    return {
      ok: true,
      sceneId: sceneId,
      sceneName: sceneName,
      panelId: panel.id,
      current: list.filter((p) => p.current)[0] || null,
      projects: list
    };
  }

  function switchTo(sceneId, panelId, root) {
    const res = projectList(sceneId, panelId);
    if (!res.ok) return res;
    const item = res.projects.filter((p) => norm(p.root) === norm(root))[0];
    if (!item) return { ok: false, notListed: true, err: '项目列表里没有这个目录：' + root };
    if (!item.sessionId || !item.sessionTitle) {
      return {
        ok: false,
        needOnboard: true,
        root: item.root,
        name: item.name,
        err: !item.sessionId
          ? '「' + item.name + '」还没有可用会话：先跑 node 外壳\\scripts\\接入项目.mjs --root "' + item.root + '"'
          : '「' + item.name + '」的会话没有标题（引擎里叫「无标题」），没法钉：先跑 node 外壳\\scripts\\接入项目.mjs --root "' + item.root + '" 建一条有标题的会话'
      };
    }

    const sceneFile = path.join(scenariosDir, sceneId + '.json');
    const text = fsx.readText(sceneFile);
    if (text == null) return { ok: false, err: '场景文件读不到：' + sceneFile };
    const patched = patchScenario(text, {
      panelId: res.panelId,
      sessionId: item.sessionId,
      sessionTitle: item.sessionTitle,
      sceneName: res.sceneName || sceneId,
      gitRoot: item.root,
      isGit: function (p) { return fsx.exists(path.join(p, '.git')); }
    });
    if (!patched.ok) return patched;
    fsx.writeText(sceneFile, patched.text);

    const docs = [];
    const cardFile = path.join(scenariosDir, sceneId + '-context.md');
    if (fsx.exists(cardFile)) {
      const r = patchContextCard(fsx.readText(cardFile) || '', { name: item.name, sessionId: item.sessionId });
      if (r.changed) fsx.writeText(cardFile, r.text);
      docs.push({ file: cardFile, changed: r.changed, notes: r.notes });
    }
    const idxFile = path.join(scenariosDir, '_场景身份索引.md');
    if (fsx.exists(idxFile)) {
      const r = patchIdentityIndex(fsx.readText(idxFile) || '', { sceneId: sceneId, name: item.sessionTitle || item.name, sessionId: item.sessionId });
      if (r.changed) fsx.writeText(idxFile, r.text);
      docs.push({ file: idxFile, changed: r.changed, notes: r.notes });
    }

    return {
      ok: true,
      sceneId: sceneId,
      panelId: res.panelId,
      project: { name: item.name, root: item.root, registered: !!item.registered },
      panel: { sessionId: item.sessionId, sessionTitle: item.sessionTitle },
      docs: docs,
      warnings: patched.warnings
    };
  }

  return { list: projectList, switchTo: switchTo };
}

module.exports = {
  norm: norm,
  uniq: uniq,
  collectSessions: collectSessions,
  pickSession: pickSession,
  findObjectRangeById: findObjectRangeById,
  setKeys: setKeys,
  patchScenario: patchScenario,
  patchContextCard: patchContextCard,
  patchIdentityIndex: patchIdentityIndex,
  createService: createService
};
