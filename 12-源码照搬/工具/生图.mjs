#!/usr/bin/env node
// 生图.mjs —— 「创意工坊」里出概念图的唯一命令行入口（Seedream / 火山方舟）
//
// 为什么要有：引擎会话自己不产图，全靠这条命令把「提示词 + 可选参考图」换成真 PNG 落盘。
//   原画概念岗出三视图/气氛图 → 走这里；美术指导审图也看这里产出的文件。
//
// 用法：
//   node 工具\生图.mjs probe                                    # 认环境：key 有没有、模型、连通性
//   node 工具\生图.mjs set-key --key "ark-xxxx"                 # 把 key 记进 机器配置.json（不进版本库）
//   node 工具\生图.mjs gen --prompt "<提示词>" --out "<路径.png>"  # 出一张
//   node 工具\生图.mjs gen --prompt "..." --out "..." --ref "<参考图.png|http(s)://...>" --size 2K
//   node 工具\生图.mjs gen --prompt "..." --out "..." --n 2      # 连出两张（分别落 _1/_2）
//   node 工具\生图.mjs gen --prompt "..." --dry                  # 只打印将要发的请求体，不发请求
//
// 约定：
//   · key 解析：环境变量 ARK_API_KEY > 机器配置.json 的 arkApiKey；都没有就直说"缺 key"，⛔ 不猜。
//   · 模型默认 doubao-seedream-4-5-251128（支持文生图 + 参考图，2K/4K）；可用 --model 覆盖。
//   · 参考图：本地文件自动转 data:image/<fmt>;base64；也可以直接给 http(s) URL。
//   · 返回用 b64_json（不依赖 24 小时外链），按魔数判断 png/jpeg 再落盘。
//   · 退出码：0 成功；1 失败（原因写 stderr，别把失败当成功）。

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { MACHINE, MACHINE_FILE, WORKBENCH_ROOT } from './环境.mjs'

const HOST = 'ark.cn-beijing.volces.com'
const API_PATH = '/api/v3/images/generations'
const DEFAULT_MODEL = 'doubao-seedream-4-5-251128'

const argv = process.argv.slice(2)
const cmd = String(argv[0] || '').trim()
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const has = (k) => argv.includes(k)
const die = (s) => { console.error('✗ ' + s); process.exit(1) }
const say = (s) => console.log(s)

// 1. 找 key：环境变量 > 机器配置（只报来源，不打印内容）
function resolveKey() {
  const env = String(process.env.ARK_API_KEY || '').trim()
  if (env) return { key: env, from: '环境变量 ARK_API_KEY' }
  const cfg = String(MACHINE.arkApiKey || '').trim()
  if (cfg) return { key: cfg, from: '机器配置 arkApiKey（' + MACHINE_FILE + '）' }
  return { key: '', from: '未配置（设 ARK_API_KEY，或 node 工具\\生图.mjs set-key --key "ark-…"）' }
}

// 2. HTTPS 请求（只用内置模块，不引第三方）
function postJson(body, key, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      host: HOST, path: API_PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: timeoutMs || 180000
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(chunks) } catch (e) { return reject(new Error('返回不是 JSON：' + chunks.slice(0, 300))) }
        if (res.statusCode !== 200) {
          const err = (json && json.error && (json.error.code || json.error.message)) || JSON.stringify(json).slice(0, 300)
          return reject(new Error('HTTP ' + res.statusCode + ' · ' + err))
        }
        resolve(json)
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时（' + timeoutMs + ' ms）')) })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// 3. 参考图：本地文件 → data URL；URL 原样透传
function toImageArg(p) {
  const s = String(p || '').trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  const abs = path.resolve(s)
  if (!fs.existsSync(abs)) die('参考图不存在：' + abs)
  const buf = fs.readFileSync(abs)
  if (buf.length > 10 * 1048576) die('参考图超过 10 MB（接口上限）：' + abs)
  const ext = path.extname(abs).toLowerCase()
  const fmt = ext === '.png' ? 'png' : (ext === '.webp' ? 'webp' : (ext === '.bmp' ? 'bmp' : 'jpeg'))
  return 'data:image/' + fmt + ';base64,' + buf.toString('base64')
}

// 4. 魔数判格式，落盘用对的后缀（接口默认 jpeg，别把 jpeg 存成 .png）
function saveImage(b64, outPath) {
  const buf = Buffer.from(String(b64 || ''), 'base64')
  if (!buf.length) throw new Error('返回里没有图片数据')
  let ext = '.png'
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) ext = '.jpg'
  else if (!(buf.length > 8 && buf.toString('hex', 0, 4) === '89504e47')) die('返回不是可识别的图片（前 8 字节：' + buf.toString('hex', 0, 8) + '）')
  let out = outPath
  if (!new RegExp(ext.replace('.', '\\.') + '$', 'i').test(out)) out = out.replace(/\.[A-Za-z0-9]+$/i, '') + ext
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(path.resolve(out), buf)
  return { file: path.resolve(out), bytes: buf.length, ext }
}

function cmdProbe() {
  const k = resolveKey()
  say('生图通道：火山方舟 Seedream')
  say('  接口：https://' + HOST + API_PATH)
  say('  模型：' + (String(MACHINE.imageModel || '').trim() || DEFAULT_MODEL) + (String(MACHINE.imageModel || '').trim() ? '（机器配置 imageModel）' : '（默认）'))
  say('  key：' + (k.key ? '已配置（来源 ' + k.from + '）' : k.from))
  say('  工程根：' + path.join(WORKBENCH_ROOT, '工作区', '创意工坊'))
  if (!k.key) { say('  ⇒ 缺 key 就出不了图：先 set-key（或设环境变量 ARK_API_KEY）'); return }
  say('  ⇒ 可用：node 工具\\生图.mjs gen --prompt "…" --out "概念\\<资产>\\concept_front.png"')
}

function cmdSetKey() {
  const key = String(val('--key', '')).trim()
  if (!key) die('用法：node 工具\\生图.mjs set-key --key "ark-…"')
  if (!/^[A-Za-z0-9._\-]{16,}$/.test(key)) die('key 形态不像方舟 API Key（长度/字符不对），拒绝写入')
  const cur = fs.existsSync(MACHINE_FILE) ? JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')) : {}
  cur.arkApiKey = key
  fs.writeFileSync(MACHINE_FILE, JSON.stringify(cur, null, 2) + '\n', 'utf8')
  say('✓ 已写入 ' + MACHINE_FILE + ' 的 arkApiKey（该文件是本机配置，不进版本库）')
}

async function cmdGen() {
  const prompt = String(val('--prompt', '')).trim()
  const out = String(val('--out', '')).trim()
  const model = String(val('--model', '')).trim() || String(MACHINE.imageModel || '').trim() || DEFAULT_MODEL
  const size = String(val('--size', '')).trim() || '2K'
  const n = Math.max(1, Math.min(4, Number(val('--n', '1')) || 1))
  const ref = toImageArg(val('--ref', ''))
  if (!prompt) die('缺 --prompt')
  if (prompt.length > 600) die('提示词超过 600 字（建议 ≤300 汉字），先精简再发')
  const body = {
    model: model,
    prompt: prompt,
    size: size,
    response_format: 'b64_json',
    watermark: false,
    sequential_image_generation: 'disabled'
  }
  if (ref) body.image = [ref]

  if (has('--dry')) { say('DRY 请求体（参考图已截断）：'); say(JSON.stringify(Object.assign({}, body, { image: ref ? ['<data-url ' + ref.length + ' 字符>'] : undefined }), null, 2)); return }
  if (!out) die('缺 --out（落盘路径，例：概念\\木箱\\concept_木箱_front.png）')

  const k = resolveKey()
  if (!k.key) die('缺 key：' + k.from)
  for (let i = 1; i <= n; i++) {
    const target = n === 1 ? out : out.replace(/(\.[A-Za-z0-9]+)$/, '_' + i + '$1')
    const t0 = Date.now()
    const json = await postJson(body, k.key)
    const item = (json.data || [])[0] || {}
    const saved = saveImage(item.b64_json, target)
    say('RESULT model=' + (json.model || model) + ' size=' + (item.size || size) + ' file=' + saved.file + ' bytes=' + saved.bytes + ' ms=' + (Date.now() - t0))
  }
}

async function main() {
  if (cmd === 'probe') return cmdProbe()
  if (cmd === 'set-key') return cmdSetKey()
  if (cmd === 'gen') return cmdGen()
  say('用法：')
  say('  node 工具\\生图.mjs probe')
  say('  node 工具\\生图.mjs set-key --key "ark-…"')
  say('  node 工具\\生图.mjs gen --prompt "…" --out "概念\\<资产>\\concept_front.png" [--ref <图>] [--size 2K|4K|WxH] [--n 1-4] [--model …] [--dry]')
  process.exit(cmd ? 1 : 0)
}

main().catch((e) => die(String((e && e.message) || e)))
