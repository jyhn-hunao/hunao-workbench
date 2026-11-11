#!/usr/bin/env node
// 渲染自检.mjs — 用假 DOM 在 Node 里整份加载 renderers.js，跑到末尾断言 APP_RENDERERS，
// 再调一次 renderers.neuron，防止「语法能过、运行时炸」的白屏类事故。
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
    if (k === 'getImageData') return () => ({ data: [] })
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
  }
  appendChild(c) { this.children.push(c); return c }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c }
  addEventListener() {}
  removeEventListener() {}
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
  devicePixelRatio: 1,
  addEventListener: noop,
  removeEventListener: noop,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { href: 'http://127.0.0.1/', search: '' },
  performance: { now: () => 0 },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop })
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

// 1. 整份加载到末尾
vm.runInNewContext(code, sandbox, { filename: 'renderers.js' })
const R = win.APP_RENDERERS
ok('加载后 window.APP_RENDERERS 存在', !!R)
ok('renderers.neuron 是函数', !!(R && typeof R.neuron === 'function'))
ok('renderers.harness / git 仍在', !!(R && typeof R.harness === 'function' && typeof R.git === 'function'))

// 2. 真调一次 neuron（假 body），不许抛
try {
  const cleanup = R.neuron(body, {}, head)
  ok('renderers.neuron 可执行', body.children.length > 0, 'children=' + body.children.length)
  ok('下钻面包屑已挂上', body.children.some(c => c.className === 'kneu-crumb'))
  if (typeof cleanup === 'function') cleanup()
} catch (e) {
  ok('renderers.neuron 可执行', false, (e && e.stack) || String(e))
}

console.log('渲染自检：' + pass + ' 项通过，' + fail + ' 项失败')
process.exit(fail ? 1 : 0)
