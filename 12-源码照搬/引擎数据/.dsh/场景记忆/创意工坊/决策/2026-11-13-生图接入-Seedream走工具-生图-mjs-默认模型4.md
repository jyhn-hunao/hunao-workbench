---
title: 生图接入-Seedream走工具-生图-mjs-默认模型4-5
date: 2026-11-13
tags: [决策]
evidence:
  - 12-源码照搬/工具/生图.mjs::images/generations
---

# 生图接入-Seedream走工具-生图-mjs-默认模型4-5

## 要点
- 用户要求：工作台接入 seedream，生图默认用它（用户本身在工作台之外，所以必须让台内会话自己能出图）
- 新增 工具\生图.mjs：probe 认 key、set-key 写 机器配置.json 的 arkApiKey、gen 发 POST /api/v3/images/generations，默认 doubao-seedream-4-5-251128 / size 2K / watermark false / response_format b64_json，按魔数判 png-jpg 后缀落盘，支持 --ref 本地图转 dataURL（≤10MB）与 --n 多版、--dry 只打印请求体
- 只用 Node 内置 https，不引第三方；key 优先级 ARK_API_KEY > 机器配置 arkApiKey，缺 key 直说，不假装出图
- 原画概念技能已改为默认 Seedream；流水线参考图入口、定位卡工具表、AGENTS.md 命令表同步
