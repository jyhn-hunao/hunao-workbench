# 社交 · 定位卡

- 场景 id：`social`
- 一句话：**只做通道，不做人格**。这个场景没有 AI 会话；消息流的来源是「胡闹的大肥鱼」人格场景的会话，QQ / 飞书的回复也由那边生成。
- 面板：`外壳\scenarios\social.json` —— **一个平台一格卡片**：`ch-qq`（`type:"chan"`, `channel:"qq"`，右上带「⚙ 控制台」）、`ch-feishu`（`channel:"feishu"`）；右侧 `so-msg`「全部消息」保留合并流用于对时。加平台 = 再加一个 `chan` 面板（`channel` 写新 key，并在 `外壳\社交.js` 的 `channelStates` 里补一条状态来源）
- 桥接控制台：SnowLuma（QQ 个人号协议端）随工作台一起启动、一起退出；控制台**不常驻面板**，入口是 `so-msg` 标题栏的「⚙ 桥接」按钮（点开才起窗口）。配置在 `外壳\data\桥接.json`（本机，gitignored）
- 记忆：`引擎数据\.dsh\场景记忆\社交\` 只放**通道参数与排障口径**；人格与对话记忆在 `场景记忆\胡闹的大肥鱼\`（`记忆\` 长期、`对话\` 流水）
- 通道：`@xmanrui/dsh-im 5.10.0`（飞书，装在本机 web profile）+ `dsh-onebot-channel 0.15.2`（QQ 个人号，协议端用 SnowLuma 自建、已随壳启停），接法与验证清单见 `插件\社交通道\说明.md` §6.1

## 边界（写代码和写提示词时都按这三条）

1. **通道层不生成内容**：`so-msg` 只读 transcript，不写会话、不建第二个人格。要改人格去 `场景记忆\胡闹的大肥鱼\`。
2. **路由绑定**：`%USERPROFILE%\.dsh\qq-bridge.config.json` 的 `routes.private["<对方QQ>"].sessionId` 必须指向 `pet.json` 的 `pet-ai` 会话；换人格会话后**必须同步**，否则插件会把消息投回旧会话。
3. **三类必审仍在人格层**：涉及钱、承诺、个人信息的回复，等用户确认再发（口径见人格卡 §〇）。

## 还没做的

- 飞书一侧：凭据与白名单还没在「设置 → IM机器人」绑（`so-msg` 通道状态显示 `[warn]` 就是它）。
- `so-msg` 的 `describeConversation`（补渠道 / 群 / 发言人字段）等飞书真通了再补。
