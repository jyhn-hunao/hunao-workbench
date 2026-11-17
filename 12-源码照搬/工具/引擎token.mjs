// 引擎 token 的唯一取法（2026-11-17）
//
// 背景：2026-11-14 壳把 server.log 里的 token 统一打成 `token=***`（防止日志发给别人时泄露），
//   但那次只改了壳，没给脚本留新通道 —— 于是所有「从日志正则取 token」的脚本同时失效，
//   换会话会在闸门放行后卡在「换不到 cookie」。
//
// 现在的通道顺序：
//   ① 进程环境 DSH_TOKEN —— 壳 spawn 子脚本时注入，token 只在内存与本机进程环境里，不落盘；
//   ② server.log 回退 —— 兼容未脱敏的旧日志、外部引擎、以及手工设了 DSH_TOKEN 的场合。
//
// 用法：const toks = engineTokens(LOG, PORT);  // PORT 为空表示不过滤端口
import fs from 'node:fs';

export function engineTokens(logFile, port) {
  const out = [];
  // ① 壳注入的 token 优先：它是当前引擎的实时 token，比翻历史日志可靠
  const env = String(process.env.DSH_TOKEN || '').trim();
  if (/^[A-Za-z0-9_\-]{16,}$/.test(env)) out.push(env);
  // ② 日志回退：按时间正序，取最新的在前
  try {
    const txt = fs.readFileSync(logFile, 'utf8');
    const re = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]{16,})/g;
    const found = [...txt.matchAll(re)]
      .filter((m) => !port || m[1] === port)
      .map((m) => m[2])
      .reverse();
    for (const t of found) if (!out.includes(t)) out.push(t);
  } catch (e) { /* 日志不在：只剩 env；没有就由调用方报错 */ }
  return out;
}
