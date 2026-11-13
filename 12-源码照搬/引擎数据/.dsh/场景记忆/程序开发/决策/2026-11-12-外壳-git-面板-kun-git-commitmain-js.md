---
title: 外壳 git 面板 `kun:git:commit`（main.js 里那段正则）拦截的是用户手写的提交信息
description: 2026-11-12（提交约束·跨项目）：外壳 git 面板 `kun:git:commit`（main.js 里那段正则）拦截的是**用户手写**的提交信息 —— 点 Commit and Push 弹「提交信息要写成 type(scop
date: 2026-11-12
tags: [决策, 提交约束·跨项目]
source: 场景私有记忆.md §五（2026-11-13 拆分）
consolidated_into: 定论/git.md
---

# 外壳 git 面板 `kun:git:commit`（main.js 里那段正则）拦截的是用户手写的提交信息

2026-11-12（提交约束·跨项目）：外壳 git 面板 `kun:git:commit`（main.js 里那段正则）拦截的是**用户手写**的提交信息 —— 点 Commit and Push 弹「提交信息要写成 type(scope)…」就是它 `return { ok:false }`。定性：`type(scope)` 只约束 AI 产出/代办的提交，面板不得校验用户输入。已删校验（只留「不能为空」）、placeholder 改中性提示，规则文本同步写清适用范围（`AGENTS.md §6`、`doc\提交准则.md §5`）；提交 `1e22e5e`、`fadc4ca`。**main.js 在主进程，重启工作台才生效**，重启前看到的仍是旧拦截。
