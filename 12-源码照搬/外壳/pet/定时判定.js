'use strict';
// 定时任务「该不该跑」的纯判定（2026-11-24）
//
// 为什么单独抽出来：壳里的 timerTick 原来只做 HH:MM 精确匹配，机器关机/休眠错过那一分钟
//   就永久漏跑，重启后也不会补。这个文件只算「这一次该不该跑」，不读文件、不起进程，
//   所以可以直接用 node 跑用例，不用为了验证改一次就重启整壳。
//
// 口径（刻意保持简单，避免补跑变成补一堆）：
//   1. 同一个任务同一个本地日历日最多成功一次（沿用 定时-已跑.json 的 id@YYYY-MM-DD 键）；
//      起进程写 pending，失败写 failed 并允许 10 分钟后重试，不能把"起得来但没干成"算成已完成。
//   2. 今天到点/已过点且今天没跑 → 现在补一次（就是当天的补跑）。
//   3. 今天还没到点，但昨天那格没跑（且这个任务有历史）→ 开机先补一次，并把今天记成已跑，
//      避免今天到点又跑一次；不重放更早的每一天。
//   4. 全新任务没有历史 → 今天没到点就等，不凭空补昨天。
//   5. 状态不只记"跑过"：起进程时先记 pending，只有子进程 exit 0/3 才记 ok；
//      失败记 failed，过 10 分钟再试。这样"进程起得来、活没干成"不会被当成已完成
//      （2026-11-24 补：旧逻辑 spawn 成功就写已跑，紧接着子进程失败也永远不再补）。

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RETRY_FAIL_MS = 10 * 60 * 1000;      // 子进程失败后至少隔这么久再试，避免每 30 秒刷一次
const PENDING_STALE_MS = 15 * 60 * 1000;   // 起进程后 15 分钟还没收到 exit，视为上次没收尾

function pad2(n) {
  const s = String(n);
  return s.length < 2 ? '0' + s : s;
}

function dayKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh: hh, mm: mm, text: pad2(hh) + ':' + pad2(mm) };
}

function dueAt(now, time) {
  const t = parseTime(time);
  if (!t) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hh, t.mm, 0, 0).getTime();
}

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

// 旧状态是数字时间戳；新状态是 { pending } / { ok:true } / { ok:false }。
// 这样不用换文件、不用迁移旧数据，旧键仍然按"已完成"处理。
function stateKind(value) {
  if (typeof value === 'number') return value > 0 ? 'done' : 'missing';
  if (!value || typeof value !== 'object') return value ? 'done' : 'missing';
  if (value.pending === true) return 'pending';
  if (value.ok === false) return 'failed';
  if (value.ok === true) return 'done';
  return 'failed';   // 有对象但既不是 pending 也不是明确成功：按失败处理，宁可重试也别当已完成
}

function stateAt(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const n = Number(value.at);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// 这一天算不算"已经完成"：pending 在超时前、failed 在重试窗口内都先算"占着"，
// 过了窗口就放行重试；不能因为写过一个失败标记就永远不再跑。
function ranOnDay(seen, key, now, opts) {
  if (!hasKey(seen, key)) return false;
  const kind = stateKind(seen[key]);
  if (kind === 'done') return true;
  if (kind === 'pending') {
    const staleMs = opts && Number(opts.pendingMs) >= 0 ? Number(opts.pendingMs) : PENDING_STALE_MS;
    return (now.getTime() - stateAt(seen[key])) < staleMs;
  }
  if (kind === 'failed') {
    const retryMs = opts && Number(opts.retryMs) >= 0 ? Number(opts.retryMs) : RETRY_FAIL_MS;
    return (now.getTime() - stateAt(seen[key])) < retryMs;
  }
  return false;
}

function hasHistory(seen, id) {
  const prefix = String(id) + '@';
  return Object.keys(seen || {}).some(function (k) { return k.indexOf(prefix) === 0; });
}

// 返回：
//   run       true = 这一次要起进程
//   mode      due / retry / catch-up-yesterday / ''（方便日志与以后面板展示）
//   stateKey  今天这一格的键（永远是 id@今天；完成/失败/进行中都写它）
//   dueAt     今天计划点的毫秒值（-1 表示时间非法）
//   reason    人能读懂的一句话
function timerDecision(task, now, seen, opts) {
  const id = String((task && task.id) || '').trim();
  const at = now instanceof Date ? now : new Date();
  if (!id) return { run: false, mode: '', stateKey: '', dueAt: -1, reason: '任务没有 id' };
  const t = parseTime(task && task.time);
  if (!t) return { run: false, mode: '', stateKey: '', dueAt: -1, reason: '时间格式不是 HH:MM：' + (task && task.time) };

  const todayDue = dueAt(at, t.text);
  const todayState = id + '@' + dayKey(at);
  if (ranOnDay(seen, todayState, at, opts)) {
    const kind = stateKind(seen[todayState]);
    if (kind === 'pending') {
      return { run: false, mode: '', stateKey: todayState, dueAt: todayDue, reason: '今天 ' + t.text + ' 的进程还没收尾' };
    }
    if (kind === 'failed') {
      return { run: false, mode: '', stateKey: todayState, dueAt: todayDue, reason: '今天 ' + t.text + ' 刚失败，等重试窗口' };
    }
    return { run: false, mode: '', stateKey: todayState, dueAt: todayDue, reason: '今天 ' + t.text + ' 已跑过' };
  }

  // 1. 今天已经到点（含开机时已经过点）：今天这格补一次
  if (at.getTime() >= todayDue) {
    const retry = hasKey(seen, todayState) && stateKind(seen[todayState]) === 'failed';
    return {
      run: true,
      mode: retry ? 'retry' : 'due',
      stateKey: todayState,
      dueAt: todayDue,
      reason: retry ? '今天 ' + t.text + ' 上次失败，重试窗口已过，再补一次' : '今天 ' + t.text + ' 已到点，补跑今天这格',
    };
  }

  // 2. 今天还没到点：昨天那格漏了才补；把今天记成已跑，避免今天到点又跑
  const y = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  y.setDate(y.getDate() - 1);
  const yesterdayState = id + '@' + dayKey(y);
  if (hasHistory(seen, id) && !ranOnDay(seen, yesterdayState, at, opts)) {
    return {
      run: true,
      mode: 'catch-up-yesterday',
      stateKey: todayState,
      dueAt: todayDue,
      reason: '昨天 ' + t.text + ' 漏跑，开机补一次；今天到点不再跑'
    };
  }

  return { run: false, mode: '', stateKey: todayState, dueAt: todayDue, reason: '今天 ' + t.text + ' 还没到点' };
}

// 状态文件只留最近 N 天，避免 定时-已跑.json 越积越大；坏键直接丢掉。
function pruneTimerState(seen, now, keepDays) {
  const out = {};
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) return out;
  const at = now instanceof Date ? now : new Date();
  const cutoff = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  cutoff.setDate(cutoff.getDate() - (Number(keepDays) > 0 ? Number(keepDays) : 45));
  for (const k of Object.keys(seen)) {
    const i = k.lastIndexOf('@');
    const dm = i >= 0 ? DAY_RE.exec(k.slice(i + 1)) : null;
    if (!dm) continue;
    const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
    if (d.getTime() >= cutoff.getTime()) out[k] = seen[k];
  }
  return out;
}

module.exports = { timerDecision, pruneTimerState, dueAt, dayKey, parseTime, pad2, stateKind, RETRY_FAIL_MS, PENDING_STALE_MS };
