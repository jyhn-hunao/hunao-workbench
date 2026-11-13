---
title: `12-源码照搬\工作区` 缺 WRITE_OWNER，DSH 沙箱连 `Get-ChildItem` 都报 `SetN
description: 2026-11-10 `12-源码照搬\工作区` 缺 WRITE_OWNER，DSH 沙箱连 `Get-ChildItem` 都报 `SetNamedSecurityInfoW failed (Win32 5)`；已用诊断脚本给当前用户补完
date: 2026-11-10
tags: [决策, 验证 writeOwner false→true]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# `12-源码照搬\工作区` 缺 WRITE_OWNER，DSH 沙箱连 `Get-ChildItem` 都报 `SetN

2026-11-10 `12-源码照搬\工作区` 缺 WRITE_OWNER，DSH 沙箱连 `Get-ChildItem` 都报 `SetNamedSecurityInfoW failed (Win32 5)`；已用诊断脚本给当前用户补完全控制（验证 writeOwner false→true），备份与回滚命令在 `12-源码照搬\_acl-recovery\acl-backup-30d1e2d82b18499f8e46fa340407916f.json.ps1`。
