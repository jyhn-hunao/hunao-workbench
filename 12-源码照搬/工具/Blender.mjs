#!/usr/bin/env node
// Blender.mjs —— 「创意工坊」里操作 Blender 的唯一命令行入口（大肥鱼和用户都能用）
//
// 为什么要有：引擎里的会话只会跑命令，不会点界面。把「找到 Blender / 后台跑 bpy / 实时改用户正开着的场景 /
//   换安装位」这四件事收成一条接口，AI 就不用自己拼 blender.exe 的参数，也不会把工程文件写得到处都是。
//
// 用法：
//   node 工具\Blender.mjs probe                       # 认环境：装没装、跑没跑、桥接通不通、工程根在哪
//   node 工具\Blender.mjs run --script <脚本.py> [--blend <工程.blend>]   # 后台跑（--background，无人值守）
//   node 工具\Blender.mjs exec --file <脚本.py> [--timeout 30]            # 在正开着的 Blender 里实时执行
//   node 工具\Blender.mjs exec --code "bpy.data.objects['Cube'].name"     # 同上，直接给代码（查询优先用表达式）
//   node 工具\Blender.mjs open --blend <工程.blend>    # 打开工程并挂桥接（打开后即可 exec）
//   node 工具\Blender.mjs set-exe --path "<blender.exe>"                  # 记下安装位（写 机器配置.json）
//   node 工具\Blender.mjs set-dir --path "<工程根>"                        # 换工程根（默认 工作区\创意工坊）
//
// 约定（与 外壳\main.js 的 Blender 段同一套口径）：
//   · 安装位解析：环境变量 DSH_BLENDER_EXE > 机器配置.json 的 blenderExe > 官方安装目录 > PATH；
//     都找不到就直说没装，⛔ 不猜路径。
//   · 工程根：环境变量 DSH_BLENDER_DIR > 机器配置 blenderDir > <工作台>\工作区\创意工坊。
//   · 桥接端口固定 127.0.0.1:9876，由 外壳\scripts\blender-bridge.py 提供（启动 Blender 时自动带）。
//   · 退出码：0 成功；1 失败（错误写 stderr，别把失败当成功）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawnSync, spawn } from 'node:child_process'
import { MACHINE, MACHINE_FILE, WORKBENCH_ROOT, IS_WIN } from './环境.mjs'

const BRIDGE_PORT = 9876
const SHELL_DIR = path.join(WORKBENCH_ROOT, '外壳')
const BRIDGE_SRC = path.join(SHELL_DIR, 'scripts', 'blender-bridge.py')
const BRIDGE_COPY = path.join(os.tmpdir(), 'dsh-blender-bridge.py')
const WORKSPACE_DIR = path.join(WORKBENCH_ROOT, '工作区')

const argv = process.argv.slice(2)
const cmd = String(argv[0] || '').trim()
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const has = (k) => argv.includes(k)
const die = (s) => { console.error('✗ ' + s); process.exit(1) }
const say = (s) => console.log(s)

// 1. 找 blender.exe（与 main.js 同序；这里只用 Node 内置模块，不引第三方）
function resolveExe() {
  const tried = []
  const envExe = String(process.env.DSH_BLENDER_EXE || '').trim()
  if (envExe) {
    tried.push('环境变量 DSH_BLENDER_EXE = ' + envExe)
    if (fs.existsSync(envExe)) return { exe: envExe, from: '环境变量', tried }
  }
  const cfgExe = String(MACHINE.blenderExe || '').trim()
  if (cfgExe) {
    tried.push('机器配置 blenderExe = ' + cfgExe)
    if (fs.existsSync(cfgExe)) return { exe: cfgExe, from: '机器配置', tried }
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : ''].filter(Boolean)
  const hits = []
  for (const r of roots) {
    const dir = path.join(r, 'Blender Foundation')
    let names = []
    try { names = fs.readdirSync(dir) } catch { tried.push('安装位（没有）：' + dir); continue }
    for (const n of names) {
      const exe = path.join(dir, n, 'blender.exe')
      if (fs.existsSync(exe)) hits.push({ exe, v: n })
    }
  }
  if (hits.length) {
    hits.sort((a, b) => String(b.v).localeCompare(String(a.v), 'en', { numeric: true }))
    return { exe: hits[0].exe, from: '安装目录', tried }
  }
  try {
    const r = spawnSync('where.exe', ['blender.exe'], { windowsHide: true, encoding: 'utf8' })
    const first = String((r && r.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first && fs.existsSync(first)) return { exe: first, from: 'PATH', tried }
    tried.push('PATH：where blender.exe 没结果')
  } catch { tried.push('PATH：where 调用失败') }
  return { exe: '', from: '', tried }
}

// 2. 工程根（与 main.js 同一套默认值）
function workspaceDir() {
  const d = String(process.env.DSH_BLENDER_DIR || MACHINE.blenderDir || '').trim()
  const dir = d || path.join(WORKSPACE_DIR, '创意工坊')
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const sub of ['工程', '输出', '导出', '_脚本']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  } catch { /* 交给后面的读写报错 */ }
  return dir
}

// 3. Blender 是否在跑（tasklist；不依赖窗口）
function isRunning() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/NH'], { windowsHide: true, encoding: 'utf8' })
    return String((r && r.stdout) || '').toLowerCase().includes('blender.exe')
  } catch { return false }
}

// 4. 桥接端口探活（600ms 超时，不阻塞）
function probeBridge(timeout = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: BRIDGE_PORT })
    let done = false
    const end = (v) => { if (done) return; done = true; try { sock.destroy() } catch { /* 已关 */ } resolve(v) }
    sock.setTimeout(timeout)
    sock.on('connect', () => end(true))
    sock.on('timeout', () => end(false))
    sock.on('error', () => end(false))
  })
}

// 5. 后台跑一段 bpy 脚本：--python-exit-code 1 让脚本报错变成非 0 退出，AI 不会把失败当成功
function runBackground() {
  const script = val('--script', '')
  if (!script) die('run 需要 --script <脚本.py>')
  if (!fs.existsSync(script)) die('脚本不存在：' + script)
  const pick = resolveExe()
  if (!pick.exe) die('没找到 blender.exe（先跑 probe 看看；或 set-exe --path "<blender.exe>"）')
  const blend = val('--blend', '')
  if (blend && !fs.existsSync(blend)) die('工程不存在：' + blend)
  const args = ['--background']
  if (blend) args.push(path.resolve(blend))
  args.push('--python', path.resolve(script), '--python-exit-code', '1')
  say('[Blender] ' + pick.exe)
  say('[Blender] ' + args.join(' '))
  const r = spawnSync(pick.exe, args, { stdio: 'inherit', windowsHide: false })
  if (r.error) die('启动失败：' + r.error.message)
  if (r.status !== 0) die('Blender 退出码 ' + r.status + '（脚本里有报错，往上翻日志）')
  say('✓ 跑完了')
}

// 6. 实时执行：连桥接，一行 JSON 去、一行 JSON 回
function connectBridge() {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: BRIDGE_PORT })
    sock.setTimeout(3000)
    sock.once('connect', () => { sock.setTimeout(0); resolve(sock) })
    sock.once('timeout', () => { sock.destroy(); reject(new Error('桥接端口 9876 没响应（Blender 没开着，或启动时没带上 blender-bridge.py）')) })
    sock.once('error', (e) => reject(new Error('连不上桥接 127.0.0.1:9876：' + e.message)))
  })
}

async function execLive() {
  const file = val('--file', '')
  const codeArg = val('--code', '')
  let code = codeArg
  if (file) {
    if (!fs.existsSync(file)) die('脚本不存在：' + file)
    code = fs.readFileSync(file, 'utf8')
  }
  if (!code) die('exec 需要 --file <脚本.py> 或 --code "<代码>"')
  const timeout = Number(val('--timeout', '30')) || 30
  const sock = await connectBridge()
  const payload = JSON.stringify({ cmd: 'exec', code, timeout, mode: val('--mode', 'auto') }) + '\n'
  const reply = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('等桥接回包超时（' + (timeout + 5) + 's）')) }, (timeout + 5) * 1000)
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (buf.includes('\n')) { clearTimeout(timer); sock.destroy(); resolve(buf.split('\n')[0]) }
    })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
    sock.write(payload)
  })
  let obj = null
  try { obj = JSON.parse(reply) } catch { /* 回包不是 JSON */ }
  if (!obj) die('桥接回包不是 JSON：' + reply.slice(0, 200))
  if (!obj.ok) {
    console.error('✗ Blender 里执行失败：' + (obj.error || '未知错误'))
    if (obj.trace) console.error(obj.trace)
    process.exit(1)
  }
  say(JSON.stringify(obj.result === undefined ? null : obj.result))
}

// 7. 打开工程（带桥接）；已开着就不重复拉起
function openBlend() {
  const pick = resolveExe()
  if (!pick.exe) die('没找到 blender.exe（先跑 probe）')
  const blend = val('--blend', '')
  if (blend && !fs.existsSync(blend)) die('工程不存在：' + blend)
  let bridge = ''
  try {
    fs.copyFileSync(BRIDGE_SRC, BRIDGE_COPY)
    bridge = BRIDGE_COPY
  } catch { bridge = '' }
  const args = []
  if (blend) args.push(path.resolve(blend))
  if (bridge) args.push('--python', bridge)
  const child = spawn(pick.exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
  // 必须 unref：否则命令跑完以后 Node 还挂着等 Blender 退出，AI 的命令会一直不回
  child.unref()
  if (child.error) die('启动失败：' + child.error.message)
  say('✓ 已拉起 Blender' + (blend ? '（' + blend + '）' : '') + (bridge ? '，桥接已挂' : '，⚠ 桥接脚本缺失'))
}

// 8. 写机器配置（原子落盘，保留其它键）
function writeMachine(patch) {
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')) } catch { cur = {} }
  const next = Object.assign({}, cur, patch)
  fs.mkdirSync(path.dirname(MACHINE_FILE), { recursive: true })
  const tmp = MACHINE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, MACHINE_FILE)
  return MACHINE_FILE
}

async function main() {
  if (!IS_WIN) die('这套 Blender 接入按 Windows 写的（窗口贴靠 + tasklist），当前系统不是 Windows')
  if (cmd === 'probe') {
    const pick = resolveExe()
    const dir = workspaceDir()
    const bridge = await probeBridge()
    say('Blender 可执行文件：' + (pick.exe || '（没找到）'))
    if (pick.exe) say('  来源：' + pick.from)
    else {
      say('  找过：' + (pick.tried.length ? pick.tried.join(' / ') : '（无）'))
      say('  补法：node 工具\\Blender.mjs set-exe --path "<blender.exe>"（或设 DSH_BLENDER_EXE）')
    }
    say('运行中：' + (isRunning() ? '是' : '否'))
    say('桥接 127.0.0.1:' + BRIDGE_PORT + '：' + (bridge ? '通' : '不通' + (isRunning() ? '（Blender 开着但没带桥接脚本 ⇒ 面板里点「⧉ 重新内置」或重启 Blender）' : '')))
    say('工程根：' + dir)
    say('机器配置：' + MACHINE_FILE)
    process.exit(pick.exe ? 0 : 1)
  }
  if (cmd === 'run') return runBackground()
  if (cmd === 'exec') return execLive()
  if (cmd === 'open') return openBlend()
  if (cmd === 'set-exe') {
    const p = path.resolve(val('--path', ''))
    if (!p) die('set-exe 需要 --path "<blender.exe>"')
    if (!fs.existsSync(p)) die('文件不存在：' + p)
    say('✓ 已记下 blenderExe：' + writeMachine({ blenderExe: p }))
    return
  }
  if (cmd === 'set-dir') {
    const p = path.resolve(val('--path', ''))
    if (!p) die('set-dir 需要 --path "<工程根>"')
    fs.mkdirSync(p, { recursive: true })
    say('✓ 已记下 blenderDir：' + writeMachine({ blenderDir: p }))
    return
  }
  die('用法：probe | run --script <py> [--blend <blend>] | exec --file <py> | exec --code "<代码>" | open --blend <blend> | set-exe --path <exe> | set-dir --path <目录>')
}

main().catch((e) => die(e && e.message ? e.message : String(e)))
