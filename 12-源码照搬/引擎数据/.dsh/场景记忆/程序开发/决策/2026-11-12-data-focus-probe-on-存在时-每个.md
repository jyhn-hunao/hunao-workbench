---
title: `data\focus-probe.on` 存在时，每个 webview 的 focus/blur 记一行到 serve
description: 2026-11-12（焦点探针·跨项目）：`data\focus-probe.on` 存在时，每个 webview 的 focus/blur 记一行到 server.log（只两行、删文件即关）。用于复现「一个面板跑任务时另一个面板打不进字
date: 2026-11-12
tags: [决策, 焦点探针·跨项目]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# `data\focus-probe.on` 存在时，每个 webview 的 focus/blur 记一行到 serve

2026-11-12（焦点探针·跨项目）：`data\focus-probe.on` 存在时，每个 webview 的 focus/blur 记一行到 server.log（只两行、删文件即关）。用于复现「一个面板跑任务时另一个面板打不进字」，当前开关已打开、尚未复现。
