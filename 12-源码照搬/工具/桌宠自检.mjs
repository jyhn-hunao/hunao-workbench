#!/usr/bin/env node
// 桌宠自检.mjs —— 把「审批策略 / 路由 / 主动闸门」当成可回归的行为测一遍（2026-11-13）
//
// 为什么要它：这三条是桌宠的规矩（谁能派、要不要人点头、什么时候能主动），
//   改设置面板、改路由、改注入都可能把它们改坏。用固定用例钉住，跑一次就知道有没有回归。
// 只读真配置做「默认值」参考，不读写真实次数账（主动闸门用临时 stateFile）。
//
// 用法：node 12-源码照搬\工具\桌宠自检.mjs      # 全过 exit 0，任一失败 exit 1
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pet = require('../外壳/桌宠设置.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rows = [];
const t = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail || '' });

// 1. 路由：命中就带场景与级别；认不出就列候选（⛔ 不猜）
const S = {
  persona: { proactive: 'normal' },
  tools: { allow: ['scene_memory_read', 'dispatch'], deny: ['shell'] },
  approval: { read: 'auto', write_mem: 'auto', write_code: 'ask', outbound: 'ask' },
  quiet: { from: '23:30', to: '08:00', proactiveMaxPerHour: 2 },
  routes: [
    { keywords: ['B站', '视频'], to: 'B站', level: 'read' },
    { keywords: ['项目', 'bug'], to: '程序开发·工作区', level: 'confirm' },
    { keywords: ['清理', '磁盘'], to: '本地电脑', level: 'never' },
  ],
};
const r1 = pet.resolveRoute('B站那期视频的脚本在哪', S);
t('路由命中 B站（read）', r1.hit && r1.hit.to === 'B站' && r1.hit.level === 'read', JSON.stringify(r1.hit));
const r2 = pet.resolveRoute('今天天气怎么样', S);
t('认不出时不猜、给候选', !r2.hit && (r2.candidates || []).length === 3, (r2.candidates || []).join('/'));

// 2. 审批：通道降级 / 全局只读要问 / never 直接禁
const p1 = pet.dispatchPolicy('（QQ 私聊）帮我看下项目里的 bug', { to: '程序开发·工作区', level: 'confirm' }, S);
t('通道来的 confirm ⇒ 升到 never', p1.level === 'never', p1.reason);
const p2 = pet.dispatchPolicy('（QQ 私聊）B站有什么新视频', { to: 'B站', level: 'read' }, S);
t('通道来的 read ⇒ 升到 confirm', p2.level === 'confirm' && p2.confirm === true, p2.reason);
const p3 = pet.dispatchPolicy('B站有什么新视频', { to: 'B站', level: 'read' }, S);
t('本地 read ⇒ 直接派', p3.level === 'read' && p3.confirm === false, p3.reason);
const p4 = pet.dispatchPolicy('清理一下磁盘', { to: '本地电脑', level: 'never' }, S);
t('路由 never ⇒ 禁止', p4.level === 'never', p4.reason);
const S2 = JSON.parse(JSON.stringify(S));
S2.approval.read = 'ask';
const p5 = pet.dispatchPolicy('B站有什么新视频', { to: 'B站', level: 'read' }, S2);
t('设置「只读也要问」⇒ read 升 confirm', p5.level === 'confirm', p5.reason);

// 3. 主动闸门：档位 / 免打扰（含跨零点）/ 每小时上限，计数独立记账
const tmpState = path.join(ROOT, '外壳', 'data', 'pet', '自检-主动.json');
try { fs.rmSync(tmpState, { force: true }); } catch (e) { /* ignore */ }
const g1 = pet.proactiveGate({ persona: { proactive: 'low' }, quiet: {}, }, { now: '2026-11-13T10:00:00', stateFile: tmpState });
t('少吭声档 ⇒ 不主动', g1.ok === false, g1.reason);
const g2 = pet.proactiveGate({ persona: { proactive: 'normal' }, quiet: { from: '23:30', to: '08:00', proactiveMaxPerHour: 2 } }, { now: '2026-11-13T23:45:00', stateFile: tmpState });
t('免打扰（同一天内）⇒ 不主动', g2.ok === false, g2.reason);
const g3 = pet.proactiveGate({ persona: { proactive: 'normal' }, quiet: { from: '23:30', to: '08:00', proactiveMaxPerHour: 2 } }, { now: '2026-11-13T02:15:00', stateFile: tmpState });
t('免打扰（跨零点）⇒ 不主动', g3.ok === false, g3.reason);
const q = { from: '23:30', to: '08:00', proactiveMaxPerHour: 2 };
const sObj = { persona: { proactive: 'normal' }, quiet: q };
const a1 = pet.proactiveGate(sObj, { now: '2026-11-13T10:00:00', stateFile: tmpState, record: true });
const a2 = pet.proactiveGate(sObj, { now: '2026-11-13T10:10:00', stateFile: tmpState, record: true });
const a3 = pet.proactiveGate(sObj, { now: '2026-11-13T10:20:00', stateFile: tmpState, record: true });
t('可主动时放行并记账', a1.ok === true && a2.ok === true, 'used=' + a2.used);
t('到上限后拦住（默认 2 次/小时）', a3.ok === false, a3.reason);
try { fs.rmSync(tmpState, { force: true }); } catch (e) { /* ignore */ }

// 4. 引用一致性：人格会话在场景 json / QQ 路由里必须指同一个 id
//    用子进程跑 --check（同步脚本本身是 CLI，直接 import 会执行它的主流程）
const { spawnSync } = await import('node:child_process');
const syncRun = spawnSync(process.execPath, [path.join(ROOT, '工具', '同步人格引用.mjs'), '--check'], { encoding: 'utf8' });
t('场景 json 与 QQ 路由都指向同一条人格会话', syncRun.status === 0, (syncRun.stdout || '').trim().split('\n')[0] || ('exit ' + syncRun.status));

// 5. 场景表：让她「去工作台记忆里找」时有准确名字，而不是猜目录名
const scRun = spawnSync(process.execPath, [path.join(ROOT, '工具', '桌宠.mjs'), '场景', '--json'], { encoding: 'utf8' });
let scRows = [];
try { scRows = JSON.parse(scRun.stdout || '[]'); } catch (e) { scRows = []; }
t('场景表能列出场景与可派会话', scRun.status === 0 && scRows.length >= 3 && scRows.some((x) => x.titles && x.titles.length), '场景数=' + scRows.length);

// 5. 报告
rows.forEach((r) => console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : '')));
const bad = rows.filter((r) => !r.ok).length;
console.log(bad ? '\n⛔ 桌宠自检：' + bad + ' 项未通过' : '\n✅ 桌宠自检全部通过（' + rows.length + ' 项）');
process.exit(bad ? 1 : 0);
