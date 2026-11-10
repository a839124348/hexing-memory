# 打包与发布清单（本地，不上传）

> 目标：明天早上可以直接 `git push` 或打 GitHub Release。  
> 原则：代码进 Git，模型进 Release，个人数据不进任何地方。

## 0. 名字 / 许可

- 中文名：**核星记忆**
- 英文名：**Hexing Memory**
- 仓库名建议：`hexing-memory` / `hexing-memory-mvp`
- 许可：MIT（见 `LICENSE`）
- 第三方：见 `NOTICE.md`

## 1. 绝对不能进仓库

- `data/`、`_backup/`
- `_dsh_run*.log`、`*.log`
- `%APPDATA%/dsh-memory`（不在项目里，但要确认没有复制进来）
- `docs/HANDOFF-*.md`（个人上下文）
- `vector/onnx/node_modules/`（约 300MB）
- `vector/onnx/.ready`、`vector/.ready`
- `test/ACCEPTANCE-*.md`（含本机路径和测试内容）
- 任何 token / 密码 / 私钥 / `.env`

`.gitignore` 已覆盖以上项目。

## 2. 模型放 GitHub Release

ONNX 模型文件不进主仓库：

- `vector/onnx/model.onnx`（41KB 图）
- `vector/onnx/bge-small-zh-v1.5.onnx.data`（约 96MB）

发布时创建 tag `v0.4.3`，把这两个文件作为 Release assets 上传。  
用户可以下载后放进 `vector/onnx/`，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\vector\onnx\install.ps1
```

> 两个文件名不能改：`model.onnx` 内部引用的是 `bge-small-zh-v1.5.onnx.data`。

## 3. 本地预检

```powershell
# 1) 公开文档里不能有个人身份
Select-String -Path README.md,docs\规划书-v0.4.md,docs\RULES.md,docs\TEST-REPORT.md,sample.jsonl -Pattern "token|密码|私钥|dsh-memory\\raw" -SimpleMatch

# 2) 样例校验
node -e "const fs=require('fs');const {validateRecords}=require('./src/validate');const rows=fs.readFileSync('sample.jsonl','utf8').trim().split(/\r?\n/).map(JSON.parse);console.log(validateRecords(rows,{allowWarnings:true}).ok)"

# 3) 全量单测 + 验收
node test/acceptance.js
```

## 4. Git 初始化

```powershell
git init
git add .
git status
git commit -m "核星记忆 v0.4.3: full-chain memory MVP"
git branch -M main
```

确认 `git status` 里没有：

- `data/`
- `_backup/`
- `_dsh_run*.log`
- `docs/HANDOFF-*.md`
- `vector/onnx/node_modules/`
- `vector/onnx/model.onnx`
- `*.onnx.data`

## 5. GitHub

```powershell
git push -u origin main
```

然后在 GitHub 创建 Release：

- tag：`v0.4.3`
- title：`核星记忆 v0.4.3`
- assets：
  - `hexing-memory-v0.4.3-full.zip`（源码 + 两个模型，给链接安装失败/离线用户）
  - `model.onnx` + `bge-small-zh-v1.5.onnx.data`（给只下源码的用户）

链接安装：用户把仓库链接发给 DSH，模型按 `INSTALL-FOR-AI.md` 下载固定 tag 和模型、跑 `install.ps1`。

## 6. 发布后验证

在干净目录 clone 一次，不复制本机数据：

```powershell
git clone <repo> clean-test
cd clean-test
npm install --prefix vector/onnx
node test/acceptance.js
```

再按 README 配 DSH，确认：

- 能启动
- 常识层能注入
- 记忆能写入/检索
- 没有模型时能显式降级关键词
