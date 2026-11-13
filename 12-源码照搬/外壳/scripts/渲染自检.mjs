#!/usr/bin/env node
// 渲染自检.mjs — 用假 DOM 在 Node 里整份加载 renderers.js，跑到末尾断言 APP_RENDERERS，
// 再真调 renderers.neuron：模拟双击项目节点进入下钻、ESC 返回，防止「语法能过、运行时炸」。
// 运行：node 外壳\scripts\渲染自检.mjs

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(HERE, '..', 'renderer', 'renderers.js')
const code = fs.readFileSync(FILE, 'utf8')

const noop = () => {}
const ctx2d = new Proxy({}, {
  get(t, k) {
    if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop })
    if (k === 'measureText') return () => ({ width: 10 })
    return typeof k === 'string' ? noop : undefined
  },
  set() { return true }
})

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.style = {}
    this.dataset = {}
    this.classList = { add: noop, remove: noop, toggle: noop, contains: () => false }
    this.clientWidth = 800
    this.clientHeight = 600
    this.width = 800
    this.height = 600
    this.value = ''
    this.textContent = ''
    this.innerHTML = ''
    this._h = {}
  }
  appendChild(c) { this.children.push(c); return c }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c }
  addEventListener(type, fn) { (this._h[type] = this._h[type] || []).push(fn) }
  removeEventListener(type, fn) { this._h[type] = (this._h[type] || []).filter(x => x !== fn) }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 } }
  getContext() { return ctx2d }
  querySelector() { return null }
  querySelectorAll() { return [] }
  focus() {}
  remove() {}
  contains() { return false }
  setPointerCapture() {}
  closest() { return null }
}

const body = new El('div')
const head = new El('div')
const doc = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ textContent: t }),
  addEventListener: noop,
  removeEventListener: noop,
  documentElement: { dataset: { theme: 'dark' } },
  body,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null
}
const win = {
  app: {},
  _h: {},
  devicePixelRatio: 1,
  addEventListener(type, fn) { (this._h[type] = this._h[type] || []).push(fn) },
  removeEventListener(type, fn) { this._h[type] = (this._h[type] || []).filter(x => x !== fn) },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { href: 'http://127.0.0.1/', search: '' },
  performance: { now: () => 0 },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop })
}

// 假数据：一个项目 + 一份 memory 索引（路径与 renderer 里的拼接一字不差）
const MEM = 'D:\\mem'
const fixtures = {
  [MEM + '\\_共享记忆\\索引.json']: JSON.stringify({ areas: [{ id: 'code-dev', name: '程序开发', owner: 'cd-ai', file: 'areas/code-dev.md', memory: '场景记忆/程序开发' }] }),
  [MEM + '\\_共享记忆\\项目.json']: JSON.stringify({ projects: [{ name: '演示项目', paths: ['D:\\demo'], owner: '程序开发', status: 'active', aliases: [], memoryRoot: 'D:\\demo', memoryIndex: 'D:\\demo\\memory\\_索引.json' }] }),
  [MEM + '\\_共享记忆\\记忆地图.json']: JSON.stringify({ areas: [], projects: [] }),
  [MEM + '\\_共享记忆\\areas\\code-dev.md']: '# 程序开发\n',
  'D:\\demo\\memory\\_索引.json': JSON.stringify({ version: 1, docs: [
    { path: 'pitfalls/2026-11-11-坑一.md', category: 'pitfalls', title: '坑一', date: '2026-11-11' },
    { path: 'decisions/2026-11-11-决策一.md', category: 'decisions', title: '决策一', date: '2026-11-11' }
  ] })
}
win.app = {
  paths: { memRoot: MEM, skillDir: 'D:\\skills', projectRoots: [] },
  file: {
    read: (p) => Promise.resolve(fixtures[p] || ''),
    stat: () => Promise.resolve({ exists: true, size: 10 })
  }
}
const sandbox = {
  window: win,
  document: doc,
  navigator: { userAgent: 'node-render-selfcheck', clipboard: { writeText: noop } },
  localStorage: win.localStorage,
  performance: { now: () => 0 },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop,
  ResizeObserver: function () { this.observe = noop; this.disconnect = noop },
  MutationObserver: function () { this.observe = noop; this.disconnect = noop },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  fetch: () => Promise.reject(new Error('selfcheck: no network')),
  URL, Blob: function () {}, Event: function () {}, CustomEvent: function () {},
  Image: function () { this.src = '' },
  alert: noop, prompt: () => null, confirm: () => false
}
sandbox.globalThis = sandbox

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; return }
  fail++
  console.log('✗ ' + name + (detail ? ' — ' + detail : ''))
}
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30))

// 1. 整份加载到末尾
vm.runInNewContext(code, sandbox, { filename: 'renderers.js' })
const R = win.APP_RENDERERS
ok('加载后 window.APP_RENDERERS 存在', !!R)
ok('renderers.neuron 是函数', !!(R && typeof R.neuron === 'function'))
ok('renderers.harness / git 仍在', !!(R && typeof R.harness === 'function' && typeof R.git === 'function'))
ok('renderers.msgflow 已注册（社交场景消息流）', !!(R && typeof R.msgflow === 'function'))

// 2. 真调 neuron（假 body）
let cleanup = null
try {
  cleanup = R.neuron(body, {}, head)
  ok('renderers.neuron 可执行', body.children.length > 0, 'children=' + body.children.length)
  ok('下钻面包屑已挂上', body.children.some(c => c.className === 'kneu-crumb'))
} catch (e) {
  ok('renderers.neuron 可执行', false, (e && e.stack) || String(e))
}

// 3. 模拟双击项目节点 → 进入下钻（网格扫，命中即停）
await tick(60)
const cv = body.children.find(c => c.className === 'kneu-cv')
const crumb = body.children.find(c => c.className === 'kneu-crumb')
const crumbText = crumb && crumb.children.find(c => c.className === 'kneu-crumb-t')
const dbl = cv && (cv._h.dblclick || [])[0]
let hit = false
if (dbl) {
  outer:
  for (let x = 0; x < 800; x += 16) {
    for (let y = 0; y < 600; y += 16) {
      dbl({ clientX: x, clientY: y, stopPropagation: noop, preventDefault: noop })
      await tick(1)
      if (crumb && crumb.style.display === 'flex') { hit = true; break outer }
    }
  }
}
ok('双击项目节点进入下钻', hit, crumb ? 'display=' + crumb.style.display : 'no crumb')
ok('面包屑显示项目与篇数', !!(crumbText && /演示项目/.test(crumbText.textContent) && /2 篇/.test(crumbText.textContent)), crumbText && crumbText.textContent)

// 4. ESC 返回全局
const esc = (win._h.keydown || [])[0]
if (esc) esc({ key: 'Escape' })
await tick(30)
ok('ESC 退出下钻', !!(crumb && crumb.style.display === 'none'), crumb && crumb.style.display)

// 5. 社交场景消息流（msgflow）：真调一次，断言通道胶囊与消息行都画出来了
//    为什么要这一条：这个面板的数据来自主进程 IPC（social:flow），渲染层出问题时表现是「空格子」，
//    在界面里只能看到空白、看不出是没数据还是没渲染 —— 这里用假数据把链路钉住。
const mfBody = new El('div')
const mfHead = new El('div')
win.app.social = {
  flow: () => Promise.resolve({
    ok: true, at: Date.now(),
    session: { id: 's-demo', title: '社交', found: true, events: 22 },
    channels: [
      { key: 'qq', label: 'QQ', state: 'warn', detail: '桥接插件已装，协议端未起' },
      { key: 'feishu', label: '飞书', state: 'off', detail: 'dsh-im 未装' }
    ],
    messages: [
      { at: 1794535133557, role: 'them', text: '在吗' },
      { at: 1794535134634, role: 'her', text: '在' }
    ]
  })
}
let mfClean = null
try {
  mfClean = R.msgflow(mfBody, { id: 'so-msg', sessionId: 's-demo', sessionTitle: '社交' }, mfHead)
  await tick(60)
  const chips = mfBody.children.find(c => c.className === 'mf-chips')
  const list = mfBody.children.find(c => c.className === 'mf-list')
  ok('msgflow 可执行', mfBody.children.length >= 2, 'children=' + mfBody.children.length)
  ok('通道胶囊画出来了', !!(chips && chips.children.length === 3), chips ? 'chips=' + chips.children.length : 'no chips')
  ok('QQ 通道没通时画成 warn（不是绿的）', !!(chips && chips.children[0] && /is-warn/.test(chips.children[0].className)))
  ok('消息行画出来了', !!(list && list.children.length === 2), list ? 'rows=' + list.children.length : 'no list')
  ok('她回的那句靠右（is-her）', !!(list && list.children[1] && /is-her/.test(list.children[1].className)))
  // 桥接控制台（SnowLuma）不常驻面板：入口就是标题栏这颗按钮（2026-11-13 用户要求「设置按钮才打开」）
  ok('标题栏「⚙ 桥接」按钮挂上了', mfHead.children.some(c => c.tagName === 'BUTTON' && /桥接/.test(c.textContent)),
    mfHead.children.map(c => c.tagName + ':' + c.textContent).join('|'))
} catch (e) {
  ok('msgflow 可执行', false, (e && e.stack) || String(e))
}
if (typeof mfClean === 'function') mfClean()

if (typeof cleanup === 'function') cleanup()
console.log('渲染自检：' + pass + ' 项通过，' + fail + ' 项失败')
process.exit(fail ? 1 : 0)
