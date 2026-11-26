#!/usr/bin/env python3
"""乗り場から出た台数を、丸1日数えた日ごとに 1 ファイルにまとめる(日ごとのグラフのページ用・2026-11-26〜)。
1日1回だけ作り直す(builtOn が今日なら何もしない)。丸1日 = 0:30 までに数え始め、23時台まで数えた日。
big = その日に1時間以上遅れた国内線の座席の合計(到着便の記録の最後の行から)。"""
import os, json, glob, collections
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EVENTS = os.path.join(ROOT, "data/stand-out-events.jsonl")
SNAPS = os.path.join(ROOT, "data/arrivals-snapshots")
OUT = os.path.join(ROOT, "data/stand-days.json")


def _mm(s):
    try:
        h, m = map(int, (s or "").split(":")[:2]); return h * 60 + m
    except Exception:
        return None


def delayed_seats(day):
    last = None
    try:
        with open(os.path.join(SNAPS, f"arrivals-{day}.jsonl")) as f:
            for line in f:
                try: last = json.loads(line)
                except Exception: pass
    except FileNotFoundError:
        return None
    if not last: return None
    seats = 0
    for fl in last.get("flights") or []:
        if fl.get("isInternational"): continue
        s, a = _mm(fl.get("scheduledTime")), _mm(fl.get("actualTime") or fl.get("estimatedTime"))
        if s is None or a is None: continue
        if a < s - 300: a += 1440
        if a - s >= 60: seats += fl.get("seatCount") or 0
    return seats


def main(force=False):
    today = datetime.now(JST).strftime("%Y-%m-%d")
    if not force and os.path.exists(OUT):
        try:
            if json.load(open(OUT)).get("builtOn") == today: return
        except Exception: pass
    outs = collections.defaultdict(lambda: [0] * 24); first = {}; last = {}
    with open(EVENTS) as f:
        for line in f:
            try: e = json.loads(line)
            except Exception: continue
            d, k = e["ts"][:10], None
            if d >= today: continue
            k = (e["stall"], d)
            outs[k][int(e["ts"][11:13])] += e.get("out", 0)
            first[k] = min(first.get(k, e["ts"]), e["ts"]); last[k] = max(last.get(k, e["ts"]), e["ts"])
    days = collections.defaultdict(dict)
    for (stall, d), h in outs.items():
        if first[(stall, d)][11:16] <= "00:30" and last[(stall, d)][11:13] == "23":
            days[d][stall.replace("stall", "")] = [round(v) for v in h]
    rows = [{"d": d, "big": delayed_seats(d), "h": days[d]} for d in sorted(days)]
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"builtOn": today, "days": rows}, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)


if __name__ == "__main__":
    import sys
    main(force="--force" in sys.argv)
