<!-- BEGIN personal-coding-standards -->
# 个人编码与 AI 协作规范（跨项目通用入口）

- 规范本体：`~/.dsh/standards/`（git 仓 `https://gitee.com/ydcy_studio/ai-compilation-specifications` 的克隆目录；正文在 `specs/个人编码与AI协作规范.md`，同目录另有 4 份技术栈附录：Java/Spring Boot、Vue3、Python/FastAPI、SQL 与数据库，以及 2 份通用协作附录：文档记忆体系 `附录-文档记忆体系.md`、提交准则 `附录-提交准则.md`）。
- 适用于**任何项目、任何技术栈、任何仓库**。若写代码任务开始时上述规范未进上下文，请先读取正文再动手。
- 优先级：**铁律层任何项目不得豁免**——任务分级与 dsh-graph 路由、中文伪代码（以 `// 1. xxx` 编号注释直接写进实现代码，标关键步骤的业务语义，不逐行注释、不单独出文档）、先思路后代码、数据来源必须可证明、不静默兜底、交付必附缺陷/边界/验证用例；技术栈、目录、命名、构建约定服从所在仓库。冲突裁决顺序：用户当轮指令 > 铁律层 > 项目层 > 个人偏好层（`specs/个人偏好.md`，只提供默认值）> 技术栈附录默认值。
- 自检：装了规范不代表生效，`powershell -File ~/.dsh/standards/install/verify.ps1`（pwsh 7 同理）分五段查本体/入口/常驻记忆/项目落地/漂移，`-Segment` 可只跑一段、`-Json` 出机器可读结果；项目侧用 `-Segment project,drift -Project <目标仓>` 复核。
- 提交纪律：一个提交 = 一个可独立审查/验证/回滚的逻辑单元；按逻辑单元提交，不按工具动作/每次修改提交，同一单元未推送前用 amend/squash 收敛；非生成文件 > 12 个或变更 > 400 行先拆分（理想 ≤ 8 个 / ≤ 300 行）；消息写 `type(scope): 中文摘要`，禁止 `1`/`update`/`fix bug`；默认只落本地，push 由人确认。详见 `附录-提交准则.md`。
- 项目迁移：拉取本仓后按 README「迁移到具体项目：AI 执行顺序」0–8 步落地，用 `~/.dsh/standards/install/project-spec-checklist.md` 填写迁移矩阵与待确认清单；每个项目值必须能指到目标仓库文件，证据不足的项必须问人，**不得自主决定**。
- dsh-graph：当前会话实际提供 `graph_*` 时，S 级开发任务不强制建目标，M/L 级必须创建或复用 graph 目标并按流程执行；用户指定既有目标时禁止旁路，执行前由当前任务会话接管 supervisor。规则、规范、协作机制等文字治理任务可由主管主会话直接实施，不强制派执行子代理；该例外不适用于常规功能开发。
<!-- END personal-coding-standards -->

## 本工作台补充（块外内容，不属于通用规范；install.ps1 只替换上面的标记块）

- 规范本体在本机有两份克隆：`~/.dsh/standards`（安装目录，被本文件引用）与 `D:\codeData\myself\ai-compilation-specifications`（开发目录）。改完推 gitee，再 `git -C ~/.dsh/standards pull`。
- 本工作台的固定接入流程：技能 `project-onboarding` + `外壳\scripts\接入项目.mjs`（工作区 → 会话 → 回写面板）。
- 推送例外：`luanyujia-workbench` 已获准自主推送 gitee `hunao-workbench` 里的 `main`；原仓 `upstream` 的 push 已置 `DISABLED`。
- 这里的记忆就是文件：`引擎数据\.dsh\场景记忆\`（场景私有记忆 §〇 交接 / §五 只追加、项目**薄卡**按项目分文件、`_共享记忆` 放跨场景内容）、项目正文 `<项目根>\memory\`（默认 `.gitignore` 忽略，按问题用 `工具\记忆.mjs` 召回）与 `引擎数据\.dsh\skills\`（技能正文按需读）。本工作台不用 `.mnemon` 常驻记忆，铁律靠**本文件每轮注入** + 技能按需读正文；**不要把规范正文复制进场景记忆、项目 `memory\` 或技能**（三份必漂移）。
- **开场读交接只要 2–4 KB**：`node 12-源码照搬\工具\场景记忆.mjs 读 --场景 <场景目录> --节 §〇`（场景目录见 `外壳\scenarios\<场景>-context.md`，如 `程序开发`）；⛔ 别整读 25 KB 的 `场景私有记忆.md`。项目记忆一律按需 `工具\记忆.mjs recall`，别整贴 `memory\`。

## 省 token 作业法（块外内容；2026-11-11 按实测定的）

> 实测：6 条会话一天 2.95 亿 token，**99.3% 是每一步重读历史**；工具返回占消息面 88–96%。
> 所以省 token 靠"少让东西进上下文"，不靠少说话。

- **一次一个主题**：换主题先收尾交接、开新会话；单会话过 150 步就停手（150 步之后每步要重发 20 万+）。
- **大文件不整读**：先 `grep` 定位，再 `read` 带 `offset/limit`（`renderers.js` 被整读 46 次是反例）。
- **命令输出只取尾巴**：`| Select-Object -Last 50`、`--oneline`、`-TotalCount`，别把整份日志/构建输出灌进上下文。
- **能一次算完就别分三轮**：同一份数据反复回看，每一轮都要把前面的历史再重发一遍。
- **记忆按需召回**：`node 工具\记忆.mjs recall --project <根> "关键词"`，不要把整篇记忆或整份 `memory\` 贴回上下文。
- **收尾三步**：结论进 `memory\` 与场景 §〇/§五 → 出交接 → 归档换新会话。
