#!/usr/bin/env node
// 场景改名核对.mjs —— 改一次场景名，五处必须一起动，否则图上/登记表悄悄过期（2026-11-14）
//
// 为什么要有它：把「命令」改成「记忆」那次只改了 scenarios 与 skills，共享登记表还指着旧面板 id `cmd-chat`，
//   于是神经元上多出一个重复区域、12 条依赖边悬空 —— 但没有任何一处会报错。
//   这类「隐式契约」靠人记不住，落成一条只读闸门：跑一遍就知道哪一处还在旧名字上。
//
// 查什么（全部只读，不修）：
//   ① 共享登记表 `_共享记忆\索引.json` 的区域 owner / panel 必须是某份场景 json 里真实存在的面板 id；
//   ② 区域指向的记忆目录（`场景记忆\<名>`）必须存在；
//   ③ 区域指向的 `areas\<id>.md` 必须存在，且正文里的「场景 id：」与登记表 id 一致；
//   ④ `_共享记忆\场景目录.json` 的场景 id 与 scenarios\*.json 的 id 必须互相覆盖；
//   ⑤ `_共享记忆\记忆地图.json` 的 panel 也必须落在真实面板 id 里。
//
// 用法：node 外壳\scripts\场景改名核对.mjs [--json]
// 退出码：0 全对齐 / 1 有错位（stderr 之外按行列出，谁错在哪一处）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.resolve(HERE, '..')
const ROOT = path.resolve(SHELL, '..')                       // 12-源码照搬
const MEM = path.join(process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh'), '场景记忆')
const SHARED = path.join(MEM, '_共享记忆')
const JSON_OUT = process.argv.includes('--json')

const rows = []
const bad = []
function say(ok, msg) { rows.push({ ok, msg }); if (!ok) bad.push(msg) }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { say(false, '读不动 ' + p + '：' + e.message); return null }
}

// 1. 真实场景与面板 id（唯一真源 = scenarios\*.json）
const scenDir = path.join(SHELL, 'scenarios')
const scenFiles = fs.readdirSync(scenDir).filter((f) => f.endsWith('.json'))
const scenes = []
const panelIds = new Set()
for (const f of scenFiles) {
  const j = readJson(path.join(scenDir, f))
  if (!j) continue
  const panels = (j.panels || []).map((p) => p.id).filter(Boolean)
  panels.forEach((id) => panelIds.add(id))
  scenes.push({ file: f, id: j.id, name: j.name, panels })
}

// 2. 共享登记表：区域 owner / panel
const idx = readJson(path.join(SHARED, '索引.json'))
if (idx && Array.isArray(idx.areas)) {
  for (const a of idx.areas) {
    for (const k of ['owner', 'panel']) {
      if (a[k] && !panelIds.has(a[k])) say(false, '索引.json 区域「' + (a.name || a.id) + '」的 ' + k + '=' + a[k] + ' 不是任何场景 json 里的面板 id（大概是改名前的旧 id）')
    }
    // 3. 记忆目录
    if (a.memory) {
      const mp = path.join(MEM, String(a.memory).replace(/^场景记忆[\\/]/, '').replace(/\//g, path.sep))
      if (!fs.existsSync(mp)) say(false, '索引.json 区域「' + (a.name || a.id) + '」的记忆目录不存在：' + mp)
    }
    // 4. areas/*.md 与正文里的场景 id
    if (a.file) {
      const fp = path.join(SHARED, String(a.file).replace(/\//g, path.sep))
      if (!fs.existsSync(fp)) say(false, '索引.json 区域「' + (a.name || a.id) + '」的 areas 文件不存在：' + fp)
      else {
        const t = fs.readFileSync(fp, 'utf8')
        const m = t.match(/场景 id：\s*([^\s]+)/)
        const clean = (s) => String(s || '').replace(/[`"'（(]/g, '').trim()
        if (m && a.id && clean(m[1]) !== clean(a.id)) say(false, 'areas 文件 ' + a.file + ' 写的是「场景 id：' + m[1] + '」，但登记表区域 id 是「' + a.id + '」')
        const mp = t.match(/记忆：\s*([^\r\n]+)/)
        if (mp && a.memory) {
          const norm = (s) => String(s).replace(/[\\/]+/g, '/').replace(/^场景记忆\//, '').replace(/\.md$/, '').trim()
          if (norm(mp[1]) !== norm(a.memory) + '/场景私有记忆') {
            // 只提示，不算错（写法有多种：目录或文件路径都合法）
            rows.push({ ok: true, msg: '（提示）' + a.file + ' 的「记忆：' + mp[1].trim() + '」与登记表 ' + a.memory + ' 写法不同，实际目录以登记表为准' })
          }
        }
      }
    }
  }
}

// 5. 场景目录.json 与 scenarios 互相覆盖
//    场景目录只收「有记忆目录」的场景（console 这类纯界面场景本来就不在里面），所以比对前先按目录存在与否筛一遍
const dir = readJson(path.join(SHARED, '场景目录.json'))
if (dir && Array.isArray(dir.scenes)) {
  const dirIds = new Set(dir.scenes.map((s) => s.id))
  const withMem = scenes.filter((s) => s.name && fs.existsSync(path.join(MEM, s.name)))
  const withMemIds = new Set(withMem.map((s) => s.id))
  for (const s of withMem) if (!dirIds.has(s.id)) say(false, '场景目录.json 缺场景「' + s.id + '」（它有记忆目录，应该被索引 --all 收进去）')
  for (const id of dirIds) if (!withMemIds.has(id)) say(false, '场景目录.json 多出场景「' + id + '」（没有对应的记忆目录或场景 json）')
  for (const s of dir.scenes) {
    for (const p of (s.panels || s.panel ? (Array.isArray(s.panels) ? s.panels : [s.panel]) : [])) {
      if (p && !panelIds.has(p)) say(false, '场景目录.json 场景「' + (s.name || s.id) + '」的面板 ' + p + ' 不在任何场景 json 里')
    }
  }
}

// 6. 记忆地图.json 的 panel
const map = readJson(path.join(SHARED, '记忆地图.json'))
if (map && Array.isArray(map.areas)) {
  for (const a of map.areas) {
    if (a.panel && !panelIds.has(a.panel)) say(false, '记忆地图.json 区域「' + (a.name || a.id) + '」的 panel=' + a.panel + ' 不是真实面板 id')
  }
}

say(true, '场景 ' + scenes.length + ' 个 · 面板 ' + panelIds.size + ' 个 · 区域 ' + ((idx && idx.areas && idx.areas.length) || 0) + ' 条')

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: bad.length === 0, errors: bad, rows }, null, 2))
} else {
  for (const r of rows) console.log((r.ok ? '✓ ' : '✗ ') + r.msg)
  console.log(bad.length ? ('\n改名核对：' + bad.length + ' 处错位（改场景名/面板名时，这五处要一起改）') : '\n改名核对通过 ✓')
}
process.exit(bad.length ? 1 : 0)
