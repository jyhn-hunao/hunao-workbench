---
title: `renderers.js` 的 blob 是 CRLF 为主 + 242 行 LF
description: 2026-11-11（混合行尾又踩）：`renderers.js` 的 blob 是 CRLF 为主 + 242 行 LF；`git add`（autocrlf=true）会把整文件规范化成 LF ⇒ diff 从 66 行变 19276 
date: 2026-11-11
tags: [坑, 混合行尾又踩]
source: 场景私有记忆.md §五（2026-11-13 拆分）
consolidated_into: 定论/renderers.md
---

# `renderers.js` 的 blob 是 CRLF 为主 + 242 行 LF

2026-11-11（混合行尾又踩）：`renderers.js` 的 blob 是 CRLF 为主 + 242 行 LF；`git add`（autocrlf=true）会把整文件规范化成 LF ⇒ diff 从 66 行变 19276 行。改法：这类文件用 `git -c core.autocrlf=false add` 暂存，再 `git diff --cached --numstat` 复核。
