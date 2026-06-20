# 各スロットの「空アスファルト」構造参照を作り、現フレームとの差で占有判定する共通処理。
# 設計理由: 固定std閾値は振動・暗い車偽陰性で破綻(検証で実証)。代わりに
#  - patchを明るさ正規化(patch-mean)して構造だけ残す(照明変化に頑健)
#  - 各スロットの「空」構造参照との平均絶対差で占有判定(空≈0、車=構造違いで大)
#  - 参照は最近の最も空いたフレームから作り定期更新(天候/光に追従)
# de-risk実証: 昼連続10frame=[16,16..]安定/空0/満16/夕方暗い車も検出。
import os, glob, json
import numpy as np
from PIL import Image

PAD = 8
SZ = 2 * PAD          # 16x16
DIFF_THR = 8.0        # 空参照との平均絶対差がこれ超で占有(車あり)
DARK_GATE = 55.0      # フレーム平均輝度がこれ未満=暗すぎ(夜/夕方暗)→占有判定保留(fillへ)
N_EMPTY = 8           # 空参照に使う最も空いたフレーム数
STALLS = ["stall1", "stall2"]  # 最奥のみ。stall3/4(近距離)はfill据置。


def frame_gray(path):
    return np.asarray(Image.open(path).convert("L")).astype(float)


def _patch16(gray, cx, cy):
    H, W = gray.shape
    y0 = min(max(0, cy - PAD), H - SZ)
    x0 = min(max(0, cx - PAD), W - SZ)
    p = gray[y0:y0 + SZ, x0:x0 + SZ]
    return p - p.mean()   # 明るさ正規化(構造のみ)


def _centers(slots, W, H):
    return [(int(s["cx"] * W), int(s["cy"] * H)) for s in slots]


def avg_slot_std(gray, slots):
    H, W = gray.shape
    vals = [gray[max(0, cy - PAD):cy + PAD, max(0, cx - PAD):cx + PAD].std()
            for cx, cy in _centers(slots, W, H)]
    return float(np.mean(vals)) if vals else 0.0


def build_reference(frames, slots):
    """空frame群から各スロットの正規化patch平均(16x16)を返す。"""
    acc = [[] for _ in slots]
    for f in frames:
        g = frame_gray(f); H, W = g.shape
        for i, (cx, cy) in enumerate(_centers(slots, W, H)):
            acc[i].append(_patch16(g, cx, cy))
    return np.stack([np.mean(np.stack(a), 0) for a in acc])  # (n_slots,16,16)


def slot_occupancy(gray, slots, ref, thr=DIFF_THR):
    """空参照refとの差で占有スロット数を返す。"""
    H, W = gray.shape; n = 0
    for i, (cx, cy) in enumerate(_centers(slots, W, H)):
        if np.abs(_patch16(gray, cx, cy) - ref[i]).mean() > thr:
            n += 1
    return n


def emptiest_frames(frame_paths, slots, k=N_EMPTY):
    """frame群から最も空いた(avg_slot_std最小)k枚を返す。"""
    scored = []
    for f in frame_paths:
        try:
            scored.append((avg_slot_std(frame_gray(f), slots), f))
        except Exception:
            continue
    scored.sort(key=lambda x: x[0])
    return [f for _, f in scored[:k]]
