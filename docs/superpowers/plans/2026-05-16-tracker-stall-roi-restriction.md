# F-3 車両追跡の stall ROI 制限 実装 Plan（G-1 修正）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F-3 トラッカーの検出を Real01_line の stall ROI union に絞り、`departed` を真の stall 出庫 throughput にして G-1 の calibration を正常化する。

**Architecture:** `track_vehicles.py` に純関数 `stall_rois_for_camera`/`filter_to_rois` を追加し、`detect_image` の検出を stall ROI で絞ってから `update_tracks` に渡す。track 出力スキーマを v2 に上げ、`track-state.json` に schema マーカーを入れて旧 whole-frame 状態を自動リセット。G-1 側は `computeThroughputCalibration`/`sumTrackDepartedInWindow` が `schema_version===2` の track 行のみ使うようにする。

**Tech Stack:** Python 3（`unittest`）、Node.js ESM（`node:test`）。新 pip/npm 依存なし。`update_tracks`・`detect_vehicles.py`・`computeForecast` は不変。

**Spec:** `docs/superpowers/specs/2026-05-16-tracker-stall-roi-restriction-design.md`

**git 運用:** main 直 push 運用（feature branch なし）。worktree 不要、main workdir で作業。各 Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts/tests/docs のみ、観測データファイル（`data/*`）は混ぜない（`git diff --cached --name-only` で確認、混入時は `git restore --staged data/<file>`）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

**テストコマンド:**
- Python: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v`
- JS: `npm test`（node:test、現 427 件）

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/track_vehicles.py` | **改修**。純関数 `stall_rois_for_camera`/`filter_to_rois`/`state_from_json` を追加、`load_state`/`save_state`/`main` を改修、track 行 schema を v2 化。 | 1, 2, 3 |
| `tests/test_track_vehicles.py` | **改修**。上記純関数の unittest を追加。 | 1, 2 |
| `scripts/lib/throughput-calibration.mjs` | **改修**。`TRACK_SCHEMA_VERSION` 定数を追加、track 行を v2 のみ採用。 | 4 |
| `tests/throughput-calibration.test.mjs` | **改修**。track fixture を v2 化、schema フィルタのテストを追加。 | 4 |

---

## Task 1: `stall_rois_for_camera` + `filter_to_rois`（純関数）

検出を stall ROI に絞るための純関数2つを `track_vehicles.py` に追加する。

**Files:**
- Modify: `scripts/track_vehicles.py`（`update_tracks` 関数の直後に2関数を追加）
- Test: `tests/test_track_vehicles.py`

- [ ] **Step 1: 失敗テストを書く**

`tests/test_track_vehicles.py` の import 文を以下に置換:

```python
from track_vehicles import update_tracks, stall_rois_for_camera, filter_to_rois
```

`tests/test_track_vehicles.py` の `class TestUpdateTracks` の定義より前（`def _trk(...)` の後）に以下を追加:

```python
SAMPLE_STALL_ROIS = {
    '_meta': {'image_size': [800, 600]},
    'stalls': {
        'stall1': {'source': 'real01_line', 'roi': {'x': 600, 'y': 80, 'width': 200, 'height': 170}},
        'stall2': {'source': 'real01_line', 'roi': {'x': 600, 'y': 250, 'width': 200, 'height': 150}},
        'stall4': {'source': 'real02', 'roi': {'x': 400, 'y': 0, 'width': 400, 'height': 250}},
    },
}


class TestStallRoisForCamera(unittest.TestCase):
    def test_filters_by_source_and_normalizes(self):
        rois = stall_rois_for_camera(SAMPLE_STALL_ROIS, 'real01_line')
        self.assertEqual(len(rois), 2)  # stall1, stall2 のみ (stall4 は real02)
        self.assertAlmostEqual(rois[0]['x'], 600 / 800)
        self.assertAlmostEqual(rois[0]['y'], 80 / 600)
        self.assertAlmostEqual(rois[0]['w'], 200 / 800)
        self.assertAlmostEqual(rois[0]['h'], 170 / 600)

    def test_case_insensitive(self):
        rois = stall_rois_for_camera(SAMPLE_STALL_ROIS, 'Real01_line')
        self.assertEqual(len(rois), 2)

    def test_no_match_returns_empty(self):
        self.assertEqual(stall_rois_for_camera(SAMPLE_STALL_ROIS, 'real99'), [])


class TestFilterToRois(unittest.TestCase):
    def test_keeps_detection_inside_roi(self):
        rois = [{'x': 0.75, 'y': 0.1, 'w': 0.25, 'h': 0.3}]
        dets = [_det(0.8, 0.2)]
        self.assertEqual(filter_to_rois(dets, rois), dets)

    def test_drops_detection_outside_roi(self):
        rois = [{'x': 0.75, 'y': 0.1, 'w': 0.25, 'h': 0.3}]
        self.assertEqual(filter_to_rois([_det(0.1, 0.2)], rois), [])

    def test_union_of_multiple_rois(self):
        rois = [
            {'x': 0.0, 'y': 0.0, 'w': 0.1, 'h': 0.1},
            {'x': 0.75, 'y': 0.1, 'w': 0.25, 'h': 0.3},
        ]
        d = _det(0.8, 0.2)  # 2 つ目の ROI 内
        self.assertEqual(filter_to_rois([d], rois), [d])

    def test_empty_rois_returns_empty(self):
        self.assertEqual(filter_to_rois([_det(0.8, 0.2)], []), [])

    def test_roi_boundary_half_open(self):
        rois = [{'x': 0.2, 'y': 0.2, 'w': 0.1, 'h': 0.1}]
        # x == rx (0.2) は含む、x == rx+rw (0.3) は除外
        self.assertEqual(len(filter_to_rois([_det(0.2, 0.25)], rois)), 1)
        self.assertEqual(len(filter_to_rois([_det(0.3, 0.25)], rois)), 0)
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: FAIL — `ImportError: cannot import name 'stall_rois_for_camera'`

- [ ] **Step 3: 純関数を実装**

`scripts/track_vehicles.py` の `update_tracks` 関数の定義の直後（`return {'tracks': ...}` の行の後の空行、`def jst_now_iso():` の前）に以下を追加:

```python
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: PASS — 既存 6 + 新規 8 = 14 tests OK。

- [ ] **Step 5: コミット**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py
git diff --cached --name-only   # この2ファイルのみであることを確認
git commit -m "$(cat <<'EOF'
feat: track_vehicles に stall ROI フィルタ純関数を追加

stall_rois_for_camera / filter_to_rois。検出を stall ROI に絞る。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 2: `state_from_json` + `track-state.json` の schema 自己回復

旧 whole-frame の `track-state.json` を schema マーカーで自動リセットする。

**Files:**
- Modify: `scripts/track_vehicles.py`（`TRACK_STATE_SCHEMA` 定数、`state_from_json` 追加、`load_state`/`save_state` 改修）
- Test: `tests/test_track_vehicles.py`

- [ ] **Step 1: 失敗テストを書く**

`tests/test_track_vehicles.py` の import 文を以下に置換:

```python
from track_vehicles import update_tracks, stall_rois_for_camera, filter_to_rois, state_from_json
```

`tests/test_track_vehicles.py` の末尾（`if __name__ == '__main__':` の行の前）に以下を追加:

```python
class TestStateFromJson(unittest.TestCase):
    def test_schema_match_returns_state(self):
        s = {'schema': 2, 'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}
        tracks, next_id = state_from_json(s)
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0]['id'], 1)
        self.assertEqual(next_id, 7)

    def test_missing_schema_resets(self):
        # 旧形式 (schema キー無し) → リセット
        s = {'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}
        self.assertEqual(state_from_json(s), ([], 1))

    def test_old_schema_resets(self):
        s = {'schema': 1, 'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}
        self.assertEqual(state_from_json(s), ([], 1))

    def test_non_dict_resets(self):
        self.assertEqual(state_from_json([]), ([], 1))
        self.assertEqual(state_from_json('x'), ([], 1))
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: FAIL — `ImportError: cannot import name 'state_from_json'`

- [ ] **Step 3: 定数・純関数・load/save を実装**

(3a) `scripts/track_vehicles.py` の定数 `DIST_THRESHOLD = 0.06` の行の直後に追加:

```python
TRACK_STATE_SCHEMA = 2
```

(3b) `scripts/track_vehicles.py` の現在の `load_state` 関数全体:

```python
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
```

を、以下に置換:

```python
def state_from_json(s):
    """track-state.json のパース済み dict から (tracks, next_id) を返す純関数。

    schema が TRACK_STATE_SCHEMA でない (旧形式・キー無し)・dict でない・
    型不正なら ([], 1) を返す (クリーン開始)。
    """
    if not isinstance(s, dict) or s.get('schema') != TRACK_STATE_SCHEMA:
        return [], 1
    tracks = s.get('tracks', [])
    next_id = s.get('next_id', 1)
    if isinstance(tracks, list) and isinstance(next_id, int):
        return tracks, next_id
    return [], 1


def load_state():
    """track-state.json を (tracks, next_id) で返す。無い・壊れていれば ([], 1)。"""
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            return state_from_json(json.load(f))
    except Exception:
        return [], 1
```

(3c) `scripts/track_vehicles.py` の現在の `save_state` 関数全体:

```python
def save_state(tracks, next_id):
    """track-state.json を上書き保存。"""
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump({'tracks': tracks, 'next_id': next_id}, f)
```

を、以下に置換:

```python
def save_state(tracks, next_id):
    """track-state.json を上書き保存 (schema マーカー付き)。"""
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump({'schema': TRACK_STATE_SCHEMA, 'tracks': tracks, 'next_id': next_id}, f)
```

- [ ] **Step 4: テストが通ることを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: PASS — 既存 6 + Task1 の 8 + 新規 4 = 18 tests OK。

- [ ] **Step 5: コミット**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: track-state.json に schema マーカーで自己回復を追加

state_from_json 純関数。旧 whole-frame state を自動リセット。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 3: `track_vehicles.py` の `main()` 配線 + track 行 schema v2

検出を stall ROI で絞ってから追跡し、出力行を `schema_version: 2` にする。

**Files:**
- Modify: `scripts/track_vehicles.py`（定数 `STALL_ROIS_PATH`/`TRACK_CAMERA`、`main()` の try ブロック、行生成の `schema_version`）

> `main()` はネットワーク I/O を伴うため単体テストハーネスを持たない。検証は構文/import チェック + Python unittest 回帰で行う（実ランタイムは Mac mini の次 track tick で確認）。新ロジックは Task 1 の純関数で完全にテスト済み。

- [ ] **Step 1: 定数を追加**

`scripts/track_vehicles.py` の現在の定数ブロック:

```python
STATE_PATH = os.path.join(REPO_ROOT, 'data', 'track-state.json')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'vehicle-track-history.jsonl')
TRACK_IMAGE = 'Real01_line'
STOP_DATE = '2026-06-01'
```

を、以下に置換:

```python
STATE_PATH = os.path.join(REPO_ROOT, 'data', 'track-state.json')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'vehicle-track-history.jsonl')
STALL_ROIS_PATH = os.path.join(REPO_ROOT, 'scripts', 'lib', 'stall-rois.json')
TRACK_IMAGE = 'Real01_line'
TRACK_CAMERA = 'real01_line'
STOP_DATE = '2026-06-01'
```

- [ ] **Step 2: `main()` の try ブロックを改修**

`scripts/track_vehicles.py` の `main()` 内、現在の以下の try ブロック:

```python
    try:
        session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
        img = fetch_image(TRACK_IMAGE)
        detections = detect_image(session, img)
    except Exception as e:
        print(f'[track] detect failed, skip tick: {e}', file=sys.stderr)
        return
```

を、以下に置換:

```python
    try:
        session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
        img = fetch_image(TRACK_IMAGE)
        raw_detections = detect_image(session, img)
        with open(STALL_ROIS_PATH, 'r', encoding='utf-8') as f:
            stall_rois_json = json.load(f)
        rois = stall_rois_for_camera(stall_rois_json, TRACK_CAMERA)
        detections = filter_to_rois(raw_detections, rois)
    except Exception as e:
        print(f'[track] detect/roi failed, skip tick: {e}', file=sys.stderr)
        return
```

- [ ] **Step 3: track 行の schema_version を 2 に**

`scripts/track_vehicles.py` の `main()` 内、現在の行生成:

```python
    row = {
        'schema_version': 1,
        'ts': jst_now_iso(),
```

を、以下に置換:

```python
    row = {
        'schema_version': 2,
        'ts': jst_now_iso(),
```

- [ ] **Step 4: 構文・import チェック**

Run: `.venv.nosync/bin/python3 -m py_compile scripts/track_vehicles.py && .venv.nosync/bin/python3 -c "import sys; sys.path.insert(0, 'scripts'); import track_vehicles; print('IMPORT_OK')"`
Expected: `IMPORT_OK`（構文エラー・未定義参照なし）

- [ ] **Step 5: Python unittest 回帰**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles tests.test_detect_vehicles -v 2>&1 | tail -8`
Expected: PASS — `OK`（track 18 + detect 13 = 31 tests、fail 0）。

- [ ] **Step 6: コミット**

```bash
git add scripts/track_vehicles.py
git diff --cached --name-only   # scripts/track_vehicles.py のみ。data/ が混ざっていないこと
git commit -m "$(cat <<'EOF'
feat: track_vehicles を stall ROI 制限に配線、track 行を schema v2 化

検出を real01_line stall ROI union に絞ってから追跡。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 4: G-1 `throughput-calibration.mjs` の schema フィルタ

calibration が旧 v1（whole-frame）の track 行を混ぜないよう、`schema_version===2` のみ採用する。

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs`（`TRACK_SCHEMA_VERSION` 定数、2関数のループに schema チェック）
- Test: `tests/throughput-calibration.test.mjs`（track fixture を v2 化、schema フィルタのテストを追加）

- [ ] **Step 1: テスト fixture を v2 化し、失敗テストを追加**

(1a) `tests/throughput-calibration.test.mjs` の `buildFixture` 内の track 行生成:

```js
      trackHistory.push({ schema_version: 1, ts: new Date(tsMs).toISOString(), departed: departedPerTick });
```

を、以下に置換:

```js
      trackHistory.push({ schema_version: 2, ts: new Date(tsMs).toISOString(), departed: departedPerTick });
```

(1b) `tests/throughput-calibration.test.mjs` のテスト「信頼サブセット外の net-diff 行は窓に数えない」内の track 行生成:

```js
  const trackHistory = [0, 1, 2, 3, 4].map(j => ({
    ts: new Date(base - 30000 - j * 60000).toISOString(), departed: 1,
  }));
```

を、以下に置換:

```js
  const trackHistory = [0, 1, 2, 3, 4].map(j => ({
    schema_version: 2, ts: new Date(base - 30000 - j * 60000).toISOString(), departed: 1,
  }));
```

(1c) `tests/throughput-calibration.test.mjs` の `makeTrackRows` 内の行生成:

```js
    rows.push({ ts: new Date(startMs + i * stepMs).toISOString(), departed });
```

を、以下に置換:

```js
    rows.push({ schema_version: 2, ts: new Date(startMs + i * stepMs).toISOString(), departed });
```

(1d) `tests/throughput-calibration.test.mjs` の末尾に以下の2テストを追加:

```js
test('computeThroughputCalibration: schema_version!==2 の track 行は無視される', () => {
  // 12 窓ぶんの net-diff + track だが track 行を旧 v1 で作る
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const netDiffHistory = [];
  const trackHistory = [];
  for (let i = 0; i < 12; i++) {
    const endMs = base + i * WINDOW_MS;
    netDiffHistory.push(makeNetDiffRow(new Date(endMs).toISOString(), { s1: -8 }));
    for (let j = 0; j < 5; j++) {
      trackHistory.push({ schema_version: 1, ts: new Date(endMs - 30000 - j * 60000).toISOString(), departed: 2 });
    }
  }
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 0); // v1 行は無視 → 各窓 track 0 本 → 不採用
  assert.equal(r.state, 'bootstrapping');
});

test('sumTrackDepartedInWindow: schema_version!==2 の行は合算しない', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const v2 = makeTrackRows(base, 60, 60000, 1);                                  // 60 本 v2、departed 1
  const v1 = makeTrackRows(base, 60, 60000, 100).map(r => ({ ...r, schema_version: 1 })); // v1、departed 100
  const sum = sumTrackDepartedInWindow([...v2, ...v1], base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60); // v2 の 60本×1 のみ。v1 は無視
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -20`
Expected: 新規2テストが FAIL（schema フィルタ未実装 → v1 行が数えられ `windowCount` が 0 でない / `sum` が 60 でない）。既存テストは PASS。

- [ ] **Step 3: `TRACK_SCHEMA_VERSION` 定数と schema フィルタを実装**

(3a) `scripts/lib/throughput-calibration.mjs` の定数 `NIGHT_LUMINANCE_THRESHOLD` の行:

```js
export const NIGHT_LUMINANCE_THRESHOLD = 30;     // 信頼サブセット条件
```

の直後に追加:

```js
export const TRACK_SCHEMA_VERSION = 2;           // F-3 stall-ROI 制限版の track 行 schema
```

(3b) `scripts/lib/throughput-calibration.mjs` の `computeThroughputCalibration` 内、track 行パースループ:

```js
  for (const row of trackHistory) {
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    const departed = typeof row.departed === 'number' ? row.departed : 0;
    trackParsed.push({ tsMs, departed });
  }
```

を、以下に置換:

```js
  for (const row of trackHistory) {
    if (row.schema_version !== TRACK_SCHEMA_VERSION) continue;
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    const departed = typeof row.departed === 'number' ? row.departed : 0;
    trackParsed.push({ tsMs, departed });
  }
```

(3c) `scripts/lib/throughput-calibration.mjs` の `sumTrackDepartedInWindow` 内のループ:

```js
  for (const row of trackHistory) {
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    if (tsMs > startMs && tsMs <= endMs) {
      sum += typeof row.departed === 'number' ? row.departed : 0;
      ticks += 1;
    }
  }
```

を、以下に置換:

```js
  for (const row of trackHistory) {
    if (row.schema_version !== TRACK_SCHEMA_VERSION) continue;
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    if (tsMs > startMs && tsMs <= endMs) {
      sum += typeof row.departed === 'number' ? row.departed : 0;
      ticks += 1;
    }
  }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: PASS — 既存 15 + 新規 2 = 17 tests passing。

- [ ] **Step 5: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（427 → 429）、fail 0。

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: calibration を schema v2 の track 行のみ使うよう制限

旧 whole-frame (v1) の track データを k 算出に混ぜない。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

- `npm test` 全 pass（約 429 件）、Python unittest 全 pass（track 18 + detect 13）。
- 次の track tick（Mac mini）で `track-state.json` の旧 whole-frame state が自動リセットされ、`vehicle-track-history.jsonl` に `schema_version: 2` 行（stall ROI 内のみ）が追記され始める。
- calibration は v2 データのみで `k` を学習。旧 v1 の53行は無視される。`k` は net-diff と同スコープの小さい安定値になる見込み。
- `update_tracks`・`detect_vehicles.py`・`computeForecast`・forecast 系は不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` のみ（observe-tick が自動実行）。新 pip/npm 依存なし、launchd 変更なし。`track-state.json` は schema マーカーで自己回復するため手動手順ゼロ。

**ロードマップ残（本 plan のスコープ外）:** C（`DIST_THRESHOLD` の適正化、要ジッター実測）、per-stall 追跡、複数カメラ、baseline 出力の真値化（G-1 B 案）。
