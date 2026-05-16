# 複数カメラ追跡（Real02/stall4）実装 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F-3/G-2 トラッカーを Real02（stall4）にも広げ、出力を per-camera 構造（v3）にし、G-1 calibration を全 stall（1+2+3+4）へ拡張する。

**Architecture:** `track_vehicles.py` を複数カメラループ化（`TRACK_CAMERAS` を順に追跡）。`track-state.json` と `vehicle-track-history.jsonl` を per-camera 構造（schema 3）に。G-1 `throughput-calibration.mjs` は v3 行のみ採用し、全カメラ `departed` を合算、net-diff を stall1〜4 に拡張。`update_tracks`・ROI フィルタ純関数・`computeForecast` は不変。

**Tech Stack:** Python 3（`unittest`）、Node.js ESM（`node:test`）。新 pip/npm 依存なし。

**Spec:** `docs/superpowers/specs/2026-05-16-multi-camera-tracking-design.md`

**git 運用:** main 直 push 運用（feature branch なし）。worktree 不要、main workdir で作業。各 Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts/tests のみ、観測データ（`data/*`）は混ぜない（`git diff --cached --name-only` で確認、混入時 `git restore --staged data/<file>`）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

**テストコマンド:**
- Python: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v`
- JS: `npm test`（node:test）

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/track_vehicles.py` | **改修**。`TRACK_CAMERAS` 定数、`state_from_json` 改修、`camera_state` 新規、`load_state`/`save_state`/`main()` を per-camera 化。schema 1ファイル内で密結合のため1タスク・1コミット。 | 1 |
| `tests/test_track_vehicles.py` | **改修**。`state_from_json`/`camera_state` の unittest を更新/追加。 | 1 |
| `scripts/lib/throughput-calibration.mjs` | **改修**。`TRACK_SCHEMA_VERSION` 3 化、`trackRowDeparted` ヘルパ、全カメラ `departed` 合算、net-diff に stall4 追加。 | 2 |
| `tests/throughput-calibration.test.mjs` | **改修**。track fixture を v3 nested 化、テストを更新/追加。 | 2 |

---

## Task 1: `track_vehicles.py` の複数カメラ化

`track_vehicles.py` の定数・state 関数・`main()` を per-camera（schema 3）にする。schema 変更が `state_from_json`→`load_state`→`main()` まで密結合のため、全変更を1コミットで原子的に行う（中間状態で `main()` が壊れるのを防ぐ）。

**Files:**
- Modify: `scripts/track_vehicles.py`
- Test: `tests/test_track_vehicles.py`

- [ ] **Step 1: 失敗テストを書く（pure functions）**

`tests/test_track_vehicles.py` の import 文（6行目）:

```python
from track_vehicles import update_tracks, stall_rois_for_camera, filter_to_rois, state_from_json
```

を、以下に置換:

```python
from track_vehicles import (
    update_tracks, stall_rois_for_camera, filter_to_rois, state_from_json, camera_state,
)
```

`tests/test_track_vehicles.py` の現在の `class TestStateFromJson` 全体:

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

を、以下に置換:

```python
class TestStateFromJson(unittest.TestCase):
    def test_schema_match_returns_cameras(self):
        cams = {'real01_line': {'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}}
        s = {'schema': 3, 'cameras': cams}
        self.assertEqual(state_from_json(s), cams)

    def test_old_v2_schema_resets(self):
        # 旧 v2 形式 (schema 2、cameras 無し) → {}
        s = {'schema': 2, 'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}
        self.assertEqual(state_from_json(s), {})

    def test_missing_schema_resets(self):
        s = {'cameras': {'real01_line': {'tracks': [], 'next_id': 1}}}
        self.assertEqual(state_from_json(s), {})

    def test_non_dict_resets(self):
        self.assertEqual(state_from_json([]), {})
        self.assertEqual(state_from_json('x'), {})

    def test_cameras_not_dict_resets(self):
        s = {'schema': 3, 'cameras': 'oops'}
        self.assertEqual(state_from_json(s), {})


class TestCameraState(unittest.TestCase):
    def test_extracts_camera_state(self):
        cams = {'real01_line': {'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}}
        tracks, next_id = camera_state(cams, 'real01_line')
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0]['id'], 1)
        self.assertEqual(next_id, 7)

    def test_missing_camera_resets(self):
        cams = {'real01_line': {'tracks': [], 'next_id': 3}}
        self.assertEqual(camera_state(cams, 'real02'), ([], 1))

    def test_non_dict_cameras_resets(self):
        self.assertEqual(camera_state({}, 'real01_line'), ([], 1))
        self.assertEqual(camera_state('x', 'real01_line'), ([], 1))

    def test_malformed_camera_resets(self):
        # tracks が list でない / next_id が int でない / camera 値が dict でない
        self.assertEqual(camera_state({'c': {'tracks': 'x', 'next_id': 1}}, 'c'), ([], 1))
        self.assertEqual(camera_state({'c': {'tracks': [], 'next_id': 'x'}}, 'c'), ([], 1))
        self.assertEqual(camera_state({'c': 5}, 'c'), ([], 1))
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: FAIL — `ImportError: cannot import name 'camera_state'`

- [ ] **Step 3: `track_vehicles.py` を改修（全変更を一括）**

(3a) 定数。現在の定数ブロック:

```python
TRACK_IMAGE = 'Real01_line'
TRACK_CAMERA = 'real01_line'
STOP_DATE = '2026-06-01'
MAX_MISSED = 2
DIST_THRESHOLD = 0.06
TRACK_STATE_SCHEMA = 2
```

を、以下に置換:

```python
# (fetch 用画像名, stall-rois.json の source キー)
TRACK_CAMERAS = [('Real01_line', 'real01_line'), ('Real02', 'real02')]
STOP_DATE = '2026-06-01'
MAX_MISSED = 2
DIST_THRESHOLD = 0.06
TRACK_STATE_SCHEMA = 3
```

(3b) `state_from_json` + `camera_state`。現在の `state_from_json` 関数全体:

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
```

を、以下に置換:

```python
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
```

(3c) `load_state`。現在の `load_state` 関数全体:

```python
def load_state():
    """track-state.json を (tracks, next_id) で返す。無い・壊れていれば ([], 1)。"""
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            return state_from_json(json.load(f))
    except Exception:
        return [], 1
```

を、以下に置換:

```python
def load_state():
    """track-state.json を per-camera state dict で返す。無い・壊れていれば {}。"""
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            return state_from_json(json.load(f))
    except Exception:
        return {}
```

(3d) `save_state`。現在の `save_state` 関数全体:

```python
def save_state(tracks, next_id):
    """track-state.json を上書き保存 (schema マーカー付き)。"""
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump({'schema': TRACK_STATE_SCHEMA, 'tracks': tracks, 'next_id': next_id}, f)
```

を、以下に置換:

```python
def save_state(cameras):
    """track-state.json を per-camera state で上書き保存 (schema マーカー付き)。"""
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump({'schema': TRACK_STATE_SCHEMA, 'cameras': cameras}, f)
```

(3e) `main()`。現在の `main()` 関数全体:

```python
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
        raw_detections = detect_image(session, img)
        with open(STALL_ROIS_PATH, 'r', encoding='utf-8') as f:
            stall_rois_json = json.load(f)
        rois = stall_rois_for_camera(stall_rois_json, TRACK_CAMERA)
        detections = filter_to_rois(raw_detections, rois)
    except Exception as e:
        print(f'[track] detect/roi failed, skip tick: {e}', file=sys.stderr)
        return
    result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
    save_state(result['tracks'], result['next_id'])
    row = {
        'schema_version': 2,
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
```

を、以下に置換:

```python
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
```

- [ ] **Step 4: pure-function テストが通ることを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: PASS — 既存 14（TestUpdateTracks 6 + TestStallRoisForCamera 3 + TestFilterToRois 5）+ TestStateFromJson 5 + TestCameraState 4 = 23 tests OK。

- [ ] **Step 5: 構文・import チェック + detect 回帰**

Run: `.venv.nosync/bin/python3 -m py_compile scripts/track_vehicles.py && .venv.nosync/bin/python3 -c "import sys; sys.path.insert(0, 'scripts'); import track_vehicles; print('IMPORT_OK')" && .venv.nosync/bin/python3 -m unittest tests.test_detect_vehicles 2>&1 | tail -4`
Expected: `IMPORT_OK` のあと detect 13 tests `OK`。

- [ ] **Step 6: コミット**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py
git diff --cached --name-only   # この2ファイルのみであることを確認
git commit -m "$(cat <<'EOF'
feat: track_vehicles を複数カメラ追跡に拡張 (Real02/stall4)

per-camera state/出力 (schema 3)、TRACK_CAMERAS でループ。
state_from_json は cameras dict を返し、camera_state を新設。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 2: G-1 `throughput-calibration.mjs` を v3 / 全 stall に拡張

calibration が v3 per-camera 行を採用し、全カメラ `departed` を合算、net-diff を stall1〜4 にする。

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs`
- Test: `tests/throughput-calibration.test.mjs`

- [ ] **Step 1: テスト fixture を v3 化し、テストを更新/追加**

(1a) `tests/throughput-calibration.test.mjs` の `makeNetDiffRow` 関数の直後（`buildFixture` の定義より前）に、v3 track 行ヘルパを追加:

```js
// departed を 2 カメラに分けた v3 track 行を作る (全カメラ合計 = departed)
function makeTrackRowV3(ts, departed) {
  const half = Math.floor(departed / 2);
  return {
    schema_version: 3,
    ts,
    cameras: { real01_line: { departed: half }, real02: { departed: departed - half } },
  };
}
```

(1b) `buildFixture` 内の track 行生成:

```js
      trackHistory.push({ schema_version: 2, ts: new Date(tsMs).toISOString(), departed: departedPerTick });
```

を、以下に置換:

```js
      trackHistory.push(makeTrackRowV3(new Date(tsMs).toISOString(), departedPerTick));
```

(1c) テスト「信頼サブセット外の net-diff 行は窓に数えない」内の track 行生成:

```js
  const trackHistory = [0, 1, 2, 3, 4].map(j => ({
    schema_version: 2, ts: new Date(base - 30000 - j * 60000).toISOString(), departed: 1,
  }));
```

を、以下に置換:

```js
  const trackHistory = [0, 1, 2, 3, 4].map(j =>
    makeTrackRowV3(new Date(base - 30000 - j * 60000).toISOString(), 1));
```

(1d) `makeTrackRows` 内の行生成:

```js
    rows.push({ schema_version: 2, ts: new Date(startMs + i * stepMs).toISOString(), departed });
```

を、以下に置換:

```js
    rows.push(makeTrackRowV3(new Date(startMs + i * stepMs).toISOString(), departed));
```

(1e) テスト「net-diff outflow は stall1+2+3 のみ、stall4 は除外」全体:

```js
test('computeThroughputCalibration: net-diff outflow は stall1+2+3 のみ、stall4 は除外', () => {
  // 各窓 stall1 -3 / stall4 -100 → netDiffSum は 12*3=36 のみ
  const { netDiffHistory, trackHistory } = buildFixture(12, { s1: -3, s4: -100, departedPerTick: 5 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.netDiffSum, 36);
  assert.equal(r.trackSum, 300); // 12 窓 × 5本 × 5
});
```

を、以下に置換:

```js
test('computeThroughputCalibration: net-diff outflow は stall1〜4 を合算 (stall4 を含む)', () => {
  // 各窓 stall1 -3 / stall4 -100 → netDiffSum = 12*(3+100) = 1236
  const { netDiffHistory, trackHistory } = buildFixture(12, { s1: -3, s4: -100, departedPerTick: 5 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.netDiffSum, 1236);
  assert.equal(r.trackSum, 300); // 12 窓 × 5本 × 5
});
```

(1f) テスト「computeThroughputCalibration: schema_version!==2 の track 行は無視される」全体:

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
```

を、以下に置換:

```js
test('computeThroughputCalibration: schema_version!==3 の track 行は無視される', () => {
  // 12 窓ぶんの net-diff + track だが track 行を旧 v2 (flat) で作る
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const netDiffHistory = [];
  const trackHistory = [];
  for (let i = 0; i < 12; i++) {
    const endMs = base + i * WINDOW_MS;
    netDiffHistory.push(makeNetDiffRow(new Date(endMs).toISOString(), { s1: -8 }));
    for (let j = 0; j < 5; j++) {
      trackHistory.push({ schema_version: 2, ts: new Date(endMs - 30000 - j * 60000).toISOString(), departed: 2 });
    }
  }
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 0); // v2 行は無視 → 各窓 track 0 本 → 不採用
  assert.equal(r.state, 'bootstrapping');
});
```

(1g) テスト「sumTrackDepartedInWindow: schema_version!==2 の行は合算しない」全体:

```js
test('sumTrackDepartedInWindow: schema_version!==2 の行は合算しない', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const v2 = makeTrackRows(base, 60, 60000, 1);                                  // 60 本 v2、departed 1
  const v1 = makeTrackRows(base, 60, 60000, 100).map(r => ({ ...r, schema_version: 1 })); // v1、departed 100
  const sum = sumTrackDepartedInWindow([...v2, ...v1], base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60); // v2 の 60本×1 のみ。v1 は無視
});
```

を、以下に置換:

```js
test('sumTrackDepartedInWindow: schema_version!==3 の行は合算しない', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const v3 = makeTrackRows(base, 60, 60000, 1);  // makeTrackRows は v3、全カメラ合計 departed 1/行
  const v2 = [];
  for (let i = 0; i < 60; i++) {
    v2.push({ schema_version: 2, ts: new Date(base + i * 60000).toISOString(), departed: 100 });
  }
  const sum = sumTrackDepartedInWindow([...v3, ...v2], base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60); // v3 の 60本×1 のみ。v2 は無視
});
```

(1h) `tests/throughput-calibration.test.mjs` の末尾に、複数カメラ合算のテストを2件追加:

```js
test('sumTrackDepartedInWindow: v3 行の全カメラ departed を合算する', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({
      schema_version: 3,
      ts: new Date(base + i * 60000).toISOString(),
      cameras: { real01_line: { departed: 2 }, real02: { departed: 3 } },
    });
  }
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 300); // 60 本 × (2 + 3)
});

test('sumTrackDepartedInWindow: departed が数値でないカメラは 0 として扱う', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({
      schema_version: 3,
      ts: new Date(base + i * 60000).toISOString(),
      cameras: { real01_line: { departed: 1 }, real02: {} },  // real02 に departed 無し
    });
  }
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60); // real01_line の 1 のみ × 60、real02 は 0
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -25`
Expected: 多数 FAIL — fixture が v3（`schema_version: 3`）になったが実装はまだ v2 採用・`row.departed` 読み（top-level）・net-diff stall1-3 のため、buildFixture 系テスト・新規テストが落ちる。

- [ ] **Step 3: `throughput-calibration.mjs` を改修**

(3a) 定数 `TRACK_SCHEMA_VERSION` の行:

```js
export const TRACK_SCHEMA_VERSION = 2;           // F-3 stall-ROI 制限版の track 行 schema
```

を、以下に置換:

```js
export const TRACK_SCHEMA_VERSION = 3;           // 複数カメラ per-camera 版の track 行 schema
```

(3b) `computeThroughputCalibration` の JSDoc コメントブロック（`/**` で始まり `net-diff history と track history を5分窓で...` を含み `*/` で終わるブロック）の**直前**に、ヘルパ関数を追加（既存の `export const` 定数群と JSDoc の間に置く）:

```js
/**
 * v3 track 行の全カメラ departed 合計を返す。
 * row.cameras 配下の各カメラの departed (数値のみ) を合算する。
 */
function trackRowDeparted(row) {
  let sum = 0;
  const cameras = row.cameras;
  if (cameras && typeof cameras === 'object') {
    for (const cam of Object.values(cameras)) {
      if (cam && typeof cam.departed === 'number') sum += cam.departed;
    }
  }
  return sum;
}

```

(3c) `computeThroughputCalibration` 内の track 行パースループ:

```js
  for (const row of trackHistory) {
    if (row.schema_version !== TRACK_SCHEMA_VERSION) continue;
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
    trackParsed.push({ tsMs, departed: trackRowDeparted(row) });
  }
```

(3d) `computeThroughputCalibration` 内の net-diff outflow 集計ループ:

```js
    for (const name of ['stall1', 'stall2', 'stall3']) {
```

を、以下に置換:

```js
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
```

(3e) `sumTrackDepartedInWindow` 内のループ:

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

を、以下に置換:

```js
  for (const row of trackHistory) {
    if (row.schema_version !== TRACK_SCHEMA_VERSION) continue;
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    if (tsMs > startMs && tsMs <= endMs) {
      sum += trackRowDeparted(row);
      ticks += 1;
    }
  }
```

(3f) ファイル冒頭の `computeThroughputCalibration` の doc コメント:

```js
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean>=30 ∧ stalls 非 null。
 * net-diff outflow = stall1+stall2+stall3 の負 diff の絶対値合算 (stall4 は track 対象外)。
```

を、以下に置換:

```js
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean>=30 ∧ stalls 非 null。
 * net-diff outflow = stall1〜stall4 の負 diff の絶対値合算。
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: PASS — 既存 17 + 新規 2 = 19 tests passing。

- [ ] **Step 5: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（429 → 431）、fail 0。

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: calibration を v3 per-camera 行・全 stall(1-4) に拡張

track 行は v3 のみ採用、全カメラ departed 合算。net-diff に stall4 追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

- `npm test` 全 pass（約 431 件）、Python unittest 全 pass（track 23 + detect 13）。
- 次の track tick（Mac mini）で旧 v2 `track-state.json` が自動リセットされ、Real01_line と Real02 を両方追跡、`vehicle-track-history.jsonl` に `schema_version: 3` の per-camera 行が追記され始める。
- G-1 calibration は v3 行のみ・全カメラ `departed` 合算・net-diff stall1〜4 で再 bootstrap。
- `update_tracks`・`detect_vehicles.py`・`computeForecast`・forecast 系は不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` のみ（observe-tick が自動実行）。新 pip/npm 依存なし、launchd 変更なし。`track-state.json` は schema マーカーで自己回復するため手動手順ゼロ。

**ロードマップ残（本 plan のスコープ外）:** C（`DIST_THRESHOLD` 適正化）、B 案（baseline 真値化）、検出ベース並行 forecast。
