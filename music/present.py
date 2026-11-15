"""present.py — 呈现层：把事件 + 当前歌词行翻成一句场景话。

不调模型：事件给动作，歌词给意象，从 quotes.json 里挑一句。
- world 优先：当前歌词里有"雨/夜/路/水/风/火/灯/屋/林"就用对应的句子；
- 没有就退回 live 里按事件分组的句子。
文字是设计层的事，结构在这里。
"""
import json
import random
from pathlib import Path

WORLDS = [
    ("雨", ["雨", "下雨", "落雨"]),
    ("夜", ["夜", "黑", "晚"]),
    ("路", ["路", "走", "远方", "出发"]),
    ("水", ["海", "水", "潮", "河", "浪"]),
    ("风", ["风"]),
    ("火", ["火", "烧", "焰"]),
    ("灯", ["灯", "光", "亮"]),
    ("屋", ["屋", "房", "窗", "门"]),
    ("林", ["林", "树", "叶"]),
]


class Presenter:
    def __init__(self, quotes_path, seed=None):
        self.path = Path(quotes_path)
        self.data = {}
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            self.data = {}
        self.rng = random.Random(seed)
        self.last = ""

    def world_of(self, lyric):
        s = str(lyric or "")
        for name, keys in WORLDS:
            if any(k in s for k in keys):
                return name
        return ""

    def pick(self, kind, lyric=""):
        """按事件 + 歌词意象挑一句；没有可用句子返回 ''。"""
        kind = str(kind or "").strip()
        pool = []
        world = self.world_of(lyric)
        if world:
            pool = ((self.data.get("world") or {}).get(world) or {}).get(kind) or []
        if not pool:
            pool = (self.data.get("live") or {}).get(kind) or []
        if not pool:
            return ""
        line = self.rng.choice(pool)
        if line == self.last and len(pool) > 1:
            line = pool[(pool.index(line) + 1) % len(pool)]
        self.last = line
        return line

    def pick_fun(self):
        """脑筋急转弯/冷笑话。返回 {text, answer}；没有就 None。"""
        pool = self.data.get("fun") or []
        if not pool:
            return None
        item = self.rng.choice(pool)
        if isinstance(item, dict):
            text = str(item.get("text") or "").strip()
            answer = str(item.get("answer") or "").strip()
        else:
            text, answer = str(item).strip(), ""
        if not text:
            return None
        if text == self.last and len(pool) > 1:
            item = pool[(pool.index(item) + 1) % len(pool)]
            if isinstance(item, dict):
                text = str(item.get("text") or "").strip()
                answer = str(item.get("answer") or "").strip()
            else:
                text, answer = str(item).strip(), ""
        self.last = text
        return {"text": text, "answer": answer}
