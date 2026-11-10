# QQ 桥接入（DSH 插件壳）

> 状态：owner 私聊已实测通过；群模式默认关闭。

## 0. 提供边界

我们只提供 **QQ 桥代码 + 接入说明**，不提供：

- NapCat / LLOneBot 安装包，不代下载、不代安装；
- QQ 账号 / 小号，不代登录、不代扫码；
- OneBot 11 WebSocket，不代开端口、不代填 token。

底座、账号、WS 由用户自己准备；用户自己的 AI 可以按官方文档协助，但必须由用户确认来源、自己扫码、自己承担账号和平台条款风险。

给用户 AI 的完整步骤：[QQ桥-FOR-AI.md](QQ桥-FOR-AI.md)。

## 结构

```text
QQ ↔ NapCat / LLOneBot（OneBot 11）
      ↕
qq-bridge/src/onebot.js        收发
      ↕
dsh-plugin/src/qq-plugin.js    插件壳
      ↕
DSH session（qq:owner / qq:group:<gid>:<uid>）
      ↕
DSH 记忆插件（owner 正常记录；群会话跳过）
```

- owner 私聊：`qq:owner`，用 `standard` preset，正常进 DSH 记忆。
- 群 @：`qq:group:<群号>:<QQ号>`，用 `minimal` preset；记忆插件对 `qq:group:` 会话跳过常识层注入和自动记录，群内容不进主 raw/链。
- 群友 24h 分板：只存该群友自己的 @ 会话（`qq/groups/<群>/members/<QQ>.jsonl`），不建群级公共上下文。
- 群模式默认 `groupEnabled: false`；先跑 owner，确认没问题再开群。

## 1. 底座

NapCat 或 LLOneBot 启动并登录 QQ，打开 **OneBot 11 正向 WebSocket**：

- 地址：`ws://127.0.0.1:3001`
- token：自己设一个

## 2. 配置

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`，追加：

```yaml
- insert:
    - id: hexing-qq
      name: 'D:/星绪/01-项目/AI-SF-14-开源记忆系统-MVP/dsh-plugin/src/qq-plugin.js'
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
- `guard.enabled: false` 是总开关；群限流默认 1 条/10 秒，私聊默认不卡，重复文本 3 秒内只发一次。

## 3. 验证

1. 重启 DSH；
2. 用 owner QQ 给机器人发私聊；
3. 看 DSH 日志：
   - `[hexing-qq] 机器人已登录`
   - `[hexing-qq] [dry-run] owner_private private ...`
4. 关掉 dry-run，再发一条；DSH 里应出现 `qq:owner` 会话，QQ 收到回复；
5. 群里 @ 机器人：`groupEnabled: false` 时应看到“群模式未开启；已忽略”。

## 4. 边界

- 不内置 NapCat / LLOneBot，不提供账号；
- 不做 QQ 协议逆向 / Hook；
- 群消息不写主记忆；群友 24h 分板已接，只存该群友自己的 @ 会话；
- 出站闸门已接：kill switch、去重、群限流、免打扰；PII/项目白名单过滤还没接。

## 5. 已知坑

- `format v4 message requires a producer-owned source kind`：DSH v4 不接受 `source.kind = 'plugin'` 的旧包装。当前代码用 `source.kind = 'hexing-qq'`。
- `no API key for provider route "deepseek-official"`：桌面启动器会注入 `QWENPLAN_API_KEY`；如果手动 `dsh web`，要自己带上同样的环境变量（或 `DEEPSEEK_API_KEY`），否则模型请求会失败。
- `session "qq:owner" already exists`：插件会优先复用已激活的 agent；如果会话已经卡死，先把 `~/.dsh/sessions/` 下对应的 `qq:owner` 会话目录移出去，再重启 DSH。
- 群模式默认关闭；`groupEnabled: true` 前先确认 `qq:group:` 会话没有写入主记忆。
