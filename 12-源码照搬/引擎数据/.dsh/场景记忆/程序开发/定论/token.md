---
kind: 定论
topic: token
date: 2026-11-25
status: confirmed
generated_by: 工具/场景记忆.mjs 沉淀
tags:
  - 定论
  - token
sources:
  - 决策/2026-11-25-壳内派发入口绕开不能拿到token.md
  - 决策/2026-11-25-token落盘web-token让对话能自己派.md
  - 坑/2026-11-10-建会话-mjs-等脚本原先写死-3080-端口取-token.md
evidence:
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/程序开发/决策/2026-11-25-壳内派发入口绕开不能拿到token.md::壳外脚本永远换不到 cookie：token 只在壳主进程内存（captureToken 写 process.env.D
  - D:/codeData/myself/luanyujia-workbench/12-源码照搬/引擎数据/.dsh/场景记忆/程序开发/决策/2026-11-25-token落盘web-token让对话能自己派.md::根因不是模型不会派，是 token 只活在壳主进程内存：CLI 和引擎内 bash 都继承不到，所以换不到 cookie
---
# token

> 由 3 条同主题记忆自动汇总的**草案**：`## 摘要` 每条来源一句，方便一页看完全貌。
> AI/用户归纳后请写进 `## 结论` 并把 `status` 改成 `confirmed`（confirmed 不会被 `沉淀 --force` 覆盖）；`sources/topic` 由工具维护。

## 摘要

- 2026-11-25 壳内派发入口绕开不能拿到token：壳外脚本永远换不到 cookie：token 只在壳主进程内存（captureToken 写 process.env.DSH_TOKEN），server.log 已脱敏 token=***，引擎进程命令行不带 token，127.0.0.1:3083 直连是 401 · `决策\2026-11-25-壳内派发入口绕开不能拿到token.md`
- 2026-11-25 token落盘web-token让对话能自己派：根因不是模型不会派，是 token 只活在壳主进程内存：CLI 和引擎内 bash 都继承不到，所以换不到 cookie · `决策\2026-11-25-token落盘web-token让对话能自己派.md`
- 2026-11-10 `建会话.mjs` 等脚本原先写死 3080 端口取 token，本机 3083 全废：2026-11-10（坑）：`建会话.mjs` 等脚本原先写死 3080 端口取 token，本机 3083 全废；已修（提交 7c4a386）。新增脚本一律按 `DSH_GUI_BASE` 的端口过滤 token。 · `坑\2026-11-10-建会话-mjs-等脚本原先写死-3080-端口取-token.md`

## 结论

- token 只活在壳主进程内存，**任何壳外进程（CLI / 引擎内 bash / 人格会话）都换不到 cookie**；因此「让对话自己派发」的前提不是提示词，而是把 token 通道开出来。
- 唯一可靠来源：壳 `captureToken` 捕获后落一份 `引擎数据\.dsh\.web-token`（本机、已 gitignore、不进记忆包、端口绑定）。脚本一律走 `工具\引擎token.mjs` 的三通道：**env `DSH_TOKEN` → `.web-token` → `server.log`**，⛔ 不要自己正则翻日志、也不要让用户手灌 token。
- 壳内还有一个备用通道（`IPC dispatch:send` → 壳起 `派发.mjs`，子进程继承 env）：壳没起、或用户想手动派时用；日常应由对话直接 `派发.mjs --词 "<原话>"` 完成。
- 以后加「让某个会话自己执行外部动作」的能力，先问一句：**执行它的进程拿不拿得到 token**；拿不到就先把通道补上，再谈能力。

## 来源

- 2026-11-25 壳内派发入口绕开不能拿到token · `决策\2026-11-25-壳内派发入口绕开不能拿到token.md`
- 2026-11-25 token落盘web-token让对话能自己派 · `决策\2026-11-25-token落盘web-token让对话能自己派.md`
- 2026-11-10 `建会话.mjs` 等脚本原先写死 3080 端口取 token，本机 3083 全废 · `坑\2026-11-10-建会话-mjs-等脚本原先写死-3080-端口取-token.md`
