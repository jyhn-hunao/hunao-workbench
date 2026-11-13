#!/usr/bin/env node
// 同步桥接路由.mjs —— 兼容壳（2026-11-13）
//
// 这活已经泛化成 工具\同步人格引用.mjs（场景 json 里的通道卡片 + QQ routes 一起对齐）。
// 保留本文件只为不打断既有调用（换会话.mjs、文档、人的肌肉记忆）；逻辑不在这里维护，
// 一律转发，参数与退出码原样透传。⛔ 不要往这里加新逻辑，否则又会出现两份实现。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '同步人格引用.mjs');
const r = spawnSync(process.execPath || 'node', [target].concat(process.argv.slice(2)), { stdio: 'inherit' });
process.exit(r.status == null ? 4 : r.status);
