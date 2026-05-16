# YOLOv8 車両検出 実装プラン (Phase F-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `models/yolov8m.onnx` を使い、毎 tick で観測8画像の車両を検出・台数カウントし、独立した新ファイル `data/vehicle-detection-history.jsonl` に並行収集する。

**Architecture:** スタンドアロン Python スクリプト `scripts/detect_vehicles.py` を `observe-tick-local.sh` から並行ステップ (`|| true`) として呼ぶ。YOLO 出力のデコード + NMS は純関数化し Python `unittest` でテスト。`observe-taxi-pool.mjs` / 既存 forecast 系 / E-1 は不変。Python 依存はプロジェクトローカル venv に隔離。

**Tech Stack:** Python 3 / `onnxruntime` / `numpy` / `pillow` / Python `unittest` / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-vehicle-detection-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `requirements.txt` | Create | Python 依存 (`onnxruntime` / `numpy` / `pillow`) |
| `scripts/detect_vehicles.py` | Create | YOLOv8m 推論で8画像を検出 → `vehicle-detection-history.jsonl` 追記。純関数 `iou` / `nms` / `decode_yolo_output` / `letterbox` |
| `tests/test_detect_vehicles.py` | Create | `iou` / `nms` / `decode_yolo_output` の `unittest` テスト |
| `data/vehicle-detection-history.jsonl` | Create (生成物) | 検出ログ (append-only) |
| `scripts/observe-tick-local.sh` | Modify | 検出ステップ追加 + git add 対象に新ファイル |
| `.gitignore` | Modify | `.venv/` と `models/` を追加 |
| `.gitattributes` | Modify | `vehicle-detection-history.jsonl merge=union` |

注: Python スクリプトはモジュール import のためファイル名にハイフン不可。`detect_vehicles.py` (アンダースコア) とする。`node --test` は `.py` を実行しないため `npm test` (407 件) には影響しない。Python テストは `python3 -m unittest` で別途実行。

実装順序: **venv セットアップ → 純関数 (TDD) → I/O + main → 配線 → 最終整合 + push**。

---

## Task 1: Python venv セットアップ

**Files:**
- Create: `requirements.txt`
- Modify: `.gitignore`

- [ ] **Step 1.1: `requirements.txt` を作成**

`requirements.txt` の内容:

```
onnxruntime
numpy
pillow
```

- [ ] **Step 1.2: `.gitignore` に `.venv/` を追加**

`.gitignore` の変更前:

```
__pycache__/
data/arrivals-snapshots/
data/forecast-log.jsonl
```

変更後:

```
__pycache__/
data/arrivals-snapshots/
data/forecast-log.jsonl
.venv/
```

- [ ] **Step 1.3: venv を作成して依存をインストール**

リポジトリルート (`乗務地図関係/`) で実行:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

期待: `onnxruntime` / `numpy` / `pillow` がインストールされる (venv 内なので PEP 668 の外部管理エラーを回避)。

- [ ] **Step 1.4: import 確認**

```bash
.venv/bin/python3 -c "import onnxruntime, numpy, PIL; print('imports OK')"
```

期待: `imports OK`。

- [ ] **Step 1.5: commit**

```bash
git add requirements.txt .gitignore
git commit -m "chore(detect): add Python venv requirements for YOLO detection"
```

---

## Task 2: `detect_vehicles.py` の純関数 (TDD)

**Files:**
- Create: `scripts/detect_vehicles.py`
- Create: `tests/test_detect_vehicles.py`

- [ ] **Step 2.1: 失敗テストを作成**

`tests/test_detect_vehicles.py` の内容:

```python
import sys
import os
import unittest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from detect_vehicles import iou, nms, decode_yolo_output


class TestIou(unittest.TestCase):
    def test_no_overlap(self):
        self.assertEqual(iou((0, 0, 10, 10), (20, 20, 30, 30)), 0.0)

    def test_identical(self):
        self.assertEqual(iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)

    def test_half_overlap(self):
        # a=(0,0,10,10) area100, b=(5,0,15,10) area100, inter=5*10=50, union=150
        self.assertAlmostEqual(iou((0, 0, 10, 10), (5, 0, 15, 10)), 50 / 150)


class TestNms(unittest.TestCase):
    def test_suppresses_overlap(self):
        dets = [(0, 0, 10, 10, 0.9, 2), (1, 1, 11, 11, 0.8, 2)]  # 高 IoU
        kept = nms(dets, 0.45)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0][4], 0.9)  # 高 conf が残る

    def test_keeps_distinct(self):
        dets = [(0, 0, 10, 10, 0.9, 2), (50, 50, 60, 60, 0.8, 2)]
        kept = nms(dets, 0.45)
        self.assertEqual(len(kept), 2)


class TestDecode(unittest.TestCase):
    def test_threshold_filters(self):
        # output [1,84,2]: anchor0 はクラス2 を 0.9、anchor1 は 0.1 (しきい値未満)
        out = np.zeros((1, 84, 2), dtype=np.float32)
        out[0, 0:4, 0] = [100, 100, 20, 20]
        out[0, 4 + 2, 0] = 0.9
        out[0, 0:4, 1] = [200, 200, 20, 20]
        out[0, 4 + 2, 1] = 0.1
        dets = decode_yolo_output(out, 0.30)
        self.assertEqual(len(dets), 1)
        self.assertEqual(dets[0][5], 2)  # cls_id
        self.assertAlmostEqual(dets[0][4], 0.9, places=5)  # conf
        self.assertEqual(dets[0][0], 100.0)  # cx


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

Expected: FAIL (`ModuleNotFoundError: No module named 'detect_vehicles'`)

- [ ] **Step 2.3: `detect_vehicles.py` の純関数部分を作成**

`scripts/detect_vehicles.py` の内容:

```python
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
```

- [ ] **Step 2.4: テスト実行 → パス**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

Expected: PASS (`Ran 6 tests` / `OK`)

- [ ] **Step 2.5: commit**

```bash
git add scripts/detect_vehicles.py tests/test_detect_vehicles.py
git commit -m "feat(detect): add iou/nms/decode_yolo_output pure functions"
```

---

## Task 3: `detect_vehicles.py` の I/O + 推論 + main

**Files:**
- Modify: `scripts/detect_vehicles.py`

- [ ] **Step 3.1: 推論・取得・main を追加**

`scripts/detect_vehicles.py` の末尾 (`decode_yolo_output` の後) に追加:

```python


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
```

- [ ] **Step 3.2: 構文チェック**

```bash
.venv/bin/python3 -m py_compile scripts/detect_vehicles.py && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 3.3: 純関数テスト再実行 (回帰確認)**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

期待: PASS (6 件)。I/O 追加で純関数テストが壊れないこと。

- [ ] **Step 3.4: 単発実行 → 検出ログ生成確認**

```bash
.venv/bin/python3 scripts/detect_vehicles.py
python3 -c "
import json
row = json.loads(open('data/vehicle-detection-history.jsonl').readlines()[-1])
print('schema_version:', row['schema_version'])
print('images:', [(im['name'], im['vehicle_count']) for im in row['images']])
b = row['images'][0]['boxes']
print('sample box:', b[0] if b else 'none')
"
```

期待: `[detect] ok: 8 images, <N> vehicles total` (推論に十数秒)。`schema_version: 1`、8 画像それぞれに `vehicle_count`、サンプル box に `cls`/`conf`/`x`/`y`/`w`/`h` (0-1 範囲)。

- [ ] **Step 3.5: commit**

```bash
git add scripts/detect_vehicles.py data/vehicle-detection-history.jsonl
git commit -m "feat(detect): YOLOv8 inference + vehicle-detection-history.jsonl output"
```

---

## Task 4: 配線 (observe-tick-local.sh / .gitignore / .gitattributes)

**Files:**
- Modify: `scripts/observe-tick-local.sh`
- Modify: `.gitignore`
- Modify: `.gitattributes`

- [ ] **Step 4.1: `observe-tick-local.sh` に検出ステップを追加**

変更前:

```bash
node scripts/observe-taxi-pool.mjs
NODE_EXIT=$?
if [ "$NODE_EXIT" -ne 0 ]; then
  echo "[observe-tick] observe script exit $NODE_EXIT, abort tick"
  exit 0
fi
```

変更後:

```bash
node scripts/observe-taxi-pool.mjs
NODE_EXIT=$?
if [ "$NODE_EXIT" -ne 0 ]; then
  echo "[observe-tick] observe script exit $NODE_EXIT, abort tick"
  exit 0
fi

# Phase F-1: YOLOv8 車両検出 (並行・fail-safe。venv が無い/失敗しても tick は継続)
if [ -x .venv/bin/python3 ]; then
  .venv/bin/python3 scripts/detect_vehicles.py || true
else
  echo "[observe-tick] .venv not found, skip vehicle detection"
fi
```

- [ ] **Step 4.2: `observe-tick-local.sh` の git add 対象に新ファイルを追加**

変更前:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl 2>/dev/null || true
```

変更後:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl 2>/dev/null || true
```

- [ ] **Step 4.3: `.gitignore` に `models/` を追加**

`.gitignore` の変更前:

```
.venv/
```

変更後:

```
.venv/
models/
```

- [ ] **Step 4.4: `.gitattributes` に merge=union を追加**

`.gitattributes` の変更前:

```
data/taxi-pool-history.jsonl merge=union
data/t3-pool-history.jsonl merge=union
```

変更後:

```
data/taxi-pool-history.jsonl merge=union
data/t3-pool-history.jsonl merge=union
data/vehicle-detection-history.jsonl merge=union
```

- [ ] **Step 4.5: 構文チェック**

```bash
bash -n scripts/observe-tick-local.sh && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 4.6: commit**

```bash
git add scripts/observe-tick-local.sh .gitignore .gitattributes
git commit -m "chore(detect): wire detect_vehicles into observe-tick + gitignore models"
```

---

## Task 5: 最終整合 + push

- [ ] **Step 5.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `requirements.txt`
- `scripts/detect_vehicles.py`
- `tests/test_detect_vehicles.py`
- `data/vehicle-detection-history.jsonl`
- `scripts/observe-tick-local.sh`
- `.gitignore`
- `.gitattributes`
- (docs の spec / plan)

`observe-taxi-pool.mjs` / `correction-engine.mjs` / `aux-observation.mjs` / `forecast-engine.mjs` / `taxi-pool-history.jsonl` / `t3-pool-history.jsonl` は含まれないこと。`models/yolov8m.onnx` がコミット対象に入っていないこと (gitignore 済)。

- [ ] **Step 5.2: Python テスト最終パス**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

期待: PASS (6 件)。

- [ ] **Step 5.3: node テスト回帰なし確認**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 407 件パス、fail 0 (Python 追加は node:test に影響しない)。

- [ ] **Step 5.4: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

autostash 適用でコンフリクトが出た場合は **`git reset --hard` を使わないこと**。再生成系 JSON (`data/stall-*.json` / `data/forecast-accuracy.json` / `data/coefficient-corrections.json`) のみ `git checkout HEAD --` で破棄。append-only の `data/taxi-pool-history.jsonl` / `data/t3-pool-history.jsonl` / `data/vehicle-detection-history.jsonl` の未コミット観測行は working tree に残す。再生成系 JSON が `UU` でなく rebase コミット適用で衝突した場合は `git checkout --theirs <file>` で解決し `git add` → `git rebase --continue`。解決後、autostash を `git stash drop`。

- [ ] **Step 5.5: push (3 回までリトライ)**

```bash
for i in 1 2 3; do
  if git push origin main; then
    echo "[push ok attempt $i]"
    break
  fi
  echo "[retry $i]"
  git pull --rebase --autostash origin main
  sleep 2
done
```

- [ ] **Step 5.6: 完了報告**

最終状態を要約。Mac mini 側は次 tick 前に **(1) `git pull`、(2) `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`、(3) `models/yolov8m.onnx` を配置** が必要 (gitignore のため model は git で配られない)。これらが揃えば次 tick から検出が走る。揃わなくても `|| true` / venv チェックで既存観測は無傷。

---

## 検証コマンド一覧 (チートシート)

```bash
# Python テスト
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py

# 単発実行
.venv/bin/python3 scripts/detect_vehicles.py

# 生成ログ最終行
python3 -c "import json; print(json.dumps(json.loads(open('data/vehicle-detection-history.jsonl').readlines()[-1]), indent=2, ensure_ascii=False))"

# node テスト (回帰確認)
npm test
```

---

## 完了条件 (再掲)

- [ ] `scripts/detect_vehicles.py` が8画像を YOLOv8m で検出し `data/vehicle-detection-history.jsonl` に schema v1 の行を追記する
- [ ] 行は `images` 配列を持ち、各エントリに `name` / `vehicle_count` / `boxes`、box 座標は 0-1 正規化
- [ ] `iou` / `nms` / `decode_yolo_output` に `unittest` テストがある (6 件パス)
- [ ] `observe-tick-local.sh` に検出ステップが venv チェック + `|| true` 付きで配線、git add 対象に新ファイル
- [ ] `.gitignore` に `.venv/` と `models/`、`.gitattributes` に新ファイルの merge=union
- [ ] `requirements.txt` がある
- [ ] `npm test` 407 件パス (回帰なし)
- [ ] `observe-taxi-pool.mjs` / `taxi-pool-history.jsonl` / 既存 forecast・accuracy・ensemble・correction・E-1 は不変
- [ ] `models/yolov8m.onnx` は git にコミットされない
