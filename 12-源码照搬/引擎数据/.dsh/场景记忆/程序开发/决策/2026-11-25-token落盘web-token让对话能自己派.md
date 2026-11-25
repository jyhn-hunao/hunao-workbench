---
title: token落盘web-token让对话能自己派
date: 2026-11-25
tags: [决策]
evidence:
  - 12-源码照搬/工具/引擎token.mjs
consolidated_into: 定论/token.md
---

# token落盘web-token让对话能自己派

## 要点
- 根因不是模型不会派，是 token 只活在壳主进程内存：CLI 和引擎内 bash 都继承不到，所以换不到 cookie
- 壳 captureToken 现在往 DSH_HOME 写 .web-token（token/port/pid/at，仅本机）；工具\引擎token.mjs 三通道：env DSH_TOKEN → .web-token（三个候选位置、端口必须匹配）→ server.log
- 安全：.gitignore 已挡；记忆打包只打 场景记忆/项目记忆，不含 .dsh 根；发布前检查红线 0 命中
- 效果：重启壳后人格会话里直接 派发.mjs --词 就能投进目标会话，壳内「新建派发」只是壳没起或想手派时的备用
- 单测三通道通过；真实环境取到 0 条属正常（壳未重启，还没写文件）
