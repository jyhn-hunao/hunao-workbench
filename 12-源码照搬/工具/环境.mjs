#!/usr/bin/env node
// 环境.mjs —— 机器层配置的唯一读取口（2026-11-12 跨机器移植改造）
//
// 为什么要有它：工作台里的「本机值」（盘符、项目根、端口、node 路径、引擎版本）原来散在
//   场景 json / 项目.json / 各脚本的默认值里，换一台机器就得逐个找、逐个改，漏一个就静默错位。
//   这里把本机值收成一份**不入库**的 `引擎数据\.dsh\机器配置.json`，其余地方只认逻辑名。
//
// 四档优先级（命中即停；第四档抛错，⛔ 不允许静默兜底 —— 见 AGENTS.md §5「不静默兜底」）：
//   1. 环境变量       DSH_WORKBENCH_ROOT / DSH_MACHINE_FILE / DSH_PORT / DSH_NODE …
//   2. 机器配置.json  引擎数据\.dsh\机器配置.json（本机生成，.gitignore 挡着）
//   3. 相对推导       按本文件位置推（工具\ → 工作台根）
//   4. 抛错           该报的错在归属层报，不把空值留给下游

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 1. 自身位置与工作台根（= 12-源码照搬；仓库根是它的上一级）
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WORKBENCH_ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..')
export const REPO_ROOT = path.resolve(WORKBENCH_ROOT, '..')
export const IS_WIN = process.platform === 'win32'

// 2. 机器配置文件（可用环境变量指到别处，便于同一台机放多个工作台实例）
export const MACHINE_FILE =
  process.env.DSH_MACHINE_FILE || path.join(WORKBENCH_ROOT, '引擎数据', '.dsh', '机器配置.json')

const DEFAULT_PORTS = { dsh: 3083, site: 31238, preview: 31240, webAi: 31239 }

// 3. 读机器配置：缺失或坏 JSON 一律返回 {}（不抛）。
//    它是「可选覆盖层」，缺了要退回相对推导；只有下游真的解析不到值时才抛。
export function machine() {
  try {
    const j = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

export const MACHINE = machine()

// 4. 引擎 home 与场景记忆根（脚本侧统一口径；这两个是运行时数据，跟着机器走）
export function dshHome() {
  return process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || path.join(WORKBENCH_ROOT, '引擎数据', '.dsh')
}
export function sceneMemoryRoot() {
  return process.env.DSH_SCENE_MEMORY || path.join(dshHome(), '场景记忆')
}

// 5. 端口：env > 机器配置 > 默认。
//    ⛔ 除这里与 启动.vbs / main.js 的默认值外，别处不许再写字面量端口。
export function port(name) {
  const envKey = { dsh: 'DSH_PORT', site: 'SITE_PORT', preview: 'PREVIEW_PORT', webAi: 'WEB_AI_PORT' }[name]
  if (envKey && process.env[envKey]) return Number(process.env[envKey])
  const fromFile = (MACHINE.ports || {})[name]
  if (fromFile) return Number(fromFile)
  if (DEFAULT_PORTS[name] === undefined) throw new Error('未知端口名：' + name + '（可用 ' + Object.keys(DEFAULT_PORTS).join(' / ') + '）')
  return DEFAULT_PORTS[name]
}

// 6. node 可执行文件：env > 机器配置 > PATH > 常见安装位
export function nodeExe() {
  if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE
  if (MACHINE.nodeExe && fs.existsSync(MACHINE.nodeExe)) return MACHINE.nodeExe
  const exeName = IS_WIN ? 'node.exe' : 'node'
  for (const d of String(process.env.Path || process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    const cand = path.join(d, exeName)
    if (fs.existsSync(cand)) return cand
  }
  if (IS_WIN && process.env.ProgramFiles) {
    const cand = path.join(process.env.ProgramFiles, 'nodejs', exeName)
    if (fs.existsSync(cand)) return cand
  }
  throw new Error('找不到 node：设 DSH_NODE，或在 ' + MACHINE_FILE + ' 里写 nodeExe')
}

// 7. 引擎版本：读引擎自己的 package.json（不入库的部分靠它对齐）
export function engineVersion() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WORKBENCH_ROOT, '引擎', 'package.json'), 'utf8'))
    return String(j.version || '')
  } catch {
    return ''
  }
}

// 8. 项目登记表（只读；写入由 环境适配.mjs / 接入项目.mjs 负责）
export function readProjectRegistry() {
  try {
    return JSON.parse(fs.readFileSync(path.join(sceneMemoryRoot(), '_共享记忆', '项目.json'), 'utf8'))
  } catch {
    return { projects: [] }
  }
}

// 9. 逻辑名 → 本机路径（先查机器配置的 projects，再查入库的项目登记表）
export function projectRoot(name) {
  const fromMachine = (MACHINE.projects || {})[name]
  if (fromMachine) return fromMachine
  const reg = readProjectRegistry()
  const hit = (reg.projects || []).find(
    (x) => x.name === name || (Array.isArray(x.aliases) && x.aliases.includes(name))
  )
  return hit && Array.isArray(hit.paths) && hit.paths[0] ? hit.paths[0] : ''
}

// 10. 必须存在：不存在就抛，报文必须能直接照着做
export function mustExist(p, label) {
  if (!p) throw new Error(label + '：解析结果为空（检查 ' + MACHINE_FILE + ' 与项目登记表）')
  if (fs.existsSync(p)) return p
  throw new Error(
    label + ' 不存在：' + p + '\n  处置：跑 node 外壳\\scripts\\环境适配.mjs --apply（重算本机路径），' +
      '或按 说明\\使用说明.md 把缺的文件补回来'
  )
}
