# QQ 官方机器人 · 接入评估

> 结论：官方机器人适合「稳定的群 @ / 私聊被动回复」，不是第三方基座的完全替代。  
> 全量群消息要群主开启；主动消息不可靠；历史消息拿不到。  
> 实现状态：群聊最终走 stateless，不建 DSH 群会话；两种 transport 都只处理 @。评估期表格与最终实现冲突时，以 `QQ双Transport-设计.md` 为准。  
> 日期：2026-11-11

## 1. 一句话结论

官方机器人能做：

- 群里被 @ 时回复；
- 用户私聊机器人时回复；
- 文本 / markdown / 按钮 / 富媒体（受接口限制）；
- 稳定、合规、低封号风险。

官方机器人不能做 / 受限：

- **全量群消息**：除非群主在 QQ 群设置里开启「获取群内全部消息」；
- **主动推送**：2025-04-21 官方下线，后续只有受限恢复，不能当“想找你就找你”的陪伴型助手；
- **历史消息**：官方 API 只给实时事件，没有历史拉取；
- **像小号一样的行为**：它是机器人身份，不是用户账号。

对现有 `qq-plugin`：**不能直接复用 OneBot 传输**，需要新增 `qq-official` 适配层；会话映射、owner 绑定、回合来源过滤、guard 可以复用。

---

## 2. 官方 API 关键事实

### 2.1 事件

| 事件 | 触发 | 用途 |
|:--|:--|:--|
| `GROUP_AT_MESSAGE_CREATE` | 群里 @ 机器人 | 群 @ 问答 |
| `GROUP_MESSAGE_CREATE` | 群内普通消息，需群主开启「获取群内全部消息」 | 全量群聊 |
| `C2C_MESSAGE_CREATE` | 用户私聊机器人 | owner 私聊 |
| `GROUP_ADD_ROBOT` | 机器人被加入群 | 入群事件 |
| `GROUP_MSG_RECEIVE` / `GROUP_MSG_REJECT` | 群消息接收开关变化 | 主动消息相关 |

- Intent：`GROUP_AND_C2C_EVENT`（`1 << 25`）；
- 群/用户标识是 **openid**：`group_openid`、`member_openid`、`user_openid`，不是 QQ 号；
- 消息字段：`id`、`content`、`author`、`timestamp`、`attachments`、`mentions`；
- `content` 里的 @ 会变成 `<@member_openid>`，@全体是 `<@all>`。

### 2.2 发送

| 场景 | 接口 |
|:--|:--|
| 群聊 | `POST /v2/groups/{group_openid}/messages` |
| 单聊 | `POST /v2/users/{openid}/messages` |

关键参数：

- `content` / `msg_type`；
- `msg_id`：被动回复的消息 ID，来自事件 `d.id`；
- `event_id`：被动回复的事件 ID，和 `msg_id` 二选一；
- `msg_seq`：回复序号，和 `msg_id` 联合去重；相同 `msg_id + msg_seq` 重复发送会失败；
- `markdown` / `media`：富媒体另走上传接口。

### 2.3 被动消息

| 场景 | 有效期 | 每条消息最多回复 |
|:--|:--|:--|
| 群聊 | 5 分钟 | 5 次 |
| 单聊 | 60 分钟 | 4–5 次（文档口径有出入） |

- 被动消息**不占主动消息配额**；
- 但有窗口、每条消息回复次数、QPS；
- 正常「你一句、它一句」十几轮没问题，因为每句都是新的 `msg_id`；
- 会撞墙的是「一条用户消息连发 5 条以上」和「超过窗口才回」。

### 2.4 主动消息

- 2025-04-21 官方下线「主动推送」，调用会报错；
- 后续有受限恢复：群主动推送默认关闭、需群主开启；私聊有互动召回/配额；
- 用户可以在 QQ 客户端关闭「允许主动发送」，关闭后主动消息一律失败；
- **不要把它当稳定能力**。定时提醒、主动关心、睡前问候，都不能只靠官方机器人。

### 2.5 全量群消息

这是官方和第三方最大的分水岭：

- 需要**群主**在 QQ 群设置 → 机器人设置里，把「机器人可获取的群聊消息范围」改成「获取群内全部消息」；
- 需要在开放平台回调/Intent 里勾选 `GROUP_MESSAGE_CREATE`；
- 只有群主能添加机器人、改这个开关；
- 如果你不是群主，官方机器人只能收到 @ 它的消息，群友 24h 分板会残缺。

### 2.6 其他限制

- 没有历史消息拉取，只有实时事件；机器人重启期间的消息拿不到；
- 机器人有「机器人」标识，不能伪装成用户；
- 富媒体/文件受接口限制，文本最稳；
- 需要注册、认证/沙箱、群主添加；部分能力要审核；
- QPS 按认证类型不同，以当前开放平台后台为准。

---

## 3. 与现有 qq-plugin 的映射

| 现有能力 | OneBot | 官方机器人 | 复用 / 改造 |
|:--|:--|:--|:--|
| 群消息 | `message.group` | `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` | 新增 adapter |
| 私聊 | `message.private` | `C2C_MESSAGE_CREATE` | 新增 adapter |
| 群会话 key | `qq:group:<gid>` | `qq:group:<group_openid>` | 改 id 来源 |
| owner 会话 key | `qq:owner` | `qq:owner`（C2C openid） | 复用 |
| owner 绑定 | `qq_bind_session` | 同一套 binding | 复用 |
| 群 24h 分板 | 桥只处理 @（传输层可能看到全群） | 只有 @ | 两边分板都只含 @ 消息 |
| 回合来源过滤 | `source.kind='hexing-qq'` | 同一套 `source.kind` + `transport` 元数据 | 复用逻辑 |
| 自动 @ 提问者 | OneBot at 段 | Markdown `<qqbot-at-user id="..." />` + `msg_type:2` | 官方发送 @ 不能用 `<@openid>` |
| 限流排队 | 自建 | 官方 QPS + 每条 5 次 | 更严格 |
| 主动消息 | 自由 | 下线/受限 | 不能做定时主动 |
| 历史 | 基座有 | 无 | 记忆只能从事件来 |

---

## 4. 三种方案

### A. 官方 only

适合：

- 群助手、命令、通知、@ 问答；
- 群主愿意开「获取群内全部消息」；
- 不需要机器人主动找人。

不适合：

- 需要主动关心/定时提醒；
- 需要历史回填；
- 不是群主的群。

### B. 二选一 transport（选定）

不是同时跑两套，而是 `qq-bridge` 只暴露一个 **Transport 接口**：

- `onebot` 和 `official` 是两个实现；
- 配置里 `transport: "onebot" | "official"` 二选一；
- DSH 侧只消费归一化事件/回复，不关心底层；
- 能力差异用 `capabilities` 标志：`groupScope`、`canProactive`、`canHistory`。

### C. 现状 OneBot only

- 传输层可能看到全群，但桥只处理 @；主动自由；
- 有账号/协议/封号风险；
- 需要自己维护基座稳定性。

**选定 B，不做混合。** 官方和 OneBot 是同一层的两个实现，不是两个身份同时在线。  
如果目标是「稳定群助手」，选官方；如果目标是「能听全场、会主动找人的陪伴型助手」，选 OneBot。切换 transport 时，会话 key 和记忆边界要重新确认。

---

## 5. 如果要接：MVP 范围

新增 `qq-official` adapter，和 OneBot 桥并存：

1. AppID/AppSecret 换 access_token；
2. WebSocket 连接（或 webhook）+ 心跳/resume；
3. 归一化 `C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`；全量模式再加 `GROUP_MESSAGE_CREATE`；
4. 复用 `QQSessionMap`、guard、owner 绑定、回合来源过滤；
5. 一轮只发一条最终回复，带 `msg_id`、`msg_seq=1`，必须在窗口内；
6. v1 只做文本；markdown/媒体后置；
7. 不做主动消息；定时提醒走本地通知或 OneBot；
8. 配置：`official: { enabled, appId, secret, intents, fullGroup }`。

测试重点：

- 事件归一化；
- 被动回复窗口/`msg_seq`；
- 全量群开关关闭时只收 @；
- owner 绑定复用；
- UI 轮次不外发；
- 5 次回复预算：一轮多气泡要合并成一条。

---

## 6. 需要你确认的事

1. **你是不是目标群的群主？** 不是群主，官方机器人加不进去，也开不了全量消息。
2. **要不要主动消息/定时提醒？** 要的话，官方机器人不能作为唯一通道。
3. **要不要历史回填？** 官方没有历史 API，只能从接入那一刻开始记。
4. **认证类型？** 个人/企业认证影响 QPS 和可用能力。
5. **群消息量多大？** 一条用户消息 5 次回复够不够，取决于是否要“打字状态 + 正文 + 追问”多气泡。

---

## 7. 选定方案：二选一 transport（2026-11-11）

确认结果：

- 不是群主，但可以让群主把官方机器人加进群；
- 不需要「获取群内全部消息」，只要 @ 机器人的人能得到回复；
- 官方和 OneBot 是**二选一**，不是同时跑两套。

因此 v1 范围锁定：

- **群**：只订阅 `GROUP_AT_MESSAGE_CREATE`；不订阅 `GROUP_MESSAGE_CREATE`；不要求群主开全量。
- **私聊**：`C2C_MESSAGE_CREATE`；owner 绑定复用。
- **群会话 key**：`qq:group:<group_openid>`；一个群一个 DSH 会话。
- **群 24h 分板**：只记录 @ 机器人的消息，不是全群消息；文档和 UI 不要宣称“全群上下文”。
- **回复**：一轮一条，带 `msg_id`、`msg_seq=1`；群 5 分钟内，私聊 60 分钟内；需要 @ 提问者时在 `content` 里拼 `<@member_openid>`。
- **主动消息**：v1 不做；定时提醒走本地/OneBot。
- **历史**：只从接入时刻开始；群历史不回填。

### 接口层

- `qq-bridge/src/transport.js` 定义 `QQTransport`：
  - `connect()` / `close()`
  - `on('message' | 'ready' | 'error' | 'close', handler)`
  - `reply(target, text, opts)`
  - `capabilities()`
- `onebot` 和 `official` 各一个实现；配置 `transport: "onebot" | "official"` 二选一。
- 归一化消息：
  ```js
  {
    transport: 'onebot' | 'official',
    kind: 'group' | 'private',
    chatKey: 'qq:group:<id>' | 'qq:owner',
    senderId, senderName,
    text, msgId, timestamp,
    mentionedBot: boolean,
    raw
  }
  ```
- DSH 侧只消费归一化消息/回复；`QQSessionMap`、guard、owner binding、source filtering 复用。

### 能力标志

| 能力 | OneBot | 官方（v1） |
|:--|:--|:--|
| `groupScope` | `mention-only`（传输层可能全量，桥只处理 @） | `mention-only` |
| `canProactive` | `true` | `false` |
| `canHistory` | `true`（基座本地有） | `false` |
| `maxReplyLength` | 取决于基座 | 官方文本上限 |
| `replyMode` | at/reply 段 | `msg_id` + `msg_seq`，Markdown @ |

两种模式都不假设全群上下文：群上下文只来自 @ 分板。官方不主动、不回填；OneBot 可主动、有基座历史。UI/文档显示当前 transport 和 `groupScope`。

- **需要你提供**：AppID/AppSecret（放本地 env，不进仓库）、机器人被群主加进测试群、开放平台沙箱/正式环境。
- **验收**：群 @ 回复、私聊回复、owner 绑定、UI 轮次不外发、5 分钟窗口、`msg_seq` 去重、群 board 只含 @ 消息、切换 transport 后会话 key 不串。

## 8. 参考

- QQ 机器人官方文档（消息收发概述）：  
  https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
- 腾讯官方 bot-docs（send.md，主动/被动消息）：  
  https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md
- QQ 机器人官方文档入口：  
  https://bot.q.qq.com/wiki/develop/api-v2/

> 文档口径会变：单聊被动 4/5 次、主动消息下线后又部分恢复，接入前以当前开放平台后台和实际返回为准。
