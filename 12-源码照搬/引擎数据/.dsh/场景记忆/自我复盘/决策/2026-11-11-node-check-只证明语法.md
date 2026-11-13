---
title: `node --check` 只证明语法
description: 2026-11-11（"能跑"的判据）：`node --check` 只证明语法；要证明**能执行到末尾并导出**，用假 DOM 跑一遍最便宜——`vm.runInNewContext` + Proxy 桩，跑完断言 `window.APP
date: 2026-11-11
tags: [决策, "能跑"的判据]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# `node --check` 只证明语法

2026-11-11（"能跑"的判据）：`node --check` 只证明语法；要证明**能执行到末尾并导出**，用假 DOM 跑一遍最便宜——`vm.runInNewContext` + Proxy 桩，跑完断言 `window.APP_RENDER_UTILS && window.APP_RENDERERS`。这次写好脚本后第一次跑就精确指到 5627 行，比人眼扫 1.9 万行快得多。建议固化进 `外壳\scripts\渲染器自检.mjs`。
