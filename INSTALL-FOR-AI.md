# INSTALL-FOR-AI.md — 给 DSH 模型的安装说明书

> **读者：DSH 里的模型，不是用户。**
> 用户可能完全不懂命令、路径、JSON、YAML。你来装，用户只负责“允许、确认、点授权”。
>
> 目标：把核星记忆装进当前 DSH profile，启动后 `memory_common` 能看到身份 / 常驻规范 / 说明书索引 / 链网索引四块。
>
> **红线：**
> - 不删任何东西；不改 DSH 源码；不把密码、token、API key 写进文件或聊天。
> - 改 `cordis.patch.yml` 前必须备份；已经有 `id: memory-system` / `id: memory-system-ui` 就跳过。
> - 不替用户决定迁移模式；装完后问，不替用户选。
> - **侧边栏入口分两步装**：先只装插件本体（`-Phase core`）；等用户选完迁移模式、导入/初始化完成，再装侧边栏（`-Phase ui`）。不要一上来就把两段都写进 profile。
> - 不承诺“和旧平台完全一样”；只承诺记忆/档案可带走。

---

## 0. 先确认环境

在用户机器上执行：

```powershell
node -v
dsh --version
```

要求：

- Node **>= 20**（推荐 24）
- DSH **0.2.x**（当前实测 0.2.2-rc.1）
- 能找到 `~/.dsh/profiles/web/cordis.patch.yml`

如果 Node 或 DSH 没有，先按官方方式装；不要自己编译 DSH。

---

## 1. 选安装方式

### A. 用户只给了仓库链接（推荐）

用户会说类似：

> 把 https://github.com/a839124348/hexing-memory 装成我的记忆插件。

你来做：

1. 选安装目录：默认 `%USERPROFILE%\hexing-memory`；如果用户给了目录，用用户的。
2. 下载固定 tag 的源码包（**不要装 main**）：

```powershell
$Tag = 'v0.4.4'
$InstallDir = Join-Path $env:USERPROFILE 'hexing-memory'
$Zip = Join-Path $env:TEMP "hexing-memory-$Tag.zip"
Invoke-WebRequest "https://github.com/a839124348/hexing-memory/archive/refs/tags/$Tag.zip" -OutFile $Zip
Expand-Archive $Zip -DestinationPath $env:TEMP -Force
$Src = Join-Path $env:TEMP "hexing-memory-$($Tag.TrimStart('v'))"
if (Test-Path $InstallDir) { throw "安装目录已存在：$InstallDir；先问用户是否覆盖/换目录" }
Move-Item $Src $InstallDir
```

3. 下载两个模型文件到 `vector\onnx\`：

```powershell
$Rel = "https://github.com/a839124348/hexing-memory/releases/download/$Tag"
Invoke-WebRequest "$Rel/model.onnx" -OutFile "$InstallDir\vector\onnx\model.onnx"
Invoke-WebRequest "$Rel/bge-small-zh-v1.5.onnx.data" -OutFile "$InstallDir\vector\onnx\bge-small-zh-v1.5.onnx.data"
```

4. 校验 SHA256：

```text
model.onnx                  E96E1CA1523D61CD0DBBA45B40A4E8B7D7CBED58FC51C0370BC8827C43FD785B
bge-small-zh-v1.5.onnx.data 02A5F74BE93B625908C7AE11B04042C21F06864E9A439605D304367388F2B256
```

不一致就停下，别继续装。

> 如果 GitHub 打不开：让用户下载 Release 的 `hexing-memory-v0.4.4-full.zip`（已含模型），解压后把文件夹路径给你；从第 2 步的 `install.ps1` 开始。

### B. 用户给了 full zip

1. 解压到 `%USERPROFILE%\hexing-memory` 或用户指定目录。
2. 确认 `vector\onnx\model.onnx` 和 `.data` 存在。
3. 跳到第 2 步。

---

## 2. 第一步：只装插件本体（Phase core）

```powershell
cd $InstallDir
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase core -DryRun
```

DryRun 只打印：

- 安装目录
- profile 路径
- 要插入的 YAML
- 会备份到哪个文件
- 模型/依赖检查结果

**把要改的 profile 和插入内容给用户看，得到确认后**再：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase core -Apply
```

脚本会：

- 备份 `cordis.patch.yml` 到 `.bak-<时间>`
- 幂等插入插件本体：

```yaml
- insert:
    - id: memory-system
      name: '<安装目录>/dsh-plugin/src/index.ts'
```

- 已有 `id: memory-system` 就跳过，不重复插
- 检查模型文件；缺了就报错，不会静默装一个没有向量的版本
- 尝试 `npm install`（`vector/onnx`）；成功后写 `vector/onnx/.ready`，插件才会自动拉起向量服务；失败只警告，检索会降级关键词
- 跑 `node tools/check-paths.js`

> `-Phase core` **不会**装侧边栏入口。此时路径自检里的「侧边栏入口（待安装）」是正常状态，不是错误。
>
> 不要用 `-Phase all` 跳过首次迁移；那是给已经完成 onboarding、只想一次重装两段的老用户。

---

## 3. 重启 DSH

- `dsh web`：停掉当前进程，重新 `dsh web`
- GitHub Desktop / 桌面版：退出后重新打开

重启后打开：

```text
http://127.0.0.1:3080
```

---

## 4. 验证

让模型调用：

```text
memory_common
```

应该能看到四块：

1. 身份
2. 常驻规范
3. 说明书索引
4. 链网索引

**左侧栏现在不应该有「记忆总览」**——这是故意的，入口要等迁移/初始化完成后才装。用户若自己打开 `http://127.0.0.1:3099/`，总览页会显示“还没有开始记住任何对话”的引导，而不是一排 0。

再调用：

```text
memory_onboarding action=status
```

应该返回 `mode: null` 和“还没选迁移模式”的 checklist，**不是“工具不存在”**。

如果工具不存在：

1. 看 `cordis.patch.yml` 里有没有 `id: memory-system`
2. 看启动日志有没有 `[memory-system] 核星记忆 v0.4.4 已加载`
3. 跑 `node tools/check-paths.js`，按红项修
4. 仍不行：把 profile 备份恢复，保留数据，把日志给用户/开发者

---

## 5. 装完后的第一次引导

1. `memory_manual action=toc` → 逐节 `read` → `ack`
   - 19 节，没读完不能改链网/话题
2. 如果用户要迁移旧对话，**先问三选一**：
   - 全继承（记忆 + 称呼 + 语气 + 习惯）
   - 只继承记忆（语气重新长）
   - 全新开始（不导入）
   - **选 inherit/memory 时，必须同时告知**：旧历史补链网会分批调用 LLM、消耗 token；导入后先用 `memory_backfill action=status` 估算，再问一次，不会自动开始。
3. 用 `memory_onboarding action=save` 记录；`inherit/memory` 需要 `consent=true`
4. 全继承再按 RULES 第 10.0 节提炼 `common/voice-habits.md`，必须有 `## 常驻核心`（≤800 字）
5. 迁移完成后用 `memory_search` 验证旧对话能搜到；全新开始则先正常聊一句
6. 旧历史补链：读 `common/offline-import-result.json` 的 `chainBackfill`（pending / 批数 / token 估算），把估算告诉用户；用户同意后 `memory_backfill action=preview` → `start`，可 `pause/resume`
7. 不替用户选，不承诺“完全一样”

> 老用户升级（旧对话已在 raw、只是没补链）：对 AI 说“检查旧历史链网，先统计，我同意后再补”即可。完整步骤见 `docs/老用户补链升级.md`。

**做完这一步，才去第 6 节装侧边栏入口。**

---

## 6. 迁移/初始化完成后：装侧边栏入口（Phase ui）

满足任一条件才做：

- 全继承 / 只继承记忆：旧对话已导入，`memory_search` 能搜到；
- 全新开始：`memory_onboarding action=save` 已保存，且已经有过至少一句对话。

先 DryRun：

```powershell
cd $InstallDir
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase ui -DryRun
```

确认后：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase ui -Apply
```

脚本会：

- 检查 `%APPDATA%\dsh-memory\common\onboarding.json` 里有没有 `mode`；没有就**拒绝安装**并提示先做 onboarding（防呆，不是故障）
- 幂等插入：

```yaml
- insert:
    - id: memory-system-ui
      name: '<安装目录>/dsh-plugin-ui/lib/index.js'
```

- 备份 profile，再跑路径自检；此时「侧边栏入口」应该变绿

装完重启 DSH，左侧栏才会出现「记忆总览」。如果用户已经手动收藏了 `http://127.0.0.1:3099/`，不装入口也能看；但入口是给零技术用户准备的，迁移完成后应该补上。

> 如果用户明确要求先装入口（例如他要先看空界面再决定迁不迁），才加 `-Force`。默认不要替用户做这个决定。

---

## 7. 失败分支

| 现象 | 处理 |
|---|---|
| 安装目录已存在 | 问用户：换目录 / 备份后覆盖；不要直接删 |
| `Invoke-WebRequest` 失败 | GitHub 网络问题；改用 full zip，或让用户开代理后重试 |
| SHA256 不一致 | 删除下载的模型文件，重新下载；不要带病安装 |
| profile 不存在 | 用户还没初始化 web profile；先 `dsh web` 一次，或让用户确认 DSH 安装 |
| YAML 插入后 DSH 启动失败 | 恢复 `.bak-<时间>`；把日志给开发者；不要改 DSH 源码绕过 |
| `npm install` 失败 | 继续；向量服务会降级关键词；告诉用户“能用，但语义召回弱” |
| 端口 3080/3099 被占 | 先停旧 DSH；不要杀未知进程 |
| 权限不足 | 让用户把仓库放到用户目录，不要写 `C:\Program Files` |
| `-Phase ui` 提示“还没选迁移模式” | 正常防呆；先完成第 5 节 onboarding，不要用 `-Force` 绕过 |
| 侧边栏入口没出现 | 确认 profile 有 `memory-system-ui`、路径存在、DSH 已重启；跑 `check-paths.js` |

---

## 8. 停用 / 回滚

- 停用：从 `cordis.patch.yml` 删除 `memory-system` 那一段，重启 DSH；数据目录保留。
- 回滚安装：恢复 `cordis.patch.yml` 的 `.bak-<时间>`，重启。
- **不要删 `%APPDATA%\dsh-memory`**，除非用户明确要求并已备份；原文是存证。

---

## 9. 给用户的汇报模板

装完插件本体后只说人话：

> 装好了。现在 DSH 已经能记住我们说过的话。
> 如果你要导入以前的对话，我先问你三个选项：把以前的它尽量带回来 / 只带记忆 / 全新开始。
> 不导入也能正常用；等这边安顿好，我再把左侧栏的「记忆总览」按钮装上。

迁移/初始化完成、入口装好后：

> 左侧栏现在有「记忆总览」了，点开就能看我们记住的第几天、多少条原文和链网。
> 总览页是 http://127.0.0.1:3099/ ，不想点按钮也可以直接开。

不要把命令、YAML、错误码甩给用户。
