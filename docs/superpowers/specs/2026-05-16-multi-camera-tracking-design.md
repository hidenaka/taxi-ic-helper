# 複数カメラ追跡（Real02/stall4 追加）設計

- 日付: 2026-05-16
- 対象: 乗務地図関係 / F-3/G-2 トラッカーを Real02（stall4）にも広げ、G-1 calibration を全 stall に拡張する
- 前提 spec: `2026-05-16-vehicle-tracking-design.md`（F-3）、`2026-05-16-tracker-stall-roi-restriction-design.md`（G-2）、`2026-05-16-throughput-forecast-connection-design.md`（G-1）

## 背景

F-3 で車両追跡、G-2 で検出を stall ROI に制限した。だが追跡対象は Real01_line 1カメラ（stall1+2+3）のみで、stall4（ANA T2、`source: real02`）は追跡されていない。そのため G-1 calibration は net-diff も track も stall1+2+3 に限定している（G-1 spec で「stall4 は track 対象外」と明記）。

本フェーズで Real02 を追跡対象に加え、stall4 の出庫 throughput を観測する。出力スキーマを per-camera 構造（v3）にし、G-1 calibration を全 stall（1+2+3+4）へ拡張する。

## 設計方針

1. **`update_tracks`・ROI フィルタ純関数は不変。** `update_tracks` / `stall_rois_for_camera` / `filter_to_rois` はカメラ非依存の純関数。カメラごとに呼ぶだけで複数カメラ化できる。アルゴリズム本体は変えない。
2. **per-camera 構造で対称に。** track-state も出力行も per-camera の入れ子にする。real01_line をトップレベル・real02 をネスト、のような非対称は作らない。
3. **スキーマ移行は1回。** track-state schema・track 行 schema・G-1 の採用 schema を一括で次バージョンへ。
4. **G-1 ロジックは最小変更。** `departed` の読み取り元と net-diff の stall リストだけ変える。`computeForecast`・forecast 系・accuracy・correction・ensemble は不変。
5. **行は常に全カメラ揃った状態。** 片肺データを記録しない（G-1 の窓が不整合にならないように）。
6. **手動デプロイ手順ゼロ。** track-state は schema マーカーで自己回復（G-2 の機構を踏襲）。

## ① `track_vehicles.py`: 複数カメラループ

### 定数

現行の単一カメラ定数:
```python
TRACK_IMAGE = 'Real01_line'
TRACK_CAMERA = 'real01_line'
```
を、カメラリストに置換:
```python
# (fetch 用画像名, stall-rois.json の source キー)
TRACK_CAMERAS = [('Real01_line', 'real01_line'), ('Real02', 'real02')]
```
`MAX_MISSED = 2` / `DIST_THRESHOLD = 0.06` は両カメラ共通・現状値のまま。`TRACK_STATE_SCHEMA` を `2` から `3` に上げる。

### `main()` のフロー

1. `is_past_stop_date()` / `MODEL_PATH` 存在チェック（現行どおり）。
2. `stall-rois.json` をロード（失敗時はその tick をスキップ）。
3. `track-state.json` をロード → `state_from_json` で per-camera state（`cameras` dict）を得る。
4. ONNX セッションを生成。
5. 各カメラ `(image_name, camera_key)` について:
   - `camera_state(cameras, camera_key)` で `(tracks, next_id)` を取得。
   - `fetch_image(image_name)` → `detect_image` → `stall_rois_for_camera(stall_rois_json, camera_key)` → `filter_to_rois` で stall ROI 内の検出を得る。
   - `update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)`。
   - そのカメラの新 state と4カウント（detected/active/arrived/departed）を保持。
6. 全カメラの新 state を `{schema: 3, cameras: {...}}` で `track-state.json` に保存。
7. per-camera の行を `vehicle-track-history.jsonl` に1本追記。

検出・推論・取得は try で囲み、**いずれかのカメラで例外が出たらその tick 全体をスキップ**（state 据え置き、行追記なし）。現行の「detect 失敗 → skip tick」の自然な拡張。

## ② `track-state.json`: schema 2→3（per-camera）

```json
{
  "schema": 3,
  "cameras": {
    "real01_line": { "tracks": [ {"id":1,"x":...,"y":...,"w":...,"h":...,"missed":0} ], "next_id": 12 },
    "real02":      { "tracks": [ ... ], "next_id": 5 }
  }
}
```

### 純関数

**`state_from_json(s)`（改修）**
- `s` が dict でない、または `s.get('schema') != TRACK_STATE_SCHEMA` → `{}` を返す。
- 一致時、`s.get('cameras')` が dict ならそれを、でなければ `{}` を返す。
- 戻り値は `cameras` dict（`{camera_key: {tracks, next_id}}`）または `{}`。

**`camera_state(cameras, camera)`（新規）**
- `cameras` dict から `camera` の state を取り出し `(tracks, next_id)` を返す純関数。
- `cameras` が dict でない、`camera` キーが無い、`tracks` が list でない、`next_id` が int でないとき `([], 1)`。

### `load_state` / `save_state`

```python
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
```

旧 v2 state（`schema: 2`、単一 tracker 形式）は schema 不一致で `state_from_json` が `{}` を返す → 各カメラ `camera_state` が `([], 1)` を返す → クリーン開始。デプロイ後初回 tick で自動移行。

## ③ 出力スキーマ: `vehicle-track-history.jsonl` v2→v3

```json
{
  "schema_version": 3,
  "ts": "2026-05-16T15:01:00+09:00",
  "cameras": {
    "real01_line": { "detected": 4, "active": 6, "arrived": 1, "departed": 1 },
    "real02":      { "detected": 2, "active": 3, "arrived": 0, "departed": 1 }
  }
}
```

1 tick = 1 行。各カメラの `detected`/`active`/`arrived`/`departed` を per-camera で保持。`ts` は行書き込み時刻（両カメラ同一 tick 内処理）。`schema_version` を `2` から `3` に上げる。

## ④ G-1 `throughput-calibration.mjs` の変更

- `TRACK_SCHEMA_VERSION` を `2` から `3` にする。**v3 行のみ採用。** 旧 v2 行は real01_line（stall1+2+3）のみのため、4-stall net-diff と組み合わせると不整合。v1→v2 と同じクリーンカットで v2 を切り捨てる（G-2 デプロイ以降に溜まった v2 行は calibration から失われるが、calibration は累積・窓ベースのため v3 蓄積で再 bootstrap するだけ）。
- track `departed` の取得元を変更。現行は各 track 行の `row.departed`。v3 では `row.cameras` 配下の全カメラの `departed` を合算する。`computeThroughputCalibration` の track パースループと `sumTrackDepartedInWindow` のループ、両方で対応。
- 値が数値でないカメラエントリは 0 として扱う（現行の `typeof row.departed === 'number' ? ... : 0` と同じ防御）。
- net-diff outflow の stall リストを `['stall1', 'stall2', 'stall3']` から `['stall1', 'stall2', 'stall3', 'stall4']` にする（`computeThroughputCalibration` 内）。stall4 の `diff_occupied_from_prev` は `taxi-pool-history.jsonl` に既に存在する。
- doc コメントの「stall4 は track 対象外」を「全 stall を対象」に更新。
- `observe-taxi-pool.mjs` の呼び出し配線・`computeForecast`・forecast/accuracy/correction/ensemble は不変。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| いずれかのカメラの fetch / detect / 推論 失敗 | その tick 全体をスキップ。`track-state.json` 据え置き、`vehicle-track-history.jsonl` 追記なし。次 tick で継続。行が常に全カメラ揃うことを保証 |
| `stall-rois.json` が読めない・壊れている | その tick をスキップ（現行どおり） |
| 旧 v2 `track-state.json` | `state_from_json` が `{}` → 各カメラ `camera_state` が `([], 1)` でクリーン開始 |
| あるカメラの ROI 内 detection ゼロ | そのカメラは検出ゼロで `update_tracks` 実行（既存トラックは順次 `missed`→`departed`）。正常動作 |
| `stall_rois_for_camera` がそのカメラで空 list | `filter_to_rois` が空 list → 検出ゼロ扱い（設定ミス。正常系では起きない） |

## テスト方針

### `tests/test_track_vehicles.py`（unittest 改修）

- `state_from_json`: `schema: 3` ∧ `cameras` dict → その `cameras` を返す。`schema` 不一致（旧 v2・キー無し）→ `{}`。dict でない → `{}`。`cameras` が dict でない → `{}`。
- `camera_state`（新規）: 該当カメラの `(tracks, next_id)` を返す。カメラキー欠落 → `([], 1)`。`tracks` が list でない / `next_id` が int でない → `([], 1)`。`cameras` が dict でない → `([], 1)`。
- 既存の `state_from_json` テスト（schema 2 前提のもの）は schema 3・per-camera 形式に書き換える。
- `update_tracks`・`stall_rois_for_camera`・`filter_to_rois` は不変 → 既存テスト不変。

### `tests/throughput-calibration.test.mjs`（node:test 改修）

- 既存テストの track 行 fixture を v3 per-camera 形式（`{schema_version: 3, ts, cameras: {real01_line: {...departed}, real02: {...departed}}}`）に更新。
- `computeThroughputCalibration`: v3 行の全カメラ `departed` を合算して窓 join する。`schema_version !== 3`（v1/v2）の行は無視する。
- `sumTrackDepartedInWindow`: 同様に v3 行の全カメラ `departed` を合算、非 v3 は無視。
- net-diff outflow が `stall4` を含むことを検証するテストを更新/追加（G-1 既存テストの「stall4 除外」テストは「stall4 を含む」へ反転）。

### 回帰

- `npm test`（node:test）全 pass。
- Python unittest（`test_track_vehicles.py` / `test_detect_vehicles.py`）全 pass。
- `update_tracks` / `detect_vehicles.py` / `computeForecast` / forecast・accuracy・ensemble・correction は不変。

## デプロイ

Mac mini は observe-tick の `git pull` で自動反映。新 pip/npm 依存なし、launchd 変更なし。`track-state.json` は schema マーカーで自己回復するため手動手順ゼロ。デプロイ後の最初の tick から `vehicle-track-history.jsonl` に v3 per-camera 行が追記され、G-1 calibration は v3 データの蓄積に従い `bootstrapping`→`learning` へ進む。

## スコープ外（次フェーズ・ロードマップ）

- C: トラッカー `DIST_THRESHOLD` の適正化（要ジッター実測、別 spec）。
- B 案: baseline 出力の真値化。
- per-stall（stall 別）粒度の追跡 — G-1 は全 stall 合算でしか使わないため不要（YAGNI）。
- 3カメラ目以降の追加 — `TRACK_CAMERAS` への追記で対応可能だが本フェーズ対象外。
- `update_tracks` / `detect_vehicles.py` / `computeForecast` / forecast 系の変更。

## 完了条件

- `track_vehicles.py` が `TRACK_CAMERAS` の全カメラ（Real01_line, Real02）を1 tick で追跡し、`vehicle-track-history.jsonl` に `schema_version: 3` の per-camera 行を追記する。
- `state_from_json`（改修）/ `camera_state`（新規）が純関数で実装され unittest がある。
- `track-state.json` が `schema: 3` の per-camera 構造で保存され、旧 v2 state を自動リセットする。
- `computeThroughputCalibration` / `sumTrackDepartedInWindow` が v3 行のみ採用し、全カメラ `departed` を合算する。
- net-diff outflow が stall1〜stall4 を対象にする。
- `npm test` 全 pass、Python unittest 全 pass。
- `update_tracks` / `detect_vehicles.py` / `computeForecast` / forecast 系は不変。
