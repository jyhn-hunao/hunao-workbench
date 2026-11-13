---
kind: 定论
topic: git
date: 2026-11-13
status: draft
generated_by: 工具/场景记忆.mjs 沉淀
tags:
  - 定论
  - git
sources:
  - 决策/2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md
  - 决策/2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md
  - 决策/2026-11-11-先-commit-看-git-show-stat-与-git.md
evidence:
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/自我复盘/决策/2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md::这次能 30 秒
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/自我复盘/决策/2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md::纯 CRLF 文
---
# git

> 由 3 条同主题记忆自动汇总的**草案**：`## 摘要` 每条来源一句，方便一页看完全貌。
> AI/用户归纳后请写进 `## 结论` 并把 `status` 改成 `confirmed`（confirmed 不会被 `沉淀 --force` 覆盖）；`sources/topic` 由工具维护。

## 摘要

- 2026-11-11 这次能 30 秒恢复，靠的是之前把第二轮改动 `git add` 过（`git checkout --` 回到暂存版），：2026-11-11（回滚基线）：这次能 30 秒恢复，靠的是之前把第二轮改动 `git add` 过（`git checkout --` 回到暂存版），属侥幸。改法：动主渲染器前先 checkpoint 提交或 `git stash`，回 · `决策\2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md`
- 2026-11-11 纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --nums：2026-11-11（numstat 会骗人）：纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --numstat`，会把整文件报成 407 增/405 删——因为索引里存的是 L · `决策\2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md`
- 2026-11-11 先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 pu：2026-11-11（提交与推送分步）：**先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 push**。我把 `commit && push` 写成一条命令跑完，推完才看 · `决策\2026-11-11-先-commit-看-git-show-stat-与-git.md`

## 结论

- （待归纳：以上 3 条各说各的，需要一句共同结论；没有就不硬凑）

## 来源

- 2026-11-11 这次能 30 秒恢复，靠的是之前把第二轮改动 `git add` 过（`git checkout --` 回到暂存版）， · `决策\2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md`
- 2026-11-11 纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --nums · `决策\2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md`
- 2026-11-11 先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 pu · `决策\2026-11-11-先-commit-看-git-show-stat-与-git.md`
