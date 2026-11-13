---
title: 改完提交时 `git add` 报 `index.lock: Permission denied`
description: 2026-11-12（环境坑·本机）：改完提交时 `git add` 报 `index.lock: Permission denied` —— `.git` 目录对当前用户缺 WRITE_OWNER（继承项只有 Modify），沙箱在该目录
date: 2026-11-12
tags: [坑, 环境坑·本机]
source: 场景私有记忆.md §五（2026-11-13 拆分）
---

# 改完提交时 `git add` 报 `index.lock: Permission denied`

2026-11-12（环境坑·本机）：改完提交时 `git add` 报 `index.lock: Permission denied` —— `.git` 目录对当前用户缺 WRITE_OWNER（继承项只有 Modify），沙箱在该目录建文件被拒。用 `diagnose-windows-sandbox-acl` 技能脚本补了当前用户完全控制（备份 + 回滚脚本在 `D:\codeData\myself\dsh-acl-reports\`），修后 add/commit/push 全通。以后「工作区内某目录写不进、报 ACE 类拒绝」先跑该技能，别手改权限。
