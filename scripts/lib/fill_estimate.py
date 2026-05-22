#!/usr/bin/env python3
"""第1/第2乗り場の埋まり具合(fill率)推定 (PIL+numpyのみ, cv2不要)。

奥(第1/第2)は遠すぎて個別スロットを分離できないため、領域全体で
「空の駐車場(背景)」との差分割合(fill率)→ ざっくり台数 を出す。
明るさを背景に正規化してから差分し、夜(暗いフレーム)は除外する。

背景は2系統:
  - 静的: lib/fill-bg-real01.png (フォールバック)
  - 適応: build_adaptive_bg() が直近の同日アーカイブから画素高%ile輝度で空アスファルトを
    自動推定 (黒タクシーは暗いので明るい側=空)。天候・光に追従し、別日背景の誤検出を解消。
設計: 2026-05-22。
"""
import json
import os
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

JST = timezone(timedelta(hours=9))


def load_fill_assets(lib_dir):
    """fill-config.json + 静的背景 + マスク を読み込む。失敗時は None。"""
    try:
        cfg = json.load(open(os.path.join(lib_dir, 'fill-config.json'), encoding='utf-8'))
        bg = np.asarray(Image.open(os.path.join(lib_dir, cfg['background'])).convert('L'), dtype=np.float32)
        stalls = {}
        for name, s in cfg['stalls'].items():
            mask = np.asarray(Image.open(os.path.join(lib_dir, s['mask'])).convert('L')) > 127
            stalls[name] = {'mask': mask, 'cap': int(s['cap']), 'full_ref': float(s['full_ref']),
                            'empty_floor': float(s.get('empty_floor', 0.0)),
                            'cam': s.get('cam', 'real01_line')}
        return {'cfg': cfg, 'bg': bg, 'bg_med': float(np.median(bg)), 'stalls': stalls,
                'size': (bg.shape[1], bg.shape[0])}
    except Exception:
        return None


def build_adaptive_bg(archive_dir, camera, now=None, hours=3, max_frames=24,
                      pct=85, night_brightness=50, min_frames=6, size=(800, 600)):
    """直近 hours 時間の同日アーカイブ(camera)から、画素 pct%ile 輝度で空アスファルト背景を作る。

    黒タクシーは暗いので高%ile=空。max_frames を時間的に均等サンプル。
    使えるフレームが min_frames 未満なら None (呼び出し側は静的背景にフォールバック)。
    戻り値: {'bg': float32[H,W], 'bg_med': float} | None
    """
    try:
        now = now or datetime.now(JST)
        day = now.strftime('%Y-%m-%d')
        d = os.path.join(archive_dir, camera, day)
        if not os.path.isdir(d):
            return None
        cutoff = (now - timedelta(hours=hours)).strftime('%H%M%S')
        files = sorted(f for f in os.listdir(d)
                       if f.endswith('.jpg') and f[:6] >= cutoff)
        if len(files) < min_frames:
            files = sorted(f for f in os.listdir(d) if f.endswith('.jpg'))  # 当日全部にゆるめる
        if len(files) < min_frames:
            return None
        step = max(1, len(files) // max_frames)
        picked = files[::step][:max_frames]
        arrs = []
        for f in picked:
            try:
                im = Image.open(os.path.join(d, f)).convert('L')
                if im.size != size:
                    im = im.resize(size)
                a = np.asarray(im, dtype=np.float32)
                if float(a.mean()) >= night_brightness:  # 昼のみ
                    arrs.append(a)
            except Exception:
                continue
        if len(arrs) < min_frames:
            return None
        bg = np.percentile(np.stack(arrs, 0), pct, axis=0).astype(np.float32)
        return {'bg': bg, 'bg_med': float(np.median(bg))}
    except Exception:
        return None


def estimate_fill(pil_img, assets, adaptive_bg=None, camera=None):
    """PIL画像 → {stall:{count,fill}}。夜/失敗時は None。

    camera 指定時はその cam の乗り場のみ処理 (Real01/Real02 を別々に呼ぶ用)。
    adaptive_bg ({'bg','bg_med'}) があれば優先、無ければ assets の静的背景。純粋関数。
    """
    if assets is None or pil_img is None:
        return None
    try:
        W, H = assets['size']
        if pil_img.size != (W, H):
            pil_img = pil_img.resize((W, H))
        g = np.asarray(pil_img.convert('L'), dtype=np.float32)
        if float(g.mean()) < assets['cfg'].get('night_brightness', 50):
            return None  # 夜は別扱い
        bg = adaptive_bg['bg'] if adaptive_bg else assets['bg']
        bg_med = adaptive_bg['bg_med'] if adaptive_bg else assets['bg_med']
        med = max(1.0, float(np.median(g)))
        g = g * (bg_med / med)                       # 明るさを背景に正規化
        binimg = np.abs(g - bg) > assets['cfg'].get('diff_threshold', 40)
        out = {}
        for name, s in assets['stalls'].items():
            if camera is not None and s.get('cam') != camera:
                continue
            area = int(s['mask'].sum())
            if area == 0:
                continue
            fr = float((binimg & s['mask']).sum()) / area
            # 空の床(empty_floor)を差し引いて 0..full_ref を 0..cap に正規化(奥の残留ノイズ対策)
            floor = s.get('empty_floor', 0.0)
            denom = max(1e-6, s['full_ref'] - floor)
            fr_adj = max(0.0, (fr - floor) / denom)
            cnt = min(int(round(fr_adj * s['cap'])), s['cap'])
            out[name] = {'count': max(0, cnt), 'fill': round(fr, 3),
                         'bg': 'adaptive' if adaptive_bg else 'static'}
        return out or None
    except Exception:
        return None
