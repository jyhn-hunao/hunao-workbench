---
title: PowerShell 调 Maven/git 时 `-D`、`-m` 位置要小心
description: 2026-11-11（工具坑·跨项目）：PowerShell 调 Maven/git 时 `-D`、`-m` 位置要小心——`git commit -- a.md -m "msg"` 会把 `-m` 当 pathspec（选项必须放 `--
date: 2026-11-11
tags: [坑, 工具坑·跨项目]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# PowerShell 调 Maven/git 时 `-D`、`-m` 位置要小心

2026-11-11（工具坑·跨项目）：PowerShell 调 Maven/git 时 `-D`、`-m` 位置要小心——`git commit -- a.md -m "msg"` 会把 `-m` 当 pathspec（选项必须放 `--` 前）；`mvnw -Dtest=X` 在 pwsh 里被拆成 `.failIfNoSpecifiedTests=false` 这类报错，`-D` 参数要加引号。另外本机默认 `JAVA_HOME` 是 JDK17，Java 21 项目编译前必须切 `D:\java\jdk21`；平台制品在 `E:\maven\repo`，可 `-o` 离线编译。
