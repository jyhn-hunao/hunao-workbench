---
kind: 定论
topic: renderers
date: 2026-11-13
status: draft
generated_by: 工具/场景记忆.mjs 沉淀
tags:
  - 定论
  - renderers
sources:
  - 决策/2026-11-11-刷新面板-mjs-只热更-renderers-js-改.md
  - 决策/2026-11-11-fs-writeFileSync-直接对-1-1MB-的.md
  - 坑/2026-11-11-renderers-js-的-blob-是-CRLF-为主.md
evidence:
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/自我复盘/决策/2026-11-11-刷新面板-mjs-只热更-renderers-js-改.md::`刷新面板.mj
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/自我复盘/决策/2026-11-11-fs-writeFileSync-直接对-1-1MB-的.md::`fs.writ
---
# renderers

> 由 3 条同主题记忆自动汇总的**草案**：`## 摘要` 每条来源一句，方便一页看完全貌。
> AI/用户归纳后请写进 `## 结论` 并把 `status` 改成 `confirmed`（confirmed 不会被 `沉淀 --force` 覆盖）；`sources/topic` 由工具维护。

## 摘要

- 2026-11-11 `刷新面板.mjs` / ⟳ 只热更 `renderers.js`，改 `index.html` 的标签不算"热更"，要：2026-11-11（新增 `<script>` 标签必须重启）：`刷新面板.mjs` / ⟳ 只热更 `renderers.js`，改 `index.html` 的标签不算"热更"，要重启一次工作台；所以"我改了但界面没变"要区分是没生效 · `决策\2026-11-11-刷新面板-mjs-只热更-renderers-js-改.md`
- 2026-11-11 `fs.writeFileSync` 直接对 1.1MB 的 `renderers.js` 截断重写，正在运行的工作台若：2026-11-11（写盘要原子）：`fs.writeFileSync` 直接对 1.1MB 的 `renderers.js` 截断重写，正在运行的工作台若此时重载就会读到半截。改法：写 `<file>.tmp` → `rename`（仓里 · `决策\2026-11-11-fs-writeFileSync-直接对-1-1MB-的.md`
- 2026-11-11 `renderers.js` 的 blob 是 CRLF 为主 + 242 行 LF：2026-11-11（混合行尾又踩）：`renderers.js` 的 blob 是 CRLF 为主 + 242 行 LF；`git add`（autocrlf=true）会把整文件规范化成 LF ⇒ diff 从 66 行变 19276 · `坑\2026-11-11-renderers-js-的-blob-是-CRLF-为主.md`

## 结论

- （待归纳：以上 3 条各说各的，需要一句共同结论；没有就不硬凑）

## 来源

- 2026-11-11 `刷新面板.mjs` / ⟳ 只热更 `renderers.js`，改 `index.html` 的标签不算"热更"，要 · `决策\2026-11-11-刷新面板-mjs-只热更-renderers-js-改.md`
- 2026-11-11 `fs.writeFileSync` 直接对 1.1MB 的 `renderers.js` 截断重写，正在运行的工作台若 · `决策\2026-11-11-fs-writeFileSync-直接对-1-1MB-的.md`
- 2026-11-11 `renderers.js` 的 blob 是 CRLF 为主 + 242 行 LF · `坑\2026-11-11-renderers-js-的-blob-是-CRLF-为主.md`
