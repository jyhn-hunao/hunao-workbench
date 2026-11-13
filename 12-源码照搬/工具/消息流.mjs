// 消息流.mjs —— 命令行看「社交」场景的消息流与通道状态（2026-11-13）
//
// 为什么要有它：面板（so-msg · msgflow）走的是同一条数据面（外壳\社交.js），
//   命令行只是把同一条数据面摊开，改完代码先在这里验，不用去界面点。
//
// 用法：
//   node 12-源码照搬\工具\消息流.mjs --标题 社交 --条数 20
//   node 12-源码照搬\工具\消息流.mjs --会话 session-f0e4192d-… --json
//   node 12-源码照搬\工具\消息流.mjs --标题 社交 --json > 流.json
//
// 参数：
//   --标题 <场景会话标题> / --会话 <sessionId>：二选一；都给时以 --会话 为准
//   --条数 <n>：默认 20（面板里是 40）
//   --json：原样输出数据（给别处加工用）；不加就是给人看的表格
'use strict';

import svc from '../外壳/社交.js';
import { loadSessions, resolveSession, DSH_HOME } from './派发-公共.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const wantId = arg('会话', '');
const wantTitle = arg('标题', '');
const limit = Number(arg('条数', '20')) || 20;
const asJson = process.argv.includes('--json');

function pickSession() {
  if (wantId) return { id: wantId, title: '' };
  const s = resolveSession(loadSessions(), wantTitle || '社交');
  if (!s) throw new Error('认不出会话：' + (wantTitle || '社交') + '（先跑 sessions.mjs --check）');
  return { id: s.id, title: s.title };
}

function hhmm(ms) {
  const d = new Date(Number(ms) || 0);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

const sess = pickSession();
const service = svc.createService({ dshHome: DSH_HOME });
const out = await service.flow({ sessionId: sess.id, sessionTitle: sess.title, limit });

if (asJson) {
  process.stdout.write(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.log('会话：' + (out.session.title || '') + ' ' + out.session.id);
console.log('转录：' + (out.session.found ? '找到（' + out.session.events + ' 个事件）' : '没找到（场景会话可能已被归档/换掉）'));
console.log('通道：');
for (const c of out.channels) console.log('  [' + c.state + '] ' + c.label + '：' + c.detail);
console.log('消息：' + out.messages.length + ' 条' + (out.messages.length ? '' : '（还没人说话）'));
for (const m of out.messages) {
  const who = m.role === 'her' ? '她' : '对面';
  console.log('  ' + hhmm(m.at) + '  ' + who + '  ' + m.text.replace(/\n/g, ' / '));
}
