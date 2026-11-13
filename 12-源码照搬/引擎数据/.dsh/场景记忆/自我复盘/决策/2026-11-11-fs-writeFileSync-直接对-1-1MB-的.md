---
title: `fs.writeFileSync` 直接对 1.1MB 的 `renderers.js` 截断重写，正在运行的工作台若
description: 2026-11-11（写盘要原子）：`fs.writeFileSync` 直接对 1.1MB 的 `renderers.js` 截断重写，正在运行的工作台若此时重载就会读到半截。改法：写 `<file>.tmp` → `rename`（仓里
date: 2026-11-11
tags: [决策, 写盘要原子]
source: 场景私有记忆.md §五（2026-11-13 拆分）
consolidated_into: 定论/renderers.md
---

# `fs.writeFileSync` 直接对 1.1MB 的 `renderers.js` 截断重写，正在运行的工作台若

2026-11-11（写盘要原子）：`fs.writeFileSync` 直接对 1.1MB 的 `renderers.js` 截断重写，正在运行的工作台若此时重载就会读到半截。改法：写 `<file>.tmp` → `rename`（仓里 `kun:file:write` 已经这么做，脚本却没学）。
