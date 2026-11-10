# 核星 QQ 桥（OneBot 11 收发骨架）

这是 QQ 桥的传输层：**只负责 OneBot 11 的收和发**。DSH 插件壳在 `dsh-plugin/src/qq-plugin.js`。

## 现在能做什么

- 连接 NapCat / LLOneBot 的正向 WebSocket
- 认三种消息：owner 私聊、群 @ 机器人、其他忽略
- dry-run 只打日志；配置 `replyText` 后才真的回一条
- 断线自动重连、心跳超时重连
- 兼容 OneBot 11 的数组消息和 CQ 码字符串
- 群友 24h 分板：只存该群友自己的 @ 会话，不建群级公共上下文
- 出站闸门：kill switch、去重、群限流、免打扰

## 还没做

- PII/项目白名单过滤
- DSH 回复的流式/分段
- 群友分板的加密（当前是本地文件 + 24h 清理）

## 配置

复制 `config.example.json` 为 `config.json`：

```json
{
  "onebot": {
    "url": "ws://127.0.0.1:3001",
    "token": ""
  },
  "ownerId": "你的QQ号",
  "dryRun": true,
  "replyText": ""
}
```

- `onebot.url`：NapCat / LLOneBot 的 OneBot 11 正向 WebSocket 地址
- `onebot.token`：如果底座设了 access token，填这里
- `ownerId`：只有这个 QQ 号的私聊会进 DSH
- `dryRun`：true 时只打日志；`replyText` 非空才真的回
- `replyText`：测试用固定回复；接 DSH 后删掉

## 底座怎么开

### NapCat

1. 启动 NapCat，登录 QQ；
2. 打开 NapCat WebUI → 网络配置 → 新建 **WebSocket 服务器**（正向 WS）；
3. 端口例如 `3001`，设一个 token；
4. 保存并启用。

### LLOneBot

1. 启动 LLOneBot；
2. 设置 → OneBot 11 → 开启 **正向 WebSocket**；
3. 端口例如 `3001`，设 token；
4. 保存。

两者都讲 OneBot 11，桥不用改。

## 运行

```sh
cd qq-bridge
node src/index.js
```

然后：

- 用 owner QQ 给机器人发私聊；
- 在群里 @ 机器人；
- 看控制台是否打出 `owner_private` / `group_mention`。

要真的回一条，把 `replyText` 设成 `"桥已收到"`，再发一次。

## 测试

```sh
node --test test/normalize.test.js test/router.test.js test/onebot.test.js
```

## 许可与参考

本目录是独立实现；参考过哪些项目的架构、没有复制哪些代码，见 [NOTICE.md](NOTICE.md)。

## 边界

- 不内置 NapCat / LLOneBot，不提供 QQ 账号；
- 不代下载、不代安装、不代登录、不代扫码；
- 不代开 OneBot WebSocket，端口/token 由用户自己配置；
- 不逆向 QQ 协议，不做 Hook；
- 群消息现在只打日志，不落盘、不进记忆；
- 底座由用户自己安装、自己承担账号风险。
