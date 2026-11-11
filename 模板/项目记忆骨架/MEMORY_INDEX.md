# <项目> · 记忆索引

> 唯一检索入口：只放类目入口与稳定根文档，**不逐篇列文件**。
> 正文默认不入库：`.gitignore` 忽略 `memory/` 与 `AGENTS.md`，除非项目特别说明。

## 类目

| 类目 | 收什么 | 入口 |
|---|---|---|
| architecture | 架构、仓库边界、职责划分 | `architecture/README.md` |
| interfaces | 接口、字段、消息与跨服务契约 | `interfaces/README.md` |
| runbooks | 操作、联调、排查、验收步骤 | `runbooks/README.md` |
| pitfalls | 已复现的坑（现象 → 原因 → 判据 → 绕法） | `pitfalls/README.md` |
| decisions | 已确认的决策与长期规则（含被否方案） | `decisions/README.md` |
| function_realize | 一次功能变更的方法流转 | `function_realize/README.md` |
| sql-log | 需人工执行、审核、追溯的 SQL | `sql-log/README.md` |
| handoffs | 会话交接（仅在用户明确要求时写） | `handoffs/README.md` |
| archive | 过期但需留痕的记录 | `archive/README.md` |

## 稳定根文档

- 项目规则：`../AGENTS.md`（默认不入库）
- 提交准则：`../doc/提交准则.md`（若存在）

## 检索顺序

1. 本文件 → 类目 `README.md`；
2. 召回：`node 工具\记忆.mjs recall --project "<项目根>" "<问题>"`；
3. 命中后只读命中文件；空命中直接读代码，不阻塞、不猜。
