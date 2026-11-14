---
title: SetParent 真子窗会随壳丢窗口-Blender 变僵尸进程
date: 2026-11-13
tags: [坑]
evidence:
  - 12-源码照搬/外壳/main.js::const embedMode = (rawMode === 'owner' || rawMode === 'child') ? rawMode : 'clip'
---

# SetParent 真子窗会随壳丢窗口-Blender 变僵尸进程

## 要点
- 2026-11-13 真机：child 模式下壳窗口一动，子窗（Blender 主窗口）跟着被销毁，进程仍在（pid 27460 无任何窗口、MainWindowTitle 空），面板再也嵌不回去；改用 clip 模式：窗口仍为顶层窗 + SetWindowRgn 把可见区裁到目标矩形，绝不越界且不会连带丢窗口；真子窗降级为机器配置可选（blenderEmbedMode=child），默认 clip
