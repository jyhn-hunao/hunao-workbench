---
title: 把当日 6 个会话的 `assistant/message.usage` 全量累了一遍，294.9M tokens 里 
description: 2026-11-11（token 账·长会话才是主成本）：把当日 6 个会话的 `assistant/message.usage` 全量累了一遍，294.9M tokens 里 **cacheRead 293.0M（99.3%）**，真正新
date: 2026-11-11
tags: [决策, token 账·长会话才是主成本]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# 把当日 6 个会话的 `assistant/message.usage` 全量累了一遍，294.9M tokens 里 

2026-11-11（token 账·长会话才是主成本）：把当日 6 个会话的 `assistant/message.usage` 全量累了一遍，294.9M tokens 里 **cacheRead 293.0M（99.3%）**，真正新增输入 0.94M、输出 1.00M；每 1 token 新内容平均被重放 151 次。原因是每步都把整段历史重读一遍，而单会话上下文从起步 10.6k 一路涨到峰值 579k → 同一件事放在会话后段做，单价是前段的 2–3 倍（前 168 步均 205k，后 168 步均 457k）。次要浪费：read 282 次只碰 103 个文件（`renderers.js` 46 次、`main.js` 24 次），整文件读回后被后续每步重放；并行 3 个长会话（09:35–10:51）各自独立重放、互不复用。改法：① 换主题就新开会话/归档重开，别让单会话堆到 300+ 步；② 大文件用 offset/limit 只读目标段；③ 记忆按薄卡+按需召回注入，别把整篇场景记忆每轮塞进上下文。判据：以后看 `cacheRead / total > 95%` 就说明会话该切了。
