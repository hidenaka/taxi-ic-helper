#!/usr/bin/env python3
# build-empty-reference — 直近の最も空いたフレームから各号の「空アスファルト」構造参照を作り保存。
# 天候/光に追従するため定期更新する(夜間の空きが多い時間帯から取れる)。占有tickがこれを読む。
import os, sys, glob, json
import numpy as np
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "lib"))
import empty_reference as er

ROOT = os.path.dirname(SCRIPT_DIR)
SLOTS = os.path.join(ROOT, "scripts/lib/stall-slots.json")
ARCH = os.path.expanduser("~/taxi-image-archive/real01_line")
OUT = os.path.join(ROOT, "data/slot-empty-reference.npz")
LOOKBACK_H = 30        # 直近何時間から空フレームを探すか
JST = timezone(timedelta(hours=9))


def recent_frames(hours):
    now = datetime.now(JST)
    out = []
    for dd in sorted(glob.glob(os.path.join(ARCH, "*")))[-3:]:
        for f in sorted(glob.glob(os.path.join(dd, "*.jpg"))):
            out.append(f)
    return out[-(hours * 120):]  # 約30秒毎=120/h


def main():
    cfg = json.load(open(SLOTS))
    frames = recent_frames(LOOKBACK_H)
    if len(frames) < er.N_EMPTY:
        print("[empty-ref] not enough frames", file=sys.stderr); return 0
    out = {}
    for st in er.STALLS:
        slots = cfg["stalls"][st]["slots"]
        empt = er.emptiest_frames(frames, slots, er.N_EMPTY)
        out[st] = er.build_reference(empt, slots)
    np.savez(OUT, **out)
    # メタ(更新時刻)
    json.dump({"ts": datetime.now(JST).isoformat(timespec="seconds"),
               "n_frames": len(frames)}, open(OUT + ".meta.json", "w"))
    print(f"[empty-ref] built from {len(frames)} frames -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
