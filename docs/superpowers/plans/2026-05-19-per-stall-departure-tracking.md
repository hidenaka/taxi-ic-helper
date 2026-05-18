# 乗り場別 出庫計測 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 車両トラッカーの出庫計測を「カメラ単位の合算」から「乗り場(stall)単位の実測」へ変え、予測・実績の乗り場別を実測ベースにする。

**Architecture:** `update_tracks` が消失トラックの最後位置を返し、main がそれを乗り場 ROI に振り分けて `departedByStall` を track-history 行(schema v4)に書く。下流(throughput校正/実績/予測)を乗り場別に追従し、按分関数 `splitTotalToStalls` を廃止する。

**Tech Stack:** Python(`track_vehicles.py`、`unittest`)、Node.js ESM(`.mjs`、`node:test`)、日報アプリ JS(独自ランナー)。

設計書: `docs/superpowers/specs/2026-05-19-per-stall-departure-tracking-design.md`

## 前提知識

- **2リポジトリ**: taxi-ic-helper(`乗務地図関係/`、Task 1-6、main直push、`npm test`＋`python3 -m unittest`) / 日報アプリ(`タクシー日報-wt-actuals/` worktree、branch `feat/arrivals-actuals-toggle`→dev、Task 7)。
- commit メッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。commit 前に `git diff --cached --name-only` で観測データ混入なし確認。
- `track_vehicles.py`: `stall_rois_for_camera(json, camera)` は現在 `[{x,y,w,h}]`(正規化)を返す。`filter_to_rois(detections, rois)` は ROI union 内の検出を残す。`update_tracks(prev, dets, next_id, max_missed, dist)` は `{tracks, next_id, arrived, departed, matched_dists}` を返し、`departed` はトラック消失数。main(`scripts/track_vehicles.py` の `for image_name, camera_key in TRACK_CAMERAS:` ループ)が各カメラを処理し row `{schema_version:3, ts, cameras:{<camera>:{detected,active,arrived,departed,matched_dists}}}` を `vehicle-track-history.jsonl` に append。
- Python テストは `tests/test_track_vehicles.py`。ヘルパ `_det(x,y)`・`_trk(tid,x,y,missed=0)`・`SAMPLE_STALL_ROIS` あり。
- `throughput-calibration.mjs`: `export function trackRowDeparted(row)` は `cameras[*].departed` 合算。`sumTrackDepartedInWindow`・`computeThroughputCalibration` が利用。`TRACK_SCHEMA_VERSION` をexport。
- `track-actuals.mjs`: `computeTrackActuals(trackHistory, now, windowMinutes=120)` が `[{slotStart,slotEnd,total}]` を返す。
- `forecast-engine.mjs`: `computeForecast(baseline, recentHistory, arrivalsJson, now, trackTrend=null, latestOccupancy=null)`。トラッカーアンカー経路が `splitTotalToStalls` で按分。`flightDemand`・`splitTotalToStalls` あり。

## ファイル構成

| ファイル | リポジトリ | 変更 |
|---|---|---|
| `scripts/track_vehicles.py` | taxi-ic-helper | `stall_rois_for_camera`/`stall_of_point`/`update_tracks`/main |
| `tests/test_track_vehicles.py` | taxi-ic-helper | テスト追加・更新 |
| `scripts/lib/throughput-calibration.mjs` | taxi-ic-helper | `trackRowDeparted` 両対応・`trackRowDepartedByStall` 追加 |
| `tests/throughput-calibration.test.mjs` | taxi-ic-helper | テスト追加 |
| `scripts/lib/track-actuals.mjs` | taxi-ic-helper | `computeTrackActuals` 乗り場別 |
| `tests/track-actuals.test.mjs` | taxi-ic-helper | テスト更新 |
| `scripts/lib/forecast-engine.mjs` | taxi-ic-helper | `computeForecast` 乗り場別・`splitTotalToStalls` 削除 |
| `tests/forecast-engine.test.mjs` | taxi-ic-helper | テスト更新 |
| `scripts/observe-taxi-pool.mjs` | taxi-ic-helper | trackTrend 乗り場別・seed v4 |
| `tools/js/forecast-section.js` | 日報アプリ | `renderActualsTable` 乗り場別列 |
| `tests/forecast-section.test.js` | 日報アプリ | テスト更新 |

---

## Task 1: track_vehicles.py — 乗り場名つきROI・stall_of_point・update_tracks

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/track_vehicles.py`
- Test: `tests/test_track_vehicles.py`

- [ ] **Step 1: 失敗するテストを書く**

`tests/test_track_vehicles.py` の import 行に `stall_of_point` を追加（`from track_vehicles import (update_tracks, stall_rois_for_camera, stall_of_point, filter_to_rois, ...)`）。末尾に追加:

```python
class TestStallOfPoint(unittest.TestCase):
    def test_point_inside_roi_returns_stall(self):
        rois = stall_rois_for_camera(SAMPLE_STALL_ROIS, 'real01_line')
        # stall1 ROI: x600 y80 w200 h170 / 画像800x600 → 正規化 x0.75-1.0 y0.133-0.417
        self.assertEqual(stall_of_point(0.8, 0.2, rois), 'stall1')

    def test_point_in_no_roi_returns_none(self):
        rois = stall_rois_for_camera(SAMPLE_STALL_ROIS, 'real01_line')
        self.assertIsNone(stall_of_point(0.1, 0.1, rois))


class TestStallRoisHaveStallName(unittest.TestCase):
    def test_roi_includes_stall_key(self):
        rois = stall_rois_for_camera(SAMPLE_STALL_ROIS, 'real01_line')
        self.assertTrue(all('stall' in r for r in rois))
        self.assertEqual({r['stall'] for r in rois}, {'stall1', 'stall2'})


class TestUpdateTracksDepartedTracks(unittest.TestCase):
    def test_departed_track_returns_last_position(self):
        # missed=2 のトラックが未マッチ → 消失。最後位置 (0.8,0.2) が departedTracks に入る
        r = update_tracks([_trk(1, 0.8, 0.2, missed=2)], [], 2, 2, 0.06)
        self.assertEqual(len(r['departedTracks']), 1)
        self.assertAlmostEqual(r['departedTracks'][0]['x'], 0.8)
        self.assertAlmostEqual(r['departedTracks'][0]['y'], 0.2)

    def test_no_departure_empty_list(self):
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.5, 0.3)], 2, 2, 0.06)
        self.assertEqual(r['departedTracks'], [])
```

既存の `update_tracks` テストのうち `r['departed']` を参照しているもの（`test_match_same_position`・`test_unmatched_track_missed_increments`・`test_track_departs_after_max_missed` ほか）を、`r['departed']` → `len(r['departedTracks'])` に書き換える。`grep -n "r\['departed'\]" tests/test_track_vehicles.py` で全て洗い出し、`assertEqual(r['departed'], N)` を `assertEqual(len(r['departedTracks']), N)` に置換する。

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `python3 -m unittest tests.test_track_vehicles`
Expected: FAIL — `stall_of_point` 未定義、`update_tracks` に `departedTracks` が無い。

- [ ] **Step 3: 実装**

`scripts/track_vehicles.py`:

(a) `stall_rois_for_camera` — ROI に `stall` キーを追加。現在の関数の `rois.append({...})` 部分、`for stall in (stall_rois_json.get('stalls') or {}).values():` を `for stall_name, stall in (stall_rois_json.get('stalls') or {}).items():` に変え、append を:
```python
        rois.append({
            'stall': stall_name,
            'x': roi.get('x', 0) / img_w,
            'y': roi.get('y', 0) / img_h,
            'w': roi.get('width', 0) / img_w,
            'h': roi.get('height', 0) / img_h,
        })
```

(b) `stall_of_point` を新規追加（`filter_to_rois` の直後）:
```python
def stall_of_point(x, y, rois):
    """点 (x,y) を含む ROI の stall 名を返す純関数。どの ROI にも入らなければ None。
    判定は filter_to_rois と同じ半開区間。"""
    if x is None or y is None:
        return None
    for r in rois:
        if r['x'] <= x < r['x'] + r['w'] and r['y'] <= y < r['y'] + r['h']:
            return r.get('stall')
    return None
```

(c) `update_tracks` — `departed`(整数カウンタ)を `departedTracks`(消失トラックの最後位置リスト)に置き換える。`departed = 0` を `departed_tracks = []` に、`departed += 1` の箇所を:
```python
            if missed > max_missed:
                departed_tracks.append({'x': tr['x'], 'y': tr['y']})
```
return を `'departed': departed` から `'departedTracks': departed_tracks` に変更。

- [ ] **Step 4: テストを実行して成功を確認**

Run: `python3 -m unittest tests.test_track_vehicles`
Expected: PASS — 新規＋更新したテストすべてパス。

- [ ] **Step 5: コミット**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track): update_tracks が消失トラックの最後位置を返す・stall_of_point 追加

ROI に stall 名を持たせ、点→乗り場 を判定する stall_of_point を追加。
update_tracks の departed(整数) を departedTracks(最後位置リスト)に置き換え、
乗り場別の振り分けを呼び出し側で行えるようにする。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: track_vehicles.py main — departedByStall を row に出力（schema v4）

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/track_vehicles.py`（main の per-camera ループ）

- [ ] **Step 1: 実装**

`scripts/track_vehicles.py` の main、`for image_name, camera_key in TRACK_CAMERAS:` ループ内。

変更前:
```python
            result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
            new_cameras[camera_key] = {
                'tracks': result['tracks'], 'next_id': result['next_id'],
            }
            row_cameras[camera_key] = {
                'detected': len(detections),
                'active': len(result['tracks']),
                'arrived': result['arrived'],
                'departed': result['departed'],
                'matched_dists': result['matched_dists'],
            }
```

変更後:
```python
            result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
            new_cameras[camera_key] = {
                'tracks': result['tracks'], 'next_id': result['next_id'],
            }
            # 消失トラックを最後位置の乗り場 ROI へ振り分ける
            departed_by_stall = {}
            for dt in result['departedTracks']:
                stall = stall_of_point(dt['x'], dt['y'], rois)
                if stall is not None:
                    departed_by_stall[stall] = departed_by_stall.get(stall, 0) + 1
            row_cameras[camera_key] = {
                'detected': len(detections),
                'active': len(result['tracks']),
                'arrived': result['arrived'],
                'departedByStall': departed_by_stall,
                'matched_dists': result['matched_dists'],
            }
```

そして row の `schema_version` を `3` → `4` に変更（`row = {'schema_version': 4, 'ts': jst_now_iso(), 'cameras': row_cameras}`）。

最後のサマリ print（`f"{k}(d=...,out={v['departed']})"`）を `departedByStall` 対応に: `out={sum(v['departedByStall'].values())}` に変更。

- [ ] **Step 2: 構文チェック**

Run: `python3 -c "import ast; ast.parse(open('scripts/track_vehicles.py').read())"`
Expected: エラーなし。

- [ ] **Step 3: 全 Python テスト**

Run: `python3 -m unittest tests.test_track_vehicles tests.test_detect_vehicles`
Expected: PASS — 全件。`update_tracks` の `rois` は main 側で参照（ループ内で既に `rois` 変数あり）。失敗したら停止して報告。

- [ ] **Step 4: コミット**

```bash
git add scripts/track_vehicles.py
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track): track-history を乗り場別出庫(departedByStall)・schema v4 に

main の per-camera ループで消失トラックを stall_of_point で乗り場 ROI に
振り分け、row に cameras[*].departedByStall を出力。schema_version 3→4。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: throughput-calibration.mjs — trackRowDeparted 両対応・trackRowDepartedByStall

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs`
- Test: `tests/throughput-calibration.test.mjs`

- [ ] **Step 1: 失敗するテストを書く**

`tests/throughput-calibration.test.mjs` 末尾に追加（`trackRowDeparted` は既存 import。`trackRowDepartedByStall` を import に追加）:

```javascript

test('trackRowDeparted: v4 行 (departedByStall) を合算する', () => {
  const row = { schema_version: 4, ts: '2026-05-19T12:00:00+09:00', cameras: {
    real01_line: { departedByStall: { stall1: 2, stall2: 1 } },
    real02: { departedByStall: { stall4: 3 } },
  } };
  assert.equal(trackRowDeparted(row), 6);
});

test('trackRowDeparted: v3 行 (departed) は従来どおり合算', () => {
  const row = { schema_version: 3, ts: '2026-05-19T12:00:00+09:00', cameras: {
    real01_line: { departed: 4 }, real02: { departed: 1 },
  } };
  assert.equal(trackRowDeparted(row), 5);
});

test('trackRowDepartedByStall: v4 行は乗り場別 dict を返す', () => {
  const row = { schema_version: 4, ts: '2026-05-19T12:00:00+09:00', cameras: {
    real01_line: { departedByStall: { stall1: 2, stall2: 1 } },
    real02: { departedByStall: { stall4: 3 } },
  } };
  assert.deepEqual(trackRowDepartedByStall(row), { stall1: 2, stall2: 1, stall3: 0, stall4: 3 });
});

test('trackRowDepartedByStall: v3 行は null を返す', () => {
  const row = { schema_version: 3, ts: '2026-05-19T12:00:00+09:00', cameras: { real01_line: { departed: 4 } } };
  assert.equal(trackRowDepartedByStall(row), null);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/throughput-calibration.test.mjs`
Expected: FAIL — `trackRowDepartedByStall` 未定義、`trackRowDeparted` が v4 を集計できない。

- [ ] **Step 3: 実装**

`scripts/lib/throughput-calibration.mjs` の `trackRowDeparted` を両対応に置き換え、`trackRowDepartedByStall` を追加。

変更前:
```javascript
export function trackRowDeparted(row) {
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

変更後:
```javascript
const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];

/**
 * track 行の総出庫数を返す。v4 (departedByStall) / v3 (departed) 両対応。
 */
export function trackRowDeparted(row) {
  let sum = 0;
  const cameras = row.cameras;
  if (cameras && typeof cameras === 'object') {
    for (const cam of Object.values(cameras)) {
      if (!cam || typeof cam !== 'object') continue;
      if (cam.departedByStall && typeof cam.departedByStall === 'object') {
        for (const v of Object.values(cam.departedByStall)) {
          if (typeof v === 'number') sum += v;
        }
      } else if (typeof cam.departed === 'number') {
        sum += cam.departed;
      }
    }
  }
  return sum;
}

/**
 * track 行の乗り場別出庫を {stall1..4} で返す。v4 のみ対応、v3 行は null。
 */
export function trackRowDepartedByStall(row) {
  const cameras = row.cameras;
  if (!cameras || typeof cameras !== 'object') return null;
  const out = { stall1: 0, stall2: 0, stall3: 0, stall4: 0 };
  let sawV4 = false;
  for (const cam of Object.values(cameras)) {
    if (!cam || typeof cam !== 'object') continue;
    if (cam.departedByStall && typeof cam.departedByStall === 'object') {
      sawV4 = true;
      for (const name of STALL_NAMES) {
        const v = cam.departedByStall[name];
        if (typeof v === 'number') out[name] += v;
      }
    }
  }
  return sawV4 ? out : null;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/throughput-calibration.test.mjs`
Expected: PASS — 新規4件を含め全件パス。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(throughput): trackRowDeparted を v3/v4 両対応・trackRowDepartedByStall 追加

track-history v4 (departedByStall) を集計可能にし、乗り場別を返す
trackRowDepartedByStall を追加(v3行はnull)。k校正は総数ベースで不変。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: track-actuals.mjs — computeTrackActuals を乗り場別に

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/lib/track-actuals.mjs`
- Test: `tests/track-actuals.test.mjs`

- [ ] **Step 1: テストを更新する**

`tests/track-actuals.test.mjs` の `row` ヘルパと既存テストを v4 形式に書き換え、乗り場別を検証する。ファイル全体を以下に置き換える:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeTrackActuals } from '../scripts/lib/track-actuals.mjs';

// v4 track 行（cameras[*].departedByStall）
function row(ts, departedByStall) {
  return { schema_version: 4, ts, cameras: { real01_line: { departedByStall } } };
}

test('computeTrackActuals: 直近2時間の departed を乗り場別15分スロットに集計', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    row('2026-05-19T18:02:00+09:00', { stall1: 3, stall2: 1 }), // 18:00-18:15
    row('2026-05-19T18:10:00+09:00', { stall1: 2 }),            // 同上
    row('2026-05-19T18:20:00+09:00', { stall3: 5 }),            // 18:15-18:30
    row('2026-05-19T16:30:00+09:00', { stall1: 9 }),            // 2時間より前 → 除外
  ];
  const r = computeTrackActuals(history, now);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { slotStart: '18:00', slotEnd: '18:15', stall1: 5, stall2: 1, stall3: 0, stall4: 0, total: 6 });
  assert.deepEqual(r[1], { slotStart: '18:15', slotEnd: '18:30', stall1: 0, stall2: 0, stall3: 5, stall4: 0, total: 5 });
});

test('computeTrackActuals: v3 行は total のみ寄与し乗り場別には加算しない', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    { schema_version: 3, ts: '2026-05-19T18:05:00+09:00', cameras: { real01_line: { departed: 4 } } },
    row('2026-05-19T18:08:00+09:00', { stall2: 2 }),
  ];
  const r = computeTrackActuals(history, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].stall2, 2);
  assert.equal(r[0].total, 6); // v3の4 + v4の2
});

test('computeTrackActuals: 空配列・未来時刻のみ → 空配列', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  assert.deepEqual(computeTrackActuals([], now), []);
  assert.deepEqual(computeTrackActuals(undefined, now), []);
  assert.deepEqual(computeTrackActuals([row('2026-05-19T20:00:00+09:00', { stall1: 5 })], now), []);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/track-actuals.test.mjs`
Expected: FAIL — 現行 `computeTrackActuals` は `{slotStart,slotEnd,total}` のみで乗り場別フィールドが無い。

- [ ] **Step 3: 実装**

`scripts/lib/track-actuals.mjs` を以下に書き換える。`trackRowDeparted`（総数）と `trackRowDepartedByStall`（乗り場別/v3はnull）を使う。

```javascript
// 車両トラッカーの実測出庫を直近 windowMinutes の15分スロットに乗り場別集計する。
import { trackRowDeparted, trackRowDepartedByStall } from './throughput-calibration.mjs';

const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60 * 1000;
const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];

// epoch ms → JST "HH:MM"
function fmtJst(ms) {
  const jst = new Date(ms + 9 * 3600 * 1000);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 直近 windowMinutes ぶんのトラッカー実測出庫を15分スロットで乗り場別集計する。
 * @param {Array} trackHistory vehicle-track-history.jsonl の行配列
 * @param {Date} now 現在時刻
 * @param {number} [windowMinutes] 遡る分数（既定 120）
 * @returns {Array<{slotStart,slotEnd,stall1,stall2,stall3,stall4,total}>} 時刻昇順。
 *   v3 行（乗り場分離不可）は total のみに寄与し stall1..4 には加算しない。
 */
export function computeTrackActuals(trackHistory, now, windowMinutes = 120) {
  const endMs = now.getTime();
  const startMs = endMs - windowMinutes * 60 * 1000;
  const bins = new Map(); // binStartMs → {stall1..4, total}
  for (const r of trackHistory || []) {
    const tsMs = new Date(r.ts).getTime();
    if (Number.isNaN(tsMs) || tsMs < startMs || tsMs > endMs) continue;
    const binStartMs = Math.floor(tsMs / SLOT_MS) * SLOT_MS;
    let bin = bins.get(binStartMs);
    if (!bin) {
      bin = { stall1: 0, stall2: 0, stall3: 0, stall4: 0, total: 0 };
      bins.set(binStartMs, bin);
    }
    bin.total += trackRowDeparted(r);
    const byStall = trackRowDepartedByStall(r);
    if (byStall) {
      for (const name of STALL_NAMES) bin[name] += byStall[name];
    }
  }
  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([binStartMs, bin]) => ({
      slotStart: fmtJst(binStartMs),
      slotEnd: fmtJst(binStartMs + SLOT_MS),
      stall1: bin.stall1, stall2: bin.stall2, stall3: bin.stall3, stall4: bin.stall4,
      total: bin.total,
    }));
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/track-actuals.test.mjs`
Expected: PASS — 3件すべてパス。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/track-actuals.mjs tests/track-actuals.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track-actuals): computeTrackActuals を乗り場別集計に

各15分スロットを {stall1..4, total} で返す。v4 行は乗り場別、v3 行は
total のみに寄与（配信切替直後の過渡期のみ）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: forecast-engine.mjs — computeForecast 乗り場別・splitTotalToStalls 廃止

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs`
- Test: `tests/forecast-engine.test.mjs`

- [ ] **Step 1: テストを更新する**

`tests/forecast-engine.test.mjs`:
(a) `splitTotalToStalls` の import とテスト3件（`splitTotalToStalls:` で始まる test）を削除する。
(b) トラッカーアンカー経路のテスト（`computeForecast: トラッカーアンカー経路` で始まる3件）を、新しい `trackTrend`（乗り場別）形式に置き換える。`grep -n "トラッカーアンカー経路\|splitTotalToStalls" tests/forecast-engine.test.mjs` で対象を特定。置き換え後のトラッカーアンカー・テスト:

```javascript

test('computeForecast: トラッカーアンカー経路 — 乗り場別実測レートで予測する', () => {
  const baseline = { slots: Array.from({ length: 288 }, () => ({ stall1: 0, stall2: 0, stall3: 0, stall4: 0 })), sampleCount: 100 };
  const recent = Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(2026, 4, 19, 11, i * 5, 0).toISOString().replace('Z', '+09:00'), total_outflow: 0,
  }));
  // 乗り場別の直近窓実測（12スロット合計）→ 乗り場別レート = 値/12
  const trackTrend = { perStall: { stall1: 60, stall2: 0, stall3: 0, stall4: 12 } };
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-19T12:00:00+09:00'), trackTrend);
  assert.equal(r.trendWindow.levelSource, 'track-anchored');
  // 便需要なし → demandRatio=1.0。stall1=60/12=5, stall4=12/12=1。
  assert.equal(r.slots[0].stall1, 5);
  assert.equal(r.slots[0].stall4, 1);
  assert.equal(r.slots[0].stall2, 0);
  assert.equal(r.slots[0].total, 6);
});

test('computeForecast: トラッカーアンカー経路 — 便需要比で乗り場別に変調', () => {
  const baseline = { slots: Array.from({ length: 288 }, () => ({ stall1: 0, stall2: 0, stall3: 0, stall4: 0 })), sampleCount: 100 };
  const recent = Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(2026, 4, 19, 11, i * 5, 0).toISOString().replace('Z', '+09:00'), total_outflow: 0,
  }));
  // 直近窓 便需要 120 → recentPerSlot 10。将来 slot0 便需要 20 → demandRatio clip(20/10)=2.0。
  const arrivals = makeArrivals([
    { lobbyExitTime: '11:30', estimatedTaxiPax: 120 },
    { lobbyExitTime: '12:05', estimatedTaxiPax: 20 },
  ]);
  const trackTrend = { perStall: { stall1: 60, stall2: 0, stall3: 0, stall4: 0 } };
  const r = computeForecast(baseline, recent, arrivals, new Date('2026-05-19T12:00:00+09:00'), trackTrend);
  // stall1 レート 5 × demandRatio 2.0 = 10
  assert.equal(r.slots[0].stall1, 10);
  assert.equal(r.slots[0].total, 10);
});

test('computeForecast: trackTrend null → 従来の net-diff 経路（後方互換）', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-19T12:00:00+09:00'), null);
  assert.equal(r.trendWindow.levelSource, 'netdiff-fallback');
  assert.equal(r.slots[0].stall1, 1);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: FAIL — 旧 `trackTrend` 形式（`{k,actual}`）前提のコードと不一致、`splitTotalToStalls` import エラー。

- [ ] **Step 3: 実装**

`scripts/lib/forecast-engine.mjs`:

(a) `splitTotalToStalls` 関数を**削除**する（`export function splitTotalToStalls` の定義全体）。

(b) `computeForecast` のシグネチャから `latestOccupancy` を削除: `export function computeForecast(baseline, recentHistory, arrivalsJson, now, trackTrend = null) {`

(c) スロット予測ブロックのトラッカーアンカー部分を置き換える。現在の `useTrackAnchor` 判定〜スロットループのうち、トラッカーアンカー関連を以下に変更:

`useTrackAnchor` の判定を:
```javascript
  const useTrackAnchor = trackTrend !== null
    && trackTrend.perStall
    && typeof trackTrend.perStall === 'object';
  const levelSource = useTrackAnchor ? 'track-anchored' : 'netdiff-fallback';
```

`trackRatePerSlot`/`demandRatios` 準備部分を:
```javascript
  let perStallRate = null;
  let demandRatios = null;
  if (useTrackAnchor) {
    perStallRate = {};
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const v = trackTrend.perStall[name];
      perStallRate[name] = (typeof v === 'number' ? v : 0) / TREND_WINDOW_TICKS;
    }
    const demand = flightDemand(arrivalsJson, nowSlot);
    const recentPerSlot = demand.recentSum / TREND_WINDOW_TICKS;
    demandRatios = demand.futureSums.map(s => {
      if (recentPerSlot <= 0) return 1.0;
      return clip(s / recentPerSlot, FLIGHT_FACTOR_MIN, FLIGHT_FACTOR_MAX);
    });
  }
```

スロットループ内のトラッカーアンカー分岐を:
```javascript
    if (useTrackAnchor) {
      // トラッカーアンカー: 乗り場別実測レート × 便需要比（按分しない）。
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const val = perStallRate[name] * demandRatios[i];
        slotOut[name] = val;
        total += val;
      }
    } else {
      // net-diff フォールバック経路（従来どおり）。
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const b = base[name];
        const val = (b === null || b === undefined) ? 0 : b * trendFactor * f;
        slotOut[name] = val;
        total += val;
      }
    }
```

`trendWindow` の `levelSource` 付与は維持。

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: PASS — 更新したトラッカーアンカー3件・既存テスト全件パス。`splitTotalToStalls` 関連テストは削除済み。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(forecast): computeForecast を乗り場別トラッカーアンカーに・splitTotalToStalls 廃止

trackTrend を乗り場別実測({perStall})にし、各乗り場の予測 = その乗り場の
実測レート × 便需要比。合計を按分する splitTotalToStalls を廃止
（乗り場別が実測になり按分不要）。latestOccupancy 引数も削除。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: observe-taxi-pool.mjs — trackTrend 乗り場別・seed v4・全回帰・push

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`
- Modify: `data/stall-actuals.json`（seed を新形式に）

- [ ] **Step 1: trackTrend を乗り場別に**

`scripts/observe-taxi-pool.mjs`。現在 `trackTrend = { k: calibration.k, actual: trackActual }` を作っている箇所（`sumTrackDepartedInWindow` を使う付近）を、乗り場別に変更する。`grep -n "trackTrend\|sumTrackDepartedInWindow\|computeForecast(" scripts/observe-taxi-pool.mjs` で箇所を特定。

`sumTrackDepartedInWindow` は総数を返すので、乗り場別の窓集計を `computeTrackActuals` で代用する。`trackTrend` 構築を以下の方針に変更:
- 直近 `TREND_WINDOW_TICKS`(=12) スロット相当（60分）の窓で、`computeTrackActuals(trackHistory, now, 60)` を呼ぶと15分スロット×4の乗り場別が得られる。その全スロットを乗り場別に合算し `{perStall: {stall1..4}}` を作る。
- 従来の `learning` 状態・`recent.length>=12` の発動条件は維持。条件を満たさなければ `trackTrend = null`（net-diff フォールバック）。

具体的には、`trackTrend` を作っていたブロックを次のように書き換える（`computeTrackActuals` を import 済みであること。未importなら `import { computeTrackActuals } from './lib/track-actuals.mjs';` は既にある）:
```javascript
    let trackTrend = null;
    if (calibration.state === 'learning' && recent.length >= 12) {
      const win = computeTrackActuals(trackHistory, now, 60);
      if (win.length > 0) {
        const perStall = { stall1: 0, stall2: 0, stall3: 0, stall4: 0 };
        for (const s of win) {
          for (const n of ['stall1', 'stall2', 'stall3', 'stall4']) perStall[n] += s[n];
        }
        trackTrend = { perStall };
      }
    }
```
`computeForecast(...)` 呼び出しから `latestOccupancy` 引数を削除する（`computeForecast(baseline, recent, arrivalsJson, now, trackTrend)`）。`latestOccupancy` を組み立てていたコード（`lastRow`/`latestOccupancy`）も削除する。

- [ ] **Step 2: stall-actuals.json のシードを新形式に**

`data/stall-actuals.json` を新形式（乗り場別 slots は空配列のまま）に。内容:
```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-19T00:00:00+09:00",
  "slots": []
}
```
（slots が空なので形式差は無いが、generatedAt を当日に更新しておく。）

- [ ] **Step 3: 構文チェック＋全回帰**

Run: `node --check scripts/observe-taxi-pool.mjs`
Run: `npm test`
Expected: PASS — 全件（Task 1-5 の変更を含む）。
Run: `python3 -m unittest tests.test_track_vehicles tests.test_detect_vehicles`
Expected: PASS — 42件前後。
失敗したら停止して報告。

- [ ] **Step 4: 実データ検証**

Run: `node --input-type=module -e "import {readFileSync} from 'node:fs'; import {computeTrackActuals} from './scripts/lib/track-actuals.mjs'; const h=readFileSync('data/vehicle-track-history.jsonl','utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l)); const r=computeTrackActuals(h,new Date(h[h.length-1].ts)); console.log(JSON.stringify(r.slice(-4),null,1));"`
Expected: 直近スロットが乗り場別フィールド付きで出る。track-history がまだ v3 のみなら stall1..4 は 0・total のみ非0（v4 行が観測で蓄積されるまでは過渡的に正しい）。出力を報告する。

- [ ] **Step 5: コミットして push**

```bash
git add scripts/observe-taxi-pool.mjs data/stall-actuals.json
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(observe): trackTrend を乗り場別実測に・stall-actuals seed 更新

trackTrend を {perStall} 形式（直近60分窓の乗り場別実出庫合計）にし、
computeForecast へ渡す。latestOccupancy(按分用)を撤去。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main
git push origin main
```

---

## Task 7: 日報アプリ — renderActualsTable を乗り場別列に

**作業ディレクトリ:** `タクシー日報-wt-actuals/`（branch `feat/arrivals-actuals-toggle`）

**Files:**
- Modify: `tools/js/forecast-section.js`
- Test: `tests/forecast-section.test.js`

- [ ] **Step 1: テストを更新する**

`tests/forecast-section.test.js` の `renderActualsTable` テスト2件（`renderActualsTable:` で始まる）を、乗り場別 slot 形式に置き換える:

```javascript
test('renderActualsTable: 乗り場別スロットを時刻＋乗1-4＋計の表にする', () => {
  const html = renderActualsTable([
    { slotStart: '18:00', slotEnd: '18:15', stall1: 2, stall2: 1, stall3: 0, stall4: 2, total: 5 },
  ]);
  assert.ok(html.includes('18:00-18:15'), '時間帯ラベルを含む');
  assert.ok(html.includes('<table'), 'table 要素で描画する');
  assert.ok(html.includes('>5<'), '合計 5 を含む');
  assert.ok(html.includes('乗1') && html.includes('乗4'), '乗り場別の見出しを含む');
});

test('renderActualsTable: 空配列はデータなし表示', () => {
  assert.ok(renderActualsTable([]).includes('実績データなし'));
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cd タクシー日報-wt-actuals && npm test`
Expected: FAIL — 現行 `renderActualsTable` は時刻＋total の2列で乗り場別の見出しが無い。

- [ ] **Step 3: 実装**

`tools/js/forecast-section.js` の `renderActualsTable` を、予測表 `renderTable` と同じ列構成（時間帯／乗1／乗2／乗3／乗4／計）に置き換える:

```javascript
// 出庫実績スロット配列を HTML テーブルに描画する（乗り場別＋合計）。
export function renderActualsTable(slots) {
  if (!slots || slots.length === 0) return '<p class="fc-empty">実績データなし</p>';
  const rows = slots.map(s => `<tr>
      <td class="fc-time">${s.slotStart}-${s.slotEnd}</td>
      <td>${s.stall1}</td><td>${s.stall2}</td><td>${s.stall3}</td><td>${s.stall4}</td>
      <td class="fc-total">${s.total}</td>
    </tr>`).join('');
  return `<table class="fc-table">
    <thead><tr><th>時間帯</th><th>乗1</th><th>乗2</th><th>乗3</th><th>乗4</th><th>計</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `cd タクシー日報-wt-actuals && npm test`
Expected: PASS — 全件パス。

- [ ] **Step 5: sw.js 版数を上げる**

`tools/arrivals.html` は変更しないが `forecast-section.js`（キャッシュ対象JS）を変更したため、`sw.js` の `CACHE_NAME` 版数を現状＋1にする（`grep CACHE_NAME sw.js` で現状値確認）。

- [ ] **Step 6: コミットして dev へ push**

```bash
cd タクシー日報-wt-actuals
git add tools/js/forecast-section.js tests/forecast-section.test.js sw.js
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(arrivals): 実績表を乗り場別列に

stall-actuals.json が乗り場別になったのに合わせ、renderActualsTable を
予測表と同じ 時間帯／乗1-4／計 の列構成にする。sw.js 版数更新。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash dev main
git push dev feat/arrivals-actuals-toggle:main
```

- [ ] **Step 7: 完了報告**

dev/main の commit SHA を報告。本番反映はユーザー確認後（この計画には含めない）。track-history が v4 で蓄積され始めれば乗り場別が実測になること、過渡期（〜2時間）は実績の乗り場別が一部0になりうることを伝える。

---

## 完了条件

- track-history 行が schema v4（`departedByStall`）で出力される。
- 予測・実績ともに乗り場別が実測（`splitTotalToStalls` 廃止）。
- 両リポジトリの `npm test` ＋ Python テストが回帰なしでパス。
- 実データ検証で乗り場別集計が動く。
- taxi-ic-helper は main 反映、日報アプリは dev 反映（本番はユーザー確認後）。

## Self-Review

- **Spec coverage:** 設計§1(track_vehicles)→Task 1-2。§2(throughput)→Task 3。§3(track-actuals)→Task 4。§4(forecast/splitTotalToStalls廃止)→Task 5。§5(observe/日報)→Task 6-7。テスト方針→各TaskのTDD。
- **Placeholder scan:** TBD/TODO なし。各ステップに実コード・実コマンド。`grep` で対象特定を指示した箇所（既存テストの置換対象）は、ファイル内に確実に存在する文字列での特定。
- **Type consistency:** `update_tracks` は `departedTracks`(リスト)を返し Task 2 が参照。`stall_of_point(x,y,rois)` は Task 1 定義・Task 2 使用。row schema v4 `cameras[*].departedByStall` は Task 2 が書き Task 3 `trackRowDeparted`/`trackRowDepartedByStall` が読む。`trackRowDepartedByStall` は `{stall1..4}|null` を返し Task 4 `computeTrackActuals` が使用。`computeTrackActuals` は `{slotStart,slotEnd,stall1..4,total}` を返し Task 6(trackTrend)・Task 7(renderActualsTable)が使用。`trackTrend` は `{perStall:{stall1..4}}` 形式で Task 5(computeForecast)定義・Task 6(observe)構築。`computeForecast` の引数は `(baseline,recentHistory,arrivalsJson,now,trackTrend)` で Task 5 定義・Task 6 呼び出しが一致。
