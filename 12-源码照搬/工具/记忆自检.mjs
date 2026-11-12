#!/usr/bin/env node
// 记忆自检.mjs — `记忆.mjs` 的零依赖自检：只在系统临时目录里造样本，不碰真实项目。
// 运行：node 工具\记忆自检.mjs
// 覆盖：init/index/recall/card/check/migrate + 默认忽略规则 + 破坏性场景。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const TOOL = path.join(TOOL_DIR, '记忆.mjs')
const CATS = ['architecture', 'interfaces', 'runbooks', 'pitfalls', 'decisions', 'function_realize', 'sql-log', 'handoffs', 'archive']

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; return }
  fail++
  console.log('✗ ' + name + (detail ? ' — ' + detail : ''))
}
function run(args, cwd) {
  const r = spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8', cwd })
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}
function read(file) { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
function doc(title, desc, body) {
  return '---\ntitle: ' + title + '\ndescription: ' + desc + '\n---\n\n# ' + title + '\n\n' + body + '\n'
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
const mem = path.join(root, 'memory')
const cardPath = path.join(root, 'thin-card.md')

// 1. init：骨架、默认忽略、幂等
let r = run(['init', '--project', root])
ok('init 退出 0', r.code === 0, r.out)
ok('MEMORY_INDEX 存在', fs.existsSync(path.join(mem, 'MEMORY_INDEX.md')))
ok('九类 README 齐全', CATS.every(c => fs.existsSync(path.join(mem, c, 'README.md'))))
ok('_索引.json 存在', fs.existsSync(path.join(mem, '_索引.json')))
const gi1 = read(path.join(root, '.gitignore'))
ok('默认忽略 memory/', /^memory\/$/m.test(gi1))
ok('默认忽略 AGENTS.md', /^AGENTS\.md$/m.test(gi1))

r = run(['init', '--project', root])
ok('重复 init 幂等', r.code === 0 && read(path.join(root, '.gitignore')).split(/\r?\n/).filter(x => x === 'memory/').length === 1, r.out)

const dryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-dry-'))
r = run(['init', '--project', dryRoot, '--dry'])
ok('init --dry 不落盘', r.code === 0 && !fs.existsSync(path.join(dryRoot, 'memory')))

const trackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-track-'))
r = run(['init', '--project', trackRoot, '--track'])
ok('init --track 不写 .gitignore', r.code === 0 && !fs.existsSync(path.join(trackRoot, '.gitignore')))

// 2. index / recall
write(path.join(mem, 'pitfalls', '2026-11-11-窗口等级不能按时段判断.md'),
  doc('窗口等级不能按时段判断', '等级来自约束日历，不是时段字段。', '## 现象\n按时段筛等级，结果为空。\n\n## 原因\n等级由 constraint_calendar 生成。'))
write(path.join(mem, 'decisions', '2026-11-11-记忆根定稿.md'),
  doc('记忆根定稿', '统一放项目根 memory 目录，默认不入库。', '## 结论\nmemory/ 默认 ignore。'))
r = run(['index', '--project', root])
ok('index 退出 0', r.code === 0, r.out)
const idx = JSON.parse(read(path.join(mem, '_索引.json')))
ok('索引登记两篇', idx.docs.length === 2, JSON.stringify(idx.docs.map(d => d.path)))
ok('索引带标题与类目', idx.docs.every(d => d.title && d.category))

r = run(['recall', '--project', root, '窗口等级'])
ok('recall 命中正确文件', r.code === 0 && r.out.includes('pitfalls/'), r.out)
ok('recall 带命中理由', r.out.includes('命中标题'), r.out)
ok('recall 输出 ≤2 KB', Buffer.byteLength(r.out, 'utf8') <= 2048, String(Buffer.byteLength(r.out, 'utf8')))

r = run(['recall', '--project', root, '不存在的词'])
ok('空命中不报错且提示读代码', r.code === 0 && r.out.includes('0/2') && r.out.includes('直接读代码'), r.out)

// 2b. 召回流水 + 低分阈值（2026-11-12 加）
const logFile = path.join(mem, '_召回.log')
ok('recall 写召回流水', fs.existsSync(logFile) && read(logFile).includes('窗口等级'), '缺 memory/_召回.log')
const logCount = () => read(logFile).trim().split(/\r?\n/).filter(Boolean).length
ok('流水一行一条且带命中数', logCount() >= 1 && read(logFile).includes('hit='))
const n1 = logCount()
r = run(['recall', '--project', root, '窗口等级', '--no-log'])
ok('--no-log 不追加流水', logCount() === n1, String(n1) + '→' + String(logCount()))
r = run(['recall', '--project', root, '窗口等级', '--json'])
ok('--json 带阈值与滤掉数', (() => { try { const j = JSON.parse(r.out); return j.threshold === 2 && typeof j.filtered === 'number' } catch { return false } })(), r.out)
write(path.join(mem, 'runbooks', '2026-11-12-低分样本.md'), doc('低分样本', '只用于阈值测试。', '偶发一词。'))
r = run(['index', '--project', root])
r = run(['recall', '--project', root, '偶发'])
ok('低分命中被阈值滤掉', r.code === 0 && (r.out.includes('滤掉') || r.out.includes('没有够格的命中')), r.out)

// 3. card：生成、限长、保留手写区
r = run(['card', '--project', root, '--card', cardPath])
ok('card 生成', r.code === 0 && fs.existsSync(cardPath), r.out)
let card = read(cardPath)
ok('card 有 AUTO 标记', card.includes('<!-- AUTO:BEGIN -->') && card.includes('<!-- AUTO:END -->'))
ok('card ≤1.8 KB', Buffer.byteLength(card, 'utf8') <= 1800)
ok('card 含最近 5 条与召回命令', card.includes('最近 5 条') && card.includes('recall --project'))
write(cardPath, card.replace('## 当前状态（手写，≤3 行）', '## 当前状态（手写，≤3 行）\n- 状态A'))
r = run(['card', '--project', root, '--card', cardPath])
ok('card 刷新保留手写区', r.code === 0 && read(cardPath).includes('状态A'))

// 4. check：通过 / 索引过期 / 重复标题 / 缺索引 / 坏 JSON
r = run(['check', '--project', root, '--card', cardPath])
ok('check 通过', r.code === 0, r.out)

write(path.join(mem, 'pitfalls', '2026-11-12-未索引.md'), doc('未索引的坑', '还没跑索引。', '正文'))
r = run(['check', '--project', root, '--card', cardPath])
ok('未索引 → check 失败', r.code === 1 && r.out.includes('索引过期'), r.out)
run(['index', '--project', root])
r = run(['check', '--project', root, '--card', cardPath])
ok('补索引后 check 通过', r.code === 0, r.out)

write(path.join(mem, 'runbooks', '2026-11-12-重复标题.md'), doc('窗口等级不能按时段判断', '同名。', '正文'))
run(['index', '--project', root])
r = run(['check', '--project', root, '--card', cardPath])
ok('重复标题 → check 失败', r.code === 1 && r.out.includes('重复标题'), r.out)
fs.rmSync(path.join(mem, 'runbooks', '2026-11-12-重复标题.md'))
run(['index', '--project', root])

const mi = path.join(mem, 'MEMORY_INDEX.md')
const miBak = read(mi)
fs.rmSync(mi)
r = run(['check', '--project', root, '--card', cardPath])
ok('缺 MEMORY_INDEX → check 失败', r.code === 1 && r.out.includes('MEMORY_INDEX.md'), r.out)
write(mi, miBak)

write(path.join(mem, '_索引.json'), '{坏 JSON')
r = run(['check', '--project', root, '--card', cardPath])
ok('坏索引 → check 失败', r.code === 1 && r.out.includes('JSON 解析失败'), r.out)
run(['index', '--project', root])
r = run(['check', '--project', root, '--card', cardPath])
ok('重建索引后 check 通过', r.code === 0, r.out)

// 5. 旧薄卡无 AUTO：默认拒绝，--force 覆盖
const legacy = path.join(root, 'legacy-card.md')
write(legacy, '# 旧摘要\n\n一大段旧内容\n')
r = run(['card', '--project', root, '--card', legacy])
ok('无 AUTO 标记默认拒绝', r.code === 1 && r.out.includes('AUTO'), r.out)
r = run(['card', '--project', root, '--card', legacy, '--force'])
ok('--force 可覆盖旧摘要', r.code === 0 && read(legacy).includes('<!-- AUTO:BEGIN -->'), r.out)

// 6. migrate：只出清单、不落盘
const mn = path.join(root, '.mnemon')
write(path.join(mn, 'documents', 'index.json'), JSON.stringify({
  documents: [
    { title: '窗口等级定稿', description: '定稿口径', createdAt: '2026-11-01T00:00:00Z', relativePath: 'documents/active/a.md' },
    { title: '启动失败排障', description: '端口冲突', createdAt: '2026-11-02T00:00:00Z', relativePath: 'documents/active/b.md' }
  ]
}))
write(path.join(mn, 'documents', 'active', 'a.md'), '# 窗口等级定稿\n')
write(path.join(mn, 'documents', 'active', 'b.md'), '# 启动失败排障\n')
r = run(['migrate', '--from', mn])
ok('migrate 出清单', r.code === 0 && r.out.includes('迁移建议') && r.out.includes('decisions'), r.out)
ok('migrate 不落盘', !fs.existsSync(path.join(root, 'memory', 'archive', 'a.md')))

// 7. 写 / 体检 / 备份：一次写完就该是「索引新 + 自检过」，且证据可复核
const draft = path.join(root, 'draft.md')
write(draft, '# 草稿\n\n## 现象\n按钮点了没反应。\n')
r = run(['写', '--project', root, '--类', 'pitfalls', '--标题', '写回冒烟', '--正文', draft, '--证据', 'draft.md::按钮点了没反应'])
ok('写 成功并落盘', r.code === 0 && r.out.includes('memory/pitfalls/'), r.out)
const wrote = fs.readdirSync(path.join(mem, 'pitfalls')).filter(f => f.endsWith('写回冒烟.md'))
ok('写 文件名是「日期-标题」', wrote.length === 1 && /^\d{4}-\d{2}-\d{2}-/.test(wrote[0]), wrote.join('、'))
ok('写 的 frontmatter 带 evidence', read(path.join(mem, 'pitfalls', wrote[0])).includes('evidence:'))
r = run(['check', '--project', root, '--card', cardPath])
ok('写 后 check 直接通过（不用再手动 index）', r.code === 0, r.out)

r = run(['写', '--project', root, '--类', 'pitfalls', '--标题', '写回冒烟', '--要点', '重复'])
ok('同名标题被拒', r.code === 1 && r.out.includes('同名记忆已存在'), r.out)
r = run(['写', '--project', root, '--类', '瞎写', '--标题', 'x', '--要点', 'y'])
ok('非法类目被拒', r.code === 1 && r.out.includes('必须是'), r.out)

write(path.join(mem, '_词表.json'), JSON.stringify({ 换会话: ['交接'] }))
r = run(['体检', '--project', root, '--noscene'])
ok('体检 通过', r.code === 0 && r.out.includes('结论：✓'), r.out)
ok('体检 提示没备份', r.out.includes('从未备份'), r.out)

// 证据失效 → 体检必须失败（这是「记忆漂移」的唯一自动发现手段）
const badDoc = path.join(mem, 'pitfalls', '坏证据.md')
write(badDoc, '---\ntitle: 坏证据\ndescription: 指向不存在的片段\nevidence:\n  - draft.md::根本没有这句话\n---\n\n# 坏证据\n\n正文\n')
run(['index', '--project', root])
r = run(['体检', '--project', root, '--noscene'])
ok('证据失效 → 体检失败', r.code === 1 && r.out.includes('证据失效'), r.out)
fs.rmSync(badDoc)
run(['index', '--project', root])

// 空词表 → check 与体检都要报（这是 2026-11-12 前的真实故障）
write(path.join(mem, '_词表.json'), '{}')
r = run(['check', '--project', root, '--card', cardPath])
ok('空词表 → check 告警', r.out.includes('词表.json 为空'), r.out)
r = run(['体检', '--project', root, '--noscene'])
ok('空词表 → 体检失败', r.code === 1 && r.out.includes('词表'), r.out)
write(path.join(mem, '_词表.json'), JSON.stringify({ 换会话: ['交接'] }))
run(['index', '--project', root])

// 备份：目录生成 + 自动写 ignore + 只留最近 N 份
r = run(['备份', '--project', root, '--keep', '2'])
const bkRoot = path.join(root, '.memory-backup')
const newestBk = fs.readdirSync(bkRoot).filter(x => /^memory-\d{8}-\d{6}$/.test(x)).sort().pop() || ''
ok('备份 退出 0 且生成目录', r.code === 0 && !!newestBk, r.out)
ok('备份 含正文副本', fs.existsSync(path.join(bkRoot, newestBk, 'memory', 'pitfalls')), fs.readdirSync(path.join(bkRoot, newestBk)).join('、'))
ok('备份 自动补 .gitignore', read(path.join(root, '.gitignore')).includes('.memory-backup/'))
for (const t of ['memory-20260101-000000', 'memory-20260102-000000', 'memory-20260103-000000']) fs.mkdirSync(path.join(bkRoot, t), { recursive: true })
r = run(['备份', '--project', root, '--keep', '2'])
ok('备份 只留最近 2 份', fs.readdirSync(bkRoot).filter(x => /^memory-\d{8}-\d{6}$/.test(x)).length === 2, r.out)

// 8. 清理
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(dryRoot, { recursive: true, force: true })
fs.rmSync(trackRoot, { recursive: true, force: true })

console.log('记忆自检：' + pass + ' 项通过，' + fail + ' 项失败')
process.exitCode = fail ? 1 : 0
