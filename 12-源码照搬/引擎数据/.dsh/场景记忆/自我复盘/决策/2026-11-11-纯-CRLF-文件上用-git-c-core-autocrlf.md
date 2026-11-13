---
title: 纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --nums
description: 2026-11-11（numstat 会骗人）：纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --numstat`，会把整文件报成 407 增/405 删——因为索引里存的是 L
date: 2026-11-11
tags: [决策, numstat 会骗人]
source: 场景私有记忆.md §五（2026-11-13 拆分）
consolidated_into: 定论/git.md
---

# 纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --nums

2026-11-11（numstat 会骗人）：纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --numstat`，会把整文件报成 407 增/405 删——因为索引里存的是 LF、工作区是 CRLF。别据此判"噪声"，用 `git show --numstat HEAD` 复核提交内容，那才是真的（这次是 2 行）。
