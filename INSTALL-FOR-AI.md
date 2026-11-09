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
$Tag = 'v0.4.1'
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

> 如果 GitHub 打不开：让用户下载 Release 的 `hexing-memory-v0.4.1-full.zip`（已含模型），解压后把文件夹路径给你；从第 2 步的 `install.ps1` 开始。

### B. 用户给了 full zip

1. 解压到 `%USERPROFILE%\hexing-memory` 或用户指定目录。
2. 确认 `vector\onnx\model.onnx` 和 `.data` 存在。
3. 跳到第 2 步。

---

## 2. 先 DryRun，再 Apply

```powershell
cd $InstallDir
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
```

DryRun 只打印：

- 安装目录
- profile 路径
- 要插入的 YAML
- 会备份到哪个文件
- 模型/依赖检查结果

**把要改的 profile 和插入内容给用户看，得到确认后**再：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Apply
```

脚本会：

- 备份 `cordis.patch.yml` 到 `.bak-<时间>`
- 幂等插入两段：

```yaml
- insert:
    - id: memory-system
      name: '<安装目录>/dsh-plugin/src/index.ts'
    - id: memory-system-ui
      name: '<安装目录>/dsh-plugin-ui/lib/index.js'
```

- 已有 `id: memory-system` / `id: memory-system-ui` 就跳过，不重复插
- 第二个是 DSH 左侧栏的「记忆总览」入口，不是可选项；缺了它，用户只能记 3099 地址
- 检查模型文件；缺了就报错，不会静默装一个没有向量的版本
- 尝试 `npm install`（`vector/onnx`）；失败只警告，检索会降级关键词
- 跑 `node tools/check-paths.js`

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

左侧栏应该出现「记忆总览」按钮，点开直接显示 3099 总览页。

再调用：

```text
memory_onboarding action=status
```

应该返回 `mode: null` 和“还没选迁移模式”的 checklist，**不是“工具不存在”**。

如果工具不存在：

1. 看 `cordis.patch.yml` 里有没有 `id: memory-system` 和 `id: memory-system-ui`
2. 看启动日志有没有 `[memory-system] 核星记忆 v0.4.1 已加载`
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
3. 用 `memory_onboarding action=save` 记录；`inherit/memory` 需要 `consent=true`
4. 全继承再按 RULES 第 10.0 节提炼 `common/voice-habits.md`，必须有 `## 常驻核心`（≤800 字）
5. 不替用户选，不承诺“完全一样”

---

## 6. 失败分支

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

---

## 7. 停用 / 回滚

- 停用：从 `cordis.patch.yml` 删除 `memory-system` 那一段，重启 DSH；数据目录保留。
- 回滚安装：恢复 `cordis.patch.yml` 的 `.bak-<时间>`，重启。
- **不要删 `%APPDATA%\dsh-memory`**，除非用户明确要求并已备份；原文是存证。

---

## 8. 给用户的汇报模板

装完后只说人话：

> 装好了。现在 DSH 已经能记住我们说过的话；总览页在 http://127.0.0.1:3099/。
> 如果你要导入以前的对话，我先问你三个选项：把以前的它尽量带回来 / 只带记忆 / 全新开始。
> 不导入也能正常用；以后想导入随时可以。

不要把命令、YAML、错误码甩给用户。
