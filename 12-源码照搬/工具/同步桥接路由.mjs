#!/usr/bin/env node
// 同步桥接路由.mjs —— 把 QQ 桥接的 routes 指回「人格会话」（2026-11-13）
//
// 为什么有它：换成一条新的人格会话后，插件里 routes.private[*].sessionId 还是旧 id，
//   消息会被投进已归档的旧会话（这次实测踩过）。换会话脚本会自动调它，也可以手动跑。
//
// 读：外壳\scenarios\pet.json 的 pet-ai（sessionId / sessionTitle）
// 写：%USERPROFILE%\.dsh\qq-bridge.config.json（插件的唯一配置源；改前备份 .bak-时间戳）
//
// 用法：node 12-源码照搬\工具\同步桥接路由.mjs [--dry]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PET = path.join(ROOT, '外壳', 'scenarios', 'pet.json');
const CONF = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json');
const dry = process.argv.includes('--dry');
const say = (s) => console.log(s);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

const pet = readJson(PET);
const panel = ((pet && pet.panels) || []).filter((p) => p && p.id === 'pet-ai')[0];
const sid = String((panel && panel.sessionId) || '');
if (!sid) { say('✗ pet.json 里没有 pet-ai 的 sessionId'); process.exit(2); }

if (!fs.existsSync(CONF)) {
  say('✗ 插件配置不存在：' + CONF + '（先按 插件\\社交通道\\说明.md §11 生成一份）');
  process.exit(3);
}
const cfg = readJson(CONF);
if (!cfg) { say('✗ 插件配置不是合法 JSON：' + CONF); process.exit(3); }

const routes = (cfg.routes && cfg.routes.private) || {};
const keys = Object.keys(routes);
if (!keys.length) {
  say('⚠ 配置里 routes.private 为空 ⇒ 没有要同步的对方号（插件会忽略所有私聊）');
  process.exit(4);
}

const changed = [];
for (const k of keys) {
  const before = String(routes[k].sessionId || '');
  if (before !== sid) { routes[k].sessionId = sid; changed.push(k + ': ' + (before || '(空)') + ' → ' + sid); }
}
// 兼容老字段（顶层 sessionId / peerUin 那套，有就一起对齐）
let legacy = false;
if (cfg.sessionId !== undefined && String(cfg.sessionId) !== sid) { cfg.sessionId = sid; legacy = true; }

if (!changed.length && !legacy) { say('✓ 已经是最新：routes 全部指向 ' + sid); process.exit(0); }
if (dry) { say('（--dry）会改：' + (changed.join('；') || '顶层 sessionId')); process.exit(0); }

const bak = CONF + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
fs.copyFileSync(CONF, bak);
const tmp = CONF + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, CONF);
say('✓ 已同步 ' + changed.length + ' 条路由 → ' + sid + '（备份 ' + path.basename(bak) + '）');
say('  重启整壳后插件才会重新读配置（引擎生命周期归壳，见 AGENTS.md §8）');
