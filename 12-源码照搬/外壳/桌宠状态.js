// 桌宠状态.js（2026-11-18）——桌宠 3D 的四态判定数据面。
// 只读人格会话 transcript（复用 社交.js 的 transcriptOf / readEvents，不新增第二套解析）。
// 四态口径照 外壳\pet3d\说明.md 的状态驱动表：
//   idle     无人说话：呼吸 / 眨眼循环
//   thinking 会话里出现 turn/start 且无输出
//   speaking 出现 assistant/message 且正在流式输出
//   listening 用户输入中
// transcript 是轮次级粒度（无 token 级流式事件），判定用「最近事件 + 时间窗口」近似：
//   窗口常量：说话 8s / 收听 6s / 思考 60s（turn 没结束且一直没有输出）。
const { transcriptOf, readEvents } = require('./社交');

const WIN = { speak: 8000, listen: 6000, think: 60000, fresh: 5 * 60 * 1000 };

// 事件 → 四态。nowMs 供测试注入。
function stateOf(dshHome, sessionId, nowMs) {
  const file = transcriptOf(dshHome, sessionId);
  const events = file ? readEvents(file) : null;
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

// 上一次「有动静」的时间（供面板显示副文案，可选）
function lastActivity(dshHome, sessionId) {
  const file = transcriptOf(dshHome, sessionId);
  const events = file ? readEvents(file) : null;
  if (!events) return 0;
  let t = 0;
  for (const e of events) {
    if (!e || !e.type) continue;
    t = Math.max(t, Number(e.time) || 0);
  }
  return t;
}

module.exports = { stateOf, lastActivity, WIN };
