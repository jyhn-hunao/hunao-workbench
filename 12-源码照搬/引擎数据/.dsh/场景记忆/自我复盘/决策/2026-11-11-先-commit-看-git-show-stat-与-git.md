---
title: 先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 pu
description: 2026-11-11（提交与推送分步）：**先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 push**。我把 `commit && push` 写成一条命令跑完，推完才看
date: 2026-11-11
tags: [决策, 提交与推送分步]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# 先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 pu

2026-11-11（提交与推送分步）：**先 commit，看 `git show --stat` 与 `git diff --numstat`，确认干净再 push**。我把 `commit && push` 写成一条命令跑完，推完才看到 `renderers.js` 484 行行尾噪声；因为"已推送不改写历史"，只能追加 `9fb6db5` 去还原——历史里永久多了一条噪声提交。代价小，但规则上完全可避免。
