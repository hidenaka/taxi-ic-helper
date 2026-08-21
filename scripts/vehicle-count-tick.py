#!/usr/bin/env python3
# 号別の実台数カウント tick (新カメラ real001/real002・2026-08-21〜)
#
# 2026-08-20 のカメラ総入れ替えで旧・占有モデル(旧画角で学習)が使えなくなった代わりに、
# 画質が上がった新カメラで「車そのもの」を数える:
#   昼(明るい): タイル分割 YOLO。全体1回だと奥の小さい車を取りこぼす(実測 16台 vs 138台)。
#   夜(暗い)  : 行灯の光点カウント(トップハット+車1台ぶんの半径でクラスタ統合)。
#   薄暮      : 両方を実行して両方記録する(方式間のズレを毎日夕方に自動で検算できる)。
#
# 号割り当ては「帯構造」(奥から 1号→2号→3号→4号 / 2026-05-22保存のルール画像と一致):
# 各号の区画点(ホモグラフィ転写)に直線を当て、隣り合う帯の中間線を境界にする。
# 右側の拡張エリア(待機所拡張)も同じ帯の延長として数え、ext に内訳を残す。
#
# 出力: data/vehicle-count-history.jsonl に1行/tick
#   {ts, mode, brightness, yolo:{stall1..4,ext,skip}, lantern:{...}}  (走らせた方式のみ)

import glob
import json
import os
import sys
from datetime import datetime, timezone, timedelta

import numpy as np
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)
ARCHIVE = os.path.expanduser('~/taxi-image-archive')
LANES_PATH = os.path.join(ROOT, 'data', 'noriba-lanes-new-draft.json')
OUT_PATH = os.path.join(ROOT, 'data', 'vehicle-count-history.jsonl')
W, H = 1024, 512
JST = timezone(timedelta(hours=9))

# 昼夜の切り分け(シーン平均輝度)。中間帯は両方式を回して突き合わせ材料にする
DAY_MIN = 80
NIGHT_MAX = 55

STALLS = ['stall1', 'stall2', 'stall3', 'stall4']

_lanes = json.load(open(LANES_PATH))


def _fit(st):
    pts = np.array(_lanes[st]) * [W, H]
    A = np.stack([pts[:, 0], np.ones(len(pts))], 1)
    a, b = np.linalg.lstsq(A, pts[:, 1], rcond=None)[0]
    return float(a), float(b)


_L = {st: _fit(st) for st in STALLS}


def _yat(st, x):
    a, b = _L[st]
    return a * x + b


def _boundaries(x):
    y1, y2, y3, y4 = (_yat('stall1', x), _yat('stall2', x), _yat('stall3', x), _yat('stall4', x))
    return y1 - (y2 - y1) / 2, (y1 + y2) / 2, (y2 + y3) / 2, (y3 + y4) / 2


# プール外周(real001・目視で確定)。上=植栽/フェンス、左=小屋前通路、右=植栽。
POOL = [(95, 300), (150, 148), (250, 130), (700, 128), (940, 148), (985, 300), (985, 511), (95, 511)]


def _in_pool(x, y):
    c = False
    n = len(POOL)
    for i in range(n):
        x1, y1 = POOL[i]
        x2, y2 = POOL[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def assign(cx, cy):
    """検出中心 → 号。プール外/1号帯より上(通路・外周駐車)は None。"""
    if not _in_pool(cx, cy):
        return None
    top, b12, b23, b34 = _boundaries(cx)
    if cy < top:
        return None
    if cy < b12:
        return 'stall1'
    if cy < b23:
        return 'stall2'
    if cy < b34:
        return 'stall3'
    return 'stall4'


def latest_frame(cam):
    days = sorted(glob.glob(os.path.join(ARCHIVE, cam, '*')))
    for d in reversed(days):
        fs = sorted(glob.glob(os.path.join(d, '*.jpg')))
        if fs:
            return fs[-1]
    return None


# ---- 昼: タイルYOLO ---------------------------------------------------------

def size_ok(x1, y1, x2, y2):
    # その y(手前ほど大きい)であり得る車幅か。白線・影の誤検出を落とす
    w = x2 - x1
    cy = (y1 + y2) / 2
    wmin = max(18, 0.30 * cy - 22)
    return wmin <= w <= wmin * 4.5


def yolo_count(img, session, dv):
    def detect_px(crop, conf):
        # detect_image の座標は「渡した画像」基準の0-1。必ずクロップ自身の寸法で戻す
        w, h = crop.size
        return [((b['x'] - b['w'] / 2) * w, (b['y'] - b['h'] / 2) * h,
                 (b['x'] + b['w'] / 2) * w, (b['y'] + b['h'] / 2) * h, b['conf'])
                for b in dv.detect_image(session, crop, conf)]

    def tiled(nx, ny, ov, conf, yr=None):
        ylo, yhi = (0, H) if yr is None else yr
        out = []
        tw = (W + (nx - 1) * ov) // nx
        th = ((yhi - ylo) + (ny - 1) * ov) // ny
        for iy in range(ny):
            for ix in range(nx):
                x0 = max(0, ix * (tw - ov))
                y0 = max(ylo, ylo + iy * (th - ov))
                x1 = min(W, x0 + tw)
                y1 = min(yhi, y0 + th)
                if x1 - x0 < 60 or y1 - y0 < 60:
                    continue
                for bx1, by1, bx2, by2, c in detect_px(img.crop((x0, y0, x1, y1)), conf):
                    out.append((bx1 + x0, by1 + y0, bx2 + x0, by2 + y0, c))
        return out

    raw = [b for b in tiled(2, 2, 80, 0.35) + tiled(6, 2, 60, 0.25, (80, 270)) if size_ok(*b[:4])]
    kept = dv.nms([(b[0], b[1], b[2], b[3], b[4], 2) for b in raw], 0.5)
    counts = {k: 0 for k in STALLS}
    ext = {k: 0 for k in STALLS}
    skip = 0
    for x1, y1, x2, y2, c, _ in kept:
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        st = assign(cx, cy)
        if st is None:
            skip += 1
            continue
        counts[st] += 1
        if cx > 700:
            ext[st] += 1
    counts['ext'] = ext
    counts['skip'] = skip
    return counts


# ---- 夜: 行灯光点 -----------------------------------------------------------

def lantern_count(img):
    a = np.asarray(img.convert('L'), dtype=np.float32)
    ii = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), axis=0), axis=1)
    r = 12
    Hh, Ww = a.shape
    y0 = np.clip(np.arange(Hh) - r, 0, Hh)
    y1 = np.clip(np.arange(Hh) + r + 1, 0, Hh)
    x0 = np.clip(np.arange(Ww) - r, 0, Ww)
    x1 = np.clip(np.arange(Ww) + r + 1, 0, Ww)
    Y0, X0 = np.meshgrid(y0, x0, indexing='ij')
    Y1, X1 = np.meshgrid(y1, x1, indexing='ij')
    bg = (ii[Y1, X1] - ii[Y0, X1] - ii[Y1, X0] + ii[Y0, X0]) / np.maximum((Y1 - Y0) * (X1 - X0), 1)
    m = (a - bg > 55) & (a > 170)
    lbl = np.zeros(a.shape, dtype=np.int32)
    cur = 0
    stack = []
    for yy in range(Hh):
        for xx in range(Ww):
            if m[yy, xx] and lbl[yy, xx] == 0:
                cur += 1
                stack.append((yy, xx))
                lbl[yy, xx] = cur
                while stack:
                    cy, cx = stack.pop()
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < Hh and 0 <= nx < Ww and m[ny, nx] and lbl[ny, nx] == 0:
                            lbl[ny, nx] = cur
                            stack.append((ny, nx))
    spots = []
    for i in range(1, cur + 1):
        ys, xs = np.where(lbl == i)
        size = len(ys)
        if size < 3 or size > 300:
            continue
        cy, cx = float(ys.mean()), float(xs.mean())
        if max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1) > 30:
            continue
        spots.append((cx, cy, size))
    # 同じ車の複数光点(行灯+ブレーキ灯+反射)を車1台ぶんの半径で統合
    merged = []
    used = [False] * len(spots)
    order = sorted(range(len(spots)), key=lambda i: -spots[i][2])
    for i in order:
        if used[i]:
            continue
        cx, cy, sz = spots[i]
        rad = max(9, 0.11 * cy)
        for j in order:
            if used[j] or j == i:
                continue
            jx, jy, _ = spots[j]
            if (jx - cx) ** 2 + (jy - cy) ** 2 <= rad * rad:
                used[j] = True
        used[i] = True
        merged.append((cx, cy))
    counts = {k: 0 for k in STALLS}
    ext = {k: 0 for k in STALLS}
    skip = 0
    for cx, cy in merged:
        st = assign(cx, cy)
        if st is None:
            skip += 1
            continue
        counts[st] += 1
        if cx > 700:
            ext[st] += 1
    counts['ext'] = ext
    counts['skip'] = skip
    return counts


def main():
    frame = latest_frame('real001')
    if not frame:
        print('[vehicle-count] no frame', file=sys.stderr)
        return 0
    img = Image.open(frame).convert('RGB')
    if img.size != (W, H):
        print(f'[vehicle-count] unexpected size {img.size}', file=sys.stderr)
        return 0
    brightness = float(np.asarray(img.convert('L'), dtype=np.float32).mean())
    row = {
        'ts': datetime.now(JST).isoformat(timespec='seconds'),
        'frame': os.path.basename(os.path.dirname(frame)) + '/' + os.path.basename(frame),
        'brightness': round(brightness, 1),
    }
    run_yolo = brightness >= NIGHT_MAX          # 夜すぎなければ YOLO は回す
    run_lantern = brightness <= DAY_MIN         # 昼すぎなければ行灯も回す(薄暮は両方)
    if run_yolo:
        try:
            import onnxruntime as ort
            import detect_vehicles as dv
            session = ort.InferenceSession(dv.MODEL_PATH, providers=['CPUExecutionProvider'])
            row['yolo'] = yolo_count(img, session, dv)
        except Exception as e:
            print(f'[vehicle-count] yolo failed: {e}', file=sys.stderr)
    if run_lantern:
        try:
            row['lantern'] = lantern_count(img)
        except Exception as e:
            print(f'[vehicle-count] lantern failed: {e}', file=sys.stderr)
    if 'yolo' not in row and 'lantern' not in row:
        return 0
    row['mode'] = 'both' if ('yolo' in row and 'lantern' in row) else ('yolo' if 'yolo' in row else 'lantern')
    with open(OUT_PATH, 'a') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
    pick = row.get('yolo') or row.get('lantern')
    print('[vehicle-count]', row['mode'], f"b={row['brightness']}",
          ' '.join(f"{k[-1]}号={pick[k]}" for k in STALLS))
    return 0


if __name__ == '__main__':
    sys.exit(main())
