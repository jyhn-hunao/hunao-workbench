---
title: Blender 内置：MainWindowHandle 为 0、窗口压成一条、标题栏还在
date: 2026-11-13
tags: [坑]
evidence:
  - 12-源码照搬/外壳/scripts/blender-embed-agent.ps1::$h = [DshBlender.Win]::FindWindowWPtr("GHOST_WindowClass", [IntPtr]::Zero)
---

# Blender 内置：MainWindowHandle 为 0、窗口压成一条、标题栏还在

## 要点
- Blender 的 GHOST 主窗口不算 Windows 主窗口，MainWindowHandle 返回 0 —— 代理若靠它找窗口会 window-not-found；改按类名 GHOST_WindowClass 用 FindWindowW 定位
- 只设 owner + 摆位不算内置：窗口仍带标题栏、能盖到旁边面板，且面板矩形只要偏一点就看出没贴进去
- 去边框做法：摘 WS_CAPTION/WS_THICKFRAME/WS_SYSMENU/WS_MINIMIZEBOX/WS_MAXIMIZEBOX，改 WS_POPUP，exstyle 加 WS_EX_TOOLWINDOW，再 SWP_FRAMECHANGED 摆位；释放时把原样式与矩形整套还原
- 窗口被最小化/压成 159×27 时，摆位前先 ShowWindow(SW_RESTORE)，否则 SetWindowPos 出来还是残条
- 2026-11-13 实测：0x34CF0000→0x94000000，Ex 0x00000100→0x00000080，矩形精确、3s 不回弹、release 全还原
- 2026-11-13 追加（真机根因）：FindWindowW 的标题参数不能写 $null —— PowerShell 会把 $null/[NullString]::Value 都转成空串 ""，等于「类名匹配 + 标题为空」，只能命中 Blender 还没打开文件时的无标题窗口；标题一变就返回 0，embed 报 window-not-found、钉住拿失效句柄也纠不了偏。必须走 IntPtr 重载传 [IntPtr]::Zero，并加 EnumWindows 按 pid + 类名兜底。
