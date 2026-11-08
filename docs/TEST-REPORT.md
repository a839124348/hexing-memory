# 开源记忆系统 · 测试报告

> 测试日期：2026-11-08
> 被测版本：MVP v0.4（全链路）
> 运行环境：Node.js v24 / Windows / 本地 bge-small-zh-v1.5（512 维）
> 数据目录：单元/验收全部使用临时目录；真机数据在 `%APPDATA%\dsh-memory`

---

## 一、结果汇总

| 测试集 | 用例数 | 通过 |
|:--|--:|--:|
| `unit-mid` 消息唯一 ID | 12 | 12 |
| `unit-store` 存档层 | 15 | 15 |
| `unit-validate` 校验器 | 21 | 21 |
| `unit-chain` 链网 | 23 | 23 |
| `unit-refine-dedup` 提炼去重 | 11 | 11 |
| `unit-stripnoise` 注入剥离 | 8 | 8 |
| `unit-identity-rules` 身份规则 | 19 | 19 |
| `unit-lock` 跨进程写锁 | 5 | 5 |
| `unit-append` 真追加 + 多进程 | 10 | 10 |
| `unit-llm-refine` LLM 纯函数 | 25 | 25 |
| `unit-refine-llm` LLM 提炼管线 | 16 | 16 |
| `unit-service` 向量服务生命周期 | 8 | 8 |
| `unit-adapter-pure` 适配层纯函数 | 25 | 25 |
| `unit-topics` 创意池/话题栈 | 24 | 24 |
| `unit-topic-llm` LLM → 创意池 | 7 | 7 |
| `unit-chain-view` 链头状态/大链 digest | 14 | 14 |
| `unit-chain-search` 链节点语义检索 | 9 | 9 |
| **合计** | **252** | **252** |

---

## 二、全链路验收（自动部分 13/13）

| # | 项 | 结果 | 证据 |
|:--|:--|:--|:--|
| 1 | 跨会话实时（核心层） | ✅ | A 写入，B 立刻可见；8ms |
| 2 | 自动提炼入库 | ✅ | 草稿 1 条 → 存档 1 条 |
| 3 | LLM 建链 | ✅ | 假 LLM 管线建出 1 节点 |
| 4 | state 推翻 / event 保留 | ✅ | 旧 state 标 superseded，新 state 保留 |
| 5 | 同分钟同文 / 跨会话同文 | ✅ | 同会话 2 条、跨会话 2 条 |
| 6 | 崩溃半行截尾 | ✅ | 半行被截，坏行不计数 |
| 7 | 多进程写锁 | ✅ | 两进程各 100 条，200 条 / 200 个 id |
| 8 | 向量索引 / 语义召回 | ✅ | 索引 7 条，`mode=vector`，Top1 命中体检 |
| 9 | 32 并发检索 | ✅ | 32/32 成功，结果签名 1 种 |
| 10 | 常识层 | ✅ | 957 字符，身份/摘要/目录/链网四块齐全 |
| 11 | 批量写入 1000 条 | ✅ | 20ms |
| 12 | 向量服务无命令降级 | ✅ | 返回 `no-cmd`，不阻塞 |
| 13 | 适配层选真话 | ✅ | 跳过 time-context/system-reminder，取到真话 |

补充：链网层级真机验收——默认九根（身份+七类+约定链）；在「学习」下新建「学习链-层级验收」成功，1 个节点。
补充：创意池真机验收——5 个互不相关想法成立「创意池-2026-11」（5 节点）；立项升格「项目链-光轴」（1 节点），原想法保留并挂 `promoted_to`。
补充：链头后置真机验收——身份链 5 节点时模型读到 `needHeader` 顺手写了 header；项目链-三进制 15 节点默认只回 9 条 digest、`needRefresh: true`；`memory_search chain=项目链-三进制计算机` 命中中间 `nodeIndex: 11`。
补充：写锁覆盖——`refine.js` 的 `.refine.lock` / `.refine-links.lock`、`search.js` 的 `.vectors.lock`、`chain_search.js` 的 `.chain-vectors.lock`；提炼/链检索单测 36/36、全链路 13/13。
补充：XVEC v1——`index/vectors.xvec` 92.8KB / 177 条（旧 JSON 2.0MB）；`vectors.meta.json` 保存字符串 id 映射；模型 SHA 不符拒绝加载；自测 1000 条、8 进程追加 5000 条、截断检测全过；真机迁移后语义检索 `mode=vector`。
补充：XVEC 10 万合成向量——写入 1.4s / 读回 457ms / 扫描 49ms / 完整查询 736ms（含 embed 往返）/ 文件 52.4MB（524B 每条）。
补充：XVEC 100 万合成向量——写入 17.4s / 流式扫描 7.7s / 文件 524MB；10 万以内实时，100 万需要分片或 ANN 才能压到 1s 内。
补充：随包服务——`vector/embed_server.py` 在 16892 端口实测 health 200（bge-small-zh-v1.5）；`vector/install.ps1` 生成 `.ready` 后插件自动拉起。
补充：token 真机——DSH `usage` chunk 已落 `common/stats.json`；对话 15,609 in / 6 out，提炼 1,163 / 10，总览页正常显示。
补充：P1 细节——`memory_draft` 默认每会话 30 条，支持 cid/minutes/limit 和 cid 哈希稳定代号；time-context 只信 10 分钟内；`historyHasCommon` 全量扫描；tool-call 步不记 AI 前解说。run38 启动通过。
补充：ONNX 零 Python——`vector/onnx` 在 16893 health 200（bge-small-zh-v1.5），CLS 向量与 Python 版余弦约 `1.0`；`service.js` 在 16894 自动拉起并 stop 成功；模型约 96MB，ONNX Runtime npm 依赖约 300MB。
补充：约定链——单独根链 `约定链`（parent=核星）；真机 9 根 / 15 链 / 45 节点，已写入 1 个真实约定（平常叫用户，认真时叫亲爱的）；LLM 提示词要求明确约定写入 `约定链`，且不造新顶层根。

报告文件：`test/ACCEPTANCE-2026-11-07T22-41-44-182Z.md`

### 手工项（已在 DSH 界面 / 3099 验收）

| # | 项 | 结果 | 证据 |
|:--|:--|:--|:--|
| M1 | DSH 压缩后常识层自动补回 | ✅ | `/compact` 压缩 55 条 / 30412 tokens；身份与版本行仍在；`count-common` 显示 1 段 |
| M2 | 跨会话 5 秒内（界面计时） | ✅ | A 消息 02:08:32，B 02:08:47 已查到「测试词」（间隔 15s；捕获在请求前，实际 <1s）；`memory_search` 有 `layer:draft` |
| M3 | 10 万条性能 | ✅（扫描） | 写入 100000 条 19.4s；读回 138ms；向量扫描 100k 76ms（不含 embed 往返） |
| M4 | 链网真 3D 展示 | ✅ | Three.js r180 本地 vendor（零 CDN）；真深度遮挡 + 球面光照/贴图 + 分层星空；9 分支 / 15 链 / 45 节点；拖拽/缩放/点核星面板；61fps；vendor JS 两个文件均 200 |
| M5 | 总览页 + token 统计 | ✅ | 177 条存档 / 今日 63；陪伴第 2 天；草稿 0；向量 177；链网 9 分支 / 15 链 / 45 节点；话题 1；提炼 19 次；服务在线；14 天 token 柱状图；实测对话 1 次 15,609 in / 6 out，提炼 1 次 1,163 / 10（输入含缓存 16,256） |

---

## 三、本轮修掉的真实坑

| # | 坑 | 现象 | 修法 |
|:--|:--|:--|:--|
| 1 | 注入消息缺 `id` | DSH 会话历史校验失败：`session event lacks an identified message` | 注入消息带唯一 `memory-common-*` id |
| 2 | LLM 推理吃光输出预算 | `text=0`，`reasoning=4036`，建链失败 | 提炼调用 `reasoningEffort:'off'`，`text=714` |
| 3 | 并发 embed 被拒 | 32 并发检索部分退化成关键词，结果从 3 条变 1 条 | embed 客户端并发闸门 `EMBED_CONCURRENCY=4`，32/32 成功且签名一致 |
| 4 | 同分钟同文被吞 | 同一分钟连说两遍只存一条 | 格式契约加 `mid`，哈希/草稿/存档全链路认它 |
| 5 | 常识层越写越大 | 注入“当前状态 + 最近会话” | 只留身份 + RULES 常驻摘要 + 说明书目录 + 链网索引，≤4000 字符 |
| 6 | 检索计数对不上 | `layers` 是两层命中总数，`results` 是限流/去重后的数，模型看到 draft 6/formal 20 但只返回 19 条 | `layers` 改为实际返回条数，另给 `matched` 表示命中总数；真机复核 7+12=19 |

---

## 四、已知限制

- 10 万条已测：写入 19.4s / 读回 138ms / 向量扫描 76ms；XVEC 完整查询 736ms（含 embed）；100 万条 XVEC 写入 17.4s、流式扫描 7.7s、文件 524MB，**100 万不是实时级，需要分片/ANN**。
- 链网展示是真 3D（Three.js r180，本地 `vendor/`，约 720KB）：需要浏览器 WebGL；最多画到第 4 层，更深的节点不画，只保留数据。MIT 许可见 `dsh-plugin/src/vendor/THREE-LICENSE.txt`。
- 向量文件已切到 XVEC v1；旧的 `index/vectors.json` 作为迁移输入/备份保留，不再作为主索引。
- 随包向量服务首次安装需要 Python + `sentence-transformers` 和一次模型下载；装完 `vector/.ready` 后由插件自动拉起。
- ONNX 零 Python 版不需要 Python，但需要 `npm install`（ONNX Runtime 约 300MB）和约 96MB 模型；`service.js` 已实测可自动拉起/停止。
- 外部复用 16891 时没有自动重启 watchdog（P2）；随包服务有重启守护。
- DSH 压缩后补回已真机通过（1 段、身份与版本行都在）；`historyHasCommon` 只看最近 80 个节点，超长会话仍有重复注入风险。
- 旧的 bug 前测试会话有少数会报历史校验失败；新会话正常，记忆库不受影响。
- token 统计从 DSH `usage` chunk 累计到 `common/stats.json`；重启后当日计数从 0 开始，下一次对话/提炼才会出现数字。
- 链网里还留着几条 prompt 收紧前的测试节点（“回一个字”之类），属于测试数据，不影响新提炼。

---

## 五、怎么复跑

```sh
# 单元测试（17 个文件）
node test/unit-mid.js
node test/unit-store.js
node test/unit-validate.js
node test/unit-chain.js
node test/unit-refine-dedup.js
node test/unit-stripnoise.js
node test/unit-identity-rules.js
node test/unit-lock.js
node test/unit-append.js
node test/unit-llm-refine.js
node test/unit-refine-llm.js
node test/unit-service.js
node test/unit-adapter-pure.js
node test/unit-topics.js
node test/unit-topic-llm.js
node test/unit-chain-view.js
node test/unit-chain-search.js

# 全链路自动验收（会生成 ACCEPTANCE-*.md）
node test/acceptance.js
```
