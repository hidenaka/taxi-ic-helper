#!/usr/bin/env python3
# 号別(1〜4)全レーン埋まり率tick。昼=学習モデル/夜=行灯(noriba_fill)。
# 最新 real01/real02 frame で比率を出し data/noriba-fill-history.jsonl に追記(ローカル保持)。
# publish側が直近medianを読み pool-status に載せる。
import os, sys, json, glob
from datetime import datetime, timezone, timedelta
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "lib"))
import noriba_fill as nf
ROOT = os.path.dirname(SCRIPT_DIR)
OUT = os.path.join(ROOT, "data/noriba-fill-history.jsonl")
JST = timezone(timedelta(hours=9))

def latest(cam):
    base = os.path.expanduser("~/taxi-image-archive/" + ("real01_line" if cam == "real01" else "real02"))
    for d in sorted(glob.glob(base + "/*"), reverse=True):
        js = sorted(glob.glob(d + "/*.jpg"))
        if js:
            return js[-1]
    return None


def _source_stale():
    # 旧カメラ凍結中(2026-08-20 カメラ総入れ替え)は追記しない。ROI再校正後に新カメラへ切替える。
    import json as _json
    try:
        _p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data/pool-source-status.json")
        return _json.load(open(_p)).get("sourceStale") is True
    except Exception:
        return False

def main():
    if _source_stale():
        print("[noriba-fill] source stale (旧カメラ凍結中) — 追記スキップ", file=sys.stderr)
        return 0
    r1 = latest("real01"); r2 = latest("real02")
    if not r1:
        print("[noriba-fill] no frame", file=sys.stderr); return 0
    try:
        res = nf.compute(r1, r2)
    except Exception as e:
        print(f"[noriba-fill] compute failed: {e}", file=sys.stderr); return 0
    row = {"ts": datetime.now(JST).isoformat(timespec="seconds"),
           "mode": res["mode"], "brightness": res["brightness"], "fill": res["fill"]}
    with open(OUT, "a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print("[noriba-fill]", row)
    return 0

if __name__ == "__main__":
    sys.exit(main())
