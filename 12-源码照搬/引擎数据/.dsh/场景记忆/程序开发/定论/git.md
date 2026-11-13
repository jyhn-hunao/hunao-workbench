---
kind: 定论
topic: git
date: 2026-11-13
status: confirmed
generated_by: 工具/场景记忆.mjs 沉淀
tags:
  - 定论
  - git
sources:
  - 决策/2026-11-12-外壳-git-面板-kun-git-commitmain-js.md
  - 坑/2026-11-12-改完提交时-git-add-报-index-lock.md
  - 坑/2026-11-11-PowerShell-调-Maven-git-时-D-m.md
evidence:
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/程序开发/决策/2026-11-12-外壳-git-面板-kun-git-commitmain-js.md::2026-11-12（提交约束·跨项目）：外壳 git 面板 `kun:git:commit`（main.js 里那段正
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/程序开发/坑/2026-11-12-改完提交时-git-add-报-index-lock.md::2026-11-12（环境坑·本机）：改完提交时 `git add` 报 `index.lock: Permission
---
# git

> 由 3 条同主题记忆自动汇总的**草案**：`## 摘要` 每条来源一句，方便一页看完全貌。
> AI/用户归纳后请写进 `## 结论` 并把 `status` 改成 `confirmed`（confirmed 不会被 `沉淀 --force` 覆盖）；`sources/topic` 由工具维护。

## 摘要

- 2026-11-12 外壳 git 面板 `kun:git:commit`（main.js 里那段正则）拦截的是用户手写的提交信息：2026-11-12（提交约束·跨项目）：外壳 git 面板 `kun:git:commit`（main.js 里那段正则）拦截的是**用户手写**的提交信息 —— 点 Commit and Push 弹「提交信息要写成 type(scop · `决策\2026-11-12-外壳-git-面板-kun-git-commitmain-js.md`
- 2026-11-12 改完提交时 `git add` 报 `index.lock: Permission denied`：2026-11-12（环境坑·本机）：改完提交时 `git add` 报 `index.lock: Permission denied` —— `.git` 目录对当前用户缺 WRITE_OWNER（继承项只有 Modify），沙箱在该目录 · `坑\2026-11-12-改完提交时-git-add-报-index-lock.md`
- 2026-11-11 PowerShell 调 Maven/git 时 `-D`、`-m` 位置要小心：2026-11-11（工具坑·跨项目）：PowerShell 调 Maven/git 时 `-D`、`-m` 位置要小心——`git commit -- a.md -m "msg"` 会把 `-m` 当 pathspec（选项必须放 `-- · `坑\2026-11-11-PowerShell-调-Maven-git-时-D-m.md`

## 结论

1. `type(scope)` 只约束 AI 产出/代办的提交，界面与脚本**不得校验**用户手写的提交信息；main.js 在主进程，相关改动要重启工作台才生效。
2. `git add` 报 `index.lock: Permission denied` = `.git` 目录对当前用户缺写权限，跑 diagnose-windows-sandbox-acl 技能补 ACL，别手改权限。
3. PowerShell 里 git/mvn 的 `-m`、`-D` 等选项必须放在 `--` **之前**（`git commit -m "msg" -- a.md`），`-D` 参数要加引号；JDK21 项目先切 `JAVA_HOME` 到 `D:\java\jdk21`。

## 来源

- 2026-11-12 外壳 git 面板 `kun:git:commit`（main.js 里那段正则）拦截的是用户手写的提交信息 · `决策\2026-11-12-外壳-git-面板-kun-git-commitmain-js.md`
- 2026-11-12 改完提交时 `git add` 报 `index.lock: Permission denied` · `坑\2026-11-12-改完提交时-git-add-报-index-lock.md`
- 2026-11-11 PowerShell 调 Maven/git 时 `-D`、`-m` 位置要小心 · `坑\2026-11-11-PowerShell-调-Maven-git-时-D-m.md`
