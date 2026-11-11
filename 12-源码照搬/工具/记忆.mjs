#!/usr/bin/env node
// 记忆.mjs — 工作台项目记忆工具（零依赖，Node 内置模块）
// 命令：init / index / recall / card / check / migrate
//   node 工具\记忆.mjs init    --project <项目根> [--dry] [--track]
//   node 工具\记忆.mjs index   --project <项目根>
//   node 工具\记忆.mjs recall  --project <项目根> "关键词" [--limit 8] [--json]
//   node 工具\记忆.mjs card    --project <项目根> [--name mlw] [--force]
//   node 工具\记忆.mjs check   --project <项目根> [--strict]
//   node 工具\记忆.mjs migrate --from <.mnemon> [--dry] [--json]
//
// 约定：
//   - 记忆正文只住 <项目根>\memory\**\*.md；本工具不复制正文。
//   - `_索引.json` 是可再生产物；`archive/` 不进索引、不参与召回。
//   - 默认把 memory/ 与 AGENTS.md 写进目标仓 .gitignore（--track 关闭）。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKBENCH = path.resolve(TOOL_DIR, '..', '..')
const TEMPLATE = path.join(WORKBENCH, '模板', '项目记忆骨架')
const CARD_DIR = path.join(WORKBENCH, '12-源码照搬', '引擎数据', '.dsh', '场景记忆', '程序开发', '项目记忆')
const CATEGORIES = ['architecture', 'interfaces', 'runbooks', 'pitfalls', 'decisions', 'function_realize', 'sql-log', 'handoffs', 'archive']
const SKIP_DIRS = new Set(['.git', 'node_modules', 'documents', '.idea', '.vscode'])

// ---------- 基础 ----------

function parseArgs(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry' || a === '--json' || a === '--force' || a === '--track' || a === '--strict') { flags[a.slice(2)] = true; continue }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error('参数缺少取值：--' + k)
      flags[k] = v; i++
      continue
    }
    pos.push(a)
  }
  return { flags, pos }
}

function requireProject(flags) {
  const p = flags.project
  if (!p) throw new Error('缺少 --project <项目根>')
  const root = path.resolve(p)
  if (!fs.existsSync(root)) throw new Error('项目根不存在：' + root)
  return root
}

function memoryRoot(root) { return path.join(root, 'memory') }

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function readJson(file, fallback) {
  const t = readText(file)
  if (!t.trim()) return fallback
  try { return JSON.parse(t) } catch (e) { throw new Error('JSON 解析失败：' + file + '：' + e.message) }
}

function walk(dir, visit) {
  let rows = []
  try { rows = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const it of rows) {
    if (it.isDirectory() && SKIP_DIRS.has(it.name)) continue
    const full = path.join(dir, it.name)
    if (it.isDirectory()) walk(full, visit)
    else if (it.isFile()) visit(full)
  }
}

function relPosix(root, file) { return path.relative(root, file).split(path.sep).join('/') }

function toCRLF(s) { return String(s).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') }

function stripMd(s) {
  return String(s || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isIgnoredRel(posix) {
  if (posix === 'MEMORY_INDEX.md') return true
  if (/(^|\/)README\.md$/.test(posix)) return true
  if (posix.startsWith('archive/')) return true
  if (/(^|\/)_/.test(posix)) return true
  return false
}

// ---------- 解析 ----------

function parseFrontmatter(text) {
  const fm = {}
  if (!text.startsWith('---')) return { fm, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { fm, body: text }
  const head = text.slice(3, end).split(/\r?\n/)
  let cur = null
  for (const line of head) {
    if (!line.trim()) continue
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (m) {
      cur = m[1]
      const v = m[2].trim()
      if (v === '') { fm[cur] = []; continue }
      if (/^\[.*\]$/.test(v)) fm[cur] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      else fm[cur] = v.replace(/^["']|["']$/g, '')
      continue
    }
    if (cur && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(fm[cur])) fm[cur] = []
      fm[cur].push(line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''))
    }
  }
  return { fm, body: text.slice(end + 4) }
}

function parseDoc(file, mem) {
  const text = readText(file)
  const { fm, body } = parseFrontmatter(text)
  const posix = relPosix(mem, file)
  const h1 = (body.match(/^#\s+(.+)$/m) || [])[1]
  const title = stripMd(fm.title || h1 || path.basename(file, '.md'))
  let desc = fm.description || ''
  if (!desc) {
    const m = body.replace(/^#.*$/m, '').match(/^\s*([^\n#>][^\n]*)$/m)
    desc = m ? m[1] : ''
  }
  const tags = Array.isArray(fm.tags) ? fm.tags : (fm.tags ? String(fm.tags).split(/[,，]/).map(s => s.trim()).filter(Boolean) : [])
  const headings = [...body.matchAll(/^##+\s+(.+)$/gm)].map(m => stripMd(m[1]))
  const stat = fs.statSync(file)
  const dateMatch = String(fm.date || '').match(/^\d{4}-\d{2}-\d{2}/)
  const date = dateMatch ? dateMatch[0] : (path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/) || [])[1]
    || new Date(stat.mtimeMs).toISOString().slice(0, 10)
  return {
    path: posix,
    category: posix.split('/')[0],
    title,
    description: stripMd(desc).slice(0, 240),
    tags,
    headings,
    date,
    size: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    body
  }
}

function scanDocs(root) {
  const mem = memoryRoot(root)
  const docs = []
  if (!fs.existsSync(mem)) return docs
  walk(mem, (file) => {
    if (!/\.md$/i.test(file)) return
    const posix = relPosix(mem, file)
    if (isIgnoredRel(posix)) return
    if (!CATEGORIES.includes(posix.split('/')[0])) return
    docs.push(parseDoc(file, mem))
  })
  return docs.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
}

// ---------- 召回 ----------

function tokenize(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  for (const w of s.match(/[a-z0-9][a-z0-9_.\-/]{1,}/g) || []) out.add(w)
  return [...out]
}

function loadLexicon(root) {
  try {
    const obj = readJson(path.join(memoryRoot(root), '_词表.json'), {})
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch { return {} }
}

function expandTokens(tokens, lexicon) {
  const out = new Set(tokens)
  for (const t of tokens) {
    const v = lexicon[t]
    if (Array.isArray(v)) v.forEach(x => tokenize(x).forEach(y => out.add(y)))
    for (const [k, arr] of Object.entries(lexicon)) {
      if (Array.isArray(arr) && arr.some(x => String(x).toLowerCase().includes(t))) tokenize(k).forEach(y => out.add(y))
    }
  }
  return [...out]
}

function countOcc(hay, needle) {
  if (!needle) return 0
  return hay.split(needle).length - 1
}

function snippetOf(raw, tokens) {
  const lines = String(raw || '').split(/\r?\n/)
  let best = ''
  for (const line of lines) {
    if (!line.trim() || /^\s*#{1,6}\s/.test(line)) continue
    const low = line.toLowerCase()
    if (tokens.some(t => low.includes(t))) { best = line; break }
  }
  if (!best) best = lines.find(l => l.trim()) || ''
  return stripMd(best).slice(0, 120)
}

const FIELD_WEIGHT = { title: 5, tags: 4, headings: 3, description: 2, body: 1 }
const FIELD_NAME = { title: '标题', tags: '标签', headings: '小标题', description: '描述', body: '正文' }

function scoreDoc(doc, tokens) {
  const fields = {
    title: (doc.title || '').toLowerCase(),
    tags: (doc.tags || []).join(' ').toLowerCase(),
    headings: (doc.headings || []).join(' ').toLowerCase(),
    description: (doc.description || '').toLowerCase(),
    body: String(doc.body || '').toLowerCase()
  }
  let score = 0
  let best = { field: '', w: 0 }
  let hit = 0
  for (const t of tokens) {
    let any = false
    for (const [name, hay] of Object.entries(fields)) {
      const c = countOcc(hay, t)
      if (!c) continue
      any = true
      const w = c * FIELD_WEIGHT[name]
      score += w
      if (w > best.w) best = { field: name, w }
    }
    if (any) hit++
  }
  if (!hit) return null
  score = score / (1 + Math.log10(1 + String(doc.body || '').length / 1200))
  return { score, hit, reason: best.field }
}

function cmdRecall(root, q, flags) {
  const mem = memoryRoot(root)
  if (!fs.existsSync(mem)) throw new Error('未初始化：缺少 ' + mem + '（先跑 init）')
  if (!q) throw new Error('缺少召回关键词')
  const docs = scanDocs(root)
  const lexicon = loadLexicon(root)
  const tokens = expandTokens(tokenize(q), lexicon)
  const hits = []
  for (const doc of docs) {
    const s = scoreDoc(doc, tokens)
    if (s) hits.push({ doc, ...s })
  }
  hits.sort((a, b) => b.score - a.score || String(b.doc.date).localeCompare(String(a.doc.date)))
  const limit = Math.max(1, Number(flags.limit || 8))
  const top = hits.slice(0, limit).map(h => ({
    path: 'memory/' + h.doc.path,
    category: h.doc.category,
    title: h.doc.title,
    date: h.doc.date,
    reason: FIELD_NAME[h.reason] || h.reason,
    score: Number(h.score.toFixed(2)),
    snippet: snippetOf(h.doc.body, tokens)
  }))
  if (flags.json) {
    console.log(JSON.stringify({ recall: 'lexical', project: path.basename(root), query: q, total: docs.length, hits: top }, null, 2))
    return 0
  }
  const head = '[lexical] project=' + path.basename(root) + ' q="' + q + '" 命中 ' + hits.length + '/' + docs.length
  if (!top.length) {
    console.log(head + ' — 没有命中，直接读代码（记忆不是阻塞项）')
    return 0
  }
  const lines = [head]
  top.forEach((h, i) => {
    lines.push((i + 1) + '. ' + h.path.replace(/^memory\//, '') + ' · ' + h.title + ' · 命中' + h.reason + (h.snippet ? '「' + h.snippet + '」' : '') + ' · ' + h.score)
  })
  let out = lines.join('\n')
  while (Buffer.byteLength(out, 'utf8') > 2048 && top.length > 1) {
    top.pop()
    out = head + '\n' + top.map((h, i) => (i + 1) + '. ' + h.path.replace(/^memory\//, '') + ' · ' + h.title + ' · 命中' + h.reason + ' · ' + h.score).join('\n')
  }
  console.log(out)
  return 0
}

// ---------- 索引 ----------

function indexRows(docs) {
  const sorted = docs.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.path.localeCompare(b.path, 'zh'))
  const rows = ['| 日期 | 文件 | 标题 |', '|---|---|---|']
  if (!sorted.length) rows.push('| — | — | （还没有记录） |')
  sorted.forEach(d => rows.push('| ' + d.date + ' | `' + path.basename(d.path) + '` | ' + d.title.replace(/\|/g, '\\|') + ' |'))
  return rows.join('\r\n')
}

function replaceAuto(text, block) {
  const begin = '<!-- AUTO:BEGIN -->'
  const end = '<!-- AUTO:END -->'
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  if (i < 0 || j < 0 || j < i) return null
  return text.slice(0, i + begin.length) + '\r\n' + block + '\r\n' + text.slice(j)
}

function cmdIndex(root) {
  const mem = memoryRoot(root)
  if (!fs.existsSync(mem)) throw new Error('未初始化：缺少 ' + mem + '（先跑 init）')
  const docs = scanDocs(root)
  const payload = { version: 1, project: path.basename(root), generatedAt: new Date().toISOString(), docs }
  writeAtomic(path.join(mem, '_索引.json'), JSON.stringify(payload, null, 2) + '\n')
  // 各级 README 的自动区
  let synced = 0
  for (const cat of CATEGORIES) {
    const readme = path.join(mem, cat, 'README.md')
    if (!fs.existsSync(readme)) continue
    const text = readText(readme)
    const next = replaceAuto(text, indexRows(docs.filter(d => d.category === cat)))
    if (next && next !== text) { writeAtomic(readme, toCRLF(next)); synced++ }
  }
  console.log('索引完成：' + payload.project + ' · 文档 ' + docs.length + ' · README 自动区同步 ' + synced)
  return 0
}

// ---------- 初始化 ----------

function copyTreeIfMissing(src, dst) {
  const created = []
  const rows = fs.readdirSync(src, { withFileTypes: true })
  for (const it of rows) {
    const s = path.join(src, it.name)
    const d = path.join(dst, it.name)
    if (it.isDirectory()) created.push(...copyTreeIfMissing(s, d))
    else if (!fs.existsSync(d)) {
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.copyFileSync(s, d)
      created.push(d)
    }
  }
  return created
}

function ensureGitignore(root, dry) {
  const file = path.join(root, '.gitignore')
  const need = ['memory/', 'AGENTS.md']
  const cur = readText(file)
  const lines = cur.split(/\r?\n/).map(s => s.trim())
  const missing = need.filter(n => !lines.includes(n))
  if (!missing.length) return { added: [], file }
  if (dry) return { added: missing, file, dry: true }
  const base = cur && !cur.endsWith('\n') ? cur + '\n' : cur
  writeAtomic(file, base + missing.join('\n') + '\n')
  return { added: missing, file }
}

function cmdInit(root, flags) {
  const mem = memoryRoot(root)
  const name = flags.name || path.basename(root)
  const planned = []
  if (flags.dry) {
    // 只报计划：模板文件 + 索引 + .gitignore
    const tpl = []
    walk(TEMPLATE, f => { if (f.endsWith('README.md') || f.endsWith('MEMORY_INDEX.md') || f.endsWith('.json')) tpl.push(f) })
    console.log('[dry] 将在 ' + mem + ' 建：' + tpl.map(f => relPosix(TEMPLATE, f)).join('、'))
    const gi = ensureGitignore(root, true)
    if (gi.added.length) console.log('[dry] 将往 .gitignore 追加：' + gi.added.join('、'))
    return 0
  }
  fs.mkdirSync(mem, { recursive: true })
  if (!fs.existsSync(TEMPLATE)) throw new Error('缺少骨架模板：' + TEMPLATE)
  planned.push(...copyTreeIfMissing(TEMPLATE, mem))
  // 索引里的项目名/占位替换（只处理刚复制的 MEMORY_INDEX）
  const mi = path.join(mem, 'MEMORY_INDEX.md')
  if (fs.existsSync(mi)) {
    const t = readText(mi).replace(/# <项目> · 记忆索引/, '# ' + name + ' · 记忆索引')
    if (t !== readText(mi)) writeAtomic(mi, toCRLF(t))
  }
  if (!fs.existsSync(path.join(mem, '_词表.json'))) writeAtomic(path.join(mem, '_词表.json'), '{}\n')
  const gi = flags.track ? { added: [], file: '' } : ensureGitignore(root, false)
  cmdIndex(root)
  console.log('初始化完成：' + name + ' · 新建 ' + planned.length + ' 个文件' + (gi.added.length ? ' · .gitignore 追加 ' + gi.added.join('、') : ' · .gitignore 已是最新'))
  const tracked = trackedFiles(root, ['memory', 'AGENTS.md'])
  if (tracked.length) console.log('⚠ 这些路径已被 git 跟踪，请确认是否属例外：' + tracked.join('、'))
  return 0
}

function trackedFiles(root, paths) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--'].concat(paths), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).filter(Boolean)
  } catch { return [] }
}

// ---------- 薄卡 ----------

function cardPathOf(root, flags) {
  const name = flags.name || path.basename(root)
  return flags.card ? path.resolve(flags.card) : path.join(CARD_DIR, name + '.md')
}

function cardBlock(root) {
  const docs = scanDocs(root).sort((a, b) => String(b.date).localeCompare(String(a.date)))
  const recent = docs.slice(0, 5)
  const lines = [
    '- 项目根：`' + root + '`',
    '- 记忆索引：`memory\\MEMORY_INDEX.md`（分类见各目录 README）',
    '- 项目规则：`AGENTS.md`（默认不入库）；提交：见项目 `AGENTS.md` / `doc\\提交准则.md`',
    '- 最近 5 条：'
  ]
  if (!recent.length) lines.push('  - （空；先写第一篇）')
  recent.forEach(d => lines.push('  - `memory/' + d.path + '` · ' + d.title + ' · ' + d.date))
  lines.push('- 召回：`node "' + path.join(TOOL_DIR, '记忆.mjs') + '" recall --project "' + root + '" "<关键词>"`')
  return lines.join('\r\n')
}

function cmdCard(root, flags) {
  const cardPath = cardPathOf(root, flags)
  const block = cardBlock(root)
  if (fs.existsSync(cardPath)) {
    const cur = readText(cardPath)
    const next = replaceAuto(cur, block)
    if (!next) {
      if (!flags.force) throw new Error('薄卡已存在但没有 AUTO 标记（可能是旧摘要）：' + cardPath + '；确认后用 --force 覆盖')
      writeAtomic(cardPath, cardTemplate(root, block))
      console.log('薄卡已覆盖：' + cardPath)
      return 0
    }
    writeAtomic(cardPath, toCRLF(next))
    console.log('薄卡已刷新：' + cardPath)
    return 0
  }
  writeAtomic(cardPath, cardTemplate(root, block))
  console.log('薄卡已生成：' + cardPath)
  return 0
}

function cardTemplate(root, block) {
  const name = path.basename(root)
  return [
    '# ' + name + ' · 记忆薄卡',
    '',
    '> 正文在 `<项目根>\\memory\\`；本卡只放指针，不放业务知识。',
    '',
    '<!-- AUTO:BEGIN -->',
    block,
    '<!-- AUTO:END -->',
    '',
    '## 当前状态（手写，≤3 行）',
    '- （待填）',
    ''
  ].join('\r\n')
}

// ---------- 校验 ----------

function cmdCheck(root, flags) {
  const mem = memoryRoot(root)
  const errors = []
  const warns = []
  if (!fs.existsSync(mem)) { console.error('✗ 未初始化：缺少 ' + mem); return 1 }
  if (!fs.existsSync(path.join(mem, 'MEMORY_INDEX.md'))) errors.push('缺少 memory\\MEMORY_INDEX.md')
  let idx = null
  try { idx = readJson(path.join(mem, '_索引.json'), null) } catch (e) { errors.push(e.message) }
  if (!idx) errors.push('缺少或无法解析 memory\\_索引.json（先跑 index）')

  const docs = scanDocs(root)
  const titles = {}
  docs.forEach(d => { titles[d.title] = (titles[d.title] || 0) + 1 })
  Object.entries(titles).filter(([, n]) => n > 1).forEach(([t]) => errors.push('重复标题：' + t))

  // 索引与文件是否一致（路径集合 / mtime）
  if (idx && Array.isArray(idx.docs)) {
    const a = new Set(idx.docs.map(d => d.path))
    const b = new Set(docs.map(d => d.path))
    const stale = [...b].filter(p => !a.has(p)).concat([...a].filter(p => !b.has(p)))
    if (stale.length) errors.push('索引过期：' + stale.slice(0, 5).join('、') + '（跑 index）')
    const changed = docs.filter(d => {
      const old = idx.docs.find(x => x.path === d.path)
      return old && old.mtime !== d.mtime
    })
    if (changed.length) errors.push('索引与文件时间不一致：' + changed.slice(0, 5).map(d => d.path).join('、') + '（跑 index）')
  }

  // 类目与 README
  walk(mem, (file) => {
    if (!/\.md$/i.test(file)) return
    const posix = relPosix(mem, file)
    if (isIgnoredRel(posix)) return
    const cat = posix.split('/')[0]
    if (!CATEGORIES.includes(cat)) errors.push('文件不在合法类目：' + posix)
  })
  for (const cat of CATEGORIES) {
    const dir = path.join(mem, cat)
    if (!fs.existsSync(dir)) continue
    const hasDoc = docs.some(d => d.category === cat)
    if (hasDoc && !fs.existsSync(path.join(dir, 'README.md'))) errors.push('类目缺 README：' + cat)
    const readme = path.join(dir, 'README.md')
    if (fs.existsSync(readme)) {
      const next = replaceAuto(readText(readme), indexRows(docs.filter(d => d.category === cat)))
      if (next === null) warns.push('README 无 AUTO 区块（索引不会自动同步）：' + cat)
      else if (next !== readText(readme)) errors.push('README 自动区过期：' + cat + '（跑 index）')
    }
  }

  // 薄卡
  const cardPath = cardPathOf(root, flags)
  if (fs.existsSync(cardPath)) {
    const text = readText(cardPath)
    if (Buffer.byteLength(text, 'utf8') > 1800) warns.push('薄卡超过 1.8 KB：' + cardPath)
    if (!text.includes('memory\\MEMORY_INDEX.md')) warns.push('薄卡没有指向记忆索引：' + cardPath)
    for (const m of text.matchAll(/memory[\\/]([^\s`）)]+\.md)/g)) {
      const rel = m[1].replace(/^[\\/]+/, '')
      if (!fs.existsSync(path.join(mem, rel))) errors.push('薄卡指向不存在的文件：memory/' + rel)
    }
  } else {
    warns.push('薄卡不存在：' + cardPath + '（跑 card）')
  }

  // 默认不入库：被跟踪只告警
  const tracked = trackedFiles(root, ['memory', 'AGENTS.md'])
  if (tracked.length) warns.push('已被 git 跟踪（默认应忽略，确认是否例外）：' + tracked.slice(0, 5).join('、'))

  if (warns.length) warns.forEach(w => console.log('⚠ ' + w))
  if (errors.length) { errors.forEach(e => console.log('✗ ' + e)); return 1 }
  console.log('✓ 记忆检查通过：' + path.basename(root) + ' · 文档 ' + docs.length)
  return 0
}

// ---------- 迁移 ----------

const CLASSIFY = [
  ['pitfalls', /(坑|排障|排查|报错|异常|失败|踩|不能|注意|兼容)/],
  ['decisions', /(决策|定稿|方案|选型|约定|规则|口径|确定|取舍)/],
  ['interfaces', /(接口|契约|字段|入参|出参|消息|回调|API)/i],
  ['runbooks', /(启动|部署|运行|流程|步骤|联调|配置|环境|验收|安装)/],
  ['function_realize', /(新增|修改|实现|改造|功能|拆分|迁移)/],
  ['architecture', /(架构|边界|职责|模块|仓库|目录)/]
]

function classify(title, desc) {
  const t = String(title || '') + ' ' + String(desc || '')
  for (const [cat, re] of CLASSIFY) if (re.test(t)) return cat
  return '未定'
}

function cmdMigrate(flags) {
  const from = flags.from
  if (!from) throw new Error('缺少 --from <.mnemon 目录>')
  const root = path.resolve(from)
  const idxFile = [path.join(root, 'documents', 'index.json'), path.join(root, 'index.json')].find(f => fs.existsSync(f))
  if (!idxFile) throw new Error('找不到 mnemon 索引：' + root)
  const idx = readJson(idxFile, { documents: [] })
  const docs = Array.isArray(idx.documents) ? idx.documents : []
  const rows = docs.map((d, i) => {
    const rel = d.relativePath || ('documents/active/' + d.filename)
    const file = path.join(root, rel)
    const body = readText(file)
    return {
      i: i + 1,
      category: classify(d.title, d.description),
      date: String(d.createdAt || d.updatedAt || '').slice(0, 10),
      title: d.title,
      size: body ? Buffer.byteLength(body, 'utf8') : 0,
      source: rel,
      exists: !!body
    }
  })
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0 }
  console.log('迁移建议（dry-run，不落盘）：' + docs.length + ' 篇 · 来源 ' + root)
  const count = {}
  rows.forEach(r => { count[r.category] = (count[r.category] || 0) + 1 })
  console.log('分类汇总：' + Object.entries(count).map(([k, v]) => k + '=' + v).join(' · '))
  rows.forEach(r => console.log([r.i, r.category, r.date || '—', (r.size / 1024).toFixed(1) + 'KB', r.title, r.exists ? '' : '（缺文件）'].join(' | ')))
  console.log('下一步：人工确认类目后，按 memory\\<类目>\\YYYY-MM-DD-动作-对象.md 落正文；工具不自动写。')
  return 0
}

// ---------- 主流程 ----------

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const { flags, pos } = parseArgs(argv.slice(1))
  // 1. 分派命令
  switch (cmd) {
    case 'init': return cmdInit(requireProject(flags), flags)
    case 'index': return cmdIndex(requireProject(flags))
    case 'recall': return cmdRecall(requireProject(flags), flags.q || pos.join(' ').trim(), flags)
    case 'card': return cmdCard(requireProject(flags), flags)
    case 'check': return cmdCheck(requireProject(flags), flags)
    case 'migrate': return cmdMigrate(flags)
    default:
      console.error('用法：node 工具\\记忆.mjs <init|index|recall|card|check|migrate> --project <根> [参数]')
      return 2
  }
}

try {
  process.exitCode = main()
} catch (e) {
  console.error('✗ ' + (e && e.message ? e.message : e))
  process.exitCode = 1
}
