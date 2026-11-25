#!/usr/bin/env node
// @功能台 {"name":"项目记忆巡检","group":"memory","freq":"daily","plain":"遍历 项目.json 里所有带 memory 的外部项目，跑一遍记忆体检；索引过期/备份缺失会自动重建/补备份。","why":"自动巡检原来只体检工作台本体，mlw 这类外部项目的记忆漂移只能靠人手动跑，问题会压到收工才暴露。","label":"跑一遍","timeout":300000}
// 项目记忆巡检.mjs —— 把「外部项目记忆体检」纳入自动巡检（2026-11-24）
//
// 为什么有它：自动巡检的 记忆体检 任务写死了 --project <工作台本体>，
//   项目.json 里注册的 mlw / ai-compilation-specifications 等外部项目从未被巡检；
//   它们的索引过期、证据失效、备份缺失只能等人在对应项目里手动跑 体检 才发现。
//   main.js 只在巡检有失败时弹 toast，覆盖不到 = 永远不会主动提示。
//
// 做法（体检会自愈派生文件：索引过期自动重建、备份缺失/超 30 天自动补；不改人写正文）：
//   读 _共享记忆\项目.json → 对每个 status=active、memoryRoot 下真有 memory\ 的项目，
//   跑 `记忆.mjs 体检 --project <根> --noscene`；场景层由 自动巡检 的 场景记忆 check --all 单独跑，
//   这里不重复。工作台本体默认跳过（自动巡检已有 记忆体检 任务）。
//
// 用法：
//   node 12-源码照搬\工具\项目记忆巡检.mjs           跑一遍，打印摘要
//   node 12-源码照搬\工具\项目记忆巡检.mjs --json    机器可读
//   node 12-源码照搬\工具\项目记忆巡检.mjs --include-workbench
// 退出码：0 = 全部通过；1 = 有项目体检失败；2 = 前置不成立（项目.json / 记忆.mjs 不在）

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nodeExe } from './环境.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))       // 12-源码照搬\工具
const ROOT = path.dirname(HERE)                                 // 12-源码照搬
const REPO = path.dirname(ROOT)                                 // 工作台仓根
const MEMROOT = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆')
const REGISTRY = path.join(MEMROOT, '_共享记忆', '项目.json')
const MEMTOOL = path.join(HERE, '记忆.mjs')
const JSON_OUT = process.argv.includes('--json')
const INCLUDE_WB = process.argv.includes('--include-workbench')

const exists = (p) => { try { return fs.existsSync(p) } catch (e) { return false } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

// 1. 项目清单：只认 active、memoryRoot 下真有 memory\ 的；同一根只跑一次
function listProjects() {
  const reg = readJson(REGISTRY)
  if (!reg || !Array.isArray(reg.projects)) {
    throw new Error('项目注册表读不到或格式不对：' + REGISTRY)
  }
  const rows = []
  const seen = new Set()
  for (const p of reg.projects) {
    if (!p || typeof p !== 'object') continue
    if (p.status && p.status !== 'active') continue
    const raw = String(p.memoryRoot || (Array.isArray(p.paths) && p.paths[0]) || '').trim()
    if (!raw) continue
    const root = path.resolve(raw)
    const key = root.toLowerCase()
    if (seen.has(key)) continue
    if (!exists(path.join(root, 'memory'))) continue
    if (!INCLUDE_WB && key === path.resolve(REPO).toLowerCase()) continue
    seen.add(key)
    rows.push({ name: String(p.name || path.basename(root)), root })
  }
  return rows
}

// 2. 跑一个项目的体检；只取最后一条 ✗ 作为摘要
function runOne(item, node) {
  const t0 = Date.now()
  const r = spawnSync(node, [MEMTOOL, '体检', '--project', item.root, '--noscene'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env),
  })
  const out = (String(r.stdout || '') + '\n' + String(r.stderr || '')).trim()
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const failLine = lines.filter((l) => l.startsWith('✗')).pop() || lines[lines.length - 1] || ''
  return {
    name: item.name,
    root: item.root,
    ok: r.status === 0 && !r.error,
    code: r.status,
    ms: Date.now() - t0,
    tail: failLine.replace(/^✗\s+/, '').slice(0, 240),
    err: r.error ? String(r.error.message || r.error) : '',
  }
}

// 3. 主流程
function main() {
  if (!exists(MEMTOOL)) { console.error('✗ 记忆.mjs 不在：' + MEMTOOL); return 2 }
  let rows
  try { rows = listProjects() } catch (e) { console.error('✗ ' + ((e && e.message) || e)); return 2 }
  if (!rows.length) {
    if (JSON_OUT) console.log(JSON.stringify({ at: new Date().toISOString(), total: 0, fails: 0, items: [] }, null, 2))
    else console.log('· 没有需要巡检的外部项目（项目.json 里没有带 memory 的非工作台项目）')
    return 0
  }
  let node = process.execPath
  try { node = nodeExe() || node } catch (e) { /* 取不到就用当前进程 */ }

  const items = rows.map((x) => runOne(x, node))
  const fails = items.filter((x) => !x.ok)
  if (JSON_OUT) {
    console.log(JSON.stringify({
      at: new Date().toISOString(), total: items.length, fails: fails.length,
      workbenchSkipped: !INCLUDE_WB, items,
    }, null, 2))
  } else {
    console.log('[项目记忆巡检] ' + new Date().toLocaleString('zh-CN', { hour12: false }))
    console.log((fails.length
      ? '✗ 项目记忆巡检：' + fails.length + '/' + items.length + ' 有问题'
      : '✓ 项目记忆巡检：' + items.length + ' 个项目全部通过') + (INCLUDE_WB ? '' : '（工作台本体由「记忆体检」覆盖）'))
    for (const x of items) {
      console.log((x.ok ? '✓ ' : '✗ ') + x.name + '：' + (x.ok ? '健康' : (x.tail || ('退出码 ' + x.code))) + ' · ' + (x.ms / 1000).toFixed(1) + 's')
    }
  }
  return fails.length ? 1 : 0
}

process.exit(main())
