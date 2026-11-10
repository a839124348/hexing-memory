# QQ 桥接入 · 给用户 AI 的 runbook

> 这份是写给**用户自己的 DSH AI**看的，不是给用户手操的。  
> 项目只提供 QQ 桥代码和说明书；NapCat/LLOneBot、QQ 账号、OneBot WebSocket 都由用户自己准备。

## 0. 先确认

开始前必须让用户明确知道并同意：

- 需要**一个小号**，不要用主号；
- 需要安装第三方 QQ 客户端（NapCat / LLOneBot），有封号风险；
- 需要用户自己扫码登录，AI 不代扫、不代过验证；
- 群聊默认关闭，先只跑 owner 私聊。

用户不同意其中任何一条，就停在这里，不要继续。

## 0.5 必须先问：QQ 私聊接到哪里（二选一）

在写配置前，**必须先警告用户，并让用户明确选一个**；不能替用户默认选“绑定主会话”。

| 方案 | 做法 | 适合 | 代价 |
|:--|:--|:--|:--|
| A. 专用会话（默认） | `ownerSessionId` 留空 | 大多数用户；QQ 和电脑上的会话互不干扰 | QQ 回复接不上主会话上下文 |
| B. 绑定已有会话 | 让模型调用 `qq_bind_session`（用户只说会话名字） | 只有一个常用会话、想让 QQ 和它无缝衔接 | QQ 与主会话共享上下文；同一会话里 UI/QQ 并发会排队；QQ 消息带 `[QQ私聊]` 前缀 |

必须告诉用户 B 方案的边界：

- 只有 **owner 私聊**能绑定；群会话永远独立，不绑定、不共享；
- 只把“由 QQ 消息触发的那一轮”回复发回 QQ；用户在 UI 里说的话和回复不会进 QQ；
- 绑定会话里能用到主会话上下文，所以**不要绑代码会话/带敏感工具或敏感内容的会话**；
- 绑定会话被删除/无法恢复时，桥会回退到专用 `qq:owner` 并写警告日志；
- **换绑不迁移旧会话历史**：换到新会话后，新会话不会自动知道旧 `qq:owner`/旧绑定会话的内容；旧会话仍在，解绑或切回就恢复。旧 QQ 聊天若已进主记忆，只能靠 `memory_search` 找回，不会自动进当前上下文；
- 要用户自己选，不要替用户决定。

选 A 时也要确认没有历史 `%APPDATA%\dsh-memory\qq\binding.json`；有就让模型先 `qq_bind_session({action:'unbind'})`，否则工具绑定会盖过配置。

### 0.5.1 方案 B 的绑定流程（模型自己操作）

前提：插件已经按方案 A 配好并加载（`ownerSessionId` 留空），DSH 里能看到 `qq_bind_session` 工具。绑定本身不需要再改 YAML，也不需要重启。

不要要求用户找 session id、不要要求用户手改 YAML。用户只需要说会话名字：

1. 问用户：“你想把 QQ 私聊接到哪个会话？说会话名字就行；也可以直接说‘就这个会话’。”
2. 用户说“就这个/当前会话” → 调用 `qq_bind_session({ action: 'current' })`；
3. 用户说了名字 → 调用 `qq_bind_session({ action: 'title', title: '用户说的名字' })`；
4. 工具返回多个候选 → 把标题和最近活动时间念给用户，让他选，再用返回的 `id` 调用 `qq_bind_session({ action: 'current', sessionId: '...' })`（或 `action:'title'` 加更精确的标题）；
5. 工具返回“没找到” → 让用户确认名字；仍找不到就调用 `node tools/list-sessions.js` 列出标题给用户看，但命令由你来跑，不要让用户跑；
6. 用户要取消绑定 → 调用 `qq_bind_session({ action: 'unbind' })`。

绑定工具写的是 `%APPDATA%\dsh-memory\qq\binding.json`，**热生效，不用重启 DSH**；不要为了绑定去重启 DSH。工具绑定优先于配置里的 `ownerSessionId`；清掉工具绑定后，配置值仍会生效。

## 1. 你不可以做的事

- 不提供、不打包、不代下载 NapCat / LLOneBot 安装包；
- 不向用户索要 QQ 密码、验证码、扫码授权；
- 不替用户创建 QQ 号，不绕过验证/风控；
- 不把 OneBot 端口开到 `0.0.0.0` 或公网；
- 不把底座、账号、token 写进仓库或 Release；
- 不承诺“不会封号”。

## 2. 检查底座

先看用户机器上有没有：

- NapCat / LLOneBot 已经在运行；
- `127.0.0.1:3001` 已经在监听（OneBot 11 正向 WS）；
- `127.0.0.1:6099` 是否能打开 NapCat WebUI。

如果都已经有了，直接跳到第 4 步配置 DSH。

## 3. 让用户自己装底座

如果没有，给用户官方入口，让用户自己下载/解压/启动：

- NapCat：`https://github.com/NapNeko/NapCatQQ/releases`
- LLOneBot：`https://github.com/LLOneBot/LLOneBot/releases`

只给官方 GitHub 链接；不要让用户从网盘、群文件、第三方站点下载。

启动后：

1. 让用户用小号扫码（NapCat 控制台/`napcat/cache/qrcode.png`）；
2. 打开 WebUI（默认 `http://127.0.0.1:6099/webui`，token 在 `napcat/config/webui.json`）；
3. 网络配置 → 新建 **WebSocket 服务器**：
   - 地址 `127.0.0.1`
   - 端口 `3001`
   - token 自己设一个
4. 确认 `127.0.0.1:3001` 已监听。

## 4. 配置 DSH

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`，追加：

```yaml
- insert:
    - id: hexing-qq
      name: '<仓库绝对路径>/dsh-plugin/src/qq-plugin.js'
      config:
        onebot:
          url: 'ws://127.0.0.1:3001'
          token: '<用户自己设的 token>'
        ownerId: '<用户主号 QQ>'
        ownerName: '<用户称呼，可空>'
        ownerGroupName: '<用户在群里的昵称，可空>'
        aiName: '<机器人公开名字，可空>'
        privateTitle: '大号私聊会话'
        provider: '<当前 DSH 的 provider>'
        model: '<当前 DSH 的 model>'
        agentPreset: 'standard'
        groupPreset: 'minimal'
        groupEnabled: false
        cwd: '~/.dsh/qq-workspace'
        # 方案 A：留空，用专用会话 qq:owner
        # 方案 B：优先让模型调用 qq_bind_session（写 binding.json，热生效）；
        # 只有工具不可用时，才手填已有会话 id
        ownerSessionId: ''
        dryRun: false
```

- `ownerId` 是**用户主号**，不是机器人小号；
- `provider/model` 用 DSH 当前模型；不确定就留空，让 DSH 用默认；
- 不确定就先把 `dryRun: true`，只打日志。

## 5. 重启与验证

1. 用用户平时的 DSH 启动方式重启（桌面启动器会注入模型凭据）；
2. 看日志：
   - `[hexing-qq] 机器人已登录`
   - `owner_private`
   - `turn/start` / `assistant/message`
3. 用主号给小号发一条私聊，确认 QQ 收到回复；
   - 方案 A：DSH 出现 `qq:owner`，标题「大号私聊会话」；
   - 方案 B：消息出现在绑定会话里，开头是 `[QQ私聊]`；在 UI 里说一句，QQ 不应收到那一轮回复；
4. 成功后再考虑 `groupEnabled: true`，并且先小群测试。

## 6. 日常维护

接入成功后，用户 AI 还要会这些：

- **启动顺序**：先起 NapCat/LLOneBot 并登录小号，再起 DSH；先起 DSH 也行，插件会重连。就绪标志是日志 `机器人已登录`。
- **模式切换**：A→B 让模型调用 `qq_bind_session`（按标题/当前会话），不用重启；B→A 调用 `qq_bind_session({action:'unbind'})`，绑定会话历史不动。只有手改 `ownerSessionId` 才需要重启。
- **群维护**：群板 24h 自动清；关群改 `groupEnabled: false` 并重启；想提前清群板，停 DSH 后删 `%APPDATA%\dsh-memory\qq\groups\<群号>\`。
- **备份**：`cordis.patch.yml`、`%APPDATA%\dsh-memory`、`~/.dsh/sessions`。不要把记忆库、session、token 上传仓库/Release。
- **更新**：拉新 tag 后重启 DSH；Node >= 24.9、DSH 0.2.2；升级后跑验收测试再上线。
- **停止发送**：`guard.enabled: false` 是 kill switch，不是只关限流；排查完再打开。
- **安全**：OneBot 只绑 `127.0.0.1`，token 定期换，用小号，不开公网。

## 7. 常见错误

| 错误 | 处理 |
|:--|:--|
| `format v4 message requires a producer-owned source kind` | 不要用 `source.kind='plugin'`；当前桥用 `source.kind='hexing-qq'` |
| `no API key for provider route` | 不要用裸 `dsh web`；用桌面启动器，或带上 `DEEPSEEK_API_KEY`/`QWENPLAN_API_KEY` |
| `session "qq:owner" already exists` | 复用已激活 agent；卡死就把对应 session 目录移出 `~/.dsh/sessions/` 再重启 |
| `绑定会话 ... 不存在或无法恢复` | `binding.json` 里的 id 写错/会话已删除；用 `qq_bind_session` 重新绑，或 `qq_bind_session({action:'unbind'})` 回退专用会话 |
| 二维码扫不出 | 用 `napcat/cache/qrcode.png`，不要扫控制台字符画 |
| 提示不能重复登录 | 同一 QQ 号不能在两个 PC 端同时登录；换小号，或退出主号 PC 端 |

## 8. 停止条件

出现以下情况，停止接入：

- 用户不愿用小号；
- 用户不愿安装第三方客户端；
- 用户要求 AI 代登录/代扫码/代过验证；
- 用户要把端口开到公网；
- 用户要在群里自动召回私聊记忆。

停在这里，告诉用户风险，不要“想办法绕过”。
