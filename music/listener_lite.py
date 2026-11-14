"""listener_lite.py — 精简版实时陪听：不依赖 librosa（省约 265MB）。

只用到四样：重采样、STFT、chroma、频谱通量 —— 全部用 numpy 手写。
依赖：numpy + soundfile + soxr（+ 可选 pyaudiowpatch 做实时录音）。

事件逻辑与 listener.py 完全一致，方便逐行对比。
"""
import sys
import time

import numpy as np

SR, HOP, N_FFT = 22050, 512, 2048
BLOCK_S = 0.5
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def load(path):
    import soundfile as sf
    try:
        y, sr = sf.read(path, dtype="float32", always_2d=False)
        if y.ndim > 1:
            y = y.mean(axis=1)
    except Exception:  # noqa: BLE001  —— mp3/m4a 走 ffmpeg
        import subprocess
        import tempfile
        import os
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
                        "-vn", "-ac", "1", "-ar", str(SR), "-y", wav], check=True,
                       capture_output=True)
        y, sr = sf.read(wav, dtype="float32")
        os.remove(wav)
    if sr != SR:
        import soxr
        y = soxr.resample(y.astype("float32"), sr, SR).astype("float32")
    return y


def stft_mag(y):
    win = np.hanning(N_FFT).astype("float32")
    n = 1 + (len(y) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    return np.abs(np.fft.rfft(y[idx] * win, axis=1)).T.astype("float32")   # (freq, time)


def chroma_of(spec):
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    mask = freqs > 40
    midi = 69 + 12 * np.log2(np.maximum(freqs[mask], 1e-9) / 440.0)
    pcs = np.mod(np.round(midi).astype(int), 12)
    out = np.zeros((12, spec.shape[1]), dtype="float32")
    S = spec[mask]
    for k in range(12):
        out[k] = S[pcs == k].sum(axis=0)
    out /= (out.sum(axis=0, keepdims=True) + 1e-9)
    return out


def key_of(chroma_vec):
    best = (-1.0, "major")
    for i in range(12):
        for nm, prof in (("major", MAJOR), ("minor", MINOR)):
            r = float(np.corrcoef(np.roll(prof, i), chroma_vec)[0, 1])
            if r > best[0]:
                best = (r, nm)
    return best[1], best[0]


def main():
    path = sys.argv[1]
    fast = "--fast" in sys.argv
    key_on = "--with-key" in sys.argv
    y = load(path)
    dur = len(y) / SR
    frame = HOP / SR
    blk = int(BLOCK_S * SR)

    buf = np.zeros(0)
    rms_hist, onset_hist = [], []
    spoken, last_say = [], -999.0
    type_last, type_count = {}, {}
    last_mode, mode_pending, mode_since, mode_hist = None, None, 0.0, []
    peak_so_far, peak_t = 0.0, 0.0
    prev_cents, prev_rms = [], []
    gap_t, mute_until = -99.0, -1.0
    out_lines, t0 = [], time.time()
    cooldown, max_lines = 20.0, 6

    def say(t, text, kind):
        nonlocal last_say
        if t < mute_until or t - last_say < cooldown or len(spoken) >= max_lines:
            return
        if t - type_last.get(kind, -999.0) < 60 or type_count.get(kind, 0) >= 2:
            return
        type_last[kind] = t
        type_count[kind] = type_count.get(kind, 0) + 1
        spoken.append((t, text))
        last_say = t
        line = f"{int(t)//60}:{t%60:04.1f}  {text}"
        out_lines.append(line)
        print(line, flush=True)

    for i in range(0, len(y) - blk, blk):
        buf = np.concatenate([buf, y[i:i + blk]])[-int(8 * SR):]
        t = (i + blk) / SR

        w2 = buf[-int(2 * SR):]
        rms = float(np.sqrt(np.mean(w2 ** 2)) + 1e-9)
        rms_hist.append(rms)
        base = float(np.median(rms_hist[-40:])) + 1e-9

        # 断源：先静音断口，再"由静到响"
        if rms < base * 0.08:
            gap_t = t
        sp2 = stft_mag(w2)
        freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
        cent = float(np.sum(freqs[:, None] * sp2) / (np.sum(sp2) + 1e-9))
        if prev_rms:
            br = float(np.median(prev_rms[-8:])) + 1e-9
            bc = float(np.median(prev_cents[-8:])) + 1e-9
            if (t - gap_t) < 1.5 and rms > br * 3 and t - mute_until > 30:
                mute_until = t + 10.0
                rms_hist.clear(); onset_hist.clear()
                line = f"{int(t)//60}:{t%60:04.1f}  （断了一下，好像换成别的声音了，我重新听）"
                out_lines.append(line); print(line, flush=True)
        prev_rms.append(rms); prev_cents.append(cent)

        if len(rms_hist) > 12 and rms > base * 1.45:
            say(t, "音量开始往上顶了", "rise")
        if len(rms_hist) > 20 and rms < base * 0.62:
            say(t, "退下来了，松口气", "drop")
        if len(rms_hist) > 20 and rms > peak_so_far:
            peak_so_far, peak_t = rms, t

        # 密度：4 秒窗的频谱通量峰值率
        if len(buf) > int(4 * SR):
            sp = stft_mag(buf[-int(4 * SR):])
            Sn = sp / (sp.sum(axis=0, keepdims=True) + 1e-9)
            flux = np.maximum(0, np.diff(Sn, axis=1)).sum(axis=0)
            # 阈值 k=0.9 让绝对速率与 librosa 对齐（实测 4.5 vs 4.3 峰值/秒）；
            # 但通量的起伏幅度只有 librosa 的 ~0.75 倍（max/中位 1.4 vs 1.9），
            # 所以触发倍数从 1.6 降到 1.25，否则永远不响。
            thr = flux.mean() + 0.9 * flux.std()
            peaks = [j for j in range(1, len(flux) - 1)
                     if flux[j] > thr and flux[j] >= flux[j - 1] and flux[j] >= flux[j + 1]]
            rate = len(peaks) / 4.0
            onset_hist.append(rate)
            if len(onset_hist) > 8:
                ob = float(np.median(onset_hist[-16:-1])) + 1e-9
                if rate > ob * 1.25:
                    say(t, "密起来了", "dense")

        # 调性：8 秒窗，4 秒一次
        if key_on and i % int(4 * SR) == 0 and len(buf) > int(6 * SR):
            ch = chroma_of(stft_mag(buf[-int(8 * SR):])).mean(axis=1)
            mode, corr = key_of(ch)
            if corr > 0.55:
                mode_hist.append(mode)
                if last_mode is None:
                    last_mode = mode
                elif mode != last_mode:
                    if mode_pending == mode:
                        share = sum(1 for m in mode_hist if m == last_mode) / len(mode_hist)
                        need = 15.0 if share > 0.8 else 10.0
                        if t - mode_since >= need:
                            say(t, "暗下来了" if mode == "minor" else "亮回来了", "key")
                            last_mode, mode_pending = mode, None
                    else:
                        mode_pending, mode_since = mode, t

        if not fast:
            wait = t0 + t - time.time()
            if wait > 0:
                time.sleep(wait)

    # 回顾层
    if peak_t > 0 and len(rms_hist) > 10:
        arr = np.asarray(rms_hist)
        i1 = int(np.argmax(arr))
        far = max(1, int(10 / BLOCK_S))
        others = [arr[j] for j in range(len(arr)) if abs(j - i1) > far]
        margin = (arr[i1] - max(others)) / (arr[i1] + 1e-9) if others else 1.0
        if margin < 0.05:
            line = "（回顾）整首响度差不多，没有哪一段特别突出"
        else:
            if peak_t > dur * 0.65:
                tail = "攒到最后才放出来"
            elif peak_t < dur * 0.3:
                tail = "很早就到顶了，后面一直在维持"
            else:
                tail = "是在中间放出来的"
            line = f"{int(peak_t)//60}:{peak_t%60:04.1f}  （回顾）刚才最响的是这一段，{tail}"
        out_lines.append(line); print(line, flush=True)

    print(f"\n--- 即时 {len(spoken)} 句 + 回顾 / 全曲 {dur:.0f}s ---")
    # 2026-11-14：研究版的 listen5/ 硬编码去掉了。默认只打 stdout；
    # 要存文件就显式 --save，写在音频旁边（<stem>_listen_lite.txt）。
    if "--save" in sys.argv:
        from pathlib import Path
        out_path = Path(path).with_name(Path(path).stem + "_listen_lite.txt")
        out_path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()