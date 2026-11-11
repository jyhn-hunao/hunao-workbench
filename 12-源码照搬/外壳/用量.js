// 用量.js —— 「这条会话烧了多少 token、该不该换会话」的数据面。
//
// 为什么单独一个文件（而不是继续往 main.js 里塞）：
//   ① main.js 已经 260KB+，再加判断没人看得全；
//   ② 这里的口径要能脱离 Electron 单测（scripts\用量自检.mjs 直接 require 本文件）；
//   ③ 命令行工具 工具\用量账本.mjs 复用同一套函数，不复制一份口径。
//
// 数据源（唯一）：引擎自己写的投影缓存
//   引擎数据\.dsh\storages\session_projcache\sessions\<会话id>.json
//   其中 rows.tokenUsage（累计用量）/ rows.contextPressure（这一步要带多少、窗口多大）
//   / rows.contextBreakdown（system / tools / messages 各占多少）/ rows.sessionStats（步数、轮数）。
//   ⛔ 不走 ctx.mjs：那个技能在本机没装（引擎\.dsh\skills\context-overflow\ 不存在），
//      所以顶栏 2026-10-23 删掉的「压力」胶囊之后，这些数一直没人看。
//
// 口径（与「自我复盘」§五 第 19 条的 token 账一致）：
//   · 上下文 = pressureTokens（引擎上报的「这一步要带上多少」），窗口 = contextWindow（本机 1M）；
//   · 重放率 = 缓存重读 /（缓存重读 + 新增输入 + 输出）—— 今天实测 99.3%；
//   · 分档只看「每步重发多少」和「跑了多少步」：窗口 1M 时 30% 就已经每步 30 万，贵得很。
'use strict';

const path = require('path');

const DEFAULT_WINDOW = 1048576;                       // 本机 deepseek-flash 的窗口（引擎上报值）
const RANK = { ok: 0, warn: 1, over: 2 };
// 分档阈值：测试与调用方可覆盖（别在别处再写一套数字）
const THRESHOLDS = { warnPct: 28, overPct: 45, warnSteps: 100, overSteps: 220 };

// ---------- 基础 ----------
function num(v, d) {
  return (typeof v === 'number' && isFinite(v)) ? v : d;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function projcacheFile(dshHome, sessionId) {
  return path.join(String(dshHome || ''), 'storages', 'session_projcache', 'sessions', String(sessionId || '') + '.json');
}

// ---------- 读一条会话的投影缓存 ----------
// 1. 读文件；读不到 = 引擎还没给这条会话写过用量（新会话 / 从没跑过）
// 2. 解析失败也当没有：宁可显示「没数据」，也不编一个 0
function readRecord(fsx, dshHome, sessionId) {
  const t = fsx.readText(projcacheFile(dshHome, sessionId));
  if (t == null) return null;
  try {
    const j = JSON.parse(t);
    return (j && j.record) ? j.record : null;
  } catch (e) {
    return null;
  }
}

// ---------- 把一条记录压成界面上要的几个数 ----------
// 1. 取四块：tokenUsage / contextPressure / contextBreakdown / sessionStats
// 2. 上下文优先用 pressureTokens；没有就退到 surfaceTokens；再没有就是 0（并标 hasData=false）
// 3. 平均每步重发 =（缓存重读 + 新增输入）/ 步数 —— 这就是「这一步有多贵」
function summarize(rec) {
  const rows = (rec && rec.rows) || {};
  const val = function (k) { return (rows[k] && rows[k].val) || null; };
  const totals = (val('tokenUsage') || {}).totals || {};
  const pressure = val('contextPressure') || {};
  const bd = val('contextBreakdown') || {};
  const stats = val('sessionStats') || {};

  const cacheRead = num(totals.cacheReadTokens, 0);
  const uncached = num(totals.uncachedInputTokens, 0);
  const output = num(totals.outputTokens, 0);
  const win = num(pressure.contextWindow, DEFAULT_WINDOW) || DEFAULT_WINDOW;
  const surface = num(bd.surfaceTokens, 0);
  const ctx = num(pressure.pressureTokens, surface);
  const steps = num(stats.steps, 0);
  const turns = num(stats.turns, 0);
  const billed = cacheRead + uncached + output;

  return {
    hasData: billed > 0 || ctx > 0 || steps > 0,
    steps: steps,
    turns: turns,
    ctx: ctx,
    window: win,
    pct: win > 0 ? round1(ctx / win * 100) : 0,
    perStep: steps > 0 ? Math.round((cacheRead + uncached) / steps) : 0,
    cacheRead: cacheRead,
    uncached: uncached,
    output: output,
    total: billed,
    replayPct: billed > 0 ? round1(cacheRead / billed * 100) : 0,
    // 消息面里正文占多少（其余是 system + 工具 schema；今天实测 99.6% 是消息）
    msgShare: surface > 0 ? Math.round(num((bd.breakdown || {}).messageTokens, 0) / surface * 100) : 0
  };
}

// ---------- 分档 ----------
// over：每步已经三十多万，或者跑到 220 步（今天三条长会话都在这个量级）
// warn：过半或者 100 步，提醒一声
function levelOf(s, th) {
  const t = Object.assign({}, THRESHOLDS, th || {});
  if (!s || !s.hasData) return 'ok';
  if (s.pct >= t.overPct || s.steps >= t.overSteps) return 'over';
  if (s.pct >= t.warnPct || s.steps >= t.warnSteps) return 'warn';
  return 'ok';
}

function wan(tokens) {
  const n = num(tokens, 0);
  if (n >= 10000) return Math.round(n / 10000) + ' 万';
  return String(Math.round(n));
}

// 说人话的下一步（不用「上下文压力」「compaction」这类术语）
function adviceOf(level, s) {
  const w = wan((s && s.perStep) || 0);
  if (level === 'over') return '每步要重发 ' + w + '：现在就该写交接、归档、开新会话';
  if (level === 'warn') return '每步要重发 ' + w + '：这一轮做完就收尾换会话';
  return '还轻，照常干活';
}

// 复制给 AI 的交接指令（只生成文本，不替人执行）
function handoffPrompt(row) {
  const s = row || {};
  const name = s.sessionTitle || s.sceneName || '这条会话';
  return [
    '「' + name + '」已经跑了 ' + (s.steps || '?') + ' 步、每步要重发 ' + wan(s.perStep || 0) + ' token，先收尾：',
    '1. 把结论写回项目记忆（memory\\）与场景记忆的 §〇 / §五；',
    '2. 出一份交接：已做成什么、下一步、卡点；',
    '3. 本轮到此结束，我开新会话继续。'
  ].join('\n');
}

// ---------- 场景面板 → 会话 id ----------
// 1. 扫 scenarios\*.json（跳过 _ 开头的索引文件）
// 2. 只收 type === 'harness' 且真的钉了 sessionId 的面板
// 3. 场景名 / 面板名一并带上，界面上要能说清「是哪一屏」
function scanScenarios(fsx, scenariosDir) {
  const out = [];
  const files = fsx.readDir(scenariosDir) || [];
  for (const f of files) {
    if (!/\.json$/i.test(f) || f.charAt(0) === '_') continue;
    const t = fsx.readText(path.join(scenariosDir, f));
    if (t == null) continue;
    let j = null;
    try { j = JSON.parse(t); } catch (e) { continue; }
    const sceneId = String((j && j.id) || f.replace(/\.json$/i, ''));
    const sceneName = String((j && j.name) || sceneId);
    const panels = (j && Array.isArray(j.panels)) ? j.panels : [];
    for (const p of panels) {
      if (!p || p.type !== 'harness' || !p.sessionId) continue;
      out.push({
        sceneId: sceneId,
        sceneName: sceneName,
        panelId: String(p.id || ''),
        panelTitle: String(p.title || ''),
        sessionId: String(p.sessionId),
        sessionTitle: String(p.sessionTitle || '')
      });
    }
  }
  return out;
}

// ---------- 汇总：给 IPC / 命令行用同一份 ----------
function listUsages(fsx, opts) {
  const o = opts || {};
  const rows = scanScenarios(fsx, o.scenariosDir).map(function (p) {
    const rec = readRecord(fsx, o.dshHome, p.sessionId);
    const s = summarize(rec);
    const level = levelOf(s, o.thresholds);
    return Object.assign({}, p, {
      hasData: s.hasData,
      steps: s.steps,
      turns: s.turns,
      ctx: s.ctx,
      window: s.window,
      pct: s.pct,
      perStep: s.perStep,
      replayPct: s.replayPct,
      msgShare: s.msgShare,
      total: s.total,
      level: level,
      advice: adviceOf(level, s)
    });
  });
  // 越线重的排前面；同档按每步重发从大到小
  rows.sort(function (a, b) {
    const d = RANK[b.level] - RANK[a.level];
    if (d) return d;
    return (b.perStep - a.perStep);
  });
  return {
    ok: true,
    at: Date.now(),
    rows: rows,
    worst: rows.length ? rows[0] : null,
    over: rows.filter(function (r) { return r.level === 'over'; }).length,
    warn: rows.filter(function (r) { return r.level === 'warn'; }).length,
    noData: rows.filter(function (r) { return !r.hasData; }).length
  };
}

// ---------- 给 main.js 用的服务壳 ----------
function createService(ctx) {
  const c = ctx || {};
  return {
    list: function () { return listUsages(c.fsx, { dshHome: c.dshHome, scenariosDir: c.scenariosDir, thresholds: c.thresholds }); }
  };
}

module.exports = {
  DEFAULT_WINDOW: DEFAULT_WINDOW,
  THRESHOLDS: THRESHOLDS,
  RANK: RANK,
  summarize: summarize,
  levelOf: levelOf,
  adviceOf: adviceOf,
  handoffPrompt: handoffPrompt,
  wan: wan,
  scanScenarios: scanScenarios,
  readRecord: readRecord,
  listUsages: listUsages,
  createService: createService
};
