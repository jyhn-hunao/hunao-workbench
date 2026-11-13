---
title: ① `派发.mjs` 加 `--project "<项目名/别称>"`：只认 `_共享记忆\项目.json` 的 nam
description: 2026-11-12（工具修·派发/换会话）：① `派发.mjs` 加 `--project "<项目名/别称>"`：只认 `_共享记忆\项目.json` 的 name/aliases → 按 `cwd` 落在该项目 paths 下认会话（
date: 2026-11-12
tags: [决策, 工具修·派发/换会话]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# ① `派发.mjs` 加 `--project "<项目名/别称>"`：只认 `_共享记忆\项目.json` 的 nam

2026-11-12（工具修·派发/换会话）：① `派发.mjs` 加 `--project "<项目名/别称>"`：只认 `_共享记忆\项目.json` 的 name/aliases → 按 `cwd` 落在该项目 paths 下认会话（排除派发方、只认有标题的、同项目优先标题完全等），认不出列候选退出 1（不猜目录名）。② `换会话.mjs` 补 `cd-ai-home` 交接映射（原表只有 5 个面板，工作区换不了），真换成功后写 `外壳\data\reload-panels.cmd=all` 让壳自动重载面板 —— 原来 json 改绑了但 webview 不重载，界面还显示旧会话（用户实报）。③ 规则落地：`AGENTS.md §5` 加「工作区会话只路由」、`skills\code-dev\SKILL.md` 第 0 条同口径。判据：`派发.mjs --project mlw "x" --dry` 命中「mlw」会话；`--project 不存在的项目` 列 2 个候选退出 1；三个脚本 `node --check` 通过。
