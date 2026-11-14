// 自动记忆整理.mjs —— 把"场景记忆 整理"做成不需要人记着的定时活（2026-11-14 新增）
// 为什么有它：`整理 --days 180` 能把超过半年的条目搬进 归档\（防止 决策\/坑\ 无限堆到几百篇），
//   但原来全靠人记得手动跑 ⇒ 本机 `程序开发` 已经堆了 31 篇、check 一直在报 warning。
//
// 它做什么（全部复用现有命令，不另立第二套判据）：
//   1) 每个场景先 `整理 --dry` 看计划；
//   2) 真有要搬的 ⇒ 先 `记忆打包.mjs 打包` 留一份快照（可回退），再 `整理` 真搬；
//      —— 整理自带护栏：被 定论.sources / 他条 evidence 引用的条目不搬（不加 --强搬）
//   3) 搬完刷 `索引 --all` + `近期记忆 生成 --all`（_近期.md 跟着变，不然注入的还是旧内容）；
//   4) 最后 `check --all` 复核，结果落 `外壳\data\记忆整理.json`，流水进 `外壳\data\自动维护.log`。
//
// 谁在跑它：main.js 引擎就绪后按 7 天节流自动跑（和巡检同一个 spawnTool，用机器配置的 nodeExe）。
// 用法（人手动跑也行）：
//   node 12-源码照搬\工具\自动记忆整理.mjs            真跑一遍
//   node 12-源码照搬\工具\自动记忆整理.mjs --dry      只看计划，一篇都不动
// 退出码：0 = 跑完（有没有搬动看结果）；1 = 有场景整理失败；2 = 前置不成立

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nodeExe } from './环境.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)                                                  // 12-源码照搬
const MEMROOT = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆')
const OUT = path.join(ROOT, '外壳', 'data', '记忆整理.json')
const AUTO_LOG = path.join(ROOT, '外壳', 'data', '自动维护.log')
const TOOL = path.join(HERE, '场景记忆.mjs')
const RECENT = path.join(HERE, '近期记忆.mjs')
const PACK = path.join(HERE, '记忆打包.mjs')
const DRY = process.argv.includes('--dry')

const exists = (p) => { try { return fs.existsSync(p) } catch (e) { return false } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }
function autoLog(line) {
  try { fs.appendFileSync(AUTO_LOG, '[' + new Date().toISOString() + '] ' + line + '\r\n') } catch (e) { /* 不阻塞 */ }
}

let NODE = process.execPath
try { NODE = nodeExe() || NODE } catch (e) { autoLog('取 nodeExe 失败，退回本进程：' + ((e && e.message) || e)) }

// 1. 跑一条子命令，拿退出码 + 输出（统一超时 180s）
function run(file, args) {
  const r = spawnSync(NODE, [file].concat(args || []), {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  })
  return { code: r.status, out: (String(r.stdout || '') + String(r.stderr || '')).trim(), err: r.error ? String(r.error.message || r.error) : '' }
}

// 2. 场景清单：标准根下的目录（跳过 _ 开头的共享层），且必须真有 场景私有记忆.md
function listScenes() {
  if (!exists(MEMROOT)) return []
  return fs.readdirSync(MEMROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .filter((e) => exists(path.join(MEMROOT, e.name, '场景私有记忆.md')))
    .map((e) => e.name)
    .sort()
}

function main() {
  if (!exists(TOOL)) { console.error('✗ 找不到 场景记忆.mjs：' + TOOL); process.exit(2) }
  const scenes = listScenes()
  if (!scenes.length) { console.error('✗ 场景记忆根下没有可用场景：' + MEMROOT); process.exit(2) }

  const items = []
  let planned = 0
  for (const s of scenes) {
    const r = run(TOOL, ['整理', '--场景', s, '--days', '180', '--dry'])
    const n = Number((r.out.match(/(\d+)\s*篇待搬/) || [])[1] || 0)
    planned += n
    items.push({ scene: s, planned: n, moved: 0, skipped: 0, code: r.code, note: n ? '' : '无旧条目' })
    if (n) autoLog('整理计划：' + s + ' 有 ' + n + ' 篇超 180 天待搬 归档\\')
  }

  // 3. 真要动之前先留快照（记忆打包只留 10 份，按份轮转）—— 没有可搬的就完全不碰
  let snapshot = '无需（没有可搬条目）'
  if (planned > 0 && !DRY) {
    const p = run(PACK, ['打包'])
    snapshot = p.code === 0 ? '已打包' : ('打包失败：' + (p.out.split(/\r?\n/).pop() || p.code))
    if (p.code !== 0) {
      // 快照拿不到就不搬：宁可这周不整理，也不要在没有回退点的情况下移动历史条目
      autoLog('✗ 快照失败，本轮不搬：' + snapshot)
      for (const it of items) it.note = it.planned ? '快照失败，未搬' : it.note
      writeAndReport(items, snapshot)
      process.exit(1)
    }
    autoLog('已留快照（记忆打包）')
  }

  if (planned === 0) { items.forEach((i) => { if (!i.note) i.note = '无旧条目' }); writeAndReport(items, snapshot); return }

  if (!DRY) {
    for (const it of items) {
      if (!it.planned) continue
      const r = run(TOOL, ['整理', '--场景', it.scene, '--days', '180'])
      it.code = r.code
      it.moved = Number((r.out.match(/已搬\s*(\d+)\s*篇/) || [])[1] || 0)
      it.skipped = it.planned - it.moved
      it.note = it.skipped ? (it.skipped + ' 篇被引用未搬') : ''
      if (r.code !== 0) it.note = (it.note ? it.note + '；' : '') + '退出码 ' + r.code + '：' + (r.out.split(/\r?\n/).pop() || '')
      autoLog('整理：' + it.scene + ' 搬 ' + it.moved + ' 篇进 归档\\' + (it.skipped ? '（' + it.skipped + ' 篇被引用未搬）' : ''))
    }
    // 4. 只有**真搬过**才刷索引与近期记忆：没搬一遍也会重写 `_近期.md` 的"生成于"时间戳，
    //    平白把 7 个场景文件弄脏（2026-11-14 实测：0 篇待搬时刷完只多了 7 行时间戳 diff）
    const movedTotal = items.reduce((a, b) => a + b.moved, 0)
    if (movedTotal > 0) {
      const idx = run(TOOL, ['索引', '--all'])
      autoLog('索引 --all：' + (idx.code === 0 ? '已刷新' : '失败（退出码 ' + idx.code + '）'))
      if (exists(RECENT)) {
        const rec = run(RECENT, ['生成', '--all'])
        autoLog('近期记忆 生成 --all：' + (rec.code === 0 ? '已刷新' : '失败（退出码 ' + rec.code + '）'))
      }
      // 5. 复核：整理会顺带查一次单场景，这里再全量过一遍
      const chk = run(TOOL, ['check', '--all'])
      autoLog('整理后 check --all：' + (chk.code === 0 ? '通过' : '未通过（退出码 ' + chk.code + '，详情手动跑 check --all）'))
    } else {
      autoLog('没有搬动条目：索引与近期记忆保持原样（不刷时间戳）')
    }
  }

  writeAndReport(items, snapshot)
}

function writeAndReport(items, snapshot) {
  const at = new Date().toISOString()
  const doc = {
    at, node: NODE, dry: DRY, memroot: MEMROOT, snapshot,
    scenes: items.length,
    planned: items.reduce((a, b) => a + b.planned, 0),
    moved: items.reduce((a, b) => a + b.moved, 0),
    items,
  }
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\r\n', 'utf8')
  } catch (e) { autoLog('写 记忆整理.json 失败：' + ((e && e.message) || e)) }
  const bad = items.filter((i) => i.code !== 0)
  autoLog('记忆整理：' + doc.scenes + ' 个场景，计划搬 ' + doc.planned + ' 篇，实搬 ' + doc.moved + ' 篇' + (bad.length ? '（失败 ' + bad.length + ' 个场景：' + bad.map((b) => b.scene).join(' / ') + '）' : ''))
  for (const i of items) {
    if (!i.planned) continue
    console.log((i.code === 0 ? '✓' : '✗') + ' ' + i.scene.padEnd(12, '　') + ' 计划 ' + i.planned + ' · 实搬 ' + i.moved + (i.skipped ? ' · 跳过 ' + i.skipped : '') + (i.note ? ' · ' + i.note : ''))
  }
  console.log('\n' + (doc.planned ? (DRY ? '[dry] 计划搬 ' + doc.planned + ' 篇（未动任何文件）' : '✓ 实搬 ' + doc.moved + ' 篇（快照：' + snapshot + '）') : '· 所有场景都没有超 180 天的条目，什么都没动'))
  console.log('结果写进 ' + OUT)
  process.exit(bad.length ? 1 : 0)
}

main()
