# 核星记忆 / Hexing Memory · DSH 插件

把开源记忆系统接进 DeepSeek Harness。装载后模型获得八个工具，并且**每次上下文压缩后自动重新加载常识层**。

## 一、前置

- 已完成 DSH 的[从源码运行](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md#run-from-source)（`pnpm dsh web` 能起来），或已全局安装 `dsh`
- 本仓库的 `src/`（核心引擎）与 `dsh-plugin/`（插件外壳）在同一目录

## 二、装载

### 方式 A：装进 profile（推荐，装一次以后 `dsh web` 直接生效）

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在数组末尾追加：

```yaml
- insert:
    - id: memory-system
      name: '<你解压的绝对路径>/dsh-plugin/src/index.ts'
```

> `name` 必须是**你这台机器上的绝对路径**，不能照抄别人的 `D:/...` 或 `/home/...`。不知道写什么就运行 `node tools/make-patch.js --print`，它会按当前仓库位置打印。Windows 路径在 YAML 里用正斜杠 `/` 最稳。

然后正常启动：

```sh
dsh web
```

### 方式 B：单次启动时挂载（不改 profile）

仓库里不存本机绝对路径；先生成一份只属于这台机器的 patch：

```sh
node tools/make-patch.js
dsh --profile web --patch ./dsh-plugin/cordis.local.yml
```

`cordis.local.yml` 已 gitignore，不会上传；换电脑重新生成即可。

> 注意：当前 DSH 0.2.x 里 `--patch` 是**启动器参数**，要放在 profile 名之前或配合 `--profile` 使用；
> `dsh web --patch ...` 会报 `unknown option '--patch'`。

启动后打开 `http://127.0.0.1:3080`，输入：

```
请调用 memory_common，把常识层原样贴出来
```

能看到身份 / 常驻规范 / 说明书目录 / 链网索引，说明插件已生效。

> 想让插件自己拉起向量服务：
> - 零 Python：跑 `vector\onnx\install.ps1` 生成 `vector/onnx/.ready`；
> - Python 版：跑 `vector\install.ps1` 生成 `vector/.ready`。  
> 16891 没有服务时插件会自动拉起对应随包服务。

## 三、环境变量（可选）

| 变量 | 默认 | 说明 |
|:--|:--|:--|
| `MEMORY_ROOT` | `%APPDATA%/dsh-memory` | 数据目录（存档 / 草稿 / 索引 / 常识 / 链网） |
| `MEMORY_CORE` | `../../src` | 核心引擎目录（打包发布后可改） |
| `EMBED_URL` | `http://127.0.0.1:16891` | 向量服务地址；已健康就复用 |
| `MEMORY_EMBED_CMD` | 优先 `vector/onnx`（装 `.ready` 后），否则 `vector/embed_server.py` | 向量服务启动命令；显式设置后覆盖随包服务；崩溃自动重启 |
| `BGE_MODEL_PATH` | 空 | Python 随包服务的本地模型目录；空则用 `BAAI/bge-small-zh-v1.5` |
| `BGE_ONNX_MODEL` | `vector/onnx/model.onnx` | ONNX 版模型路径 |
| `MEMORY_VIEWER_PORT` | `3099` | 总览 + 链网展示窗端口（Three.js 真 3D） |

## 四、八个工具

| 工具 | 作用 | 什么时候调用 |
|:--|:--|:--|
| `memory_write` | 写草稿（一次发言一条，原文不改） | 用户明确说“记住” |
| `memory_search` | 检索草稿 + 链节点 + 正式存档（向量；可带 `chain` 过滤） | 用户问“之前说过什么 / 这条链里说过什么” |
| `memory_draft` | 看最近未提炼的跨会话草稿（带“距今多久”） | 用户问“刚才那个 / 另一个窗口” |
| `memory_common` | 读常识层 | 手动刷新（正常由请求前自动注入） |
| `memory_manual` | 分节读 RULES、记录进度、`ack` 解锁 | 首次安装/升级先通读；迁移前必读 |
| `memory_identity` | 写身份四段（空字段才填，改已有值要用户明确同意） | 用户自报名字 / 关系 |
| `memory_chain` | 链网：tree / get（大链 digest / offset / full）/ append / header / audit | 用户问“我们经历过什么 / 这个项目”；get 返回 needHeader 时顺手写 header |
| `memory_topic` | 话题栈 / 创意池：list / get / add / promote / close / merge | 想法累计 ≥5 成立创意池；想法立项升格项目链 |

> 提炼不是工具，是后台进程：草稿 ≥100 条立即跑，否则最老草稿满 10 分钟跑一次；对话结束/重启也会补。

## 五、常识层怎么自动加载

**不依赖模型主动调用**。插件挂在 `agent/pre-step`：

```
每一步请求前（pre-step）
  ↓
本步消息里 / 会话历史里已有 memory-system 标记吗？
  ├─ 有 → 不动
  └─ 没有（首次 / 刚被压缩掉）→ 把常识层追加到本步消息最前面
```

- 用 `agent/pre-step` 而不是 `llm/stream`：当前 DSH 的 `llm/stream` 签名是 `next()`，
  不接受改过的 options（实测旧写法日志说“已注入”，模型却看不到）。
- 注入只做一次：`agent.session.surface` 里已有标记就跳过，所以多步工具调用、
  多轮对话都不会重复堆常识层；DSH 压缩把旧消息裁掉后，下一次 pre-step 自动补回。

**这就是“压缩后自动加载常识层”的实现。**

## 六、已验证（2026-11-08 实测）

- 插件随 DSH 0.2.2-rc.1 正常加载，启动日志打印存档条数
- **常识层自动注入**：不调工具、直接问“你叫什么/我们什么关系”，模型能答出身份
- **多步不重复注入**：一次工具调用跑 4 步，会话里只有 1 份常识层
- **用户消息不漏记**：用户消息后面跟着 `system-reminder` / `runtime-context` 时也能抓到真话
- **多会话同文各记一条**：同一句话在两个会话里各存一条，不按内容全局去重
- `memory_common` / `memory_draft` / `memory_search` / `memory_chain` / `memory_topic` 在真实会话里调用成功
- 链网展示窗 `http://127.0.0.1:3099/universe` 可用；总览页 `http://127.0.0.1:3099/` 可以看到记忆/草稿/向量/链网/话题/提炼/服务/token；Three.js r180 本地 vendor，不联网
- 自动记录：用户消息 + AI 回复都进草稿，提炼后进存档

旧版列的三处“待验证”（pre-step 事件名 / agent.inject / hasContext）已不适用：
当前实现走 `agent/pre-step` + `agent.session.surface` 判重，已实测可用。

## 七、数据结构

```
%APPDATA%/dsh-memory/
├── raw/           原始存档（按天 JSONL，原子写）
├── draft/         草稿（待提炼）
├── index/         向量索引（XVEC v1：vectors.xvec + vectors.meta.json）
├── links/         链网（一条链一个 JSON）
├── common/        IDENTITY.md / identity.json / links.json（会话节点）/ refine-state.json / stats.json（token）
```

## 八、启动

双击 `启动DSH带记忆插件.bat`，或直接：

```sh
dsh web
```
