#!/usr/bin/env python3
"""車両フレーム間追跡 (Phase F-3)。

設計: docs/superpowers/specs/2026-05-16-vehicle-tracking-design.md

60秒間隔で Real01_line を YOLO 検出し、駐車中の車を位置ベースで
フレーム間追跡する。消えたトラック = 出庫として throughput を記録。
git 操作はしない (5分 observe-tick が出力を commit する)。
"""
import json
import math
import os
import sys
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)
from detect_vehicles import fetch_image, detect_image, MODEL_PATH

STATE_PATH = os.path.join(REPO_ROOT, 'data', 'track-state.json')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'vehicle-track-history.jsonl')
TRACK_IMAGE = 'Real01_line'
STOP_DATE = '2026-06-01'
MAX_MISSED = 2
DIST_THRESHOLD = 0.06


def update_tracks(prev_tracks, detections, next_id, max_missed, dist_threshold):
    """検出を既存トラックに位置ベースで対応付ける純関数。

    prev_tracks: [{id,x,y,w,h,missed}, ...]
    detections:  [{x,y,w,h,...}, ...]
    戻り値: {tracks, next_id, arrived, departed}
    - マッチ: 中心座標のユークリッド距離が最小かつ dist_threshold 以内
    - 未マッチ検出 → 新トラック (arrived++)
    - 未マッチトラック → missed++、missed > max_missed で消滅 (departed++)
    """
    unmatched = list(range(len(detections)))
    out_tracks = []
    arrived = 0
    departed = 0
    for tr in prev_tracks:
        best_i, best_d = None, dist_threshold
        for i in unmatched:
            d = detections[i]
            dist = math.hypot(d['x'] - tr['x'], d['y'] - tr['y'])
            if dist <= best_d:
                best_d, best_i = dist, i
        if best_i is not None:
            d = detections[best_i]
            unmatched.remove(best_i)
            out_tracks.append({'id': tr['id'], 'x': d['x'], 'y': d['y'],
                               'w': d['w'], 'h': d['h'], 'missed': 0})
        else:
            missed = tr.get('missed', 0) + 1
            if missed > max_missed:
                departed += 1
            else:
                out_tracks.append({**tr, 'missed': missed})
    for i in unmatched:
        d = detections[i]
        out_tracks.append({'id': next_id, 'x': d['x'], 'y': d['y'],
                           'w': d['w'], 'h': d['h'], 'missed': 0})
        next_id += 1
        arrived += 1
    return {'tracks': out_tracks, 'next_id': next_id, 'arrived': arrived, 'departed': departed}


def stall_rois_for_camera(stall_rois_json, camera):
    """stall-rois.json から指定カメラの stall ROI を 0-1 正規化した rect list で返す純関数。

    stall_rois_json: stall-rois.json をパースした dict。
    camera: カメラ名 (例 'real01_line')。source との一致は大文字小文字を無視。
    戻り値: [{'x','y','w','h'}, ...]。該当 stall が無ければ []。
    """
    meta = stall_rois_json.get('_meta', {})
    size = meta.get('image_size', [800, 600])
    img_w, img_h = size[0], size[1]
    rois = []
    for stall in (stall_rois_json.get('stalls') or {}).values():
        if str(stall.get('source', '')).lower() != camera.lower():
            continue
        roi = stall.get('roi') or {}
        rois.append({
            'x': roi.get('x', 0) / img_w,
            'y': roi.get('y', 0) / img_h,
            'w': roi.get('width', 0) / img_w,
            'h': roi.get('height', 0) / img_h,
        })
    return rois


def filter_to_rois(detections, rois):
    """detection の中心 (x,y) がいずれかの ROI 内のものだけ返す純関数。

    detections: [{x,y,...}, ...] (x/y は中心の 0-1 正規化座標)。
    rois: stall_rois_for_camera の戻り (正規化 rect の list)。
    rois が空なら [] を返す (ROI 不明時に全車を通さない fail-safe)。
    判定は半開区間 rx <= x < rx+rw かつ ry <= y < ry+rh。
    """
    if not rois:
        return []
    out = []
    for d in detections:
        x, y = d.get('x'), d.get('y')
        if x is None or y is None:
            continue
        for r in rois:
            # 浮動小数点誤差対応: 厳密に半開区間を判定
            x_right = r['x'] + r['w']
            y_right = r['y'] + r['h']
            # x は右端と isclose なら除外、そうでなければ < で判定
            x_in = r['x'] <= x < x_right and not math.isclose(x, x_right, rel_tol=0, abs_tol=1e-9)
            y_in = r['y'] <= y < y_right and not math.isclose(y, y_right, rel_tol=0, abs_tol=1e-9)
            if x_in and y_in:
                out.append(d)
                break
    return out


def jst_now_iso():
    """現在時刻の JST ISO 文字列 (秒精度)。"""
    return datetime.now(timezone(timedelta(hours=9))).isoformat(timespec='seconds')


def is_past_stop_date():
    """観測停止日 (STOP_DATE) 以降なら True。"""
    today = datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d')
    return today >= STOP_DATE


def load_state():
    """track-state.json を (tracks, next_id) で返す。無い・壊れていれば ([], 1)。"""
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            s = json.load(f)
        tracks = s.get('tracks', [])
        next_id = s.get('next_id', 1)
        if isinstance(tracks, list) and isinstance(next_id, int):
            return tracks, next_id
    except Exception:
        pass
    return [], 1


def save_state(tracks, next_id):
    """track-state.json を上書き保存。"""
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump({'tracks': tracks, 'next_id': next_id}, f)


def main():
    import onnxruntime as ort
    if is_past_stop_date():
        print(f'[track] STOP_DATE {STOP_DATE} reached, skip', file=sys.stderr)
        return
    if not os.path.exists(MODEL_PATH):
        print(f'ERROR: model not found: {MODEL_PATH}', file=sys.stderr)
        sys.exit(1)
    tracks, next_id = load_state()
    try:
        session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
        img = fetch_image(TRACK_IMAGE)
        detections = detect_image(session, img)
    except Exception as e:
        print(f'[track] detect failed, skip tick: {e}', file=sys.stderr)
        return
    result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
    save_state(result['tracks'], result['next_id'])
    row = {
        'schema_version': 1,
        'ts': jst_now_iso(),
        'detected': len(detections),
        'active': len(result['tracks']),
        'arrived': result['arrived'],
        'departed': result['departed'],
    }
    with open(OUTPUT_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row) + '\n')
    print(f"[track] ok: detected={row['detected']} active={row['active']} "
          f"arrived={row['arrived']} departed={row['departed']}")


if __name__ == '__main__':
    main()
