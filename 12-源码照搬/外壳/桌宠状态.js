// 桌宠状态.js（2026-11-20 扩）——桌宠状态的数据面。
//
// 两套口径，别混：
//   · stateOf(dshHome, sessionId)  → 四态 idle / thinking / speaking / listening
//     给工作台里的 Live2D 面板用（/petlive2d/state），保持 2026-11-18 的行为不变。
//   · stateAll(dshHome, opts)     → 六态 thinking / working / result / waiting / success / error + idle
//     给桌面身体（dsh-pet 0.4.9）用：读所有场景绑定的会话，按优先级挑一个当前状态，
//     再 POST /dsh-pet-7340/work-status；审批队列非空时强制 waiting。
//
// 只读 transcript，复用 社交.js 的 transcriptOf / readEvents，不新增第二套解析。
// 事件结构（2026-11-20 实测）：
//   turn/start      {turn}
//   turn/end        {turn, reason:{kind:'completed'|'error'|'max-tokens', error:{message,code}}}
//   user/message    {source:{kind:'user'|'memory-recall'...}, content:[{type:'text',text}]}
//   assistant/message {message:{content:[{type:'text',text}|{type:'tool-call',...}]}}
//   tool/call       {turn, step, callId, name, arguments(JSON 字符串)}
//   tool/result     {turn, step, message:{isError}, ...}
//   approval/asked  {id, toolName, callId, reason}
//   approval/decided{id, ...}
const fs = require('fs');
const path = require('path');
const { transcriptOf, readEvents } = require('./社交');

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

// 时间窗口：说话 8s / 收听 6s / 思考 60s（四态沿用）；工具 5min / 结果 5s / 成功 10s / 出错 60s / 审批 30min（六态）
const WIN = {
  speak: 8000, listen: 6000, think: 60000,
  tool: 5 * 60 * 1000, result: 5000, success: 10000, error: 60000, approval: 30 * 60 * 1000,
};

// 优先级照 dsh-pet 的口径：waiting > error > working > thinking > result > success；idle 最后。
const RANK = { waiting: 0, error: 1, working: 2, thinking: 3, result: 4, success: 5, idle: 6 };

// transcript 是全量 zstd 解压：按「文件 size + mtimeMs」缓存，文件没变就复用。
// 2026-11-20 从单文件缓存改成 Map：全会话轮询要同时读 7 条会话，单缓存会互相顶掉、每次全解压。
const EV_CACHE = new Map();
const EV_CACHE_MAX = 12;
function eventsOf(file) {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    const hit = EV_CACHE.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.events;
    const events = readEvents(file);
    if (EV_CACHE.size >= EV_CACHE_MAX && !EV_CACHE.has(file)) {
      const first = EV_CACHE.keys().next().value;
      if (first) EV_CACHE.delete(first);
    }
    EV_CACHE.set(file, { size: st.size, mtimeMs: st.mtimeMs, events });
    return events;
  } catch (e) {
    const hit = EV_CACHE.get(file);
    if (hit) return hit.events;
    try { return readEvents(file); } catch (e2) { return null; }   // 文件刚被移走/还没落盘：不让轮询断
  }
}

// 1. 四态（Live2D 面板）：事件 → idle / thinking / speaking / listening
function stateOf(dshHome, sessionId, nowMs) {
  const file = transcriptOf(dshHome, sessionId);
  const events = eventsOf(file);
  const now = nowMs || Date.now();
  if (!events || !events.length) return { state: 'idle', why: 'no-events' };

  let lastTurnStart = 0;
  let lastTurnEnd = 0;
  let lastUser = 0;   // 真人输入（source.kind === 'user'，不含引擎注入）
  let lastAsst = 0;   // 她输出的最后一条 assistant/message
  for (const e of events) {
    if (!e || !e.type) continue;
    const t = Number(e.time) || 0;
    if (!t) continue;
    if (e.type === 'turn/start') lastTurnStart = t;
    else if (e.type === 'turn/end') lastTurnEnd = t;
    else if (e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user') lastUser = t;
    else if (e.type === 'assistant/message') lastAsst = t;
  }

  // 1. speaking：最近 8 秒有输出，且这一轮还没 turn/end（结束事件把 speaking 掐掉）
  if (lastAsst && now - lastAsst < WIN.speak && lastAsst > lastTurnEnd) {
    return { state: 'speaking', lastAsst };
  }
  // 2. listening：最近 6 秒有真人说话
  if (lastUser && now - lastUser < WIN.listen) {
    return { state: 'listening', lastUser };
  }
  // 3. thinking：turn 已开始、尚无输出、尚未结束，且没过 60 秒（过久算引擎卡死 → 回 idle）
  if (lastTurnStart && lastTurnStart > lastAsst && lastTurnStart > lastTurnEnd && now - lastTurnStart < WIN.think) {
    return { state: 'thinking', lastTurnStart };
  }
  return { state: 'idle' };
}

// 2. 文本小工具：只取一条消息里的正文，不拼 reasoning / tool-call
function textOf(data) {
  if (!data) return '';
  const c = data.content || (data.message && data.message.content);
  if (Array.isArray(c)) {
    for (const b of c) if (b && b.type === 'text' && b.text) return String(b.text);
  }
  return '';
}
function short(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const max = n || 40;
  const a = Array.from(t);
  return a.length > max ? a.slice(0, max - 1).join('') + '…' : t;
}
function firstLine(s) { return String(s == null ? '' : s).split(/\r?\n/)[0]; }
function baseName(p) { return String(p == null ? '' : p).split(/[\\/]/).pop() || ''; }
function parseArgs(args) {
  try { const j = JSON.parse(String(args || '{}')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
}
// 审批原因去掉引擎前缀，只留人话
function stripReason(s) {
  return String(s == null ? '' : s)
    .replace(/^escalate sandbox to danger-full-access:\s*/i, '')
    .replace(/^sandbox[^:]*:\s*/i, '')
    .trim();
}

// 3. 工具调用 → 一句任务文案（气泡最多 40 码点）
function toolTask(name, args) {
  const n = String(name || '');
  const a = parseArgs(args);
  const p = String(a.command || a.path || a.file_path || a.file || a.query || a.pattern || a.question || a.description || a.text || a.prompt || '');
  if (!p) return short(n) || '干活';
  if (n === 'pwsh' || n === 'bash' || n === 'shell') return short(firstLine(p)) || '跑命令';
  if (n === 'write' || n === 'edit') return short('改 ' + baseName(p)) || '改文件';
  if (n === 'read') return short('读 ' + baseName(p)) || '翻文件';
  if (n === 'ask_user_question') return '等你回答';
  if (n === 'todo_write' || n === 'todo') return short(p) || '理待办';
  return short(n + ' ' + firstLine(p)) || n || '干活';
}

// 4. 一条会话的事件 → 六态 + 任务文案
function scan(events, nowMs) {
  const now = nowMs || Date.now();
  const out = { state: 'idle', task: '', lastAt: 0 };
  if (!events || !events.length) return out;

  let lastTurnStart = 0;
  let lastTurnEnd = 0;
  let lastEndKind = '';
  let lastEndError = '';
  let lastUserText = '';
  let lastAsst = 0;
  let lastToolCall = 0;
  let lastToolResult = 0;
  let lastToolName = '';
  let lastToolArgs = '';
  let apAsk = { time: 0, id: '', reason: '' };
  let apDecide = { time: 0, id: '' };

  for (const e of events) {
    if (!e || !e.type) continue;
    const t = Number(e.time) || 0;
    if (!t) continue;
    if (t > out.lastAt) out.lastAt = t;
    switch (e.type) {
      case 'turn/start':
        lastTurnStart = t;
        break;
      case 'turn/end': {
        lastTurnEnd = t;
        const r = (e.data && e.data.reason) || {};
        lastEndKind = String(r.kind || '');
        const er = r.error || {};
        lastEndError = String(er.message || er.code || '');
        break;
      }
      case 'user/message':
        if (e.data && e.data.source && e.data.source.kind === 'user') {
          const tx = textOf(e.data);
          if (tx) lastUserText = tx;
        }
        break;
      case 'assistant/message':
        lastAsst = t;
        break;
      case 'tool/call':
        lastToolCall = t;
        lastToolName = String((e.data && e.data.name) || '');
        lastToolArgs = String((e.data && e.data.arguments) || '');
        break;
      case 'tool/result':
        lastToolResult = t;
        break;
      case 'approval/asked':
        apAsk = { time: t, id: String((e.data && e.data.id) || ''), reason: String((e.data && e.data.reason) || '') };
        break;
      case 'approval/decided':
        apDecide = { time: t, id: String((e.data && e.data.id) || '') };
        break;
      default:
        break;
    }
  }

  const freshTurn = lastTurnStart > lastTurnEnd;
  const waiting = apAsk.time > 0 && apAsk.time >= apDecide.time && (now - apAsk.time < WIN.approval);

  if (waiting) {
    out.state = 'waiting';
    out.task = short(stripReason(apAsk.reason), 40) || '等你确认一下';
    return out;
  }
  if (lastTurnEnd && !freshTurn && lastEndKind && lastEndKind !== 'completed' && now - lastTurnEnd < WIN.error) {
    out.state = 'error';
    out.task = lastEndKind === 'max-tokens' ? '达到本轮上限' : (short(lastEndError, 40) || '这一步出错了');
    return out;
  }
  if (lastToolCall > lastToolResult && now - lastToolCall < WIN.tool) {
    out.state = 'working';
    out.task = toolTask(lastToolName, lastToolArgs);
    return out;
  }
  if (freshTurn && lastTurnStart > lastAsst && lastTurnStart > lastToolCall && now - lastTurnStart < WIN.think) {
    out.state = 'thinking';
    out.task = short(lastUserText, 40) || '正在想下一步';
    return out;
  }
  if (lastToolResult > lastToolCall && now - lastToolResult < WIN.result) {
    out.state = 'result';
    out.task = toolTask(lastToolName, lastToolArgs) || '这一步好了';
    return out;
  }
  if (lastTurnEnd && !freshTurn && lastEndKind === 'completed' && now - lastTurnEnd < WIN.success) {
    out.state = 'success';
    out.task = '这一轮完成了';
    return out;
  }
  return out;
}

// 5. 场景名只给别的场景加前缀；人格场景不加，避免把 40 码点全吃掉
const NO_PREFIX = { '胡闹的大肥鱼': 1 };
function composeTask(scene, task) {
  const s = String(scene || '').trim();
  const t = String(task || '').trim();
  if (!t) return '';
  const full = (s && !NO_PREFIX[s]) ? (s + ' · ' + t) : t;
  return short(full, 40);
}

// 6. 从 scenarios/*.json 读所有场景绑定的 AI 会话；一个场景可能有多条 harness 面板
//    （如 code-dev 的 mlw / 工作区），每条都收；同一 sessionId 被多个场景共用时保留 pet.json 的那一份。
function listSceneSessions() {
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch (e) { return []; }
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8')); } catch (e) { continue; }
    if (!j || !Array.isArray(j.panels)) continue;
    for (const p of j.panels) {
      if (!p || !p.sessionId || String(p.type) !== 'harness') continue;
      const sid = String(p.sessionId);
      if (!sid) continue;
      const row = {
        scene: String(j.name || j.id || f),
        panelId: String(p.id || ''),
        title: String(p.sessionTitle || j.name || ''),
        sessionId: sid,
      };
      if (!map.has(sid) || String(j.id) === 'pet') map.set(sid, row);
    }
  }
  return Array.from(map.values());
}

// 7. 一条会话 → 六态行（带场景/面板/sessionId）
function stateOfSession(dshHome, s, nowMs) {
  const file = transcriptOf(dshHome, s.sessionId);
  const events = eventsOf(file);
  const info = scan(events, nowMs);
  return Object.assign({}, s, info, { task: composeTask(s.scene, info.task) });
}

// 8. 全会话聚合：按优先级挑一个状态；审批队列非空时强制 waiting（审批是人的动作，不能被别的会话盖掉）
function stateAll(dshHome, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const scenes = o.scenes || listSceneSessions();
  const rows = [];
  for (const s of scenes) {
    try { rows.push(stateOfSession(dshHome, s, now)); } catch (e) { /* 单条会话坏了不拖垮整轮 */ }
  }
  const pending = Math.max(0, Number(o.pendingApprovals) || 0);
  if (pending > 0) {
    rows.push({
      scene: '派发', panelId: 'pet-dog', title: '派发巡检', sessionId: '',
      state: 'waiting', task: '待批准 ' + pending + ' 条', lastAt: now,
    });
  }
  rows.sort((a, b) => {
    const ra = RANK[a.state] == null ? 9 : RANK[a.state];
    const rb = RANK[b.state] == null ? 9 : RANK[b.state];
    return (ra - rb) || ((b.lastAt || 0) - (a.lastAt || 0));
  });
  const top = rows[0] || { state: 'idle', task: '', scene: '', sessionId: '', lastAt: 0 };
  return {
    state: top.state || 'idle',
    task: top.task || '',
    scene: top.scene || '',
    sessionId: top.sessionId || '',
    sessions: rows,
    pendingApprovals: pending,
    at: now,
  };
}

// 上一次「有动静」的时间（供面板显示副文案，可选）
function lastActivity(dshHome, sessionId) {
  const file = transcriptOf(dshHome, sessionId);
  const events = eventsOf(file);
  if (!events) return 0;
  let t = 0;
  for (const e of events) {
    if (!e || !e.type) continue;
    t = Math.max(t, Number(e.time) || 0);
  }
  return t;
}

module.exports = { stateOf, stateAll, listSceneSessions, lastActivity, WIN };
