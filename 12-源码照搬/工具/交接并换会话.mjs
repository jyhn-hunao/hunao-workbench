#!/usr/bin/env node
// 交接并换会话.mjs —— 「换会话」按钮的"先写交接再换"路径（2026-11-12 用户拍板）
// 干什么（一条命令三步）：
//   1. 给该面板**旧会话**投一条交接提示（口径 = `场景记忆.mjs 交接` 的 §〇 四小节，不另造模板）；
//   2. 等那一轮跑完（按 transcript 轮数判，不按时间猜），最多 --timeout 秒；
//   3. 完成后跑 `换会话.mjs <panel> --go`（**不带 --force**，让 2 小时交接闸自然生效）。
// 失败语义：超时/投递失败 ⇒ 退出 4，**不动绑定**；轮换失败原样透出退出码。
//
// 用法：node 工具\交接并换会话.mjs --panel cd-ai [--timeout 120] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SHELL, loadSessions, getCookie, promptSession, transcriptOf, readEvents, turnStats } from './派发-公共.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const PANEL = val('--panel', '');
const TIMEOUT = Math.max(30, Number(val('--timeout', '120')) || 120);
const DRY = argv.includes('--dry');
const say = (...a) => console.log(...a);

if (!PANEL) { console.error('用法：node 工具\\交接并换会话.mjs --panel <面板id> [--timeout 120] [--dry]'); process.exit(2); }

// 1. 面板 → 旧会话 id（以场景 json 为准）
const scenDir = path.join(SHELL, 'scenarios');
let oldId = '', sceneId = '';
for (const f of fs.readdirSync(scenDir).filter((x) => x.endsWith('.json') && x[0] !== '_')) {
  let sc; try { sc = JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8')); } catch (e) { continue; }
  const p = (sc.panels || []).find((x) => x.id === PANEL);
  if (p) { oldId = String(p.sessionId || ''); sceneId = String(sc.id || f.replace(/\.json$/, '')); break; }
}
if (!oldId) { console.error('✗ 找不到面板或它没绑 sessionId：' + PANEL); process.exit(2); }

const sessions = loadSessions();
const old = sessions.get(oldId);
say('面板 ' + PANEL + '（场景 ' + sceneId + '）· 旧会话 ' + oldId + '「' + ((old && old.title) || '') + '」');

const TIP = '【换会话前交接】请现在把本轮结论写进本场景的 `场景记忆\\<场景>\\场景私有记忆.md` 的 §〇，口径按 `工具\\场景记忆.mjs 交接` 的四小节：'
  + '① 上次交接 ② 当前项目 ③ 私有记忆变更 ④ 下一步/卡点。只改这四小节，别新建文件、别动历史段落。'
  + '写完只回一句「交接已更新」即可，不要做别的事。';

if (DRY) { say('\n--dry：将投递如下提示，然后等轮次结束再轮换。\n' + TIP); process.exit(0); }

// 2. 投递 + 等这一轮结束（按轮数，不按时间猜）
const before = turnStats(readEvents(transcriptOf(oldId)));
const turnsBefore = before ? before.count : 0;
say('投递交接提示（该会话当前已完成 ' + turnsBefore + ' 轮）…');
try {
  const cookie = await getCookie();
  await promptSession(oldId, TIP, cookie);
} catch (e) {
  console.error('✗ 投递失败，未换会话：' + ((e && e.message) || e));
  process.exit(4);
}
const t0 = Date.now();
let done = false;
while (Date.now() - t0 < TIMEOUT * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  const now = turnStats(readEvents(transcriptOf(oldId)));
  const n = now ? now.count : 0;
  if (n > turnsBefore) { done = true; break; }
}
if (!done) {
  console.error('✗ 等交接超时（' + TIMEOUT + ' 秒内旧会话没跑完那一轮）⇒ 已放弃换会话，绑定没动。');
  process.exit(4);
}
say('✓ 交接那一轮已结束（' + Math.round((Date.now() - t0) / 1000) + ' 秒）');

// 3. 不带 --force 正换：2 小时交接闸自然生效
const r = spawnSync(process.execPath, [path.join(SHELL, 'scripts', '换会话.mjs'), PANEL, '--go'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20 });
if (r.stdout) say(String(r.stdout));
if (r.stderr) console.error(String(r.stderr));
process.exit(r.status == null ? 1 : r.status);
