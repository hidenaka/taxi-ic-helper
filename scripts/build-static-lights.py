#!/usr/bin/env python3
# 静的光源マスク生成(両カメラ)。夜フレーム(空<=140)を約30分おきにサンプルし、
# 輝点マスクの発火頻度>=0.6のピクセル=固定光(街灯・背景灯・常設路面反射)。
# real001は空プール時間帯(1-5時)も含まれるため、車由来のピクセルは頻度が上がらない。
import glob
import sys
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

def build(cam, thr_freq=0.6):
    files = sorted(glob.glob(f'/Users/nakanohideaki/taxi-image-archive/{cam}/*/*.jpg'))
    picked = []
    last = ''
    for f in files:
        key = f.split('/')[-2] + f.split('/')[-1][:3]
        if key[-1] in '036' and key != last:  # 00/30分台のみ ≒30分粒度
            picked.append(f); last = key
    acc = None
    n = 0
    for f in picked:
        img = Image.open(f).convert('L')
        if img.size != (1024, 512):
            continue
        a = np.asarray(img, dtype=np.float32)
        if float(np.median(a[0:28, :])) > 140:  # 夜のみ
            continue
        m = spot_mask(a)
        acc = m.astype(np.float32) if acc is None else acc + m
        n += 1
    freq = acc / n
    static = freq >= thr_freq
    s2 = static.copy()
    for dy in (-2, -1, 0, 1, 2):
        for dx in (-2, -1, 0, 1, 2):
            s2 |= np.roll(np.roll(static, dy, 0), dx, 1)
    out = f'/Users/nakanohideaki/repos/taxi-ic-helper/data/{cam}-static-lights.npz'
    np.savez_compressed(out, mask=s2, n=n)
    print(f'{cam}: 夜サンプル{n}枚 静的ピクセル{int(s2.sum())} -> {out}')

for cam in (sys.argv[1:] or ['real001', 'real002']):
    build(cam)
