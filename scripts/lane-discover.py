#!/usr/bin/env python3
# 新カメラの「区画(タクシーが繰り返し停まる場所)」を、貯めたフレームから自動で洗い出す。
#
# 考え方: 一日ぶん眺めると、
#   ・区画  = 車が居たり居なかったりする → 明るさの振れ幅が大きい
#   ・通路  = ずっと路面のまま           → 振れ幅が小さい
#   ・construct(建物/植栽) = ずっと暗いまま → 振れ幅が小さい
# なので画素ごとの「振れ幅」と「車が居た割合」を出せば区画が浮かび上がる。
# 旧カメラは手作業で座標を打っていたが、画角が変わったので実データから引き直す。
import os, sys, glob, json
import numpy as np
from PIL import Image

cam = sys.argv[1]
days = sys.argv[2].split(',')
out_prefix = sys.argv[3]
hour_lo = sys.argv[4] if len(sys.argv) > 4 else '070000'
hour_hi = sys.argv[5] if len(sys.argv) > 5 else '170000'

ARC = os.path.expanduser(f'~/taxi-image-archive/{cam}')
files = []
for d in days:
    p = os.path.join(ARC, d)
    if not os.path.isdir(p): continue
    fs = sorted(glob.glob(os.path.join(p, '*.jpg')))
    files += [f for f in fs if hour_lo <= os.path.basename(f)[:6] <= hour_hi]
if not files:
    print(f'[lane] {cam}: 対象フレームなし'); sys.exit(1)

step = max(1, len(files) // 300)
picks = files[::step][:300]
arrs = []
size = None
for f in picks:
    try:
        im = Image.open(f).convert('L')
    except Exception:
        continue
    if size is None: size = im.size
    if im.size != size: continue
    arrs.append(np.asarray(im, dtype=np.float32))
if len(arrs) < 20:
    print(f'[lane] {cam}: フレームが少なすぎる ({len(arrs)}枚)'); sys.exit(1)
stack = np.stack(arrs)
print(f'[lane] {cam} {days}: {len(arrs)}枚 / {size[0]}x{size[1]}')

bg = np.median(stack, axis=0)              # 車が消えた路面
dev = np.abs(stack - bg)
occupied = (dev > 18).mean(axis=0)         # 車が居た割合 0-1
spread = stack.std(axis=0)                 # 振れ幅

np.savez_compressed(out_prefix + '.npz', bg=bg, occupied=occupied, spread=spread)

def colorize(m, lo=0.0, hi=1.0):
    v = np.clip((m - lo) / max(hi - lo, 1e-6), 0, 1)
    img = np.zeros(m.shape + (3,), dtype=np.uint8)
    base = (bg * 0.4).astype(np.uint8)
    img[..., 0] = np.clip(base + v * 220, 0, 255)
    img[..., 1] = np.clip(base + v * 60, 0, 255)
    img[..., 2] = base
    return Image.fromarray(img)

colorize(occupied).save(out_prefix + '-occupied.png')
Image.fromarray(bg.astype(np.uint8)).save(out_prefix + '-bg.png')
print(f'  車が居た割合の中央値={float(np.median(occupied)):.2f}  '
      f'区画候補(30-90%の画素)={(np.logical_and(occupied>0.3, occupied<0.9)).mean()*100:.1f}%')
print(f'  -> {out_prefix}-occupied.png / -bg.png / .npz')
