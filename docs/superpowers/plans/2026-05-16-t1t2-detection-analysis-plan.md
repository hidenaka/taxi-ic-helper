# T1/T2 検出ベース並行占有分析 実装プラン (Phase F-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F-1 の YOLO 検出 box から `stall-rois.json` の ROI で T1/T2 stall 別車両台数を算出し、`vehicle-detection-history.jsonl` に `t1t2_stalls`（schema v2）として並行記録する。

**Architecture:** `detect_vehicles.py` に純関数 `count_boxes_per_stall` / `build_t1t2_stalls` を追加し、`main()` で stall 別カウント + 前 tick 差分を行に付与。黒比率 `analyzeStalls`（observe-taxi-pool.mjs）は不変 — 2系統が並走。

**Tech Stack:** Python 3 / `onnxruntime` / `numpy` / Python `unittest`

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-t1t2-detection-analysis-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/detect_vehicles.py` | Modify | `count_boxes_per_stall` / `build_t1t2_stalls` / `read_last_history_row` 追加、`main()` で `t1t2_stalls` 付与、`schema_version` → 2 |
| `tests/test_detect_vehicles.py` | Modify | `count_boxes_per_stall` / `build_t1t2_stalls` のテスト追加 |

`stall-rois.json`（`scripts/lib/stall-rois.json`）は読むだけ・不変。`observe-taxi-pool.mjs` / `taxi-pool-history.jsonl` も不変。

実装順序: **純関数 + テスト先行（TDD）→ main 統合 + 単発実行 → 最終整合 + push**。

前提（F-1 で確認済み）:
- `detect_vehicles.py` に `MODEL_PATH` / `OUTPUT_PATH` / `REPO_ROOT` / `jst_now_iso` / `fetch_image` / `detect_image` / `main` がある。
- 検出 box は `{cls, conf, x, y, w, h}`（`x`/`y` は中心の 0-1 正規化座標）。
- `stall-rois.json` 構造: `{_meta:{image_size:[800,600]}, stalls:{stallN:{source, roi:{x,y,width,height}}}}`。`source` は `real01_line` / `real02`。

---

## Task 1: `count_boxes_per_stall` + `build_t1t2_stalls` 純関数 (TDD)

**Files:**
- Modify: `scripts/detect_vehicles.py`
- Modify: `tests/test_detect_vehicles.py`

- [ ] **Step 1.1: テストを追加**

`tests/test_detect_vehicles.py` の末尾（`if __name__ == '__main__':` の**前**）に追加:

```python

# --- Phase F-2: T1/T2 stall 別カウント ---

from detect_vehicles import count_boxes_per_stall, build_t1t2_stalls


def _box(x, y):
    return {'cls': 'car', 'conf': 0.8, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05}


STALL_ROIS_FIXTURE = {
    '_meta': {'image_size': [800, 600]},
    'stalls': {
        # stall1 正規化: x∈[0.75,1.0) y∈[0.1333,0.4167)
        'stall1': {'source': 'real01_line', 'roi': {'x': 600, 'y': 80, 'width': 200, 'height': 170}},
        # stall4 正規化: x∈[0.5,1.0) y∈[0.0,0.4167)
        'stall4': {'source': 'real02', 'roi': {'x': 400, 'y': 0, 'width': 400, 'height': 250}},
    },
}


class TestCountBoxesPerStall(unittest.TestCase):
    def test_box_inside_roi_counted(self):
        bbi = {'Real01_line': [_box(0.8, 0.2)], 'Real02': []}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 1)
        self.assertEqual(r['stall4'], 0)

    def test_box_outside_roi_not_counted(self):
        bbi = {'Real01_line': [_box(0.1, 0.2)], 'Real02': []}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 0)

    def test_source_isolation(self):
        # Real02 の box は stall1 (source real01_line) に入らない / stall4 (source real02) に入る
        bbi = {'Real01_line': [], 'Real02': [_box(0.8, 0.2)]}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 0)
        self.assertEqual(r['stall4'], 1)

    def test_no_boxes(self):
        r = count_boxes_per_stall({'Real01_line': [], 'Real02': []}, STALL_ROIS_FIXTURE)
        self.assertEqual(r, {'stall1': 0, 'stall4': 0})

    def test_multiple_boxes(self):
        bbi = {'Real01_line': [_box(0.8, 0.2), _box(0.9, 0.3), _box(0.1, 0.1)], 'Real02': []}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 2)  # 2 個が ROI 内、1 個が外


class TestBuildT1t2Stalls(unittest.TestCase):
    def test_diff_from_prev(self):
        counts = {'stall1': 5, 'stall2': 3}
        prev = {'stall1': {'count': 7}, 'stall2': {'count': 3}}
        r = build_t1t2_stalls(counts, prev)
        self.assertEqual(r['stall1'], {'count': 5, 'diff_from_prev': -2})
        self.assertEqual(r['stall2'], {'count': 3, 'diff_from_prev': 0})

    def test_no_prev(self):
        r = build_t1t2_stalls({'stall1': 5}, None)
        self.assertEqual(r['stall1'], {'count': 5, 'diff_from_prev': None})
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

Expected: FAIL（`ImportError: cannot import name 'count_boxes_per_stall'`）

- [ ] **Step 1.3: 純関数を実装**

`scripts/detect_vehicles.py` の `decode_yolo_output` 関数の直後（`# --- 以下、ネットワーク取得` コメントの**前**）に追加:

```python


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
```

- [ ] **Step 1.4: テスト実行 → パス**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

Expected: PASS（`Ran 13 tests` / `OK` — F-1 の 6 件 + F-2 の 7 件）

- [ ] **Step 1.5: 構文チェック**

```bash
.venv/bin/python3 -m py_compile scripts/detect_vehicles.py && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 1.6: commit**

```bash
git add scripts/detect_vehicles.py tests/test_detect_vehicles.py
git commit -m "feat(detect): add count_boxes_per_stall + build_t1t2_stalls pure functions"
```

---

## Task 2: `main()` に `t1t2_stalls` 統合

**Files:**
- Modify: `scripts/detect_vehicles.py`

- [ ] **Step 2.1: `STALL_ROIS_PATH` 定数を追加**

`scripts/detect_vehicles.py` の変更前:

```python
MODEL_PATH = os.path.join(REPO_ROOT, 'models', 'yolov8m.onnx')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'vehicle-detection-history.jsonl')
```

変更後:

```python
MODEL_PATH = os.path.join(REPO_ROOT, 'models', 'yolov8m.onnx')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'vehicle-detection-history.jsonl')
STALL_ROIS_PATH = os.path.join(REPO_ROOT, 'scripts', 'lib', 'stall-rois.json')
```

- [ ] **Step 2.2: `read_last_history_row` を追加**

`scripts/detect_vehicles.py` の `jst_now_iso` 関数の直後に追加:

```python


def read_last_history_row(path):
    """JSON Lines ファイルの最終行を dict で返す。無い・壊れている場合は None。"""
    if not os.path.exists(path):
        return None
    last = None
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            s = line.strip()
            if s:
                last = s
    if last is None:
        return None
    try:
        return json.loads(last)
    except Exception:
        return None
```

- [ ] **Step 2.3: `main()` を t1t2_stalls 対応に書き換え**

`main()` 関数**全体**を以下で置き換え:

```python
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

    # Phase F-2: 検出 box を stall ROI に振り分けて T1/T2 stall 別台数を算出
    t1t2_stalls = None
    try:
        with open(STALL_ROIS_PATH, 'r', encoding='utf-8') as f:
            stall_rois = json.load(f)
        boxes_by_image = {im['name']: im.get('boxes', []) for im in images}
        prev_row = read_last_history_row(OUTPUT_PATH)
        prev_stalls = prev_row.get('t1t2_stalls') if isinstance(prev_row, dict) else None
        stall_counts = count_boxes_per_stall(boxes_by_image, stall_rois)
        t1t2_stalls = build_t1t2_stalls(stall_counts, prev_stalls)
    except Exception as e:
        print(f'[detect] t1t2_stalls failed: {e}', file=sys.stderr)

    row = {'schema_version': 2, 'ts': jst_now_iso(), 'images': images}
    if t1t2_stalls is not None:
        row['t1t2_stalls'] = t1t2_stalls
    with open(OUTPUT_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row) + '\n')
    total = sum(im['vehicle_count'] for im in images)
    stall_summary = ' '.join(f"{k}={v['count']}" for k, v in (t1t2_stalls or {}).items())
    print(f'[detect] ok: {len(images)} images, {total} vehicles total | t1t2 {stall_summary}')
```

- [ ] **Step 2.4: 構文チェック**

```bash
.venv/bin/python3 -m py_compile scripts/detect_vehicles.py && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 2.5: 純関数テスト再実行（回帰確認）**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

期待: PASS（13 件）。

- [ ] **Step 2.6: 単発実行 → t1t2_stalls 確認**

```bash
.venv/bin/python3 scripts/detect_vehicles.py
python3 -c "
import json
row = json.loads(open('data/vehicle-detection-history.jsonl').readlines()[-1])
print('schema_version:', row['schema_version'])
print('t1t2_stalls:', json.dumps(row.get('t1t2_stalls'), ensure_ascii=False))
"
```

期待: `[detect] ok: 8 images, N vehicles total | t1t2 stall1=.. stall2=.. stall3=.. stall4=..`。`schema_version: 2`、`t1t2_stalls` に stall1-4 の `count` / `diff_from_prev`（初回 tick は `diff_from_prev: null`、または前行が v1 なら null）。

- [ ] **Step 2.7: commit**

```bash
git add scripts/detect_vehicles.py data/vehicle-detection-history.jsonl
git commit -m "feat(detect): record t1t2_stalls detection counts (schema v2)"
```

---

## Task 3: 最終整合 + push

- [ ] **Step 3.1: scope check（触ったファイル一覧）**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/detect_vehicles.py`
- `tests/test_detect_vehicles.py`
- `data/vehicle-detection-history.jsonl`
- （docs の spec / plan）

`observe-taxi-pool.mjs` / `taxi-pool-history.jsonl` / `correction-engine.mjs` / `aux-observation.mjs` / `scripts/lib/stall-rois.json` / `observe-tick-local.sh` は含まれないこと。

- [ ] **Step 3.2: Python テスト最終パス**

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

期待: PASS（13 件）。

- [ ] **Step 3.3: node テスト回帰なし確認**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 407 件パス、fail 0（Python 変更は node:test に影響しない）。

- [ ] **Step 3.4: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

autostash 適用でコンフリクトが出た場合は **`git reset --hard` を使わないこと**。再生成系 JSON（`data/stall-*.json` / `data/forecast-accuracy.json` / `data/coefficient-corrections.json`）のみ `git checkout HEAD --` で破棄。append-only の `data/taxi-pool-history.jsonl` / `data/t3-pool-history.jsonl` / `data/vehicle-detection-history.jsonl` の未コミット観測行は working tree に残す。再生成系 JSON が rebase コミット適用で衝突した場合は `git checkout --theirs <file>` で解決し `git add` → `git rebase --continue`。解決後、autostash を `git stash drop`。

- [ ] **Step 3.5: push（3 回までリトライ）**

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

- [ ] **Step 3.6: 完了報告**

最終状態を要約。Mac mini 側は次 tick 前に `~/repos/taxi-ic-helper` で `git pull` すれば次 tick から `t1t2_stalls` が記録され始める（venv・モデルは F-1 で配置済み、追加セットアップ不要）。

---

## 検証コマンド一覧 (チートシート)

```bash
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
.venv/bin/python3 scripts/detect_vehicles.py
python3 -c "import json; print(json.dumps(json.loads(open('data/vehicle-detection-history.jsonl').readlines()[-1]).get('t1t2_stalls'), indent=2, ensure_ascii=False))"
npm test
```

---

## 完了条件 (再掲)

- [ ] `count_boxes_per_stall` / `build_t1t2_stalls` が純関数として実装され `unittest` テストがある（計13件パス）
- [ ] `detect_vehicles.py` が Real01_line/Real02 の検出 box から stall 別台数を算出し `vehicle-detection-history.jsonl` の行に `t1t2_stalls` を追加
- [ ] `schema_version` が 2
- [ ] `t1t2_stalls` の各 stall に `count` と `diff_from_prev`
- [ ] `stall-rois.json` 欠損・例外時も `images[]` の記録と既存処理が継続（`t1t2_stalls` 省略）
- [ ] `npm test` 407 件パス（回帰なし）
- [ ] 黒比率 `analyzeStalls` / `observe-taxi-pool.mjs` / `taxi-pool-history.jsonl` は不変
