// 把指定会话改名（引擎 RPC session/rename，照 建会话.mjs 的实测配方）
// 用法：node 会话改名.mjs <sessionId> "<新标题>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [sid, title] = process.argv.slice(2);
if (!sid || !title) {
  console.log('用法：node 会话改名.mjs <sessionId> "新标题"');
  process.exit(2);
}
const BASE = process.env.DSH_GUI_BASE || process.env.DSH_WEB_URL || ('http://127.0.0.1:' + (process.env.DSH_PORT || '3083'));
const DSH_HOME = process.env.DSH_HOME || '<盘根>:/DSH/引擎/.dsh';
// token 在「外壳」的 server.log 里（不是 引擎 目录）；两个位置都试
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // 本仓 = 外壳\
const LOG = [
  process.env.DSH_LOG,
  path.join(SELF_ROOT, 'server.log'),
  '<盘根>:/DSH/外壳/server.log',
  path.join(path.dirname(DSH_HOME), '外壳', 'server.log'),
].find((x) => x && fs.existsSync(x)) || '';

// token 正则跟随 BASE 的端口（原来写死 3080：引擎默认跑 3083 时取不到 token）
const PORT = (() => { try { return new URL(BASE).port || '80'; } catch (e) { return ''; } })();
const toks = fs.existsSync(LOG)
  ? [...fs.readFileSync(LOG, 'utf8').matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]{16,})/g)]
      .filter((m) => !PORT || m[1] === PORT).map((m) => m[2]).reverse()
  : [];
let cookie = '';
for (const t of toks.slice(0, 3)) {
  try {
    const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (sc.length) { cookie = sc.map((c) => c.split(';')[0]).join('; '); break; }
  } catch (e) { /* next */ }
}
if (!cookie) { console.log('✗ 换不到 cookie（引擎没在跑？）'); process.exit(1); }

const rpc = async (method, args) => {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
};

const r = await rpc('session/rename', { request: { sessionId: sid, title } });
if (r.status !== 200) {
  console.log('✗ 改名失败 HTTP ' + r.status + ' · ' + String(r.t).slice(0, 200));
  process.exit(1);
}
console.log('✓ 已改名：' + sid + ' → 「' + title + '」');
