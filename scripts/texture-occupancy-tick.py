#!/usr/bin/env python3
# occupancy-tick(学習版) — 最奥 stall1/2 の占有を学習モデルで判定する。
#
# ルール方式(std/差分)は4方式とも独立検証で破綻(満車を空と誤読・状態依存)。代わりに
# 大量画像で学習した判定器 occupancy_model.py(各スロット23x23→19特徴→ロジ回帰)で
# 各スロット車あり/なしを確率判定し、号別占有=占有スロット数を出す。
# 検証: 雨で最奥フル→16/16, 明るい昼の空→空, 夜空→0, 同一画像で完全再現(状態非依存)。
# 暗所(br<55)は学習未検証のため出さず fill へ退避(publish側)。日中 stall1/2 のみ。
import os, sys, json, glob
import numpy as np
from PIL import Image
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "lib"))
import occupancy_model as om

ROOT = os.path.dirname(SCRIPT_DIR)
SLOTS = os.path.join(ROOT, "scripts/lib/stall-slots.json")
MODEL = os.path.join(ROOT, "data/occupancy_model.json")
ARCH = os.path.expanduser("~/taxi-image-archive/real01_line")
OUT = os.path.join(ROOT, "data/slot-texture-occupancy.jsonl")
DARK_GATE = 55.0
JST = timezone(timedelta(hours=9))


def latest_frame():
    for d in sorted(glob.glob(os.path.join(ARCH, "*")), reverse=True):
        js = sorted(glob.glob(os.path.join(d, "*.jpg")))
        if js:
            return js[-1]
    return None


def main():
    fn = latest_frame()
    if not fn:
        print("[occ] no frame", file=sys.stderr); return 0
    try:
        im = Image.open(fn).convert("RGB")
    except Exception as e:
        print(f"[occ] image read failed: {e}", file=sys.stderr); return 0
    g = np.asarray(im.convert("L"), dtype=np.float32)
    row = {"ts": datetime.now(JST).isoformat(timespec="seconds")}
    if g.mean() < DARK_GATE:
        row["dark"] = True   # 暗所は学習器を信用せずfillへ
    else:
        try:
            M = om.load_model(MODEL)
            slots = json.load(open(SLOTS))
            o = om.infer(im, M, slots, stalls=("stall1", "stall2"))
            row["stall1"] = int(o["stall1"]); row["stall2"] = int(o["stall2"])
        except Exception as e:
            print(f"[occ] infer failed: {e}", file=sys.stderr); return 0
    with open(OUT, "a") as f:
        f.write(json.dumps(row) + "\n")
    print("[occ]", row)
    return 0


if __name__ == "__main__":
    sys.exit(main())
