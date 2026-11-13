#!/usr/bin/env node
// 引擎快照.mjs —— 引擎**启动配置**的存档 / 回退（补齐 main.js 早就在调、却一直不存在的工具，2026-11-13）
//
// 边界（和「引擎更新.mjs」严格分开，别混）：
//   · 这里只管**配置级**：profiles/web 下的 cordis.yml / cordis.patch.yml / package.json / 锁与 workspace，
//     加 .plugin-manager 下的插件启用记录。它们是「引擎能不能起来」的直接输入，改坏了引擎就起不来。
//   · 不碰源码、不碰构建产物、不碰会话、不碰 .credentials.yaml —— 换个版本那是 引擎更新.mjs 的事。
//
// main.js 里 5 个 IPC 认的就是这套契约（见 外壳/main.js:4397-4460）：
//   --save                          打一份正常点（写 <data>/engine-good/<gen>/ 与 meta.json）
//   --list                          列全部代（每行 "- gen-<stamp> · <时间> · 引擎 <版本> · HEAD <sha>"）
//   --restore --yes                 回到 meta.json 记的那一代
//   --restore-gen <gen> --yes       回到指定一代
//
// 落盘：外壳\data\engine-good\meta.json（最新一代的登记）、<data>\engine-good\<gen>\meta.json（每代自己的）
// ⛔ 回退前一定先把"现在这一份"另存到 pre-restore-<stamp>，否则回退了就再也回不来了。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { WORKBENCH_ROOT, dshHome, engineVersion } from './环境.mjs'

// 1. 路径
const DATA_DIR = path.join(WORKBENCH_ROOT, '外壳', 'data', 'engine-good')
const META = path.join(DATA_DIR, 'meta.json')
const KEEP = 5

// 2. 要存档的文件清单（相对 dshHome；存在的才存，缺失记进 missing 一起报出来）
function configFiles() {
  const base = path.join(dshHome(), 'profiles', 'web')
  const list = [
    'cordis.yml',
    'cordis.patch.yml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml'
  ].map((n) => path.join(base, n))
  // 插件启用记录：目录存在就把里面的 json 全带上（数量随装了多少插件变，所以动态枚举）
  const plug = path.join(base, '.plugin-manager')
  if (fs.existsSync(plug)) {
    fs.readdirSync(plug)
      .filter((n) => n.endsWith('.json'))
      .forEach((n) => list.push(path.join(plug, n)))
  }
  return list
}
function relOf(p) {
  const home = dshHome()
  return p.startsWith(home) ? path.relative(home, p).split(path.sep).join('/') : p
}

// 3. 小工具
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}
function human(ms) {
  if (!ms) return '?'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
}
function gitHead() {
  const r = spawnSync('git', ['-C', WORKBENCH_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? String(r.stdout || '').trim() : ''
}
function say(t) { process.stdout.write(String(t) + '\n') }
function drop(t) { process.stderr.write(String(t) + '\n') }

// 4. 打一份：把现有配置拷进 <gen>/，同时更新 meta.json（多代只留最近 KEEP 份）
function cmdSave() {
  const gen = 'gen-' + stamp()
  const dir = path.join(DATA_DIR, gen)
  fs.mkdirSync(dir, { recursive: true })
  const files = {}
  const missing = []
  configFiles().forEach((src) => {
    if (!fs.existsSync(src)) { missing.push(relOf(src)); return }
    const rel = relOf(src)
    const dst = path.join(dir, rel.split('/').join(path.sep))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    const buf = fs.readFileSync(src)
    fs.writeFileSync(dst, buf)
    files[rel] = sha(buf)
  })
  const meta = { gen, savedAt: Date.now(), engineVersion: engineVersion(), head: gitHead(), files, missing }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  fs.writeFileSync(META, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  pruneOld(gen)
  say('已记下正常点：' + gen + '（' + Object.keys(files).length + ' 个配置' + (missing.length ? ('，缺 ' + missing.length + ' 个') : '') + '）')
  say('引擎版本：' + (meta.engineVersion || '?') + (meta.head ? ('　HEAD ' + meta.head) : ''))
  missing.forEach((m) => drop('  · 没找到：' + m))
  return { ok: true, gen, files: Object.keys(files).length, missing }
}

// 5. 只留最近 KEEP 代（按目录名倒序，后缀是时间戳，字典序就是时间序）
function pruneOld(keepGen) {
  if (!fs.existsSync(DATA_DIR)) return []
  const gens = fs.readdirSync(DATA_DIR).filter((n) => /^gen-\d{14}$/.test(n)).sort().reverse()
  const dead = gens.slice(KEEP)
  dead.forEach((n) => {
    try { fs.rmSync(path.join(DATA_DIR, n), { recursive: true, force: true }) } catch (e) { drop('删不掉旧代 ' + n + '：' + e.message) }
  })
  return dead
}

// 6. 列全部代（格式必须是 main.js 正则能认的那一行）
function cmdList() {
  if (!fs.existsSync(DATA_DIR)) { say('（还没有任何一代）'); return { ok: true, rows: [] } }
  const gens = fs.readdirSync(DATA_DIR).filter((n) => /^gen-\d{14}$/.test(n)).sort().reverse()
  if (!gens.length) { say('（还没有任何一代）'); return { ok: true, rows: [] } }
  gens.forEach((n) => {
    let m = null
    try { m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, n, 'meta.json'), 'utf8')) } catch (e) { m = null }
    say('- ' + n + ' · ' + human(m && m.savedAt) + ' · 引擎 ' + ((m && m.engineVersion) || '?') + ' · HEAD ' + ((m && m.head) || '-'))
  })
  return { ok: true, rows: gens }
}

// 7. 回写某一代：先把现在这份另存，再把存档铺回去
function restoreFrom(genDir, label) {
  const metaPath = path.join(genDir, 'meta.json')
  if (!fs.existsSync(metaPath)) throw new Error('这一代没有 meta.json，存的是坏的：' + genDir)
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const files = meta.files || {}
  const keys = Object.keys(files)
  if (!keys.length) throw new Error('这一代的 meta 里没记任何配置，不敢回写：' + genDir)

  // 1. 先把当前配置另存（叫 pre-restore，不进代列表，避免占满 5 份名额）
  const pre = path.join(DATA_DIR, 'pre-restore-' + stamp())
  fs.mkdirSync(pre, { recursive: true })
  const cur = {}
  keys.forEach((rel) => {
    const src = path.join(dshHome(), rel.split('/').join(path.sep))
    if (!fs.existsSync(src)) return
    const dst = path.join(pre, rel.split('/').join(path.sep))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    const buf = fs.readFileSync(src)
    fs.writeFileSync(dst, buf)
    cur[rel] = sha(buf)
  })
  fs.writeFileSync(path.join(pre, 'meta.json'), JSON.stringify({ savedAt: Date.now(), engineVersion: engineVersion(), files: cur, note: '回退前的现场' }, null, 2) + '\n', 'utf8')

  // 2. 铺回存档（缺的文件按"存档里有什么就写什么"，不多删）
  const wrote = []
  keys.forEach((rel) => {
    const src = path.join(genDir, rel.split('/').join(path.sep))
    if (!fs.existsSync(src)) return
    const dst = path.join(dshHome(), rel.split('/').join(path.sep))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, fs.readFileSync(src))
    wrote.push(rel)
  })
  say('已' + label + '：' + path.basename(genDir) + '（回写 ' + wrote.length + ' 个配置）')
  say('回退前的现场另存在：' + pre)
  say('重启工作台后生效。若还起不来，去看 外壳\\server.log。')
  return { ok: true, gen: path.basename(genDir), wrote, pre }
}

function cmdRestore() {
  if (!fs.existsSync(META)) throw new Error('还没有正常点（先跑 --save 打一份）：' + META)
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'))
  const gen = meta && meta.gen
  if (!gen) throw new Error('meta.json 里没有 gen 字段，认不出回哪一代')
  return restoreFrom(path.join(DATA_DIR, gen), '回到上次正常配置')
}
function cmdRestoreGen(gen) {
  if (!/^gen-\d{14}$/.test(String(gen || ''))) throw new Error('这一代编号不合法：' + gen)
  const dir = path.join(DATA_DIR, gen)
  if (!fs.existsSync(dir)) throw new Error('找不到这一代：' + dir)
  return restoreFrom(dir, '回到 ' + gen)
}

// 8. 参数与分发（--yes 只是显式确认位，没有它就拒绝执行回退，免得被误调）
function main() {
  const argv = process.argv.slice(2)
  const has = (k) => argv.includes(k)
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : '' }
  try {
    if (has('--list')) { cmdList(); process.exit(0) }
    if (has('--save')) { cmdSave(); process.exit(0) }
    if (has('--restore-gen')) {
      if (!has('--yes')) throw new Error('回退要显式加 --yes（这条会覆盖现有配置）')
      cmdRestoreGen(val('--restore-gen')); process.exit(0)
    }
    if (has('--restore')) {
      if (!has('--yes')) throw new Error('回退要显式加 --yes（这条会覆盖现有配置）')
      cmdRestore(); process.exit(0)
    }
    drop('用法：node 工具\\引擎快照.mjs --save | --list | --restore --yes | --restore-gen <gen> --yes')
    process.exit(2)
  } catch (e) {
    drop('失败：' + String((e && e.message) || e))
    process.exit(1)
  }
}
main()
