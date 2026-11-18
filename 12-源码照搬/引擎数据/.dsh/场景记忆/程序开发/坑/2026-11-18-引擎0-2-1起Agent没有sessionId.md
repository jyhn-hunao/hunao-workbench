---
title: 引擎0.2.1起Agent没有sessionId-记忆回响静默不注入
date: 2026-11-18
tags: [坑]
evidence:
  - 12-源码照搬\引擎\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js::this.session = session
---

# 引擎0.2.1起Agent没有sessionId-记忆回响静默不注入

## 要点
- 引擎0.2.1的ReactLoopAgent字段只有session和id，没有sessionId；pre-step的payload.agent由agentEvents的fused注入，就是loop实例，读agent.sessionId永远空串。sceneOf拿不到会话id就每次静默return，40条会话转录里0处【记忆回想，人格卡等于没进上下文。同一条人格会话还同时挂在pet-ai(harness)和社交so-msg(msgflow)两个面板，sessionMap按文件名顺序遍历、后者覆盖前者，即使取到id也会注入成社交§〇。修法：sessionIdOf兼容agent.session.id与agent.id；sessionMap按panel类型排序harness优先；人格场景§〇整卡≤4KB并把标题改成【人格回想】，别写成数据不是指令。自证看<DSH_HOME>/logs/memory-recall.log的已挂载行，壳不转发引擎stderr，server.log里看不到。
