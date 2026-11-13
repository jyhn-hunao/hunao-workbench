---
title: 五个场景-根因-oaApi-filesLocal-全仓零命中
date: 2026-11-13
tags: [决策, 神经元, 场景目录, IPC]
evidence:
  - 12-源码照搬\外壳\renderer\renderers.js::场景目录.json
  - 12-源码照搬\工具\场景记忆.mjs::cmdIndexAll
---

# 五个场景-根因-oaApi-filesLocal-全仓零命中

## 要点
- 现象：面板只显示登记表那 5 个场景，社交/胡闹的大肥鱼没有节点
- 根因：自动进图分支调 oaApi.filesLocal，但 preload/main/renderer 全仓 grep 0 命中，分支一直静默返回 null
- 修法：工具\场景记忆.mjs 索引 生成 _共享记忆\场景目录.json（索引 --all 全量重建），渲染器读它补场景节点，不再依赖目录扫描
- 配套：新增 areas\social.md、areas\pet.md 并把两者登记进 索引.json（areas 7 个）
