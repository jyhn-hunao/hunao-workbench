#!/usr/bin/env node
// 同步人格引用.mjs（原名 同步桥接路由.mjs）—— 把「引用人格会话」的地方一次性对齐（2026-11-13）
//
// 为什么要泛化：换一条人格会话后，引用旧 id 的不止 QQ 桥接，还有社交场景里按平台分的卡片
//   （social.json 的 ch-qq / ch-feishu / so-msg）。只改一处 = 卡片读到空会话、QQ 消息投进已归档的会话。
//
// 唯一真源：外壳\scenarios\pet.json 的 panel `pet-ai`（sessionId + sessionTitle）。
// 同步范围：
//   1) 外壳\scenarios\*.json 里 sessionTitle 与人格相同的面板（通道卡片 / 消息流）→ 改 sessionId
//   2) %USERPROFILE%\.dsh\qq-bridge.config.json 的 routes.private[*].sessionId（+ 老字段 sessionId）
// 安全：写前备份（.bak-时间戳）；json 原子写（.tmp → rename）；幂等，没差异就只报「已是最新」。
//
// 用法：
//   node 12-源码照搬\工具\同步人格引用.mjs            # 对齐并报告
//   node 12-源码照搬\工具\同步人格引用.mjs --dry      # 只看会改什么
//   node 12-源码照搬\工具\同步人格引用.mjs --check    # 只判断是否一致（不一致 exit 3，给自检/发布前检查用）
// 兼容：旧名 同步桥接路由.mjs 仍可直接跑（本文件即按新名维护，旧文件是转发壳）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCEN = path.join(ROOT, '外壳', 'scenarios');
const PET = path.join(SCEN, 'pet.json');
const CONF = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json');
const DRY = process.argv.includes('--dry');
const CHECK = process.argv.includes('--check');
const say = (s) => console.log(s);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function stamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); }
function backup(f) { const b = f + '.bak-' + stamp(); fs.copyFileSync(f, b); return b; }
function writeAtomic(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

const pet = readJson(PET);
const panel = ((pet && pet.panels) || []).filter((p) => p && p.id === 'pet-ai')[0];
const sid = String((panel && panel.sessionId) || '');
const title = String((panel && panel.sessionTitle) || '');
if (!sid) { say('✗ pet.json 里没有 pet-ai 的 sessionId'); process.exit(2); }

const changes = [];

// 1. 场景 json：只动「标题与人格相同」的面板（不认识的面板一律不碰）
let files = [];
try { files = fs.readdirSync(SCEN).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch (e) { say('✗ 读不到场景目录：' + SCEN); process.exit(2); }
for (const f of files) {
  if (f === 'pet.json') continue;
  const full = path.join(SCEN, f);
  const j = readJson(full);
  if (!j || !Array.isArray(j.panels)) continue;
  let touched = 0;
  for (const p of j.panels) {
    if (!p || String(p.sessionTitle || '') !== title) continue;
    if (String(p.sessionId || '') === sid) continue;
    changes.push({ kind: 'scenario', file: f, panelId: String(p.id || ''), from: String(p.sessionId || '(空)'), to: sid });
    p.sessionId = sid;
    touched += 1;
  }
  if (touched && !DRY && !CHECK) {
    backup(full);
    writeAtomic(full, j);
  }
}

// 2. QQ 桥接配置：routes.private 全部对齐（插件重启后才会重新读）
if (fs.existsSync(CONF)) {
  const cfg = readJson(CONF);
  if (!cfg) { say('✗ 插件配置不是合法 JSON：' + CONF); process.exit(3); }
  const routes = (cfg.routes && cfg.routes.private) || {};
  let touched = 0;
  for (const k of Object.keys(routes)) {
    if (String(routes[k].sessionId || '') === sid) continue;
    changes.push({ kind: 'qq', key: k, from: String(routes[k].sessionId || '(空)'), to: sid });
    routes[k].sessionId = sid;
    touched += 1;
  }
  if (cfg.sessionId !== undefined && String(cfg.sessionId) !== sid) {
    changes.push({ kind: 'qq', key: '(顶层 sessionId)', from: String(cfg.sessionId), to: sid });
    cfg.sessionId = sid;
    touched += 1;
  }
  if (touched && !DRY && !CHECK) { backup(CONF); writeAtomic(CONF, cfg); }
} else {
  say('⚠ 找不到插件配置 ' + CONF + '（QQ 通道未生成过；跳过这一项）');
}

// 3. 报告
if (!changes.length) { say('✓ 已是最新：所有引用都指向 ' + sid + '（' + title + '）'); process.exit(0); }
say((CHECK ? '✗ 不一致' : (DRY ? '（--dry）会改 ' : '已同步 ')) + changes.length + ' 处 → ' + sid);
changes.forEach((c) => {
  if (c.kind === 'scenario') say('  · ' + c.file + ' / ' + c.panelId + '：' + c.from + ' → ' + c.to);
  else say('  · qq routes[' + c.key + ']：' + c.from + ' → ' + c.to);
});
if (CHECK) process.exit(3);
if (!DRY) {
  say('  ⚠ 场景 json 改动要重载面板才生效；QQ 配置要重启整壳后插件才重新读（引擎生命周期归壳）');
}
process.exit(0);
