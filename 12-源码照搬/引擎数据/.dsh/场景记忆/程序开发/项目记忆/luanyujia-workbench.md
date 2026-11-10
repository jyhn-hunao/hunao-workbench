# luanyujia-workbench · 项目记忆

> 项目根：`D:\codeData\myself\luanyujia-workbench`｜场景：程序开发（code-dev）｜建单 2026-11-10｜最近更新 2026-11-10
> **业务记忆只住这里**：术语 / 数据来源 / 契约 / 领域规则都写本文件；跨项目规矩去场景私有记忆。

## 状态区

- **状态**：进行中
- **一句话**：一套「多场景 AI 工作台」的搭建方法与可跑纯壳模板（Electron 外壳 + DSH 引擎 + 场景 JSON + 记忆工具）。
- **成果/证据**：场景 5 个（命令 / B站 / 自我复盘 / 本地电脑 / 程序开发），`sessions.mjs --check` 5/5 通过；项目规则 `AGENTS.md` + `doc\提交准则.md` + `doc\迁移报告.md` 已落地（基线 `f0fc18f`）。
- **下一步**：四个场景在浅色下逐屏核对正文对比度（见 §八）。
- **已有档案**：`README.md`、`doc\迁移报告.md`、`08-升级与改造清单\外观皮肤与设计令牌.md`、`12-源码照搬\说明\使用说明.md`。

## 一、领域与术语

- **业务域**：AI 工作台——把「一个聊天窗口」变成「按场景分工的工作室」；产物是方法 + 模板，不是业务系统。
- **术语**：场景（职责/工作模式，顶栏一个标签）、面板（场景里的一块格子，`type` 决定渲染器）、会话（DSH session，AI 面板钉一条）、工作区（DSH 侧栏分组 = 项目目录）、记忆三层（全局 AGENTS → 技能 → 定位卡 → 场景记忆）、共享记忆（`_共享记忆\areas`）、技能（`.dsh\skills\<名>\SKILL.md`）。
- **边界**：不含引擎、密钥、真实用户数据；不是通用安装包（壳能跑，方法要接到自己的内容上）。

## 二、数据来源与业务规则

- **场景配置**是事实源：`外壳\scenarios\<id>.json`，`id` 必须等于文件名；面板 `type` 必须是已注册渲染器（`view`/`file`/`harness`/`neuron`/`embed`/`pc-*` 等）。
- **会话绑定**：AI 面板三字段 `sessionId` / `sessionTitle` / `pinTarget`；`sessionId` 只能来自 `建会话.mjs` 或 `接入项目.mjs` 的输出，不能手填。
- **会话数据**在 `引擎数据\.dsh\sessions\`（不入库）；**场景记忆**在 `引擎数据\.dsh\场景记忆\`（入库，但归档与运行态文件忽略）。
- **规则**：一个场景挂多项目时，业务知识进 `项目记忆\<项目>.md`；场景私有记忆只放跨项目规矩。
- **脏字段与例外**：`sessionId` 是本机数据，换机器必然失效；标题必须与界面显示逐字一致（重名会串台）。

## 三、接口与契约

- **引擎 RPC**：`POST /api/<method>`，body `{type:'client-request', rpcId, method, payload:{args}}`；已用：`session/create`、`session/rename`、`session/prompt`、`session/cancel`、`workspace/create`、`workspace/archiveSession`。
- **鉴权**：token 从 `外壳\server.log` 的 `dsh web: http://127.0.0.1:<port>/?token=…` 取，`fetch(BASE + '/?token=…', {redirect:'manual'})` 换签名 cookie；redirect 跟随会 401。
- **端口**：`DSH_PORT` 默认 3083（`启动.vbs` 与 `main.js` 各写一处，必须同改）。

## 四、技术栈与目录

- Electron 43.4.0，Node `>=24.9 <25`；外壳主进程 CJS，脚本用 `.mjs`。
- 文本 UTF-8 无 BOM；换行以各文件现状为准（多数 CRLF，`sessions.mjs` 是 LF——改前先看，别整文件重排）。
- 关键目录：`外壳/scenarios/`（场景）、`外壳/scripts/`（会话与接入脚本）、`引擎数据/.dsh/`（记忆/技能/配置）。

## 五、规范与提交

- 项目规则：`AGENTS.md`；提交准则：`doc/提交准则.md`；迁移矩阵与基线：`doc/迁移报告.md`（基线 `f0fc18f`）。
- 远程：`origin` = gitee `hunao-workbench`，获准自主 push；`upstream` = 原仓且 push 被置 `DISABLED`。

## 六、决策与坑（只追加）

- 2026-11-10：会话脚本 token 正则写死 3080，本机 3083 取不到 cookie → 已改为按 `DSH_GUI_BASE` 端口过滤（提交 7c4a386）。
- 2026-11-10：`自检.mjs` 找的是 `引擎/apps/cli/lib/bin.js`，本机引擎是打包布局 `引擎/lib/`，所以它总走"复用 3083 实例"分支。
- 2026-11-10：`init` 会在每个场景目录生成 `<场景>场景私有记忆.md` 副本，与正本逐字节相同；已有清理，且 `身份卡/场景画像` 已加入忽略。
- 2026-11-10（外观）：皮肤段在 `外壳\renderer\styles.css` 末尾（§①~⑪，约 754 行）；换外观走「末尾皮肤段 + 设计令牌」，不重写 `styles.css`（4900 行里混着布局与 JS 依赖的尺寸）；组件规则一律带 `html[data-theme]` 前缀，靠「同特异性 + 文件末尾」压过历史覆盖，能不写 `!important` 就不写。
- 2026-11-10（外观）：默认主题 dark → light，键改 `guiTheme.v2` 并做一次性迁移（light/system 保留、dark 落回浅色）；默认值在 `renderer.js` 的 `currentThemeMode()`。
- 2026-11-10（外观坑）：`styles.css` 有 78 行 `!important`（70% 在启动页）；`#scenebar` 的背景/边框是 `!important`，皮肤段里也必须 `!important`；启动页的 `position:fixed / z-index:30000 / flex 居中` 同理。
- 2026-11-10（外观坑）：`.view-ta` 是 `<textarea>`，会被全局 `textarea` 的阴影环命中 ⇒ 必须显式 `box-shadow:none`，否则预览区凭空多一圈边框。
- 2026-11-10（外观坑）：改 `renderer.js`（主题默认、preload 之外的启动逻辑）热更新不生效，只有整页重载才重新执行；`刷新面板.mjs` 只重拉 `styles.css` 与 `renderers.js`。整页重载：先 `(Get-Item 外壳\renderer\topbar-status.js).LastWriteTime = Get-Date`，再跑 `刷新面板.mjs all`（主进程有它的 mtime 哨兵）。
- 2026-11-10（外观坑）：`check-gui.mjs` 第 10 项会报 3 个 FAIL（`外壳\.idea`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 不属于目录契约），是既有问题，别当成自己改坏的。
- 2026-11-10（外观判据）：自绘画布也必须能换皮——颜色集中成常量表（`renderers.neuron` 的 `KNEU_LIGHT`/`KNEU_DARK` + `COLOR`/`COLOR_LIGHT`），绘制代码里不留 hex；浅色画在白纸上，深色维持原星空；HUD 给两套玻璃；图例点由 `paintLegend()` 跟主题重刷。当初返工就是因为颜色散落在 30 处 `rgba(...)` 里。

## 七、上线记录（只追加）

- 2026-11-10：首次推送到 gitee `hunao-workbench`（main），此后每次改动都只推这里。

## 八、待办

- 四个场景（B站 / 命令 / 自我复盘 / 本地电脑）在浅色下逐屏核对正文对比度（写死浅色字的类只补了一批护栏，还没逐屏看）。
