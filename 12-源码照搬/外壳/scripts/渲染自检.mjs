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

if (typeof cleanup === 'function') cleanup()
console.log('渲染自检：' + pass + ' 项通过，' + fail + ' 项失败')
process.exit(fail ? 1 : 0)
