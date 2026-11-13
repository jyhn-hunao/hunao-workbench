// 记忆回响.mjs —— 把「每轮注入场景记忆」的引擎插件装进当前 profile（2026-11-13）
//
// 为什么不手改 profile：引擎升级会整目录替换，安装/回退要能一条命令重来。
// 用法：
//   node 工具\记忆回响.mjs --check          # 只看装没装、什么模式（只读）
//   node 工具\记忆回响.mjs --apply          # 拷插件 + 写 cordis.patch.yml（enforce）
//   node 工具\记忆回响.mjs --mode shadow    # 改成只记日志、不注入
//   node 工具\记忆回响.mjs --off            # 从 patch 里摘掉（下次重启生效）
// ⚠ 插件在引擎启动时加载：装完/改完必须重启整壳（⛔ 不要只重启引擎，token 会失效）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__HERE, '..', '..')                    // 工作台根
const SRC = path.join(__HERE, '..', '插件', '记忆回响')
const PROFILE = path.join(ROOT, '12-源码照搬', '引擎数据', '.dsh', 'profiles', 'web')
const DEST = path.join(PROFILE, 'node_modules', 'dsh-memory-recall')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const MARK = 'dsh-memory-recall'

const argv = process.argv.slice(2)
const mode = (argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : '') || ''
const on = (f) => argv.includes(f)

function patchText() {
  return fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : ''
}

function status() {
  const inst = fs.existsSync(path.join(DEST, 'index.js'))
  const inPatch = patchText().includes(MARK)
  const m = (patchText().match(new RegExp('name: "' + MARK + '"[\\s\\S]*?mode: (\\w+)')) || [])[1] || ''
  console.log('插件文件：' + (inst ? '已装 ' + DEST : '未装'))
  console.log('patch 登记：' + (inPatch ? '已登记' : '未登记'))
  console.log('注入模式：' + (m || (inPatch ? 'enforce（默认）' : '—')))
  console.log('profile：' + PROFILE)
  return inst && inPatch
}

function ensurePatch(m) {
  let text = patchText()
  if (text.includes(MARK)) {
    text = text.replace(new RegExp('(name: "' + MARK + '"[\\s\\S]*?mode: )\\w+'), '$1' + m)
    fs.writeFileSync(PATCH, text, 'utf8')
    return
  }
  const block = [
    '',
    '# ---- 2026-11-13 记忆回响：每轮用户发言前注入 §〇 / 近期 / 相关条目（工具\\记忆回响.mjs 装）----',
    '- insert:',
    '    - id: memory-recall',
    '      name: "' + MARK + '"',
    '      config:',
    '        mode: ' + m,
    '',
  ].join('\n')
  fs.writeFileSync(PATCH, text.replace(/\s*$/u, '\n') + block, 'utf8')
}

if (on('--check') || !argv.length) process.exit(status() ? 0 : 1)

if (on('--off')) {
  const text = patchText()
  if (!text.includes(MARK)) { console.log('· patch 里本来就没有 ' + MARK); process.exit(0) }
  const next = text.replace(/\n# ---- 2026-11-13 记忆回响[^\n]*\n- insert:\n    - id: memory-recall\n      name: "dsh-memory-recall"\n      config:\n        mode: \w+\n?/u, '\n')
  fs.writeFileSync(PATCH, next, 'utf8')
  console.log('✓ 已从 patch 摘除（重启整壳后不再加载；插件文件保留以便回装）')
  process.exit(0)
}

if (on('--mode')) {
  if (!['shadow', 'enforce'].includes(mode)) { console.error('✗ --mode 只认 shadow / enforce'); process.exit(2) }
  if (!patchText().includes(MARK)) { console.error('✗ 还没装（先 --apply）'); process.exit(2) }
  ensurePatch(mode)
  console.log('✓ 模式已改为 ' + mode + '（重启整壳后生效）')
  process.exit(0)
}

if (on('--apply')) {
  if (!fs.existsSync(path.join(SRC, 'index.js'))) { console.error('✗ 插件源不存在：' + SRC); process.exit(2) }
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.mkdirSync(DEST, { recursive: true })
  for (const f of fs.readdirSync(SRC)) {
    if (f === '自检.mjs') continue
    fs.copyFileSync(path.join(SRC, f), path.join(DEST, f))
  }
  ensurePatch(mode === 'shadow' ? 'shadow' : 'enforce')
  console.log('✓ 已装：' + DEST)
  console.log('✓ 已登记 cordis.patch.yml（mode=' + (mode === 'shadow' ? 'shadow' : 'enforce') + '）')
  console.log('⚠ 需要重启整壳才生效：双击 12-源码照搬\\启动.vbs（⛔ 不要只重启引擎）')
  process.exit(0)
}

console.error('用法：node 工具\\记忆回响.mjs --check | --apply | --mode shadow|enforce | --off')
process.exit(2)
