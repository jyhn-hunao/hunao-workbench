# mlw · 记忆薄卡

> 正文在 `<项目根>\memory\`；本卡只放指针，不放业务知识。

<!-- AUTO:BEGIN -->
- 项目根：`D:\codeData\workData\workCode\mlw`
- 记忆索引：`memory\MEMORY_INDEX.md`（分类见各目录 README）
- 项目规则：`AGENTS.md`（默认不入库）；提交：见项目 `AGENTS.md` / `doc\提交准则.md`
- 最近 5 条：
  - `memory/architecture/2026-11-11-库表分域与键类型约定.md` · 库表分域、键与类型约定（131 表口径） · 2026-11-11
  - `memory/architecture/2026-11-11-业务域与计算流水线.md` · 业务域与窗口计算流水线 · 2026-11-11
  - `memory/decisions/2026-11-11-本地提交与规则文件不入库.md` · 提交只落本地，AGENTS.md 与提交准则不进库 · 2026-11-11
  - `memory/decisions/2026-11-11-编制漏斗分母改为全部计划.md` · 编制漏斗分母改为“全部计划”，不再用上一段转化率 · 2026-11-11
  - `memory/decisions/2026-11-11-大屏各年只看各年与窗口KPI含多设备.md` · 大屏各年只看各年、默认当前年、窗口 KPI 含多设备 · 2026-11-11
- 召回：`node "D:\codeData\myself\luanyujia-workbench\12-源码照搬\工具\记忆.mjs" recall --project "D:\codeData\workData\workCode\mlw" "<关键词>"`
<!-- AUTO:END -->

## 当前状态（手写，≤3 行）
- 态势大屏已落地（HEAD `1584e2ef`，9 个 `/screen/*` 接口 + 前端 9 区域）；基线：后端 14/14、前端 14/14、build 通过。
- 未联调（本机无 Nacos/DB）：真实返回、ECharts 缩放命中、整体视觉未验证；`mlw:screen:list` 权限点与菜单待人工配。
- 已知高优：互斥恒为 0（`plan_year_conflict` 无写入方）；中优：跨页窗口数口径、保电段数口径待拍板。
