#!/usr/bin/env python3
"""第1/第2乗り場の埋まり具合(fill率)推定 (PIL+numpyのみ, cv2不要)。

奥(第1/第2)は遠すぎて個別スロットを分離できないため、領域全体で
「空の駐車場(背景)」との差分割合(fill率)→ ざっくり台数 を出す。
明るさを背景に正規化してから差分し、夜(暗いフレーム)は除外する。
設計: 2026-05-22 校正。背景=昼アーカイブ中央値。満杯基準=昼95%ile。
"""
import json
import os

import numpy as np
from PIL import Image


def load_fill_assets(lib_dir):
    """fill-config.json + 背景 + マスク を読み込む。失敗時は None。"""
    try:
        cfg = json.load(open(os.path.join(lib_dir, 'fill-config.json'), encoding='utf-8'))
        bg = np.asarray(Image.open(os.path.join(lib_dir, cfg['background'])).convert('L'), dtype=np.float32)
        stalls = {}
        for name, s in cfg['stalls'].items():
            mask = np.asarray(Image.open(os.path.join(lib_dir, s['mask'])).convert('L')) > 127
            stalls[name] = {'mask': mask, 'cap': int(s['cap']), 'full_ref': float(s['full_ref'])}
        return {'cfg': cfg, 'bg': bg, 'bg_med': float(np.median(bg)), 'stalls': stalls,
                'size': (bg.shape[1], bg.shape[0])}
    except Exception:
        return None


def estimate_fill(pil_img, assets):
    """Real01_line の PIL画像 → {stall1:{count,fill}, stall2:{...}}。夜/失敗時は None。

    純粋関数 (画像読み込み以外の副作用なし)。
    """
    if assets is None or pil_img is None:
        return None
    try:
        W, H = assets['size']
        if pil_img.size != (W, H):
            pil_img = pil_img.resize((W, H))
        g = np.asarray(pil_img.convert('L'), dtype=np.float32)
        if float(g.mean()) < assets['cfg'].get('night_brightness', 50):
            return None  # 夜は別扱い (行灯/空のため)
        med = max(1.0, float(np.median(g)))
        g = g * (assets['bg_med'] / med)            # 明るさを背景に正規化
        diff = np.abs(g - assets['bg'])
        thr = assets['cfg'].get('diff_threshold', 32)
        binimg = diff > thr
        out = {}
        for name, s in assets['stalls'].items():
            m = s['mask']
            area = int(m.sum())
            if area == 0:
                continue
            fr = float((binimg & m).sum()) / area
            cnt = min(int(round(fr / s['full_ref'] * s['cap'])), s['cap'])
            out[name] = {'count': max(0, cnt), 'fill': round(fr, 3)}
        return out or None
    except Exception:
        return None
