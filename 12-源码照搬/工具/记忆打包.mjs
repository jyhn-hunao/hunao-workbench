#!/usr/bin/env node
/**
 * 记忆打包 v1 · 可移植性安全网（2026-11-13）
 *
 * 定位：让记忆数据「丢不了、换得了」——git 之外再给一层独立于仓库的完整快照。
 * 零依赖（只用 Node 内置模块）；快照 = 目录拷贝 + sha256 清单，不做 zip（记忆体量小，省掉压缩依赖）。
 *
 * 用法：
 *   node 记忆打包.mjs 打包 [--到 <目录>]      # 全量快照：场景记忆 + 各项目 memory\ → <目录>\记忆包-<时间戳>\
 *   node 记忆打包.mjs 核对 --包 <目录>        # 包 vs 当前数据逐文件比对；有「缺失」exit 1，「变了/新增」只报告
 *   node 记忆打包.mjs 恢复 --包 <目录>        # 回滚/换机落位：先自动快照当前 → 覆盖（安全可回滚）
 *   node 记忆打包.mjs 升版                    # 落地/更新 _共享记忆\schema.json（记忆数据契约版本）
 *
 * 与 git 的分工：git 管「机制与公开记忆」，本工具管「换机与兜底」——归档\、项目.json、
 * 身份卡画像这些被 gitignore 的本机内容，git 救不回来，打包能。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath as __f2u } from 'node:url'

// 1. 根与路径（口径与 场景记忆.mjs 一致：--root > env > 工具上一级）
const __HERE = path.dirname(__f2u(import.meta.url))
const ARGV_ROOT = (() => { const i = process.argv.indexOf('--root'); return i >= 0 ? process.argv[i + 1] : '' })()
const WORKBENCH_ROOT = ARGV_ROOT || process.env.DSH_WORKBENCH_ROOT || path.resolve(__HERE, '..')
const MEMROOT = process.env.DSH_SCENE_MEMORY || path.join(WORKBENCH_ROOT, '引擎数据', '.dsh', '场景记忆')
const PROJECTS_FILE = path.join(MEMROOT, '_共享记忆', '项目.json')
const SCHEMA_FILE = path.join(MEMROOT, '_共享记忆', 'schema.json')
const PKG_DIR = path.join(WORKBENCH_ROOT, '记忆包')
const SCHEMA_VERSION = 2   // 记忆数据契约版本：加字段/改结构时 +1，工具按此判「老数据 vs 新工具」

// 2. 小工具
const flag = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : '' }
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` }
const relOf = (dir, p) => path.relative(dir, p).replaceAll('\\', '/')

/** 递归收集目录下全部文件 → [{p 绝对, rel 前斜杠相对目录}]（连隐藏文件都收，快照要的是完整） */
function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) rec(p)
      else if (e.isFile()) out.push({ p, rel: relOf(dir, p) })
    }
  }
  rec(dir)
  return out
}

/** 读项目登记表（宽容：坏了就当没项目，打包继续，只少收项目记忆） */
function readProjects() {
  try { return (JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).projects || []) } catch { return [] }
}

/** 扫当前真源：场景记忆（前缀 场景记忆/）+ 各项目 memory\（前缀 项目记忆/<名>/）→ Map<key, sha> */
function scanLive() {
  const map = new Map()
  for (const f of walk(MEMROOT)) map.set('场景记忆/' + f.rel, f.p)
  for (const pr of readProjects()) {
    const mem = pr.memoryRoot ? path.join(pr.memoryRoot, 'memory') : ''
    if (!mem || !fs.existsSync(mem)) continue
    for (const f of walk(mem)) map.set('项目记忆/' + pr.name + '/' + f.rel, f.p)
  }
  return map
}

/** 读包清单；损坏/缺字段 → null */
function readManifest(pkg) {
  try { return JSON.parse(fs.readFileSync(path.join(pkg, '清单.json'), 'utf8')) } catch { return null }
}

/** 包内自校验：每个条目文件要在、sha 对得上；返回 {bad: [...], entries} */
function verifyPackage(pkg) {
  const m = readManifest(pkg)
  if (!m) return { bad: ['清单.json 读不动或不存在（这不是本工具打的包）'], entries: [] }
  const bad = []
  for (const e of m.entries || []) {
    const p = path.join(pkg, e.p)
    if (!fs.existsSync(p)) { bad.push('缺文件：' + e.p); continue }
    if (sha256(p) !== e.sha256) bad.push('校验不符：' + e.p + '（包已损坏，别用这个包恢复）')
  }
  if (m.schemaVersion > SCHEMA_VERSION) bad.push('包 schema v' + m.schemaVersion + ' 比本工具新（v' + SCHEMA_VERSION + '）：换新工具再恢复')
  return { bad, entries: m.entries || [], schemaVersion: m.schemaVersion || 0 }
}

/** 目录快照（恢复前的自动备份）：整目录递归拷贝 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const f of walk(src)) {
    const t = path.join(dst, f.rel)
    fs.mkdirSync(path.dirname(t), { recursive: true })
    fs.copyFileSync(f.p, t)
  }
}

// 3. 打包：全量快照 + sha256 清单 + 恢复说明
function cmdPack() {
  if (!fs.existsSync(MEMROOT)) { console.error('✗ 场景记忆目录不存在：' + MEMROOT); return 2 }
  const dst = flag('--到') || PKG_DIR
  const pkg = path.join(dst, '记忆包-' + stamp())
  if (fs.existsSync(pkg)) { console.error('✗ 目标已存在：' + pkg); return 2 }
  const entries = []
  let nScene = 0
  let nProj = 0
  const skipped = []
  const copy = (abs, key) => {
    const t = path.join(pkg, key)
    fs.mkdirSync(path.dirname(t), { recursive: true })
    fs.copyFileSync(abs, t)
    entries.push({ p: key.replaceAll('\\', '/'), sha256: sha256(abs), size: fs.statSync(abs).size })
  }
  for (const f of walk(MEMROOT)) { copy(f.p, path.join('场景记忆', f.rel)); nScene++ }
  for (const pr of readProjects()) {
    if (!pr.memoryRoot) { skipped.push(pr.name + '（项目.json 没登记 memoryRoot）'); continue }
    const mem = path.join(pr.memoryRoot, 'memory')
    if (!fs.existsSync(mem)) { skipped.push(pr.name + '（项目根没有 memory\\ 目录）'); continue }
    for (const f of walk(mem)) { copy(f.p, path.join('项目记忆', pr.name, f.rel)); nProj++ }
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generator: '工具/记忆打包.mjs 打包',
    generatedAt: stamp(),
    machine: os.hostname(),
    entries,
  }
  fs.writeFileSync(path.join(pkg, '清单.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  const note = `# 记忆包 · ${manifest.generatedAt}

## 里面是什么
- \`场景记忆\\\`：<场景> 私有记忆、决策/坑/通知分条、定论、归档、_共享记忆（含项目.json、schema.json）——**连 gitignore 掉的归档/身份卡/登记表都包进来了**，git 救不回的它救。
- \`项目记忆\\<项目名>\\\`：每个已登记项目根下的 memory\\ 目录。
- \`清单.json\`：每个文件的 sha256，核对/恢复前先自校验，防半包/坏包。

## 怎么核对（备份过期了吗）
\`node 工具\\记忆打包.mjs 核对 --包 <本目录>\`——「缺失」exit 1，「变了/新增」只报告。

## 怎么恢复
\`node 工具\\记忆打包.mjs 恢复 --包 <本目录>\`——先自动把当前数据快照到 记忆包\\恢复前备份-<时间戳>\\，再覆盖，可回滚。

## 恢复后必做（换机场景）
1. \`node 外壳\\scripts\\环境适配.mjs --apply\`（本机路径重算）
2. \`node 工具\\场景记忆.mjs 索引 --all\` + \`check --all\`
3. 逐面板 \`换会话.mjs <面板id> --go\`（sessionId 是机器凭证，本就不搬）
4. 人工核对 \`_共享记忆\\项目.json\` 的 memoryRoot 是否指向本机项目路径
${skipped.length ? '\n## 打包时跳过\n' + skipped.map((s) => '- ' + s).join('\n') : ''}
`
  fs.writeFileSync(path.join(pkg, '恢复说明.md'), note.replaceAll('\n', '\r\n'), 'utf8')
  console.log('✓ 已打包：' + pkg)
  console.log('  场景记忆 ' + nScene + ' 个文件 · 项目记忆 ' + nProj + ' 个文件（' + entries.length + ' 条清单）')
  if (skipped.length) console.log('  · 跳过 ' + skipped.length + ' 项：\n    ' + skipped.join('\n    '))
  console.log('  核对：node 工具\\记忆打包.mjs 核对 --包 "' + pkg + '"')
  return 0
}

// 4. 核对：包 vs 当前真源；「缺失」exit 1，「变了/新增」只报告（例行备份过期检查用）
function cmdCheck(pkg) {
  const { bad, entries } = verifyPackage(pkg)
  if (bad.length) { console.error('✗ 包自校验不过，不能用来核对：'); bad.forEach((b) => console.error('  ' + b)); return 2 }
  const live = scanLive()
  const missing = []
  const changed = []
  let same = 0
  for (const e of entries) {
    const cur = live.get(e.p)
    if (!cur) { missing.push(e.p); continue }
    if (sha256(cur) !== e.sha256) changed.push(e.p)
    else same++
    live.delete(e.p)
  }
  const added = [...live.keys()]
  console.log('核对：一致 ' + same + ' · 变了 ' + changed.length + ' · 缺失 ' + missing.length + ' · 新增 ' + added.length)
  if (changed.length) { console.log('\n· 变了（自打包后内容改过，属正常演进）：'); changed.slice(0, 10).forEach((p) => console.log('  ' + p)); if (changed.length > 10) console.log('  …共 ' + changed.length + ' 个') }
  if (missing.length) { console.log('\n✗ 缺失（当前数据比包少——可能误删，恢复可捞回）：'); missing.forEach((p) => console.log('  ' + p)) }
  if (added.length) { console.log('\n· 新增（打包后新写的，包没有，建议重打包）：'); added.slice(0, 10).forEach((p) => console.log('  ' + p)); if (added.length > 10) console.log('  …共 ' + added.length + ' 个') }
  return missing.length ? 1 : 0
}

// 5. 恢复：先自动快照当前（可回滚）→ 覆盖；项目记忆按**本机** 项目.json 落位
function cmdRestore(pkg) {
  const { bad, entries, schemaVersion } = verifyPackage(pkg)
  if (bad.length) { console.error('✗ 包自校验不过，拒绝恢复：'); bad.forEach((b) => console.error('  ' + b)); return 2 }
  const backup = path.join(PKG_DIR, '恢复前备份-' + stamp())
  const snapshot = []
  if (fs.existsSync(MEMROOT) && fs.readdirSync(MEMROOT).length) {
    const b = path.join(backup, '场景记忆')
    copyDir(MEMROOT, b)
    snapshot.push('场景记忆 → ' + b)
  }
  const projMap = new Map()
  for (const pr of readProjects()) if (pr.memoryRoot) projMap.set(pr.name, path.join(pr.memoryRoot, 'memory'))
  for (const name of projMap.keys()) {
    if (!fs.existsSync(projMap.get(name))) continue
    const b = path.join(backup, '项目记忆', name)
    copyDir(projMap.get(name), b)
    snapshot.push('项目记忆\\' + name + ' → ' + b)
  }
  if (snapshot.length) console.log('· 恢复前已把当前数据快照到 ' + backup + '\n  ' + snapshot.join('\n  '))
  const warnings = []
  let n = 0
  for (const e of entries) {
    const [kind, ...rest] = e.p.split('/')
    if (kind === '场景记忆') {
      const t = path.join(MEMROOT, rest.join(path.sep))
      fs.mkdirSync(path.dirname(t), { recursive: true })
      fs.copyFileSync(path.join(pkg, e.p), t)
      n++
    } else if (kind === '项目记忆') {
      const name = rest[0]
      const rel = rest.slice(1).join(path.sep)
      const mem = projMap.get(name)
      if (!mem) { warnings.push('项目 ' + name + ' 不在本机 项目.json（包里有它的记忆，路径没落位）：先登记项目再重跑恢复'); continue }
      const t = path.join(mem, rel)
      fs.mkdirSync(path.dirname(t), { recursive: true })
      fs.copyFileSync(path.join(pkg, e.p), t)
      n++
    } else warnings.push('清单里有未知前缀条目：' + e.p)
  }
  console.log('✓ 已恢复 ' + n + ' 个文件' + (schemaVersion ? '（包 schema v' + schemaVersion + '）' : ''))
  if (warnings.length) { console.log('\n⚠ 注意：'); warnings.forEach((w) => console.log('  ' + w)) }
  console.log('\n下一步（换机必做，本机回滚可跳过前两项）：')
  console.log('  1. node 外壳\\scripts\\环境适配.mjs --apply')
  console.log('  2. node 工具\\场景记忆.mjs 索引 --all && node 工具\\场景记忆.mjs check --all')
  console.log('  3. 逐面板换会话（sessionId 是机器凭证，不随包搬）')
  console.log('  4. 人工核对 _共享记忆\\项目.json 的 memoryRoot 是否指向本机路径')
  return 0
}

// 6. 升版：落地 schema.json（记忆数据契约版本锚点）；版本更高时拒绝降级
function cmdSchema() {
  fs.mkdirSync(path.dirname(SCHEMA_FILE), { recursive: true })
  if (fs.existsSync(SCHEMA_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')).schemaVersion || 0
      if (old > SCHEMA_VERSION) { console.error('✗ 现有 schema v' + old + ' 比本工具新（v' + SCHEMA_VERSION + '）：别用旧工具降级'); return 2 }
    } catch { /* 读不动就重写 */ }
  }
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: stamp(),
    generator: '工具/记忆打包.mjs 升版',
    note: '记忆数据契约版本：加字段/改结构时 +1；工具据此判「老数据 vs 新工具」。详细规则见 doc/记忆可移植性与同步规范.md',
  }
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  console.log('✓ ' + SCHEMA_FILE + '（schemaVersion ' + SCHEMA_VERSION + '）')
  return 0
}

// 7. 命令分发
const cmd = process.argv[2] || ''
if (cmd === '打包' || cmd === 'pack') process.exit(cmdPack())
if (cmd === '核对' || cmd === 'check') process.exit(cmdCheck(flag('--包') || process.argv[3] || ''))
if (cmd === '恢复' || cmd === 'restore') process.exit(cmdRestore(flag('--包') || process.argv[3] || ''))
if (cmd === '升版' || cmd === 'schema') process.exit(cmdSchema())
console.error('用法：node 记忆打包.mjs <打包|核对|恢复|升版> [--包 <目录>] [--到 <目录>]')
console.error('  打包：全量快照场景记忆 + 各项目 memory\\（含 gitignore 掉的归档/登记表）')
console.error('  核对 --包 <目录>：包 vs 当前，缺失 exit 1')
console.error('  恢复 --包 <目录>：先自动快照当前再覆盖（可回滚）')
console.error('  升版：落地 _共享记忆\\schema.json 数据契约版本')
process.exit(2)
