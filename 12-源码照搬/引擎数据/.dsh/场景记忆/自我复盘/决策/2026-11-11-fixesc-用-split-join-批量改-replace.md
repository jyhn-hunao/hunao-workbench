---
title: `fixesc` 用 `split/join` 批量改 `.replace(/^\/([A-Za-z]:)/…)`，本意
description: 2026-11-11（批量替换·这次直接造成整页白屏）：`fixesc` 用 `split/join` 批量改 `.replace(/^\/([A-Za-z]:)/…)`，本意只改 **guest 模板串**里的两处，结果**第三处**（`
date: 2026-11-11
tags: [决策, 批量替换·这次直接造成整页白屏]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# `fixesc` 用 `split/join` 批量改 `.replace(/^\/([A-Za-z]:)/…)`，本意

2026-11-11（批量替换·这次直接造成整页白屏）：`fixesc` 用 `split/join` 批量改 `.replace(/^\/([A-Za-z]:)/…)`，本意只改 **guest 模板串**里的两处，结果**第三处**（`renderers.flow` 拖文件解析，第 5627 行）也被改成 `\\/` ⇒ 正则被提前闭合 ⇒ 语法错误。我只跑了"抽出 guest 脚本 `node --check`"，没对宿主文件跑 `node --check` 就热更新了。改法：① 全局替换前先列全部命中点（数一数再说"这两处"）；② 替换后必跑 `node --check`；③ 改完 1.9 万行的单文件，再跑一次"假 DOM 跑到末尾"（下一条）。
