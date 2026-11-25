# 图标库（生成产物，别手改）

本目录下的 `*.svg` 由 `12-源码照搬\外壳\scripts\图标库.mjs` 从 Lucide 官方图标库抓取后写入，
手改会在下次重跑时被覆盖。改图标请改脚本里的 `SPEC`，再加场景登记（见下）。

- 来源：<https://lucide.dev> · npm 包 `lucide-static@1.72.0`
- 许可：ISC（可商用、可再分发）；每个文件头保留来源与版本标记
- 规格：`viewBox="0 0 24 24"`、源文件按 17×17 输出（功能条 UI 显示 20×20）、描边 `#8fb4ff`（工作台图标主色）、`stroke-width="2"`

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
| `folder-code.svg` | 程序开发 · AI项目（当前项目会话） |
| `folders.svg` | 程序开发 · AI多项目管理（所有项目的入口） |
| `shapes.svg` | 兜底 1（抽象图形） |
| `layers.svg` | 兜底 2（叠层） |
| `box.svg` | 兜底 3（盒子） |
| `sparkles.svg` | 兜底 4（星点） |
| `circle-dot.svg` | 兜底 5（圆点） |
| `radar.svg` | 兜底 6（雷达） |
| `heart.svg` | 人格 · 关系与情绪 |
| `shield.svg` | 人格 · 安全闸门（边界） |
| `database.svg` | 人格 · 聊天档案库 |
| `clock.svg` | 人格 · 定时任务 |
| `zap.svg` | 人格 · 劲儿（主动开口的燃料） |
| `leaf.svg` | 生活 · 生活设置 |
| `gauge.svg` | 生活 · 发布额度 |
| `send.svg` | 社交 · 主动出消息 |
| `message-square.svg` | 社交 · QQ 接入 |
| `users.svg` | 社交 · QQ 群聊与语音 |
| `message-circle.svg` | 社交 · 微信（鲸鲸设置） |
| `wrench.svg` | 维护（记忆 / 控制台） |
| `refresh-cw.svg` | 记忆 · 自动换会话 |
| `archive.svg` | 记忆 · 上次整理 |
| `clipboard-check.svg` | 记忆 · 上次巡检 |
| `sliders-horizontal.svg` | 控制台 · 工具策略 |
| `hard-drive.svg` | 本地电脑 · 上次扫描 |
| `clipboard-list.svg` | 本地电脑 · 清理台账 |
| `book-open.svg` | 自我复盘 · 复盘库 |
| `network.svg` | 程序开发 · 端口 |
| `git-branch.svg` | 程序开发 · 变更单 |
| `list-checks.svg` | 总入口 · 派发巡检（弹窗） |
| `monitor.svg` | 社交 · SnowLuma 控制台（弹窗） |
