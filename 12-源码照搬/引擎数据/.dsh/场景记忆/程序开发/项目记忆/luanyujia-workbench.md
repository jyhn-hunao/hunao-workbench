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
