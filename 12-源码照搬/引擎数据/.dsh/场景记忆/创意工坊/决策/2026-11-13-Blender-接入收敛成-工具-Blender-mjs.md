---
title: Blender 接入收敛成 工具\Blender.mjs 一条入口
date: 2026-11-13
tags: [决策]
evidence:
  - 12-源码照搬/工具/Blender.mjs::node 工具\Blender.mjs probe
consolidated_into: 定论/blender.md
---

# Blender 接入收敛成 工具\Blender.mjs 一条入口

## 要点
- probe 认环境: 装没装/跑没跑/桥接通不通/工程根
- run 后台跑 bpy 脚本出模型与批量渲染
- exec 连 127.0.0.1:9876 实时改用户正开着的场景
- open 打开工程并自动挂桥接; set-exe/set-dir 改安装位与工程根
