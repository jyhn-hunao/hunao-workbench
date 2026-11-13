#!/usr/bin/env node
// 引擎更新.mjs —— DSH 引擎的「查版本 → 下载装配 → 自证 → 替换 → 探活 → 回退」一条链（2026-11-13）
//
// 为什么要有它：引擎是外部依赖（⛔ 不手改，升级＝整目录替换）。换版本要解决四件事：
//   ① 只换 CLI tarball 不够 —— 新版本会新增依赖、cordis 次版本也会动，必须重装整棵依赖树；
//   ② 装依赖会被 pnpm 拦（ERR_PNPM_IGNORED_BUILDS），必须把 allowBuilds 显式写成 true；
//   ③ 引擎运行中目录被 Windows 文件锁占着，只能停机替换；
//   ④ 换坏了得能退回去，所以替换前先整目录备份。
//
// ⛔ 本工具**不写死版本号**：每次都以 registry 上的 dist-tags 为准（默认 latest）。
//    官方以后发 0.2.2 / 0.2.3 / 0.3.0 都走同一套流程，不需要改代码。
// ⛔ 只动两处：`12-源码照搬\引擎\` 与 `12-源码照搬\引擎更新\`。
//    不碰 `引擎数据\.dsh` 下的会话 / 日志 / 凭证（.credentials.yaml 不进任何备份）。
//
// 用法（全部在 12-源码照搬 下执行）：
//   node 工具\引擎更新.mjs status [--json]                 看状态（本地版本 / 最新版本 / 备份 / 磁盘）
//   node 工具\引擎更新.mjs prepare [--version X]            下载并装配到 staging，自证通过才算 ready
//   node 工具\引擎更新.mjs apply [--version X] [--yes]      备份 → 换入 → 验收 → 探活，失败自动回退
//   node 工具\引擎更新.mjs rollback [--to <备份目录名>]      回到某一版备份
//   node 工具\引擎更新.mjs list [--json]                    备份清单
//   node 工具\引擎更新.mjs clean [--keep 2]                 只留最近 N 份备份
//
// 退出码：0 成功 / 1 业务失败（可直接看 stderr 的中文原因） / 2 参数或环境错误

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import https from 'node:https'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { WORKBENCH_ROOT, machine, nodeExe, engineVersion, dshHome, port } from './环境.mjs'

// 1. 路径与常量（全部从 环境.mjs 的口径来，不另造字面量）
const ENGINE_DIR = path.join(WORKBENCH_ROOT, '引擎')
const UPDATE_DIR = path.join(WORKBENCH_ROOT, '引擎更新')
const STATE_FILE = path.join(UPDATE_DIR, 'state.json')
const PKG = '@deepseek-ai/dsh'
const REGISTRY = (process.env.DSH_MIRROR || 'https://registry.npmmirror.com').replace(/\/+$/, '')
// 这六个包的后安装脚本必须放行，否则 pnpm 12 直接 ERR_PNPM_IGNORED_BUILDS（2026-11-13 实测）
const ALLOW_BUILDS = ['@deepseek-ai/dsh-subprocess-local', '@google/genai', 'esbuild', 'koffi', 'node-pty', 'protobufjs']
const NEED_FREE_MB = 1300 // 一份 staging(≈526MB) + 一份备份(≈508MB) 再留点余量
const PROBE_TIMEOUT_MS = 45000

// 2. 版本比较（semver 规则：无 prerelease > 有 prerelease；pre 段数字比数字、字母按字典序）
function splitVer(s) {
  const m = String(s || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}
function cmpVer(a, b) {
  const x = splitVer(a), y = splitVer(b)
  if (!x || !y) return String(a).localeCompare(String(b))
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1
  }
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1 }
    else if (pn) return -1
    else if (qn) return 1
    else if (p !== q) return p > q ? 1 : -1
  }
  return 0
}

// 3. 小工具
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}
function freeMB(dir) {
  try {
    const s = fs.statfsSync(dir)
    return Math.round((s.bavail * s.bsize) / 1048576)
  } catch (e) { return -1 }
}
function dirSizeMB(p) {
  let sum = 0
  const walk = (d) => {
    let items = []
    try { items = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const it of items) {
      const full = path.join(d, it.name)
      if (it.isDirectory()) walk(full)
      else if (it.isFile()) { try { sum += fs.statSync(full).size } catch (e) { /* 读不到就跳过 */ } }
    }
  }
  walk(p)
  return Math.round(sum / 1048576)
}
function portBusy(p) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: p })
    const done = (v) => { try { sock.destroy() } catch (e) { /* 已关闭 */ } resolve(v) }
    sock.setTimeout(900)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false))
    sock.on('error', () => done(false))
  })
}

// 4. 状态文件：界面靠轮询它显示进度，断点续跑也靠它
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch (e) { return {} }
}
function writeState(patch) {
  fs.mkdirSync(UPDATE_DIR, { recursive: true })
  // at 必须最后写：否则 readState 里的旧 at 会把这一次的时间盖回去（界面会一直显示同一个"读于"）
  const next = Object.assign({}, readState(), patch, { at: Date.now() })
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}
function say(text) { process.stdout.write(String(text) + '\n') }
function drop(text) { process.stderr.write(String(text) + '\n') }

// 5. 查 registry：每次都现取 dist-tags，不缓存版本号
function httpJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const req = lib.get(url, { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        httpJson(res.headers.location).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('registry 回了 HTTP ' + res.statusCode + '：' + url)); return }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { buf += c })
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('registry 返回的不是 JSON')) } })
    })
    req.setTimeout(20000, () => { req.destroy(new Error('registry 连接超时（断网？）')) })
    req.on('error', (e) => reject(new Error('连不上 registry：' + e.message)))
  })
}
async function distTags() {
  const doc = await httpJson(REGISTRY + '/' + PKG.replace('/', '%2f'))
  const tags = (doc && doc['dist-tags']) || {}
  if (!tags.latest) throw new Error('registry 没给 latest 标签，可能是镜像同步中，过一会儿再试')
  return { tags, version: (doc.versions || {})[tags.latest] || null }
}

// 6. 下载 tarball（带进度回调；下载失败一律抛，不写"已完成"）
function download(url, dest, onPct) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const req = lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        download(res.headers.location, dest, onPct).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('下载失败 HTTP ' + res.statusCode + '：' + url)); return }
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      const out = fs.createWriteStream(dest)
      res.on('data', (c) => {
        got += c.length
        if (total && onPct) onPct(Math.min(99, Math.round((got / total) * 100)), got, total)
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve({ bytes: got, total })))
      out.on('error', (e) => reject(new Error('写盘失败：' + e.message)))
    })
    req.setTimeout(30000, () => { req.destroy(new Error('下载超时（网络太慢或断了）')) })
    req.on('error', (e) => reject(new Error('下载出错：' + e.message)))
  })
}

// 7. 解包：用系统自带的 bsdtar（Node 没有内置 tar，⛔ 不引第三方依赖）
function untar(tgz, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const r = spawnSync('tar', ['-xzf', tgz, '-C', dest], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error('解包失败：' + String(r.stderr || r.error || '').slice(0, 300))
}
// 8. staging 的 pnpm-workspace.yaml：
//    ① nodeLinker: hoisted —— 默认的 isolated 布局要在 D 盘建 symlink，普通权限会直接报
//       "Failed to create symlink ... os error 2"（2026-11-13 实测）；平铺不建链，稳且和 profiles/web 一致。
//    ② allowBuilds 六个 native 包必须显式 true，否则 pnpm 12 直接 ERR_PNPM_IGNORED_BUILDS。
function writeWorkspaceYaml(dir) {
  const lines = ['nodeLinker: hoisted', 'allowBuilds:']
  ALLOW_BUILDS.forEach((k) => lines.push("  '" + k + "': true"))
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), lines.join('\n') + '\n', 'utf8')
}

// 9. 装依赖：走 cmd.exe 调 pnpm.CMD（Node 20+ 不允许直接 spawn *.cmd，固定参数无注入）
function installDeps(dir, onPct) {
  const pnpm = path.join(path.dirname(nodeExe()), 'pnpm.CMD')
  if (!fs.existsSync(pnpm)) throw new Error('找不到 pnpm：' + pnpm + '\n  处置：装 pnpm（npm i -g pnpm），或把 pnpm.CMD 放到 ' + path.dirname(nodeExe()))
  return new Promise((resolve, reject) => {
    const args = ['/c', pnpm, 'install', '--registry=' + REGISTRY]
    const p = spawn('cmd.exe', args, { cwd: dir, windowsHide: true, env: Object.assign({}, process.env, { CI: 'true' }) })
    let tail = ''
    let total = 0
    const onLine = (ln) => {
      tail = (tail + ln + '\n').slice(-1600)
      // pnpm 12 的进度长这样：`Progress: resolved 620, reused 22, downloaded 594, added 512`
      // 先记总数，再按已装数算百分比；认不出就停在阶段值，不硬编假进度。
      const mRes = ln.match(/resolved\s+(\d+)/)
      if (mRes) total = Number(mRes[1])
      const mAdd = ln.match(/added\s+(\d+)/)
      if (mAdd && total && onPct) onPct(Math.min(99, Math.round((Number(mAdd[1]) / total) * 100)))
      else if (/Packages:\s*\+(\d+)/.test(ln) && onPct) onPct(40)
      else if (/Done in/.test(ln) && onPct) onPct(100)
    }
    const hook = (buf) => String(buf).split(/\r?\n/).forEach((ln) => { if (ln.trim()) onLine(ln) })
    p.stdout.on('data', hook)
    p.stderr.on('data', hook)
    p.on('error', (e) => reject(new Error('起不来 pnpm：' + e.message)))
    p.on('close', (code) => {
      if (code === 0) { resolve(tail); return }
      reject(new Error('pnpm install 失败（退出码 ' + code + '）\n' + tail.trim().split('\n').slice(-8).join('\n')))
    })
  })
}

// 10. 跑引擎自己的 bin.js（自证用），超时可调
function runBin(dir, args, timeout) {
  const r = spawnSync(nodeExe(), [path.join(dir, 'lib', 'bin.js')].concat(args), {
    cwd: dir, encoding: 'utf8', timeout: timeout || 60000, windowsHide: true,
    env: Object.assign({}, process.env, { DSH_HOME: dshHome() })
  })
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), timedOut: !!(r.error && /ETIMEDOUT|timeout/i.test(String(r.error))) }
}

// 11. 自证：版本必须一字不差，dump-config 必须 exit 0（两关任一不过就不许替换）
function verifyStaging(dir, want) {
  if (!fs.existsSync(path.join(dir, 'lib', 'bin.js'))) throw new Error('staging 里没有 lib\\bin.js，包没解全')
  const v = runBin(dir, ['-V'], 60000)
  const got = (v.out || '').trim().split(/\r?\n/).pop()
  if (v.code !== 0 || got !== want) throw new Error('自证失败：引擎自报版本「' + got + '」，期望「' + want + '」（退出码 ' + v.code + '）')
  const d = runBin(dir, ['web', '--dump-config'], 120000)
  if (d.code !== 0) throw new Error('自证失败：dump-config 退出码 ' + d.code + '\n' + String(d.err || d.out).slice(0, 600))
  return { version: got, dumpLines: String(d.out || '').split(/\r?\n/).length }
}

// 12. 替换三件事：备份 / 换入 / 退回
function backupCurrent() {
  if (!fs.existsSync(ENGINE_DIR)) throw new Error('引擎目录不存在：' + ENGINE_DIR)
  const ver = engineVersion() || 'unknown'
  const dest = path.join(UPDATE_DIR, 'backup-' + ver + '-' + stamp())
  fs.mkdirSync(UPDATE_DIR, { recursive: true })
  fs.renameSync(ENGINE_DIR, dest) // 同盘 rename，秒级，不复制
  return { dir: dest, name: path.basename(dest), version: ver, sizeMB: dirSizeMB(dest) }
}
function swapIn(stagingDir) {
  fs.renameSync(stagingDir, ENGINE_DIR)
}
function restoreBackup(backupDir, tag) {
  const dead = path.join(UPDATE_DIR, 'failed-' + (engineVersion() || 'unknown') + '-' + (tag || stamp()))
  if (fs.existsSync(ENGINE_DIR)) fs.renameSync(ENGINE_DIR, dead)
  fs.renameSync(backupDir, ENGINE_DIR)
  return dead
}

// 13. 验收：环境适配只读一遍（要求引擎在跑的自检不放这里，那是启动后的事）
//     返回 fails 列表是为了跟"替换前"做基线比对：既有缺陷（比如私有插件没落位）不该拦住升级，
//     只有"替换后才冒出来的问题"才算这次替换的错。
function envCheck() {
  const script = path.join(WORKBENCH_ROOT, '外壳', 'scripts', '环境适配.mjs')
  if (!fs.existsSync(script)) return { ok: true, note: '跳过：找不到 环境适配.mjs', fails: [] }
  const r = spawnSync(nodeExe(), [script, '--check', '--json'], { encoding: 'utf8', timeout: 180000, windowsHide: true })
  const txt = String(r.stdout || '')
  const i = txt.indexOf('{')
  let j = null
  if (i >= 0) { try { j = JSON.parse(txt.slice(i)) } catch (e) { j = null } }
  if (!j) return { ok: false, note: '环境适配没有回来 JSON：' + (String(r.stderr || txt).slice(0, 300) || '无输出'), fails: [] }
  const fails = (j.rows || []).filter((x) => x.level === 'fail')
  return { ok: !fails.length, note: fails.length ? ('环境适配有 ' + fails.length + ' 项 fail') : '环境适配全过', fails }
}

// 14. 探活：真起一次引擎（临时端口），看见 token 行才算这个引擎能跑。
//     同时把 stderr 里 "skipping profile bundle" 收成 warns —— 引擎能起但插件没挂，这属于"要告诉你"的事，不是失败。
function probeEngine(dir) {
  const p = port('dsh') + 16
  return new Promise((resolve) => {
    let done = false
    const kill = (child) => {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (e) { /* 已退出 */ }
    }
    const child = spawn(nodeExe(), [path.join(dir, 'lib', 'bin.js'), 'web', '--no-open', '--port', String(p)], {
      cwd: dir, windowsHide: true, env: Object.assign({}, process.env, { DSH_HOME: dshHome() })
    })
    let log = ''
    let errLog = ''
    const warns = () => {
      const out = []
      const re = /skipping profile bundle "([^"]+)"/g
      let m = null
      while ((m = re.exec(errLog)) !== null) if (out.indexOf(m[1]) < 0) out.push(m[1])
      return out
    }
    const finish = (ok, note) => {
      if (done) return
      done = true
      try { clearTimeout(timer) } catch (e) { /* 无定时器 */ }
      kill(child)
      resolve({ ok, note, port: p, warns: warns() })
    }
    const timer = setTimeout(() => finish(false, '探活超时（' + (PROBE_TIMEOUT_MS / 1000) + ' 秒没起来）\n' + (log + errLog).slice(-800)), PROBE_TIMEOUT_MS)
    const onBuf = (buf) => {
      log = (log + String(buf)).slice(-2000)
      if (new RegExp('dsh web: http://127\\.0\\.0\\.1:' + p).test(log)) finish(true, '探活通过（起得来、token 行正常）')
    }
    child.stdout.on('data', onBuf)
    child.stderr.on('data', (b) => {
      errLog = (errLog + String(b)).slice(-4000)
      onBuf(b)
    })
    child.on('error', (e) => finish(false, '探活起不来：' + e.message))
    child.on('close', (code) => { if (!done) finish(false, '探活进程提前退出（码 ' + code + '）\n' + (log + errLog).slice(-800)) })
  })
}

// 15. 命令：status
async function cmdStatus() {
  const local = engineVersion()
  const st = readState()
  let latest = '', tags = null, remoteNote = null
  try { const r = await distTags(); latest = r.tags.latest; tags = r.tags } catch (e) { remoteNote = e.message }
  const staged = fs.existsSync(UPDATE_DIR)
    ? fs.readdirSync(UPDATE_DIR).filter((n) => n.startsWith('staging-')).map((n) => n.replace('staging-', ''))
    : []
  const backups = listBackups()
  const busy = await portBusy(port('dsh'))
  const out = {
    ok: true, local, latest, tags, remoteNote, channel: process.env.DSH_CHANNEL || 'latest',
    newer: latest ? cmpVer(latest, local) > 0 : false,
    staged, backups, engineBusy: busy, enginePort: port('dsh'),
    freeMB: freeMB(WORKBENCH_ROOT), needFreeMB: NEED_FREE_MB,
    node: nodeExe(), pnpmOk: fs.existsSync(path.join(path.dirname(nodeExe()), 'pnpm.CMD')),
    state: st
  }
  return out
}

// 16. 命令：list
function listBackups() {
  if (!fs.existsSync(UPDATE_DIR)) return []
  return fs.readdirSync(UPDATE_DIR)
    .filter((n) => n.startsWith('backup-'))
    .map((n) => {
      const full = path.join(UPDATE_DIR, n)
      let at = 0
      try { at = fs.statSync(full).mtimeMs } catch (e) { at = 0 }
      const m = n.match(/^backup-(.+)-(\d{14})$/)
      return { name: n, version: m ? m[1] : '?', stamp: m ? m[2] : '', at, sizeMB: 0 }
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp))
}

// 17. 命令：prepare（四步，每步写 state，界面靠轮询它显示进度）
async function cmdPrepare(opts) {
  const st = await cmdStatus()
  const want = opts.version || st.latest
  if (!want) throw new Error('不知道要装哪个版本：registry 没回 latest，也没给 --version')
  if (st.freeMB >= 0 && st.freeMB < NEED_FREE_MB) throw new Error('磁盘不够：剩 ' + st.freeMB + ' MB，至少要 ' + NEED_FREE_MB + ' MB（一份 staging + 一份备份）')
  const staging = path.join(UPDATE_DIR, 'staging-' + want)
  writeState({ phase: 'preparing', pct: 0, text: '开始准备 ' + want, target: want, ok: null, error: null, source: opts.version ? 'cli-arg' : 'registry-latest' })

  // 1. 下载 tarball
  const cache = path.join(UPDATE_DIR, 'cache')
  fs.mkdirSync(cache, { recursive: true })
  const tgz = path.join(cache, 'dsh-' + want + '.tgz')
  writeState({ pct: 3, text: '下载 ' + want + ' 的 CLI 包' })
  // tarball 走未编码路径（npm 的 /-/ 约定对 %2f 不认），metadata 才用编码形式
  await download(REGISTRY + '/' + PKG + '/-/dsh-' + want + '.tgz', tgz, (pct) => {
    writeState({ pct: 3 + Math.round(pct * 0.17), text: '下载 CLI 包 ' + pct + '%' })
  })

  // 2. 解包到 staging（tarball 里是 package/ 一层，要去掉）
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
  const raw = path.join(cache, 'raw-' + want)
  if (fs.existsSync(raw)) fs.rmSync(raw, { recursive: true, force: true })
  untar(tgz, raw)
  const inner = path.join(raw, 'package')
  const src = fs.existsSync(inner) ? inner : raw
  fs.mkdirSync(staging, { recursive: true })
  for (const name of fs.readdirSync(src)) fs.cpSync(path.join(src, name), path.join(staging, name), { recursive: true })
  fs.rmSync(raw, { recursive: true, force: true })
  if (!fs.existsSync(path.join(staging, 'package.json'))) throw new Error('解包后没有 package.json，包是坏的')
  writeWorkspaceYaml(staging)

  // 3. 装依赖（620 包上下，首次几分钟）
  writeState({ pct: 22, text: '装配依赖树（首次约 3–6 分钟）' })
  await installDeps(staging, (pct) => writeState({ pct: 22 + Math.round(pct * 0.63), text: '装配依赖 ' + pct + '%' }))

  // 4. 自证
  writeState({ pct: 88, text: '自证：版本与 dump-config' })
  const v = verifyStaging(staging, want)
  writeState({ phase: 'ready', pct: 100, text: want + ' 已就绪（自证通过），重启后生效', ok: true, verify: v, staging: path.basename(staging) })
  return { ok: true, version: want, staging: path.basename(staging), verify: v }
}

// 18. 命令：apply（备份 → 换入 → 验收 → 探活；任一环失败自动退回）
//     --wait N 用于「一键更新」：主进程先退出，这里等端口释放再动手，避免被文件锁挡住。
async function waitPortFree(sec) {
  const end = Date.now() + sec * 1000
  while (Date.now() < end) {
    if (!(await portBusy(port('dsh')))) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return !(await portBusy(port('dsh')))
}
// 更新完把工作台拉起来（wscript 跑 启动.vbs，脱离本进程，失败不影响结果）
function startWorkbench() {
  const vbs = path.join(WORKBENCH_ROOT, '启动.vbs')
  if (!fs.existsSync(vbs)) return { ok: false, note: '没找到 启动.vbs，请手动启动工作台' }
  try {
    spawn('wscript.exe', [vbs], { cwd: WORKBENCH_ROOT, detached: true, windowsHide: true, stdio: 'ignore' }).unref()
    return { ok: true, note: '已拉起 启动.vbs' }
  } catch (e) { return { ok: false, note: '拉不起来 启动.vbs：' + e.message } }
}

async function cmdApply(opts) {
  const want = opts.version || readState().target
  if (!want) throw new Error('不知道要应用哪个版本：先跑 prepare，或给 --version')
  const staging = path.join(UPDATE_DIR, 'staging-' + want)
  if (!fs.existsSync(staging)) throw new Error('还没有装好的 ' + want + '（先跑 prepare）')
  if (opts.wait) {
    writeState({ phase: 'applying', pct: 2, text: '等工作台退出（最多 ' + opts.wait + ' 秒）', target: want, ok: null, error: null })
    const free = await waitPortFree(Number(opts.wait))
    if (!free) throw new Error('等了 ' + opts.wait + ' 秒端口 ' + port('dsh') + ' 还被占着 ⇒ 工作台没退干净，先手动关掉它再更新')
  }
  if (await portBusy(port('dsh'))) throw new Error('引擎正在跑（' + port('dsh') + ' 被占）⇒ 先退出工作台再更新。替换要停机，热换会被文件锁挡住。')

  writeState({ phase: 'applying', pct: 5, text: '再自证一次', target: want, ok: null, error: null })
  verifyStaging(staging, want)

  // 替换前的基线：环境适配里"本来就有"的 fail 不算这次的账（例如私有插件没落位）
  const base = envCheck()
  const baseFails = (base.fails || []).map((f) => f.name)

  writeState({ pct: 15, text: '备份当前引擎（整目录改名，秒级）' })
  const bak = backupCurrent()
  writeState({ pct: 25, text: '备份完成：' + bak.name, backup: bak.name })

  let swapped = false
  try {
    writeState({ pct: 35, text: '换入新引擎' })
    swapIn(staging)
    swapped = true
    writeState({ pct: 50, text: '验收：环境适配（只拦新冒出来的问题）' })
    const env = envCheck()
    const newFails = (env.fails || []).filter((f) => baseFails.indexOf(f.name) < 0)
    if (newFails.length) throw new Error('替换后环境适配新冒出问题：' + newFails.map((f) => f.name + '（' + (f.detail || '') + '）').join('；'))
    if (env.fails && env.fails.length) say('提示：环境适配还有 ' + env.fails.length + ' 项既有 fail（替换前就有，不算这次）：' + env.fails.map((f) => f.name).join(' / '))
    writeState({ pct: 70, text: '验收：探活（真起一次引擎）' })
    const probe = await probeEngine(ENGINE_DIR)
    if (!probe.ok) throw new Error('替换后引擎起不来：' + probe.note)
    if (probe.warns && probe.warns.length) say('提示：探活时有 ' + probe.warns.length + ' 条 bundle 被跳过：' + probe.warns.join(' / '))
    writeState({ phase: 'done', pct: 100, text: '已升到 ' + want + '，验收全过', ok: true, backup: bak.name, appliedAt: Date.now(), warns: probe.warns || [] })
    const boot = opts.start ? startWorkbench() : null
    if (boot) writeState({ text: '已升到 ' + want + '，验收全过；' + boot.note })
    return { ok: true, version: want, backup: bak.name, envNote: env.note, probeNote: probe.note, boot, warns: probe.warns || [] }
  } catch (e) {
    if (!swapped) throw e // 还没换，原地不动即可
    // 换了但不合格 ⇒ 立刻退回
    try {
      restoreBackup(bak.dir, 'auto')
      writeState({ phase: 'failed', pct: 100, text: '自动回退成功：' + e.message, ok: false, error: String(e.message), backup: bak.name })
      throw new Error('替换后验收失败，已自动退回 ' + bak.version + '：' + e.message)
    } catch (inner) {
      if (/已自动退回/.test(String(inner.message))) throw inner
      writeState({ phase: 'failed', pct: 100, text: '回退也失败了：' + inner.message, ok: false, error: String(inner.message) })
      throw new Error('替换失败且回退也失败（现场在 引擎更新\\ 下）：原错 ' + e.message + '；回退错 ' + inner.message)
    }
  }
}

// 19. 命令：rollback
async function cmdRollback(opts) {
  const all = listBackups()
  if (!all.length) throw new Error('没有备份可回（引擎更新\\ 下没有 backup-*）')
  const target = opts.to ? all.find((x) => x.name === opts.to || x.name === 'backup-' + opts.to) : all[0]
  if (!target) throw new Error('找不到这一份备份：' + opts.to)
  const dir = path.join(UPDATE_DIR, target.name)
  if (!fs.existsSync(dir)) throw new Error('备份目录不在了：' + dir)
  if (await portBusy(port('dsh'))) throw new Error('引擎正在跑（' + port('dsh') + ' 被占）⇒ 先退出工作台再回退。')

  writeState({ phase: 'applying', pct: 20, text: '回退到 ' + target.version + '（' + target.stamp + '）', ok: null, error: null })
  const base = envCheck()
  const baseFails = (base.fails || []).map((f) => f.name)
  const dead = restoreBackup(dir, 'manual')
  writeState({ pct: 70, text: '回退后验收：环境适配 + 探活' })
  const env = envCheck()
  const newFails = (env.fails || []).filter((f) => baseFails.indexOf(f.name) < 0)
  const probe = await probeEngine(ENGINE_DIR)
  const ok = !newFails.length && probe.ok
  const why = newFails.length ? ('新冒出：' + newFails.map((f) => f.name).join(' / ')) : probe.note
  const boot = opts.start ? startWorkbench() : null
  writeState({
    phase: ok ? 'done' : 'failed', pct: 100, ok,
    text: ok ? ('已回退到 ' + target.version + '，验收全过' + (boot ? '；' + boot.note : '')) : ('回退到 ' + target.version + ' 但验收没过：' + why),
    error: ok ? null : why
  })
  return { ok, version: target.version, replacedTo: dead, envNote: env.note, probeNote: probe.note, boot, warns: probe.warns || [] }
}

// 20. 命令：clean（只留最近 N 份；⛔ 不自动删，必须显式调用）
function cmdClean(opts) {
  const keep = Number(opts.keep || 2)
  const all = listBackups()
  if (!all.length) return { ok: true, removed: [], kept: 0 }
  const removed = []
  all.slice(keep).forEach((x) => {
    try { fs.rmSync(path.join(UPDATE_DIR, x.name), { recursive: true, force: true }); removed.push(x.name) } catch (e) { drop('删不掉 ' + x.name + '：' + e.message) }
  })
  return { ok: true, removed, kept: Math.min(keep, all.length) }
}

// 21. 参数解析与分发
function parseArgs(argv) {
  const opts = { cmd: argv[0] || 'status' }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--yes') opts.yes = true
    else if (a === '--version') opts.version = argv[++i]
    else if (a === '--to') opts.to = argv[++i]
    else if (a === '--keep') opts.keep = argv[++i]
    else if (a === '--wait') opts.wait = argv[++i]
    else if (a === '--then-start') opts.start = true
    else drop('忽略不认识的参数：' + a)
  }
  return opts
}
function printStatus(s) {
  say('本地引擎：' + (s.local || '读不到') + '　（node ' + s.node + '）')
  say('registry：' + (s.latest ? ('最新 ' + s.latest + '（' + (s.tags.next ? 'next ' + s.tags.next + ' / ' : '') + 'latest）') : ('查不到：' + s.remoteNote)))
  say('比较：' + (s.newer ? '有新版本可升' : '已是最新（或本地更新）'))
  say('已就绪待应用：' + (s.staged.length ? s.staged.join(' / ') : '无'))
  say('备份：' + (s.backups.length ? s.backups.map((x) => x.version + '(' + x.stamp + ')').join(' / ') : '无'))
  say('磁盘剩 ' + s.freeMB + ' MB（需 ' + s.needFreeMB + ' MB）　端口 ' + port('dsh') + '：' + (s.engineBusy ? '被占（引擎在跑）' : '空闲'))
  if (s.state && s.state.phase) say('上次：' + s.state.phase + ' · ' + (s.state.text || ''))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const out = { cmd: opts.cmd }
  try {
    if (opts.cmd === 'status') out.data = await cmdStatus()
    else if (opts.cmd === 'prepare') out.data = await cmdPrepare(opts)
    else if (opts.cmd === 'apply') out.data = await cmdApply(opts)
    else if (opts.cmd === 'rollback') out.data = await cmdRollback(opts)
    else if (opts.cmd === 'list') out.data = { backups: listBackups() }
    else if (opts.cmd === 'clean') out.data = cmdClean(opts)
    else throw new Error('不认识的命令：' + opts.cmd + '（可用 status / prepare / apply / rollback / list / clean）')
    out.ok = true
    if (opts.json) say(JSON.stringify(out))
    else if (opts.cmd === 'status') printStatus(out.data)
    else say(JSON.stringify(out.data, null, 2))
    process.exit(0)
  } catch (e) {
    out.ok = false
    out.error = String((e && e.message) || e)
    if (opts.json) say(JSON.stringify(out))
    else drop('失败：' + out.error)
    process.exit(1)
  }
}
main()
