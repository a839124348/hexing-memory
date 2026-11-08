# 随包向量服务

这是记忆系统自带的本地语义向量服务，不再依赖星核引擎的 16891。  
模型默认 `BAAI/bge-small-zh-v1.5`（512 维），只在本机 `127.0.0.1` 监听。

## 一次性安装（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File .\vector\install.ps1
```

脚本会：

1. 找 Python 3；
2. `pip install -r vector/requirements.txt`；
3. 预下载/校验 bge 模型；
4. 写 `vector/.ready`。

之后插件启动时如果 16891 没有现成服务，会自动拉起 `vector/embed_server.py`，DSH 关闭时一起退出。

## 手动启动

```powershell
python vector/embed_server.py 16891
```

离线部署时：

```powershell
$env:BGE_MODEL_PATH = "D:\models\bge-small-zh-v1.5"
$env:HF_HUB_OFFLINE = "1"
python vector/embed_server.py 16891
```

插件侧也可以显式指定：

```powershell
$env:MEMORY_EMBED_CMD = 'python D:\...\vector\embed_server.py 16891'
```

## 健康检查

```powershell
curl http://127.0.0.1:16891/health
```

返回 `{"status":"ok","model":"bge-small-zh-v1.5"}` 即可。模型/依赖缺失时返回 503，检索自动降级关键词并标 `degraded`，不会产伪向量。
