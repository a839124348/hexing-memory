"""share.py — 歌尾分享卡：初印象 + 想象 + 依据 + 歌词对照材料 + 一个问题。

    py share.py <音频> [--title 歌名] [--artist 歌手] [--json]

它不是让模型直接念的报告，是给模型的四拍骨架：
    1. 初印象（来自测量，说人话）
    2. 想象（场景，标明是想象）
    3. 歌词（上网查的，不是听出来的）
    4. 差在哪 + 问用户一句

诚实边界：歌词是查的，画面是想的，测量是量的，三样不混。
"""
import argparse
import json
import sys
sys.dont_write_bytecode = True
from pathlib import Path

import numpy as np

import listen as M
import lyrics as LY

SR, HOP = M.SR, M.HOP
FRAME = M.FRAME

FAMILY_IMAGES = {
    "闷": ["像压着不散的云，停在半空，没飘到天顶。"],
    "空": ["像水落到底，又慢慢涨回来。"],
    "急": ["像有人在前面赶路，一步不停。"],
    "暖": ["像晒过太阳的被子，慢慢铺开。"],
    "冷": ["像灯一盏盏暗下去。"],
    "远": ["像越走越远，最后自己散了。"],
}
try:
    _q = json.loads((Path(__file__).with_name("quotes.json")).read_text(encoding="utf-8"))
    FAMILY_IMAGES.update({
        k: v for k, v in (_q.get("family") or {}).items()
        if isinstance(v, list) and v
    })
except Exception:
    pass

SHAPE_TEXT = {
    "一路升": "它一路往上，没怎么回头",
    "一路降": "它一开始就在往下走，越到后面越轻",
    "一路平": "它基本停在一个高度上，没什么大起落",
    "先升后降": "先往上，到一个地方就转了，后面慢慢落",
    "升了又落": "升上去又落下来，来回了一趟",
    "落了又升": "先落下去，后来又提回来",
}


def measure(y):
    """对一段 22050 单声道音频做整首测量。"""
    n = (len(y) // HOP) * HOP
    rms = np.sqrt(np.mean(y[:n].reshape(-1, HOP) ** 2, axis=1))
    spec = M.stft(y)
    segs, label = M.energy_shape(rms)
    pk = M.peaks(rms, FRAME)
    dur = len(y) / SR
    tail = rms[-max(1, int(15 / FRAME)):]
    end_ratio = float(np.mean(tail) / (np.mean(rms) + 1e-9))
    return {
        "duration_s": round(dur, 1),
        "bpm": M.bpm_of(spec),
        "shape_label": label,
        "segments": [
            {"from_s": round(s[0], 1), "to_s": round(s[1], 1),
             "dir": s[2], "delta_db": round(s[3], 1)}
            for s in segs
        ],
        "peaks": pk,
        "ending": {"energy_ratio": round(end_ratio, 3), "fades": end_ratio < 0.55},
        "events": M.events(y),
    }


def family_of(m):
    """按 8.6 的“依据”粗分六族；分不清就返回空。"""
    segs = m["segments"]
    end = m["ending"]["energy_ratio"]
    margin = float(m["peaks"].get("margin") or 0)
    downs = [s for s in segs if s["dir"] == "down" and s["delta_db"] <= -6]
    ups = [s for s in segs if s["dir"] == "up"]

    # 空：中间掉下去又回来
    if downs and ups and end >= 0.75:
        di = segs.index(downs[0])
        if any(s["dir"] == "up" for s in segs[di + 1:]):
            return "空"
    # 远：结尾只剩四成上下，末段还在下行
    if end <= 0.5 and segs and segs[-1]["dir"] == "down":
        return "远"
    # 闷：涨到某处就停住，结尾仍接近满
    if end >= 0.8 and segs and segs[-1]["dir"] == "flat" and margin < 0.12:
        return "闷"
    # 急：起势一路往上
    if segs and segs[0]["dir"] == "up" and segs[0]["delta_db"] >= 6:
        return "急"
    # 暖：没有大低谷，结尾不是骤停
    if not downs and end >= 0.55:
        return "暖"
    return ""


def _dir_text(seg):
    d = float(seg["delta_db"])
    if seg["dir"] == "up":
        return "往上走得明显" if d >= 8 else "慢慢往上"
    if seg["dir"] == "down":
        return "往下掉得明显" if d <= -8 else "慢慢往下"
    return "基本持平"


def first_impression(m):
    segs = m["segments"]
    parts = []
    if not segs:
        return "它有自己的走法。"
    words = [_dir_text(s) for s in segs[:3]]
    if len(segs) == 1:
        parts.append("整首" + words[0])
    elif len(segs) == 2:
        parts.append("前面" + words[0])
        parts.append("后面" + words[1])
    else:
        parts.append("先" + words[0])
        parts.append("后来" + words[1])
        parts.append("最后" + words[2])
    if m["ending"]["fades"]:
        parts.append("结尾是淡出去的")
    elif m["ending"]["energy_ratio"] >= 0.9:
        parts.append("结尾还撑着")
    pk = m["peaks"]
    if pk.get("count") == 1 and float(pk.get("margin") or 0) >= 0.05:
        pos = float(pk.get("position") or 0)
        when = "很早" if pos < 0.3 else "很靠后" if pos > 0.65 else "在中间"
        parts.append(f"最响的一段{when}")
    return "，".join(parts) + "。"


def because(m):
    out = []
    for s in m["segments"]:
        d = "往上" if s["dir"] == "up" else "往下" if s["dir"] == "down" else "持平"
        out.append(f"{s['from_s']:.0f}–{s['to_s']:.0f} 秒：{d}，{s['delta_db']:+.1f} dB")
    e = m["ending"]["energy_ratio"]
    out.append(f"结尾 15 秒能量是全曲平均的 {e:.0%}" + ("（淡出）" if m["ending"]["fades"] else ""))
    pk = m["peaks"]
    if pk.get("count") == 1 and float(pk.get("margin") or 0) >= 0.05:
        out.append(f"峰值只有一处，领先第二处 {float(pk['margin']):.0%}")
    else:
        out.append("峰值并列，不报单独位置")
    return out


def lyric_excerpt(lyr, limit=6):
    """挑一段歌词给模型：优先副歌（重复最多的那行前后），否则前几句。

    返回 (lines, total_lines)。不返回全词，省 token，也少碰版权。
    """
    if not lyr:
        return [], 0
    text = lyr.get("synced") or ""
    if text:
        lines = [e["text"] for e in LY.parse_lrc(text)]
    else:
        lines = [x.strip() for x in (lyr.get("plain") or "").splitlines() if x.strip()]
    if not lines:
        return [], 0
    from collections import Counter
    hook, n = Counter(lines).most_common(1)[0]
    if n >= 2:
        i = lines.index(hook)
        start = max(0, i - 1)
        return lines[start:start + limit], len(lines)
    return lines[:limit], len(lines)


def build_share(y, title="", artist="", duration=None):
    m = measure(y)
    fam = family_of(m)
    lyr = LY.fetch_lrc(title, artist, duration or m["duration_s"]) if title else None
    excerpt, total_lines = lyric_excerpt(lyr)
    dur = float(m["duration_s"] or 0)
    # 一两句 + 整首几分钟：按“几乎无歌词/纯音乐”处理，别让模型硬说有完整歌词
    sparse = bool(lyr and total_lines <= 2 and dur >= 90)
    line = excerpt[0] if excerpt else ""
    if lyr and line and sparse:
        ask = f"整首几乎只有这一句「{line}」；你听到它的时候，想到的是什么？"
    elif lyr and line:
        ask = f"歌词里那句「{line}」，你听的时候对上了吗？还是你想到的是别的？"
    elif lyr:
        ask = "查到了歌词，但这首几乎没词；你听的时候，它像什么？"
    else:
        ask = "面板没查到歌词；你听的时候，它像什么？"
    images = FAMILY_IMAGES.get(fam) or ["像一段路，走到哪儿算哪儿。"]
    return {
        "song": {"title": lyr.get("title") if lyr else title,
                 "artist": lyr.get("artist") if lyr else artist,
                 "duration_s": m["duration_s"]},
        "first_impression": first_impression(m),
        "family": fam,
        "image": images[0],
        "because": because(m),
        "lyrics": {
            "found": bool(lyr),
            "source": (lyr or {}).get("source", ""),
            "instrumental": bool((lyr or {}).get("instrumental")),
            "sparse": sparse,
            "total_lines": total_lines,
            "has_full": bool(
                ((lyr or {}).get("synced") or (lyr or {}).get("plain"))
                and total_lines > 2),
            "excerpt": excerpt,
        },
        "ask": ask,
        "gap_hint": "拿 image 和 lyrics.excerpt 对照：差在哪儿，就说哪儿；没查到歌词就说没查到，不编。",
        "honesty": "歌词是上网查的，不是听出来的；画面是想的，不是量出来的。",
        "measured": m,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--title", default="")
    ap.add_argument("--artist", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    path = Path(args.audio)
    if not path.exists():
        print(json.dumps({"ok": False, "error": "file not found"}, ensure_ascii=False))
        return 1
    y = M.load(str(path))
    title = args.title or path.stem
    share = build_share(y, title, args.artist)
    if args.json:
        print(json.dumps(share, ensure_ascii=False, indent=1))
    else:
        print("初印象：" + share["first_impression"])
        print("想象：" + share["image"] + "（想的）")
        if share["lyrics"]["found"]:
            print("歌词（上网查的）：")
            for line in share["lyrics"]["excerpt"][:4]:
                print("  " + line)
        else:
            print("歌词：没查到")
        print("问：" + share["ask"])
        print("依据：")
        for b in share["because"]:
            print("  - " + b)
    return 0


if __name__ == "__main__":
    sys.exit(main())
