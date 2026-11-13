# 核星记忆 · 老用户修复包（v0.4.3）

> 给**用户自己的 DSH AI**看。只做分类修复，不做全面转写。

## 这次修什么

v0.4.3 修了“链节点 `t` 用 UTC”的新写入问题：

- 新节点：本地时间 + `tSource`（`local` / `explicit` / `llm` / `fallback`）；
- 旧节点：没有 `tSource`，可能是对的，也可能是 UTC；**不能全转**。

## 先诊断（只读）

```sh
node repair/tools/check-chain-time.js
```

它会列出：

- 链文件数 / 节点总数 / 没有 `tSource` 的旧节点；
- 每个旧节点的链名、时间、who、文本、source。

先看这些时间是否整体比本地慢/快一个时区。**不要直接批量加 8 小时**：refine 节点本来就来自本地 raw；只有 `memory_chain append` 没传 `t` 的节点才走 UTC。

## 再造映射（会话取证 / 人工）

先跑会话取证：

```sh
node repair/tools/suggest-chain-time.js --out map.json
```

它只读扫描 `~/.dsh/sessions`，找 `memory_chain append` 工具调用里**没有传 `t`** 的节点，用工具调用事件的 `time` 转成本地时间，生成 `map.json`。匹配不到就输出 0 条，不会猜。

如果会话取证匹配不到，再人工确认后写 map：

```json
[
  { "chain": "身份链", "text": "原节点文本", "t": "2026-11-07 10:00" }
]
```

证据优先级：

1. DSH 会话里 `memory_chain append` 工具调用的 `time`（epoch ms）；
2. raw 里同一条原文的本地 `t`；
3. 明确知道时区偏移、且节点来源是 `append` 的，才按时区换算；
4. 不确定 → 不动。

## 预演 / 写入

```sh
# 默认 dry-run，只打印
node repair/tools/fix-chain-time.js --map map.json

# 确认后写入；会先整目录备份 links
node repair/tools/fix-chain-time.js --map map.json --apply
```

- 只改没有 `tSource` 且 map 精确匹配的节点；
- 已有 `tSource` 的节点一律跳过；
- 重复跑幂等；
- 不碰 raw、不碰 index、不碰 common。

## 边界

- 不做“全库 +8 小时”；
- 不猜；
- 不改 raw 原文；
- 不保证修复所有节点；修不了的就保留原样。

---

## 另一项：旧版本下载包清理（v0.4.4 / v0.4.5）

v0.4.4、v0.4.5 的下载包和解压副本里带了一些不该公开的示例文本（群聊话术里写了具体称呼和关系）。**v0.4.6 已经去掉**，但已经下载出去的副本不会自己变干净。

你（用户的 AI）要做的是：

1. 问用户：机器上还有没有 v0.4.4 / v0.4.5 的 zip、解压出来的文件夹、或以前 clone 的仓库。
2. 找到后**先列给用户看，再删**（zip 和解压目录整份删）。
3. 如果是 git clone 的仓库，重新 clone 新版本，不要就地改旧目录。
4. 安装/升级只使用当前版本的文件；不要把旧目录里的 `docs/` 拷进安装目录。

**边界：**

- 只清我们自己发出去的包和它的解压副本；
- 不扫描用户的文档、聊天记录、记忆库；
- 不动 `%APPDATA%\dsh-memory` 下的任何数据；
- 已被转发出去的副本收不回，只保证这台机器干净。

这条没有脚本——因为按版本号认包就够了，不需要去匹配文本。查到就删，查不到就在汇报里写“未发现旧副本”。

---

## 升级到 v0.4.6 之后：确认三件事

这一节没有脚本，是给你（用户的 AI）在升级后逐条核对的。

### 1. transport 线路有没有被静默切走

0.4.6 起 `transport` 留空＝**按凭据自动**：profile 里填过 `official.appId/clientSecret` 的，会从 OneBot 切到官方机器人。

- 问用户一句：**这版默认优先官方线路，你现在想走哪条？**
- 想固定 OneBot → profile 里显式写 `transport: 'onebot'`
- 想固定官方 → `transport: 'official'`
- 不写 → 自动
- 改完必须重启 DSH；两条线路不会同时在线

核对：`%APPDATA%\dsh-memory\qq\transport-status.json` 里的 `selected` 是否符合预期。

### 2. 两个新功能是不是"用户点了才开"

| 功能 | 默认 | 谁来开 |
|:--|:--|:--|
| 鱼的心路历程（`/heart`） | 关 | 你问一次；用户同意才 `memory_heart action=enable`。拒绝后不要再提 |
| 自动唤醒（`/wake`） | 关（未绑定会话） | 先 `memory_wake action=bind target=current`，再 enable |

**不要替用户默认打开。** 两个都是"会产生行为"的功能，不是装完就该生效的东西。

### 3. 旧关心账本要不要补

`common/wake-care.json` 里历史条目的 `response` 字段会是空的——那是 0.4.6 之前没有回填逻辑，**不是数据坏了**。不用回填（也回填不了，当时的回复没记）。新账目从升级后开始记。

---

> 汇报模板：`线路：<onebot|official|自动>；心路历程：<已开/未开/未询问>；自动唤醒：<已绑定/未绑定>；旧副本：<已清/未发现>`

