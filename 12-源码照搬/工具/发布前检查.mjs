#!/usr/bin/env node
/**
 * 发布前检查.mjs —— 出包/推仓库前扫一遍红线
 * 用法：node 工具\发布前检查.mjs
 *
 * 2026-11-12 修（配置本地化体检发现的三处失效，见 doc\配置本地化体检-2026-11-12.md §三）：
 *   ① 两条「本机绝对路径」规则原来写成字面量 `/<盘根>:\\\\DSH`：`<盘根>` 在正则里是字面字符不是占位符
 *      ⇒ 真实路径 `D:\codeData\…` 永远不命中，盘符/用户目录泄露等于没查。
 *      改成**运行时取本机真实值**再精确匹配（仓库根、用户目录），既不漏也不误伤代码里的 `b:\s*` 之类正则转义。
 *   ② 扫描面原来无条件递归全盘，连 gitignore 的运行态数据（引擎数据\storages、server.log）一起读
 *      ⇒ 109 处命中几乎全是假警。改成**优先只扫 git 跟踪的文件**（没装 git 才退回递归）。
 *   ③ 场景 json / 场景记忆 / 说明里的 sessionId 与项目路径是**设计上必须存在**的
 *      ⇒ 走白名单；模板占位符会话 id（session-00000000-…）也不算。
 *
 * 2026-11-13 加 ⑤：把 `场景记忆.mjs check --all` 挂进来当记忆闸门——
 *   记忆腐化（§五 又攒正文、单篇超 2 KB、证据指空）在出包前就该拦住，而不是等下一次开工才发现。
 *   只挂场景层（纯文件、不依赖本机 memory\），新机器克隆完也是绿的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..')   // 12-源码照搬
const REPO = path.resolve(ROOT, '..')                                     // 仓库根
const HOME_DIR = os.homedir()                                             // C:\Users\<名>

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const both = (s) => esc(s) + '|' + esc(s.replace(/\\/g, '/'))             // 反斜杠 / 正斜杠两种写法

// 规则：name / 正则 / 适用范围（'all' 全部文件，'code' 只有代码与配置）
const RULES = [
  ['本机绝对路径 <工作台>', new RegExp(both(REPO), 'i'), 'all'],
  ['本机用户目录 <用户目录>', new RegExp(both(HOME_DIR), 'i'), 'all'],
  ['会话 id', /session-[0-9a-f]{8}/i, 'all'],
  ['密钥', /sk-[A-Za-z0-9]{16,}/, 'all'],
  ['服务器 IP', /47\.108\.201\.6/, 'all'],
]
const CODE_EXT = /\.(js|mjs|cjs|json|yml|yaml|vbs|ps1|bat|cmd)$/i
const SKIP_DIR = new Set(['node_modules', '.git', '发布', 'dist'])
const SKIP_EXT = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.ico|\.woff2?|\.ttf|\.mp4|\.zip|\.7z|\.exe|\.dll|\.log|\.prev|\.jsonl|\.zstd)$/i
// 白名单：这些位置里的真实会话 id / 本机路径是设计上必须存在的
//   （面板绑定、记忆正文、说明与用法示例）。路径相对 ROOT（= 12-源码照搬）。
const ALLOW = [
  '外壳/scenarios/',
  '引擎数据/.dsh/场景记忆/',
  '说明/',
]
const PLACEHOLDER_ID = /session-00000000/i   // 模板占位符，不是真会话

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
const allowed = (r) => ALLOW.some((a) => r === a || r.startsWith(a))

let hits = 0
function scan(p) {
  const r = rel(p)
  if (allowed(r)) return
  let t
  try { t = fs.readFileSync(p, 'utf8') } catch { return }
  const isCode = CODE_EXT.test(p)
  for (const [name, re, scope] of RULES) {
    if (scope === 'code' && !isCode) continue
    const m = t.match(re)
    if (!m) continue
    if (name === '会话 id' && PLACEHOLDER_ID.test(m[0])) continue
    console.log('✗ ' + r + ' ← ' + name + '：' + m[0].slice(0, 40)); hits++
  }
}

// ④ 可移植性提示（2026-11-12 跨机器移植补的第四类检查）
//    白名单位置（场景 json / 项目.json）里的绝对路径是**设计上必须存在**的，红线规则管不到；
//    但换机器换盘符后它们会指向不存在的目录 ⇒ 面板静默错位。这里只提示，**不阻断提交**。
//    ⛔ 别改成红线：新机器克隆完必然全红，检查会被直接关掉（见 doc\跨机器移植兼容清单-2026-11-12.md）。
function portability() {
  const readJ = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
  const items = []
  const scenDir = path.join(ROOT, '外壳', 'scenarios')
  if (fs.existsSync(scenDir)) {
    for (const f of fs.readdirSync(scenDir)) {
      if (!f.endsWith('.json') || /\.bak\.json$/i.test(f)) continue
      const j = readJ(path.join(scenDir, f))
      if (!j) continue
      for (const p of j.panels || []) {
        for (const h of p.homeFolders || []) if (!fs.existsSync(h)) items.push(f + ' homeFolders ' + h)
        for (const d of p.drives || []) if (!fs.existsSync(d + '\\')) items.push(f + ' drives ' + d)
        if (p.repo && !fs.existsSync(p.repo)) items.push(f + ' repo ' + p.repo)
      }
    }
  }
  const reg = readJ(path.join(ROOT, '引擎数据', '.dsh', '场景记忆', '_共享记忆', '项目.json'))
  for (const p of (reg && reg.projects) || []) {
    for (const k of ['paths', 'memoryRoot', 'memory']) {
      const v = Array.isArray(p[k]) ? p[k] : p[k] ? [p[k]] : []
      for (const x of v) if (!fs.existsSync(x)) items.push('项目.json ' + p.name + '.' + k + ' ' + x)
    }
  }
  if (!items.length) { console.log('✓ 可移植性：场景路径与项目登记全部命中本机'); return }
  console.log('△ 可移植性：' + items.length + ' 处路径在本机不存在（换机器/换盘符后属正常，不影响本机提交）')
  for (const it of items.slice(0, 8)) console.log('    · ' + it)
  if (items.length > 8) console.log('    … 还有 ' + (items.length - 8) + ' 处')
  console.log('    处置：node 外壳\\scripts\\环境适配.mjs --apply（重算本机路径，不动仓库外项目）')
}

// ① 优先用 git 跟踪清单（天然排除 gitignore 的运行态数据）
function gitFiles() {
  const cands = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
  for (const bin of cands) {
    try {
      const out = execFileSync(bin, ['-c', 'core.quotepath=false', 'ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
      return out.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch { /* 换下一个候选 */ }
  }
  return null
}

const list = gitFiles()
if (list) {
  // ② 有 git：只扫库里 12-源码照搬 下的入库文件（入库文件才可能被推出去）
  for (const f of list) {
    if (SKIP_EXT.test(f)) continue
    const p = path.join(REPO, f)
    if (p !== ROOT && !p.startsWith(ROOT + path.sep)) continue
    if (fs.existsSync(p)) scan(p)
  }
} else {
  // ③ 没 git：退回递归，但跳过运行态目录
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (SKIP_EXT.test(e.name)) continue
      scan(p)
    }
  }
  walk(ROOT)
  console.log('（没找到 git，按递归扫描：运行态数据可能被算进来）')
}

portability()

// ⑤ 记忆闸门（2026-11-13 加）：场景记忆的结构/体量/证据一起验。
//   只跑 场景记忆.mjs check --all（纯场景层，不依赖本机 memory\），所以新机器克隆完也是绿的；
//   ⛔ 别把它扩成「体验」，那会依赖 memory\，新克隆必然全红（同 portability 的理由）。
{
  const tool = path.join(ROOT, '工具', '场景记忆.mjs')
  if (!fs.existsSync(tool)) {
    console.log('⚠ 找不到 场景记忆.mjs ⇒ 跳过记忆闸门')
  } else {
    const r = spawnSync(process.execPath, [tool, 'check', '--all'], { cwd: ROOT, encoding: 'utf8' })
    const bad = String((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter((l) => l.includes('✗'))
    if (r.status === 0) console.log('✓ 记忆闸门：场景记忆 check --all 通过')
    else {
      hits += bad.length || 1
      console.log('✗ 记忆闸门：场景记忆 check --all 没过（' + (bad[0] || '见上方输出').trim() + '）')
      bad.slice(1, 4).forEach((l) => console.log('   ' + l.trim()))
    }
  }
}

console.log('')
if (hits) { console.log('命中 ' + hits + ' 处红线 ⇒ 不出包'); process.exit(1) }
console.log('✓ 红线检查通过（0 命中）')
