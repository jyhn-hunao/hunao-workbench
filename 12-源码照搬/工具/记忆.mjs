#!/usr/bin/env node
// 记忆.mjs — 工作台项目记忆工具（零依赖，Node 内置模块）
// 命令：init / index / recall / card / check / 写 / 体检 / 备份 / migrate
//   node 工具\记忆.mjs init    --project <项目根> [--dry] [--track]
//   node 工具\记忆.mjs index   --project <项目根>
//   node 工具\记忆.mjs recall  --project <项目根> "关键词" [--limit 8] [--min 2] [--json] [--no-log]
//   recall 默认按分数阈值（--min，默认 2）滤掉低分噪声，并把每次调用写进 memory\_召回.log；
//   `--no-log` 关流水，`--min 0` 关阈值。
//   node 工具\记忆.mjs card    --project <项目根> [--name mlw] [--force]
//   node 工具\记忆.mjs check   --project <项目根> [--strict]
//   node 工具\记忆.mjs 写      --project <根> --类 <类目> --标题 <标题> [--正文 <md>|--要点 "a|b|c"]
//                              [--描述 <一句话>] [--标签 a,b] [--证据 "<路径>::<片段>"] [--dry]
//   node 工具\记忆.mjs 体检    --project <项目根> [--noscene]     ← 收工/换会话前的总闸门，exit 0 才算健康
//   node 工具\记忆.mjs 备份    --project <根> [--to <目录>] [--keep 10]
//   node 工具\记忆.mjs migrate --from <.mnemon> [--dry] [--json]
//
// 约定：
//   - 记忆正文只住 <项目根>\memory\**\*.md；本工具不复制正文。
//   - `_索引.json` 是可再生产物；`archive/` 不进索引、不参与召回。
//   - 默认把 memory/、AGENTS.md、.memory-backup/ 写进目标仓 .gitignore（--track 关闭）。
//   - 每条记忆的 frontmatter 可带 evidence（`路径::文件里的片段`），体检时逐条复核，用来发现「记忆还在说，代码已经变了」。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
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
    if (a === '--dry' || a === '--json' || a === '--force' || a === '--track' || a === '--strict' || a === '--no-log' || a === '--noscene') { flags[a.slice(2)] = true; continue }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error('参数缺少取值：--' + k)
      // 同名参数可重复（如两条 --证据）：第一次赋值，之后并成数组（2026-11-13 修：原来只留最后一个）
      flags[k] = Object.prototype.hasOwnProperty.call(flags, k)
        ? (Array.isArray(flags[k]) ? flags[k].concat(v) : [flags[k], v])
        : v
      i++
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
  // evidence：这条记忆靠什么成立（`路径::文件里的片段`），体检时逐条复核；没有它就只能靠人记得「当时是这样」
  const evidence = Array.isArray(fm.evidence) ? fm.evidence.map(String) : (fm.evidence ? [String(fm.evidence)] : [])
  // no_evidence：明说「这条为什么不需要证据」，体检把它当已交代（不给就等于漏登记，见体检第 3 项）
  const noEv = String(fm.no_evidence || '').trim()
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
    evidence,
    noEv,
    headings,
    date,
    size: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
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

/** 召回流水：一行一条，用来事后证明「召回到底有没有被调用」（memory\ 已 ignore，日志不进库） */
function logRecall(root, q, total, hit, filtered, top) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const at = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  const one = (s) => String(s || '').replace(/[\r\n|]/g, ' ').slice(0, 80)
  const line = [at, path.basename(root), 'q="' + one(q) + '"',
    'hit=' + hit + '/' + total, 'filtered=' + filtered,
    'top=' + (top.slice(0, 3).map(t => t.path.replace(/^memory\//, '')).join(',') || '-')].join(' | ')
  try { fs.appendFileSync(path.join(memoryRoot(root), '_召回.log'), line + '\n', 'utf8') } catch { /* 日志失败不影响召回 */ }
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
  // 1. 过滤低分命中（2026-11-12 加）：bigram 词法很容易因一个通用二字词就命中，
  //    没有阈值时 top8 里会混进 0.8 分的噪声；默认 2.0 ≈「至少两个词同现」或「一个词进了标题/标签」
  const MIN = flags.min === undefined ? 2 : Math.max(0, Number(flags.min) || 0)
  const kept = hits.filter(h => h.score >= MIN)
  const filtered = hits.length - kept.length
  const limit = Math.max(1, Number(flags.limit || 8))
  const top = kept.slice(0, limit).map(h => ({
    path: 'memory/' + h.doc.path,
    category: h.doc.category,
    title: h.doc.title,
    date: h.doc.date,
    reason: FIELD_NAME[h.reason] || h.reason,
    score: Number(h.score.toFixed(2)),
    snippet: snippetOf(h.doc.body, tokens)
  }))
  // 2. 记账（2026-11-12 加）：召回不写日志 = 「有没有被调用」永远只能猜；memory\ 已被 ignore，日志不进库
  if (!flags['no-log']) logRecall(root, q, docs.length, kept.length, filtered, top)
  if (flags.json) {
    console.log(JSON.stringify({ recall: 'lexical', project: path.basename(root), query: q, total: docs.length, threshold: MIN, filtered, hits: top }, null, 2))
    return 0
  }
  const head = '[lexical] project=' + path.basename(root) + ' q="' + q + '" 命中 ' + kept.length + '/' + docs.length
    + (filtered ? '（阈值 ' + MIN + ' 滤掉 ' + filtered + ' 条低分）' : '')
  if (!top.length) {
    console.log(head + ' — 没有够格的命中，直接读代码（记忆不是阻塞项）')
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

function cmdIndex(root, quiet) {
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
  if (!quiet) console.log('索引完成：' + payload.project + ' · 文档 ' + docs.length + ' · README 自动区同步 ' + synced)
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
  const need = ['memory/', 'AGENTS.md', '.memory-backup/']
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
  // 词表空转（2026-11-12 加）：_词表.json 存在但为 {} 时同义词扩展静默失效，只告警不阻断
  if (docs.length && !Object.keys(loadLexicon(root)).length) warns.push('_词表.json 为空：同义词/别称扩展未生效（填几组常用别称即可）')
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

  // 默认不入库：memory\ 被跟踪才告警；AGENTS.md 只在「.gitignore 说忽略、却又被跟踪」时才告警
  //   2026-11-12：本仓 .gitignore 已明确「AGENTS.md 是模板规则、属例外」，旧判据仍按 ls-files 报警 ⇒ 永久假告警
  const tracked = trackedFiles(root, ['memory', 'AGENTS.md'])
  const gi = readText(path.join(root, '.gitignore')).split(/\r?\n/).map(s => s.trim())
  const bad = tracked.filter((f) => {
    const base = f.split(/[\\/]/)[0]
    return base === 'AGENTS.md' ? gi.includes('AGENTS.md') : (gi.includes('memory/') || gi.includes('memory'))
  })
  if (bad.length) warns.push('已被 git 跟踪（默认应忽略，确认是否例外）：' + bad.slice(0, 5).join('、'))

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

// ---------- 写回 ----------

const SLUG_BAD = /[\\/:*?"<>|\s]+/g

/**
 * 写回一条记忆（2026-11-12 加）：把「结构对 + 索引新 + 自检过」三件事合成一步，
 * 免得人只写了正文、忘了 index，下次 check 才炸。
 *   node 记忆.mjs 写 --project <根> --类 <类目> --标题 <标题> [--正文 <md>|--要点 "a|b|c"]
 *                 [--描述 <一句话>] [--标签 a,b] [--证据 "<相对路径>::<片段>"] [--无证据 <原因>] [--dry]
 */
function cmdWrite(root, flags) {
  // 1. 校验入参（类目白名单、标题唯一、未初始化直接报；中英参数名都认）
  const cat = String(flags.cat || flags['类'] || '')
  const title = String(flags.title || flags['标题'] || '').trim()
  if (!CATEGORIES.includes(cat)) throw new Error('--类 必须是：' + CATEGORIES.join(' / '))
  if (!title) throw new Error('缺少 --标题')
  const mem = memoryRoot(root)
  if (!fs.existsSync(mem)) throw new Error('未初始化：缺少 ' + mem + '（先跑 init）')
  const dup = scanDocs(root).find(d => d.title === title)
  if (dup) throw new Error('同名记忆已存在：memory/' + dup.path + '（改标题，或直接编辑那一篇）')

  // 2. 组正文（--正文 优先；否则按 --要点 的 `a|b|c` 生成要点行）
  let inner = ''
  const bodyFile = String(flags.body || flags['正文'] || '')
  if (bodyFile) {
    const f = path.resolve(bodyFile)
    if (!fs.existsSync(f)) throw new Error('正文文件不存在：' + f)
    inner = parseFrontmatter(readText(f)).body
  } else if (flags.points || flags['要点']) {
    const pts = String(flags.points || flags['要点']).split('|').map(s => s.trim()).filter(Boolean)
    if (!pts.length) throw new Error('--要点 里没有内容')
    inner = '## 要点\r\n' + pts.map(s => '- ' + s).join('\r\n')
  } else throw new Error('缺少 --正文 <md文件> 或 --要点 "a|b|c"')
  inner = inner.replace(/^\s*#\s+[^\r\n]*\r?\n/, '').trim()
  // 本仓文本约定是 CRLF，草稿可能是 LF：这里统一，别把混合换行写进正文
  inner = inner.replace(/\r?\n/g, '\r\n')

  // 3. 补 frontmatter：evidence 是「三个月后还能自证」的唯一凭据
  //    2026-11-13：决策/坑默认必须有证据；说不出的就写 --无证据 "原因"，让「没有证据」也留痕
  //    description 不再自动抄正文首行——解析时本来就回落到正文（parseDoc），写进文件只是白占 ~300 B/篇
  const descGiven = String(flags.desc || flags['描述'] || '').trim()
  // 同名参数可能是数组（重复传 --证据 / --标签）
  const listOf = (x) => (Array.isArray(x) ? x.join(';') : String(x || ''))
  const tags = listOf(flags.tags || flags['标签']).split(/[,，;；]/).map(s => s.trim()).filter(Boolean)
  const ev = listOf(flags.evidence || flags['证据']).split(/[;；]/).map(s => s.trim()).filter(Boolean)
  const noEv = String(flags['无证据'] || flags.no_evidence || '').trim()
  const MUST_EV = ['decisions', 'pitfalls']
  if (MUST_EV.includes(cat) && !ev.length && !noEv) {
    throw new Error('决策/坑必须能自证：加 --证据 "<路径>::<片段>"；确实没有就写 --无证据 "原因"（会记进 frontmatter，体检按已交代算）')
  }
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  const fm = ['---', 'title: ' + title]
  if (descGiven) fm.push('description: ' + descGiven.slice(0, 200))
  fm.push('tags: [' + tags.join(', ') + ']', 'date: ' + date)
  if (ev.length) fm.push('evidence:', ...ev.map(e => '  - ' + e))
  if (noEv) fm.push('no_evidence: ' + noEv)
  fm.push('---')

  // 4. 落盘：<类目>/<日期>-<标题>.md（标题直接进文件名，中文可读）
  const slug = title.replace(SLUG_BAD, '-').replace(/-+/g, '-').replace(/^-\s*/, '').slice(0, 40)
  const file = path.join(mem, cat, date + '-' + slug + '.md')
  const rel = 'memory/' + relPosix(mem, file)
  if (fs.existsSync(file) && !flags.force) throw new Error('目标已存在：' + rel + '（--force 覆盖，或改标题）')
  const text = fm.join('\r\n') + '\r\n\r\n# ' + title + '\r\n\r\n' + inner + '\r\n'
  if (flags.dry) { console.log('[dry] 将写：' + rel + '（' + Buffer.byteLength(text) + ' B）'); return 0 }
  writeAtomic(file, text)

  // 5. 同轮收尾：索引 + 自检；自检不过就说「已写入但没完成」，不说「已记录」
  console.log('✓ 已写入：' + rel + '（' + Buffer.byteLength(text) + ' B）')
  if (Buffer.byteLength(text) > 2048) console.log('⚠ 超 2 KB：写的是过程不是结论？压到 ≤10 行更有人读')
  if (!ev.length && noEv) console.log('· 已记「无证据」原因：' + noEv)
  cmdIndex(root, true)
  if (cmdCheck(root, {}) !== 0) { console.error('✗ 已写入但自检未过 → 按上面的条目修完才算完成'); return 1 }
  return 0
}

// ---------- 体检（一层的总闸门） ----------

/** 证据复核：`路径::片段` 里的文件要在、片段要对得上；只给路径就只查存在 */
function verifyEvidence(root, ref) {
  const i = String(ref).indexOf('::')
  const relPath = i < 0 ? String(ref) : String(ref).slice(0, i)
  const needle = i < 0 ? '' : String(ref).slice(i + 2)
  const abs = path.isAbsolute(relPath) ? relPath : path.join(root, relPath)
  if (!fs.existsSync(abs)) return { ok: false, why: '文件不存在：' + relPath }
  if (needle && !readText(abs).includes(needle)) return { ok: false, why: '文件里找不到「' + needle + '」' }
  return { ok: true }
}

function daysSince(dateStr) {
  const t = new Date(String(dateStr) + 'T00:00:00').getTime()
  if (!t) return -1
  return Math.floor((Date.now() - t) / 86400000)
}

/**
 * 体检：把「结构 / 词表 / 证据 / 召回活性 / 备份 / 体量 / 场景层」一次跑完，一个退出码。
 * 收工、换会话前都跑它；exit 0 才算记忆是健康的。
 */
function cmdDoctor(root, flags) {
  const mem = memoryRoot(root)
  if (!fs.existsSync(mem)) throw new Error('未初始化：缺少 ' + mem + '（先跑 init）')
  const problems = []
  const warns = []
  const lines = []
  const self = fileURLToPath(import.meta.url)

  // 1. 结构：直接复用 check，只取结论（不再写第二套判据）
  const chk = spawnSync(process.execPath, [self, 'check', '--project', root], { encoding: 'utf8' })
  const chkBad = String(chk.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('✗'))
  if (chk.status === 0) lines.push('结构：✓ 通过')
  else { lines.push('结构：✗ ' + chkBad.length + ' 项'); problems.push(...chkBad.slice(0, 3)) }

  // 2. 词表：空词表 = 同义词扩展静默失效（2026-11-12 前就是这样空转了两个月）
  const nLex = Object.keys(loadLexicon(root)).length
  if (!nLex) { lines.push('词表：✗ 空'); problems.push('memory\\_词表.json 是空的：同义词/别称扩展未生效') }
  else lines.push('词表：✓ ' + nLex + ' 组')

  // 3. 证据：分两段判——近 30 天的决策/坑必须能自证（✗），存量只提醒补（⚠）
  const docs = scanDocs(root)
  const withEv = docs.filter(d => (d.evidence || []).length)
  const broken = []
  for (const d of withEv) for (const ref of d.evidence) {
    const r = verifyEvidence(root, ref)
    if (!r.ok) broken.push(d.path + ' → ' + ref + '（' + r.why + '）')
  }
  const MUST_EV = ['decisions', 'pitfalls']
  const evDocs = docs.filter(d => MUST_EV.includes(d.category))
  const freshEv = evDocs.filter(d => daysSince(d.date) <= 30)
  const bare = (d) => !(d.evidence || []).length && !d.noEv
  const freshBare = freshEv.filter(bare)
  const oldBare = evDocs.filter(d => daysSince(d.date) > 30).filter(bare)
  if (broken.length) problems.push('证据失效 ' + broken.length + ' 条：' + broken.slice(0, 3).join('；'))
  if (freshBare.length) problems.push('近 30 天的决策/坑缺证据 ' + freshBare.length + ' 篇：' + freshBare.slice(0, 3).map(d => d.path).join('、') + '（补 --证据，或写 no_evidence 说明）')
  if (oldBare.length) warns.push('存量 ' + oldBare.length + ' 篇决策/坑没有 evidence：有空补，不阻断')
  lines.push('证据：' + (withEv.length ? withEv.length + '/' + docs.length + ' 篇有声明' : '0 篇声明')
    + (broken.length ? ' · ✗ ' + broken.length + ' 条失效' : ' ✓'))
  if (freshEv.length) lines.push('证据：近 30 天决策/坑 ' + freshEv.length + ' 篇 · 缺证 ' + freshBare.length + ' 篇')
  if (!withEv.length && docs.length) warns.push('没有任何记忆写 evidence：内容漂移发现不了（新记录请带 --证据）')

  // 4. 召回活性：流水在不在、是不是早就没人读了
  const logFile = path.join(mem, '_召回.log')
  if (!fs.existsSync(logFile)) warns.push('召回从未被调用（没有 _召回.log）')
  else {
    const last = readText(logFile).trim().split(/\r?\n/).filter(Boolean).pop() || ''
    const day = (last.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1]
    const age = day ? daysSince(day) : -1
    lines.push('召回：' + (age >= 0 ? '最近 ' + age + ' 天前' : '有流水但读不出日期'))
    if (age > 30) warns.push('召回 ' + age + ' 天没用过：记忆可能已经没人读')
  }

  // 5. 备份：记忆不进库，就只能靠自己备份
  const bkRoot = path.join(root, '.memory-backup')
  const bks = fs.existsSync(bkRoot) ? fs.readdirSync(bkRoot).filter(x => /^memory-\d{8}-\d{6}$/.test(x)).sort() : []
  if (!bks.length) warns.push('从未备份过 memory\\（跑 备份）')
  else {
    const newest = bks[bks.length - 1]
    const age = daysSince(newest.slice(14, 18) + '-' + newest.slice(18, 20) + '-' + newest.slice(20, 22))
    lines.push('备份：' + newest + '（共 ' + bks.length + ' 份' + (age >= 0 ? '，最近 ' + age + ' 天前' : '') + '）')
    if (age > 30) warns.push('最近备份已 ' + age + ' 天：先跑 备份')
  }

  // 6. 体量：单篇超 12 KB 基本没人读
  const big = docs.filter(d => d.size > 12288)
  const total = docs.reduce((s, d) => s + d.size, 0)
  lines.push('体量：' + docs.length + ' 篇 · ' + (total / 1024).toFixed(1) + ' KB')
  if (big.length) warns.push(big.length + ' 篇超 12 KB：' + big.slice(0, 2).map(d => d.path).join('、'))

  // 7. 新鲜度（2026-11-13 加）：记忆很久没动、之后又攒了多次提交 ⇒ 大概率「改完代码没写回」。
  //    判据必须同时满足「≥3 次提交」与「>3 天」，否则「先写记忆、后提交」这种正常顺序都会误报
  //    （第一版只看时间先后，上线当天就误报了 1 次）。
  {
    const newest = docs.reduce((a, d) => (!a || d.mtimeMs > a.mtimeMs ? d : a), null)
    const git = (args) => {
      const g = spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8' })
      return g.status === 0 ? String(g.stdout || '').trim() : ''
    }
    const ts = Number(git(['log', '-1', '--format=%ct'])) * 1000
    if (!ts || !newest) lines.push('新鲜度：跳过（不是 git 仓或没有记忆）')
    else {
      const since = Math.floor(newest.mtimeMs / 1000)
      const n = Number(git(['rev-list', '--count', '--since', String(since), 'HEAD']) || 0)
      const stale = ts - newest.mtimeMs > 3 * 86400000
      if (n >= 3 && stale) {
        lines.push('新鲜度：⚠ 记忆 ' + Math.round((ts - newest.mtimeMs) / 86400000) + ' 天没动，之后有 ' + n + ' 次提交')
        warns.push('最新记忆（memory/' + newest.path + '）已 ' + Math.round((ts - newest.mtimeMs) / 86400000)
          + ' 天没更新，之后又提交了 ' + n + ' 次：这轮改了代码却没写回？')
      } else lines.push('新鲜度：✓ 记忆不落后（之后 ' + n + ' 次提交，' + (stale ? '超过 3 天但次数不足' : '3 天内') + '）')
    }
  }

  // 8. 场景层：另一份记忆（§〇 交接）也一起验，别只报一半
  if (!flags.noscene) {
    const tool = path.join(TOOL_DIR, '场景记忆.mjs')
    if (fs.existsSync(tool)) {
      const r = spawnSync(process.execPath, [tool, 'check', '--all'], { encoding: 'utf8', cwd: WORKBENCH })
      const bad = String((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(l => l.includes('✗'))
      if (r.status === 0) lines.push('场景记忆：✓ 全通过')
      else { lines.push('场景记忆：✗ ' + bad.length + ' 项'); problems.push(...bad.slice(0, 3).map(s => s.trim())) }
    } else warns.push('找不到 场景记忆.mjs：场景层未体检')
  }

  // 9. 结论：问题数决定退出码，提醒不影响
  console.log('[体检] ' + path.basename(root) + ' · ' + new Date().toLocaleString('zh-CN', { hour12: false }))
  lines.forEach(l => console.log('· ' + l))
  problems.forEach(p => console.log('✗ ' + p))
  warns.forEach(w => console.log('⚠ ' + w))
  if (problems.length) { console.log('结论：✗ ' + problems.length + ' 个问题（修完再收工）'); return 1 }
  console.log('结论：✓ 健康' + (warns.length ? '（' + warns.length + ' 条提醒）' : ''))
  return 0
}

// ---------- 备份 ----------

function ensureIgnoreLine(root, lines) {
  const file = path.join(root, '.gitignore')
  const cur = readText(file)
  const have = cur.split(/\r?\n/).map(s => s.trim())
  const miss = lines.filter(l => !have.includes(l))
  if (!miss.length) return []
  writeAtomic(file, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + miss.join('\n') + '\n')
  return miss
}

function countFiles(dir) {
  let n = 0; let b = 0
  const walk2 = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, it.name)
      if (it.isDirectory()) walk2(full)
      else { n++; b += fs.statSync(full).size }
    }
  }
  walk2(dir)
  return { n, b }
}

/**
 * 备份：memory\ 不在 git 里（公开仓不能带本机路径），所以必须有独立的本地副本。
 *   node 记忆.mjs 备份 --project <根> [--to <目录>] [--keep 10]
 */
function cmdBackup(root, flags) {
  // 1. 目标目录：默认 <根>\.memory-backup\memory-YYYYMMDD-HHmmss（已在 .gitignore）
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  const bkRoot = path.join(root, '.memory-backup')
  const to = flags.to ? path.resolve(flags.to) : path.join(bkRoot, 'memory-' + stamp)
  const mem = memoryRoot(root)
  if (!fs.existsSync(mem)) throw new Error('未初始化：缺少 ' + mem + '（先跑 init）')

  // 2. 两份一起备：项目 memory\ + 场景记忆\（后者已入库，仍备一份方便整机迁移；
  //    只在本工作台仓内顺带备，别把别人的场景记忆塞进无关项目）
  fs.mkdirSync(to, { recursive: true })
  fs.cpSync(mem, path.join(to, 'memory'), { recursive: true })
  const scene = path.join(WORKBENCH, '引擎数据', '.dsh', '场景记忆')
  const withScene = root.toLowerCase().startsWith(WORKBENCH.toLowerCase()) && fs.existsSync(scene)
  if (withScene) fs.cpSync(scene, path.join(to, '场景记忆'), { recursive: true })
  const added = flags.to ? [] : ensureIgnoreLine(root, ['.memory-backup/'])

  // 3. 只留最近 N 份（默认 10），删前先把名字打出来
  const keep = Math.max(1, Number(flags.keep || 10))
  const olds = fs.existsSync(bkRoot) ? fs.readdirSync(bkRoot).filter(x => /^memory-\d{8}-\d{6}$/.test(x)).sort() : []
  const drop = olds.slice(0, Math.max(0, olds.length - keep))
  for (const x of drop) { fs.rmSync(path.join(bkRoot, x), { recursive: true, force: true }); console.log('· 清理旧备份：' + x) }

  // 4. 报数
  const c = countFiles(to)
  console.log('✓ 已备份：' + to + '（' + c.n + ' 个文件 · ' + (c.b / 1024).toFixed(1) + ' KB'
    + (withScene ? ' · 含场景记忆' : '') + '）')
  if (added.length) console.log('· .gitignore 补 ' + added.join('、'))
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
    case '写': case 'write': return cmdWrite(requireProject(flags), flags)
    case '体检': case 'doctor': return cmdDoctor(requireProject(flags), flags)
    case '备份': case 'backup': return cmdBackup(requireProject(flags), flags)
    default:
      console.error('用法：node 工具\\记忆.mjs <init|index|recall|card|check|写|体检|备份|migrate> --project <根> [参数]')
      return 2
  }
}

try {
  process.exitCode = main()
} catch (e) {
  console.error('✗ ' + (e && e.message ? e.message : e))
  process.exitCode = 1
}
