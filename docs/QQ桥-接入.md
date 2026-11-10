# QQ 桥接入（DSH 插件壳）

> 状态：owner 私聊已实测；群聊与绑定模式按验收单做最终真实验收；群模式默认关闭。

## 0. 提供边界

我们提供 **QQ 桥代码 + 接入说明**；下面这些需要你自行准备：

- NapCat / LLOneBot 安装包（含下载、安装）；
- QQ 账号 / 小号（含登录、扫码）；
- OneBot 11 WebSocket（端口、token、绑定地址）。

底座、账号、WS 由你准备；你自己的 AI 可以按官方文档协助，但需要你确认来源、自己扫码，并自行承担账号和平台条款风险。

给用户 AI 的完整步骤：[QQ桥-FOR-AI.md](QQ桥-FOR-AI.md)。

## 结构

```text
QQ ↔ NapCat / LLOneBot（OneBot 11）
      ↕
qq-bridge/src/onebot.js        收发
      ↕
dsh-plugin/src/qq-plugin.js    插件壳
      ↕
DSH session（qq:owner / qq:group:<gid> / 绑定的已有会话）
      ↕
DSH 记忆插件（owner 正常记录；群会话跳过）
```

- owner 私聊：默认 `qq:owner`，用 `standard` preset，正常进 DSH 记忆；绑定模式沿用被绑会话自己的 preset/模型。
- 群 @：`qq:group:<群号>`，一个群一个 DSH 会话；群友上下文用 24h 分板区分，不按群友建会话；回复自动 @ 提问者，模型不用自己写 @；记忆插件对 `qq:group:` 会话跳过常识层注入和自动记录，群内容不进主 raw/链。
- 群友 24h 分板：只存该群友自己的 @ 会话（`qq/groups/<群>/members/<QQ>.jsonl`），不建群级公共上下文。
- DSH 会话标题：专用私聊为「大号私聊会话」；群聊用群名（`get_group_info`，拿不到就用 `QQ群 <群号>`）；绑定会话保留用户自己的标题，不会显示「未命名」。
- 群模式默认 `groupEnabled: false`；先跑 owner，确认没问题再开群。

## 1. 底座

NapCat 或 LLOneBot 启动并登录 QQ，打开 **OneBot 11 正向 WebSocket**：

- 地址：`ws://127.0.0.1:3001`
- token：自己设一个

## 2. 配置

### 2.0 先二选一：QQ 私聊接哪里

接入 owner 私聊前，必须选一个模式：

- **A. 专用会话（默认，推荐）**：`ownerSessionId` 留空，并确认没有 `%APPDATA%\dsh-memory\qq\binding.json`（有就让 AI 取消绑定）。QQ 私聊单独一个 `qq:owner` 会话，不碰你在 DSH 里的主会话。干净、隔离，但 QQ 接不上主会话上下文。
- **B. 绑定已有会话**：让 DSH 里的 AI 直接说“把 QQ 私聊接到这个会话 / 接到‘某某’会话 / 取消 QQ 绑定”。模型会调用 `qq_bind_session`，按会话标题或当前会话自动绑定，写 `%APPDATA%\dsh-memory\qq\binding.json`，**热生效，不用重启**。QQ 消息进入那个会话（带 `[QQ私聊]` 前缀），回复能用到主会话上下文；只有 QQ 触发的那一轮回复会发回 QQ，你在 UI 里说的话不会进 QQ。

选 B 的边界：

- 绑定只作用于 owner 私聊；**群会话保持独立，不参与绑定**；
- 更建议绑日常聊天会话；代码会话或带敏感工具/敏感内容的会话不太适合；
- 同一会话里 UI 和 QQ 同时说话会排队，QQ 回复可能等当前轮结束；
- 绑定会话被删除/无法恢复时，桥会回退到专用 `qq:owner`，并在日志里提醒；
- **换绑只切换后续 QQ 消息的去向，不迁移旧会话历史**：新会话不会自动知道旧 `qq:owner` 或旧绑定会话里聊过什么；旧会话仍保留，解绑/切回就恢复旧上下文。旧 QQ 聊天若已进主记忆，只能靠 `memory_search` 检索，不会自动塞进当前上下文。

模型绑定优先于配置里的 `ownerSessionId`。第一次接入建议先按 A 配好、重启加载插件，再对 AI 说“把 QQ 私聊接到这个会话/接到‘某某’会话”，由模型热绑定；只有模型工具不可用时，才需要手动查 id 并填配置：

```powershell
node tools/list-sessions.js
```

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`，追加：

```yaml
- insert:
    - id: hexing-qq
      name: '<仓库绝对路径>/dsh-plugin/src/qq-plugin.js'
      config:
        onebot:
          url: 'ws://127.0.0.1:3001'
          token: '你的 token'
        ownerId: '你的 QQ 号'
        provider: 'deepseek-official'
        model: 'deepseek-v4-flash'
        agentPreset: 'standard'
        groupPreset: 'minimal'
        groupEnabled: false
        cwd: '~/.dsh/qq-workspace'
        # A：留空；B 一般也留空，由模型 qq_bind_session 绑定；
        # 只有工具不可用时才手填已有会话 id（例如 'dsh:xxxx'）
        ownerSessionId: ''
        dryRun: true
        guard:
          enabled: true
          groupMinMs: 10000
          privateMinMs: 0
          dedupeMs: 3000
          quietHours: []
```

- `dryRun: true`：只打日志，不投 DSH、不发 QQ。
- 确认日志出现 `owner_private` 后，改成 `false` 再重启 DSH。
- `groupEnabled` 先保持 `false`；群模式等 owner 跑通再开。
- `guard.enabled: false` 是**停止发送的 kill switch**（不是只关限流）；群限流默认 1 条/10 秒，私聊默认不卡，重复文本 3 秒内只发一次。

### 2.1 可选字段

| 字段 | 默认 | 作用 |
|:--|:--|:--|
| `ownerName` | 空 | 私聊/群提示里 owner 的称呼，例如「明明」 |
| `ownerGroupName` | 空 | owner 在群里的昵称；owner 在群里说话时会自动更新 |
| `aiName` | 空 | 机器人在群里的公开名字，例如「星绪」；用于“我是谁”自我介绍 |
| `privateTitle` | `大号私聊会话` | 专用 `qq:owner` 会话的标题 |
| `memoryRoot` | `%APPDATA%\dsh-memory` | 记忆根目录；公开项目白名单从这里读 |
| `qqRoot` | `<memoryRoot>\qq` | 群友 24h 分板目录 |
| `groupPrefix` | 空 | 覆盖默认群提示词；一般不用填 |

## 3. 验证

1. 重启 DSH；
2. 用 owner QQ 给机器人发私聊；
3. 看 DSH 日志：
   - `[hexing-qq] 机器人已登录`
   - `[hexing-qq] [dry-run] owner_private private ...`
4. 关掉 dry-run，再发一条：
   - 方案 A：DSH 里应出现 `qq:owner` 会话（标题「大号私聊会话」），QQ 收到回复；
   - 方案 B：QQ 消息出现在你绑定的会话里，带 `[QQ私聊]` 前缀，QQ 收到回复；在 UI 里说一句，QQ 不应收到这一轮的回复。
5. 群里 @ 机器人：`groupEnabled: false` 时应看到“群模式未开启；已忽略”。

## 4. 边界

- 不内置 NapCat / LLOneBot，不提供账号；
- 不做 QQ 协议逆向 / Hook；
- 群消息不写主记忆；群友 24h 分板已接，只存该群友自己的 @ 会话；群会话永远不绑定主会话；
- 出站闸门已接：kill switch、去重、群限流、免打扰；项目公开白名单已接（见 4.5）；PII 内容过滤还没接。

## 4.5 公开项目白名单

群聊只允许介绍 owner 显式标 `public: true` 的项目；默认空 = 什么项目都不介绍。

文件：`%APPDATA%\dsh-memory\common\public-projects.json`

```json
{
  "projects": [
    {
      "name": "项目名",
      "public": true,
      "summary": "一句话公开介绍",
      "links": ["https://..."]
    }
  ]
}
```

- 只有 `public: true` 的条目会进群上下文；
- 只读 `name/summary/links`，不读链、不读私聊记忆；
- 没标 public、文件不存在、JSON 坏了 → 群聊说“没有公开项目”，不猜。

## 5. 日常维护

### 5.1 启动顺序

1. 先启动 NapCat / LLOneBot，用小号登录，确认 `127.0.0.1:3001` 在监听；
2. 再启动 DSH；插件会自动连接 OneBot，断线会退避重连；
3. 看日志出现 `[hexing-qq] 机器人已登录` 才算就绪。

先起 DSH、后起底座也可以：插件会一直重连，底座起来后自动连上。

### 5.2 健康检查

- `127.0.0.1:3001` 有监听；
- 日志有 `机器人已登录`；
- owner 私聊发一句能回；
- 群模式：群里 @ 一次能回，且只有一个 `qq:group:<群号>` 会话。

不健康时按顺序查：OneBot 是否掉线 → token 是否一致 → 绑定会话是否存在 → 会话是否卡死。

### 5.3 切换 A / B 模式

- **A → B**：直接对 DSH 里的 AI 说“把 QQ 私聊接到这个会话”或“接到‘某某’会话”。模型调用 `qq_bind_session`，写 `binding.json`，热生效，不用重启。
- **B → A**：对 AI 说“取消 QQ 绑定”，模型调用 `qq_bind_session({ action: 'unbind' })`；绑定会话原样保留，历史不丢。
- 绑定会话被删除/无法恢复：桥回退到 `qq:owner`，日志会写 `绑定会话 ... 不存在或无法恢复`。
- 手动兜底：`node tools/list-sessions.js` 查 id，填 `ownerSessionId` 后重启；工具绑定优先于配置。
- 不再用的 `qq:owner` 会话：停 DSH 后把 `~/.dsh/sessions/` 下对应目录移到备份处，不要直接删。

### 5.4 群维护

- 群友分板 24h 自动清；想提前清：停 DSH 后删 `%APPDATA%\dsh-memory\qq\groups\<群号>\`。
- 关群：`groupEnabled: false` 后重启；已有群会话和群板不会自动删，按上面手动清。
- 一个群一个会话；退群/换群后，旧会话可备份移走。

### 5.5 数据与备份

要备份的三样：

1. `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`（配置）；
2. `%APPDATA%\dsh-memory`（主记忆 + QQ 群板 + 公开项目白名单）；
3. `~/.dsh/sessions`（DSH 会话历史）。

QQ 桥没有删除工具；要删只能停 DSH 后处理文件或整库删除。不要把记忆库、session、token 上传到仓库或 Release。

### 5.6 更新

- 拉新 tag 后重启 DSH；Cordis 插件不热更，改代码必须重启。
- 运行环境：Node >= 24.9，DSH 0.2.2；换 DSH 版本后先跑 `node test/acceptance.js` 和 `node --test dsh-plugin/test/qq.test.js`。
- 升级后看日志版本号和 `机器人已登录`，再发一条私聊确认。

### 5.7 安全

- OneBot 只绑 `127.0.0.1`，不要开到 `0.0.0.0`/公网；token 定期换，换完同步改 profile。
- 用小号，不用主号；群里不自动召回私聊。
- 出问题先设 `guard.enabled: false`（停止发送的 kill switch），再排查；恢复后再打开。

## 6. 已知坑

- `format v4 message requires a producer-owned source kind`：DSH v4 不接受 `source.kind = 'plugin'` 的旧包装。当前代码用 `source.kind = 'hexing-qq'`。
- `no API key for provider route "deepseek-official"`：桌面启动器会注入 `QWENPLAN_API_KEY`；如果手动 `dsh web`，要自己带上同样的环境变量（或 `DEEPSEEK_API_KEY`），否则模型请求会失败。
- `session "qq:owner" already exists`：插件会优先复用已激活的 agent；如果会话已经卡死，先把 `~/.dsh/sessions/` 下对应的 `qq:owner` 会话目录移出去，再重启 DSH。
- 群模式默认关闭；`groupEnabled: true` 前先确认 `qq:group:` 会话没有写入主记忆。
