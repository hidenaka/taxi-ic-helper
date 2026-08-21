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
BANDS_PATH = os.path.join(ROOT, 'data', 'noriba-bands.json')
OUT_PATH = os.path.join(ROOT, 'data', 'vehicle-count-history.jsonl')
W, H = 1024, 512
JST = timezone(timedelta(hours=9))

# 昼夜の切り分けは「空(画面上端)の明るさ」で行う。全体輝度は街灯+ゲイン補正で夜も
# 100を超え役に立たない(実測: 夜の全体輝度108-121)。空なら昼227-253/夜96-118と明確に分かれる。
# 薄暮(140-210)は両方式を回して突き合わせ材料にする。
SKY_DAY = 210     # これ以上=昼(YOLOのみ・主系yolo)
SKY_NIGHT = 140   # これ以下=夜(両方記録・主系lantern。夜YOLOは6割以上取りこぼす)

STALLS = ['stall1', 'stall2', 'stall3', 'stall4']

# 帯境界(2026-08-21 根本作り直し):
# 旧: 号ごとの転写点に直線を当て中間線を境界 → 白線と平行にならず、同じ列の車が
#     途中で別の号に割れた(本人指摘: 3号が少なく1・2号が多い)。
# 新: 境界は「白線と平行」= 行灯点の並びが最も鋭く揃う消失点(VP)を通る線。
#     位置は満杯夜のレーン・ヒストグラムの「谷」(通路)に置く = 列を絶対に割らない。
_bands = json.load(open(BANDS_PATH))
_VX, _VY = _bands['vp']
_XREF = _bands['xref']
_T_TOP = _bands['t_top']
_B12 = _bands['t_bounds']['b12']
_B23 = _bands['t_bounds']['b23']
_B34 = _bands['t_bounds']['b34']
POOL = [tuple(p) for p in _bands['pool']]


def _t_of(x, y):
    """点(x,y)とVPを結ぶ線が x=XREF で切る y。白線と平行な束のパラメータ(上ほど小)。"""
    if abs(x - _VX) < 1e-9:
        return y
    a = (y - _VY) / (x - _VX)
    return _VY + a * (_XREF - _VX)


def _in_pool(x, y):
    c = False
    n = len(POOL)
    for i in range(n):
        x1, y1 = POOL[i]
        x2, y2 = POOL[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


# 4号後列(real002)の領域: 現地ルール(2026-08-21 本人)
# 「真ん中下のカラーコーンを起点に8台までが4号。右隣は3号」
# コーンは列方向レーン峰 u=586 の真上=レーン先頭標識。領域=そのレーン(u範囲)×奥8台(t範囲)。
# 右隣(3号)は real001 で計上済みなので数えない。奥の密集列(t小)は反対側から見えている
# 他号なので数えない。
_b2 = _bands.get('real002')
if _b2:
    _VXr2, _VYr2 = _b2['vp_row']
    _XREF2 = _b2['xref']
    _VXc2, _VYc2 = _b2['vp_col']
    _YREF2 = _b2['yref']
    _U2LO, _U2HI = _b2['u_range']
    _T2LO, _T2HI = _b2['t_range']


def _t2_of(x, y):
    if abs(x - _VXr2) < 1e-9:
        return y
    a = (y - _VYr2) / (x - _VXr2)
    return _VYr2 + a * (_XREF2 - _VXr2)


def _u2_of(x, y):
    if abs(y - _VYc2) < 1e-9:
        return x
    a = (x - _VXc2) / (y - _VYc2)
    return _VXc2 + a * (_YREF2 - _VYc2)


def assign_back(cx, cy):
    """real002: コーンのレーン×奥8台の中だけ stall4_back。"""
    if not _b2:
        return None
    u = _u2_of(cx, cy)
    if u < _U2LO or u > _U2HI:
        return None
    t = _t2_of(cx, cy)
    if t < _T2LO or t > _T2HI:
        return None
    return 'stall4_back'



def assign(cx, cy):
    """検出中心 → 号。プール外/最初のレーンより上(通路等)は None。"""
    if not _in_pool(cx, cy):
        return None
    t = _t_of(cx, cy)
    if t < _T_TOP:
        return None
    if t < _B12:
        return 'stall1'
    if t < _B23:
        return 'stall2'
    if t < _B34:
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


def yolo_count(img, session, dv, assign_fn=assign, stall_keys=None):
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

    keys = stall_keys or STALLS
    raw = [b for b in tiled(2, 2, 80, 0.35) + tiled(6, 2, 60, 0.25, (80, 270)) if size_ok(*b[:4])]
    kept = dv.nms([(b[0], b[1], b[2], b[3], b[4], 2) for b in raw], 0.5)
    counts = {k: 0 for k in keys}
    ext = {k: 0 for k in keys}
    skip = 0
    for x1, y1, x2, y2, c, _ in kept:
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        st = assign_fn(cx, cy)
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

_static_mask_cache = {}


def _static_mask(cam):
    # 夜アーカイブから作った固定光源マスク(build-static-lights.py)。無ければNone
    if cam not in _static_mask_cache:
        path = os.path.join(os.path.dirname(__file__), '..', 'data', f'{cam}-static-lights.npz')
        try:
            _static_mask_cache[cam] = np.load(path)['mask']
        except Exception:
            _static_mask_cache[cam] = False
    m = _static_mask_cache[cam]
    return None if m is False else m


def lantern_count(img, assign_fn=assign, stall_keys=None, back_mode=False, cam='real001'):
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
        if size < 3 or size > (400 if back_mode else 300):
            continue
        cy, cx = float(ys.mean()), float(xs.mean())
        if max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1) > (45 if back_mode else 30):
            continue
        spots.append((cx, cy, size))
    # 固定光源(毎晩同座標に出る街灯・背景灯・常設反射)を除去。
    # 空プールの深夜に~90台の幽霊検出を出していた real001 にも適用(2026-08-22)
    sm = _static_mask(cam)
    if sm is not None:
        spots = [sp for sp in spots if not sm[int(sp[1]), int(sp[0])]]
    if back_mode:
        # 真下反射の抑制: 近いxで自分の上に光点があれば路面反射とみなす
        spots.sort(key=lambda sp: sp[1])
        kept = []
        for sp in spots:
            if not any(abs(k[0] - sp[0]) < 12 and 8 < (sp[1] - k[1]) < 90 for k in kept):
                kept.append(sp)
        spots = kept
    # 同じ車の複数光点(行灯+ブレーキ灯+反射)を車1台ぶんの半径で統合
    # back_mode: 対面ヘッドライト対+行灯を1台に潰すため横長楕円で統合し、微小単独光は捨てる
    merged = []
    used = [False] * len(spots)
    order = sorted(range(len(spots)), key=lambda i: -spots[i][2])
    for i in order:
        if used[i]:
            continue
        cx, cy, sz = spots[i]
        if back_mode:
            rx = max(14, 0.16 * cy + 6)
            ry = max(8, 0.05 * cy + 4)
        else:
            rx = ry = max(9, 0.11 * cy)
        for j in order:
            if used[j] or j == i:
                continue
            jx, jy, _ = spots[j]
            if ((jx - cx) / rx) ** 2 + ((jy - cy) / ry) ** 2 <= 1:
                used[j] = True
        used[i] = True
        if back_mode and sz < 6:
            continue
        merged.append((cx, cy))
    keys = stall_keys or STALLS
    counts = {k: 0 for k in keys}
    ext = {k: 0 for k in keys}
    skip = 0
    for cx, cy in merged:
        st = assign_fn(cx, cy)
        if st is None:
            skip += 1
            continue
        counts[st] += 1
        if cx > 700:
            ext[st] += 1
    counts['ext'] = ext
    counts['skip'] = skip
    return counts


_session_cache = [None, None]


def main():
    frame = latest_frame('real001')
    if not frame:
        print('[vehicle-count] no frame', file=sys.stderr)
        return 0
    img = Image.open(frame).convert('RGB')
    if img.size != (W, H):
        print(f'[vehicle-count] unexpected size {img.size}', file=sys.stderr)
        return 0
    gray = np.asarray(img.convert('L'), dtype=np.float32)
    brightness = float(gray.mean())
    sky = float(np.median(gray[0:28, :]))       # 空の明るさ(上端28px中央値)
    row = {
        'ts': datetime.now(JST).isoformat(timespec='seconds'),
        'frame': os.path.basename(os.path.dirname(frame)) + '/' + os.path.basename(frame),
        'brightness': round(brightness, 1),
        'sky': round(sky, 1),
    }
    is_day = sky >= SKY_DAY
    is_night = sky <= SKY_NIGHT
    run_yolo = True                              # 記録としては常に回す(夜は主系にしない)
    run_lantern = not is_day                     # 薄暮・夜は行灯も回す
    row['primary'] = 'yolo' if not is_night else 'lantern'
    if run_yolo:
        try:
            import onnxruntime as ort
            import detect_vehicles as dv
            session = ort.InferenceSession(dv.MODEL_PATH, providers=['CPUExecutionProvider'])
            _session_cache[0] = session
            _session_cache[1] = dv
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
    # 4号後列(real002)も同方式で数え、同じ行の back に入れる
    try:
        f2 = latest_frame('real002')
        if f2 and _b2:
            img2 = Image.open(f2).convert('RGB')
            if img2.size == (W, H):
                b2 = float(np.asarray(img2.convert('L'), dtype=np.float32).mean())
                back = {}
                # 昼夜判定は real001 と同じ(同じ現場の照明)
                if 'yolo' in row and _session_cache[0] is not None:
                    back['yolo'] = yolo_count(img2, _session_cache[0], _session_cache[1],
                                              assign_fn=assign_back, stall_keys=['stall4_back'])
                if run_lantern:
                    back['lantern'] = lantern_count(img2, assign_fn=assign_back, stall_keys=['stall4_back'], back_mode=True, cam='real002')
                if back:
                    row['back'] = {m: v.get('stall4_back') for m, v in back.items()}
                    row['back']['brightness'] = round(b2, 1)
    except Exception as e:
        print(f'[vehicle-count] real002 failed: {e}', file=sys.stderr)
    row['mode'] = 'both' if ('yolo' in row and 'lantern' in row) else ('yolo' if 'yolo' in row else 'lantern')
    # 表示: 主系のカウント

    with open(OUT_PATH, 'a') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
    pick = row.get(row.get('primary') or 'yolo') or row.get('yolo') or row.get('lantern')
    print('[vehicle-count]', row['mode'], f"b={row['brightness']}",
          ' '.join(f"{k[-1]}号={pick[k]}" for k in STALLS))
    return 0


if __name__ == '__main__':
    sys.exit(main())
