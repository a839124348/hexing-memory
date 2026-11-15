"""lyrics.py — 现在在放什么歌 + 联网查同步歌词（LRCLIB）。

    py lyrics.py                      # 当前歌曲 + 当前歌词行
    py lyrics.py --json               # 机器读
    py lyrics.py --lookup "晴天" "周杰伦" 270   # 手动查一首，验证网络/解析

识别歌曲用 Windows 的媒体会话（SMTC）：歌名、歌手、专辑、进度、总时长。
歌词用 LRCLIB（https://lrclib.net，开放、免费、不用 key），查过的只放在内存里，退出即清，不落盘。
歌词有版权：只在本机临时用，不进仓库、不写进记忆、不转发。
"""
import argparse
import asyncio
import json
import re
import sys
sys.dont_write_bytecode = True
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "hexing-music/0.1 (+https://github.com/a839124348/hexing-memory)"
TIMEOUT = 12
_MEM = {}   # 只在内存里缓存；进程退出即清，不落盘

_LRC_TAG = re.compile(r"\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]")


# ── 现在在放什么 ─────────────────────────────────────────────

def _media_manager():
    try:
        from winrt.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager as Manager,
        )
        return Manager
    except Exception:
        return None


async def _read_session():
    Manager = _media_manager()
    if Manager is None:
        return None
    mgr = await Manager.request_async()
    session = mgr.get_current_session()
    if session is None:
        return None
    props = await session.try_get_media_properties_async()
    tl = session.get_timeline_properties()
    info = session.get_playback_info()
    dur = tl.end_time.total_seconds() if tl.end_time else 0.0
    pos = tl.position.total_seconds() if tl.position else 0.0
    return {
        "title": (props.title or "").strip(),
        "artist": (props.artist or "").strip(),
        "album": (props.album_title or "").strip(),
        "duration_s": round(dur, 1) if dur > 0 else None,
        "position_s": round(pos, 1) if pos > 0 else 0.0,
        "status": str(info.playback_status),
        "app": session.source_app_user_model_id or "",
    }


def current_song():
    """当前媒体会话；没有播放器/非 Windows 返回 None。"""
    try:
        return asyncio.run(_read_session())
    except Exception:
        return None


# ── LRCLIB ──────────────────────────────────────────────────

def _http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def _pick(results, duration):
    """search 结果里挑一条：优先有同步词的，其次时长最接近的。"""
    rows = [r for r in (results or []) if isinstance(r, dict)]
    if not rows:
        return None

    def score(r):
        has_sync = 1 if r.get("syncedLyrics") else 0
        has_plain = 1 if r.get("plainLyrics") else 0
        d = abs(float(r.get("duration") or 0) - float(duration or 0)) if duration else 0
        return (has_sync, has_plain, -d)

    rows.sort(key=score, reverse=True)
    return rows[0]


def fetch_lrc(title, artist="", duration=None, use_cache=True):
    """按歌名/歌手/时长查 LRC。返回 dict；查不到返回 None。

    结果字段：title/artist/duration/instrumental/synced/plain/source/fetchedAt
    """
    title = str(title or "").strip()
    artist = str(artist or "").strip()
    if not title:
        return None
    key = f"{artist}|{title}|{int(duration or 0)}"
    if use_cache and key in _MEM:
        return _MEM[key]

    params = {"track_name": title}
    if artist:
        params["artist_name"] = artist
    if duration:
        params["duration"] = int(round(float(duration)))
    got = None
    # /api/get 需要 artist_name；没有歌手就直接走 search
    if artist:
        try:
            got = _http_json("https://lrclib.net/api/get?" + urllib.parse.urlencode(params))
        except urllib.error.HTTPError as e:
            # 400/404 都当“没这条”，继续走 search
            if e.code not in (400, 404):
                raise
        except Exception:
            return None

    if not got:
        q = {"track_name": title}
        if artist:
            q["artist_name"] = artist
        try:
            rows = _http_json("https://lrclib.net/api/search?" + urllib.parse.urlencode(q))
        except Exception:
            rows = []
        got = _pick(rows, duration)

    if not got:
        return None

    out = {
        "title": got.get("trackName") or title,
        "artist": got.get("artistName") or artist,
        "duration": got.get("duration"),
        "instrumental": bool(got.get("instrumental")),
        "synced": got.get("syncedLyrics") or "",
        "plain": got.get("plainLyrics") or "",
        "source": "lrclib",
        "fetchedAt": time.time(),
    }
    if out["synced"] or out["plain"]:
        _MEM[key] = out
    return out


# ── LRC 解析 ────────────────────────────────────────────────

def parse_lrc(text):
    """返回 [{t: 秒, text: 行}]，按时间排序；一行多个时间戳会展开。"""
    out = []
    for line in str(text or "").splitlines():
        tags = _LRC_TAG.findall(line)
        if not tags:
            continue
        body = _LRC_TAG.sub("", line).strip()
        if not body:
            continue
        for mm, ss in tags:
            try:
                out.append({"t": round(int(mm) * 60 + float(ss), 2), "text": body})
            except ValueError:
                continue
    out.sort(key=lambda x: x["t"])
    return out


def line_at(entries, pos):
    """pos 秒时唱到哪一行；还没开始返回 None。"""
    cur = None
    for e in entries:
        if e["t"] <= pos:
            cur = e
        else:
            break
    return cur


# ── CLI ─────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--lookup", nargs="+", metavar="TEXT",
                    help="手动查：--lookup 歌名 [歌手] [时长秒]")
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args()

    if args.lookup:
        title = args.lookup[0]
        artist = args.lookup[1] if len(args.lookup) > 1 else ""
        dur = None
        if len(args.lookup) > 2:
            try:
                dur = float(args.lookup[2])
            except ValueError:
                dur = None
        data = fetch_lrc(title, artist, dur, use_cache=not args.no_cache)
        if not data:
            print(json.dumps({"ok": False, "error": "not found"}, ensure_ascii=False))
            return 1
        entries = parse_lrc(data["synced"])
        print(json.dumps({
            "ok": True,
            "title": data["title"],
            "artist": data["artist"],
            "duration": data["duration"],
            "instrumental": data["instrumental"],
            "lines": len(entries),
            "first": entries[:3],
            "source": data["source"],
        }, ensure_ascii=False, indent=1))
        return 0

    song = current_song()
    if not song:
        print(json.dumps({"ok": False, "error": "no media session"}, ensure_ascii=False))
        return 1

    data = fetch_lrc(song["title"], song["artist"], song.get("duration_s"),
                     use_cache=not args.no_cache)
    entries = parse_lrc(data["synced"]) if data else []
    cur = line_at(entries, song.get("position_s") or 0)
    out = {
        "ok": True,
        "song": song,
        "lyrics": {
            "found": bool(data),
            "instrumental": bool(data and data.get("instrumental")),
            "lines": len(entries),
            "current": cur,
        } if data else {"found": False},
    }
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        print(f"{song['title']} — {song['artist']}")
        print(f"{song['position_s']:.0f}s / {song['duration_s'] or '?'}s  {song['status']}")
        if data:
            print(f"歌词：{len(entries)} 行（{data['source']}）")
            if cur:
                print(f"当前：{cur['text']}")
        else:
            print("歌词：没查到")
    return 0


if __name__ == "__main__":
    sys.exit(main())
