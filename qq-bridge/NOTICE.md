# 参考与许可说明

本目录（`qq-bridge/`）的代码是核星记忆项目的独立实现。

设计阶段参考了以下开源项目的**架构与行为**，用于理解 DSH 插件接入、OneBot 收发和发送护栏的常见做法：

- [dsh-im-qq](https://github.com/988hj7tczd-oss/dsh-im-qq)（MIT）— DSH session 映射、出站合并、被动回复预算
- [dsh-qqchat](https://github.com/Coffeiz/dsh-qqchat)（MIT）— 群/私聊会话隔离、成员记忆分层
- [dsh-qq-agent](https://github.com/CR1831/dsh-qq-agent)（MIT）— OneBot 适配、白名单/限流/免打扰护栏
- [dsh-starr](https://github.com/MoonLoordSaMa/dsh-starr)（MIT）— 群/私聊隔离与主动行动权限
- [NapCatQQ](https://github.com/NapNeko/NapCatQQ)、[LLOneBot](https://github.com/LLOneBot/LLOneBot) — OneBot 11 底座

参考范围仅限于：

- DSH 插件与 agent 的公开接口调用方式；
- OneBot 11 协议；
- 会话映射、出站合并、发送护栏等通用设计思路。

**未复制上述项目的代码、注释或文件结构。** 本目录代码按本项目需求独立编写。

如果后续确需复用某段代码，会在此列出项目、文件、版权声明和 MIT 许可文本，并保留原作者的版权信息。
