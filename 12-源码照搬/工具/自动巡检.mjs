// 自动巡检.mjs —— 开机后台跑一遍"体检"，异常才提示（2026-11-14 新增）
// 为什么有它：自检 / sessions / check-gui / 记忆体检 / 看门狗 原来都靠人记得手动跑；
//   跑不跑全凭自觉 ⇒ 红线（如"面板指到已归档会话"）可能挂好几天没人发现。
//   这里把它们收成一条：**只读、不改任何东西**，结果落 `外壳\data\巡检.json`，只把"有问题的项"说清楚。
//
// 谁在跑它：main.js 引擎就绪 60s 后（每天最多一次，按 巡检.json 的 at 判断），后台异步、不占启动时间。
// 用法（人手动跑也行）：
//   node 12-源码照搬\工具\自动巡检.mjs          跑一遍，打印摘要
//   node 12-源码照搬\工具\自动巡检.mjs --json   机器可读
// 退出码：0 = 巡检本身跑完（**不代表全绿**，看 items 里的 ok）；2 = 前置不成立（找不到脚本）
//   —— 特意这样：巡检失败不该让调用方以为"工作台坏了"，坏没坏看具体项。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nodeExe } from './环境.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))       // 12-源码照搬\工具
const ROOT = path.dirname(HERE)                                 // 12-源码照搬
const REPO = path.dirname(ROOT)                                 // 仓根
const SHELL = path.join(ROOT, '外壳')
const OUT = path.join(SHELL, 'data', '巡检.json')
const AUTO_LOG = path.join(SHELL, 'data', '自动维护.log')

const sleepMs = 0
const exists = (p) => { try { return fs.existsSync(p) } catch (e) { return false } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

// 1. 要跑哪些（顺序无关；每条都会各自计时；超时一律 180s，check-gui 要跑 dump-config 最慢）
const TASKS = [
  { name: '自检', file: path.join(SHELL, 'scripts', '自检.mjs'), args: [], mustPass: true },
  { name: '会话对照', file: path.join(SHELL, 'scripts', 'sessions.mjs'), args: ['--check'], mustPass: true },
  { name: '门禁 check-gui', file: path.join(SHELL, 'scripts', 'check-gui.mjs'), args: [], mustPass: true },
  { name: '记忆体检', file: path.join(HERE, '记忆.mjs'), args: ['体检', '--project', REPO], mustPass: true },
  { name: '派发看门狗', file: path.join(HERE, '看门狗.mjs'), args: [], mustPass: true },
]

// 2. 跑一条：拿退出码 + 最后一行有意义的话（异常时能直接看出是哪一环）
function runOne(t, node) {
  const t0 = Date.now()
  const r = spawnSync(node, [t.file].concat(t.args), {
    cwd: SHELL, encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env),
  })
  const out = (String(r.stdout || '') + '\n' + String(r.stderr || '')).trim()
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const tail = lines.filter((l) => /^✗|^⛔|^!|全部通过|通过|健康|✓/.test(l)).pop() || lines[lines.length - 1] || ''
  return {
    name: t.name, ok: r.status === 0 && !r.error, code: r.status,
    ms: Date.now() - t0, tail: tail.slice(0, 200),
    err: r.error ? String(r.error.message || r.error) : '',
  }
}

function autoLog(line) {
  try { fs.appendFileSync(AUTO_LOG, '[' + new Date().toISOString() + '] ' + line + '\r\n') } catch (e) { /* 不阻塞巡检 */ }
}

// 3. 主流程
function main() {
  let node = process.execPath
  try { node = nodeExe() || node } catch (e) { autoLog('取 nodeExe 失败，退回本进程：' + ((e && e.message) || e)) }

  const items = []
  let missing = 0
  for (const t of TASKS) {
    if (!exists(t.file)) { items.push({ name: t.name, ok: false, code: -1, ms: 0, tail: '脚本不在：' + t.file, err: '' }); missing++; continue }
    items.push(runOne(t, node))
  }
  const at = Date.now()
  const fails = items.filter((x) => !x.ok)
  const doc = { at: new Date(at).toISOString(), node, total: items.length, fails: fails.length, items }
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\r\n', 'utf8')
  } catch (e) { autoLog('写 巡检.json 失败：' + ((e && e.message) || e)) }
  autoLog('巡检：' + items.length + ' 项，失败 ' + fails.length + (fails.length ? '（' + fails.map((f) => f.name).join(' / ') + '）' : ''))
  for (const f of fails) autoLog('  ✗ ' + f.name + ' → ' + (f.tail || f.err || ('退出码 ' + f.code)))

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(doc, null, 2))
    process.exit(missing ? 2 : 0)
  }
  for (const x of items) {
    const mark = x.ok ? '✓' : '✗'
    console.log(mark + ' ' + x.name.padEnd(14, '　') + ' ' + (x.ok ? '通过' : '失败') + ' · ' + (x.ms / 1000).toFixed(1) + 's · ' + x.tail)
  }
  console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项失败（结果写进 ' + OUT + '）' : '✓ 全部通过（结果写进 ' + OUT + '）'))
  process.exit(missing ? 2 : 0)
}

main()
