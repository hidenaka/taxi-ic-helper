# トラッカー jitter 計装 実装 Plan（C 前半）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `update_tracks` のマッチ距離を記録し、`vehicle-track-history.jsonl` の v3 行に `matched_dists` として残して `DIST_THRESHOLD` 適正化のためのジッター分布を観測可能にする。

**Architecture:** `update_tracks`（純関数）がマッチ成立トラックの距離 `best_d` をリストで返す。`main()` が各カメラの `matched_dists` を per-camera 行オブジェクトに加える。加算的変更で `schema_version` は 3 のまま、G-1・`track-state.json` は不変。

**Tech Stack:** Python 3（`unittest`）。新依存なし。`throughput-calibration.mjs`・`computeForecast`・JS 系は不変。

**Spec:** `docs/superpowers/specs/2026-05-16-tracker-jitter-instrumentation-design.md`

**git 運用:** main 直 push 運用（feature branch なし）。worktree 不要、main workdir で作業。各 Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts/tests のみ、観測データ（`data/*`）は混ぜない（`git diff --cached --name-only` で確認、混入時 `git restore --staged data/<file>`）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

**テストコマンド:** `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v`

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/track_vehicles.py` | **改修**。`update_tracks` がマッチ距離 `matched_dists` を返す（Task 1）。`main()` が `matched_dists` を行に記録（Task 2）。 | 1, 2 |
| `tests/test_track_vehicles.py` | **改修**。`update_tracks` の `matched_dists` の unittest を追加。 | 1 |

Task 1（`update_tracks` への加算）は戻り値にキーを足すだけで `main()` の挙動を壊さない（`main()` は新キーを使わないだけ）。Task 2 で `main()` が新キーを使う。各 Task は独立してコミット可能。

---

## Task 1: `update_tracks` がマッチ距離を返す

`update_tracks` がマッチ成立した各トラックの距離 `best_d` を集めて `matched_dists` で返す。

**Files:**
- Modify: `scripts/track_vehicles.py`（`update_tracks` 関数）
- Test: `tests/test_track_vehicles.py`

- [ ] **Step 1: 失敗テストを書く**

`tests/test_track_vehicles.py` の `class TestUpdateTracks` 全体の**直後**（次の `SAMPLE_STALL_ROIS = {` の定義より前）に、以下のテストクラスを追加:

```python
class TestUpdateTracksMatchedDists(unittest.TestCase):
    def test_matched_track_records_distance(self):
        # 同位置マッチ → 距離 ≈ 0
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.5, 0.3)], 2, 2, 0.06)
        self.assertEqual(len(r['matched_dists']), 1)
        self.assertAlmostEqual(r['matched_dists'][0], 0.0)

    def test_matched_distance_value(self):
        # track (0.5,0.3) と det (0.54,0.3) → 距離 0.04
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.54, 0.3)], 2, 2, 0.06)
        self.assertEqual(len(r['matched_dists']), 1)
        self.assertAlmostEqual(r['matched_dists'][0], 0.04, places=4)

    def test_unmatched_track_not_recorded(self):
        # 検出なし → マッチ無し → matched_dists 空
        r = update_tracks([_trk(1, 0.5, 0.3)], [], 2, 2, 0.06)
        self.assertEqual(r['matched_dists'], [])

    def test_new_detection_not_recorded(self):
        # 新規検出のみ → マッチ無し → matched_dists 空
        r = update_tracks([], [_det(0.2, 0.2)], 5, 2, 0.06)
        self.assertEqual(r['matched_dists'], [])

    def test_multiple_matches_all_recorded(self):
        r = update_tracks(
            [_trk(1, 0.2, 0.2), _trk(2, 0.8, 0.8)],
            [_det(0.2, 0.2), _det(0.8, 0.8)],
            3, 2, 0.06)
        self.assertEqual(len(r['matched_dists']), 2)

    def test_distance_rounded_to_4_decimals(self):
        # 丸め済み: 値は round(値,4) と一致する (4桁超の精度を持たない)
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.54321, 0.3)], 2, 2, 0.06)
        self.assertEqual(len(r['matched_dists']), 1)
        d = r['matched_dists'][0]
        self.assertEqual(d, round(d, 4))
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: FAIL — `KeyError: 'matched_dists'`（`update_tracks` の戻り値にキーが無い）。

- [ ] **Step 3: `update_tracks` を改修**

`scripts/track_vehicles.py` の現在の `update_tracks` 関数の本体（docstring の後）:

```python
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
```

を、以下に置換:

```python
    unmatched = list(range(len(detections)))
    out_tracks = []
    arrived = 0
    departed = 0
    matched_dists = []
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
            matched_dists.append(round(best_d, 4))
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
    return {'tracks': out_tracks, 'next_id': next_id, 'arrived': arrived,
            'departed': departed, 'matched_dists': matched_dists}
```

また、`update_tracks` の docstring 内の戻り値の記述行:

```python
    戻り値: {tracks, next_id, arrived, departed}
```

を、以下に置換:

```python
    戻り値: {tracks, next_id, arrived, departed, matched_dists}
```

（`matched_dists` = マッチ成立トラックの距離リスト、小数4桁丸め）

- [ ] **Step 4: テストが通ることを確認**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -15`
Expected: PASS — 既存 23 + 新規 6 = 29 tests OK。

- [ ] **Step 5: コミット**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py
git diff --cached --name-only   # この2ファイルのみであることを確認
git commit -m "$(cat <<'EOF'
feat: update_tracks がマッチ距離 matched_dists を返す

DIST_THRESHOLD 適正化のためのジッター計装。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 2: `main()` が `matched_dists` を行に記録

`main()` のカメラループで、各カメラの `update_tracks` 戻り値の `matched_dists` を per-camera 行オブジェクトに加える。

**Files:**
- Modify: `scripts/track_vehicles.py`（`main()` の `row_cameras` 構築部）

> `main()` はネットワーク I/O を伴うため単体テストハーネスを持たない。検証は構文/import チェック + unittest 回帰で行う。

- [ ] **Step 1: `main()` の行構築を改修**

`scripts/track_vehicles.py` の `main()` 内、現在の `row_cameras[camera_key]` 構築:

```python
            row_cameras[camera_key] = {
                'detected': len(detections),
                'active': len(result['tracks']),
                'arrived': result['arrived'],
                'departed': result['departed'],
            }
```

を、以下に置換:

```python
            row_cameras[camera_key] = {
                'detected': len(detections),
                'active': len(result['tracks']),
                'arrived': result['arrived'],
                'departed': result['departed'],
                'matched_dists': result['matched_dists'],
            }
```

- [ ] **Step 2: 構文・import チェック + unittest 回帰**

Run: `.venv.nosync/bin/python3 -m py_compile scripts/track_vehicles.py && .venv.nosync/bin/python3 -c "import sys; sys.path.insert(0, 'scripts'); import track_vehicles; print('IMPORT_OK')" && .venv.nosync/bin/python3 -m unittest tests.test_track_vehicles tests.test_detect_vehicles 2>&1 | tail -4`
Expected: `IMPORT_OK` のあと track 29 + detect 13 = 42 tests `OK`、fail 0。

- [ ] **Step 3: コミット**

```bash
git add scripts/track_vehicles.py
git diff --cached --name-only   # scripts/track_vehicles.py のみ。data/ が混ざっていないこと
git commit -m "$(cat <<'EOF'
feat: track 行に per-camera matched_dists を記録

vehicle-track-history.jsonl v3 の各カメラに matched_dists を追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

- Python unittest 全 pass（track 29 + detect 13 = 42）。`npm test` は不変（JS 系は触らない）。
- 次の track tick（Mac mini）から `vehicle-track-history.jsonl` の v3 行の各カメラに `matched_dists` が記録され始める。
- `schema_version` は 3 のまま。`throughput-calibration.mjs`・`computeForecast`・`track-state.json`・`observe-tick-local.sh` は不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` のみ（observe-tick が自動実行）。新依存なし、launchd 変更なし、`track-state.json` リセット不要。

**後続（本 plan のスコープ外）:** 約1日の `matched_dists` 蓄積後、分布を分析して `DIST_THRESHOLD` を「主クラスタ上端の直上 ∧ 駐車間隔 0.035 未満」に設定（spec の④判定基準）。
