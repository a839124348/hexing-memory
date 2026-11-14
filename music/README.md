# music/ — AI 听音乐（lite）

给模型用的音乐测量工具：它不"听懂"，只测能量形状、峰值、结尾、BPM。
怎么把测量写成话，看 `MANUAL.md` 第二部分（词表、结构、14 条自检）。

## 文件

| 文件 | 作用 |
|:--|:--|
| `listen.py` | 一首歌 → 测量 JSON（`--brief` 省 token） |
| `listener_lite.py` | 实时陪听：按真实时间轴逐句输出 |
| `MANUAL.md` | 唯一说明书：调用 / 写作 / 操作 |

## 依赖

- Python 3.10+
- `pip install numpy soundfile soxr`
- m4a / 视频另需系统里有 `ffmpeg`（`soundfile` 读不了时自动调用）

Windows 用 `py`，Linux/macOS 用 `python3`。

## 跑

```bash
py listen.py song.mp3 --pretty
py listen.py song.mp3 --brief
py listener_lite.py song.mp3 --fast
```

## 边界

- **不随仓库分发任何音频**；示例、语料、转写缓存都在自己机器上。
- 不做 DRM 解密、不代下载音乐。
- 调性默认不报（lite 与 CQT 只有 60% 一致）；要调性走完整版。
- 不猜真实地点；峰值并列时不报位置。详见 `MANUAL.md` 三条铁律。

## 接入状态

还没接进 DSH（没有 `memory_*` 工具）。目前是独立 CLI，由模型按 `MANUAL.md` 调用。
