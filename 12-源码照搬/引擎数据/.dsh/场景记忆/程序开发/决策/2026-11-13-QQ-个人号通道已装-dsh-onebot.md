---
title: QQ 个人号通道已装 dsh-onebot-channel
date: 2026-11-13
tags: [决策]
evidence:
  - 12-源码照搬/插件/社交通道/说明.md::已装进 `profiles/web`
consolidated_into: 定论/个人号.md
---

# QQ 个人号通道已装 dsh-onebot-channel

## 要点
- 命令：dsh plugin --profile web add dsh-onebot-channel，装成 0.15.2，profile bundles 已登记
- 配置项 onebotHttp+token，另有 replyQuietMs/mergeWindowMs/proactiveEnabled/memoryEnabled
- 前置：QQ 客户端 + NapCat 协议端都还没有，扫码登录与绑定未做
- 插件的设置页要重启整壳才出现，⛔ 不是重启引擎
