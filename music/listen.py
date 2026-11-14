"""listen.py — 给其它 AI 调用的唯一入口。输出 JSON。

    py listen.py <音频>              # 输出 JSON
    py listen.py <音频> --pretty     # 带缩进的 JSON
    py listen.py <音频> --brief      # 只要结论字段（省 token）

依赖只有 numpy + soundfile + soxr（约 35 MB），不需要 librosa。
所有字段的含义与可靠性见 MANUAL.md。
"""
import json
import sys

import numpy as np

SR, HOP, N_FFT = 22050, 512, 2048
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
FRAME = HOP / SR


# ── 基础 ────────────────────────────────────────────────
def load(path):
    import soundfile as sf
    try:
        y, sr = sf.read(path, dtype="float32", always_2d=False)
        if y.ndim > 1:
            y = y.mean(axis=1)
    except Exception:  # noqa: BLE001
        import os
        import subprocess
        import tempfile
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
                        "-vn", "-ac", "1", "-ar", str(SR), "-y", wav],
                       check=True, capture_output=True)
        y, sr = sf.read(wav, dtype="float32")
        os.remove(wav)
    if sr != SR:
        import soxr
        y = soxr.resample(np.asarray(y, dtype="float32"), sr, SR).astype("float32")
    return np.ascontiguousarray(y)


def stft(y):
    win = np.hanning(N_FFT).astype("float32")
    n = 1 + (len(y) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    return np.abs(np.fft.rfft(y[idx] * win, axis=1)).T.astype("float32")


def chroma(spec):
    """限带 80–2000Hz + 幅度开方。

    全带 chroma 会被贝斯谐波拉偏：实测 z84751 判成 A 小调，而真实是 E 大调。
    限带之后与 librosa 的 CQT 一致。
    """
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    m = (freqs >= 80) & (freqs <= 2000)
    midi = 69 + 12 * np.log2(np.maximum(freqs[m], 1e-9) / 440.0)
    pcs = np.mod(np.round(midi).astype(int), 12)
    S = np.sqrt(spec[m])
    out = np.zeros((12, spec.shape[1]), dtype="float32")
    for k in range(12):
        out[k] = S[pcs == k].sum(axis=0)
    return out / (out.sum(axis=0, keepdims=True) + 1e-9)


def key_of(vec):
    """返回 (根音, 模式, 最佳相关, 领先幅度)。

    lite 的相关值整体比 librosa 低（chroma 更糊），所以**不能用绝对阈值**判断可信度，
    改用"最佳与次佳的差距"。
    """
    scored = []
    for i in range(12):
        for nm, prof in (("major", MAJOR), ("minor", MINOR)):
            r = float(np.corrcoef(np.roll(prof, i), vec)[0, 1])
            scored.append((r, i, nm))
    scored.sort(reverse=True)
    best = scored[0]
    second = next((s for s in scored[1:] if s[1] != best[1] or s[2] != best[2]), scored[1])
    margin = (best[0] - second[0]) / (abs(best[0]) + 1e-9)

    # 关系调歧义：直接算"关系调"那一条的相关，而不是看次佳是谁。
    # C 大调与 A 小调共用同一套音，chroma 几乎分不出来；实测 z4dfdb 就是
    # lite 判 A 小调、CQT 判 C 大调，而 C 大调根本不在次佳位置上。
    rel_root = (best[1] + 9) % 12 if best[2] == "major" else (best[1] + 3) % 12
    rel_mode = "minor" if best[2] == "major" else "major"
    rel_prof = MINOR if rel_mode == "minor" else MAJOR
    rel_corr = float(np.corrcoef(np.roll(rel_prof, rel_root), vec)[0, 1])
    relative = bool(rel_corr >= 0.90 * best[0])
    return NAMES[best[1]], best[2], round(best[0], 3), round(margin, 3), relative


# ── 形状（与 soundkit.corpus 同一套算法）─────────────────
def energy_shape(rms, min_seg=10.0, thresh_db=2.0):
    db = np.clip(20 * np.log10(np.maximum(rms, 1e-8)), -60, 0)
    valid = np.where(db > -45)[0]
    if len(valid) < 40:
        return [], "太短"
    db = db[valid[0]: valid[-1] + 1]
    step = max(1, int(2.0 / FRAME))
    idx = list(range(0, len(db), step))
    vals = np.array([float(np.mean(db[i:i + step])) for i in idx])
    times = np.array(idx) * FRAME
    total = float(times[-1]) if len(times) else 1.0
    if len(vals) < 6:
        return [], "太短"

    win = 4
    dirs = []
    for i in range(len(vals)):
        a, b = max(0, i - win // 2), min(len(vals), i + win // 2 + 1)
        if b - a < 3:
            dirs.append("flat")
            continue
        s = float(np.polyfit(np.arange(a, b), vals[a:b], 1)[0]) / 2.0
        dirs.append("flat" if abs(s) < 0.15 else ("up" if s > 0 else "down"))

    raw = []
    for i, d in enumerate(dirs):
        if raw and raw[-1][0] == d:
            raw[-1][2] = i
        else:
            raw.append([d, i, i])

    def delta_of(t0, t1):
        ia = int(t0 / 2.0)
        ib = max(ia + 1, min(int(t1 / 2.0), len(vals)))
        return float(np.median(vals[max(ia, ib - 3):ib]) - np.median(vals[ia:min(ia + 3, ib)]))

    merged = []
    for _, a, b in raw:
        t0, t1 = float(times[a]), float(times[min(b + 1, len(times) - 1)])
        if merged and (t1 - t0) < min_seg and abs(delta_of(t0, t1)) < 6.0:
            merged[-1][1] = t1
        else:
            merged.append([t0, t1])

    typed = []
    for t0, t1 in merged:
        dd = max(-25.0, min(25.0, delta_of(t0, t1)))
        kind = "up" if dd >= thresh_db else ("down" if dd <= -thresh_db else "flat")
        typed.append([round(t0, 1), round(t1, 1), kind, round(dd, 1)])

    out = []
    for seg in typed:
        if out and out[-1][2] == seg[2]:
            out[-1][1] = seg[1]
            out[-1][3] = round(out[-1][3] + seg[3], 1)
        else:
            out.append(seg)

    ending = None
    if out and out[-1][2] == "down" and out[-1][0] > total * 0.85:
        ending = out.pop()

    ups = sum(1 for s in out if s[2] == "up")
    downs = sum(1 for s in out if s[2] == "down")
    seq = [s[2] for s in out]
    if ups == 0 and downs == 0:
        label = "一路平"
    elif ups == 1 and downs == 0:
        label = "一路升"
    elif downs == 1 and ups == 0:
        label = "一路降"
    elif ups == 1 and downs == 1:
        label = "先升后降" if seq.index("up") < seq.index("down") else "先降后升"
    elif ups >= 2 and downs >= 1:
        label = "升了又落"
    else:
        label = "落了又升"
    if ending:
        label += "+结尾淡出"
    return out, label


def peaks(rms, fr_t):
    k = max(1, int(1.5 / fr_t))
    sm = np.convolve(rms, np.ones(k) / k, mode="same")
    i1 = int(np.argmax(sm))
    far = max(1, int(10.0 / fr_t))
    order = np.argsort(sm)[::-1]
    i2 = next((int(i) for i in order if abs(int(i) - i1) > far), None)
    margin = float((sm[i1] - sm[i2]) / (sm[i1] + 1e-9)) if i2 is not None else 1.0
    hot = np.where(sm >= float(sm[i1]) * 0.995)[0]
    times, last = [], -1e9
    for i in hot:
        t = i * fr_t
        if t - last > 2.0:
            times.append(round(float(t), 1))
            last = t
    return {"count": len(times), "times_s": times[:6], "margin": round(margin, 4),
            "position": round(i1 / max(len(sm) - 1, 1), 3)}


def bpm_of(spec):
    env = np.maximum(0, np.diff(spec / (spec.sum(axis=0, keepdims=True) + 1e-9),
                                axis=1)).sum(axis=0)
    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lo = int(60 / 180 / FRAME)
    hi = min(len(ac) - 1, int(60 / 60 / FRAME))
    if hi <= lo + 2:
        return None
    lag = lo + int(np.argmax(ac[lo:hi]))
    return round(60.0 / (lag * FRAME), 1)


def events(y):
    """即时层事件（因果：只看过去）。返回 [{t_s, kind}]。"""
    blk = int(0.5 * SR)
    out, rms_hist, onset_hist = [], [], []
    last = {"rise": -999.0, "drop": -999.0, "dense": -999.0}
    count = {"rise": 0, "drop": 0, "dense": 0}
    for i in range(0, len(y) - blk, blk):
        t = (i + blk) / SR
        buf = y[max(0, i + blk - int(8 * SR)): i + blk]
        rms = float(np.sqrt(np.mean(buf[-int(2 * SR):] ** 2)) + 1e-9)
        rms_hist.append(rms)
        base = float(np.median(rms_hist[-40:])) + 1e-9

        def add(kind):
            if t - last[kind] > 60 and count[kind] < 2:
                last[kind] = t
                count[kind] += 1
                out.append({"t_s": round(t, 1), "kind": kind})

        if len(rms_hist) > 12 and rms > base * 1.45:
            add("rise")
        if len(rms_hist) > 20 and rms < base * 0.62:
            add("drop")
        if len(buf) > int(4 * SR):
            sp = stft(buf[-int(4 * SR):])
            Sn = sp / (sp.sum(axis=0, keepdims=True) + 1e-9)
            flux = np.maximum(0, np.diff(Sn, axis=1)).sum(axis=0)
            thr = flux.mean() + 0.9 * flux.std()
            pk = [j for j in range(1, len(flux) - 1)
                  if flux[j] > thr and flux[j] >= flux[j - 1] and flux[j] >= flux[j + 1]]
            rate = len(pk) / 4.0
            onset_hist.append(rate)
            if len(onset_hist) > 8:
                ob = float(np.median(onset_hist[-16:-1])) + 1e-9
                if rate > ob * 1.25:
                    add("dense")
    return out


def main():
    path = sys.argv[1]
    pretty = "--pretty" in sys.argv
    brief = "--brief" in sys.argv

    y = load(path)
    spec = stft(y)
    rms = np.sqrt(np.mean(y[: (len(y) // HOP) * HOP].reshape(-1, HOP) ** 2, axis=1))
    dur = len(y) / SR

    ch = chroma(spec).mean(axis=1)
    key, mode, corr, margin, relative = key_of(ch)
    # 调性默认不报：lite 的 STFT-chroma 与 librosa CQT 只有 60% 一致
    # （5 首里 2 首判错：z4dfdb A小调 vs C大调、zb86fe G大调 vs C大调）。
    # 错四成的字段比没有字段更糟 —— 需要调性请用完整版 soundkit。
    use_key = "--with-key" in sys.argv
    segs, label = energy_shape(rms)
    pk = peaks(rms, FRAME)
    tail = rms[-max(1, int(15 / FRAME)):]
    end_ratio = float(np.mean(tail) / (np.mean(rms) + 1e-9))
    low_ratio = float((spec[np.fft.rfftfreq(N_FFT, 1 / SR) < 110] ** 2).sum()
                      / ((spec ** 2).sum() + 1e-9))
    ev = events(y)

    R = {
        "ok": True,
        "file": path,
        "duration_s": round(dur, 1),
        "bpm": bpm_of(spec),
        "tonality": ({"key": key, "mode": mode, "confidence": corr,
                      "margin": margin, "relative_ambiguous": relative}
                     if use_key else None),
        "tonality_note": None if use_key else
        "lite 版不测调性（与 CQT 仅 60% 一致）；需要调性用完整版 soundkit。",
        "shape": {"label": label,
                  "segments": [{"from_s": s[0], "to_s": s[1], "dir": s[2], "delta_db": s[3]}
                               for s in segs]},
        "peaks": pk,
        "ending": {"energy_ratio": round(end_ratio, 3),
                   "fades": bool(end_ratio < 0.55)},
        "events": ev,
        "reliability": {
            "tonality": ("unavailable（需要完整版）" if not use_key else
                         "low（关系大/小调分不清，只说'明暗之间'）" if relative else
                         "ok" if margin >= 0.05 else "low（不要说调性）"),
            "peak_position": "ok" if pk["margin"] >= 0.05 else "tied（不许多处挑一处）",
            "scene": "unavailable（不要猜场景）",
        },
    }
    if brief:
        R = {k: R[k] for k in ("ok", "file", "duration_s", "bpm", "shape",
                               "peaks", "ending", "reliability")}
    print(json.dumps(R, ensure_ascii=False, indent=1 if pretty else None))


if __name__ == "__main__":
    main()