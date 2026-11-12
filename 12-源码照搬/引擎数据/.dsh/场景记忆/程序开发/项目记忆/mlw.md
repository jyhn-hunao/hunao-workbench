# mlw · 记忆薄卡

> 正文在 `<项目根>\memory\`；本卡只放指针，不放业务知识。

<!-- AUTO:BEGIN -->
- 项目根：`D:\codeData\workData\workCode\mlw`
- 记忆索引：`memory\MEMORY_INDEX.md`（分类见各目录 README）
- 项目规则：`AGENTS.md`（默认不入库）；提交：见项目 `AGENTS.md` / `doc\提交准则.md`
- 最近 5 条：
  - `memory/decisions/2026-11-12-大屏已计算按计算执行年度归属.md` · 大屏「已计算」按计算执行年度归属，窗口 KPI 仍只看所选年 · 2026-11-12
  - `memory/function_realize/2026-11-12-大屏本年未计算改按执行年度.md` · 大屏「本年未计算」改按计算执行年度（2026-11-12） · 2026-11-12
  - `memory/architecture/2026-11-11-库表分域与键类型约定.md` · 库表分域、键与类型约定（131 表口径） · 2026-11-11
  - `memory/architecture/2026-11-11-业务域与计算流水线.md` · 业务域与窗口计算流水线 · 2026-11-11
  - `memory/decisions/2026-11-11-本地提交与规则文件不入库.md` · 提交只落本地，AGENTS.md 与提交准则不进库 · 2026-11-11
- 召回：`node "D:\codeData\myself\luanyujia-workbench\12-源码照搬\工具\记忆.mjs" recall --project "D:\codeData\workData\workCode\mlw" "<关键词>"`
<!-- AUTO:END -->

## 当前状态（手写，≤3 行）
- 态势大屏已落地（9 个 `/screen/*` + 前端 9 区域）；2026-11-12「本年未计算」改按计算执行年度认任务（`b7cb7c1d`，未 push），窗口 KPI 仍只看所选年。
- 未联调（无 Nacos/DB）：2027 视图重算前 KPI 0 属预期、ECharts 命中、权限点/菜单未验证。
- 高优：互斥恒 0（无写入方）；中优：跨页窗口口径、保电段数、后评估是否跟随待拍板。
