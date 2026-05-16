#!/usr/bin/env python3
"""YOLOv8 車両検出 (Phase F-1)。

設計: docs/superpowers/specs/2026-05-16-vehicle-detection-design.md

ttc.taxi-inf.jp の観測8画像を yolov8m.onnx で検出し、車両台数・box を
data/vehicle-detection-history.jsonl に追記するスタンドアロンスクリプト。
"""
import numpy as np


def iou(a, b):
    """a, b = (x1,y1,x2,y2)。IoU を返す。"""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def nms(dets, iou_threshold):
    """クラス非依存 NMS。dets = list of (x1,y1,x2,y2,conf,cls_id)。残す dets を返す。"""
    order = sorted(dets, key=lambda d: d[4], reverse=True)
    kept = []
    for d in order:
        if all(iou(d[:4], k[:4]) <= iou_threshold for k in kept):
            kept.append(d)
    return kept


def decode_yolo_output(output, conf_threshold):
    """YOLOv8 出力 [1,84,8400] をデコードする。

    戻り値: list of (cx, cy, w, h, conf, cls_id)。conf >= conf_threshold のもののみ。
    座標はモデル入力空間 (640)。
    """
    preds = output[0].T  # [N, 84]
    cls_scores = preds[:, 4:]
    cls_ids = np.argmax(cls_scores, axis=1)
    confs = cls_scores[np.arange(len(cls_ids)), cls_ids]
    dets = []
    for i in np.where(confs >= conf_threshold)[0]:
        cx, cy, w, h = preds[i, 0:4]
        dets.append((float(cx), float(cy), float(w), float(h), float(confs[i]), int(cls_ids[i])))
    return dets


def count_boxes_per_stall(boxes_by_image, stall_rois):
    """検出 box を stall ROI に振り分けてカウントする (純関数)。

    boxes_by_image: {画像名: [box,...]}。box は {x,y,...} で x/y は中心の 0-1 正規化座標。
    stall_rois: stall-rois.json の中身。
    戻り値: {stall名: 台数}。
    """
    meta = stall_rois.get('_meta', {})
    size = meta.get('image_size', [800, 600])
    img_w, img_h = size[0], size[1]
    out = {}
    for stall_name, stall in (stall_rois.get('stalls') or {}).items():
        roi = stall.get('roi') or {}
        image_name = str(stall.get('source', '')).capitalize()
        boxes = boxes_by_image.get(image_name, [])
        rx = roi.get('x', 0) / img_w
        ry = roi.get('y', 0) / img_h
        rw = roi.get('width', 0) / img_w
        rh = roi.get('height', 0) / img_h
        count = 0
        for b in boxes:
            x, y = b.get('x'), b.get('y')
            if x is None or y is None:
                continue
            if rx <= x < rx + rw and ry <= y < ry + rh:
                count += 1
        out[stall_name] = count
    return out


def build_t1t2_stalls(stall_counts, prev_stalls):
    """stall 別カウントと前 tick の t1t2_stalls から {stall名:{count,diff_from_prev}} を作る (純関数)。

    prev_stalls が無い・前 count が整数でない場合は diff_from_prev = None。
    """
    out = {}
    for stall_name, count in stall_counts.items():
        prev = (prev_stalls or {}).get(stall_name)
        prev_count = prev.get('count') if isinstance(prev, dict) else None
        diff = (count - prev_count) if isinstance(prev_count, int) else None
        out[stall_name] = {'count': count, 'diff_from_prev': diff}
    return out


# --- 以下、ネットワーク取得 + ONNX 推論 + 出力 ---

import io
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
MODEL_PATH = os.path.join(REPO_ROOT, 'models', 'yolov8m.onnx')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'vehicle-detection-history.jsonl')

TTC_BASE = 'https://ttc.taxi-inf.jp'
IMAGES = ['Real01_line', 'Real02', 'Real106', 'Real107', 'Real03', 'Real04', 'Real108', 'Real109']
INPUT_SIZE = 640
CONF_THRESHOLD = 0.30
NMS_IOU = 0.45
FETCH_TIMEOUT = 15
# COCO クラス id → 車両クラス名
VEHICLE_CLASSES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}


def jst_now_iso():
    """現在時刻の JST ISO 文字列 (秒精度)。"""
    return datetime.now(timezone(timedelta(hours=9))).isoformat(timespec='seconds')


def letterbox(img, size):
    """PIL Image を size×size にレターボックス。(NCHW float32 配列, scale, pad_x, pad_y) を返す。"""
    w, h = img.size
    scale = min(size / w, size / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new('RGB', (size, size), (114, 114, 114))
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    canvas.paste(resized, (pad_x, pad_y))
    arr = np.asarray(canvas, dtype=np.float32) / 255.0  # HWC
    arr = arr.transpose(2, 0, 1)[None, ...]  # NCHW
    return arr, scale, pad_x, pad_y


def fetch_image(name):
    """ttc から画像を取得し RGB の PIL Image を返す。"""
    url = f'{TTC_BASE}/{name}.jpg'
    req = urllib.request.Request(url, headers={'User-Agent': 'taxi-ic-helper detect'})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as res:
        return Image.open(io.BytesIO(res.read())).convert('RGB')


def detect_image(session, img):
    """PIL Image を検出し、車両 box の dict list を返す (座標は 0-1 正規化)。"""
    orig_w, orig_h = img.size
    tensor, scale, pad_x, pad_y = letterbox(img, INPUT_SIZE)
    input_name = session.get_inputs()[0].name
    output = session.run(None, {input_name: tensor})[0]  # [1,84,8400]
    raw = decode_yolo_output(output, CONF_THRESHOLD)
    # 車両クラスのみ、cx,cy,w,h → x1,y1,x2,y2 (640 空間)
    dets = []
    for cx, cy, w, h, conf, cls_id in raw:
        if cls_id not in VEHICLE_CLASSES:
            continue
        dets.append((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, conf, cls_id))
    kept = nms(dets, NMS_IOU)
    boxes = []
    for x1, y1, x2, y2, conf, cls_id in kept:
        # レターボックス逆変換 → 元画像座標 → 0-1 正規化
        ox1, oy1 = (x1 - pad_x) / scale, (y1 - pad_y) / scale
        ox2, oy2 = (x2 - pad_x) / scale, (y2 - pad_y) / scale
        boxes.append({
            'cls': VEHICLE_CLASSES[cls_id],
            'conf': round(conf, 3),
            'x': round(((ox1 + ox2) / 2) / orig_w, 4),
            'y': round(((oy1 + oy2) / 2) / orig_h, 4),
            'w': round((ox2 - ox1) / orig_w, 4),
            'h': round((oy2 - oy1) / orig_h, 4),
        })
    return boxes


def main():
    import onnxruntime as ort
    if not os.path.exists(MODEL_PATH):
        print(f'ERROR: model not found: {MODEL_PATH}', file=sys.stderr)
        sys.exit(1)
    session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    images = []
    for name in IMAGES:
        try:
            img = fetch_image(name)
            boxes = detect_image(session, img)
            images.append({'name': name, 'vehicle_count': len(boxes), 'boxes': boxes})
        except Exception as e:
            print(f'[detect] {name} failed: {e}', file=sys.stderr)
    if not images:
        print('[detect] all images failed, skip append', file=sys.stderr)
        return
    row = {'schema_version': 1, 'ts': jst_now_iso(), 'images': images}
    with open(OUTPUT_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row) + '\n')
    total = sum(im['vehicle_count'] for im in images)
    print(f'[detect] ok: {len(images)} images, {total} vehicles total')


if __name__ == '__main__':
    main()
