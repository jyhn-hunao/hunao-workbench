// 省 token 守卫 —— DSH 引擎插件：在工具**派发前**拦住重复动作。
//
// 为什么需要它（2026-11-11 实测）：一天 300 次 read 里 147 次是重复读同一文件，
// 工具结果 83 条非零退出。这些浪费靠"规范"约束不住（我当天就违反了三次），
// 只有工具层拦截能保证。挂载点：`tools/pre-execute`（waterfall，可 allow/deny/cancel/ask）。
//
// 两种模式（由 patch 里的 config.mode 决定）：
//   shadow（默认）：只记日志、不拦 —— 先看误伤率；
//   enforce       ：命中规则就返回 {kind:'deny'}，模型会看到拒绝原因并改路子。
//
// 不碰会话、不写场景；日志写在 <DSH_HOME>/storages/token-guard.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import { classify, decide, remember } from './rules.js';

export const name = 'token-guard';

// 日志位置：引擎进程的环境里有 DSH_HOME / DSH_CUSTOMER_HOME（启动.vbs 设的后者）
function logFile(config) {
  if (config && config.logFile) return String(config.logFile);
  const home = process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || '';
  const base = home || path.join(process.cwd(), '.dsh');
  return path.join(base, 'storages', 'token-guard.jsonl');
}

function appendLine(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) { /* 写不了日志绝不影响主流程 */ }
}

// 读文件大小：相对路径先按当前工作目录试；读不到就返回 0（规则 ② 自动跳过）
function fileSize(p) {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s.size : 0;
  } catch (e) {
    return 0;
  }
}

export function apply(ctx, config) {
  const mode = (config && config.mode) === 'enforce' ? 'enforce' : 'shadow';
  const file = logFile(config);
  // 每个 agent（= 每条会话）一份历史，互不干扰；WeakMap 让会话结束后自动回收
  const histories = new WeakMap();

  // 1. 只在工具派发前介入：命中规则就决定「拦」还是「只记」
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!exec || !exec.name) return next();
      const args = exec.arguments || exec.args || {};
      const call = classify(exec.name, args);
      if (!call) return next();

      const agent = exec.agent || null;
      let hist = agent ? histories.get(agent) : null;
      if (!hist) { hist = new Map(); if (agent) histories.set(agent, hist); }

      // 规则 ② 需要文件大小：在判定前补上（只有 read 才补）
      if (call.kind === 'read') call.size = fileSize(call.path);

      const hit = decide(hist, call);
      remember(hist, call);            // 先记账：被拦的调用也算「读过一次」
      if (!hit) return next();

      appendLine(file, {
        at: new Date().toISOString(), mode, rule: hit.rule,
        tool: exec.name, hint: hit.hint || null,
        agent: agent && (agent.sessionId || agent.id) || '',
      });

      if (mode !== 'enforce') return next();
      return { kind: 'deny', reason: hit.reason };
    } catch (e) {
      // 守卫自己出错绝不阻断工具：记一行，放行
      appendLine(file, { at: new Date().toISOString(), error: String((e && e.message) || e) });
      return next();
    }
  });
}
