---
title: Blender 真嵌入用 SetParent 子窗-失败自动退回贴合
date: 2026-11-13
tags: [决策]
evidence:
  - 12-源码照搬/外壳/main.js::rawMode === 'owner' || rawMode === 'child'
---

# Blender 真嵌入用 SetParent 子窗-失败自动退回贴合

## 要点
- 默认 child 模式：SetParent(壳窗口) + WS_CHILD
- WS_VISIBLE、去 WS_POPUP/标题栏，坐标从屏幕换算成父客户区（ClientToScreen），窗口被 Electron 客户区裁掉，绝不越界；SetParent 没生效就还原样式退回 owner 覆盖式并在响应里带 fallback=true；机器配置 blenderEmbedMode=owner 可强制老模式；全屏调整同样走子窗，等于壳内满屏
