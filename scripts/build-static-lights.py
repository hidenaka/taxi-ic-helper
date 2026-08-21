#!/usr/bin/env python3
# real002 の静的光源マスクを作る。アーカイブの夜フレーム(空<=140)を30分おきにサンプルし、
# 輝点マスクが発火する頻度をピクセル単位で集計。頻度>=0.6 = 固定光(背景灯・常設反射)。
import glob
import numpy as np
from PIL import Image

def spot_mask(a, thr_abs=170, thr_top=55):
    ii = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), axis=0), axis=1)
    r = 12
    Hh, Ww = a.shape
    y0 = np.clip(np.arange(Hh) - r, 0, Hh); y1 = np.clip(np.arange(Hh) + r + 1, 0, Hh)
    x0 = np.clip(np.arange(Ww) - r, 0, Ww); x1 = np.clip(np.arange(Ww) + r + 1, 0, Ww)
    Y0, X0 = np.meshgrid(y0, x0, indexing='ij'); Y1, X1 = np.meshgrid(y1, x1, indexing='ij')
    bg = (ii[Y1, X1] - ii[Y0, X1] - ii[Y1, X0] + ii[Y0, X0]) / np.maximum((Y1 - Y0) * (X1 - X0), 1)
    return (a - bg > thr_top) & (a > thr_abs)

files = sorted(glob.glob('/Users/nakanohideaki/taxi-image-archive/real002/*/*.jpg'))
# 30分おきにサンプル
picked = []
last = ''
for f in files:
    key = f.split('/')[-2] + f.split('/')[-1][:3]  # 日付+時+10分位 → 約10分粒度
    if key[-1] in '036' and key != last:           # 00,30分台
        picked.append(f); last = key

acc = None
n = 0
for f in picked:
    img = Image.open(f).convert('L')
    if img.size != (1024, 512):
        continue
    a = np.asarray(img, dtype=np.float32)
    sky = float(np.median(a[0:28, :]))
    if sky > 140:   # 夜フレームのみ
        continue
    m = spot_mask(a)
    acc = m.astype(np.float32) if acc is None else acc + m
    n += 1
print(f'夜サンプル {n}枚')
freq = acc / n
static = freq >= 0.6
# 少し膨張(2px)
s2 = static.copy()
for dy in (-2, -1, 0, 1, 2):
    for dx in (-2, -1, 0, 1, 2):
        s2 |= np.roll(np.roll(static, dy, 0), dx, 1)
np.savez_compressed('/Users/nakanohideaki/repos/taxi-ic-helper/data/real002-static-lights.npz',
                    mask=s2, n=n)
print(f'静的ピクセル {int(s2.sum())} / {s2.size} 保存済')
