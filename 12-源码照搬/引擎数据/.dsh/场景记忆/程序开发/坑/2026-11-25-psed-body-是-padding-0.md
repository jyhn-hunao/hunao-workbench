---
title: psed-body 是 padding 0 不能复用
date: 2026-11-25
tags: [坑]
evidence:
  - 12-源码照搬/外壳/renderer/styles.css::.cfg-body
  - 12-源码照搬/外壳/renderer/styles.css::.psed-body
---

# psed-body 是 padding 0 不能复用

## 要点
- styles.css 里 .psed-body 在桌宠弹窗分区卡片重做时被改成 padding:0，边距靠内层 psed-secs 补
- 新弹窗直接套 psed-body 会内容贴边（实测生活设置/通道规矩都中招）
- 统一改用自建 .cfg-dlg/.cfg-body/.cfg-foot 骨架：体 padding 18px 24px 20px 可滚，脚固定放保存
