"""tap.py — 边录边分析：抓系统输出的环回，0.5 秒一块。

    py tap.py                     # 只听，Ctrl+C 收（能量层）
    py tap.py --ui                # 采集面板（WebView；没装 pywebview 回退 tkinter 浮窗）
    py tap.py --lyrics            # 能量层 + 边听边转写（约 540 MB 模型）
    py tap.py --json              # 输出 NDJSON，给上层 AI 读
    py tap.py --save              # 存下这段音频，事后可复算
    py tap.py --seconds 30        # 只听 30 秒（测试用）

只听系统正在放的声音（WASAPI loopback），不碰麦克风。
能量判断与 listener_lite.py 同一套；转写与 stream_lyrics.py 同一套。
"""
import json
import math
import os
import random
import sys
sys.dont_write_bytecode = True
import time
import threading
from pathlib import Path

import numpy as np

import listener_lite as L
import lyrics as LY
import present
import share as SH

_MUTEX = None


def _single_instance():
    """--ui 只允许一个实例；第二次启动把已有窗口提到前台。"""
    global _MUTEX
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.CreateMutexW.restype = ctypes.c_void_p
        _MUTEX = k32.CreateMutexW(None, False, "Local\\HexingMusicPanel")
        if k32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            hwnd = _find_panel()
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, 9)      # SW_RESTORE
                ctypes.windll.user32.SetForegroundWindow(hwnd)
            return False
    except Exception:
        return True
    return True


def _windows_titled(title, pid=None):
    """列出标题为 title 的可见顶层窗口，按面积从大到小。"""
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        out = []
        EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def cb(h, l):
            if not u.IsWindowVisible(h):
                return True
            n = u.GetWindowTextLengthW(h)
            if not n:
                return True
            b = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, b, n + 1)
            if b.value != title:
                return True
            if pid is not None:
                p = wintypes.DWORD()
                u.GetWindowThreadProcessId(h, ctypes.byref(p))
                if p.value != pid:
                    return True
            r = wintypes.RECT()
            u.GetWindowRect(h, ctypes.byref(r))
            out.append(((r.right - r.left) * (r.bottom - r.top), h))
            return True

        u.EnumWindows(EnumProc(cb), 0)
        out.sort(reverse=True)
        return [h for _, h in out]
    except Exception:
        return []


def _find_panel():
    hs = _windows_titled("音乐陪听")
    return hs[0] if hs else 0


def _hwnd():
    """本进程自己的面板窗口。别用 FindWindowW：会撞上同名的辅助窗口。"""
    import os
    hs = _windows_titled("音乐陪听", os.getpid())
    return hs[0] if hs else 0


def _write_last_share(share, elapsed=0.0):
    """歌尾分享卡落一个小 JSON，给 DSH 里的模型读；每次覆盖，只有最近一首。"""
    try:
        out = Path(__file__).with_name("share-last.json")
        tmp = out.with_name(".share-last.json.tmp")
        payload = {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "elapsed_s": round(float(elapsed or 0.0), 1),
            "share": share,
        }
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, out)
    except Exception:
        pass


_STATS_LOCK = threading.Lock()


def _bump_listen_count(song):
    """每产出一首歌尾，陪听计数 +1；面板自己写，DSH 没开也算。"""
    try:
        p = Path(__file__).with_name("listen-stats.json")
        with _STATS_LOCK:
            try:
                cur = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                cur = {}
            payload = {
                "count": int(cur.get("count") or 0) + 1,
                "last_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "last_song": (song or {}).get("title") or "",
                "last_artist": (song or {}).get("artist") or "",
            }
            tmp = p.with_name(".listen-stats.json.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            os.replace(tmp, p)
    except Exception:
        pass


def pick_loopback(force=None):
    """找默认输出设备对应的环回设备。

    必须精确匹配 "输出名 + ' [Loopback]'"。
    按前缀匹配会抓错：默认输出「耳机 (D88 Stereo)」，而蓝牙还挂着一个
    「耳机 (D88 Hands-Free AG Audio) [Loopback]」——16 kHz、根本不送数据，
    抓上去 read() 会一直阻塞。
    """
    import pyaudiowpatch as pyaudio

    p = pyaudio.PyAudio()
    try:
        info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        out = p.get_device_info_by_index(info["defaultOutputDevice"])
        cands = list(p.get_loopback_device_info_generator())
        if force is not None:
            for dev in cands:
                if int(dev["index"]) == int(force):
                    return p, dev
            raise RuntimeError(f"没有索引为 {force} 的环回设备")
        for dev in cands:
            if dev["name"] == out["name"] + " [Loopback]":
                return p, dev
        for dev in cands:
            if dev["name"].startswith(out["name"]):
                return p, dev
        listing = "\n".join(f"  {d['index']}  {d['name']}  {int(d['defaultSampleRate'])} Hz" for d in cands)
        raise RuntimeError(f"没找到 {out['name']} 的环回设备。可用的有：\n{listing}\n用 --device <索引> 指定")
    except Exception:
        p.terminate()
        raise


def main():
    if "--ui" in sys.argv and not _single_instance():
        return
    seconds = None
    if "--seconds" in sys.argv:
        seconds = float(sys.argv[sys.argv.index("--seconds") + 1])
    save = "--save" in sys.argv
    key_on = "--with-key" in sys.argv
    want_json = "--json" in sys.argv
    want_lyrics = "--lyrics" in sys.argv
    # 歌放完自动收：连续安静这么多秒就停（0 = 不自动停）。默认 12 秒。
    stop_silence = 12.0
    if "--no-stop" in sys.argv:
        stop_silence = 0.0
    if "--stop-silence" in sys.argv:
        stop_silence = float(sys.argv[sys.argv.index("--stop-silence") + 1])
    force = None
    if "--device" in sys.argv:
        force = int(sys.argv[sys.argv.index("--device") + 1])

    import pyaudiowpatch as pyaudio

    p, dev = pick_loopback(force)
    rate = int(dev["defaultSampleRate"])
    ch = max(1, int(dev["maxInputChannels"]))
    if not want_json:
        print(f"听：{dev['name']}  {rate} Hz  {ch} ch", flush=True)

    live = None
    if want_lyrics:
        import stream_lyrics as SL
        live = SL.Live(log=lambda m: print(m, file=sys.stderr, flush=True))

    block_raw = int(rate * L.BLOCK_S)          # 每块 0.5 秒（源采样率）
    stream = p.open(format=pyaudio.paFloat32,
                    channels=ch,
                    rate=rate,
                    input=True,
                    input_device_index=dev["index"],
                    frames_per_buffer=2048)

    import soxr

    lite = L.Lite(key_on=key_on, echo=not want_json)
    raw = np.zeros(0, dtype="float32")
    raw_l = np.zeros(0, dtype="float32")
    raw_r = np.zeros(0, dtype="float32")
    kept, cursor = [], 0
    import traceback
    import threading
    # pythonw / pyw 下 stdout/stderr 是 None；先兜住，免得 print 崩在 UI 里
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    state = {"fed": 0, "last_block": time.time(), "done": False,
             "peak": 0.0, "heard": 0.0, "silent": 0.0, "last_active": 0.0,
             "level": 0.0, "db": (-60.0, -60.0), "peak_db": -60.0, "event_n": 0, "last_event": "", "last_kind": "",
             "stop_requested": False, "review": [], "save": save,
             "song": None, "last_song_key": None, "song_started_at": 0.0, "lyric_entries": [], "lyric_data": None,
             "quote": "", "quote_at": 0.0, "quote_answer": "", "quote_answer_at": 0.0, "quote_turn": 0,
             "track_count": 0, "share": None, "wrapping": False,
             "kept_n": 0, "kept_drop": 0, "track_start_kept": None,
             "share_threads": [],
             "mode": "single", "random_next_at": 0.0, "random_count": 0,
             "started_at": 0.0, "paused": False, "paused_total": 0.0,
             "paused_since": 0.0, "elapsed": 0.0}
    t0 = time.time()
    ui_mode = "--ui" in sys.argv

    # --ui 优先用 WebView（需要 pywebview + WebView2）；没有就回退 tkinter。
    web_ui = False
    if ui_mode:
        try:
            import webview  # noqa: F401
            web_ui = True
        except Exception:
            web_ui = False

    # 命令行 / tkinter 回退：启动即开始；WebView 面板要点“开始采集”。
    if not web_ui:
        state["started_at"] = time.time()

    def elapsed_now():
        """会话时长，不含暂停。"""
        if not state["started_at"]:
            return 0.0
        base = time.time() - state["started_at"] - state["paused_total"]
        if state["paused"]:
            base -= time.time() - state["paused_since"]
        return max(0.0, base)

    presenter = present.Presenter(Path(__file__).with_name("quotes.json"))

    def current_lyric():
        song = state.get("song") or {}
        entries = state.get("lyric_entries") or []
        if not entries:
            return ""
        pos = song.get("position_s") or 0
        if not pos and state.get("song_started_at"):
            pos = max(0.0, time.time() - state["song_started_at"])
        cur = LY.line_at(entries, pos)
        return cur["text"] if cur else ""

    def drain():
        """把新事件按选定格式吐出去。"""
        nonlocal cursor
        if want_json:
            for e in lite.events[cursor:]:
                print(json.dumps({"layer": "energy", **e}, ensure_ascii=False), flush=True)
            cursor = len(lite.events)
        if live is not None:
            for t, text in live.poll():
                if want_json:
                    print(json.dumps({"layer": "lyrics", "t": t, "text": text},
                                     ensure_ascii=False), flush=True)
                else:
                    print(f"{int(t)//60}:{t%60:04.1f}  词 {text}", flush=True)

    def _track_audio(start_id, trim=0):
        """按 kept 的绝对块号切出一首；start_id 是这首开始时的 kept_n。"""
        if start_id is None or not kept:
            return None
        off = max(0, int(start_id) - int(state.get("kept_drop", 0)))
        blocks = kept[off:]
        if trim > 0 and len(blocks) > trim:
            blocks = blocks[:-trim]
        if not blocks:
            return None
        return np.concatenate(blocks)

    def _should_share():
        """单首：每首都给；随机：8–15 分钟随机间隔，最多 15 条反馈。"""
        if state.get("mode") != "random":
            return True
        if int(state.get("random_count", 0)) >= 15:
            return False
        now = time.time()
        if now < float(state.get("random_next_at", 0.0)):
            return False
        state["random_count"] = int(state.get("random_count", 0)) + 1
        state["random_next_at"] = now + random.uniform(8 * 60, 15 * 60)
        return True

    def _cut_track(start_id, song, trim=3):
        """换歌：把上一首切出来单独算分享，写 share-last.json。"""
        try:
            y = _track_audio(start_id, trim)
            if y is None or len(y) < L.SR * 15:
                return
            info = dict(song or {})
            # 陪听统计算所有歌；反馈是否投由模式决定
            _bump_listen_count(info)
            if not _should_share():
                return

            def job(a=y, info=info):
                try:
                    share = SH.build_share(
                        a, info.get("title") or "", info.get("artist") or "")
                    _write_last_share(share, len(a) / float(L.SR))
                except Exception:
                    traceback.print_exc()

            t = threading.Thread(target=job, daemon=True)
            state["share_threads"].append(t)
            t.start()
        except Exception:
            traceback.print_exc()

    def wrap_up():
        """收尾：算回顾、吐完事件、存文件。不退出——UI 还要把回顾显示出来。"""
        if state["done"]:
            return
        state["done"] = True
        # 自动收的时候末尾有一段静音；回顾用"最后有声"的时刻，不把静音算进歌长
        dur = state.get("last_active") or state.get("elapsed") or elapsed_now()
        if live is not None:
            for _ in range(60):                # 给最后一块转写留点时间
                time.sleep(0.1)
                if live.q.empty():
                    break
            time.sleep(0.3)
            drain()
        lite.finish(dur)
        drain()
        # 收尾后立刻释放缓冲：音频只在内存里，不落盘、不跨会话
        # 只算正在听的这一首；前面几首在换歌时已经单独切出去写过了
        audio = _track_audio(state.get("track_start_kept")) if kept else None
        if audio is None and kept:
            audio = np.concatenate(kept)
        kept.clear()
        state["review"] = list(lite.out_lines[-1:])
        if not state["review"]:
            state["review"] = ["这次先到这儿，想听的时候再喊我。"]
        state["quote"] = presenter.pick("review", current_lyric())
        # 歌尾分享卡：这首至少听了 10 秒才写，免得刚切歌就停把上一首盖掉
        if audio is not None and len(audio) >= L.SR * 10:
            song = state.get("song") or {}
            _bump_listen_count(song)
            if _should_share():
                def _share(a=audio, info=song):
                    try:
                        share = SH.build_share(
                            a, info.get("title") or "", info.get("artist") or "")
                        state["share"] = share
                        _write_last_share(share, len(a) / float(L.SR))
                    except Exception:
                        traceback.print_exc()

                t = threading.Thread(target=_share, daemon=True)
                state["share_thread"] = t
                state["share_threads"].append(t)
                t.start()
        if not want_json:
            print(f"\n--- 听了 {dur:.1f} 秒，即时 {len(lite.spoken)} 句 ---", flush=True)
        # 2026-11-14：研究版的 listen5/ 硬编码去掉了。默认不打文件；
        # --save 时把音频和这次的事件行一起写在当前目录。
        if state["save"] and audio is not None:
            import soundfile as sf
            out = Path(time.strftime("tap_%Y%m%d_%H%M%S.wav"))
            sf.write(str(out), audio, L.SR)
            out.with_suffix(".txt").write_text("\n".join(lite.out_lines) + "\n", encoding="utf-8")
            if not want_json:
                print(f"音频已存：{out}", flush=True)

    def finalize(code=0):
        """收尾并硬退出。

        不走 PortAudio 的 stop/close —— 采集被饿死时那一步会永久阻塞。
        资源交给系统回收，进程直接退。
        """
        wrap_up()
        # 等分享卡写完再退，否则用户一关面板，DSH 那边就读不到文件了
        deadline = time.time() + 10.0
        for t in list(state.get("share_threads") or []):
            left = deadline - time.time()
            if left <= 0:
                break
            if t.is_alive():
                t.join(timeout=left)
        os._exit(code)

    def request_stop(code=0):
        """非 UI：直接收；UI：交给窗口显示回顾后再退。"""
        if state["done"]:
            return
        if ui_mode and code == 0:
            state["stop_requested"] = True
        else:
            finalize(code)

    # 看门狗：设备卡住时 read() 不会返回，只能从外面收。
    # 歌放完时有两种情况：环回继续送静音（内层计数收），或 read 直接卡住
    # （块不再到达，只能靠这里看 last_block 的年龄）。
    def watchdog():
        last_warn = 0.0
        while True:
            time.sleep(1.0)
            now = time.time()
            active = bool(state["started_at"]) and not state["paused"] and not state["done"]
            if seconds and active and now - state["started_at"] >= seconds:
                request_stop()
            idle = now - state["last_block"]
            if stop_silence and active and state["heard"] >= 15 and idle >= stop_silence:
                if not want_json:
                    print(f"（安静了 {idle:.0f} 秒，先收）", file=sys.stderr, flush=True)
                request_stop()
            if active and idle > 10 and now - last_warn > 10:
                print("（十秒没有音频了，设备可能停了）", file=sys.stderr, flush=True)
                last_warn = now

    def capture_loop():
        """采集 + 判断。跑在后台线程，UI 在主线程。"""
        nonlocal raw, raw_l, raw_r
        code = 0
        try:
            while True:
                chunk = stream.read(2048, exception_on_overflow=False)
                a = np.frombuffer(chunk, dtype="float32")
                if ch > 1:
                    m = a.reshape(-1, ch)
                    raw_l = np.concatenate([raw_l, m[:, 0]])
                    raw_r = np.concatenate([raw_r, m[:, 1]])
                    clv = float(np.sqrt(np.mean(m[:, 0] ** 2)) + 1e-9)
                    crv = float(np.sqrt(np.mean(m[:, 1] ** 2)) + 1e-9)
                    a = m.mean(axis=1)
                else:
                    raw_l = np.concatenate([raw_l, a])
                    raw_r = np.concatenate([raw_r, a])
                    clv = crv = float(np.sqrt(np.mean(a ** 2)) + 1e-9)
                raw = np.concatenate([raw, a])

                # 电平按 46ms 一块走；灵敏度用会话峰值归一化（见前端 dbToPct）
                if state["started_at"] and not state["paused"] and not state["done"]:
                    dl = 20 * math.log10(clv)
                    dr = 20 * math.log10(crv)
                    state["db"] = (dl, dr)
                    state["level"] = (clv + crv) / 2
                    state["peak_db"] = max(state.get("peak_db", -60.0), dl, dr)
                else:
                    state["db"] = (-60.0, -60.0)
                    state["level"] = 0.0

                auto_stopped = False
                while len(raw) >= block_raw:
                    seg, raw = raw[:block_raw], raw[block_raw:]
                    seg_l, raw_l = raw_l[:block_raw], raw_l[block_raw:]
                    seg_r, raw_r = raw_r[:block_raw], raw_r[block_raw:]
                    y = soxr.resample(seg, rate, L.SR).astype("float32")
                    state["fed"] += 1
                    state["last_block"] = time.time()

                    # 还没开始 / 暂停：不喂判断层
                    if not state["started_at"] or state["paused"] or state["done"]:
                        continue

                    t = elapsed_now()
                    lite.feed(y, t)
                    if len(lite.events) > state["event_n"]:
                        ev = lite.events[-1]
                        state["last_event"] = ev["text"]
                        state["last_kind"] = ev.get("kind") or ""
                        state["event_n"] = len(lite.events)
                        state["quote"] = presenter.pick(state["last_kind"], current_lyric())
                        state["quote_at"] = time.time()
                        state["quote_answer"] = ""
                        state["quote_answer_at"] = 0.0
                    if live is not None:
                        live.feed(y)
                    # 不管存不存盘，都留一份用于歌尾分析；最多 10 分钟
                    kept.append(y)
                    state["kept_n"] += 1
                    if len(kept) > 1200:
                        drop = len(kept) - 1200
                        del kept[:drop]
                        state["kept_drop"] += drop
                    drain()

                    # 歌放完自动收：连续安静 N 秒就停。
                    # 先用相对门限（会话峰值的 3%，最低 -66 dBFS）判"有没有声音"；
                    # 听到过 15 秒才允许自动停，避免前奏静音时误收。
                    blk_s = len(y) / L.SR
                    rms_now = float(np.sqrt(np.mean(y ** 2)) + 1e-9)
                    state["level"] = rms_now
                    state["peak"] = max(state["peak"], rms_now)
                    thr = max(0.0005, state["peak"] * 0.03)
                    if rms_now >= thr:
                        state["heard"] += blk_s
                        state["silent"] = 0.0
                        state["last_active"] = t
                    else:
                        state["silent"] += blk_s
                    if stop_silence and state["heard"] >= 15 and state["silent"] >= stop_silence:
                        if not want_json:
                            print(f"（安静了 {state['silent']:.0f} 秒，先收）",
                                  file=sys.stderr, flush=True)
                        auto_stopped = True
                        break

                if auto_stopped:
                    break
        except KeyboardInterrupt:
            pass
        except BaseException:
            traceback.print_exc()
            code = 1
        request_stop(code)

    def song_watch():
        """每 1.5 秒：换歌查歌词；没事件时轮语录（不依赖 SMTC）。"""
        while True:
            time.sleep(1.5)
            try:
                if not state["started_at"] or state["done"]:
                    continue
                now = time.time()
                # 先兑现上一道脑筋急转弯的答案
                if state.get("quote_answer_at") and now >= state["quote_answer_at"]:
                    state["quote"] = "答案：" + state["quote_answer"]
                    state["quote_answer"] = ""
                    state["quote_answer_at"] = 0.0
                    state["quote_at"] = now
                # 18 秒换一句：每 5 次一条笑话/急转弯，每 2 次一句暖心话
                if now - state.get("quote_at", 0) > 18:
                    state["quote_turn"] = state.get("quote_turn", 0) + 1
                    turn = state["quote_turn"]
                    fun = presenter.pick_fun() if turn % 5 == 0 else None
                    if fun:
                        state["quote"] = fun["text"]
                        if fun["answer"]:
                            state["quote_answer"] = fun["answer"]
                            state["quote_answer_at"] = now + 12
                    elif turn % 2 == 0:
                        state["quote"] = presenter.pick("warm")
                    else:
                        state["quote"] = presenter.pick("quiet", current_lyric())
                    state["quote_at"] = now

                song = LY.current_song()
                if not song or not song.get("title"):
                    continue
                key = (song["title"], song["artist"])
                prev_key = state.get("last_song_key")
                if key == prev_key:
                    continue
                # 网易云不会在歌与歌之间停；换歌就是上一首的结尾
                prev_song = state.get("song") or {}
                prev_start = state.get("track_start_kept")
                changed = prev_key is not None
                if changed and prev_start is not None:
                    _cut_track(prev_start, prev_song)
                state["last_song_key"] = key
                state["song"] = song
                state["song_started_at"] = time.time()
                state["track_start_kept"] = state["kept_n"]
                state["track_count"] = state.get("track_count", 0) + 1
                # 单首模式：听到下一次换歌就收（第一次认出歌不算换歌）
                if ui_mode and changed and state.get("mode") == "single":
                    request_stop()

                def load(s=song):
                    data = LY.fetch_lrc(s["title"], s["artist"], s.get("duration_s"))
                    state["lyric_data"] = data
                    state["lyric_entries"] = LY.parse_lrc(data["synced"]) if data else []

                threading.Thread(target=load, daemon=True).start()
            except Exception:
                pass

    def run_ui():
        """小浮窗：无边框 HUD，置顶、可拖、带实时电平条和一个停止键。"""
        import tkinter as tk

        W, H = 360, 168
        BG, LINE = "#0b0f16", "#223047"
        TXT, MUTED, DIM = "#e7ecf5", "#8b96aa", "#5b6678"
        MINT, GOLD = "#63e6a6", "#e7b86a"

        def mix(c1, c2, t):
            a = tuple(int(c1[i:i + 2], 16) for i in (1, 3, 5))
            b = tuple(int(c2[i:i + 2], 16) for i in (1, 3, 5))
            return "#%02x%02x%02x" % tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

        root = tk.Tk()
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        try:
            root.attributes("-alpha", 0.985)
        except Exception:
            pass
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f"{W}x{H}+{max(0, sw - W - 28)}+{max(0, sh - H - 80)}")
        cv = tk.Canvas(root, width=W, height=H, bg=BG, highlightthickness=0, bd=0)
        cv.pack()

        # 背景 + 1px 边框（同时负责拖动）
        cv.create_rectangle(0, 0, W - 1, H - 1, fill=BG, outline=LINE, tags="drag")
        # 顶部一条很淡的强调线
        cv.create_line(1, 1, W - 2, 1, fill="#1b4a3a", tags="drag")

        dot = cv.create_oval(18, 20, 26, 28, fill=MINT, outline="", tags="drag")
        head = cv.create_text(34, 24, text="正在听歌", fill=TXT, anchor="w",
                              font=("Microsoft YaHei UI", 10, "bold"), tags="drag")
        timer = cv.create_text(W - 18, 24, text="00:00", fill="#9aa4b8", anchor="e",
                               font=("Consolas", 12), tags="drag")

        # 电平条（最近 32 个采样的历史，看起来像一条滚动的波形）
        NB, BW, GAP, BASE, HMAX = 32, 5, 3, 96, 38
        X0 = (W - (NB * (BW + GAP) - GAP)) // 2
        bars = []
        for i in range(NB):
            x = X0 + i * (BW + GAP)
            bars.append(cv.create_rectangle(x, BASE, x + BW, BASE, fill="#16352a", outline=""))

        last = cv.create_text(18, 112, text="最近：—", fill="#c3cbdb", anchor="w",
                              font=("Microsoft YaHei UI", 9), tags="drag")
        hint = cv.create_text(18, 130, text="", fill=GOLD, anchor="w",
                              font=("Microsoft YaHei UI", 8), tags="drag")
        devt = cv.create_text(18, 148, text=str(dev["name"])[:34], fill=DIM, anchor="w",
                              font=("Microsoft YaHei UI", 7), tags="drag")

        # 圆角胶囊按钮
        def pill_shape(x1, y1, x2, y2, r, **kw):
            pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2,
                   x2 - r, y2, x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
            return cv.create_polygon(pts, smooth=True, **kw)

        py1, py2 = 118, 150
        pill = pill_shape(W - 96, py1, W - 18, py2, 12, fill="#17202e", outline="", tags="pill")
        pill_t = cv.create_text(W - 57, (py1 + py2) // 2, text="停止", fill="#dfe6f2",
                                font=("Microsoft YaHei UI", 9), tags="pill")

        drag = {}

        def on_press(e):
            drag["x"], drag["y"] = e.x, e.y

        def on_move(e):
            if "x" not in drag:
                return
            root.geometry(f"+{root.winfo_x() + e.x - drag['x']}+{root.winfo_y() + e.y - drag['y']}")

        cv.tag_bind("drag", "<Button-1>", on_press)
        cv.tag_bind("drag", "<B1-Motion>", on_move)

        def hard_exit():
            os._exit(0)

        def stop_ui():
            if state["done"]:
                hard_exit()
                return
            wrap_up()
            cv.itemconfig(dot, fill=GOLD)
            cv.itemconfig(head, text="已停止", fill=GOLD)
            for b in bars:
                cv.coords(b, 0, 0, 0, 0)
            cv.itemconfig(last, text="\n".join(state.get("review") or ["（没有可回顾的内容）"]),
                          fill="#cfd6e4", width=W - 36, anchor="nw")
            cv.coords(last, 18, 54)
            cv.itemconfig(hint, text=f"共听了 {int(time.time() - t0)} 秒", fill=MUTED)
            cv.itemconfig(pill_t, text="关闭")

        def on_pill(_e=None):
            if state["done"]:
                hard_exit()
            else:
                stop_ui()

        for item in (pill, pill_t):
            cv.tag_bind(item, "<Button-1>", on_pill)
            cv.tag_bind(item, "<Enter>", lambda e: (
                cv.itemconfig(pill, fill="#1c2a26"), cv.itemconfig(pill_t, fill=MINT)))
            cv.tag_bind(item, "<Leave>", lambda e: (
                cv.itemconfig(pill, fill="#17202e"), cv.itemconfig(pill_t, fill="#dfe6f2")))

        levels = [0.0] * NB
        flash_until = 0.0
        last_n = 0

        def tick():
            nonlocal flash_until, last_n
            if state["done"]:
                return
            if state["stop_requested"]:
                stop_ui()
                return
            now = time.time()
            el = now - t0
            cv.itemconfig(timer, text=f"{int(el) // 60:02d}:{int(el) % 60:02d}")

            if state["event_n"] != last_n:
                flash_until = now + 1.0
            cv.itemconfig(dot, fill=GOLD if now < flash_until else MINT)
            cv.itemconfig(head, text="正在听歌", fill=TXT)
            cv.itemconfig(last, text="最近：" + (state.get("last_event") or "—"),
                          fill="#c3cbdb", width=0, anchor="w")
            cv.coords(last, 18, 112)

            quiet = max(state["silent"], now - state["last_block"])
            if state["heard"] >= 15 and stop_silence and quiet >= 3:
                cv.itemconfig(hint, text=f"安静 {min(quiet, stop_silence):.0f}/{stop_silence:.0f} 秒，准备收尾")
            else:
                cv.itemconfig(hint, text="")

            peak = max(state.get("peak", 0.0), 0.01)
            lvl = state.get("level", 0.0)
            norm = min(1.0, (lvl / peak) ** 0.5) if lvl > 0 else 0.0
            levels.append(max(norm, levels[-1] * 0.75))
            levels.pop(0)
            for i, b in enumerate(bars):
                h = max(2, int(levels[i] * HMAX))
                x = X0 + i * (BW + GAP)
                cv.coords(b, x, BASE - h, x + BW, BASE)
                cv.itemconfig(b, fill=mix("#16352a", MINT, 0.25 + 0.75 * levels[i]))
            root.after(120, tick)

        tick()
        root.mainloop()

    class WebApi:
        """给 WebView 页面用的桥。JS 每 120ms 拉一次 state。"""

        _win = None
        _mini = False
        _collapsed = False
        _expanded_h = 353
        _mini_pos = None
        _precollapse = None

        def state(self):
            # 自动收（静音/--seconds）在 webview 模式下由这里落地
            if state["stop_requested"] and not state["done"] and not state.get("wrapping"):
                state["wrapping"] = True
                state["elapsed"] = elapsed_now()
                threading.Thread(target=wrap_up, daemon=True).start()
            done = bool(state["done"])
            song = state.get("song") or {}
            entries = state.get("lyric_entries") or []
            pos = song.get("position_s") or 0
            if not pos and state.get("song_started_at"):
                pos = max(0.0, time.time() - state["song_started_at"])
            cur = LY.line_at(entries, pos) if entries else None
            nxt = None
            if cur is not None:
                for e in entries:
                    if e["t"] > cur["t"]:
                        nxt = e
                        break
            return {
                "started": bool(state["started_at"]),
                "paused": bool(state["paused"]),
                "mode": state.get("mode") or "single",
                "randomCount": int(state.get("random_count") or 0),
                "done": done,
                "elapsed": state["elapsed"] if done else elapsed_now(),
                "dbL": round(float(state["db"][0]), 1),
                "dbR": round(float(state["db"][1]), 1),
                "peakDb": round(float(state.get("peak_db", -60.0)), 1),
                "rate": int(rate),
                "format": "32-bit float",
                "device": str(dev["name"]),
                "save": bool(state["save"]),
                "review": list(state.get("review") or []),
                "last": state.get("last_event") or "",
                "lastKind": state.get("last_kind") or "",
                "songTitle": song.get("title") or "",
                "songArtist": song.get("artist") or "",
                "lyric": cur["text"] if cur else "",
                "lyricNext": nxt["text"] if nxt else "",
                "quote": state.get("quote") or "",
                "share": state.get("share"),
            }

        def start(self, mode="single"):
            mode = "random" if str(mode).lower() == "random" else "single"
            if state["done"]:
                # 新一局：面板不关，只把上一局的缓冲/状态清掉
                kept.clear()
                state.update({
                    "done": False, "wrapping": False, "stop_requested": False,
                    "elapsed": 0.0, "paused": False, "paused_since": 0.0,
                    "paused_total": 0.0, "started_at": time.time(),
                    "kept_n": 0, "kept_drop": 0, "track_start_kept": None,
                    "track_count": 0, "song": None, "last_song_key": None,
                    "song_started_at": 0.0, "lyric_entries": [], "lyric_data": None,
                    "share": None, "review": [], "peak_db": -60.0,
                    "peak": 0.0, "heard": 0.0, "silent": 0.0,
                    "last_active": 0.0, "level": 0.0, "db": (-60.0, -60.0),
                    "event_n": len(lite.events), "last_event": "", "last_kind": "",
                    "last_block": time.time(),
                })
            state["mode"] = mode
            state["random_count"] = 0
            state["random_next_at"] = (
                time.time() + random.uniform(8 * 60, 15 * 60)
                if mode == "random" else 0.0
            )
            if not state["started_at"]:
                state["started_at"] = time.time()
            if state["paused"]:
                state["paused_total"] += time.time() - state["paused_since"]
                state["paused"] = False
            state["peak_db"] = -60.0
            state["quote"] = presenter.pick("start", current_lyric())
            state["quote_at"] = time.time()
            state["quote_answer"] = ""
            state["quote_answer_at"] = 0.0
            state["quote_turn"] = 0
            return True

        def set_mode(self, mode="single"):
            """正在陪听时切换「这首 / 随机」，不打断采集。"""
            if state["done"] or not state["started_at"]:
                return False
            mode = "random" if str(mode).lower() == "random" else "single"
            if state.get("mode") == mode:
                return True
            state["mode"] = mode
            state["random_count"] = 0
            state["random_next_at"] = (
                time.time() + random.uniform(8 * 60, 15 * 60)
                if mode == "random" else 0.0
            )
            state["quote"] = presenter.pick("start", current_lyric())
            state["quote_at"] = time.time()
            state["quote_answer"] = ""
            state["quote_answer_at"] = 0.0
            return True

        def pause(self):
            if not state["started_at"] or state["done"]:
                return False
            if state["paused"]:
                state["paused_total"] += time.time() - state["paused_since"]
                state["paused"] = False
            else:
                state["paused_since"] = time.time()
                state["paused"] = True
            return True

        def stop(self):
            if state["done"] or not state["started_at"]:
                return False
            state["elapsed"] = elapsed_now()
            wrap_up()
            return True

        def toggle_save(self):
            state["save"] = not state["save"]
            return state["save"]

        def _win_pos(self):
            try:
                import ctypes
                from ctypes import wintypes
                hwnd = _hwnd()
                r = wintypes.RECT()
                ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(r))
                return int(r.left), int(r.top)
            except Exception:
                return (int(getattr(self._win, "x", 0) or 0),
                        int(getattr(self._win, "y", 0) or 0))

        def _fit(self, w, h, x, y):
            """只改窗口大小和位置。圆角交给 CSS，不再碰 region。"""
            self._win.resize(int(w), int(h))
            self._win.move(int(x), int(y))

        def fit_height(self, h=353):
            """语录长了就把窗口加高一点；收起/小窗时只记下来。"""
            try:
                h = max(340, min(420, int(h)))
                self._expanded_h = h
                if self._win is None or self._mini or self._collapsed:
                    return False
                import webview
                scr = webview.screens[0]
                x, y = self._win_pos()
                y = max(scr.y, min(int(y), scr.y + scr.height - h))
                self._fit(540, h, x, y)
                return True
            except Exception:
                return False

        def compact(self, on=True):
            """小窗：420x280，办公时不挡。"""
            try:
                import webview
                if self._win is None:
                    return False
                scr = webview.screens[0]
                self._mini = bool(on)
                if on:
                    self._mini_pos = self._win_pos()
                    w, h = 420, 280
                    x, y = self._mini_pos
                else:
                    w, h = 540, self._expanded_h
                    x, y = self._win_pos()
                x = max(scr.x, min(int(x), scr.x + scr.width - w))
                y = max(scr.y, min(int(y), scr.y + scr.height - h))
                self._fit(w, h, x, y)
                return True
            except Exception:
                return False

        def collapse(self, on=True):
            """收起成桌面语录条 / 展开回面板或小窗。"""
            try:
                import webview
                if self._win is None:
                    return False
                scr = webview.screens[0]
                if on:
                    self._collapsed = True
                    self._precollapse = (self._win_pos(), bool(self._mini))
                    w, h = 520, 88
                    x = int(scr.x + (scr.width - w) / 2)
                    y = int(scr.y + scr.height - 237)
                else:
                    self._collapsed = False
                    if self._mini:
                        w, h = 420, 280
                    else:
                        w, h = 540, self._expanded_h
                    pos = self._precollapse
                    if pos:
                        (px, py), self._mini = pos
                        x, y = px, py
                    else:
                        x = int(scr.x + (scr.width - w) / 2)
                        y = int(scr.y + (scr.height - h) / 2)
                    x = max(scr.x, min(int(x), scr.x + scr.width - w))
                    y = max(scr.y, min(int(y), scr.y + scr.height - h))
                self._fit(w, h, x, y)
                return True
            except Exception:
                return False

        def close(self):
            if not state["done"]:
                state["elapsed"] = elapsed_now()
                wrap_up()
            deadline = time.time() + 10.0
            for t in list(state.get("share_threads") or []):
                left = deadline - time.time()
                if left <= 0:
                    break
                if t.is_alive():
                    t.join(timeout=left)
            os._exit(0)

    def run_webview():
        import webview
        webview.settings["DRAG_REGION_SELECTOR"] = ".drag-region"
        webview.settings["DRAG_REGION_DIRECT_TARGET_ONLY"] = True
        page = Path(__file__).with_name("ui") / "panel.html"
        W, H = 556, 392
        scr = webview.screens[0]
        x = max(0, int(scr.x + (scr.width - W) / 2))
        y = max(0, int(scr.y + (scr.height - H) / 2))
        api = WebApi()
        win = webview.create_window(
            "音乐陪听", url=page.resolve().as_uri(),
            width=W, height=H, x=x, y=y,
            resizable=False, frameless=True, transparent=True,
            easy_drag=False, on_top=True,
            js_api=api,
        )
        api._win = win
        try:
            from System.Drawing import Color
            win.native.BackColor = Color.FromArgb(11, 15, 22)
        except Exception:
            pass
        # 圆角由页面 CSS 画，窗口只保留透明底；不再从后台线程动 region
        if "--autostart" in sys.argv:
            def _kick():
                time.sleep(1.2)
                try:
                    win.evaluate_js("document.getElementById('mainBtn').click()")
                except Exception:
                    pass
            threading.Thread(target=_kick, daemon=True).start()
        webview.start()
        os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=song_watch, daemon=True).start()

    if web_ui:
        try:
            run_webview()
        except Exception:
            traceback.print_exc()
            if not want_json:
                print("（WebView 起不来，回退小浮窗）", file=sys.stderr, flush=True)
            if not state["started_at"]:
                state["started_at"] = time.time()
            run_ui()
    elif ui_mode:
        run_ui()
    else:
        try:
            while True:
                time.sleep(1.0)
        except KeyboardInterrupt:
            if not want_json:
                print("\n（收）", flush=True)
            finalize(0)


if __name__ == "__main__":
    main()