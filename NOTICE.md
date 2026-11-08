# 核星记忆 / Hexing Memory — 第三方组件

项目署名：**核星记忆 / Hexing Memory by 夜屿声**  
项目主页：https://github.com/a839124348/hexing-memory  
本项目自身代码：MIT，见 `LICENSE`；署名说明见 `AUTHORS.md`。

## 随仓库/随发行版

| 组件 | 版本 | 许可 | 位置 |
|:--|:--|:--|:--|
| Three.js | r180 | MIT | `dsh-plugin/src/vendor/three.module.min.js` + `THREE-LICENSE.txt` |
| ONNX Runtime Node | 1.31.1 | MIT | 由 `vector/onnx/install.ps1` 安装 |
| @huggingface/tokenizers | 0.2.0 | Apache-2.0 | 由 `vector/onnx/install.ps1` 安装 |
| BAAI/bge-small-zh-v1.5 | — | 见上游模型卡 | ONNX/Python 向量服务使用 |

## Python 随包服务（可选）

| 组件 | 许可 | 说明 |
|:--|:--|:--|
| sentence-transformers | Apache-2.0 | 由 `vector/install.ps1` 安装 |
| PyTorch / Transformers | BSD/Apache-2.0 | 随 sentence-transformers 环境 |

发布前请以各上游仓库的最新 LICENSE 为准；模型权重单独分发时也要保留上游模型卡的许可与署名。
