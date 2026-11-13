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
// 人格卡现状：设置弹窗要能一眼看到「她是谁 / 记了多少」，而不是让人去翻目录（2026-11-13）
function personaStats() {
  let st = {};
  try { st = getSettings() || {}; } catch (e) { st = {}; }
  const name = String((st.persona && st.persona.name) || '胡闹的大肥鱼');
  const dir = path.join(DSH_HOME, '场景记忆', name);
  const countMd = (sub) => {
    try {
      return fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.md') && !f.startsWith('_')).length;
    } catch (e) { return 0; }
  };
  const bytes = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
  let todo = 0;
  try {
    const t = fs.readFileSync(path.join(dir, '_待办.md'), 'utf8');
    todo = (t.match(/^\s*- \[ \]/gm) || []).length;
  } catch (e) { todo = 0; }
  return {
    name,
    dir,
    exists: fs.existsSync(dir),
    记忆: countMd('记忆'),
    对话: countMd('对话'),
    决策: countMd('决策'),
    坑: countMd('坑'),
    待办: todo,
    私忆字节: bytes(path.join(dir, '场景私有记忆.md')),
    近期字节: bytes(path.join(dir, '_近期.md')),
  };
}
function petSession() {
  const j = readJson(path.join(SHELL, 'scenarios', 'pet.json')) || {};
  const p = (j.panels || []).filter((x) => x && x.id === 'pet-ai')[0] || {};
  return { sessionId: String(p.sessionId || ''), sessionTitle: String(p.sessionTitle || '') };
}

// 5.5 可派活的场景清单：给设置弹窗的「派给谁」下拉用，免去手写会话标题（2026-11-13）
//     只收有 sessionTitle 的 AI 面板；人格自己那条排除掉（自己派给自己没意义）。
function listScenes() {
  const dir = path.join(SHELL, 'scenarios');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch (e) { return out; }
  for (const f of files) {
    const j = readJson(path.join(dir, f));
    if (!j || !Array.isArray(j.panels)) continue;
    for (const p of j.panels) {
      if (!p || !p.sessionTitle) continue;
      if (String(j.id) === 'pet') continue;
      if (String(p.type) === 'chan') continue;          // 通道卡片不是人，别出现在下拉里
      out.push({ scene: String(j.name || j.id || f), panelId: String(p.id || ''), title: String(p.sessionTitle) });
    }
  }
  const seen = {};
  return out.filter((x) => (seen[x.title] ? false : (seen[x.title] = true)));
}

// 6. 审批策略：一处判定，所有入口（桌宠.mjs 派 / 未来面板按钮 / 定时任务）都调它，别各写一份
//    输入：text 原话、rv 路由命中 {to, level}、settings
//    输出：{ level: read|confirm|never, reason, confirm: 需不需要人点头 }
//    规则（顺序即优先级）：
//      a) 通道来的一律降一级（QQ/飞书 前缀）——防止「那头的我」指使她改仓库/对外发消息
//      b) 路由自带的 never 最高
//      c) 全局 approval.read !== auto 时，连 read 级也要确认
const CHANNEL_PREFIX = [/^（QQ/, /^（飞书/, /^\[QQ/, /^\[飞书/];
function channelOf(text) {
  const t = String(text || '');
  for (const re of CHANNEL_PREFIX) if (re.test(t)) return 'im';
  return '';
}
function dispatchPolicy(text, rv, settings) {
  const s = settings || getSettings();
  const ap = s.approval || {};
  const rank = { read: 0, confirm: 1, never: 2 };
  const base = rank[(rv && rv.level) || 'confirm'];
  let level = base == null ? 1 : base;
  const reasons = [];
  if (channelOf(text)) {
    level = Math.min(2, level + 1);
    reasons.push('来自外部通道的指令，权限降一级');
  }
  if ((ap.read || 'auto') !== 'auto' && level === 0) {
    level = 1;
    reasons.push('设置里「只看资料」也要求先问');
  }
  if (level >= 2) return { level: 'never', confirm: false, reason: reasons.concat('该场景被设为禁止').join('；') };
  return { level: level === 1 ? 'confirm' : 'read', confirm: level === 1, reason: reasons.join('；') || '按路由级别执行' };
}

// 7. 主动闸门：档位 + 免打扰 + 每小时上限（计数落盘，跨进程有效）
//    为什么不在插件里改：主动钟在第三方插件内，改它等于改引擎依赖；这里给「能不能开口」的硬判据 + 次数账。
const PROACTIVE_STATE = path.join(SHELL, 'data', 'pet', '主动记录.json');
function proactiveGate(settings, opts) {
  const s = settings || getSettings();
  const o = opts || {};
  const now = o.now ? new Date(o.now) : new Date();
  const p = String((s.persona || {}).proactive || 'low');
  if (p === 'low') return { ok: false, reason: '档位是「少吭声」（只答不说）' };
  const q = s.quiet || {};
  const toMin = (x) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const hh = now.getHours() * 60 + now.getMinutes();
  const a = toMin(q.from), b = toMin(q.to);
  if (a != null && b != null) {
    const inside = a <= b ? (hh >= a && hh < b) : (hh >= a || hh < b);
    if (inside) return { ok: false, reason: '免打扰时段（' + q.from + '–' + q.to + '）' };
  }
  const cap = Number(q.proactiveMaxPerHour == null ? 2 : q.proactiveMaxPerHour);
  const stateFile = o.stateFile || PROACTIVE_STATE;
  const st = readJson(stateFile) || {};
  const hourKey = now.getFullYear() + '-' + String(now.getMonth() + 1) + '-' + now.getDate() + 'T' + now.getHours();
  const used = Number((st.hours || {})[hourKey] || 0);
  if (cap > 0 && used >= cap) return { ok: false, reason: '这一小时已主动 ' + used + '/' + cap + ' 次', used, cap };
  // record=true 才记账（查询不该消耗额度）
  if (o.record) {
    const hours = st.hours || {};
    hours[hourKey] = used + 1;
    const keys = Object.keys(hours).sort().slice(-48);      // 只留最近 48 个小时桶，文件不会越长越大
    const keep = {};
    for (const k of keys) keep[k] = hours[k];
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hours: keep, last: now.toISOString() }, null, 2), 'utf8');
  }
  return { ok: true, reason: '可以主动开口（本小时 ' + (o.record ? used + 1 : used) + '/' + cap + '）', used: o.record ? used + 1 : used, cap };
}

module.exports = {
  DEFAULT_FILE, DATA_FILE, DSH_HOME,
  getSettings, setSettings, resolveRoute,
  logPath, logDispatch, tailLog,
  petSession, listScenes, personaStats,
  channelOf, dispatchPolicy, proactiveGate
};
