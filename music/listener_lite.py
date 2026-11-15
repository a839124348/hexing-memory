"""listener_lite.py — 实时陪听的判断层。不依赖 librosa（省约 265MB）。

两种驱动方式共用同一套判断：
    py listener_lite.py <音频>         # 从文件读（可 --fast 不限速）
    py tap.py                          # 从系统声卡环回读（边录边分析）

判据全部用 numpy 手写：重采样、STFT、chroma、频谱通量。
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
        import os
        import subprocess
        import tempfile
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


class Lite:
    """即时层判断。每 0.5 秒喂一块音频，吐出它愿意说的那几句。"""

    def __init__(self, key_on=False, cooldown=20.0, max_lines=6, echo=True):
        self.key_on = key_on
        self.cooldown = cooldown
        self.max_lines = max_lines
        self.echo = echo
        self.buf = np.zeros(0)
        self.n = 0
        self.rms_hist, self.onset_hist = [], []
        self.spoken, self.last_say = [], -999.0
        self.type_last, self.type_count = {}, {}
        self.last_mode, self.mode_pending, self.mode_since, self.mode_hist = None, None, 0.0, []
        self.peak_so_far, self.peak_t = 0.0, 0.0
        self.prev_cents, self.prev_rms = [], []
        self.gap_t, self.mute_until = -99.0, -1.0
        self.out_lines = []
        self.lines = []          # 这一次 feed 新产生的行，给调用方取走
        self.events = []         # 结构化事件，给 --json 用

    def say(self, t, text, kind):
        if t < self.mute_until or t - self.last_say < self.cooldown:
            return
        if len(self.spoken) >= self.max_lines:
            return
        if t - self.type_last.get(kind, -999.0) < 60 or self.type_count.get(kind, 0) >= 2:
            return
        self.type_last[kind] = t
        self.type_count[kind] = self.type_count.get(kind, 0) + 1
        self.spoken.append((t, text))
        self.last_say = t
        self.events.append({"t": round(t, 1), "kind": kind, "text": text})
        self._emit(f"{int(t)//60}:{t%60:04.1f}  {text}")

    def _emit(self, line):
        self.out_lines.append(line)
        self.lines.append(line)
        if self.echo:
            print(line, flush=True)

    def feed(self, block, t=None):
        """喂一块 0.5 秒的音频。t 默认按已喂样点数推算。"""
        self.lines = []
        self.buf = np.concatenate([self.buf, block])[-int(8 * SR):]
        self.n += len(block)
        if t is None:
            t = self.n / SR

        w2 = self.buf[-int(2 * SR):]
        rms = float(np.sqrt(np.mean(w2 ** 2)) + 1e-9)
        self.rms_hist.append(rms)
        base = float(np.median(self.rms_hist[-40:])) + 1e-9

        # 断源：先静音断口，再"由静到响"
        if rms < base * 0.08:
            self.gap_t = t
        sp2 = stft_mag(w2)
        freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
        cent = float(np.sum(freqs[:, None] * sp2) / (np.sum(sp2) + 1e-9))
        if self.prev_rms:
            br = float(np.median(self.prev_rms[-8:])) + 1e-9
            if (t - self.gap_t) < 1.5 and rms > br * 3 and t - self.mute_until > 30:
                self.mute_until = t + 10.0
                self.rms_hist.clear()
                self.onset_hist.clear()
                msg = "（断了一下，好像换成别的声音了，我重新听）"
                self.events.append({"t": round(t, 1), "kind": "switch", "text": msg})
                self._emit(f"{int(t)//60}:{t%60:04.1f}  {msg}")
        self.prev_rms.append(rms)
        self.prev_cents.append(cent)

        if len(self.rms_hist) > 12 and rms > base * 1.45:
            self.say(t, "开始往上顶了", "rise")
        if len(self.rms_hist) > 20 and rms < base * 0.62:
            self.say(t, "退下来了，松口气", "drop")
        if len(self.rms_hist) > 20 and rms > self.peak_so_far:
            self.peak_so_far, self.peak_t = rms, t

        # 密度：4 秒窗的频谱通量峰值率
        if len(self.buf) > int(4 * SR):
            sp = stft_mag(self.buf[-int(4 * SR):])
            Sn = sp / (sp.sum(axis=0, keepdims=True) + 1e-9)
            flux = np.maximum(0, np.diff(Sn, axis=1)).sum(axis=0)
            # 阈值 k=0.9 让绝对速率与 librosa 对齐（实测 4.5 vs 4.3 峰值/秒）；
            # 但通量的起伏幅度只有 librosa 的 ~0.75 倍（max/中位 1.4 vs 1.9），
            # 所以触发倍数从 1.6 降到 1.25，否则永远不响。
            thr = flux.mean() + 0.9 * flux.std()
            peaks = [j for j in range(1, len(flux) - 1)
                     if flux[j] > thr and flux[j] >= flux[j - 1] and flux[j] >= flux[j + 1]]
            rate = len(peaks) / 4.0
            self.onset_hist.append(rate)
            if len(self.onset_hist) > 8:
                ob = float(np.median(self.onset_hist[-16:-1])) + 1e-9
                if rate > ob * 1.25:
                    self.say(t, "密起来了", "dense")

        # 调性：8 秒窗，4 秒一次
        if self.key_on and self.n % int(4 * SR) == 0 and len(self.buf) > int(6 * SR):
            ch = chroma_of(stft_mag(self.buf[-int(8 * SR):])).mean(axis=1)
            mode, corr = key_of(ch)
            if corr > 0.55:
                self.mode_hist.append(mode)
                if self.last_mode is None:
                    self.last_mode = mode
                elif mode != self.last_mode:
                    if self.mode_pending == mode:
                        share = sum(1 for m in self.mode_hist if m == self.last_mode) / len(self.mode_hist)
                        need = 15.0 if share > 0.8 else 10.0
                        if t - self.mode_since >= need:
                            self.say(t, "暗下来了" if mode == "minor" else "亮回来了", "key")
                            self.last_mode, self.mode_pending = mode, None
                    else:
                        self.mode_pending, self.mode_since = mode, t
        return self.lines

    def finish(self, dur=None):
        """回顾层：整段听完才下结论。

        太短的会话不给回顾——试听 15 秒会得出"刚才最响的是这一段"，
        那是拿 15 秒当整首，等于编。
        """
        dur = dur or self.n / SR
        if dur < 60:
            msg = "（听的时间太短，先不下回顾）"
            self.events.append({"t": round(dur, 1), "kind": "review", "text": msg})
            self._emit(msg)
            return self.out_lines
        if self.peak_t > 0 and len(self.rms_hist) > 10:
            arr = np.asarray(self.rms_hist)
            i1 = int(np.argmax(arr))
            far = max(1, int(10 / BLOCK_S))
            others = [arr[j] for j in range(len(arr)) if abs(j - i1) > far]
            margin = (arr[i1] - max(others)) / (arr[i1] + 1e-9) if others else 1.0
            if margin < 0.05:
                line = "（回顾）整首响度差不多，没有哪一段特别突出"
            else:
                if self.peak_t > dur * 0.65:
                    tail = "攒到最后才放出来"
                elif self.peak_t < dur * 0.3:
                    tail = "很早就到顶了，后面一直在维持"
                else:
                    tail = "是在中间放出来的"
                line = f"{int(self.peak_t)//60}:{self.peak_t%60:04.1f}  （回顾）刚才最响的是这一段，{tail}"
            self.events.append({"t": round(dur, 1), "kind": "review", "text": line})
            self._emit(line)
        return self.out_lines


def main():
    path = sys.argv[1]
    fast = "--fast" in sys.argv
    key_on = "--with-key" in sys.argv
    from pathlib import Path

    y = load(path)
    dur = len(y) / SR
    blk = int(BLOCK_S * SR)
    L = Lite(key_on=key_on)
    t0 = time.time()
    for i in range(0, len(y) - blk, blk):
        L.feed(y[i:i + blk], (i + blk) / SR)
        if not fast:
            wait = t0 + (i + blk) / SR - time.time()
            if wait > 0:
                time.sleep(wait)
    L.finish(dur)

    print(f"\n--- 即时 {len(L.spoken)} 句 + 回顾 / 全曲 {dur:.0f}s ---")
    # 2026-11-14：研究版的 listen5/ 硬编码去掉了。默认只打 stdout；
    # 要存文件就显式 --save，写在音频旁边。
    if "--save" in sys.argv:
        Path(path).with_name(Path(path).stem + "_listen_lite.txt").write_text(
            "\n".join(L.out_lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()