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
STALL_ROIS_PATH = os.path.join(REPO_ROOT, 'scripts', 'lib', 'stall-rois.json')
# (fetch 用画像名, stall-rois.json の source キー)
TRACK_CAMERAS = [('Real01_line', 'real01_line'), ('Real02', 'real02')]
STOP_DATE = '2026-06-01'
MAX_MISSED = 2
DIST_THRESHOLD = 0.06
TRACK_STATE_SCHEMA = 3


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
            if r['x'] <= x < r['x'] + r['w'] and r['y'] <= y < r['y'] + r['h']:
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


def state_from_json(s):
    """track-state.json のパース済み dict から per-camera state dict を返す純関数。

    schema が TRACK_STATE_SCHEMA でない (旧形式・キー無し)・dict でない・
    cameras が dict でないなら {} を返す (クリーン開始)。
    """
    if not isinstance(s, dict) or s.get('schema') != TRACK_STATE_SCHEMA:
        return {}
    cameras = s.get('cameras')
    return cameras if isinstance(cameras, dict) else {}


def camera_state(cameras, camera):
    """per-camera state dict から指定カメラの (tracks, next_id) を返す純関数。

    cameras が dict でない・camera キーが無い・camera 値が dict でない・
    tracks が list でない・next_id が int でないなら ([], 1)。
    """
    if not isinstance(cameras, dict):
        return [], 1
    cam = cameras.get(camera)
    if not isinstance(cam, dict):
        return [], 1
    tracks = cam.get('tracks', [])
    next_id = cam.get('next_id', 1)
    if isinstance(tracks, list) and isinstance(next_id, int):
        return tracks, next_id
    return [], 1


def load_state():
    """track-state.json を per-camera state dict で返す。無い・壊れていれば {}。"""
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            return state_from_json(json.load(f))
    except Exception:
        return {}


def save_state(cameras):
    """track-state.json を per-camera state で上書き保存 (schema マーカー付き)。"""
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump({'schema': TRACK_STATE_SCHEMA, 'cameras': cameras}, f)


def main():
    import onnxruntime as ort
    if is_past_stop_date():
        print(f'[track] STOP_DATE {STOP_DATE} reached, skip', file=sys.stderr)
        return
    if not os.path.exists(MODEL_PATH):
        print(f'ERROR: model not found: {MODEL_PATH}', file=sys.stderr)
        sys.exit(1)
    cameras = load_state()
    try:
        session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
        with open(STALL_ROIS_PATH, 'r', encoding='utf-8') as f:
            stall_rois_json = json.load(f)
        new_cameras = {}
        row_cameras = {}
        for image_name, camera_key in TRACK_CAMERAS:
            tracks, next_id = camera_state(cameras, camera_key)
            img = fetch_image(image_name)
            raw_detections = detect_image(session, img)
            rois = stall_rois_for_camera(stall_rois_json, camera_key)
            detections = filter_to_rois(raw_detections, rois)
            result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
            new_cameras[camera_key] = {
                'tracks': result['tracks'], 'next_id': result['next_id'],
            }
            row_cameras[camera_key] = {
                'detected': len(detections),
                'active': len(result['tracks']),
                'arrived': result['arrived'],
                'departed': result['departed'],
            }
    except Exception as e:
        print(f'[track] detect/roi failed, skip tick: {e}', file=sys.stderr)
        return
    save_state(new_cameras)
    row = {'schema_version': 3, 'ts': jst_now_iso(), 'cameras': row_cameras}
    with open(OUTPUT_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row) + '\n')
    summary = ' '.join(
        f"{k}(d={v['detected']},a={v['active']},in={v['arrived']},out={v['departed']})"
        for k, v in row_cameras.items())
    print(f'[track] ok: {summary}')


if __name__ == '__main__':
    main()
