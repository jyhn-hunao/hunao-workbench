# 社交 · 定位卡

- 场景 id：`social`
- 一句话：**只做通道，不做人格**。这个场景没有 AI 会话；消息流的来源是「胡闹的大肥鱼」人格场景的会话，QQ / 飞书的回复也由那边生成。QQ 每个私聊/群聊可各自绑一条独立 DSH 会话，避免多聊天串上下文。
- 面板：`外壳\scenarios\social.json` —— **一个「通道」面板收所有平台**（`ch-hub`, `type:"channels"`）：内部并列 `ch-qq`（`channel:"qq"`，带「⚙ 控制台」）、`ch-feishu`、`ch-wechat`（`selfCheck:true`，带启动/停止/自检/发测试/钉账号）；每个平台不再单独占一格。右侧 `so-msg`「全部消息」保留合并流用于对时；底部 `sl-console`（`type:"embed"`）是 SnowLuma 控制台面板。加平台 = 在 `ch-hub.channels` 数组加一项（`key` 写新 key，并在 `外壳\社交.js` 的 `channelStates` 里补一条状态来源）。`ch-hub` 标题栏有「收起/展开」，收起只留三列标题。
- 桥接控制台：SnowLuma（QQ 个人号协议端）随工作台一起启动、一起退出；控制台是场景里的**固定面板** `sl-console`（`type:"embed"`，本机 5099，与旧浮动窗共用 `persist:webai-snowluma` 登录态），入口是 `so-msg` 标题栏「⚙ 桥接」与 `ch-qq` 列「⚙ 控制台」——点一下滚到面板并展开，不再弹窗。配置在 `外壳\data\桥接.json`（本机，gitignored）
- 聊天档案库：社交「通道」标题行常驻入口。面板是 **SQLite 库视图**（库规模、存储结构、最近入库、原文查询、按天浏览、记忆表），默认不按聊天分类铺列表；会话分类看右侧 `so-msg`「全部消息」。档案库 `引擎数据\.dsh\社交档案\chat-archive.db` 只读查询，不发消息。
- 记忆：`引擎数据\.dsh\场景记忆\社交\` 只放**通道参数与排障口径**；人格与对话记忆在 `场景记忆\胡闹的大肥鱼\`（`记忆\` 长期、`对话\` 流水）
- 通道：`@xmanrui/dsh-im 5.10.0`（飞书，装在本机 web profile）+ `dsh-onebot-channel 0.15.2`（QQ 个人号，协议端用 SnowLuma 自建、已随壳启停），接法与验证清单见 `插件\社交通道\说明.md` §6.1

## 边界（写代码和写提示词时都按这三条）

1. **通道层不生成内容**：`so-msg` 只读 transcript，不写会话、不建第二个人格。要改人格去 `场景记忆\胡闹的大肥鱼\`。
2. **路由绑定**：`%USERPROFILE%\.dsh\qq-bridge.config.json` 的 `routes.private["<对方QQ>"]` / `routes.group["<群号>"]` 的 `sessionId` 决定消息投给哪个 DSH 会话。QQ 卡片「QQ 会话隔离」显示每条 route 是**独立会话**还是**共用人格主会话**；「接入并建独立会话」会用 `建会话.mjs` 建新会话并写回 route，群号加进去后插件才会监听该群。换人格会话后只同步仍共用主会话的 route；`chatMode=per-chat` 的独立 route 不动。不要手改 id，也不要让多个聊天共用一条会话。
3. **三类必审仍在人格层**：涉及钱、承诺、个人信息的回复，等用户确认再发（口径见人格卡 §〇）。
4. **QQ 群旁听 / 随机接话**：只对已绑定到独立 DSH 群会话的群生效；`外壳\data\QQ群聊\旁听\<群号>.jsonl` 存最近 600 条群上下文，群卡片「QQ 群旁听 / 随机接话」显示已连/未连、已绑定群数、最近跳过原因。随机接话默认关，打开后仍受接话窗口、静默重置、冷却、每分钟上限、群地址保护约束；普通 @ 回复仍由 `dsh-onebot-channel` 处理，二者不抢。
5. **QQ 媒体层**：`外壳\QQ能力.js` 负责群语音转写（DeepSeek ASR）、群随机语音回复和千问表情包（`pet3d\表情包\QQ千问`，兼容 `鲸鲸千问`）。语音合成可在 QQ 卡片「QQ 语音 / 表情包」里选 **Windows SAPI** 或 **BreezeBlue**：Breeze 走 `wav_24000`，再交给现有 pysilk 编 SILK；Key/音色/演绎指令都在同一张卡片配置，Key 只显示末尾四位。配置落 `外壳\data\QQ能力.json`，日志在 `外壳\data\QQ能力\通道.log`。普通 @ / 私聊的语音出站由 `外发闸门.js` 的 3100 代理在正文成功后补发（`voiceReplyMentions` / `voiceReplyPrivate`，默认关）；群随机由 `QQ群聊.js` 发，代理用 `x-wb-voice-skip` 跳过，避免两条语音。微信原生语音不重写鲸鲸合成器：同一份 Breeze 配置通过「同步到微信原生语音」写入 `D:\whale-girl\data\settings.json`，鲸鲸自己的 `voice-send.json` 策略决定何时发。

## 还没做的

- 飞书一侧：凭据与白名单还没在「设置 → IM机器人」绑（`so-msg` 通道状态显示 `[warn]` 就是它）。
- `so-msg` 的 `describeConversation`（补渠道 / 群 / 发言人字段）等飞书真通了再补。
