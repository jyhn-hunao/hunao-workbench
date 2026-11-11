# mlw · 项目记忆

> 项目根：`D:\codeData\workData\workCode\mlw`｜场景：程序开发（code-dev）｜建单 2026-11-11｜最近更新 2026-11-11
> **业务记忆只住这里**：术语 / 数据来源 / 契约 / 领域规则都写本文件；跨项目规矩去 场景私有记忆。
> **来源与口径**：本文件首次填充 = 旧记忆引擎 `.mnemon` → 工作台文件记忆的迁移提炼（2026-11-11）。38 篇原文按篇存于 `归档\mlw-mnemon-2026-11-11.md`，本文件只留长期有用的结论；旧文里写 `develop-tjl` 是 2026-11-02 前后的检出分支，仓库当前分支是 `develop`。

## 状态区

- **状态**：进行中
- **一句话**：MLW = 电力系统中长期停电检修窗口规划与管理平台（Spring Cloud 微服务后端 + Vue3 管理端），主干是「粗筛→打标→分档→KNN→评分→优化」的窗口计算流水线，外围是年度计划与 BPM 审批、检修窗口后评估、态势大屏。
- **成果/证据**：仓库 `develop` @ `9bb9fc67`（领先 origin/develop 3 个提交）；工作区仍有未提交的态势大屏改造——`frontend/mlw-app-ui/src/views/pages/visualization/index.vue`（1244 行，diff +1437）与 3 个未跟踪组件 `screen/{RingBackdrop,ScreenTicker,ScreenYearCalendar}.vue` + `visualization/skeletonData.js`。知识侧：库表 11 域 131 表已核、后评估口径定稿（6 卡片）、`/screen/*` 8 个门面方法设计定稿但**后端未实现**。
- **下一步**：① 态势大屏 `index.vue` 按区域拆组件（1244 行已超提交硬上限 400 行，拆分方案此前只是提案、未获用户确认）；② 接 `/screen/*` 门面（权限点 `mlw:screen:list` 与菜单由用户配，不在开发任务内）；③ 后评估口径改过，存量统计快照要用户点一次「刷新」才更新。
- **已有档案**：`AGENTS.md`（项目规则）、`doc/commit-guidelines.md`（提交准则）、`doc/FunctionalDocumentation/态势大屏.md`（230 行）、`doc/dbsql/{pg,oracle,dm}`（版本化 DDL）、`doc/pdmaner/`（数据模型）、`doc/readme/`（前后端文档）。

## 一、领域与术语

- **业务域**：给设备选出可停电的窗口（时间窗 + 等级 + 评分）→ 据此编年度检修计划 → 走 BPM 审批 → 事后评估命中情况 → 上台态势大屏。所有页面与表都围绕这条主链。
- **流水线口径**：粗筛（候选窗口 `calc_window_candidate`）→ 打标（整点判据/标签）→ 分档（`window_level`）→ KNN（历史相似案例修正历史分）→ 评分（`total_score`，含 load/time/margin/history 四项）→ 优化（Pareto 方案 + 设备-窗口分配）。每次执行 = 一条 `calc_window_task`，`calc_task_id` 串全链路，`calc_version` 是版本号；算法能力由 `core/{coarse,tag,grade,knn,score,optimize}` 分域封装。
- **术语（按库表落地，别用同义词混写）**：
  - **候选窗口** = `calc_window_candidate`，`window_start/end` 是 `date`；`vetoed='1'` 是被硬否决的候选，**仍在表里**，查询必须显式加 `vetoed='0'`。
  - **判据** = 策略里的可执行表达式。一次判定拆三处（V2_0_215 后）：任务级快照 `calc_window_task_criterion_snapshot`（表达式定格、无索引）／整点明细 `calc_window_time_criterion.criterion_running_details jsonb`（左右值与单条结果）／汇总 `calc_window_time_criterion_summary`（真假/未知判据 ID 与标签计数，PG 数组列）。复现一次判定要三表联动。
  - **标签** = 判据命中后的业务标记（保电、覆冰期…），按设备按天去重落 `calc_window_day_label.labels`。
  - **窗口组** = 多设备任务（`task_type='MULTI_DEVICE'`）的合并窗口 `calc_window_group`；`group_score` 取成员**最低分**（短板），`group_level` 取最差等级，`group_status` VALID/INVALID。
  - **资源池** = `busi_window_resource`（PERSIST 成果）；`source_type` 区分单设备/多设备，`group_id` 只在窗口组来源时有值。页面上叫「窗口资源池」。
  - **后评估** = 拿「当前计算版本的窗口池」回比年度计划时段：命中即无缺口，未命中记 `NO_WINDOW`（无可用窗）。缺口类型与是否落窗**只落库**，不在填报表单展示。
  - **重大工程** = `plan_year_ext.plan_engineering_type='MAJOR'`；页面上的「重点工程」已统一并入重大工程。
  - **冷/热表** = 11 张 `_cold` 是任务成功后的历史副本，与热表 1:1 逐列一致；只查热表漏历史，只查 cold 漏当前。
- **边界**：不负责 CIM/PODC 采集本身（只消费 `raw_cim_*`）、不负责 BPM 引擎/网关/认证/Redis 封装（平台 starter 提供，不复制改写）、不负责态势大屏的权限点与菜单配置（用户负责）。

## 二、数据来源与业务规则

- **数据从哪来**：PODC/CIM 同步 → `raw_cim_*`（34 张，主键 `mrid`，只读镜像）；OMS/人工/模拟 → `raw_*`（17 张，带 `sync_task_id`）；标准层 `std_device_info`（`device_id uuid` + 唯一 `mrid`）与整点负荷 `std_device_time_load*`；审批记录来自 BPM（`bpm_*`）；KNN/评分/优化在 `core/*` 封装，外部算法服务是按环境准备的外部依赖。外部依赖还有 PODC/CIM、模拟/离散总线、DIA BPM、Neo4j。
- **谁维护**：设计事实源 = `doc/dbsql/{pg,oracle,dm}` 版本化脚本（**无 Flyway，全部人工执行**）；运行态事实源 = 公司开发库结构导出。
- **两个事实源，别混**：
  - 仓库 `doc/dbsql/pg/V2_0_0__init.sql`：空库基线 **128 张 CREATE TABLE**；增量到 `V2_0_232`，`doc/dbsql/pg` 共 **247 个脚本**；`V2_0_232` 号**重复两个文件**（`raw_cim_ac_line_segment_extend`、`criterion16_description`），加脚本前先核最大号。
  - 开发库导出（2026-11-10 09:19，`mlw_dev.sql`，321 KB / 4966 行）：**131 表**、269 条索引（234 普通 + 35 唯一）、131 条表注释 + 1830 条字段注释；**无外键/触发器/视图**，仅 6 个 `GENERATED ALWAYS AS IDENTITY` 列。10 月 27 日那版（126 表）只作 diff 留档。
- **分域**：计算流水线 36（23 热 + 11 冷 + 2 配置）／成果发布 1（`busi_window_resource`）／CIM 同步层 35（34 `raw_cim_*` + `cim_status`）／原始业务同步 17／标准与运行 9／策略规则 18／年度计划 5／流程审批 3／基础台账与断面 6／定时任务日志 1。合计 131。
- **键与类型约定**：`calc_*` 结果表主键一律 uuid、且都带 `calc_task_id`；审计主流 `create_time/create_user/update_time/update_user` + `deleted bpchar(1) DEFAULT '0'`（`'0'` 未删），`plan_*/bpm_*/raw_cim_*` 改用 `created_*/updated_*`——不要混用。JSON 一律 jsonb；唯一例外是 summary 表的 `integer[]/bigint[]` 数组列（MyBatis 要 TypeHandler，不能当 jsonb 处理）。
- **窗口类型三套，跨表不能直接比**：candidate=`date`、busi/group=`timestamp(6)`、`optimize_assign.window_start/end`=`varchar(32)`。
- **设备两条主线**：业务侧 `device_id uuid`（枢纽是 `std_device_info`）↔ CIM/台账侧 `mrid varchar`；`raw_cim_*` 必须经 `std_device_info.mrid` 映射才拿得到 `device_id`。
- **已核实的「设计 ↔ 运行态」漂移（写代码前必看）**：① `mlw_task_log` 在开发库已改名 `mlw_dev_task_log`，仓库脚本与实体 `MlwTaskLog` 仍是旧名（按开发库结构写日志会 42P01）；② `data_maint_capacity` 开发库已删，检修容量改从 `data_ops_hist_maint` 取（`MonthMaintCapacityIndex` 只注入 `OpsHistMaintMapper`，全后端已无旧表引用）；③ `calc_window_time_criterion(_cold)` 运行态是 7 列 + `criterion_running_details jsonb`，init 里的 24 列是 V2_0_215 之前的形态（按 24 列写会报列不存在）。
- **无外键、无级联**：清理/插入顺序由应用保证，按「子表 → 头表」：`_device_job`/`_device`/`_summary`/`_criterion` 先于 `calc_window_task`，`busi_window_resource` 最后。
- **后评估口径（2026-11-02 定稿）**：统计范围 = **全部有效计划**（非作废 + 有时段 + 有停电设备），不是「只算已发布」；缺口类型**只剩 `NO_WINDOW`**，「批次不符 BATCH_MISMATCH」整体取消（旧文档里关于批次不符的预期值已失效）；命中判定 = 计划时段落在**当前计算版本**窗口池内；`plan_year.window_calc_version` 字段保留（填报选窗还在用），只是后评估不再拿它分缺口类型。
- **「计算版本」取值（commit ec6f8f8 之后）**：取「该计划年有窗口数据（`busi_window_resource` 区间重叠）的最近 SUCCESS 任务」，取不到才回退全系统最近成功任务；`plan_year_eval_stat.calc_time` 只作审计。后评估概览的「计算版本」卡片已删，版本信息留在「评估摘要」第 2 行。
- **演示数据约定**：`doc/dbsql/mock/2027_plan_evaluation_demo.sql` 只准备源数据，**缺口/跟踪/统计必须由页面「刷新」计算生成**；清理段只删 `mock2027%` 行，绝不删用户已有的计划/窗口/任务数据。
- **脏字段与坑**：`plan_year.work_content` 是对象数组 `[{"summary","content","workType"}]`（summary=短标题、content=明细），仓内 4 处展示口径不一致，工程列取 summary → content → 变电站名 回退；`calc_window_day_label` 主键拼写是 `calc_day_lable_id`（**lable**）；`calc_window_knn.row_type` 取值 DDL 没注释，别臆造含义。

## 三、接口与契约

- **统一返回**：`com.xh.bp.enums.ResponseData<T>`（`ok`/`page`/`failMessage`/`Nothing.VALUE`）；Controller 跟相邻写法 `try/catch (XhBusinessException)` → `failMessage`，兜底 `GlobalExceptionHandler`；契约变更要同步 Controller → `mlw-sdk-main` → 前端 `src/api/**` 与页面。
- **后评估**（`/window/post/evaluate` 一组，`PlanEvaluationController` + `PlanEvaluationServiceImpl`）：概览 / 缺口分页 / 跟踪分页 / 「查看检修计划」只读弹窗复用；列表已拆表（`plan_eval_gap_item`、`plan_eval_track_item`）走数据库分页，`plan_year_eval_stat.stat_json` 只存卡片摘要；概览 6 张卡片 = 绑定命中率 / 最优命中率 / 检修申请 / 重大工程覆盖 / 命中缺口 / 窗口资源池（3 列 × 2 行，≤1200px 降 2 列、≤768px 降 1 列）。
- **年度计划**：`plan/year/report/list` 曾无条件 `isNull(process_instance_id)` 导致只返回 1 条（commit b2c228e 已修）；绑定命中按「设备 + 时段完整包含」判定，未发布计划不计；填报列表的 `process_instance_id` 过滤是硬条件，别再当 bug 反复查。
- **态势大屏**：后端 `/screen/*` 门面 8 个方法，统一权限点 `mlw:screen:list`（不复用带 `@HasPermission` 的业务接口）；只有 `GET /screen/device-coverage`（设备三桶聚合）与 `GET /screen/major-tracks`（分批 + 里程碑 + 审批时间，每批固定 3 条 SQL 消 N+1）需要新 SQL，其余 6 个薄转发。前端落点：`visualization/index.vue` 大屏容器、`components/screen/*`、`composables/useScreenData.js`（分档刷新/暂停/可见性/失败隔离）、`api/mlw/screen.js`。
- **前端请求链路**：`OSPath = /${VITE_SUB_OS_CODE}${VITE_SUB_DEVELOP_INSTANCE}`，开发实例得 `/mlw-tjl`；`VITE_SUB_OS_CODE` 同时是授权中心菜单编码，**必须留 `mlw`**；开发代理只剥 `/api`；网关 route 必须 `StripPrefix=1`（后端 context path 是 `/`，否则 404）；后端 `REGISTER_IP` 必须是网关可达的局域网 IP（127.0.0.1 会让远程网关回连失败 → 500）。
- **Nacos**：`NACOS_CONFIG_NAMESPACE`（默认 `mlw`）与 `NACOS_DISCOVERY_NAMESPACE`（本机远程实例用 `bp200rc2`）相互独立；单个 Spring Cloud Alibaba 应用只能读**一个** config namespace（`spring.config.import` 没有 namespace 参数），跨 namespace 只能多客户端或同 namespace 拆 dataId。**改服务名要同时确认 `SERVER_CONFIG_NAME`**，否则读不到配置。

## 四、技术栈与目录

- 后端 Java 21 / Spring Cloud（父 POM `com.xh:bp-cloud:2.0.0-RC2`）/ MyBatis-Plus；前端 Vue 3 + Vite 6 + Element Plus + ECharts 6。
- 关键目录：`backend/mlw-project-main/{mlw-sdk-main,mlw-server-main}`、`frontend/mlw-app-ui/`、`doc/dbsql/{pg,oracle,dm}`、`doc/readme/`、`config/nacos/`（示例，非生效配置）。
- 注入风格 `@Resource` 字段注入；日志 Lombok `@Slf4j`；多表 SQL 进 `resources/mapper/*.xml`。
- 命令：后端 `./mvnw -q -pl backend/mlw-project-main/mlw-server-main -am -DskipTests compile`；测试 `./mvnw -pl backend/mlw-project-main/mlw-server-main -am test`（89 个测试类，按改动选跑）；规则 `node --test agents-policy.test.js`；前端 `npm run build`。**本机常缺 BP 制品/Nacos/开发库**，跑不了就写"未执行"，别把编译通过说成联调通过。

## 五、规范与提交

- 项目规则 `AGENTS.md`：**视为用户本地配置，绝不提交**（`git update-index --skip-worktree` 保持本地版本）。
- 提交准则 `doc/commit-guidelines.md`：**同样绝不入库**（已加入 `.git/info/exclude`），不要提交、也不要顺手 `git add -A` 带上。
- 粒度：一个逻辑单元 = 一个可独立审查/验证/回滚的提交；理想 ≤ 8 文件 / ≤ 300 行，硬上限 **12 文件 / 400 行**；同一单元未推送前用 amend/squash 收敛，禁止按工具动作/每次编辑提交。
- 消息 `type(scope): 中文摘要`；scope 词表固定 `backend`/`sdk`/`pipeline`/`frontend`/`dbsql`/`doc`/`build`/`rules`。
- **远程：提交只落本地，禁止 AI push**，必须等用户验收后由用户自己推。
- 交付参考来源要标 `// [REF-<文件缩写>#<方法名>]`（源：旧常驻记忆，见 §六 2026-11-11 条）。

## 六、决策与坑（只追加）

- 2026-10-28（缺口语义）：后评估缺口类型先后经历「无可用窗 + 批次不符」→ 2026-11-02 收敛为 **NO_WINDOW 单一类型**，删掉 `resolveGapType`/`matchInPlanVersion`/`loadBatchContext` 与 `BATCH_MISMATCH` 常量、前端分支与单测用例；存量 `BATCH_MISMATCH` 靠一次「刷新」收口（`plan_eval_gap_item` 按年整体删重建）。
- 2026-11-02（统计范围）：后评估从「已发布计划」改为「全部有效计划」——影响卡片、缺口、重大工程与回写范围；演示 SQL 的预期值随之变化，旧文档数值作废。
- 2026-10-28（列表只 1 条）：`YearPlanServiceImpl` 无条件 `isNull(process_instance_id)`；演示 SQL 统一置空 `process_instance_id` 才让 report/list 全部可见。
- 2026-10-30（MyBatis-Plus 坑）：`updateById` 默认忽略 null ⇒「重大工程改否」不落库；修法是字段 `@TableField(updateStrategy = FieldStrategy.ALWAYS)`，并清理表单状态残留（弹窗关闭后状态没重置会带出上一条）。
- 2026-11-03（前端坑）：Element Plus `el-card` 的 flex + `__body{overflow:auto}` 在固定高布局里会让每张卡片各自出竖向滚动条；口径是整页滚动、卡片 `flex-shrink:0`、body `overflow:visible`。
- 2026-10-30（前端路由）：要「应用内菜单式跳转」用 `router.push` + `AdminLayout` 监听 + `tabsStore.openTab` 自动开页签，不要 `window.open`（会脱离页签体系）。
- 2026-11-09（大屏口径）：Q1 计划集合 = 全部有效计划；Q2「重点」= 重大工程；大屏走 `/screen/*` 门面而不是复用业务接口，权限点只铺一个；固定 1920×1080 画布 + `scale(min(vw/1920, vh/1080))` 等比缩放，不做流式（流式缩到 1366 时月份格只剩 2–3px，物理不可见）。
- 2026-11-09（大屏剔除清单）：里程碑「开工/完工」、供需错配天数、可研考核缺口、自动摘要都**没有数据源**，剔除而不是造字段；「枯水期优先」「覆冰禁检修」无字段，降级为策略备注；「重点工程」并入重大工程。
- 2026-11-09（判据缺失行为，已静态证明）：判据 7/9 的表达式 `in_icing_season()`/`in_power_guarantee()` 在规则集合为空时 `SeasonWindowMatch.anyRule` 直接返回 false ⇒ 不产生 `FORBID*` 标签 ⇒ 粗筛只在 `forbidHit` 为真时剔除 ⇒ **缺约束时窗口照常生成**；同一链路也解释了「缺时序数据 → 无低谷 → 候选为空 → 无窗」。失效条件：有人把判据表达式改成依赖数据存在性。
- 2026-11-10（库表口径）：DB 知识从 126 表更新到 **131 表**（`mlw_dev.sql`），判据三表拆分、设备级执行表与打标队列、自定义窗口组、`candidate.vetoed`、`task_type` 都是这轮新增；旧 126/69 表的口径作废。
- 2026-11-10（提交纪律落地）：`agents-policy.test.js` 3/3 通过是改规则的 gate；`git commit -F <消息文件>` 若文件带 BOM，会把 `\ufeff` 写进提交标题（`git cat-file commit <hash>` 看首字节 239,187,191 可确认），消息文件必须无 BOM 写入。
- 2026-11-11（记忆迁移）：旧引擎 `.mnemon` 有 38 篇文档 + 8 条常驻记忆 + 2 条库表洞察；迁进工作台文件记忆的分工——跨项目的「REF 参考来源标记」进场景私有记忆 §五；本项目专属的（AGENTS.md 不入库、`doc/commit-guidelines.md` 不入库、提交只落本地）写在本文件 §五；「记忆落点分层」那套规则随旧引擎一起作废；38 篇原文整篇存 `归档\mlw-mnemon-2026-11-11.md`。
- 2026-11-11（仓库现状）：检出分支从 `develop-tjl` 换到 `develop`，本地领先 origin 3 个提交；`visualization/index.vue` 的大屏改造尚未提交、3 个 screen 组件未跟踪——动这块前先问用户是否要延续该工作区状态，别 `checkout`/`clean` 覆盖。

## 七、待办

- 态势大屏：`index.vue` 拆组件（目标每个 ≤ 300 行）→ 接 `/screen/*` 8 个门面；剩余区域(8) 的两张卡（数据就绪三态 + 风险告警）方案待用户最终确认。
- 后评估：口径变更后让用户点一次「刷新」，否则页面还是旧措辞/旧字段值。
- 提交：工作区的大屏改造要按 `doc/commit-guidelines.md` 分成逻辑单元（骨架/布局 → 动效 → 数据接线），单提交不得超 400 行。
