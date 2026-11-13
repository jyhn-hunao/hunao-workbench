#!/usr/bin/env node
/**
 * 场景记忆 v2 · 统一工具（2026-10-27 核心机制；例外场景清单＝工具同目录 `场景记忆-例外.json`）
 *
 * 每个场景的记忆文件夹固定四类：
 *   <场景>\
 *     场景私有记忆.md   ← 人写（交接 §〇 四小节 / 职责 / 决策 / 项目索引）
 *     身份卡.md         ← 工具写（身份/权限/定位卡指纹）⛔ 手改即校验失败
 *     场景画像.md       ← 工具写（布局/面板/渲染器/依赖）
 *     项目记忆\ + 归档\ + _文件索引.md
 *
 * 用法：
 *   node 场景记忆.mjs list                       # 一览：三文档/归档/项目记忆 缺什么
 *   node 场景记忆.mjs init    --场景 刷抖音       # 建目录骨架 + 三文档（已存在不覆盖）
 *   node 场景记忆.mjs stamp   --场景 刷抖音       # 重生成 身份卡 + 场景画像
 *   node 场景记忆.mjs 交接    --场景 刷抖音       # 归档旧版 + 补 §〇 四小节 + stamp + 登记索引
 *   node 场景记忆.mjs 读      --场景 刷抖音 [--节 §〇]  # 只打印某一节（默认 §〇，约 2-4 KB，别整读 25 KB）
 *   node 场景记忆.mjs check   --场景 刷抖音       # 结构/指纹/§〇/项目/归档/分条 全检（--all 全场景）
 *   node 场景记忆.mjs 写      --场景 刷抖音 --类 决策|坑|通知 --标题 "…" [--正文 <md>|--要点 "a|b|c"] [--证据 "路径::片段"]
 *                              # 一条一个文件：自动 frontmatter + 登记索引 + 同轮 check
 *                              # 拿不准加 --不确定 "要问用户的疑问" ⇒ 进 _待确认.md，不生效；用户点头后 确认 --序号 N
 *                              # 和已有条目像但不是一回事：--不是同一条 "词：区别" ⇒ 写进 distinct，联想层不再用该词连边
 *                              # 取代/过期/逻辑多归属：--取代 "<场景>/<类>/<日期>-<标题>.md" --过期 YYYY-MM-DD --相关 <场景id,…>
 *   node 场景记忆.mjs 待确认  --场景 刷抖音       # 列出 _待确认.md 队列（编号用于 确认）
 *   node 场景记忆.mjs 确认    --场景 刷抖音 --序号 N [--放弃]  # 转正 / 丢掉一条待确认
 *   node 场景记忆.mjs 收工    --场景 刷抖音       # 索引 + 近期记忆 + 沉淀定论 + check + 待确认计数（exit 0 才算收工）
 *   node 场景记忆.mjs 拆      --场景 刷抖音 [--dry]   # 把 §五 存量条目拆成 决策\/坑\ 分条，原文整份进 归档\
 *   node 场景记忆.mjs 整理    --场景 刷抖音 [--days 180] [--dry]  # 旧条目搬 归档\（被 定论/证据 引用的不搬，--强搬 强制），§五 下标重算
 *   node 场景记忆.mjs 召回    --场景 刷抖音 --词 "关键词" [--条 8] [--含归档]  # 场景级检索；归档条目默认不召回，--含归档 按 ×0.3 降权并标注
 *
 * --场景 可传目录名（刷抖音）或场景 id（douyin）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

// 公开模板：根 = --root 参数 > 脚本所在目录的上一级；记忆在 <根>\引擎数据\.dsh\场景记忆
import { fileURLToPath as __f2u } from 'node:url'
const __HERE = path.dirname(__f2u(import.meta.url))
const __ARGV_ROOT = (() => { const i = process.argv.indexOf('--root'); return i >= 0 ? process.argv[i + 1] : '' })()
const WORKBENCH_ROOT = __ARGV_ROOT || process.env.DSH_WORKBENCH_ROOT || path.resolve(__HERE, '..')
const MEMROOT = process.env.DSH_SCENE_MEMORY || path.join(WORKBENCH_ROOT, '引擎数据', '.dsh', '场景记忆')
// 场景目录（派生清单，2026-11-13）：神经元不再靠手工登记表 索引.json，也不用目录扫描 IPC
const SCENE_REG = path.join(MEMROOT, '_共享记忆', '场景目录.json')
// 记忆数据契约版本（2026-11-13）：schema.json 由 工具\记忆打包.mjs 升版 维护；check --all 校验，换机/升级时判「老数据 vs 新工具」
const MEM_SCHEMA_VERSION = 2
const MEM_SCHEMA_FILE = path.join(MEMROOT, '_共享记忆', 'schema.json')
// 公开模板：不写审计日志
function audit() {}
const GUI = process.env.DSH_GUI_DIR || path.join(WORKBENCH_ROOT, '外壳')
const SCEN = path.join(GUI, 'scenarios')
const IDX = path.join(SCEN, '_场景身份索引.md')
const NOW = () => new Date()
const stamp = () => { const d = NOW(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }; // 本地时间（原来是 UTC）
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '')

const ALIAS = {
  'bilibili': 'B站', 'pc-cleanup': '本地电脑', 'personal-site': '<个人站场景>',
  'stock-analysis': '<机主>的分析助手', 'code-dev': '程序开发', 'design-misc': '设计杂活',
  'video-workflow': '视频工作流', 'self-review': '自我复盘', 'douyin': '刷抖音', 'command': '命令',
  'workbench-custom': '工作台定制', 'dsh-gui': null,
}

/* ------------------------------------------------------------ 读两个事实源 */

function readScenes() {
  const out = []
  for (const f of fs.existsSync(SCEN) ? fs.readdirSync(SCEN) : []) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'))
      if (j && j.id && Array.isArray(j.panels)) out.push(j)
    } catch { /* 跳过坏 json */ }
  }
  return out
}

/** 解析 `_场景身份索引.md` §二 表：场景id → {panel,title,session,sessionId,card,skill} */
function readIdentity() {
  const map = new Map()
  if (!fs.existsSync(IDX)) return map
  for (const line of fs.readFileSync(IDX, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const c = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim().replace(/`/g, ''))
    if (c.length < 7) continue
    const id = c[0]
    if (!/^[a-z0-9-]+$/.test(id)) continue
    const cardRel = (c[5] || '').replace(/^scenarios\\/, '')
    map.set(id, {
      id, panel: c[1], title: c[2], session: c[3], sessionId: c[4],
      card: cardRel ? path.join(SCEN, cardRel) : '',
      skill: c[6] || '',
    })
  }
  return map
}

/** 目录名 ↔ 场景 json */
function findSceneDir(arg) {
  const dirs = fs.existsSync(MEMROOT) ? fs.readdirSync(MEMROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name) : []
  if (dirs.includes(arg)) return arg
  const alias = ALIAS[arg]
  if (alias && dirs.includes(alias)) return alias
  const scenes = readScenes()
  const byId = scenes.find((s) => s.id === arg)
  if (byId && dirs.includes(byId.name)) return byId.name
  return null
}

function sceneOf(dirName) {
  const scenes = readScenes()
  const SUB = { '视频全工作流': 'video-workflow' }   // 画布子项：无独立 json，用父场景 json
  return scenes.find((s) => s.name === dirName)
    || scenes.find((s) => s.id === dirName)
    || scenes.find((s) => (s.name || '').toLowerCase() === String(dirName).toLowerCase())
    || (SUB[dirName] ? scenes.find((s) => s.id === SUB[dirName]) : null)
    || null
}

/* ----------------------------------------------------- 记忆 v2 例外（集中清单） */
// 2026-10-27（命令台 cmd-chat 报）：例外场景没有 `引擎\场景记忆\<场景>\` ⇒ 以前 check 直接 ENOENT 抛错，
// 收工闸形同虚设。现在例外清单**只有一份**：工具同目录的 `场景记忆-例外.json`（别在代码里散落）。
const TOOL_DIR = path.dirname(path.resolve(process.argv[1] || '<工作台>\\工具\\场景记忆.mjs'))
// 2026-11-12 修：`记忆库.mjs` 是私有版才有的组件，公开版模板里没有；
// 以前交接末尾直接引用未定义的 __MEMLIB_OK ⇒ 每次交接都抛 ReferenceError，被 catch 成「记忆库入库异常」。
const MEMLIB_FILE = path.join(TOOL_DIR, '记忆库.mjs')
const __MEMLIB_OK = fs.existsSync(MEMLIB_FILE)
const EXCEPTION_FILE = path.join(TOOL_DIR, '场景记忆-例外.json')
let _exceptions = null
function readExceptions() {
  if (_exceptions) return _exceptions
  const map = new Map()
  try {
    const j = JSON.parse(fs.readFileSync(EXCEPTION_FILE, 'utf8'))
    for (const [id, ex] of Object.entries((j && j.scenes) || {})) map.set(String(id), { id, ...ex })
  } catch (e) {
    if (fs.existsSync(EXCEPTION_FILE)) console.error('⚠ 例外清单读不动（' + EXCEPTION_FILE + '）：' + e.message + ' ⇒ 按"没有例外"处理')
  }
  _exceptions = map
  return map
}
/** arg 可以是场景 id / 目录名 / 面板 id / 场景标题 / 别名；命中返回例外条目。 */
function exceptionOf(arg) {
  if (!arg) return null
  const a = String(arg).trim()
  return [...readExceptions().values()].find((ex) =>
    ex.id === a || (ex.panels || []).includes(a) || ex.title === a || (ex.aliasNames || []).includes(a)) || null
}
/** §〇 字节数（与 cmdCheck 同口径：从 §〇 标题到下一个同级标题）。 */
function sec0Bytes(txt) {
  const h = txt.search(/^## (?:§〇|〇、|§0)/m)
  if (h < 0) return -1
  const rest = txt.slice(h)
  const next = rest.indexOf('\n## ', 5)
  return Buffer.byteLength(next >= 0 ? rest.slice(0, next) : rest)
}
/** 例外场景的 check：不按三文档校验，只验它声明的记忆根 + 定位卡。 */
function cmdCheckException(arg, ex) {
  if (ex.handler === 'oa') return cmdCheckOa()
  const problems = []
  const ok = []
  for (const r of ex.roots || []) {
    const p = r.path
    if (!fs.existsSync(p)) { problems.push('缺' + (r.kind === 'dir' ? '目录' : '文件') + ' ' + r.label + '：' + p); continue }
    if (r.kind === 'dir') { ok.push(r.label + '：' + p); continue }
    const b = sec0Bytes(fs.readFileSync(p, 'utf8'))
    if (b < 0) problems.push(r.label + ' 里没有 §〇 段：' + p)
    else if (b > 4096) problems.push(r.label + ' §〇 超 4 KB（' + b + ' B）：' + p)
    else ok.push(r.label + '：§〇 ' + b + ' B')
  }
  const card = ex.card ? path.join(GUI, ex.card) : ''
  if (card) { if (fs.existsSync(card)) ok.push('定位卡在（' + ex.card + '）'); else problems.push('缺定位卡：' + card) }
  console.log(`\n${ex.title || arg}（${ex.id}）：${problems.length ? '✗' : '✓'} 例外 —— 记忆在下面这些位置，跳过 v2 三文档校验`)
  for (const s of ok) console.log('  ✓ ' + s)
  for (const s of problems) console.log('  ✗ ' + s)
  if (ex.why) console.log('  · 依据：' + ex.why)
  console.log('  · 例外清单：' + EXCEPTION_FILE + '（改口径要宿主确认）')
  return problems.length ? 1 : 0
}

/* ---------------------------------------------------------------- 文档生成 */

function bindingBlock(id, ident, dirName, sceneJson) {
  const card = ident && ident.card ? ident.card : ''
  const fp = card ? sha(card) : ''
  const panels = (sceneJson?.panels || []).map((p) => `${p.id}:${p.type}${p.url ? '=' + p.url : p.sessionId ? '(会话)' : ''}`).join(' ｜ ')
  // 一个场景可能挂两块 AI 面板（程序开发：工作区 + 项目）⇒ 每条会话都要写出来，别只留第一块
  const ais = (sceneJson?.panels || []).filter((p) => p.type === 'harness').map((p) => `${p.id} = ${p.sessionId || '(未绑)'}`).join(' ｜ ')
  return `<!-- 场景绑定 BEGIN · 由 场景记忆.mjs 生成，⛔ 手改即校验失败 -->
> **场景** \`${id}\` ｜ **面板** \`${ident?.panel || '?'}\` ｜ **会话** \`${ident?.sessionId || '?'}\`
> **AI 会话** ${ais || '(无)'}
> **定位卡** \`${card ? path.relative('<工作台>', card) : '(缺)'}\` ｜ **卡指纹** \`sha256:${fp ? fp.slice(0, 16) : '(缺)'}…\` ｜ **盖章** ${stamp()}
> **地盘** \`${dirName}\`
> **权限** 只写自己的记忆文件夹与本人资产；⛔ 不改别的场景、不重启引擎、不关 GUI
> **专属技能** ${ident?.skill || '(无)'}
> **面板** ${panels || '(场景 json 里没有 panels)'}
<!-- 场景绑定 END -->`
}

function writeIdentityCard(dir, id, ident, sceneJson) {
  const name = dir
  const txt = `# ${name} · 身份卡（工具生成 · ⛔ 手改即校验失败）

${bindingBlock(id, ident, dir, sceneJson)}

## 怎么用
- 开场第一份读的是**这张卡**：我是谁、在哪个面板、会话是哪条、定位卡是哪张、能碰什么。
- 定位卡或场景 json 改了 ⇒ 立刻跑 \`node <工作台>\\工具\\场景记忆.mjs stamp --场景 ${name}\`，否则 \`场景记忆.mjs check\` 会报指纹过期。
- 本文件由工具全量重写；要补充说明请写进 \`场景私有记忆.md\`，别写这里。
`
  fs.writeFileSync(path.join(dir, '身份卡.md'), txt, 'utf8')
  return txt
}

function writePortrait(dir, id, sceneJson, ident) {
  const p = sceneJson || {}
  const rows = (p.panels || []).map((x) => `| \`${x.id}\` | ${x.title || ''} | \`${x.type}\` | ${x.url ? `\`${x.url}\`` : x.sessionId ? '会话' : ''} | ${x.col ?? ''},${x.row ?? ''} | ${x.w ?? ''}×${x.h ?? ''} |`).join('\n')
  const txt = `# ${dir} · 场景画像（工具生成 · 由场景 json 推导）

> 来源：\`scenarios\\${id}.json\` + \`renderers.js\` + 定位卡 ｜ 生成 ${stamp()}
> 一句话：${p.description || '(json 没写 description)'}

## 一、形态
- 布局 \`${p.layout || '?'}\` ｜ 主题 \`${p.theme || '?'}\` ｜ 列数 ${p.cols ?? '?'}
- 面板数：${(p.panels || []).length}

## 二、面板
| 面板 id | 标题 | 类型 | 内容 | 位置(col,row) | 尺寸 |
|---|---|---|---|---|---|
${rows || '| — | — | — | — | — | — |'}

## 三、运行时
- 绑定会话：\`${ident?.sessionId || '(见身份卡)'}\`
- 钉定：${(p.panels || []).flatMap((x) => x.pinTarget || []).join(' / ') || '(无)'}
- 渲染器：${[...new Set((p.panels || []).map((x) => x.type))].join(' / ') || '(无)'}

## 四、依赖与入口
- 定位卡：${ident?.card ? '`' + path.relative('<工作台>', ident.card) + '`' : '(缺)'}
- 专属技能：${ident?.skill || '(无)'}
- 记忆文件夹：\`${dir}\`

> 本文件由工具推导生成；场景 json 改了就 \`stamp\`。
`
  fs.writeFileSync(path.join(dir, '场景画像.md'), txt, 'utf8')
  return txt
}

const SEC0 = `## §〇 当前交接（≤4 KB，新会话先读这一节）

### 1) 上次交接
- （交接时由工具写入：旧版已归档 \`归档\\<文件名>\`）

### 2) 当前项目
| 项目 | 记忆文件 | 状态 | 下一步 |
|---|---|---|---|
| （暂无） | — | — | — |

### 3) 私有记忆变更
- （本轮改了什么，≤3 行）

### 4) 下一步 / 卡点
- （写给下一任）

`

function ensureSkeleton(dir, name) {
  const main = path.join(dir, '场景私有记忆.md')
  const legacyPrefixed = path.join(dir, name + '场景私有记忆.md')
  const legacyPlain = path.join(dir, '项目信息.md')
  const arch = path.join(dir, '归档')
  fs.mkdirSync(arch, { recursive: true })
  // 收敛内容源（最新修改者为准）；多个名字内容不同 ⇒ 副本进 归档\冲突副本-*，⛔ 绝不直接删正文
  const sizeOf = (p) => { try { return fs.statSync(p).size } catch { return 0 } }
  // 2026-11-12（修「每次交接多一份 24 KB 冲突副本」）：判断兼容副本先看 inode——同一 inode 就是真硬链接，
  //   内容必然跟随正本；只有「独立文件且内容不同」才值得归档，否则重复副本会一直堆进 归档\。
  const inoOf = (p) => { try { return fs.statSync(p).ino } catch { return 0 } }
  const cand = [main, legacyPlain, legacyPrefixed].filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
  // ★ 安全收敛（2026-10-27 事故后加固）：
  //   1) 正本存在且 >200B ⇒ 绝不被别的名字覆盖（哪怕它 mtime 更新、哪怕是 0 字节）
  //   2) 正本缺失/空 ⇒ 从候选里选“最大且非空”的恢复
  //   3) 冲突副本只归档内容确实不同的非空文件
  if (sizeOf(main) <= 200) {
    const best = cand.filter((p) => sizeOf(p) > 200).sort((a, b) => sizeOf(b) - sizeOf(a))[0]
    if (best && best !== main) fs.copyFileSync(best, main)
  }
  for (const p of cand) {
    if (p === main) continue
    try {
      if (inoOf(p) === inoOf(main)) continue   // 同一 inode = 真硬链接，不归档（否则每轮多一份 24 KB 副本）
      if (sizeOf(p) > 200 && sha(p) !== sha(main)) {
        const tag = path.basename(p).replace(/\.md$/, '')
        const bak = path.join(arch, `冲突副本-${tag}-${NOW().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`)
        fs.copyFileSync(p, bak)
      }
    } catch {}
  }
  // ★ 2026-10-27：`项目信息.md` 已淘汰 —— 正文并入 main 后删除，**不再重建**（旧前缀名暂留兼容）
  try { if (fs.existsSync(legacyPlain)) fs.rmSync(legacyPlain, { force: true }) } catch {}
  // 旧前缀名只做兼容硬链接（各场景技能/文档还引用它）：断了就重链，不再另存一份正文
  //   2026-11-12：以前「内容不同就删、缺了才链」，独立副本会先被当冲突副本归档，再被判不同反复删链 ⇒ 垃圾循环。
  try {
    const linked = fs.existsSync(legacyPrefixed) && inoOf(legacyPrefixed) === inoOf(main)
    if (!linked && fs.existsSync(main)) {
      if (fs.existsSync(legacyPrefixed)) fs.rmSync(legacyPrefixed, { force: true })
      fs.linkSync(main, legacyPrefixed)
    }
  } catch {}
  if (!fs.existsSync(main)) {
    fs.writeFileSync(main, `# ${name} · 场景私有记忆

> 身份与形态见 \`身份卡.md\` / \`场景画像.md\`（工具生成，⛔ 手改）
> 规矩：这份记忆只有本场景能改写；别的场景发现错误只能提醒。

${SEC0}## §一 我管什么 / 不管什么

- 管：
- 不管：

## §二 干活入口

- 项目记忆：\`项目记忆\\<项目名>.md\`（当前项目索引表放上面 §〇 第 2 小节）
- 归档：\`归档\\\`
- 索引：\`_文件索引.md\`

## §五 决策与坑（只追加）
`, 'utf8')
  }
  fs.mkdirSync(path.join(dir, '项目记忆'), { recursive: true })
  fs.mkdirSync(path.join(dir, '归档'), { recursive: true })
  const fidx = path.join(dir, '_文件索引.md')
  if (!fs.existsSync(fidx)) {
    fs.writeFileSync(fidx, `# ${name} · 文件索引

> 状态四态：\`活 / 常备 / 留档 / 待清\`

| 文件 / 目录 | 是什么 | 状态 | 复核日期 |
|---|---|---|---|
| \`场景私有记忆.md\` | 场景私有记忆（人写：交接/职责/决策/项目索引） | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`身份卡.md\` | 身份卡（工具生成：身份/权限/定位卡指纹） | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`场景画像.md\` | 场景画像（工具生成：布局/面板/渲染器） | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`项目记忆\\\` | 每个项目一份记忆 | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`归档\\\` | 旧版本快照（只进不改） | 留档 | ${NOW().toISOString().slice(0, 10)} |
`, 'utf8')
  }
}

/* ------------------------------------------------------------------ 命令 */

function cmdStamp(name) {
  const dir = path.join(MEMROOT, name)
  if (!fs.existsSync(dir)) {
    const ex = exceptionOf(name)
    if (ex) {
      console.log(`\n${ex.title || name}（${ex.id}）：例外场景，没有三文档可盖（记忆在 ${(ex.roots || []).map((r) => r.path).join(' / ')}）⇒ stamp 跳过，改定位卡也不用重盖`)
      return 0
    }
  }
  const scene = sceneOf(name)
  const ident = scene ? readIdentity().get(scene.id) : null
  if (!scene) { console.error(`✗ 找不到场景 json（name=${name}），无法生成画像`); return 1 }
  if (!ident) { console.error(`✗ 身份索引 §二 里找不到场景 ${scene.id}`); return 1 }
  writeIdentityCard(dir, scene.id, ident, scene)
  writePortrait(dir, scene.id, scene, ident)
  console.log(`✓ ${name}：身份卡 + 场景画像 已重生成（卡指纹 ${sha(ident.card).slice(0, 12)}…）`)
  audit('stamp', name, { card: sha(ident.card).slice(0, 12) })
  return 0
}

function cmdInit(arg) {
  const name = findSceneDir(arg)
  const ex = !name ? exceptionOf(arg) : null
  if (!name && ex) { console.log(`\n${ex.title || arg}（${ex.id}）：例外场景，按设计不建 引擎\\场景记忆\\ 三文档 ⇒ init 跳过`); return 0 }
  if (!name) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const dir = path.join(MEMROOT, name)
  ensureSkeleton(dir, name)
  console.log(`✓ ${name}：目录骨架就绪（场景私有记忆/身份卡/场景画像/项目记忆/归档/_文件索引）`)
  audit('init', name)
  return cmdStamp(name)
}

function cmdHandover(arg) {
  const name = findSceneDir(arg)
  const ex = !name ? exceptionOf(arg) : null
  if (!name && ex) { console.log(`\n${ex.title || arg}（${ex.id}）：例外场景，没有标准三文档 ⇒ 交接请在它自己的记忆里写（${(ex.roots || []).map((r) => r.path).join(' / ')}）`); return 0 }
  if (!name) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const dir = path.join(MEMROOT, name)
  ensureSkeleton(dir, name)
  const main = path.join(dir, '场景私有记忆.md')
  let body = fs.readFileSync(main, 'utf8')
  const arch = path.join(dir, '归档')
  const sid6 = (readIdentity().get(sceneOf(name)?.id || '')?.sessionId || '').replace('session-', '').slice(0, 6) || 'nosid'
  const file = `场景私有记忆-${stamp().replace(/[-: ]/g, '').slice(0, 12)}-${sid6}.md`
  fs.writeFileSync(path.join(arch, file), body, 'utf8')
  console.log(`✓ 旧版已归档：归档\\${file}（${Buffer.byteLength(body)} B）`)
  // 补 §〇 四小节（缺哪个补哪个）
  const has = (s) => body.includes(s)
  const missing = []
  if (!has('### 1) 上次交接')) missing.push('### 1) 上次交接\n- 旧版已归档 `归档\\' + file + '`\n')
  if (!has('### 2) 当前项目')) missing.push('### 2) 当前项目\n| 项目 | 记忆文件 | 状态 | 下一步 |\n|---|---|---|---|\n| （暂无） | — | — | — |\n')
  if (!has('### 3) 私有记忆变更')) missing.push('### 3) 私有记忆变更\n- \n')
  const pmDir = path.join(main, '..', '项目记忆')
  const archDir = path.join(main, '..', '归档')
  const nProj = fs.existsSync(pmDir) ? fs.readdirSync(pmDir).filter((x) => x.endsWith('.md')).length : 0
  const nArch = fs.existsSync(archDir) ? fs.readdirSync(archDir).filter((x) => x.endsWith('.md')).length : 0
  if (!has('### 5) 全貌')) missing.push('### 5) 全貌（自动生成，别手改）\n- 项目记忆 ' + nProj + ' 个 · 归档 ' + nArch + ' 份 · 索引 _文件索引.md\n- 身份卡 / 场景画像 / 共享层 areas 已就位；全貌细节看 核职责 + §一 + §二\n- 卡点 / 等谁：见第 4 节\n')
  if (!has('### 4) 下一步 / 卡点')) missing.push('### 4) 下一步 / 卡点\n- \n')
  if (missing.length) {
    const h = body.indexOf('## §〇')
    if (h >= 0) {
      const lineEnd = body.indexOf('\n', h)
      const at = lineEnd >= 0 ? lineEnd + 1 : body.length
      body = body.slice(0, at) + '\n' + missing.join('\n') + body.slice(at)
    } else {
      body = '# 场景私有记忆\n\n## §〇 当前交接（≤4 KB）\n\n' + missing.join('\n') + '\n' + body
    }
    fs.writeFileSync(main, body, 'utf8')
  }
  console.log('✓ ' + name + '：§〇 四小节已补 ' + missing.length + ' 处 · 索引已登记')
  // 索引登记
  const fidx = path.join(dir, '_文件索引.md')
  if (fs.existsSync(fidx)) fs.appendFileSync(fidx, `| \`归档\\${file}\` | 交接前快照（只进不改） | 留档 | ${NOW().toISOString().slice(0, 10)} |\n`, 'utf8')
  audit('handover', name, { archive: file })
  cmdStamp(name)
  // 2026-10-28（宿主定）：「写入即索引」——交接完顺手把各场景 §〇 灌进记忆库（记了就能搜；失败不影响交接）
  // 2026-11-12：公开版没有 记忆库.mjs，直接跳过并说清楚，别再假装「已入库」
  if (!__MEMLIB_OK) {
    console.log('· 记忆库未安装（公开版模板）：跳过入库，交接本身已完成')
    return 0
  }
  try {
    const r = spawnSync(process.execPath, [MEMLIB_FILE, '--import'], { encoding: 'utf8', windowsHide: true, timeout: 180000 })
    const last = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-1)[0] || ''
    console.log(r.status === 0 ? `✓ 记忆库已入库（写入即索引）：${last}` : `⚠ 记忆库入库失败（不影响交接，exit=${r.status}）`)
  } catch (e) {
    console.log('⚠ 记忆库入库异常（不影响交接）：' + String((e && e.message) || e).slice(0, 120))
  }
  return 0
}

/** <客户> OA：§2.4 例外，记忆是 E 盘目录里的多份文档，不按 `<场景>\场景私有记忆.md` 检查。 */
function cmdCheckOa() {
  const dir = '<盘根>:\\工作\\工程文件\\<客户>教育oa\\项目信息'
  const problems = []
  const ok = []
  for (const f of ['README.md', '31_会话接手锚点.md', '项目记忆-langchen-oa.md']) {
    if (fs.existsSync(path.join(dir, f))) ok.push(f)
    else problems.push('缺文件 ' + f)
  }
  const anchorPath = path.join(dir, '31_会话接手锚点.md')
  const anchor = fs.existsSync(anchorPath) ? fs.readFileSync(anchorPath, 'utf8') : ''
  if (!anchor) {
    problems.push('31_会话接手锚点.md 读不到')
  } else {
    const h = anchor.search(/^## (?:§〇|〇、)/m)
    if (h < 0) {
      problems.push('31 里没有 §〇/〇、当前交接 段')
    } else {
      const rest = anchor.slice(h)
      const next = rest.indexOf('\n## ', 5)
      const sec = next >= 0 ? rest.slice(0, next) : rest
      const bytes = Buffer.byteLength(sec)
      if (bytes > 4096) problems.push('§〇 超 4 KB（' + bytes + ' B）')
      else ok.push('§〇 ' + bytes + ' B')
    }
    const ci = anchor.search(/^## 核心职责/m)
    if (ci < 0) problems.push('31 里没有 ## 核心职责')
    else {
      const rest = anchor.slice(ci)
      const next = rest.indexOf('\n## ', 5)
      const sec = next >= 0 ? rest.slice(0, next) : rest
      const n = (sec.match(/^- /gm) || []).length
      if (n < 3) problems.push('核心职责只有 ' + n + ' 条（至少 3 条）')
      else ok.push('核心职责 ' + n + ' 条')
    }
  }
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(MEMROOT, '_共享记忆', '项目.json'), 'utf8'))
    const p = (pj.projects || []).find((x) => x.id === 'langchen-oa')
    const want = path.join(dir, '项目记忆-langchen-oa.md')
    if (!p) problems.push('项目.json 里没有 langchen-oa')
    else if (path.resolve(p.memory || '') !== path.resolve(want)) problems.push('项目.json memory 没指向 OA 项目记忆')
    else ok.push('项目.json 路由一致')
  } catch (e) {
    problems.push('项目.json 读不到：' + e.message)
  }
  console.log(`\n<客户> OA（oa-ops）：${problems.length ? '✗' : '✓'} OA 例外（E 盘自有布局）`)
  for (const s of ok) console.log('  ✓ ' + s)
  for (const s of problems) console.log('  ✗ ' + s)
  return problems.length ? 1 : 0
}

function cmdCheck(name) {
  const dir = path.join(MEMROOT, name)
  // 例外场景（清单见 场景记忆-例外.json）：没有标准目录时给明确状态，**不再 ENOENT 抛错**
  if (!fs.existsSync(dir)) {
    const ex = exceptionOf(name) || exceptionOf((sceneOf(name) || {}).id)
    if (ex) return cmdCheckException(name, ex)
    console.log(`\n${name}：✗ 没有这个场景目录（${dir}）；若不是例外场景就先 init，若是就登记到 ${EXCEPTION_FILE}`)
    return 1
  }
  const scene = sceneOf(name)
  const ident = scene ? readIdentity().get(scene.id) : null
  const problems = []
  const warns = []
  const ok = []
  // 会话库与场景记忆同级：MEMROOT = <dshHome>\场景记忆 ⇒ 会话在 <dshHome>\sessions
  //（2026-11-12 修：原来多拼了一层 '.dsh'，拼成 <dshHome>\.dsh\.dsh\sessions，5 个场景全报「会话文件不在库」假告警）
  const SESS = path.join(MEMROOT, '..', 'sessions')
  for (const f of ['场景私有记忆.md', '身份卡.md', '场景画像.md', '_文件索引.md']) {
    if (fs.existsSync(path.join(dir, f))) ok.push(f); else problems.push('缺文件 ' + f)
  }
  for (const d of ['项目记忆', '归档']) {
    if (fs.existsSync(path.join(dir, d))) ok.push(d + '\\'); else problems.push('缺目录 ' + d + '\\')
  }
  if (ident && ident.card) {
    const card = fs.readFileSync(path.join(dir, '身份卡.md'), 'utf8')
    const fp = (card.match(/卡指纹`\s*`?sha256:([0-9a-f]+)/) || card.match(/sha256:([0-9a-f]{8,64})/) || [])[1]
    const real = sha(ident.card).slice(0, fp ? fp.length : 16)
    if (!fp) problems.push('身份卡里没有卡指纹')
    else if (!sha(ident.card).startsWith(fp)) problems.push(`卡指纹过期（卡已改，跑 stamp）${fp}…≠${real}…`)
    else ok.push('卡指纹一致')
  } else problems.push('身份索引里没有这张场景卡')
  // 会话必须绑定到场景（2026-10-27 卡07 决定）
  if (scene && ident) {
    const panelSessions = (scene.panels || []).filter((p) => p && p.sessionId).map((p) => p.sessionId)
    if (!panelSessions.includes(ident.sessionId)) problems.push('会话未绑定场景 json（身份索引 ' + ident.sessionId + '，json 面板 ' + (panelSessions.join(',') || '无') + '）')
    else ok.push('会话已绑定场景')
    let found = false
    if (fs.existsSync(SESS)) {
      for (const ws of fs.readdirSync(SESS)) {
        if (fs.existsSync(path.join(SESS, ws, ident.sessionId, 'session.v4.jsonl.zstd')) || fs.existsSync(path.join(SESS, ws, ident.sessionId, 'session.v3.jsonl.zstd'))) { found = true; break }
      }
    }
    if (!found) warns.push('会话文件不在库（可能刚归档/换会话未回填）')
  }
  const mainPath = path.join(dir, '场景私有记忆.md')
  if (!fs.existsSync(mainPath)) { console.log('\n' + name + '：✗ 缺 场景私有记忆.md（跑 init）'); return 1 }
  const main = fs.readFileSync(mainPath, 'utf8')
  // 兼容副本必须是硬链接（2026-11-12 加）：独立副本会被当「冲突副本」反复归档，也会读到过期内容
  {
    const legacy = path.join(dir, name + '场景私有记忆.md')
    if (fs.existsSync(legacy) && fs.statSync(legacy).ino !== fs.statSync(mainPath).ino) {
      problems.push('兼容副本 ' + name + '场景私有记忆.md 不是硬链接（是独立副本，会重复产冲突副本）：跑 init 收敛')
    }
  }
  // 核心职责块（2026-10-27 宿主定：私有记忆必须包含核心职责）
  {
    const i = main.search(/^## 核心职责/m)
    if (i < 0) problems.push('缺「## 核心职责」块（私有记忆必填）')
    else {
      const rest = main.slice(i)
      const next = rest.indexOf('\n## ', 5)
      const sec = next >= 0 ? rest.slice(0, next) : rest
      const n = (sec.match(/^- /gm) || []).length
      if (n < 3) problems.push('核心职责只有 ' + n + ' 条（至少 3 条）')
      else ok.push('核心职责 ' + n + ' 条')
    }
  }
  // 2026-11-12（用户报「四小节都在却判不过」）：结构闸改为**按内容**认小节，不再要求固定编号/空格；
  //   缺哪节就直说缺哪节、期望什么格式。四小节（上次交接 / 当前项目 / 私有记忆变更 / 下一步·卡点）必须，
  //   「全貌」缺了只告警（工具会自动补）。
  const m0 = main.match(/^## (?:§〇|〇、|§0)[^\n]*$/m)
  const sec0Start = m0 ? m0.index : -1
  const sec0Stop = (() => { if (sec0Start < 0) return -1; const n = main.indexOf('\n## ', sec0Start + 4); return n < 0 ? main.length : n })()
  const sec0Text = sec0Start >= 0 ? main.slice(sec0Start, sec0Stop) : ''
  if (sec0Text) {
    const SEC_REQ = [
      ['上次交接', /^###[^\n]*上次交接/m],
      ['当前项目', /^###[^\n]*当前项目/m],
      ['私有记忆变更', /^###[^\n]*私有记忆变更/m],
      ['下一步 / 卡点', /^###[^\n]*(?:下一步|卡点)/m],
    ]
    for (const [label, re] of SEC_REQ) {
      if (re.test(sec0Text)) continue
      problems.push('§〇 缺「' + label + '」小节：期望 §〇 里有任意一行 `###` 标题含「' + label + '」（如 `### 1) ' + label + '`）')
    }
    if (!/^###[^\n]*全貌/m.test(sec0Text)) warns.push('§〇 没有「全貌」小节（工具会自动补，不阻断）')
  }
  // 内容告警：项目表不能空、下一步/卡点不能空（卡08 决定：只告警不阻断）
  {
    const segBy = (re) => {
      const m = sec0Text.match(re)
      if (!m) return ''
      const i2 = m.index
      const e2 = sec0Text.indexOf('\n### ', i2 + m[0].length)
      return sec0Text.slice(i2, e2 > i2 ? e2 : sec0Text.length)
    }
    const seg2 = segBy(/^###[^\n]*当前项目/m)
    const rows = seg2.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !/^\|\s*-/.test(l.trim()))
    if (rows.length <= 1) warns.push('当前项目表是空的（没项目要写“无”）')
    const seg4 = segBy(/^###[^\n]*(?:下一步|卡点)/m)
    const body4 = seg4.split(/\r?\n/).filter((l) => /^-\s*\S/.test(l.trim()))
    if (!body4.length) warns.push('第 4 节 下一步/卡点 为空')
  }
  // §〇 区段：从 '## §〇' 到下一个二级标题（不假设下一个一定叫 §一）
  const mNew = main.match(/^## §〇[^\n]*$/m)
  const mOld = main.match(/^## 〇、当前交接[^\n]*$/m)
  let h0 = mNew ? mNew.index : (mOld ? mOld.index : -1)
  const oldH0 = mOld ? mOld.index : -1
  const hasNew = !!mNew, hasOld = !!mOld
  let secEnd = main.length
  if (h0 >= 0) {
    const nxt = main.indexOf('\n## ', h0 + 5)
    if (nxt > h0) secEnd = nxt
  }
  const sec0Bytes = h0 >= 0 ? Buffer.byteLength(main.slice(h0, secEnd)) : 0
  // 2026-10-27 L2：新旧 §0 头/空骨架/项目表
  if (h0 < 0) problems.push('缺 §〇 交接头（## §〇 或旧 ## 〇、当前交接 都没有）')
  else {
    if (hasOld && !hasNew) warns.push('用的是旧 §0 头（## 〇、当前交接），建议改为 ## §〇 当前交接')
    if (hasOld && hasNew) warns.push('新旧两个 §0 头并存（旧头内容需并入/归档）')
    const seg0 = main.slice(h0, secEnd)
    let pmCount = 0
    try { const pm = path.join(dir, '项目记忆'); pmCount = fs.existsSync(pm) ? fs.readdirSync(pm).filter((x) => x.endsWith('.md')).length : 0 } catch {}
    if (pmCount > 0 && /\|\s*（暂无）\s*\|/.test(seg0)) warns.push('当前项目表写“暂无”，但项目记忆有 ' + pmCount + ' 份（表需更新）')
    if ((pmCount > 0 || hasOld) && /### 2\) 当前项目[\s\S]{0,120}?（暂无）/.test(seg0) && /### 3\)[\s\S]{0,40}?-\s*\n/.test(seg0)) warns.push('§〇 仍是空骨架（项目表暂无 + 变更/下一步为空）')
  }
  // 项目记忆隔离（2026-11-10）：一个项目一份，必须有业务区（领域 / 数据来源）；
  // 场景私有记忆只放跨项目规矩——里面出现项目名就等于业务知识串到了共享区（只告警，不阻断）
  // 2026-11-11（记忆改造 P1）：项目记忆改成「薄卡 + memory\ 正文」后，薄卡只放指针、正文在 memory\，
  // 业务区校验交给 记忆.mjs check；薄卡自身不再要求「领域 / 数据来源」标题，否则两套校验互相打架。
  {
    const pmDir = path.join(dir, '项目记忆')
    const pmFiles = fs.existsSync(pmDir) ? fs.readdirSync(pmDir).filter((x) => x.endsWith('.md')) : []
    for (const f of pmFiles) {
      const body = fs.readFileSync(path.join(pmDir, f), 'utf8')
      const thinCard = body.includes('记忆薄卡')
      if (thinCard) {
        if (!body.includes('MEMORY_INDEX.md')) problems.push('项目薄卡 ' + f + ' 没有指向 memory\\MEMORY_INDEX.md')
        continue
      }
      if (!/^#{1,4}[^\n]*领域/m.test(body)) problems.push('项目记忆 ' + f + ' 缺「领域」小节（业务域 / 术语 / 边界）')
      if (!/^#{1,4}[^\n]*数据来源/m.test(body)) problems.push('项目记忆 ' + f + ' 缺「数据来源」小节（数据从哪来、谁维护、哪些字段脏）')
    }
    if (pmFiles.length) ok.push('项目记忆 ' + pmFiles.length + ' 份（含业务区）')
    const names = pmFiles.map((f) => f.replace(/\.md$/, '')).filter(Boolean)
    // 2026-11-12（改判据）：只查「本来就不该出现项目名」的小节——核心职责 / §一 职责边界 / §二 现状接口。
    //   §五 决策与坑是只追加的历史（不许改），§八 项目索引本来就该列项目——扫它们只会留下永远消不掉的告警，
    //   告警一多就没人看，等于把真泄漏也一起忽略了。
    const SKIP_SEC = /(?:§〇|当前交接|五|坑|决策|项目索引|通知)/
    let skipSec = false
    const shared = main.split(/\r?\n/).map((l) => {
      if (/^## /.test(l)) skipSec = SKIP_SEC.test(l)
      return skipSec ? '' : l
    }).join('\n')
    const leaked = names.filter((n) => shared.includes(n))
    if (leaked.length) warns.push('场景私有记忆里出现项目名（' + leaked.join('、') + '）：业务知识应写 项目记忆\\<项目>.md，这里只放跨项目规矩')
  }
  if (sec0Bytes > 4096) problems.push('§〇 ' + sec0Bytes + ' B 超 4 KB（红线 4096）')
  const mainBytes = Buffer.byteLength(main)
  // 2026-11-13（用户问「文件越来越大怎么办」）：主文件红线从 warn 升级成 ✗，>12 KB 提前提醒该拆。
  //   只告警不阻断等于看着它长大——这正是 §五 长到 18 KB 的原因。
  if (mainBytes > 25600) problems.push('主文件 ' + (mainBytes / 1024).toFixed(1) + ' KB 超 25 KB 红线（跑 拆 --场景 ' + name + '，把 §五 搬成 决策\\/坑\\ 分条）')
  else if (mainBytes > 12288) warns.push('主文件 ' + (mainBytes / 1024).toFixed(1) + ' KB（>12 KB 该拆了：先跑 拆 --场景 ' + name + ' --dry 看清单）')
  // §五 不许再攒正文（2026-11-13）：拆过的场景只要 §五 里又出现「日期开头的正条目」就是巨石复发。
  //   这条比 25 KB 红线早得多——追加 5 条才 3 KB，等到 25 KB 已经晚了。指针行（`… → 决策\x.md`）不算。
  {
    const splitDone = KINDS.some((k) => fs.existsSync(path.join(dir, k)))
    const sec5 = sectionOf(main, '五|坑与决策')
    const inline = sec5 ? sec5.body.split(/\r?\n/).filter((l) => /^- ?\d{4}-\d{2}-\d{2}/.test(l) && !l.includes(' → ')).length : 0
    if (splitDone && inline) problems.push('§五 里还有 ' + inline + ' 条正文（本场景已分条）：新条目用 写 --场景 ' + name + ' --类 决策|坑 --标题 "…"，存量用 拆')
  }
  // 分条红线（2026-11-13）：一条一个文件——单篇 >2 KB 说明又在往里写过程；evidence 逐条复核
  {
    let n = 0
    let longTagN = 0
    for (const k of KINDS) {
      const sub = path.join(dir, k)
      if (!fs.existsSync(sub)) continue
      const files = fs.readdirSync(sub).filter((f) => f.endsWith('.md'))
      n += files.length
      for (const f of files) {
        const p = path.join(sub, f)
        const b = fs.statSync(p).size
        const txt = fs.readFileSync(p, 'utf8')
        if (b > KIND_SIZE) problems.push('单篇 ' + k + '\\' + f + ' ' + b + ' B 超 2 KB（一条一个文件：只留结论，过程进 归档\\）')
        const bad = evidenceOf(txt).map((ref) => [ref, verifyEvidence(ref)]).filter((x) => x[1])
        bad.forEach((x) => problems.push('证据失效 ' + k + '\\' + f + ' → ' + x[0] + '（' + x[1] + '）'))
        longTagN += tagsOf(txt).filter((t) => t.length > 12 || TAG_BAD_RE.test(t)).length
      }
      if (files.length > KIND_BULK) warns.push(k + '\\ 有 ' + files.length + ' 篇（>' + KIND_BULK + '：跑 整理 --days ' + KIND_OLD_DAYS + ' 把旧条目搬 归档\\）')
    }
    if (n) ok.push('分条 ' + n + ' 篇')
    // 标签整句：联想层会把这些词当主题词连边，越连越糊（用户 2026-11-13 要求防「词像义不同」）
    if (longTagN) warns.push('标签像整句/超长 ' + longTagN + ' 处：收敛成 ≤12 字的主题词（新写入已被 写 拦住）')
  }
  // 索引与文件一致（2026-11-14）：派生索引过期/损坏，以前靠"写/沉淀会顺手重建"的纪律兜底，现在直接查
  {
    const idxPath = path.join(dir, '_索引.json')
    if (!fs.existsSync(idxPath)) problems.push('缺 _索引.json（跑 索引 --场景 ' + name + '）')
    else {
      let rows = []
      try { rows = (JSON.parse(fs.readFileSync(idxPath, 'utf8')).entries || []) } catch { problems.push('_索引.json 解析失败：跑 索引 --场景 ' + name) }
      const files = KINDS.flatMap((k) => kindFiles(dir, k).map((f) => k + '\\' + f))
      for (const extra of ['记忆', DISTILL_DIR, '归档']) {
        const sub = path.join(dir, extra)
        if (fs.existsSync(sub)) files.push(...fs.readdirSync(sub).filter((x) => x.endsWith('.md')).map((f) => extra + '\\' + f))
      }
      const have = new Set(rows.map((r) => String(r.path || '')))
      const missing = files.filter((f) => !have.has(f))
      const gone = rows.map((r) => String(r.path || '')).filter((p) => p && !files.includes(p))
      if (missing.length) problems.push('索引缺 ' + missing.length + ' 个文件（' + missing.slice(0, 3).join('、') + '…）：跑 索引 --场景 ' + name)
      if (gone.length) problems.push('索引有 ' + gone.length + ' 个已不存在文件（' + gone.slice(0, 3).join('、') + '…）：跑 索引 --场景 ' + name)
    }
  }
  // 定论断链 + 定论证据（2026-11-14）：整理/删源都会让定论的 sources 悬空；证据失效说明来源条目变了，以前都没人查
  {
    const disDir = path.join(dir, DISTILL_DIR)
    if (fs.existsSync(disDir)) {
      for (const f of fs.readdirSync(disDir).filter((x) => x.endsWith('.md'))) {
        const dp = path.join(disDir, f)
        const txt = fs.readFileSync(dp, 'utf8')
        for (const ref of evidenceOf(txt)) {
          const why = verifyEvidence(ref)
          if (why) problems.push('定论证据失效 ' + DISTILL_DIR + '\\' + f + ' → ' + ref.slice(0, 50) + '…（' + why + '；跑 沉淀 --场景 ' + name + ' --force 重算）')
        }
        for (const s of sourcesOfDistill(dp)) {
          if (fs.existsSync(path.join(dir, s.replace(/\//g, path.sep)))) continue
          if (fs.existsSync(path.join(dir, '归档', path.basename(s)))) problems.push('定论 ' + f + ' 的来源已进归档（' + s + '）：把条目搬回，或 沉淀 --force 重算')
          else problems.push('定论 ' + f + ' 的来源不存在（' + s + '）：来源已丢，跑 沉淀 --force 重算')
        }
      }
    }
  }
  // 取代/过期/回链（2026-11-14）：写 现在能写这三个字段，check 就得能验它们不悬空
  {
    const regIds = readSceneReg().scenes.map((s) => String(s.id || '')).filter(Boolean)
    for (const k of KINDS) for (const f of kindFiles(dir, k)) {
      const fm = fmOfText(fs.readFileSync(path.join(dir, k, f), 'utf8'))
      const sup = ((fm.match(/^supersedes:[ \t]*([^\r\n]+)/m) || [])[1] || '').trim()
      if (sup && !fs.existsSync(path.join(MEMROOT, sup.replace(/\//g, path.sep)))) problems.push(k + '\\' + f + ' 的 supersedes 指向不存在：' + sup)
      const exp = ((fm.match(/^expires:[ \t]*(\d{4}-\d{2}-\d{2})/m) || [])[1] || '')
      if (exp && exp < dayStr()) warns.push(k + '\\' + f + ' 已过期（expires ' + exp + '）：临时约定该收尾了，删掉或延长')
      const ci = ((fm.match(/^consolidated_into:[ \t]*([^\r\n]+)/m) || [])[1] || '').trim()
      if (ci && !fs.existsSync(path.join(dir, ci.replace(/\//g, path.sep)))) problems.push(k + '\\' + f + ' 的 consolidated_into 指向不存在（定论被删/改名？）：' + ci)
      const rel = ((fm.match(/^relate:[ \t]*\[?([^\]\r\n]*)\]?$/m) || [])[1] || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      const bad = rel.filter((r) => !regIds.includes(r))
      if (bad.length) warns.push(k + '\\' + f + ' 的 relate 指向未知场景 id（' + bad.join('、') + '）：先 索引 --all 让场景进目录')
    }
  }
  // 同证据不同条目（2026-11-14）：两条都活、证据指向同一处、结论却是两条 ⇒ 可能一条旧一条新/一条对一条错，去 冲突.md 裁决
  {
    const byEv = new Map()
    for (const k of KINDS) for (const f of kindFiles(dir, k)) {
      const txt = fs.readFileSync(path.join(dir, k, f), 'utf8')
      for (const ref of evidenceOf(txt)) {
        if (!byEv.has(ref)) byEv.set(ref, [])
        byEv.get(ref).push(k + '\\' + f)
      }
    }
    const dup = [...byEv.entries()].filter(([, v]) => new Set(v).size >= 2)
    if (dup.length) warns.push('同证据不同条目 ' + dup.length + ' 组（如 ' + dup[0][1].join(' 与 ') + ' 都引 ' + dup[0][0].slice(0, 40) + '…）：可能结论矛盾，去 _共享记忆\\冲突.md 裁决')
  }
  // 项目薄卡 ↔ 项目根 memory 对账（2026-11-14）：薄卡说"正文在 memory\"，项目根却没建过 ⇒ 指针空转
  {
    const pmDir = path.join(dir, '项目记忆')
    const projByName = new Map(readProjects().map((p) => [String(p.name || ''), p]))
    for (const f of fs.existsSync(pmDir) ? fs.readdirSync(pmDir).filter((x) => x.endsWith('.md')) : []) {
      const nm = f.replace(/\.md$/, '')
      const p = projByName.get(nm)
      if (!p) { warns.push('项目薄卡 ' + f + ' 没在 _共享记忆\\项目.json 登记（薄卡成孤岛）'); continue }
      const root = p.memoryRoot
      if (!root) { warns.push('项目 ' + nm + ' 在 项目.json 里没登记 memoryRoot：补上才能对账'); continue }
      if (!fs.existsSync(path.join(root, 'memory'))) warns.push('项目 ' + nm + ' 的项目根没有 memory\\ 目录：跑 记忆.mjs init --project "' + root + '"')
      else if (!fs.existsSync(p.memoryIndex || path.join(root, 'memory', '_索引.json'))) warns.push('项目 ' + nm + ' 缺 memory 索引：跑 记忆.mjs index --project "' + root + '"')
    }
  }
  // 待确认队列：不确定的东西不许无限期挂着
  {
    const blocks = readPending(dir)
    if (blocks.length) {
      warns.push('待确认 ' + blocks.length + ' 条（用户点头后 确认 --序号 N 转正）')
      const stale = blocks.filter((b) => b.date && (Date.now() - Date.parse(b.date)) > 7 * 86400000)
      if (stale.length) warns.push('待确认有 ' + stale.length + ' 条超 7 天：别让不确定的记忆烂在队列里，当轮就问用户')
    }
  }
  console.log(`\n${name}：${problems.length ? '✗ ' + problems.length + ' 个问题' : '✓ 全部通过'}（§〇 ${sec0Bytes} B${warns.length ? ' · ⚠ ' + warns.length : ''}）`)
  problems.forEach((p) => console.log('   ✗ ' + p))
  warns.forEach((p) => console.log('   ⚠ ' + p))
  return problems.length ? 1 : 0
}

/* --------------------------------------------------- 读一节（省上下文） */

/**
 * 只打印某一节（默认 §〇），避免为了拿 4 KB 交接去整读 25 KB 主文件。
 *   node 场景记忆.mjs 读 --场景 程序开发 [--节 §〇|§一|§五]
 * 返回：0 正常；1 该节超 4 KB；2 场景/文件不存在；3 没有这一节（会列出可用小节）
 */
function cmdRead(arg, flags) {
  // 1. 定位主文件
  const name = findSceneDir(arg) || arg
  const file = path.join(MEMROOT, name, '场景私有记忆.md')
  if (!fs.existsSync(file)) { console.error('✗ 找不到 ' + file + '（先跑 init）'); return 2 }
  const text = fs.readFileSync(file, 'utf8')
  // 2. 按二级标题切段：命中行起，到下一个 `## ` 前一行止（`### ` 子标题不断段）
  const lines = text.split(/\r?\n/)
  const heads = []
  lines.forEach((l, i) => { if (/^## /.test(l)) heads.push(i) })
  const key = String(flags.sec || '§〇')
  // 老场景的交接头是 `## 〇、当前交接`，按 §〇 也要能取到
  const ALT = key === '§〇' ? /(?:§〇|§0|〇、当前交接)/ : null
  let start = heads.find((i) => lines[i].includes(key))
  if (start === undefined && ALT) start = heads.find((i) => ALT.test(lines[i]))
  if (start === undefined) {
    const avail = heads.map((i) => lines[i].replace(/^## /, ''))
    console.error('✗ 没有小节「' + key + '」；可用：' + (avail.join(' / ') || '（主文件没有二级标题）'))
    return 3
  }
  const nextHead = heads.find((i) => i > start)
  const sec = lines.slice(start, nextHead === undefined ? lines.length : nextHead).join('\n').replace(/\s+$/, '')
  // 3. 打印：先一行元信息（体积/来源），正文紧跟，方便贴进上下文
  const bytes = Buffer.byteLength(sec)
  console.log('[' + key + '] ' + name + ' · ' + bytes + ' B · 源 ' + file)
  console.log(sec)
  if (bytes > 4096) { console.error('⚠ 这一节 ' + bytes + ' B 超 4 KB 红线：搬旧内容进 归档\ 并留指针'); return 1 }
  return 0
}

/* --------------------------------------------------- 分条记忆（2026-11-13 加） */

// 一条事实一个文件：三类别目录。⛔ 不再往 §五 追加正文（那是「一坨」的复发入口）
const KINDS = ['决策', '坑', '通知']
const KIND_SIZE = 2048        // 单篇红线：超了就说明又在写过程
const KIND_BULK = 30          // 单目录篇数：超了提示 整理
const KIND_OLD_DAYS = 180     // 整理默认：超过多少天搬 归档\
const SLUG_BAD = /[\\/:*?"<>|\s]+/g
const DAY_RE = /\d{4}-\d{2}-\d{2}/
const dayStr = (d = NOW()) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
// 布尔旗标必须查 `argv.includes`：`val('--dry')` 取的是「--dry 的下一个参数」，永远为空 ⇒ dry 从不生效（2026-11-13 实际踩到）
const flagOn = (k) => process.argv.slice(2).includes(k)
// 文件名要人能读：去掉反引号/引号/括号等排版字符，其余非中文非字母数字一律归成一个 '-'
// 截断优先落在 '-' 分词处，避免把词切成「…别整段重」「…是-CRL」这种半截
const clipSlug = (s, n = 32) => {
  const cut = s.slice(0, n)
  const i = cut.lastIndexOf('-')
  return (i >= Math.floor(n / 2) ? cut.slice(0, i) : cut).replace(/-$/, '')
}
const slugOf = (s, n = 32) => clipSlug(String(s)
  .replace(/\*\*/g, '')
  .replace(/[`~"'“”‘’「」『』()（）【】\[\]{}<>《》]/g, '')
  .replace(/[^0-9A-Za-z\u4e00-\u9fa5]+/g, '-')
  .replace(/-+/g, '-').replace(/^-|-$/g, ''), n)

/** 取某一节的正文（`## 五…` 到下一个 `## ` 之前）；找不到返回 null */
function sectionOf(text, kw) {
  const lines = text.split(/\r?\n/)
  const heads = []
  lines.forEach((l, i) => { if (/^## /.test(l)) heads.push(i) })
  const start = heads.find((i) => new RegExp(kw).test(lines[i]))
  if (start === undefined) return null
  const next = heads.find((i) => i > start)
  return { start, end: next === undefined ? lines.length : next, body: lines.slice(start, next === undefined ? lines.length : next).join('\n') }
}

/** §五 按顶级 `- ` 条目切（缩进子条与续行归上一条）；是否「日期条目」由调用方判 */
function bulletsOf(secBody) {
  const out = []
  let cur = null
  for (const line of secBody.split(/\r?\n/)) {
    if (/^- /.test(line)) {
      if (cur) out.push(cur)
      cur = { text: line }
    } else if (cur && line.trim()) {
      cur.text += '\n' + line
    } else if (cur) { out.push(cur); cur = null }
  }
  if (cur) out.push(cur)
  return out
}

/** 从条目里取 日期 / 括注标签 / 标题 / 类别 */
function metaOfBullet(text) {
  const body = text.replace(/^-\s+/, '')
  const d = (body.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || dayStr()
  const tag = ((body.match(/（([^）]{0,40})）/) || [])[1] || '').trim()
  const rest = body.replace(/^\d{4}-\d{2}-\d{2}(（[^）]*）)?[：:]?\s*/, '')
  const title = rest.replace(/\*\*/g, '').split(/——|。|；/)[0].replace(/[，,]\s*$/, '').trim().slice(0, 60) || tag || '条目'
  const kind = /坑|踩|故障|报错|失效/.test(tag) ? '坑' : '决策'
  return { date: d, tag, title, kind, body }
}

/** frontmatter 里的 evidence（复用 记忆.mjs 的 `路径::片段` 约定）
 *  2026-11-13 修：单行分支原来用 `^evidence:\s*(.+)$`，`\s` 会吃掉换行 ⇒ 把数组块的首行连同 `- ` 当值，
 *  既丢了第二条又让值带前缀。现在先认数组块，再认同一行的单个值。 */
function evidenceOf(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return []
  const fm = m[1]
  const block = fm.match(/^evidence:\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/m)
  if (block) return block[1].split(/\r?\n/).map((s) => s.replace(/^[ \t]*-[ \t]*/, '').trim()).filter(Boolean)
  const one = fm.match(/^evidence:[ \t]*(\S[^\r\n]*)$/m)
  return one ? [one[1].trim()] : []
}

/** 同名参数的全部取值（`--证据` 可重复；`val()` 只取第一个，2026-11-13 实际踩到） */
function vals(k) {
  const a = process.argv.slice(2)
  const out = []
  a.forEach((x, i) => { if (x === k && a[i + 1] && !String(a[i + 1]).startsWith('--')) out.push(a[i + 1]) })
  return out
}

/** 证据复核：文件在、片段对得上
 *  路径先按工作台根解析；找不到再往上找一层——两种写法都常见：`工具\x.mjs`（相对工作台）
 *  与 `12-源码照搬/工具/x.mjs`（相对仓根）。2026-11-13：只认前者时前者写法里的仓根路径全被误报失效。 */
/** 证据文件按编码读：UTF-8 / UTF-16LE / UTF-16BE。
//  2026-11-13 修：.vbs/.ps1 常是 UTF-16，按 UTF-8 读全是乱码 ⇒ 真证据被判"找不到片段"（假失效） */
function readEvidenceText(abs) {
  const buf = fs.readFileSync(abs)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString('utf16le')
  return buf.toString('utf8')
}

function verifyEvidence(ref) {
  const i = String(ref).indexOf('::')
  const rel = i < 0 ? String(ref) : String(ref).slice(0, i)
  const needle = i < 0 ? '' : String(ref).slice(i + 2)
  const bases = [WORKBENCH_ROOT, path.resolve(WORKBENCH_ROOT, '..')]
  const abs = path.isAbsolute(rel)
    ? (fs.existsSync(rel) ? rel : '')
    : bases.map((b) => path.join(b, rel)).find((p) => fs.existsSync(p))
  if (!abs) return '文件不存在：' + rel + '（已试 ' + (path.isAbsolute(rel) ? '绝对路径' : bases.join(' / ')) + '）'
  if (needle && !readEvidenceText(abs).includes(needle)) return '文件里找不到「' + needle + '」'
  return ''
}

/** 某类目录里的文件（按名倒序 = 新的在前） */
function kindFiles(dir, kind) {
  const d = path.join(dir, kind)
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort().reverse() : []
}

/* 2026-11-14 审计新项的三个小助手：索引一致 / 定论断链 / 薄卡对账（调用见 cmdCheck） */

/** frontmatter 原文（不含首尾 --- 行） */
function fmOfText(txt) {
  return (txt.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
}

/** 定论文件的 sources（相对路径数组，保留 / 写法由调用方归一） */
function sourcesOfDistill(file) {
  const txt = fs.readFileSync(file, 'utf8')
  return ((txt.match(/^sources:\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/m) || [])[1] || '')
    .split(/\r?\n/).map((s) => s.replace(/^[ \t]*-[ \t]*/, '').trim()).filter(Boolean)
}

/** 项目登记表（_共享记忆\项目.json）：薄卡对账的数据源 */
function readProjects() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(MEMROOT, '_共享记忆', '项目.json'), 'utf8'))
    return Array.isArray(j.projects) ? j.projects : []
  } catch { return [] }
}

/** 文件标题：优先 frontmatter title，其次首个 `# ` */
function titleOf(file) {
  const t = fs.readFileSync(file, 'utf8')
  const fm = (t.match(/^---\r?\n[\s\S]*?\r?\ntitle:\s*(.+)\r?$/m) || [])[1]
  if (fm) return fm.trim()
  return ((t.split(/\r?\n/).find((l) => /^#\s+/.test(l)) || '').replace(/^#\s+/, '')) || path.basename(file, '.md')
}

/** 给 _文件索引.md 追加一行（已登记过就跳过，避免重复行） */
function indexAdd(dir, rel, what, status = '活') {
  const fidx = path.join(dir, '_文件索引.md')
  if (!fs.existsSync(fidx)) return false
  const text = fs.readFileSync(fidx, 'utf8')
  if (text.includes('`' + rel + '`')) return false
  fs.appendFileSync(fidx, `| \`${rel}\` | ${what} | ${status} | ${dayStr()} |\r\n`, 'utf8')
  return true
}

/** 重写 §五：只留「有多少篇 + 最近 5 条指针」；`keepLines` 是没有日期、原样保留的旧备注 */
function renderPointerSec(dir, note, keepLines = []) {
  const counts = KINDS.map((k) => k + '\\ ' + kindFiles(dir, k).length + ' 篇').join(' · ')
  const rows = KINDS.flatMap((k) => kindFiles(dir, k).slice(0, 5).map((f) => ({ k, f, t: titleOf(path.join(dir, k, f)) })))
  const latest = rows.slice(0, 5).map((r) => `- ${r.f.slice(0, 10)}：${r.t} → \`${r.k}\\${r.f}\``)
  return [
    '## 五、坑与决策（已拆分，只放下标）',
    '',
    '> ' + (note || '一条一个文件：正文在 `决策\\` / `坑\\` / `通知\\`，原文整份留 `归档\\`（只进不改）。'),
    '> ⛔ 不要再往这一节追加正文——新条目用 `node 工具\\场景记忆.mjs 写 --场景 <场景> --类 决策|坑 --标题 "…"`。',
    '',
    '- 规模：' + counts,
    '- 最近 5 条：',
    ...latest,
    ...(keepLines.length ? ['', '### 原 §五 未归类条目（原样保留）', ...keepLines.map((s) => s.trim()), ''] : ['']),
  ].join('\r\n')
}

/* ---------------------------------------- 写入闸门（2026-11-13：不确定就问用户）
//  ① 相似检测：同场景已有条目的标题与新标题二元词重合 ≥62% ⇒ 拒写，先确认是不是同一条
//  ② 消歧清单：`--不是同一条 "词：区别"` ⇒ frontmatter distinct，联想层不再拿该词连边
//  ③ 待确认队列：`--不确定 "疑问"` ⇒ 不落正式条目，进 `_待确认.md`，用户点头后 `确认 --序号 N`
//  判据来源：用户 2026-11-13「遇到不确定的记忆要向我确认，防止错误/模糊/词像义不同」。
 */

const TITLE_STOP = new Set(['场景', '记忆', '项目', '工作台', '文件', '目录', '工具', '面板', '代码', '规则',
  '文档', '条目', '一条', '不是', '就是', '可以', '需要', '已经', '没有', '时候', '问题', '这个', '那个',
  '一个', '我们', '用户', '以及', '还是', '但是', '如果', '因为', '所以', '现在', '然后', '东西', '这里', '那里'])

function gramsOfTitle(s) {
  const out = new Set()
  for (const r of String(s || '').toLowerCase().match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < r.length - 1; i++) { const g = r.slice(i, i + 2); if (!TITLE_STOP.has(g)) out.add(g) }
  }
  for (const w of String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) || []) out.add(w)
  return out
}

/** 标题相似度（Dice 系数，0–1）；只看"像不像同一条"，不做语义判断 */
function simOf(a, b) {
  const A = gramsOfTitle(a), B = gramsOfTitle(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  A.forEach((g) => { if (B.has(g)) hit++ })
  return (2 * hit) / (A.size + B.size)
}

/** 同场景里和新标题最像的 3 条（只跟自己场景比：跨场景相近是正常的"共享主题"） */
function similarEntries(dir, title) {
  const out = []
  for (const k of KINDS) for (const f of kindFiles(dir, k)) {
    const s = simOf(title, titleOf(path.join(dir, k, f)))
    if (s >= 0.4) out.push({ kind: k, file: f, title: titleOf(path.join(dir, k, f)), score: s })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3)
}

const TAG_BAD_RE = /[，。、；;：:！？!?+＋|｜]/
const DISTINCT_MAX = 12          // 消歧词条上限：多了说明这条本身就该拆
const PENDING = (dir) => path.join(dir, '_待确认.md')
const PENDING_HEAD = '# _待确认 · 不确定就不落盘，等用户点头\r\n\r\n> 工具维护（`写 --不确定` 追加，`确认` 转正/放弃）。⛔ 别手改这一页。\r\n'

/** frontmatter 的 distinct（消歧词）：内联数组，兼容块状 */
function distinctOfText(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return []
  const block = m[1].match(/^distinct:\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/m)
  if (block) return block[1].split(/\r?\n/).map((s) => s.replace(/^[ \t]*-[ \t]*/, '').trim()).filter(Boolean)
  const one = m[1].match(/^distinct:[ \t]*\[?([^\]\r\n]*)\]?$/m)
  return one ? one[1].split(/[,，]/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []
}

/** 解析待确认队列：每块 `## <编号> · <类> · <标题> · <日期>` + 疑问/证据 + body 标记 */
function readPending(dir) {
  const p = PENDING(dir)
  if (!fs.existsSync(p)) return []
  const text = fs.readFileSync(p, 'utf8')
  const re = /^## (\d+) · (决策|坑|通知) · ([^\r\n]*?) · (\d{4}-\d{2}-\d{2})/gm
  const blocks = []
  let m
  while ((m = re.exec(text))) blocks.push({ id: Number(m[1]), kind: m[2], title: m[3].trim(), date: m[4], start: m.index })
  blocks.forEach((b, i) => { b.end = i + 1 < blocks.length ? blocks[i + 1].start : text.length })
  for (const b of blocks) {
    const body = text.slice(b.start, b.end)
    b.question = ((body.match(/^- 疑问：([^\r\n]*)/m) || [])[1] || '').trim()
    b.ev = (body.match(/^- 证据：.*$/gm) || []).map((l) => l.replace(/^- 证据：/, '').trim()).filter(Boolean)
    b.tags = ((body.match(/^- 标签：([^\r\n]*)/m) || [])[1] || '').split(/[,，/／]/).map((s) => s.trim()).filter(Boolean)
    b.distinct = ((body.match(/^- 消歧：([^\r\n]*)/m) || [])[1] || '').split(/[,，/／]/).map((s) => s.trim()).filter(Boolean)
    const inner = body.match(/<!-- body:start -->([\s\S]*?)<!-- body:end -->/)
    b.body = inner ? inner[1].trim() : ''
  }
  return blocks
}

function writePendingFile(dir, blocksText) {
  fs.writeFileSync(PENDING(dir), blocksText.replace(/\s*$/, '\r\n'), 'utf8')
}

function dropPending(dir, id) {
  const text = fs.existsSync(PENDING(dir)) ? fs.readFileSync(PENDING(dir), 'utf8') : ''
  const blocks = readPending(dir)
  const b = blocks.find((x) => x.id === id)
  if (!b) return false
  writePendingFile(dir, text.slice(0, b.start) + text.slice(b.end))
  return true
}

/** 不落正式条目：进待确认队列，等用户表态（返回 0 表示"已挂起"，不是"已记录"） */
function appendPending(dir, o) {
  const p = PENDING(dir)
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : PENDING_HEAD
  const id = readPending(dir).reduce((m, b) => Math.max(m, b.id), 0) + 1
  const rows = [
    '', '## ' + id + ' · ' + o.kind + ' · ' + o.title + ' · ' + o.d,
    '- 疑问：' + o.question,
    ...o.ev.map((e) => '- 证据：' + e),
  ]
  if (o.distinct.length) rows.push('- 消歧：' + o.distinct.join(' / '))
  if (o.tags.length) rows.push('- 标签：' + o.tags.join(' / '))
  rows.push('<!-- body:start -->', o.body, '<!-- body:end -->', '')
  writePendingFile(dir, cur + rows.join('\r\n'))
  console.log('⏸ 已入待确认 #' + id + '（未生效）：' + o.kind + ' · ' + o.title)
  console.log('   疑问：' + o.question)
  console.log('   下一步：问用户 → 确认后 `确认 --场景 ' + path.basename(dir) + ' --序号 ' + id + '`；否掉加 `--放弃`。')
  return 0
}

/* --------------------------------------------------- 写一条（唯一入口） */

/** 真正落盘：frontmatter + 索引 + 文件索引（不跑 check，调用方决定） */
function doWrite(name, kind, title, body, ev, tags, d, distinct, extra = {}) {
  const dir = path.join(MEMROOT, name)
  const fm = ['---', 'title: ' + title, 'date: ' + d, 'tags: [' + [kind].concat(tags).join(', ') + ']']
  if (distinct.length) fm.push('distinct: [' + distinct.join(', ') + ']')
  if (ev.length) fm.push('evidence:', ...ev.map((e) => '  - ' + e))
  // 2026-11-14：取代/过期/相关 三个字段终于能写进去了（以前只在规范里，代码零实现）
  if (extra.supersedes) fm.push('supersedes: ' + extra.supersedes)
  if (extra.expires) fm.push('expires: ' + extra.expires)
  if (extra.relate && extra.relate.length) fm.push('relate: [' + extra.relate.join(', ') + ']')
  fm.push('---')
  const sub = path.join(dir, kind)
  fs.mkdirSync(sub, { recursive: true })
  let file = d + '-' + slugOf(title) + '.md'
  let n = 1
  while (fs.existsSync(path.join(sub, file))) file = d + '-' + slugOf(title) + '-' + (++n) + '.md'
  const text = fm.join('\r\n') + '\r\n\r\n# ' + title + '\r\n\r\n' + body + '\r\n'
  fs.writeFileSync(path.join(sub, file), text, 'utf8')
  indexAdd(dir, kind + '\\' + file, title)
  cmdIndex(name, true)
  return { file, text }
}

function cmdWrite(arg) {
  const name = findSceneDir(arg) || arg
  const dir = path.join(MEMROOT, name)
  const ex = !fs.existsSync(dir) ? exceptionOf(arg) : null
  if (ex) { console.log(`\n${ex.title || arg}（${ex.id}）：例外场景，记忆在 ${(ex.roots || []).map((r) => r.path).join(' / ')} ⇒ 不进标准结构，请直接写那几份文档`); return 1 }
  if (!fs.existsSync(dir)) { console.error('✗ 找不到场景目录：' + arg); return 2 }

  // 1. 校验：类别白名单、标题必填且不撞名
  const kind = val('--类') || val('--kind')
  const title = (val('--标题') || val('--title') || '').trim()
  if (!KINDS.includes(kind)) { console.error('✗ --类 必须是：' + KINDS.join(' / ')); return 2 }
  if (!title) { console.error('✗ 缺少 --标题'); return 2 }
  for (const k of KINDS) for (const f of kindFiles(dir, k)) {
    if (titleOf(path.join(dir, k, f)) === title) { console.error('✗ 同名条目已存在：' + k + '\\' + f + '（改标题，或直接编辑那一篇）'); return 1 }
  }

  // 1.5 写入闸门：和已有条目太像 ⇒ 先确认是不是同一条（用户 2026-11-13：不确定就要问）
  const distinctRaw = vals('--不是同一条').concat(vals('--不同')).map((s) => String(s).trim()).filter(Boolean)
  const distinct = distinctRaw.map((s) => s.split(/[：:]/)[0].trim()).filter(Boolean).slice(0, DISTINCT_MAX)
  const similar = similarEntries(dir, title)
  const top = similar[0]
  if (top && top.score >= 0.5 && !distinct.length) {
    console.error('✗ 和已有条目太像（' + Math.round(top.score * 100) + '%）：' + top.kind + '\\' + top.file + ' · ' + top.title)
    similar.slice(1).forEach((x) => console.error('   ~ ' + Math.round(x.score * 100) + '% ' + x.kind + '\\' + x.file + ' · ' + x.title))
    console.error('  是同一条 ⇒ 直接改那一篇（不新写）；确实是两件事 ⇒ 加 --不是同一条 "区分词：区别" 再写')
    return 3
  }
  if (similar.length) {
    console.log('· 相近条目（确认不是同一条再写）：')
    similar.forEach((x) => console.log('   ' + Math.round(x.score * 100) + '% ' + x.kind + '\\' + x.file + ' · ' + x.title))
  }

  // 2. 正文：--正文 文件优先，其次 --要点 "a|b|c"
  const draft = val('--正文') || val('--body')
  let body = ''
  if (draft) {
    if (!fs.existsSync(path.resolve(draft))) { console.error('✗ 正文文件不存在：' + draft); return 2 }
    body = fs.readFileSync(path.resolve(draft), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  } else if (val('--要点')) {
    body = '## 要点\r\n' + val('--要点').split('|').map((s) => s.trim()).filter(Boolean).map((s) => '- ' + s).join('\r\n')
  }
  if (!body.trim()) { console.error('✗ 缺少 --正文 <md文件> 或 --要点 "a|b|c"'); return 2 }
  body = body.replace(/^\s*#\s+[^\r\n]*\r?\n/, '').trim().replace(/\r?\n/g, '\r\n')

  // 3. frontmatter（date / tags / evidence / distinct）+ 落盘 <类>\<日期>-<标题>.md
  const d = val('--日期') || dayStr()
  const tags = (val('--标签') || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const badTag = tags.find((t) => t.length > 12 || TAG_BAD_RE.test(t))
  if (badTag) { console.error('✗ 标签「' + badTag + '」像整句/超长（≤12 字、不含标点）：改成词表里的主题词，一条最多 3 个'); return 2 }
  if (tags.length > 3) { console.error('✗ 标签最多 3 个（多了就是没想清主题）：' + tags.join(' / ')); return 2 }
  const ev = vals('--证据').concat(vals('--evidence')).flatMap((s) => s.split(/[;；]/)).map((s) => s.trim()).filter(Boolean)

  // 3.5 消歧：词像但不是一回事 ⇒ 正文留一段说明 + distinct（联想层不再用这个词连边）
  if (distinctRaw.length) {
    body += '\r\n\r\n## 消歧\r\n' + distinctRaw.map((s) => {
      const i = s.search(/[：:]/)
      const w = i >= 0 ? s.slice(0, i).trim() : s
      const why = i >= 0 ? s.slice(i + 1).trim() : ''
      return '- 与「' + w + '」不是同一件事' + (why ? '：' + why : '（未写原因，补一句）')
    }).join('\r\n')
  }

  // 3.6 取代 / 过期 / 逻辑多归属（2026-11-14 落地）：先能写进去，check 再盯住它们不悬空
  const extra = {
    supersedes: (val('--取代') || '').trim(),
    expires: (val('--过期') || '').trim(),
    relate: vals('--相关'),
  }
  if (extra.expires) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(extra.expires)) { console.error('✗ --过期 必须是 YYYY-MM-DD：' + extra.expires); return 2 }
    if (extra.expires <= dayStr()) console.log('⚠ --过期 不晚于今天（' + extra.expires + '）：写出来即过期，召回/注入会跳过它')
  }
  if (extra.supersedes && !fs.existsSync(path.join(MEMROOT, extra.supersedes.replace(/\//g, path.sep)))) {
    console.log('⚠ --取代 的目标现在不存在（' + extra.supersedes + '）：允许写，check 会盯着它')
  }
  if (extra.relate.length) {
    const ids = readSceneReg().scenes.map((s) => String(s.id || '')).filter(Boolean)
    const unknown = extra.relate.filter((r) => !ids.includes(r))
    if (unknown.length) console.log('⚠ --相关 里的场景 id 不在场景目录（' + unknown.join('、') + '）：先 索引 --all 再补')
  }

  // 4. 拿不准就问：只进待确认队列，不落正式条目（用户点头后 `确认 --序号 N`）
  const question = (val('--不确定') || val('--待确认') || '').trim()
  if (question) {
    if (flagOn('--dry')) { console.log('[dry] 将入待确认：' + title + ' · 疑问：' + question); return 0 }
    return appendPending(dir, { kind, title, body, ev, tags, d, distinct, question })
  }
  if (flagOn('--dry')) { console.log('[dry] 将写：' + kind + '\\' + d + '-' + slugOf(title) + '.md（' + Buffer.byteLength(body) + ' B 正文）'); return 0 }

  // 5. 同轮收尾：落盘（doWrite 内含索引）→ 跑 check；check 不过就说「已写入但没完成」
  const r = doWrite(name, kind, title, body, ev, tags, d, distinct, extra)
  console.log('✓ 已写入：' + kind + '\\' + r.file + '（' + Buffer.byteLength(r.text) + ' B）')
  if (Buffer.byteLength(r.text) > KIND_SIZE) console.log('⚠ 超 2 KB：一条只写结论，细节进 归档\\ 或留在会话')
  if (!ev.length) console.log('⚠ 没写 --证据：这条以后没法自动判「还成不成立」')
  if (cmdCheck(name) !== 0) { console.error('✗ 已写入但自检未过 → 按上面的条目修完才算完成'); return 1 }
  // 6. 巩固不依赖"人记得收工"（2026-11-14）：写成功且 check 过后，顺手静默沉淀本场景
  try { const st = {}; cmdDistill(name, { quiet: true, stats: st }); if (st.made) console.log('· 巩固：新落 定论 ×' + st.made + '（结论待归纳，见 ' + name + '\\定论\\）') } catch {}
  return 0
}

/* ---------------------------------------- 待确认 / 确认 / 收工（2026-11-13） */

function cmdPending(arg) {
  const name = findSceneDir(arg) || arg
  const dir = path.join(MEMROOT, name)
  if (!fs.existsSync(dir)) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const blocks = readPending(dir)
  if (!blocks.length) { console.log(name + '：待确认 0 条 ✓'); return 0 }
  console.log('\n' + name + '：待确认 ' + blocks.length + ' 条（未生效，等用户点头）')
  blocks.forEach((b) => {
    console.log('  #' + b.id + ' [' + b.kind + '] ' + b.title + '（' + b.date + '）')
    console.log('      疑问：' + (b.question || '（没写疑问，补一句要问什么）'))
    if (b.ev.length) console.log('      证据：' + b.ev.join(' · '))
  })
  return 0
}

function cmdConfirm(arg) {
  const name = findSceneDir(arg) || arg
  const dir = path.join(MEMROOT, name)
  if (!fs.existsSync(dir)) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const id = Number(val('--序号') || val('--id') || 0)
  if (!id) { console.error('✗ 缺 --序号（先跑 待确认 看编号）'); return 2 }
  const blocks = readPending(dir)
  const b = blocks.find((x) => x.id === id)
  if (!b) { console.error('✗ 队列里没有 #' + id + '（现有：' + (blocks.map((x) => '#' + x.id).join(' ') || '空') + '）'); return 2 }
  if (flagOn('--放弃')) {
    dropPending(dir, id)
    console.log('✓ 已放弃 #' + id + '（没有落任何条目）')
    return 0
  }
  if (!b.body.trim()) { console.error('✗ #' + id + ' 没有正文，补完再确认'); return 2 }
  for (const k of KINDS) for (const f of kindFiles(dir, k)) {
    if (titleOf(path.join(dir, k, f)) === b.title) { console.error('✗ 同名条目已存在：' + k + '\\' + f); return 1 }
  }
  if (!b.ev.length) console.log('⚠ 这条没有证据：以后没法判「还成不成立」')
  const r = doWrite(name, b.kind, b.title, b.body, b.ev, b.tags, b.date, b.distinct)
  dropPending(dir, id)
  console.log('✓ 已转正：' + b.kind + '\\' + r.file + '（' + Buffer.byteLength(r.text) + ' B）')
  if (cmdCheck(name) !== 0) { console.error('✗ 已转正但自检未过 → 按上面的条目修完'); return 1 }
  return 0
}

/** 收工一条命令：索引 + 近期记忆 + check + 待确认计数（exit 0 才算收工） */
function cmdFinish(arg) {
  const name = findSceneDir(arg) || arg
  const dir = path.join(MEMROOT, name)
  if (!fs.existsSync(dir)) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  cmdIndex(name, true)
  // 巩固：同主题攒够 3 条就自动落一份 定论 草案（已存在的 draft 不重算，confirmed 不碰）
  let made = 0
  try { const st = {}; cmdDistill(name, { quiet: true, stats: st }); made = st.made || 0 } catch (e) { made = -1 }
  const r = spawnSync(process.execPath, [path.join(__HERE, '近期记忆.mjs'), '生成', '--场景', name], { encoding: 'utf8' })
  const tail = String(r.stdout || r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  const pend = readPending(dir).length
  const code = cmdCheck(name)
  console.log('· 收工：索引 ✓ · 近期记忆 ' + (r.status === 0 ? '✓' : '跳过（' + tail.slice(0, 80) + '）')
    + ' · 定论 ' + (made < 0 ? '巩固失败（不影响收工）' : '+' + made) + ' · 待确认 ' + pend + ' 条' + (pend ? '（问用户，别挂着）' : ''))
  return code
}

/* --------------------------------------------------- 索引（神经元的数据面：分条记忆的机器可读清单） */
//  2026-11-13：神经元要按「标签/证据」连联想边，就得有机器可读的索引；
//  正文仍是唯一真源，`_索引.json` 只是**可再生产物**（删了重跑一条命令就回来）。

/** frontmatter 的 tags：数组块与同行逗号两种写法都认 */
function tagsOf(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return []
  const fm = m[1]
  const block = fm.match(/^tags:\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/m)
  if (block) {
    return block[1].split(/\r?\n/)
      .map((s) => s.replace(/^[ \t]*-[ \t]*/, '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
  }
  const one = fm.match(/^tags:[ \t]*\[?([^\]\r\n]+)\]?$/m)
  return one ? one[1].split(/[,，]/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []
}

/** 一条分条记忆的摘要（渲染器读它画点、算联想边） */
function entryOf(file, kind) {
  const text = fs.readFileSync(file, 'utf8')
  const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
  const date = ((fm.match(/^date:[ \t]*(\d{4}-\d{2}-\d{2})/m) || [])[1])
    || (path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || ''
  return {
    path: kind + '\\' + path.basename(file),
    kind,
    title: titleOf(file),
    date,
    tags: tagsOf(text),
    distinct: distinctOfText(text),
    evidence: evidenceOf(text),
    // 2026-11-14：expires/consolidated_into 进索引——召回凭前者过滤过期，check 凭后者查回链断掉
    expires: ((fm.match(/^expires:[ \t]*(\d{4}-\d{2}-\d{2})/m) || [])[1] || ''),
    consolidatedInto: ((fm.match(/^consolidated_into:[ \t]*([^\r\n]+)/m) || [])[1] || '').trim(),
    size: fs.statSync(file).size,
  }
}

/* ---------------------------------------- 场景目录（派生：给神经元一份完整场景清单）
//  2026-11-13 用户报「模块里只有 5 个场景，社交/胡闹没进来」：渲染器的目录扫描走 oaApi.filesLocal，
//  真实壳没有这个 IPC ⇒ 自动进图一直静默失效，只剩手工登记表 5 个。
//  改成工具产出 `_共享记忆\场景目录.json`：每次 索引 / 写 / 收工 更新本场景，`索引 --all` 全量重建。
 */

function readSceneReg() {
  try { const d = JSON.parse(fs.readFileSync(SCENE_REG, 'utf8')); return Array.isArray(d.scenes) ? d : { version: 1, scenes: [] } } catch { return { version: 1, scenes: [] } }
}

function writeSceneReg(scenes) {
  const sorted = scenes.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
  fs.mkdirSync(path.dirname(SCENE_REG), { recursive: true })
  fs.writeFileSync(SCENE_REG, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), scenes: sorted }, null, 2) + '\n', 'utf8')
}

/** 单场景登记：名字 / 场景 id / 面板 / 分条数 / 是否有私有记忆与身份卡 */
function sceneRegUpsert(name, entryCount) {
  const sc = sceneOf(name) || {}
  const dir = path.join(MEMROOT, name)
  const row = {
    name,
    id: String(sc.id || ''),
    panels: (sc.panels || []).filter((p) => p && p.id).map((p) => p.id),
    entries: Number(entryCount) || 0,
    hasPrivate: fs.existsSync(path.join(dir, '场景私有记忆.md')),
    hasIdentity: fs.existsSync(path.join(dir, '身份卡.md')),
    updatedAt: new Date().toISOString(),
  }
  const cur = readSceneReg().scenes || []
  writeSceneReg(cur.filter((x) => x.name !== name).concat([row]))
}

function cmdIndexAll() {
  const dirs = fs.readdirSync(MEMROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort()
  let n = 0
  let total = 0
  for (const d of dirs) {
    const p = path.join(MEMROOT, d)
    const mark = ['场景私有记忆.md', '身份卡.md', '_索引.json'].some((f) => fs.existsSync(path.join(p, f)))
    if (!mark) continue
    if (cmdIndex(d, true) !== 0) continue
    n++
    try { total += (JSON.parse(fs.readFileSync(path.join(p, '_索引.json'), 'utf8')).entries || []).length } catch {}
  }
  const scenes = readSceneReg().scenes.filter((s) => fs.existsSync(path.join(MEMROOT, s.name)))
  writeSceneReg(scenes)
  console.log('✓ 场景目录已重建：' + scenes.length + ' 个场景（索引 ' + n + ' 个 · 分条 ' + total + ' 条）')
  scenes.forEach((s) => console.log('  ' + s.name + '  [' + (s.id || '?') + ']  面板 ' + (s.panels.join('/') || '—') + '  分条 ' + s.entries))
  return 0
}

function cmdIndex(arg, quiet) {
  const name = findSceneDir(arg) || arg
  const dir = path.join(MEMROOT, name)
  if (!fs.existsSync(dir)) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const entries = []
  for (const k of KINDS) for (const f of kindFiles(dir, k)) entries.push(entryOf(path.join(dir, k, f), k))
  // 「记忆\」是人格/桌宠这类非 决策/坑 的要点存储，有就一起收（不强制）
  const memDir = path.join(dir, '记忆')
  if (fs.existsSync(memDir)) {
    for (const f of fs.readdirSync(memDir).filter((x) => x.endsWith('.md')).sort()) entries.push(entryOf(path.join(memDir, f), '记忆'))
  }
  // 「定论\」是 `沉淀` 产出的语义层（派生草案），一起进索引 ⇒ 神经元下钻能看到
  const disDir = path.join(dir, DISTILL_DIR)
  if (fs.existsSync(disDir)) {
    for (const f of fs.readdirSync(disDir).filter((x) => x.endsWith('.md')).sort()) entries.push(entryOf(path.join(disDir, f), DISTILL_DIR))
  }
  // 「归档\」也进索引（2026-11-14）：不再"搬进归档=全忘"——不注入、不默认召回，但机器仍看得到（半记得）
  const arcDir = path.join(dir, '归档')
  if (fs.existsSync(arcDir)) {
    for (const f of fs.readdirSync(arcDir).filter((x) => x.endsWith('.md')).sort()) entries.push(entryOf(path.join(arcDir, f), '归档'))
  }
  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  const out = { version: 1, scene: path.basename(dir), generatedAt: new Date().toISOString(), entries }
  fs.writeFileSync(path.join(dir, '_索引.json'), JSON.stringify(out, null, 2) + '\n', 'utf8')
  sceneRegUpsert(path.basename(dir), entries.length)     // 场景目录：神经元靠它把新场景画进来
  if (!quiet) console.log(`✓ 索引已写：${path.basename(dir)}\\_索引.json（${entries.length} 条）`)
  return 0
}

/* --------------------------------------------------- 沉淀（情景 → 定论，2026-11-13）
//  人脑会把一条条经历压成规律；原来只有 85 条按日期的情景记录，没有"定论"层。
//  `沉淀` 按标题相似度把同主题条目聚类（≥3 条才成篇），把各条的「要点」抽取去重写成
//  `定论\<主题>.md`（草案，带来源指针）。不手改原文，只做派生的摘要层。
*/
const DISTILL_DIR = '定论'

/** 一条记忆的要点：`## 要点` 下的 `- xxx` 优先；否则取 frontmatter description + 正文前两句 */
function bulletsOfFile(file) {
  const t = fs.readFileSync(file, 'utf8')
  const fm = (t.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
  const out = []
  const desc = (fm.match(/^description:[ \t]*(.+)$/m) || [])[1]
  if (desc) out.push(desc.trim())
  const body = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const sec = body.match(/##[ \t]*要点\r?\n([\s\S]*?)(?=\r?\n##[ \t]|\r?\n#\s|$)/)
  if (sec) {
    sec[1].split(/\r?\n/).forEach((l) => {
      const m = l.match(/^[-*][ \t]+(.+)/)
      if (m) out.push(m[1].trim())
    })
  } else {
    body.split(/\r?\n/)
      .filter((l) => l.trim() && !/^#/.test(l) && !/^>/.test(l))
      .join(' ')
      .split(/[。；]/)
      .forEach((s) => { if (s.trim().length >= 8) out.push(s.trim()) })
  }
  return out.slice(0, 4)
}

/** 简易最长公共子串（给主题起名；没有 4 字以上就退回最高频二元词） */
function lcsOf2(a, b) {
  const A = String(a || ''), B = String(b || '')
  let best = ''
  for (let i = 0; i < A.length; i++) {
    for (let j = i + best.length + 1; j <= A.length; j++) {
      const s = A.slice(i, j)
      if (B.includes(s)) { if (s.length > best.length) best = s } else break
    }
  }
  return best
}

const BAD_TOPIC = new Set(['mjs', 'json', 'js', 'md', 'txt', 'log', 'yml', 'yaml', 'ps1', 'exe', 'cmd', 'bat', 'html', 'css'])

/** 标题聚类（2026-11-13 改）：不用"两两相似 + 并查集"——40 条会被链成一个巨簇。
 *  改成"主题种子"：取中等频次的词（≥min、≤8 条），把这个词命中的条目收成一组；
 *  组内最多 8 条、组间不重叠。宁可少沉淀，也不把不相干的事糊成一篇。 */
function clustersOf(entries, min, max = 8) {
  const G = entries.map((e) => gramsOfTitle(e.title + ' ' + (Array.isArray(e.tags) ? e.tags.join(' ') : '')))
  const df = {}
  G.forEach((g) => g.forEach((x) => { df[x] = (df[x] || 0) + 1 }))
  const seeds = Object.keys(df).filter((g) => df[g] >= min && df[g] <= max && !BAD_TOPIC.has(g))
    .sort((a, b) => df[b] - df[a] || b.length - a.length)
  const used = new Set()
  const groups = []
  for (const g of seeds) {
    const idx = entries.map((_, i) => i).filter((i) => !used.has(i) && G[i].has(g))
    if (idx.length < min) continue
    idx.forEach((i) => used.add(i))
    groups.push(idx.map((i) => entries[i]))
  }
  return groups
}

/** 给一组条目起主题名：组内高频且较长的中文短语（df × 长度²），够 3 字才用；否则退回最长公共子串 */
function topicOf(group) {
  const df = {}
  const add = (s) => { if (s) df[s] = (df[s] || 0) + 1 }
  group.forEach((e) => {
    const t = String(e.title || '').toLowerCase()
    for (const r of t.match(/[\u4e00-\u9fff]+/g) || []) {
      for (let len = 2; len <= 5; len++) {
        for (let i = 0; i + len <= r.length; i++) {
          const s = r.slice(i, i + len)
          if (TITLE_STOP.has(s) || /^(的|了|在|是|和|与|把|被|给)/.test(s)) continue
          add(s)
        }
      }
    }
    ;(t.match(/[a-z0-9][a-z0-9_.-]{2,}/g) || []).forEach((w) => {
      const s = w.replace(/\.[a-z0-9]+$/, '')       // renderers.js → renderers，别把扩展名当主题
      if (s.length >= 3 && !BAD_TOPIC.has(s)) add(s)
    })
  })
  const best = Object.keys(df).filter((s) => df[s] >= 2 && !BAD_TOPIC.has(s))
    .sort((a, b) => (df[b] * b.length * b.length) - (df[a] * a.length * a.length) || b.length - a.length)[0]
  if (best && best.length >= 3) return best.slice(0, 16)
  // 没有够长的公共短语：用两条最像标题的最长公共子串兜底
  let lcs = ''
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const s = lcsOf2(group[i].title, group[j].title).replace(/^[-_·\s]+|[-_·\s]+$/g, '')
      if (s.length > lcs.length) lcs = s
    }
  }
  if (lcs.length >= 3) return lcs.slice(0, 16)
  if (lcs.length >= 3) return lcs.slice(0, 16)
  return best && best.length >= 3 ? best.slice(0, 16) : ''
}

function cmdDistill(arg, opts = {}) {
  const quiet = !!opts.quiet
  const log = quiet ? () => {} : console.log
  const all = process.argv.slice(2).includes('--all')
  const min = Number(val('--min')) || 3
  const dry = process.argv.slice(2).includes('--dry')
  const force = process.argv.slice(2).includes('--force')
  const names = all
    ? (readSceneReg().scenes || []).map((s) => s.name)
    : [findSceneDir(arg) || arg].filter(Boolean)
  if (!names.length) { console.error('✗ 缺 --场景 <目录名>（或 --all）'); return 2 }
  let made = 0
  for (const name of names) {
    const dir = path.join(MEMROOT, name)
    if (!fs.existsSync(dir)) { console.error('✗ 找不到场景目录：' + name); continue }
    if (!fs.existsSync(path.join(dir, '_索引.json'))) cmdIndex(name, true)
    let entries = []
    try { entries = (JSON.parse(fs.readFileSync(path.join(dir, '_索引.json'), 'utf8')).entries || []) } catch {}
    entries = entries.filter((e) => ['决策', '坑', '通知', '记忆'].includes(String(e.kind)))
    const groups = clustersOf(entries, min)
    if (!groups.length) { log(`· ${name}：没有 ≥${min} 条的同主题簇（不用沉淀）`); continue }
    const outDir = path.join(dir, DISTILL_DIR)
    for (const g of groups) {
      const topic = topicOf(g)
      if (!topic) { log(`· ${name}：一簇 ${g.length} 条找不到明确主题名，跳过（不硬造词）`); continue }
      // 文件名安全：标题里的 / \ : * ? " < > | 不能进文件名
      const safe = topic.replace(/[\\/:*?"<>|\r\n]/g, '·').replace(/[.\s]+$/g, '').slice(0, 20) || '同主题'
      const file = safe + '.md'
      const abs = path.join(outDir, file)
      const srcs = g.map((e) => ({ date: e.date, title: e.title, rel: e.path, kind: e.kind }))
      if (fs.existsSync(abs) && !force) { log(`· ${name}：跳过已有 定论\\${file}（来源 ${g.length} 条；要重算加 --force）`); continue }
      if (fs.existsSync(abs) && /^status:[ \t]*confirmed/m.test(fs.readFileSync(abs, 'utf8'))) {
        log(`· ${name}：跳过已确认的 定论\\${file}（confirmed 不再自动覆盖）`); continue
      }
      // 结论只收「被 ≥2 条来源重复说到」的点，避免把各说各的原文堆成 8 条噪声
      const cand = []
      g.forEach((e) => {
        const p = path.join(dir, String(e.path || ''))
        if (/\.md$/i.test(p) && fs.existsSync(p)) {
          bulletsOfFile(p).forEach((b) => cand.push({ b, src: String(e.path) }))
        }
      })
      const cons = []
      cand.forEach((x) => {
        const hit = cons.find((c) => simOf(c.b, x.b) >= 0.55)
        if (hit) hit.srcs.add(x.src)
        else cons.push({ b: x.b, srcs: new Set([x.src]) })
      })
      const pick = cons.filter((c) => c.srcs.size >= 2).sort((a, b) => b.srcs.size - a.srcs.size).slice(0, 6)
      // 每条来源留一句摘要：同主题的 7 条放在一页能顺着看，这就是"巩固"最小可用的形态
      const srcLines = g.map((e) => {
        const p = path.join(dir, String(e.path || ''))
        let gist = ''
        if (/\.md$/i.test(p) && fs.existsSync(p)) gist = (bulletsOfFile(p)[0] || '').replace(/\s+/g, ' ')
        return { date: e.date, title: e.title, rel: e.path, gist: gist.slice(0, 140) }
      })
      if (dry) { log(`[dry] ${name} → 定论\\${file}（${g.length} 条来源 · ${pick.length} 条共识）`); continue }
      // 证据用源条目要点原文（verifyEvidence 的 includes 能命中），不再拿标题前 8 个字当摆设（2026-11-14）
      //   只取第一行、原样截断：跨行拼接的片段在文件里找不到，会造成"假失效"
      const evRefs = []
      for (const s of srcs.slice(0, 2)) {
        const sp = path.join(dir, s.rel)
        if (!fs.existsSync(sp)) continue
        const bl = bulletsOfFile(sp)[0]
        evRefs.push('  - ' + sp.replace(/\\/g, '/') + '::' + (bl ? bl.split(/\r?\n/)[0].trim().slice(0, 60) : s.title))
      }
      fs.mkdirSync(outDir, { recursive: true })
      const lines = [
        '---',
        'kind: 定论',
        'topic: ' + topic,
        'date: ' + dayStr(),
        'status: draft',
        'generated_by: 工具/场景记忆.mjs 沉淀',
        'tags:',
        '  - 定论',
        '  - ' + topic.slice(0, 12),
        'sources:',
        ...srcs.map((s) => '  - ' + s.rel.replace(/\\/g, '/')),
        'evidence:',
        ...evRefs,
        '---',
        '# ' + topic,
        '',
        '> 由 ' + g.length + ' 条同主题记忆自动汇总的**草案**：`## 摘要` 每条来源一句，方便一页看完全貌。',
        '> AI/用户归纳后请写进 `## 结论` 并把 `status` 改成 `confirmed`（confirmed 不会被 `沉淀 --force` 覆盖）；`sources/topic` 由工具维护。',
        '',
        '## 摘要',
        '',
        ...srcLines.map((s) => '- ' + s.date + ' ' + s.title + (s.gist ? ('：' + s.gist) : '') + ' · `' + s.rel + '`'),
        '',
        '## 结论',
        '',
        ...(pick.length
          ? pick.map((c) => '- ' + c.b + '（来源 ' + c.srcs.size + ' 条）')
          : ['- （待归纳：以上 ' + g.length + ' 条各说各的，需要一句共同结论；没有就不硬凑）']),
        '',
        '## 来源',
        '',
        ...srcs.map((s) => '- ' + s.date + ' ' + s.title + ' · `' + s.rel + '`'),
        '',
      ]
      fs.writeFileSync(abs, lines.join('\r\n'), 'utf8')
      // 巩固回链（2026-11-14）：给源条目写 consolidated_into ⇒ 整理/check 凭它发现"还被定论引用"，
      //   定论被手删/改名时 check 也能靠回链报断链
      for (const s of g) {
        const sp = path.join(dir, String(s.path || ''))
        if (!/\.md$/i.test(sp) || !fs.existsSync(sp)) continue
        const st = fs.readFileSync(sp, 'utf8')
        if (/^consolidated_into:/m.test(st)) continue
        const fmM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(st)
        if (!fmM) continue
        const rel = (DISTILL_DIR + '/' + file).replace(/\\/g, '/')
        fs.writeFileSync(sp, '---\r\n' + fmM[1].replace(/\s*$/, '') + '\r\nconsolidated_into: ' + rel + '\r\n---\r\n' + st.slice(fmM[0].length), 'utf8')
      }
      made++
      log(`✓ 沉淀：${name}\\定论\\${file}（${g.length} 条来源 → ${pick.length} 条结论）`)
    }
    if (!dry) cmdIndex(name, true)
  }
  if (opts.stats) opts.stats.made = made
  if (!quiet) console.log(made ? `\n✓ 本次沉淀 ${made} 篇（索引已同步）` : '\n· 本次没有新增定论')
  return 0
}

/* --------------------------------------------------- 召回（按需检索，2026-11-13）
//  场景层原来只能 `读 --节 §〇`，85 条分条没有检索入口；heat 只亮不排。
//  `召回` 在标题（×3）/标签（×2）/正文（×1）上算命中，叠 IDF 与 45 天热度，输出前 N 条。
//  2026-11-14：归档条目默认不召回（搬进归档≠全忘，--含归档 按 ×0.3 降权并标注）；expires 已过的条目不再召回。
*/
function cmdRecall(arg) {
  const all = process.argv.slice(2).includes('--all')
  const withArchive = flagOn('--含归档')
  const q = (val('--词') || val('--query') || '').trim()
  if (!q) { console.error('✗ 缺 --词 "<关键词>"（如 召回 --场景 命令 --词 "场景目录"）'); return 2 }
  const limit = Number(val('--条')) || 8
  const names = all
    ? (readSceneReg().scenes || []).map((s) => s.name)
    : [findSceneDir(arg) || arg].filter(Boolean)
  if (!names.length) { console.error('✗ 缺 --场景 <目录名>（或 --all）'); return 2 }
  const grams = gramsOfTitle(q)
  const words = (String(q).toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) || [])
  const rows = []
  for (const name of names) {
    const dir = path.join(MEMROOT, name)
    if (!fs.existsSync(dir)) continue
    if (!fs.existsSync(path.join(dir, '_索引.json'))) cmdIndex(name, true)
    let entries = []
    try { entries = (JSON.parse(fs.readFileSync(path.join(dir, '_索引.json'), 'utf8')).entries || []) } catch {}
    for (const e of entries) {
      // 归档默认不召回；--含归档 时 ×0.3 降权并标注（2026-11-14：半记得 ≠ 和活条目同权）
      const isArc = String(e.kind) === '归档'
      if (isArc && !withArchive) continue
      // 过期条目（expires 已过）不再召回：临时约定该失效了
      if (e.expires && String(e.expires) < dayStr()) continue
      const title = String(e.title || '')
      const tags = (Array.isArray(e.tags) ? e.tags : []).map(String)
      const file = path.join(dir, String(e.path || ''))
      let body = ''
      try { body = fs.readFileSync(file, 'utf8') } catch {}
      const tG = gramsOfTitle(title + ' ' + tags.join(' '))
      let hit = 0
      grams.forEach((g) => { if (tG.has(g)) hit += 3 })
      for (const w of words) { if ((title + ' ' + tags.join(' ')).toLowerCase().includes(w)) hit += 3 }
      grams.forEach((g) => { if (body.includes(g)) hit += 1 })
      if (!hit) continue
      const days = e.date ? Math.max(0, (Date.now() - Date.parse(e.date)) / 86400000) : 60
      const heat = Math.exp(-days / 45)
      rows.push({ scene: name, kind: String(e.kind || ''), title, date: e.date || '', path: file, rel: e.path, score: (hit + 0.6 * heat) * (isArc ? 0.3 : 1), archived: isArc })
    }
  }
  rows.sort((a, b) => b.score - a.score)
  const top = rows.slice(0, limit)
  if (!top.length) { console.log(`· 召回「${q}」：0 条命中（场景 ${names.join('/')}）`); return 0 }
  console.log(`召回「${q}」· 命中 ${rows.length} 条，取前 ${top.length}：`)
  top.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${r.score.toFixed(1)}] ${r.date} ${r.scene}/${r.kind} · ${r.title}` + (r.archived ? '（归档，降权）' : ''))
    console.log(`      ${r.path}`)
  })
  // 记账：召回有没有被真的调用，事后可查（不写进正文）
  try {
    const log = path.join(MEMROOT, '_共享记忆', '_召回.log')
    fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), q, scenes: names, hits: rows.length, top: top.map((r) => r.rel) }) + '\n', 'utf8')
  } catch {}
  return 0
}

/* --------------------------------------------------- 拆（一次性还债，可 dry） */

function cmdSplit(arg) {
  const name = findSceneDir(arg) || arg
  const dir = path.join(MEMROOT, name)
  const main = path.join(dir, '场景私有记忆.md')
  if (!fs.existsSync(main)) { console.error('✗ 找不到 ' + main + '（先跑 init）'); return 2 }
  const text = fs.readFileSync(main, 'utf8')

  // 1. 找 §五 并按条目切；只有「日期开头的条目」能拆成文件，其余原样保留在 §五（绝不静默丢内容）
  const sec = sectionOf(text, '五|坑与决策')
  if (!sec) { console.error('✗ 找不到 §五 段（## 五、坑与决策）'); return 3 }
  const all = bulletsOf(sec.body)
  const DATED = /^-\s*\d{4}-\d{2}-\d{2}/
  const dated = all.filter((b) => DATED.test(b.text))
  const keep = all.filter((b) => !DATED.test(b.text)).map((b) => b.text)
  if (!dated.length) { console.log('· ' + name + '：§五 没有日期条目（已是下标或只有备注）⇒ 不用拆'); return 0 }
  const plans = dated.map((b) => { const m = metaOfBullet(b.text); return { ...m, file: m.date + '-' + slugOf(m.title) + '.md' } })

  // 2. 计划与对账（先打印，--dry 到此为止）
  const origBytes = Buffer.byteLength(sec.body)
  const newBytes = plans.reduce((s, p) => s + Buffer.byteLength(p.body) + 160, 0)
  console.log('\n' + name + '：§五 ' + origBytes + ' B / ' + plans.length + ' 条 → 决策 ' + plans.filter((p) => p.kind === '决策').length + ' 篇 · 坑 ' + plans.filter((p) => p.kind === '坑').length + ' 篇（正文合计约 ' + newBytes + ' B）'
    + (keep.length ? ' · 另有 ' + keep.length + ' 条无日期备注原样保留' : ''))
  plans.forEach((p) => console.log('  ' + p.date + ' ' + p.kind + ' | ' + p.title + ' → ' + p.kind + '\\' + p.file))
  if (flagOn('--dry')) { console.log('\n[dry] 未落盘。确认后去掉 --dry 重跑。'); return 0 }

  // 3. 原文整份进 归档\（只进不改），再逐条落盘；同名自动加序号，绝不覆盖既有条目
  const archName = `场景私有记忆-${stamp().replace(/[-: ]/g, '').slice(0, 12)}-拆分前.md`
  fs.writeFileSync(path.join(dir, '归档', archName), text, 'utf8')
  let wrote = 0
  for (const p of plans) {
    const sub = path.join(dir, p.kind)
    fs.mkdirSync(sub, { recursive: true })
    let file = p.file
    let n = 1
    while (fs.existsSync(path.join(sub, file))) file = p.file.replace(/\.md$/, '-' + (++n) + '.md')
    wrote++
    const fm = ['---', 'title: ' + p.title, 'date: ' + p.date,
      'tags: [' + [p.kind, p.tag].filter(Boolean).join(', ') + ']', 'source: 场景私有记忆.md §五（' + dayStr() + ' 拆分）']
    const ev = evidenceOf(p.body)
    if (ev.length) fm.push('evidence:', ...ev.map((e) => '  - ' + e))
    fm.push('---')
    fs.writeFileSync(path.join(sub, file), fm.join('\r\n') + '\r\n\r\n# ' + p.title + '\r\n\r\n' + p.body.replace(/\r?\n/g, '\r\n') + '\r\n', 'utf8')
    indexAdd(dir, p.kind + '\\' + file, p.title)
  }
  // 4. §五 换成下标（正文已在分条文件里；无日期备注原样带上）
  const pointer = renderPointerSec(dir, '一条一个文件（' + dayStr() + ' 从 §五 拆分，原文整份在 `归档\\' + archName + '`）。', keep)
  const lines = text.split(/\r?\n/)
  const rebuilt = lines.slice(0, sec.start).join('\r\n') + '\r\n' + pointer + '\r\n' + lines.slice(sec.end).join('\r\n')
  fs.writeFileSync(main, rebuilt, 'utf8')
  cmdIndex(name, true)
  console.log('✓ 已拆：' + plans.length + ' 条 → 分条目录 · 原文归档 归档\\' + archName)
  console.log('✓ §五 已换成下标（' + Buffer.byteLength(renderPointerSec(dir)) + ' B）：' + (Buffer.byteLength(rebuilt) / 1024).toFixed(1) + ' KB 主文件')
  if (cmdCheck(name) !== 0) { console.error('✗ 已拆分但自检未过 → 按上面的条目修完'); return 1 }
  return 0
}

/* --------------------------------------------------- 整理（旧条目搬 归档\） */

/* 2026-11-14（防断链）：整理搬归档前先算"被引用集合"——
//  ① 定论\*.md 的 sources 指向的条目；② 活条目 evidence 指向本场景记忆文件本身的引用。
//  被引用的旧条目不搬：一搬，定论来源/证据立刻悬空（归档只进不改，回退还得手搬）。
//  真要连它们一起归档：先改写引用，或加 --强搬（check 会把悬空的定论来源报出来）。 */
function refsOfScene(dir) {
  const refs = new Set()
  const disDir = path.join(dir, DISTILL_DIR)
  if (fs.existsSync(disDir)) {
    for (const f of fs.readdirSync(disDir).filter((x) => x.endsWith('.md'))) {
      const txt = fs.readFileSync(path.join(disDir, f), 'utf8')
      const srcs = ((txt.match(/^sources:\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/m) || [])[1] || '')
        .split(/\r?\n/).map((s) => s.replace(/^[ \t]*-[ \t]*/, '').trim()).filter(Boolean)
      for (const s of srcs) refs.add(path.resolve(path.join(dir, s.replace(/\//g, path.sep))))
    }
  }
  for (const k of KINDS) for (const f of kindFiles(dir, k)) {
    const txt = fs.readFileSync(path.join(dir, k, f), 'utf8')
    for (const ref of evidenceOf(txt)) {
      const p = String(ref).split('::')[0]
      const abs = path.isAbsolute(p)
        ? p
        : [WORKBENCH_ROOT, path.resolve(WORKBENCH_ROOT, '..')].map((b) => path.join(b, p)).find((x) => fs.existsSync(x))
      if (abs && path.resolve(abs).startsWith(path.resolve(dir) + path.sep)) refs.add(path.resolve(abs))
    }
  }
  return refs
}

function cmdTidy(arg) {
  const name = findSceneDir(arg) || arg
  const dir = path.join(MEMROOT, name)
  if (!fs.existsSync(dir)) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const days = Number(val('--days') || KIND_OLD_DAYS)
  const cut = dayStr(new Date(Date.now() - days * 86400000))
  const moved = []
  for (const k of KINDS) {
    for (const f of kindFiles(dir, k)) {
      const d = (f.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1]
      if (d && d < cut) moved.push({ k, f })
    }
  }
  console.log('\n' + name + '：' + days + ' 天前（<' + cut + '）' + moved.length + ' 篇待搬 归档\\')
  moved.forEach((m) => console.log('  ' + m.k + '\\' + m.f))
  if (!moved.length) return 0
  // 1. 搬前查引用：被 定论.sources / 他条 evidence 引用的不搬（--强搬 连它们一起搬，断链后果 check 会报）
  const refs = refsOfScene(dir)
  const skip = []
  const go = []
  for (const m of moved) {
    const abs = path.resolve(path.join(dir, m.k, m.f))
    if (refs.has(abs) && !flagOn('--强搬')) skip.push(m.k + '\\' + m.f)
    else go.push(m)
  }
  if (skip.length) {
    console.log('\n⏸ ' + skip.length + ' 篇被 定论.sources / 他条 evidence 引用，不搬（一搬就断链）：')
    skip.forEach((s) => console.log('  ' + s))
    console.log('   要么先改写引用再整理，要么加 --强搬 连它们一起归档（悬空的定论来源会被 check 报出来）')
  }
  if (flagOn('--dry')) { console.log('[dry] 将搬 ' + go.length + ' 篇、跳过 ' + skip.length + ' 篇。确认后去掉 --dry 重跑。'); return 0 }
  if (!go.length) { console.log('\n· 全部被引用、一篇未搬：先处理引用再整理'); return 0 }
  // 2. 搬剩余的 + 登记 + 重写 §五 下标 + 重建索引 + 自检
  for (const m of go) {
    fs.renameSync(path.join(dir, m.k, m.f), path.join(dir, '归档', m.f))
    indexAdd(dir, '归档\\' + m.f, '旧条目（自动整理搬入）', '留档')
  }
  const pointer = renderPointerSec(dir, '旧条目已搬 `归档\\`（<' + cut + '，' + go.length + ' 篇' + (skip.length ? '；' + skip.length + ' 篇被引用未搬' : '') + '）。')
  const text = fs.readFileSync(path.join(dir, '场景私有记忆.md'), 'utf8')
  const sec = sectionOf(text, '五|坑与决策')
  if (sec) {
    const lines = text.split(/\r?\n/)
    fs.writeFileSync(path.join(dir, '场景私有记忆.md'), lines.slice(0, sec.start).join('\r\n') + '\r\n' + pointer + lines.slice(sec.end).join('\r\n'), 'utf8')
  }
  cmdIndex(name, true)
  console.log('✓ 已搬 ' + go.length + ' 篇进 归档\\，§五 下标已重算')
  if (cmdCheck(name) !== 0) { console.error('✗ 已整理但自检未过'); return 1 }
  return 0
}

/* ------------------------------------------------------------------ 入口 */

const argv = process.argv.slice(2)
const cmd = argv[0]
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : '' }
const arg = val('--场景') || val('--scene') || ''

if (cmd === 'list' || !cmd) {
  const dirs = fs.existsSync(MEMROOT) ? fs.readdirSync(MEMROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name) : []
  let bad = 0
  for (const d of dirs.sort()) {
    const has = (f) => fs.existsSync(path.join(MEMROOT, d, f))
    const flag = (b) => (b ? '✓' : '✗')
    const line = `  ${d}   私有${flag(has('场景私有记忆.md'))} 身份${flag(has('身份卡.md'))} 画像${flag(has('场景画像.md'))} 项目${flag(has('项目记忆'))} 归档${flag(has('归档'))}`
    if (!(has('身份卡.md') && has('场景画像.md'))) bad++
    console.log(line)
  }
  console.log(`\n共 ${dirs.length} 个场景；缺身份卡/画像 ${bad} 个`)
  // 例外场景（清单见 场景记忆-例外.json）：在标准根下没有目录，单列一行
  for (const ex of readExceptions().values()) {
    const miss = (ex.roots || []).filter((r) => !fs.existsSync(r.path))
    console.log(`  例外 ${ex.id}（${ex.title || ''}）  记忆根 ${(ex.roots || []).length} 个 ${miss.length ? '✗ 缺 ' + miss.length : '✓'}`)
  }
  process.exit(0)
}

if (cmd === 'check' && argv.includes('--all')) {
  let n = 0
  for (const d of fs.readdirSync(MEMROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort()) {
    if (!sceneOf(d)) { console.log('\n' + d + '：跳过（不是场景目录，没有对应场景 json）'); continue }
    n += cmdCheck(d) ? 1 : 0
  }
  // 例外场景（清单见 场景记忆-例外.json）：标准根下没有目录，但一样要 check
  for (const ex of readExceptions().values()) n += cmdCheckException(ex.id, ex) ? 1 : 0
  // 1. 数据契约版本（2026-11-13）：⚠ 不阻断，但每次 check --all 都提醒——老数据撞新工具是最常见的"换机后莫名其妙"来源
  if (!fs.existsSync(MEM_SCHEMA_FILE)) {
    console.log('⚠ _共享记忆\\schema.json 不存在：跑 工具\\记忆打包.mjs 升版 落地记忆数据契约版本')
  } else {
    try {
      const sv = JSON.parse(fs.readFileSync(MEM_SCHEMA_FILE, 'utf8')).schemaVersion || 0
      if (sv < MEM_SCHEMA_VERSION) console.log('⚠ 记忆数据 schema v' + sv + ' 比工具期望旧（v' + MEM_SCHEMA_VERSION + '）：跑 工具\\记忆打包.mjs 升版')
      else if (sv > MEM_SCHEMA_VERSION) console.log('⚠ 记忆数据 schema v' + sv + ' 比本工具新：换新工具再写数据，别用旧工具降级')
    } catch { console.log('⚠ _共享记忆\\schema.json 读不动：跑 工具\\记忆打包.mjs 升版 重写') }
  }
  process.exit(n ? 1 : 0)
}

// `索引 --all` / `沉淀 --all` / `召回 --all` 不需要 --场景
if (!arg && !(argv.includes('--all') && ['索引', 'index', '沉淀', 'distill', '召回', 'recall'].includes(cmd))) { console.error('用法：node 场景记忆.mjs <init|stamp|交接|check|list|读|写|待确认|确认|收工|拆|整理|索引|沉淀|召回> --场景 <目录名>（索引/check/沉淀/召回 支持 --all）'); process.exit(2) }

if (cmd === 'list') process.exit(0)
if (cmd === 'init') process.exit(cmdInit(arg))
if (cmd === '读' || cmd === 'read') process.exit(cmdRead(arg, { sec: val('--节') || val('--sec') }))
if (cmd === 'stamp') process.exit(cmdStamp(findSceneDir(arg) || arg))
if (cmd === '交接' || cmd === 'handover') process.exit(cmdHandover(arg))
// 2026-11-13：写一条 / 拆 §五 / 整理旧条目——让「记忆别长成一坨」有命令可用，而不是靠文档劝
if (cmd === '写' || cmd === 'write') process.exit(cmdWrite(arg))
// 2026-11-13（用户要求：拿不准先问，别把错误/模糊记忆写死）：不确定进队列，确认后转正；收工一条命令
if (cmd === '待确认' || cmd === 'pending') process.exit(cmdPending(arg))
if (cmd === '确认' || cmd === 'confirm') process.exit(cmdConfirm(arg))
if (cmd === '收工' || cmd === 'finish') process.exit(cmdFinish(arg))
if (cmd === '拆' || cmd === 'split') process.exit(cmdSplit(arg))
if (cmd === '整理' || cmd === 'tidy') process.exit(cmdTidy(arg))
if (cmd === '索引' || cmd === 'index') process.exit(argv.includes('--all') ? cmdIndexAll() : cmdIndex(arg))
// 2026-11-13：巩固（情景→定论）与按需检索（场景层召回）
if (cmd === '沉淀' || cmd === 'distill') process.exit(cmdDistill(arg))
if (cmd === '召回' || cmd === 'recall') process.exit(cmdRecall(arg))
if (cmd === 'check') {
  const ex = exceptionOf(arg)
  if (ex && ex.handler === 'oa') process.exit(cmdCheckOa())
  process.exit(cmdCheck(findSceneDir(arg) || arg))
}
console.error('未知命令：' + cmd)
process.exit(2)
