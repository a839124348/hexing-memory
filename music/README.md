# music/ — AI 听音乐（lite）

给模型用的音乐测量工具：它不"听懂"，只测能量形状、峰值、结尾、BPM。
怎么把测量写成话，看 `MANUAL.md` 第二部分（词表、结构、14 条自检）。

**核心玩法是边录边分析**：用户放歌，工具抓系统输出的 WASAPI 环回，按 0.5 秒一块判断，
只在“变化”处吐一句。不碰麦克风，不上传音频。

## 文件

| 文件 | 作用 |
|:--|:--|
| `tap.py` | **边录边分析**：抓系统输出，`--json` 输出 NDJSON 给上层读 |
| `listener_lite.py` | 判断层（能量/密度/调性）；也可从文件回放 |
| `lyrics.py` | 识别当前歌曲 + 联网查同步歌词（LRCLIB） |
| `share.py` | 歌尾分享卡：初印象 / 想象 / 依据 / 歌词材料 |
| `ui/panel.html` | `--ui` 的陪听面板（WebView 渲染） |
| `listen.py` | 一首歌 → 测量 JSON（`--brief` 省 token） |
| `MANUAL.md` | 唯一说明书：调用 / 写作 / 操作 |

## 依赖

- Python 3.10+
- `pip install numpy soundfile soxr pyaudiowpatch`
- 想识别当前歌曲、查歌词：`pip install winrt-Windows.Media.Control`（约 1 MB）
- 想要陪听面板（`--ui`）再加：`pip install pywebview`
  - 它需要系统有 **WebView2 运行时**；Win11 自带，Win10 装过 Edge 的通常也有
  - 没有 pywebview 时 `--ui` 自动回退到 tkinter 小浮窗
- m4a / 视频另需系统里有 `ffmpeg`（`soundfile` 读不了时自动调用）

Windows 用 `py`，Linux/macOS 用 `python3`。

## 跑

边录边分析（主路径）：

```bash
py tap.py                 # 听系统正在放的声音，Ctrl+C 收；连续安静 12 秒自动收
py tap.py --ui            # 陪听面板（WebView；没有 pywebview 时回退 tkinter 浮窗）
py tap.py --json          # NDJSON，一行一个事件
py lyrics.py              # 当前歌曲 + 当前歌词行
py lyrics.py --lookup "晴天" "周杰伦" 270   # 手动查一首
py share.py song.mp3 --title "晴天" --artist "周杰伦"   # 一首歌的分享卡
py tap.py --stop-silence 20  # 静音多少秒算“歌放完”（默认 12）
py tap.py --no-stop       # 不自动收，只听 Ctrl+C
py tap.py --seconds 30    # 只听 30 秒
py tap.py --save          # 同时存音频和事件行到当前目录
```

想要“没有黑窗口”的小浮窗，用 `pyw` 启动：

```bash
pyw tap.py --ui
```

只允许一个实例：重复启动会直接退出，并把已有窗口提到前台。

也可以在 DSH 里让模型调 `memory_music(open)`：插件拉起面板并把歌尾绑到当前会话；开始陪听还是你自己点。

主圆按钮显示当前模式（「陪听这首」/「兴趣陪听」），点它开始；音频源旁的「切换」按钮切换模式。陪听这首只听当前这首，换歌就收；兴趣陪听是歌单模式，隔 8–15 分钟随机回一首，最多 15 条反馈，不每首都回。两种可以随时切换，关闭用右上角 ×。

面板默认 540×353；语录换成两三行时会临时加高（最多到 392），短句再落回来。

面板右上角 `小窗` 可以缩成 420×280，办公时不挡；再点 `还原` 回去。

`▾` 可以收起：只剩一条透明语录在桌面底部，点它展开回原来的大小和位置；歌听完不会自己弹回大窗。

歌尾分享卡会写一份到 `music/share-last.json`（每次覆盖，只有最近一首）；让模型 `memory_music(open)` 或 `bind` 绑到要聊的会话后，插件才会把歌尾投过去（全歌延迟；插件要重启才生效）。没绑定就不投，不会猜“最近活跃”的会话；模型也可以直接读这个文件。音频和其余歌词仍只在内存，退出即清。

文件模式（演练/复算）：

```bash
py listen.py song.mp3 --brief
py listener_lite.py song.mp3 --fast
```

`tap.py --json` 的输出：

```json
{"layer": "energy", "t": 11.2, "kind": "dense", "text": "密起来了"}
{"layer": "energy", "t": 62.0, "kind": "review", "text": "（回顾）刚才最响的是这一段，…"}
```

## 边界

- **不随仓库分发任何音频**；示例、语料、转写缓存都在自己机器上。
- 不做 DRM 解密、不代下载音乐。
- 调性默认不报（lite 与 CQT 只有 60% 一致）；要调性走完整版。
- 不猜真实地点；峰值并列时不报位置。详见 `MANUAL.md` 三条铁律。
- 听不足 60 秒不下回顾，只说“太短”。

## 接入状态

还没接进 DSH（没有 `memory_*` 工具）。现在 `tap.py --json` 是给上层的接口，
由模型或插件读 NDJSON；怎么把事件投进会话还没定。
