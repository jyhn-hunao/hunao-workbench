---
title: SnowLuma 源码自建跑通-skips-QQ版本锁
date: 2026-11-13
tags: [决策]
evidence:
  - 12-源码照搬\插件\社交通道\说明.md::## 10. SnowLuma：源码自建跑通
---

# SnowLuma 源码自建跑通-skips-QQ版本锁

## 要点
- 发行包断供但源码仓库完整 v1.14.22，自带 win32 原生 dll/node（注入器内置）
- compat\qq.json 允许未知版本 ⇒ 本机 QQ 9.9.20-37625 合法，绕开 NapCat 锁版本
- 构建：npx pnpm@10.28.0 install --frozen-lockfile + rebuild esbuild + build:all
- 跑：dist 下 node index.mjs，WebUI 5099，Bearer token 认证（cookie 不生效）
- 卡点：processes/qq-list 需用户本人在 WebUI 同意 EULA 与隐私政策，不代点
- 非商业源码可见许可，原生组件专有，只自用不外发
