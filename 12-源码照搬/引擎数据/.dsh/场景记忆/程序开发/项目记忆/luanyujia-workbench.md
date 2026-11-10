# luanyujia-workbench · 项目记忆

> 项目根：`D:\codeData\myself\luanyujia-workbench`｜场景：程序开发（code-dev）
> 只追加：决策、坑、上线记录各一行带日期；进度写场景 §〇。

## 一、定位

- 一套「多场景 AI 工作台」的搭建方法与纯壳模板；`12-源码照搬/` 是可跑的参考实现（Electron 外壳 + DSH 引擎 + 场景 JSON + 记忆工具）。
- 顶栏场景：命令 / B站 / 自我复盘 / 本地电脑 / 工作台定制 / 程序开发。

## 二、技术与目录

- Electron 43.4.0，Node `>=24.9 <25`；外壳主进程 CJS，脚本用 `.mjs`。
- 文本 UTF-8 无 BOM；换行以各文件现状为准（多数 CRLF，`sessions.mjs` 是 LF——改前先看，别整文件重排）。
- 关键目录：`外壳/scenarios/`（场景）、`外壳/scripts/`（会话与接入脚本）、`引擎数据/.dsh/`（记忆/技能/配置）。

## 三、规范与提交

- 项目规则：`AGENTS.md`；提交准则：`doc/提交准则.md`；迁移矩阵与基线：`doc/迁移报告.md`（基线 `f0fc18f`）。
- 远程：`origin` = gitee `hunao-workbench`，获准自主 push；`upstream` = 原仓且 push 被置 `DISABLED`。

## 四、坑（只追加）

- 2026-11-10：会话脚本 token 正则写死 3080，本机 3083 取不到 cookie → 已改为按 `DSH_GUI_BASE` 端口过滤（提交 7c4a386）。
- 2026-11-10：`自检.mjs` 找的是 `引擎/apps/cli/lib/bin.js`，本机引擎是打包布局 `引擎/lib/`，所以它总走"复用 3083 实例"分支。
- 2026-11-10：`init` 会在每个场景目录生成 `<场景>场景私有记忆.md` 副本，与正本逐字节相同；已有清理，且 `身份卡/场景画像` 已加入忽略。

## 五、上线记录（只追加）

- 2026-11-10：首次推送到 gitee `hunao-workbench`（main），此后每次改动都只推这里。

## 六、外观皮肤与主题（并入自「工作台定制」场景记忆，2026-11-10）

- 皮肤段：`外壳\renderer\styles.css` 末尾「全量视觉重设计」段（§①~⑪，约 754 行）——令牌浅/深 + 底座 + 标题栏 + 场景栏 + 面板 + 控件 + 浮层 + 启动页 + 浅色护栏；说明文档 `08-升级与改造清单\外观皮肤与设计令牌.md`。
- 决策：换外观走「末尾皮肤段 + 设计令牌」，不重写 `styles.css`（4900 行里混着布局与 JS 依赖的尺寸）；组件规则一律带 `html[data-theme]` 前缀，靠「同特异性 + 文件末尾」压过历史覆盖，能不写 `!important` 就不写。
- 决策：默认主题 dark → light，键改 `guiTheme.v2` 并做一次性迁移（light/system 保留、dark 落回浅色）；默认值在 `renderer.js` 的 `currentThemeMode()`。
- 坑：`styles.css` 有 78 行 `!important`（70% 在启动页）；`#scenebar` 的背景/边框是 `!important`，皮肤段里也必须 `!important`；启动页的 `position:fixed / z-index:30000 / flex 居中` 同理。
- 坑：`.view-ta` 是 `<textarea>`，会被全局 `textarea` 的阴影环命中 ⇒ 必须显式 `box-shadow:none`，否则预览区凭空多一圈边框。
- 坑：改 `renderer.js`（主题默认、preload 之外的启动逻辑）热更新不生效，只有整页重载才重新执行；`刷新面板.mjs` 只重拉 `styles.css` 与 `renderers.js`。整页重载：先 `(Get-Item 外壳\renderer\topbar-status.js).LastWriteTime = Get-Date`，再跑 `刷新面板.mjs all`（主进程有它的 mtime 哨兵）。
- 坑：`check-gui.mjs` 第 10 项会报 3 个 FAIL（`外壳\.idea`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 不属于目录契约），是既有问题，别当成自己改坏的。
- 判据：自绘画布也必须能换皮——颜色集中成常量表（`renderers.neuron` 的 `KNEU_LIGHT`/`KNEU_DARK` + `COLOR`/`COLOR_LIGHT`），绘制代码里不留 hex。浅色画在白纸上（不铺深色背景、不压暗角、星点退成纸面尘埃、标签白底深字、连线按类型走石板/青/蓝），深色维持原星空；HUD 给两套玻璃；图例点由 `paintLegend()` 跟主题重刷。当初返工就是因为颜色散落在 30 处 `rgba(...)` 里。

## 七、待办

- 四个场景（B站 / 命令 / 自我复盘 / 本地电脑）在浅色下逐屏核对正文对比度（写死浅色字的类只补了一批护栏，还没逐屏看）。
