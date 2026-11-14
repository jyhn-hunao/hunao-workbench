---
title: PowerShell 脚本必须 UTF-8 带 BOM
date: 2026-11-13
tags: [坑]
evidence:
  - 12-源码照搬/外壳/scripts/blender-embed-agent.ps1::UTF-8 带 BOM
---

# PowerShell 脚本必须 UTF-8 带 BOM

## 要点
- Windows PowerShell 5.1 读无 BOM 文件按 ANSI 解，中文注释会把语法读坏（实测 ParserError）
- .ps1 带 BOM 保存，其余文本仍 UTF-8 无 BOM
