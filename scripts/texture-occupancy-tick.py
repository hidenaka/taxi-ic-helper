#!/usr/bin/env python3
# texture-occupancy-tick — 最奥 stall1/2 の占有を「スロット占有率(テクスチャ)」で計測する。
#
# 背景: 最奥 stall1/2 は遠景で前列に隠れ、fill(背景差分)もYOLOカウントも信頼できない
# (台数カウントが不可能だから列移動を測っている、という設計前提どおり)。
# しかし「各スロットが車で埋まっているか」はテクスチャ(局所std)で判定できる:
# 車=窓/輪郭/コントラストでテクスチャ高、空アスファルト=平坦でテクスチャ低(濡れでも平坦)。
# これは列移動と同じ stall-slots.json のスロット位置を使い、台数でなく占有"割合"を出すため
# 遮蔽に強い。実画像検証で 満車16/16・空0/16 と分離(thr=28)。
import os, sys, json, glob
import numpy as np
from PIL import Image
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SLOTS = os.path.join(ROOT, "scripts/lib/stall-slots.json")
OUT = os.path.join(ROOT, "data/slot-texture-occupancy.jsonl")
ARCH = os.path.expanduser("~/taxi-image-archive/real01_line")
JST = timezone(timedelta(hours=9))
THR = 28.0     # スロットpatchのstdがこれ超で占有(車あり)。実画像で満車/空を分離する値。
PATCH = 7      # スロット中心の±7px(=14x14)パッチ。
STALLS = ["stall1", "stall2"]  # 最奥のみ。stall3/4(近距離)はfill据置。

def latest_frame():
    for d in sorted(glob.glob(os.path.join(ARCH, "*")), reverse=True):
        js = sorted(glob.glob(os.path.join(d, "*.jpg")))
        if js:
            return js[-1]
    return None

def main():
    try:
        cfg = json.load(open(SLOTS))
    except Exception as e:
        print(f"[tex-occ] slots read failed: {e}", file=sys.stderr); return 0
    fn = latest_frame()
    if not fn:
        print("[tex-occ] no frame", file=sys.stderr); return 0
    try:
        g = np.asarray(Image.open(fn).convert("L")).astype(float)
    except Exception as e:
        print(f"[tex-occ] image read failed: {e}", file=sys.stderr); return 0
    H, W = g.shape
    row = {"ts": datetime.now(JST).isoformat(timespec="seconds")}
    for st in STALLS:
        slots = cfg["stalls"][st]["slots"]
        n = 0
        for s in slots:
            cx, cy = int(s["cx"] * W), int(s["cy"] * H)
            p = g[max(0, cy - PATCH):cy + PATCH, max(0, cx - PATCH):cx + PATCH]
            if p.size and p.std() > THR:
                n += 1
        row[st] = n
    with open(OUT, "a") as f:
        f.write(json.dumps(row) + "\n")
    print("[tex-occ]", row)
    return 0

if __name__ == "__main__":
    sys.exit(main())
