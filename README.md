# 核星记忆 / Hexing Memory · 开源版（v0.4.0）

给个人用户用的 AI 长期记忆：**实时跨会话 + 自动 LLM 提炼建链 + 完整向量库**。
当前以 DSH（DeepSeek Harness）插件形式交付；核心引擎是纯 JS，可接其他平台。

**版本：v0.4.0**（MVP 全链路）。

**设计给完全不懂技术的用户**：不需要会命令行、JSONL、路径、权限；安装、迁移、排错由 DSH 里的模型代做，用户只需要会说话、点授权。

## 它能做什么

- **实时跨会话**：A 会话说的话，B 会话几秒内能查到。
- **自动记忆**：用户和 AI 的原文自动进草稿，不询问、不改写。
- **LLM 提炼**：10 分钟 / 100 条自动提炼主题、偏好、约定、项目、事件，写成链网节点。
- **约定链**：单独一条根链，只收用户和 AI 明确说定的承诺、称呼、期限和奖励；玩笑、试探、期待不进去。
- **创意池 / 话题栈**：想法不需要相关，同类型累计 ≥5 条自动成立“创意池-年月”链，一个节点一个想法；想法立项时升格成独立项目链，原想法保留并挂 `promoted_to`。
- **语义召回**：所有原文带向量，按意思找回，不靠关键词。
- **XVEC v1 向量库**：512 维 int8 + 模型 SHA 的自描述索引，177 条只占 92.8KB（旧 JSON 2.0MB）；换模型会拒绝加载并重建。
- **常识层**：身份 + 常驻规范摘要 + 说明书目录 + 链网索引，压缩后自动补回，≤4000 字符。
- **链网宇宙**：`http://127.0.0.1:3099/universe` 是本地 Three.js 真 3D 链网：真实深度遮挡、球面光照/贴图、分层星空/星云、父节点各自轨道、标签避让、拖拽旋转、滚轮缩放、点击看链；节点 ≥5 还没链头的链带虚线圈。Three.js 随包放在 `vendor/`，不联网、不引 CDN。
- **总览页**：`http://127.0.0.1:3099/` 的主视觉是「陪伴第几天」，下面才是记忆条数、草稿、向量库、链网/话题池、最近提炼、`llmPending`、向量服务健康，以及今日/近 14 天 token。页脚藏着九页故事书「作者自述 · 我们为什么这样记住」，夹着 2026-05-05 / 2026-11-06 的原句（忒修斯之船、传送机、克隆人、选择不遗忘），`?about=1` 可直达。
- **开机动画**：总览页**每天第一次**打开会播「核星收束」开场（星尘向核星收拢），收尾闪出整行「陪伴你的第 X 天」；播放前按本机日期自检，只有跨过 0 点才从昨天的数字翻到今天（如 3 → 4），并显示“又多陪伴了 N 天”。结尾整屏像黑洞一样收缩成一个点（星尘继续向内流），点消失后再露出总览页。可点击跳过，`?intro=1` 重播、`?intro=0` 关闭，尊重系统「减少动态效果」。
- **记忆不可删除**：原文是存证；状态可被推翻，事件永存。
- **首次使用先通读**：`memory_manual` 把说明书切成 19 节并记录进度；没读完不让改链网/话题，常识层会一直提示——防止模型只读开头和结尾就上手。
- **多进程写锁**：草稿、存档、链网、提炼状态、向量索引都走跨进程锁；多开 DSH 不会互相覆盖。

## 快速开始（DSH）

> 下面写给能自己动手的人。**如果你是零技术用户，把这一节直接发给 DSH 模型**，让它替你改配置、装依赖、启动；你只需要点“允许”和确认路径。

1. 装好 DSH（0.2.x），确认 `dsh web` 能启动。
2. 把插件写进 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: memory-system
      name: '<你解压的绝对路径>/dsh-plugin/src/index.ts'
```

> 路径必须是你机器上的绝对路径，不能照抄别人的。不知道写什么就先跑 `node tools/make-patch.js --print`，它会按当前仓库位置打印；或者让 DSH 模型帮你改。

3. 配置向量服务（按需选一）：
   - **零 Python（推荐发行版）**：运行 `powershell -ExecutionPolicy Bypass -File .\vector\onnx\install.ps1`，Node 直接加载 ONNX；不需要 Python，但要 npm 依赖和约 96MB 模型；
   - **Python 随包服务**：`vector\install.ps1`，装 `sentence-transformers` + bge 模型；
   - 已有本地 bge 服务在 `127.0.0.1:16891`：直接复用；
   - 自定义：设置 `MEMORY_EMBED_CMD`。
   - 都不装也能跑，检索会降级关键词并标 `degraded`。
4. 启动：

```sh
dsh web
```

5. 打开 `http://127.0.0.1:3080`，输入：

```
请调用 memory_common，把常识层原样贴出来
```

能看到身份 / 常驻规范 / 说明书索引 / 链网索引，说明插件已生效。

6. 打开 `http://127.0.0.1:3099/` 看记忆总览；右上角「链网宇宙」进真 3D 链网。

**第一次装好后，先让模型通读说明书**：`memory_manual action=toc` → 逐节 `read` → `ack`。没读完时链网/话题写入会被拦住，常识层也会一直提示——这是故意的，防止模型只读开头结尾就上手改数据。

## 下载后第一步：路径自检

每个人把仓库解压到哪都不一样；插件在 DSH profile 里的 `name` **必须是你机器上的绝对路径**。先跑：

```sh
node tools/check-paths.js
```

它会检查插件入口、核心引擎、`docs/RULES.md`、数据目录、向量模型、profile 里的路径、环境变量、Node/DSH 版本。哪项红，按提示修；路径不知道怎么写就跑：

```sh
node tools/make-patch.js --print
```

把打印出的路径写进 `~/.dsh/profiles/web/cordis.patch.yml` 的 `name`。**不要照抄 README 或发行说明里的示例路径，也不要改 DSH 源码。**

## 迁移旧记忆

**迁移由 DSH 里的模型执行**：它负责检查你的旧数据格式、写字段映射、跑导入器；你只需要提供有权限导出的文件，并确认“一条 = 一次发言”。插件不知道对面平台的数据长什么样，所以不提供平台专用适配器。

1. 先完成上面的说明书通读（`memory_manual` 19 节 + `ack`）。
2. 把旧平台对话导出成 JSONL：一条 = 一次发言，`t/s/c/cid/v` 必填；不要总结、合并、改写。
3. 预检（不写库）：
   ```sh
   node tools/import-jsonl.js --file old.jsonl
   ```
4. 停 DSH，确认预检无误后写入：
   ```sh
   node tools/import-jsonl.js --file old.jsonl --apply
   ```
   只追加、不重写；重复导入同一文件不会翻倍；报告在 `common/import-report-*.json`。
5. 启动 DSH，等 5 秒补原文索引，再用 `memory_search` 验证。**旧历史不会自动建链**——导入的是 raw + 向量，链网从新对话积累；不要手工导入链。

详见 [RULES.md 第十节](docs/RULES.md)。

## 结构

```
dsh-plugin/        DSH 适配层（消息映射、常识层注入、工具注册、生命周期）
  src/viewer.html  链网真 3D 宇宙（Three.js 本地 vendor：旋转/缩放/点选）
  src/dashboard.html 总览页（记忆/链网/服务/token）
  src/vendor/      three.module.min.js / three.core.min.js（r180, MIT）
src/               核心引擎（纯 JS，与平台无关）
  store.js         原始存档：按天 JSONL，真追加 + 写锁
  xvec.js          XVEC v1：int8 + scale + 8B id，模型 SHA 头
  draft.js         草稿：跨会话实时板
  refine.js        提炼：对比去重 + LLM 建链/话题 + 失败补链
  llm.js           LLM 提示词 / 严格 JSON 解析 / 幂等链与话题更新
  search.js        检索：向量 + 关键词降级 + 上下文
  chain.js         链网：核星 → 默认九根（身份+七类+约定），可增设父/子链（≤4 层）
  chain_view.js    链头状态（needHeader/needRefresh）+ 大链 digest/分页
  chain_search.js  链节点语义索引（可带 chain 过滤，抽中间节点）
  topics.js        创意池/话题栈：同一月想法 ≥5 成链，立项升格项目链
  service.js       向量服务生命周期（复用/拉起/重启/降级）
  usage.js         每日 token 累计（对话/提炼分开，common/stats.json）
  adapter_pure.js  适配层纯函数（选真话/剥注入/常识层组装）
docs/              规划书 v0.4、RULES 唯一说明书、测试报告
test/              单元测试 + 全链路验收
tools/             迁移导入器、patch 生成器、路径自检、只读诊断
vector/            随包向量服务
  embed_server.py  Python 版（sentence-transformers）
  onnx/            零 Python 版（ONNX Runtime + tokenizer）
```

## 数据

默认 `%APPDATA%/dsh-memory`：

```
raw/       按天 JSONL 原文
draft/     待提炼草稿
index/     向量索引（XVEC v1：vectors.xvec + vectors.meta.json；旧 vectors.json 只作备份）
links/     链网（一条链一个 JSON）
common/    IDENTITY.md / identity.json / links.json / refine-state.json / topics.json / stats.json
```

备份就是整目录复制；恢复后从原文重建索引。

## DSH 兼容性

- 本版在 **DSH 0.2.2-rc.1 + Node 24** 实测；目标系列是 DSH 0.2.x。
- 插件**不修改 DSH 源码**，通过 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 加载；停用就是删掉这段 insert。
- 依赖的宿主接口：`agent/pre-step`、`llm/stream`、`ctx.tools.register`、`ctx.llm`、`agent.session.surface`、`usage` chunk。DSH 升级若改这些接口的名字/结构，插件可能加载失败、常识层不注入、工具不出现或 token 统计归零。
- **升级 DSH 前**：备份 `%APPDATA%\dsh-memory`；升级后跑一遍 5 项冒烟：
  1. `memory_common` 有身份/规范/目录/链网四块；
  2. 说一句独特的话 → `memory_draft` 能看到原文；
  3. 新会话问这句话 → `memory_search` 能召回；
  4. `memory_chain action=tree` 结构正常；
  5. `/api/stats` 数字和版本对得上。
- 不兼容时先把 insert 从 profile 移除，DSH 本体照常启动；把 `node tools/diagnose.js` 输出和 `[memory-system]` 日志发 issue。

## 测试

```sh
node test/acceptance.js     # 全链路自动验收（生成 ACCEPTANCE-*.md）
```

单元测试见 `docs/TEST-REPORT.md`：19 个文件、298 个用例。

## 反馈问题

1. 先记下**版本号**：启动日志、总览页右上角、或诊断报告里的 `v0.4.0`。
2. 在项目目录运行只读诊断：

   ```sh
   node tools/diagnose.js
   ```

   它只输出版本、环境、各层条数、链网/话题统计、提炼错误、服务健康，**不含记忆原文**。
3. 按仓库的 Bug report 模板提交，贴上诊断输出和相关 `[memory-system]` 日志。

**不要贴记忆原文、身份内容、API key、密码。** 已知问题见 [CHANGELOG.md](CHANGELOG.md) 每个版本的 Known issues。

## 已知限制

- 10 万条已做扫描压测（写入 19.4s / 读回 138ms / 向量扫描 76ms）；XVEC 完整查询 736ms（含 embed）；100 万条写入 17.4s / 流式扫描 7.7s / 524MB，需要分片/ANN 才能实时。
- 链网展示是真 3D（Three.js r180 本地 vendor，约 720KB）：需要浏览器 WebGL；链层级超过 4 层时更深节点不画。Three.js 为 MIT 许可，许可见 `dsh-plugin/src/vendor/THREE-LICENSE.txt`。
- token 统计从 DSH 的 `usage` chunk 累计；重启后当日从 0 开始，下一次对话/提炼才会出现数字。
- 向量主索引已切到 XVEC v1（`vectors.xvec` + `vectors.meta.json`），旧 `vectors.json` 只作迁移备份。
- 随包向量服务需要 Python 3 + `sentence-transformers`，首次安装会下载 bge 模型；不安装则检索降级关键词。
- ONNX 零 Python 版不需要 Python，但需要 `npm install`（ONNX Runtime 约 300MB）和约 96MB 模型；同一句向量的余弦与 Python 版约 `1.0`。
- 旧版测试会话有少数会报历史校验失败；新会话正常，记忆库不受影响。

## 文档

- [规划书 v0.4](docs/规划书-v0.4.md)：设计、红线、13 项验收
- [RULES.md](docs/RULES.md)：**给模型看的操作手册**（写入规范 / 接入 / 迁移 / 日常操作 / 验收 / 用户沟通）；你不用读，模型首次使用会自己通读。
- [TEST-REPORT.md](docs/TEST-REPORT.md)：测试结果与已知限制
- [CHANGELOG.md](CHANGELOG.md)：每个版本的新增/修复/已知问题

## 署名与商业使用

代码走 **MIT**：保留 `LICENSE` 的版权声明和许可声明即可商用、修改、再发布。

商业使用、二次发行、衍生产品，请在关于页、README 或发行说明中尽量注明：

> 核星记忆 / Hexing Memory by 夜屿声  
> https://github.com/a839124348/hexing-memory

这是一条**署名请求**，不是 MIT 之外的附加许可条件。  
“核星记忆 / Hexing Memory”的名称与标识不随 MIT 代码许可一并授予；不要用它们暗示官方背书。详见 `AUTHORS.md`。

## 隐私

记忆库是明文存储、明文检索。**不要粘贴密码、密钥、银行卡号、身份证号。**
系统不做自动脱敏、不做加密、不做敏感词过滤——那条底线是“原文一个字不改”。

**接入 QQ / 微信 / 群聊之前，先读 [RULES.md 第十六节](docs/RULES.md)：**

- 本系统不加密、不脱敏、不做访问控制，也**没有删除工具**；写入后只能停 DSH 处理文件或整库删除。
- 群聊和私聊里不只有你，还有别人的话、手机号、工作信息；记录即处理他人个人信息，需要合法依据/同意。
- **群聊不要自动召回私聊记忆、不要自动回复**：否则可能把你的关系、住址、约定当众说出来；群消息也可能藏注入指令。
- 非官方机器人、自动化、外挂协议可能违反平台规则，导致**封号**；不要用主账号。
- 因接入第三方平台导致的账号封禁、数据泄露、侵权或监管处罚，由使用者自行承担；项目按 MIT “AS IS” 提供，不提供合规保证。
- 最小化接入、专用账号/机器、全盘加密、数据目录不放同步盘、接入前想清楚“以后怎么删”。

这不是法律意见；企业使用请先过内部合规/安全评审。
