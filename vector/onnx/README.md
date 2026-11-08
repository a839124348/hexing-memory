# 零 Python 向量服务（ONNX）

这是 `vector/` 里的第二条路：不启动 Python 进程，Node 直接加载 ONNX 模型。

- 模型：`bge-small-zh-v1.5`，512 维，CLS pooling
- 分词器：`@huggingface/tokenizers`
- 推理：`onnxruntime-node`
- 模型文件：`model.onnx` + `bge-small-zh-v1.5.onnx.data`
- 输出与 Python 版一致；同一句“周末想去看海”的余弦相似度约 `1.0`

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\vector\onnx\install.ps1
```

脚本只做两件事：

1. `npm install` 安装 ONNX Runtime 和分词器；
2. 检查模型文件，写 `vector/onnx/.ready`。

之后 16891 没有服务时，插件自动拉起 `embed_server.mjs`；不需要 Python，也没有 HTTP 之外的服务管理。

## 手动启动

```powershell
node vector\onnx\embed_server.mjs 16891
```

健康检查：

```powershell
curl http://127.0.0.1:16891/health
# {"status":"ok","model":"bge-small-zh-v1.5"}
```

## 体积

- 模型：约 96MB
- ONNX Runtime Node：安装后约 300MB
- 适合“零 Python、开箱即用”的发行版；如果更在意仓库体积，可继续用 `vector/embed_server.py` 或外部 16891。

模型与分词器来自 BAAI/bge-small-zh-v1.5（MIT/相应模型许可），ONNX Runtime 为 MIT。
