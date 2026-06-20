#!/usr/bin/env python3
# occupancy-tick(構造差分方式) — 最奥 stall1/2 の占有を「空参照との構造差」で計測する。
#
# 旧 std>28(テクスチャ)は固定閾値で振動・暗い車偽陰性で破綻(独立検証で実証)。
# 本方式: 各スロットpatchを明るさ正規化(patch-mean=構造のみ)し、最近の「空アスファルト」
# 参照(data/slot-empty-reference.npz, build-empty-reference.pyが定期生成)との平均絶対差が
# 閾値超なら占有。de-risk: 昼連続frame安定(無振動)/空0/満16/暗い車も検出。
# 暗所(夜/夕方暗)は brightness gate で保留→publishがfillへフォールバック。
import os, sys, json, glob, subprocess, time
import numpy as np
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "lib"))
import empty_reference as er

ROOT = os.path.dirname(SCRIPT_DIR)
SLOTS = os.path.join(ROOT, "scripts/lib/stall-slots.json")
ARCH = os.path.expanduser("~/taxi-image-archive/real01_line")
REF = os.path.join(ROOT, "data/slot-empty-reference.npz")
OUT = os.path.join(ROOT, "data/slot-texture-occupancy.jsonl")
BUILDER = os.path.join(SCRIPT_DIR, "build-empty-reference.py")
REF_MAX_AGE_H = 24   # 参照がこれより古ければ再生成(天候/光に追従)
JST = timezone(timedelta(hours=9))


def latest_frame():
    for d in sorted(glob.glob(os.path.join(ARCH, "*")), reverse=True):
        js = sorted(glob.glob(os.path.join(d, "*.jpg")))
        if js:
            return js[-1]
    return None


def ref_stale():
    meta = REF + ".meta.json"
    if not (os.path.exists(REF) and os.path.exists(meta)):
        return True
    try:
        ts = datetime.fromisoformat(json.load(open(meta))["ts"])
        return (datetime.now(JST) - ts).total_seconds() > REF_MAX_AGE_H * 3600
    except Exception:
        return True


def main():
    if ref_stale():
        try:
            subprocess.run([sys.executable, BUILDER], timeout=180, check=False)
        except Exception as e:
            print(f"[occ] ref rebuild failed: {e}", file=sys.stderr)
    if not os.path.exists(REF):
        print("[occ] no reference yet", file=sys.stderr); return 0
    fn = latest_frame()
    if not fn:
        print("[occ] no frame", file=sys.stderr); return 0
    g = er.frame_gray(fn)
    cfg = json.load(open(SLOTS))
    npz = np.load(REF)
    refs = {st: npz[st].copy() for st in er.STALLS}
    row = {"ts": datetime.now(JST).isoformat(timespec="seconds")}
    if g.mean() < er.DARK_GATE:
        row["dark"] = True   # 暗所は占有値を出さない(publishはfillへ)
    else:
        for st in er.STALLS:
            slots = cfg["stalls"][st]["slots"]
            row[st] = int(er.slot_occupancy(g, slots, refs[st]))
            er.adapt_reference(g, slots, refs[st])   # 占有判定後、空スロットだけ参照を現状へEMA追従
        np.savez(REF, **refs)   # 適応後の参照を保存(天候/光に連続追従)
    with open(OUT, "a") as f:
        f.write(json.dumps(row) + "\n")
    print("[occ]", row)
    return 0


if __name__ == "__main__":
    sys.exit(main())
