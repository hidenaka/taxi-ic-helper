#!/usr/bin/env python3
# プールが「空」になった時間帯を記録する。
#
# 定義(2026-09-25): 台数 = 号内(1〜4号)+拡張エリア+4号奥ブロック。昼は YOLO、夜は行灯(primary)。
#   ほぼ空 = 10台以下、完全に空 = 3台以下。5分おきの vehicle-count-history から拾い、
#   16分以内の間隔は同じエピソードとしてつなぐ(計測が1回飛んでも切らない)。
# 画像検証(2026-09-25): 8/23 03:04-04:01・9/16 00:35-01:05・9/24 09:17-10:24・9/21 15:43-15:53 を
#   実画像で確認し、いずれも本当に空(カメラ故障や写り込みではない)。
# 出力: data/pool-empty-history.jsonl  {start, end, minutes, min_cars, kind}
import json, os, sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "vehicle-count-history.jsonl")
OUT = os.path.join(ROOT, "data", "pool-empty-history.jsonl")
NEAR = 10     # ほぼ空
EMPTY = 3     # 完全に空
GAP_MIN = 16


def total(r):
    p = r.get("primary") or "yolo"
    src = r.get(p) or r.get("yolo") or {}
    st = sum(int(src.get(k) or 0) for k in ("stall1", "stall2", "stall3", "stall4"))
    ext = src.get("ext") or {}
    ex = sum(int(ext.get(k) or 0) for k in ("stall1", "stall2", "stall3", "stall4"))
    b = r.get("back") or {}
    return st + ex + int(b.get(p) or b.get("yolo") or 0)


def load():
    rows = []
    try:
        for l in open(SRC):
            l = l.strip()
            if not l: continue
            try: r = json.loads(l)
            except Exception: continue
            rows.append((datetime.fromisoformat(r["ts"]), total(r)))
    except FileNotFoundError:
        return []
    rows.sort()
    return rows


def episodes(rows):
    eps = []; cur = None
    for ts, n in rows:
        if n <= NEAR:
            if cur and ts - cur["end"] <= timedelta(minutes=GAP_MIN):
                cur["end"] = ts; cur["min"] = min(cur["min"], n)
            else:
                if cur: eps.append(cur)
                cur = {"start": ts, "end": ts, "min": n}
        # NEAR 超えはエピソードを閉じない(GAP_MIN で自然に切れる)
    if cur: eps.append(cur)
    return [{"start": e["start"].isoformat(), "end": e["end"].isoformat(),
             "minutes": int((e["end"] - e["start"]).total_seconds() / 60) + 5,
             "min_cars": e["min"], "kind": "empty" if e["min"] <= EMPTY else "near"} for e in eps]


def main():
    rows = load()
    if not rows: return 0
    eps = episodes(rows)
    with open(OUT, "w") as fh:
        for e in eps: fh.write(json.dumps(e) + "\n")
    if eps:
        last = eps[-1]
        print("[pool-empty] 記録", len(eps), "件 / 最後に空:", last["start"][:16],
              f"({last['minutes']}分, 最少{last['min_cars']}台, {last['kind']})")
    return 0


if __name__ == "__main__":
    try: sys.exit(main())
    except Exception as ex:
        print(f"[pool-empty] failed: {ex}", file=sys.stderr); sys.exit(0)
