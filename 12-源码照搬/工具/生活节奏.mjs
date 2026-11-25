#!/usr/bin/env node
// @功能台 {"name":"生活节奏","group":"生活","freq":"daily","plain":"查生活这段节奏：几点到几点刷、劲儿门槛、评论额度、刷到喜欢的喊不喊主人。真源 场景记忆\\生活\\节奏.json","why":"刷/评论/喊主人原来散在 刷内容.mjs 与 B站操作.mjs 的常量里，面板改不了；收成一处可读可改、脚本与面板同源","label":"生活节奏","timeout":15000}
// 生活节奏.mjs —— 「生活」场景三个"什么时候"的唯一真源（2026-11-25）
//
// 为什么有它：
//   · 刷内容.mjs 里 WAKE_FROM / BROWSE_MIN / GROW_PER_HOUR / BROWSE_COST 是写死的常量
//   · B站操作.mjs 里 12 时 / 30 天 / 120 秒 / 同视频 7 天 也是写死的
//   · 「刷到喜欢的要不要喊你」根本没有
//   现在三段收进 场景记忆\生活\节奏.json，面板（生活 → 节奏）与脚本都读这一份，只有一处默认。
//
// 三段：
//   browse  什么时候刷：from / to（HH:MM，清醒时段）、minEnergy（劲儿门槛）、growPerHour、cost
//   comment 什么时候能评论：enabled（总开关）、hourMax、dayMax、cooldownSec、videoCooldownDays
//   hail    刷到喜欢的喊不喊你：enabled、perDay、channel（auto / 微信 / QQ / 飞书）
//   每天刷几次 / 跳过概率 / 深读几条仍在 内容源.json（内容源面板改），这里不重复。
//
// 用法：node 12-源码照搬\工具\生活节奏.mjs 查 [--json]
// 读：  import { load } from './生活节奏.mjs'

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DSH = process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh');
export const FILE = path.join(DSH, '场景记忆', '生活', '节奏.json');

export const DEFAULT_RHYTHM = {
  browse: { from: '09:00', to: '23:30', minEnergy: 25, growPerHour: 6, cost: 25 },
  comment: { enabled: true, hourMax: 12, dayMax: 30, cooldownSec: 120, videoCooldownDays: 7 },
  hail: { enabled: true, perDay: 2, channel: 'auto' }
};

function p2(n) { return String(n).padStart(2, '0'); }

/** HH:MM → 分钟数；不合法返回 null */
export function toMin(v) {
  const m = String(v == null ? '' : v).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

/** 分钟数 → HH:MM（查里显示用） */
export function fmtHM(min) {
  const n = Math.max(0, Math.min(1439, Number(min) || 0));
  return p2(Math.floor(n / 60)) + ':' + p2(n % 60);
}

function clampNum(v, d, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
}

/** 深合并 + 夹紧：坏字段回默认，不整份作废 */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = r.browse && typeof r.browse === 'object' ? r.browse : {};
  const c = r.comment && typeof r.comment === 'object' ? r.comment : {};
  const h = r.hail && typeof r.hail === 'object' ? r.hail : {};
  const d = DEFAULT_RHYTHM;
  let from = toMin(b.from);
  let to = toMin(b.to);
  if (from == null) from = toMin(d.browse.from);
  if (to == null) to = toMin(d.browse.to);
  if (to <= from) { from = toMin(d.browse.from); to = toMin(d.browse.to); }   // 跨天不支持，坏值回默认
  return {
    browse: {
      from: fmtHM(from),
      to: fmtHM(to),
      fromMin: from,
      toMin: to,
      minEnergy: Math.round(clampNum(b.minEnergy, d.browse.minEnergy, 1, 100)),
      growPerHour: Math.round(clampNum(b.growPerHour, d.browse.growPerHour, 0, 50)),
      cost: Math.round(clampNum(b.cost, d.browse.cost, 0, 100))
    },
    comment: {
      enabled: c.enabled !== false,
      hourMax: Math.round(clampNum(c.hourMax, d.comment.hourMax, 1, 60)),
      dayMax: Math.round(clampNum(c.dayMax, d.comment.dayMax, 1, 300)),
      cooldownSec: Math.round(clampNum(c.cooldownSec, d.comment.cooldownSec, 0, 3600)),
      videoCooldownDays: Math.round(clampNum(c.videoCooldownDays, d.comment.videoCooldownDays, 0, 365))
    },
    hail: {
      enabled: h.enabled !== false,
      perDay: Math.round(clampNum(h.perDay, d.hail.perDay, 0, 10)),
      channel: ['auto', '微信', 'QQ', '飞书'].includes(String(h.channel || '')) ? String(h.channel) : 'auto'
    }
  };
}

/** 读配置：文件缺失/坏 JSON 都按默认跑，并把原因带出来（不静默） */
export function load() {
  let raw = null;
  let why = '';
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    why = fs.existsSync(FILE) ? '节奏.json 解析失败（按默认跑）：' + ((e && e.message) || e) : '节奏.json 还没有（按默认跑）';
  }
  const cfg = normalize(raw);
  cfg.note = why;
  return cfg;
}

function cmdShow() {
  const cfg = load();
  const out = {
    file: FILE,
    exists: fs.existsSync(FILE),
    note: cfg.note || '',
    browse: cfg.browse,
    comment: cfg.comment,
    hail: cfg.hail
  };
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log('生活节奏（真源 ' + path.relative(ROOT, FILE) + '）');
  if (!out.exists) console.log('· 文件还没有，下面是默认值（面板保存一次就会落盘）');
  if (cfg.note && out.exists) console.log('· ' + cfg.note);
  console.log('· 刷：' + cfg.browse.from + '–' + cfg.browse.to + ' · 劲儿 ≥' + cfg.browse.minEnergy
    + '（每小时 +' + cfg.browse.growPerHour + '，刷一次 −' + cfg.browse.cost + '）');
  console.log('· 评论：' + (cfg.comment.enabled ? '开' : '关') + ' · ' + cfg.comment.hourMax + ' 次/时 · '
    + cfg.comment.dayMax + ' 次/天 · 间隔 ' + cfg.comment.cooldownSec + ' 秒 · 同视频 ' + cfg.comment.videoCooldownDays + ' 天一次');
  console.log('· 喊你：' + (cfg.hail.enabled ? '开' : '关') + ' · 每天最多 ' + cfg.hail.perDay + ' 次 · 通道 ' + cfg.hail.channel);
  console.log('· 每天刷几次 / 跳过概率 / 深读几条 在 内容源.json（生活设置面板）');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = String(process.argv[2] || '查');
  if (cmd === '查') process.exit(cmdShow());
  console.error('用法：node 工具\\生活节奏.mjs 查 [--json]');
  process.exit(2);
}
