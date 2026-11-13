# 场景图标库（生成产物，别手改）

本目录下的 `*.svg` 由 `12-源码照搬\外壳\scripts\图标库.mjs` 从 Lucide 官方图标库抓取后写入，
手改会在下次重跑时被覆盖。改图标请改脚本里的 `SPEC`，再加场景登记（见下）。

- 来源：<https://lucide.dev> · npm 包 `lucide-static@1.72.0`
- 许可：ISC（可商用、可再分发）；每个文件头保留来源与版本标记
- 规格：`viewBox="0 0 24 24"`、显示 17×17、描边 `#8fb4ff`（工作台图标主色）、`stroke-width="2"`

## 加一个场景图标（四步）

1. 到 <https://lucide.dev/icons> 挑图标，记下英文名（如 `fish`）；
2. 在 `scripts\图标库.mjs` 的 `SPEC` 里加一条（`name` = 图标名，`note` = 哪个场景用）；
3. 跑 `node 12-源码照搬\外壳\scripts\图标库.mjs`（只补这一个新文件，不重下已有的）；
4. 在 `renderer\scene-icons.js` 的 `MAP` 里登记 `'<场景 id>': '<图标名>'`，
   然后 `node 12-源码照搬\外壳\scripts\check-gui.mjs` 过一遍 —— 会检出「没登记 / 两个场景撞同一个图标 / 文件缺失」。

## 当前清单

| 文件 | 用在哪 |
| --- | --- |
| `fish.svg` | 胡闹的大肥鱼（人格本体 · 一条鱼） |
| `message-circle-more.svg` | 社交（多平台通道 + 合并消息流 · 气泡+三点） |
| `shapes.svg` | 兜底 1（抽象图形） |
| `layers.svg` | 兜底 2（叠层） |
| `box.svg` | 兜底 3（盒子） |
| `sparkles.svg` | 兜底 4（星点） |
| `circle-dot.svg` | 兜底 5（圆点） |
| `radar.svg` | 兜底 6（雷达） |
