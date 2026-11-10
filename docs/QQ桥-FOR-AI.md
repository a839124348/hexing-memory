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
        provider: '<当前 DSH 的 provider>'
        model: '<当前 DSH 的 model>'
        agentPreset: 'standard'
        groupPreset: 'minimal'
        groupEnabled: false
        cwd: '~/.dsh/qq-workspace'
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
4. 成功后再考虑 `groupEnabled: true`，并且先小群测试。

## 6. 常见错误

| 错误 | 处理 |
|:--|:--|
| `format v4 message requires a producer-owned source kind` | 不要用 `source.kind='plugin'`；当前桥用 `source.kind='hexing-qq'` |
| `no API key for provider route` | 不要用裸 `dsh web`；用桌面启动器，或带上 `DEEPSEEK_API_KEY`/`QWENPLAN_API_KEY` |
| `session "qq:owner" already exists` | 复用已激活 agent；卡死就把对应 session 目录移出 `~/.dsh/sessions/` 再重启 |
| 二维码扫不出 | 用 `napcat/cache/qrcode.png`，不要扫控制台字符画 |
| 提示不能重复登录 | 同一 QQ 号不能在两个 PC 端同时登录；换小号，或退出主号 PC 端 |

## 7. 停止条件

出现以下情况，停止接入：

- 用户不愿用小号；
- 用户不愿安装第三方客户端；
- 用户要求 AI 代登录/代扫码/代过验证；
- 用户要把端口开到公网；
- 用户要在群里自动召回私聊记忆。

停在这里，告诉用户风险，不要“想办法绕过”。
