// rules.js —— 守卫的判定逻辑（纯函数，不碰 ctx / 文件系统，方便单测）
//
// 为什么单独抽出来：拦截规则一旦写错，会把正常操作也拦掉（误伤比浪费更贵）。
// 所以规则必须能在命令行里一秒钟验一遍：给一串假调用 → 看它拦不拦。
//
// 三条硬规则（2026-11-11 实测出来的，不是拍脑袋）：
//   ① 同一路径 read 第 3 次      —— 今天 renderers.js 被读 46 次
//   ② read 没带 offset/limit 且文件 > 200KB —— 整读 1.1MB 的单文件
//   ③ 同一条 pwsh 命令原样第 2 次 —— 改完立刻重跑同一条，多半是没看上次结果

export const LIMITS = {
  readRepeat: 3,        // 同一路径读第 3 次就拦（前两次是正常：定位 + 复核）
  bigFileBytes: 200 * 1024,
  commandRepeat: 2,     // 同一条命令第 2 次就拦
};

// ---------- 把一次调用归一化成 {kind, key}；不认识就返回 null ----------
// 1. read：key = 路径，附带 offset/limit 与文件大小（大小由调用方补）
// 2. pwsh：key = 去掉多余空白后的整条命令
// 3. 其他工具不参与（grep/glob/edit 重复是正常的）
export function classify(name, args) {
  const a = args || {};
  if (name === 'read') {
    const p = String(a.file_path || a.path || '').trim();
    if (!p) return null;
    return {
      kind: 'read',
      key: 'read|' + p.toLowerCase(),
      path: p,
      hasRange: a.offset !== undefined || a.limit !== undefined,
    };
  }
  if (name === 'pwsh') {
    const c = String(a.command || '').replace(/\s+/g, ' ').trim();
    if (!c) return null;
    return { kind: 'pwsh', key: 'pwsh|' + c, command: c };
  }
  return null;
}

// ---------- 判定：返回 null（放行）或 {rule, reason, hint} ----------
// history: Map<key, {count, first, last}>；stat: (path) => {size} | null
export function decide(history, call, opts) {
  const o = Object.assign({}, LIMITS, opts || {});
  if (!call) return null;
  const rec = history.get(call.key) || { count: 0, first: null, last: null };

  // 规则 ①：同一文件读太多次
  if (call.kind === 'read' && rec.count + 1 >= o.readRepeat) {
    return {
      rule: 'repeat-read',
      reason: '这个文件本轮已经读过 ' + rec.count + ' 次（' + call.path + '）。不要整读第三遍：'
        + '先用 grep 拿到具体行号，再 read 带 offset/limit 只读那一段；'
        + '如果你要的只是某个函数/字段，grep 就够。',
      hint: { path: call.path, count: rec.count + 1 },
    };
  }

  // 规则 ②：整读大文件
  if (call.kind === 'read' && !call.hasRange && call.size > o.bigFileBytes) {
    return {
      rule: 'full-read-big',
      reason: '这个文件有 ' + Math.round(call.size / 1024) + ' KB，而你没带 offset/limit。'
        + '整读会把几千行原文灌进上下文，之后每一步都要重发一遍。'
        + '先 grep -n 定位，再 read 带 offset/limit 读目标段。',
      hint: { path: call.path, size: call.size },
    };
  }

  // 规则 ③：同一条命令原样重跑
  if (call.kind === 'pwsh' && rec.count + 1 >= o.commandRepeat) {
    return {
      rule: 'repeat-command',
      reason: '这条命令本轮已经跑过一次了（原样）。先看上次的输出；'
        + '如果上次报错，换手段（换引号风格 / 改用 node 脚本 / 换工具），不要在原来的命令上继续微调。',
      hint: { command: call.command.slice(0, 120) },
    };
  }
  return null;
}

// ---------- 记账：把这次调用写进历史 ----------
// 只记参与判定的两类；同 key 累加次数
export function remember(history, call) {
  if (!call) return history;
  const rec = history.get(call.key) || { count: 0, first: null, last: null };
  rec.count += 1;
  rec.last = Date.now();
  if (!rec.first) rec.first = rec.last;
  history.set(call.key, rec);
  return history;
}
