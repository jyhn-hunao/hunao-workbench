// 引擎 token 的唯一取法（2026-11-17 / 2026-11-25 补 .web-token）
//
// 背景：2026-11-14 壳把 server.log 里的 token 统一打成 `token=***`（防止日志发给别人时泄露），
//   但那次只改了壳，没给脚本留新通道 —— 于是所有「从日志正则取 token」的脚本同时失效，
//   换会话会在闸门放行后卡在「换不到 cookie」。
//
// 现在的通道顺序：
//   ① 进程环境 DSH_TOKEN —— 壳 spawn 子脚本时注入（壳自己的子进程一定有）；
//   ② 引擎 home 的 `.web-token` —— 壳每次捕获 token 都写一份（仅本机、不入库），
//      给「CLI / 人格会话里的 bash」用：它们继承不到壳的 env，否则永远换不到 cookie；
//   ③ server.log 回退 —— 兼容未脱敏的旧日志与外部引擎。
//
// 用法：const toks = engineTokens(LOG, PORT);  // PORT 为空表示不过滤端口
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// .web-token 的三个可能位置：① 显式 DSH_HOME（安装版 / 壳 spawn 的子进程）；
// ② server.log 同目录（外部引擎把它写在 home 里）；③ 本仓源码布局 工具\..\引擎数据\.dsh
function tokenFiles(logFile) {
  const out = [];
  const home = String(process.env.DSH_HOME || '').trim();
  if (home) out.push(path.join(home, '.web-token'));
  if (logFile) out.push(path.join(path.dirname(String(logFile)), '.web-token'));
  out.push(path.join(HERE, '..', '引擎数据', '.dsh', '.web-token'));
  return out;
}

export function engineTokens(logFile, port) {
  const out = [];
  // ① 壳注入的 token 优先：它是当前引擎的实时 token，比翻历史日志可靠
  const env = String(process.env.DSH_TOKEN || '').trim();
  if (/^[A-Za-z0-9_\-]{16,}$/.test(env)) out.push(env);
  // ② 壳落的 .web-token：给 CLI / 人格会话里的 bash 用（它们继承不到壳的 env）；
  //    端口对不上就别用，免得串到另一个 DSH 实例
  for (const f of tokenFiles(logFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const t = String((j && j.token) || '').trim();
      const pt = String((j && j.port) || '').trim();
      if (!/^[A-Za-z0-9_\-]{16,}$/.test(t)) continue;
      if (port && pt && pt !== String(port)) continue;
      if (!out.includes(t)) out.push(t);
      break;
    } catch (e) { /* 这个位置没有：换下一个候选 */ }
  }
  // ③ 日志回退：按时间正序，取最新的在前
  try {
    const txt = fs.readFileSync(logFile, 'utf8');
    const re = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]{16,})/g;
    const found = [...txt.matchAll(re)]
      .filter((m) => !port || m[1] === port)
      .map((m) => m[2])
      .reverse();
    for (const t of found) if (!out.includes(t)) out.push(t);
  } catch (e) { /* 日志不在：只剩 env 与 .web-token；没有就由调用方报错 */ }
  return out;
}
