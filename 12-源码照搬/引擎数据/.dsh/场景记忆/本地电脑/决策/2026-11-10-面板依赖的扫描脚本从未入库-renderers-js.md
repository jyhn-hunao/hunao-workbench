---
title: 面板依赖的扫描脚本从未入库：`renderers.js:12288` 写的是 `scripts\pc-scan.mjs`
description: 2026-11-10 面板依赖的扫描脚本从未入库：`renderers.js:12288` 写的是 `scripts\pc-scan.mjs`，仓里没这个文件，所以三块面板一直显示"还没扫过"。已按面板实际读的字段补写（`items`/`b
date: 2026-11-10
tags: [决策]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# 面板依赖的扫描脚本从未入库：`renderers.js:12288` 写的是 `scripts\pc-scan.mjs`

2026-11-10 面板依赖的扫描脚本从未入库：`renderers.js:12288` 写的是 `scripts\pc-scan.mjs`，仓里没这个文件，所以三块面板一直显示"还没扫过"。已按面板实际读的字段补写（`items`/`byDrive`/`junk`/`junkTotalGb`/`scannedAt`/`tookSec`/`minGb`）。决定：面板继续只读快照，扫描全部在脚本里做 —— 渲染层没有列目录 IPC，面板不能自己扫盘。
