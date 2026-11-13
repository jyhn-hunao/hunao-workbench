// 桌宠设置.js —— 桌宠层的机器可读参数（2026-11-13）
//
// 干什么：给「胡闹的大肥鱼」场景的 petset 面板和 工具\桌宠.mjs 提供同一份配置的读写，
//   并负责「一句话 → 派给哪个场景会话」的路由打分 + 派发日志。
//
// 分工（别把东西塞错地方）：
//   · 人格正文（我是谁 / 语气 / 边界）在 场景记忆\胡闹的大肥鱼\场景私有记忆.md，⛔ 不进这里
//   · 通道凭据 / token 在 %USERPROFILE%\.dsh\qq-bridge.config.json，⛔ 不进这里
//   · 会话 id 在 外壳\scenarios\pet.json（换会话脚本回写），这里只显示不存
//
// 落点：外壳\data\pet\设置.json（本机，整个 外壳/data/ 已 gitignore）；
//   默认值在 外壳\pet\设置.默认.json（入库，可当模板/换机器重建用）。
'use strict';

const fs = require('fs');
const path = require('path');

const SHELL = __dirname;
const ROOT = path.resolve(SHELL, '..');
const DEFAULT_FILE = path.join(SHELL, 'pet', '设置.默认.json');
const DATA_FILE = path.join(SHELL, 'data', 'pet', '设置.json');
const DSH_HOME = process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// 1. 读：默认值打底，运行值覆盖（键缺了就沿用默认，别把面板读成空白）
function getSettings() {
  const def = readJson(DEFAULT_FILE) || {};
  const cur = readJson(DATA_FILE) || {};
  return merge(def, cur);
}

function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = Array.isArray(a) ? a.slice() : Object.assign({}, a || {});
  for (const k of Object.keys(b)) out[k] = merge(out[k], b[k]);
  return out;
}

// 2. 写：只接受认识的结构，原子落盘（先写 .tmp 再改名，避免写一半被面板读到半截 JSON）
const ALLOWED = ['persona', 'tools', 'routes', 'approval', 'channels', 'memory', 'quiet', 'log'];
function setSettings(patch) {
  const cur = getSettings();
  const clean = {};
  for (const k of ALLOWED) if (patch && patch[k] !== undefined) clean[k] = patch[k];
  if (!Object.keys(clean).length) return { ok: false, error: '没有可写的字段（只认 ' + ALLOWED.join(' / ') + '）' };
  const next = merge(cur, clean);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  return { ok: true, settings: next, file: DATA_FILE };
}

// 3. 路由：一句话 → 场景会话
//    打分口径：命中关键词个数多的优先；同分取 routes 里靠前的（配置顺序 = 人的偏好顺序）。
//    认不出就返回 null + 候选（⛔ 不按目录名猜，让调用方列候选问人）。
function resolveRoute(text, settings) {
  const s = settings || getSettings();
  const t = String(text || '');
  if (!t.trim()) return { hit: null, candidates: (s.routes || []).map((r) => r.to) };
  let best = null;
  for (const r of s.routes || []) {
    const kws = (r.keywords || []).filter((k) => k && t.includes(k));
    if (!kws.length) continue;
    if (!best || kws.length > best.n) best = { n: kws.length, route: r, matched: kws };
  }
  return {
    hit: best ? { to: best.route.to, level: best.route.level || 'confirm', matched: best.matched } : null,
    candidates: (s.routes || []).map((r) => r.to)
  };
}

// 4. 派发日志：一行一次，落在人格场景记忆里（面板「最近派发」也从这里读）
function logPath() { return path.join(DSH_HOME, '场景记忆', '胡闹的大肥鱼', '派发日志.md'); }
function ensureLog() {
  const f = logPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, '# 派发日志\n\n> 一行一次：时间 · 命令原话 · 派给谁 · 动作级别 · 结果 · 耗时。只追加。\n\n', 'utf8');
  }
  return f;
}
function logDispatch(entry) {
  const f = ensureLog();
  const e = entry || {};
  const line = '- ' + (e.at || new Date().toISOString())
    + ' · 原话「' + String(e.text || '').replace(/\n/g, ' ') + '」'
    + ' · 派给「' + (e.to || '—') + '」'
    + ' · ' + (e.level || '—')
    + ' · ' + (e.ok ? '✓ ' + String(e.summary || '完成') : '✗ ' + String(e.summary || '失败'))
    + ' · 耗时 ' + (e.ms == null ? '—' : Math.round(e.ms) + 'ms')
    + ' · 单号 ' + (e.ticket || '—') + '\n';
  fs.appendFileSync(f, line, 'utf8');
  return f;
}
function tailLog(n) {
  const f = ensureLog();
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter((x) => x.startsWith('- '));
  return rows.slice(-(Number(n) || 10));
}

// 5. 会话 id 与桥接配置（面板只展示/同步用，不把它存进设置.json）
function petSession() {
  const j = readJson(path.join(SHELL, 'scenarios', 'pet.json')) || {};
  const p = (j.panels || []).filter((x) => x && x.id === 'pet-ai')[0] || {};
  return { sessionId: String(p.sessionId || ''), sessionTitle: String(p.sessionTitle || '') };
}

module.exports = {
  DEFAULT_FILE, DATA_FILE, DSH_HOME,
  getSettings, setSettings, resolveRoute,
  logPath, logDispatch, tailLog,
  petSession
};
