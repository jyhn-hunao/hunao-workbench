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
  - 决策/2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md
  - 决策/2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md
  - 决策/2026-11-11-先-commit-看-git-show-stat-与-git.md
evidence:
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/自我复盘/决策/2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md::2026-11-11（回滚基线）：这次能 30 秒恢复，靠的是之前把第二轮改动 `git add` 过（`git che
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/自我复盘/决策/2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md::2026-11-11（numstat 会骗人）：纯 CRLF 文件上用 `git -c core.autocrlf=fa
---
# git

> 由 3 条同主题记忆自动汇总的**草案**：`## 摘要` 每条来源一句，方便一页看完全貌。
> AI/用户归纳后请写进 `## 结论` 并把 `status` 改成 `confirmed`（confirmed 不会被 `沉淀 --force` 覆盖）；`sources/topic` 由工具维护。

## 摘要

- 2026-11-11 这次能 30 秒恢复，靠的是之前把第二轮改动 `git add` 过（`git checkout --` 回到暂存版），：2026-11-11（回滚基线）：这次能 30 秒恢复，靠的是之前把第二轮改动 `git add` 过（`git checkout --` 回到暂存版），属侥幸。改法：动主渲染器前先 checkpoint 提交或 `git stash`，回 · `决策\2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md`
- 2026-11-11 纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --nums：2026-11-11（numstat 会骗人）：纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --numstat`，会把整文件报成 407 增/405 删——因为索引里存的是 L · `决策\2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md`
- 2026-11-11 先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 pu：2026-11-11（提交与推送分步）：**先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 push**。我把 `commit && push` 写成一条命令跑完，推完才看 · `决策\2026-11-11-先-commit-看-git-show-stat-与-git.md`

## 结论

1. 动主渲染器这类高风险文件前，先 checkpoint（提交或 `git stash`）——回滚目标是明确的一版，不是「我记得哪版能用」。
2. autocrlf 下 `diff --cached --numstat` 会把 CRLF 文件报成整文件增删（numstat 会骗人），判噪声用 `git show --numstat HEAD` 复核真实提交内容。
3. commit 与 push 分步：先 commit → `git show --stat` 确认干净 → 再 push；已推送不可改写历史，噪声提交会永久留在历史里。

## 来源

- 2026-11-11 这次能 30 秒恢复，靠的是之前把第二轮改动 `git add` 过（`git checkout --` 回到暂存版）， · `决策\2026-11-11-这次能-30-秒恢复-靠的是之前把第二轮改动-git-add.md`
- 2026-11-11 纯 CRLF 文件上用 `git -c core.autocrlf=false diff --cached --nums · `决策\2026-11-11-纯-CRLF-文件上用-git-c-core-autocrlf.md`
- 2026-11-11 先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 pu · `决策\2026-11-11-先-commit-看-git-show-stat-与-git.md`
