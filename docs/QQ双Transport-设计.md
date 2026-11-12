# QQ 双 Transport 设计：保留 OneBot，接入官方机器人

> 目标：不替换现有 QQ 桥；在它上面抽一层 transport 接口，让 OneBot 和 QQ 官方机器人二选一接入，DSH 侧只认归一化消息。  
> 日期：2026-11-11

## 1. 总原则

- **保留现有 OneBot 路径**：`onebot.js`、`normalize.js`、`router.js`、`group-board.js`、`guard.js`、`QQSessionMap`、`QQOutbound` 都不重写。
- **只抽传输层**：把「连 QQ / 收消息 / 发消息」抽成 `QQTransport`；OneBot 是第一个实现，官方是第二个。
- **二选一，不并行**：配置 `transport: "onebot" | "official"`，同一时间只启用一个。
- **能力差异显式化**：官方不是 OneBot 的等价替代；用 `capabilities()` 告诉核心「群消息范围 / 能否主动 / 有没有历史 / 回复方式」。
- **核心按能力降级**：官方模式不假设全群上下文、不主动发、不回填历史；UI/文档显示当前 transport 和群消息范围。

## 2. 架构

```
QQ 事件源
  ├─ OneBotTransport   （NapCat / LLOneBot 正向 WS）
  └─ OfficialTransport （QQ 机器人 API v2，WS/Webhook）
            │
            ▼
     normalize（各自实现，输出同一 schema）
            │
            ▼
  router/classify → GroupBoard → QQSessionMap → DSH agent
            ▲
            │
       QQOutbound → transport.reply(target, text, opts)
```

核心层（router/board/session/guard/outbound）不知道底层是 OneBot 还是官方；它只拿到：

```js
{
  transport: 'onebot' | 'official',
  kind: 'group' | 'private',
  chatKey: 'qq:group:<id>' | 'qq:owner',
  userId, groupId, senderName,
  text, msgId, replyId, time,
  atSelf, mentionedBot,
  raw
}
```

## 3. 接口

`qq-bridge/src/transport.js`：

```js
class QQTransport {
  async connect() {}
  async close() {}
  on(event, handler) {}        // 'message' | 'ready' | 'error' | 'close'
  async reply(target, text, opts) {}
  capabilities() {}
}
```

`reply` 的 `target`：

```js
{
  kind: 'group' | 'private',
  id,            // group_openid / user_openid / QQ 群号 / QQ 号
  userId,        // 提问者
  senderName,
  replyId,       // OneBot reply id / 官方 msg_id
  messageId
}
```

`opts`：

```js
{
  mentionSender: true,   // 群回复自动 @ 提问者
  msgSeq: 1              // 官方被动回复序号
}
```

`capabilities()`：

```js
{
  groupScope: 'full' | 'mention-only',
  canProactive: boolean,
  canHistory: boolean,
  canGroupInfo: boolean,
  canLoginInfo: boolean,
  maxReplyLength: number,
  replyMode: 'onebot-segments' | 'official-passive'
}
```

## 4. 现有代码怎么复用

| 现有文件/能力 | 现在做什么 | 双 transport 后 |
|:--|:--|:--|
| `qq-bridge/src/onebot.js` | OneBot WS 客户端 | 保留；外面包 `OneBotTransport` |
| `qq-bridge/src/normalize.js` | OneBot 事件 → 内部消息 | 保留；`OneBotTransport` 内调用 |
| `qq-bridge/src/router.js` | owner/群 @ 分类 | 不动；官方 normalize 输出同 schema |
| `qq-bridge/src/group-board.js` | 群友 24h 分板 | 不动；官方只写入 @ 消息 |
| `qq-bridge/src/guard.js` | 发送节流/去重 | 不动；官方受 5 分钟/5 次限制，guard 仍有用 |
| `qq-bridge/src/public-projects.js` | 群公开项目白名单 | 不动 |
| `dsh-plugin/src/qq/session-map.js` | `qq:owner` / `qq:group:<gid>` 会话映射 | 不动；官方用 `group_openid` 作为 `<gid>` |
| `dsh-plugin/src/qq/outbound.js` | assistant 文本 → QQ | 改注入 `transport.reply`，不再直接调 OneBot |
| `dsh-plugin/src/qq-plugin.js` | 组装事件、群队列、owner 绑定 | 改 `new OneBotClient` 为 `createTransport(cfg)`；其余复用 |
| `qq_bind_session` | owner 绑定已有 DSH 会话 | 不动；官方 C2C 也用 `qq:owner` |
| `source.kind='hexing-qq'` | 回合来源过滤 | 保留；额外加 `source.transport` 便于诊断 |

## 5. 差异清单（必须处理）

| 差异 | OneBot | 官方 | 处理 |
|:--|:--|:--|:--|
| 群/用户 ID | QQ 群号 / QQ 号 | `group_openid` / `member_openid` | `chatKey` 继续 `qq:group:<id>`；切换 transport = 新 ID/新会话 |
| 群名 | `get_group_info` | 官方通常拿不到群名 | 配置 `groupNames[group_openid]`；否则标题 `QQ群 <openid>` |
| 发送者昵称 | `sender.card/nickname` | 事件里通常只有 openid | 没名字就用 `群友 <短 id>`；可做本地别名表 |
| 群回复 @ | OneBot `at` 段 | 官方 Markdown `<qqbot-at-user id="..." />` + `msg_type:2` | 由 transport 的 `reply` 负责，核心只传 `mentionSender` |
| 被动回复 | `reply` 段 | `msg_id` + `msg_seq` | 由 transport 负责 |
| 群消息范围 | 传输层可能看到全群，但桥只处理 @ | 仅 @（未接全量订阅） | 两种实现的 `groupScope` 都是 `mention-only`；非 @ 不入分板 |
| 主动消息 | 可主动 | 下线/受限 | `canProactive`；官方 v1 不做主动 |
| 历史 | 基座本地有 | 无历史 API | `canHistory`；官方只从接入时刻开始 |
| 登录信息 | `get_login_info` | `READY` 事件给 bot 身份 | `canLoginInfo`；官方从 ready 取 selfId |
| 群信息 | `get_group_info` | 无 | `canGroupInfo`；核心跳过并 fallback |
| Token | WS token | access_token 会过期 | 官方 transport 自动刷新 |
| 回复窗口 | 无 | 群 5 分钟 / 私聊 60 分钟 | 超时直接报错；长任务要先回“收到”再补最终（消耗 2 次） |
| 回复条数 | 可多段 | 每条用户消息最多 5 次 | 官方 v1 一轮一条；多气泡合并 |
| 消息长度 | 取决于基座 | 官方文本上限 | `maxReplyLength`；超长截断/合并 |
| 群主权限 | 不需要 | 群主加 bot；全量模式还要群主开 | 官方只做 @，避开全量权限 |

## 6. 配置

```json
{
  "transport": "onebot",
  "ownerId": "QQ号（onebot）/ user_openid（official）",
  "ownerOpenId": "官方模式的 owner user_openid",
  "groupEnabled": false,
  "onebot": { "url": "ws://127.0.0.1:3001", "token": "" },
  "official": {
    "appId": "",
    "clientSecret": "",
    "intents": ["GROUP_AND_C2C_EVENT"],
    "groupNames": { "<group_openid>": "群名" }
  }
}
```

- 默认 `transport: "onebot"`，现有用户不受影响；
- `transport: "official"` 时校验 AppID/Secret，不再连 OneBot；
- `ownerId` 在官方模式填 `user_openid`，或单独用 `ownerOpenId`；
- `groupEnabled` 仍默认 `false`。

## 7. 分阶段落地

### 阶段 1：抽接口，不改行为

- 新增 `transport.js`、`onebot-transport.js`；
- `onebot-transport` 包装现有 `OneBotClient` + `normalizeEvent`；
- `qq-plugin.js` 改为 `createTransport(cfg)`；
- 现有 OneBot 测试全过，行为不变。

### 阶段 2：官方 transport 骨架

- `official-transport.js`：AppID/Secret、access_token、WS 连接、READY、心跳/resume；
- 只支持 `C2C_MESSAGE_CREATE` 和 `GROUP_AT_MESSAGE_CREATE`；
- `reply` 带 `msg_id`/`msg_seq=1`；
- 单测用假事件，不连真 QQ。

### 阶段 3：真机联调

- 群主把 bot 加进测试群；
- 测：群 @、私聊、owner 绑定、UI 轮次不外发、5 分钟窗口、`msg_seq` 去重、群 board 只含 @；
- 官方模式不主动、不回填；UI/文档标注 `mention-only`。

### 阶段 4：能力补齐（可选）

- 群名映射/别名；
- markdown/按钮；
- 长任务“先收到再补最终”；
- 互动召回/主动消息（如果平台允许且你需要）。

## 8. 验收

- OneBot 旧路径：现有 31 + 15 项测试全过；
- 官方 normalize：`GROUP_AT_MESSAGE_CREATE`、`C2C_MESSAGE_CREATE` 字段映射正确；
- 官方 reply：`msg_id`、`msg_seq`、`<@openid>` 正确；
- 能力降级：官方模式不调 `get_group_info`、不主动、不假设全群；
- 会话：`qq:owner` 绑定可用；`qq:group:<openid>` 一群一会话；
- 来源过滤：只有 QQ 触发的轮次回 QQ，UI 轮次不外发；
- 切换 transport：旧会话归档，不串记忆。

## 9. 只读「QQ 群 24h 活动」面板

给“想看一眼群里 bot 说了什么”的用户一个只读窗口，但不把群聊变成 DSH 会话。

- **数据源**：`qq/groups/<gid>/members/<uid>.jsonl`（GroupBoard）；
- **范围**：只显示 @ 机器人的消息和 AI 回复，不含非 @ 群聊；
- **生命周期**：读取时 prune 24h；空板不显示；24h 后自动消失；
- **不建 DSH 会话**、不进主记忆、不写 raw/链；
- **入口**：总览页卡片「QQ 群 24h 活动」+ `/qq-groups` 列表页；不额外占侧边栏；
- **字段**：群名/openid、成员别名/openid、时间、@ 内容、AI 回复；
- **API**：`GET /api/qq-groups`，只读，仅本机；
- **官方模式**：群名拿不到时显示配置 alias 或 `QQ群 <openid>`；
- **默认**：最新 50 条，可按群/成员筛选（后置）。

## 10. 结论

**不替换，只加一层。**  
OneBot 继续做“传输层可见全群、可主动、有基座历史”的重路径；但群上下文仍只来自 @ 分板。官方做“稳定、合规、只 @”的轻路径。  
核心代码只认 transport 接口和能力标志，不认 QQ 的底层协议。这样以后加第三个平台，也不用再改 DSH 插件。


## 11. 实现状态（2026-11-11）

- [x] `QQTransport` 接口 + `OneBotTransport` 包装（现有 OneBot 测试全过）
- [x] 群聊 stateless：不建 DSH 群会话，24h 分板 + 一次 LLM 回复
- [x] `GroupBoard.sweep()` + 每小时定时清扫
- [x] 只读「QQ 群 24h 活动」面板：`/qq-groups` + `/api/qq-groups`
- [x] 官方 transport：access_token / WebSocket / @+私聊 normalize / 被动回复
- [x] 侧边栏「QQ 接入」切换向导：`/qq-switch` + `/api/qq-transport`，保存后重启生效
- [ ] 官方真机：AppID/Secret、群主加 bot、5 分钟窗口、msg_seq 去重
- [ ] 现有 OneBot 真机回归：群 @、私聊、owner 绑定、24h 清扫
