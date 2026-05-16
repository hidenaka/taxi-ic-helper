# F-3 車両追跡の stall ROI 制限 設計（G-1 修正）

- 日付: 2026-05-16
- 対象: 乗務地図関係 / F-3 トラッカーを stall ROI 内の車両のみに制限する
- 前提 spec: `2026-05-16-vehicle-tracking-design.md`（F-3、実装済）、`2026-05-16-throughput-forecast-connection-design.md`（G-1、実装済）

## 背景：G-1 検証で判明した根本原因

G-1（追跡 throughput → forecast 接続）を実データで検証したところ、calibration の累積比 `k = track_sum / netdiff_sum ≈ 7` という異常値が出た。`systematic-debugging` で真因を追跡した結果：

**F-3 トラッカーは `detect_image()`（Real01_line カメラ全域の YOLO 検出）をそのまま `update_tracks` に渡しており、stall ROI に絞っていない。**

証拠（実データ）:
- `track-state.json` の追跡中17トラックの x 座標分布: stall ROI は x≥0.75（画像最右列）。17台中 stall 内は3台のみ、14台は x∈[0.08, 0.65] の道路車両。
- 検出20サンプル: Real01_line 全検出 ~14-16台、うち stall 内（x≥0.75）は毎回2-5台、stall 外が8-16台。約80%が非 stall。
- コード: `track_vehicles.py` は `detect_image(session, img)` の戻り（画像全域の検出）を ROI フィルタなしで `update_tracks` に渡す。`stall-rois.json` の `_meta`「画像最右端の縦列が観測対象」を無視している。

結論: F-3 の `departed` の約80%は道路車両がカメラ枠から出ただけで、taxi 出庫 throughput ではない。G-1 の `k` は「道路交通量 ÷ stall net-diff」という無意味かつ不安定（道路交通量は taxi 需要と独立に変動）な比になっていた。`K_MAX` をいくつにしても直らない — F-3 の `departed` の中身が誤っている。これは F-3 spec が「全車追跡」を選び stall ROI に絞らなかった設計ミス。G-1 のコード自体は spec 通りで正しい。

## 設計方針

1. **検出を stall ROI に絞ってから追跡する。** `track_vehicles.py` で `detect_image()` の戻りを3つの real01_line stall ROI の union でフィルタし、絞った検出のみ `update_tracks` に渡す。これで `departed` が真の stall 出庫になり net-diff と同スコープに揃う。
2. **G-1 のロジックは不変。** `departed` の意味が正されれば `k` は自動的に net-diff 取りこぼし係数（小さく安定）になる。`computeForecast`・forecast 系は一切変更しない。
3. **データの世代を切る。** 修正後の track 行は意味が変わるため `schema_version` を 1→2 に上げ、calibration は v2 のみ使う。旧 whole-frame データを混ぜない。
4. **`update_tracks` 純関数は不変。** 追跡アルゴリズム本体は変えない。入力（検出リスト）を絞るだけ。
5. **手動デプロイ手順ゼロ。** 旧 `track-state.json` は schema マーカーで自動リセット。
6. **fail-safe。** ROI 設定の読み込み失敗時はその tick をスキップ。

## ① F-3: `track_vehicles.py` の変更

### 新規純関数（unittest 対象）

**`stall_rois_for_camera(stall_rois_json, camera)`**
- `stall_rois_json` = `stall-rois.json` をパースした dict。
- `camera` = カメラ名（例 `'real01_line'`）。
- `stall_rois_json['stalls']` のうち `source`（大文字小文字無視）が `camera` と一致する stall の `roi` を取り出す。
- `_meta.image_size`（既定 `[800, 600]`）で 0-1 正規化した rect の list を返す: `[{'x': rx, 'y': ry, 'w': rw, 'h': rh}, ...]`（`rx = roi.x / img_w` 等）。
- 該当 stall が無ければ空 list。

**`filter_to_rois(detections, rois)`**
- `detections` = `detect_image` の戻り（各 `{x, y, w, h, ...}`、`x`/`y` は中心の 0-1 正規化座標）。
- `rois` = `stall_rois_for_camera` の戻り（正規化 rect の list）。
- detection の中心 `(x, y)` が **いずれかの ROI 内**（`rx <= x < rx + rw` かつ `ry <= y < ry + rh`）のものだけを返す。
- `rois` が空なら空 list を返す（ROI 不明時に全車を通さない — fail-safe）。
- 純関数・副作用なし。

### `main()` のフロー変更

現在:
```
detections = detect_image(session, img)
result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
```

変更後:
```
stall_rois_json を scripts/lib/stall-rois.json からロード（失敗時はその tick をスキップ）
rois = stall_rois_for_camera(stall_rois_json, 'real01_line')
detections = filter_to_rois(detect_image(session, img), rois)
result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
```

`TRACK_IMAGE = 'Real01_line'` に対応するカメラ名は `'real01_line'`（`stall-rois.json` の `source` 値）。定数 `STALL_ROIS_PATH = REPO_ROOT/scripts/lib/stall-rois.json`、`TRACK_CAMERA = 'real01_line'` を追加。`detect_image`・`update_tracks` は不変。

## ② F-3: track 出力スキーマ v1→v2

`vehicle-track-history.jsonl` の行の `schema_version` を `1` から `2` にする。フィールド構成（`ts`/`detected`/`active`/`arrived`/`departed`）は不変。v2 は「`detected`/`active`/`arrived`/`departed` が stall ROI 内の車両のみを表す」ことを意味する。`track_vehicles.py` の行生成で `'schema_version': 2` に変更。

## ③ track-state.json の自己回復

旧 `track-state.json` には whole-frame の17トラック（14台が stall 外）が残る。放置すると修正後の初回 tick で stall 外の旧トラックが検出とマッチせず順次 `missed` 増加 → `MAX_MISSED` 超で `departed` 計上され、約14件の偽出庫が混入する。

対策: `track-state.json` に `schema` キーを導入。
- 定数 `TRACK_STATE_SCHEMA = 2` を `track_vehicles.py` に追加。
- `load_state()`: 読み込んだ dict の `schema` が `TRACK_STATE_SCHEMA` と一致しないとき（旧 state は `schema` キー自体が無い）`([], 1)` を返す（クリーン開始）。一致時のみ既存 `tracks`/`next_id` を採用。
- `save_state()`: `{'schema': TRACK_STATE_SCHEMA, 'tracks': ..., 'next_id': ...}` を書く。

これにより修正コードのデプロイ後、初回 tick で旧 state が自動破棄され、Mac mini での手動 `rm` 不要。

## ④ G-1: `throughput-calibration.mjs` の schema フィルタ

旧 v1（whole-frame）の track 行を calibration に混ぜないため:
- 定数 `TRACK_SCHEMA_VERSION = 2` を `scripts/lib/throughput-calibration.mjs` に追加。
- `computeThroughputCalibration`: track 行を採用する条件に `row.schema_version === TRACK_SCHEMA_VERSION` を追加（現状は全行採用）。net-diff 側が `schema_version === 3` を要求するのと対称。
- `sumTrackDepartedInWindow`: 窓内合算の対象を `row.schema_version === TRACK_SCHEMA_VERSION` の行に限定。

これで calibration は修正後（v2）データのみで `k`・`trackActual` を算出。旧 v1 データは自然に無視される。`observe-taxi-pool.mjs` の呼び出し・`computeForecast`・forecast 系は不変。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `stall-rois.json` が読めない・壊れている | その tick をスキップ（`vehicle-track-history.jsonl` に追記しない、state 据え置き）。`detect_image` 失敗時と同じ fail-safe |
| `stall_rois_for_camera` が空 list（該当 stall 無し） | `filter_to_rois` が空 list を返す → `update_tracks` は検出ゼロで実行（既存トラックは順次 `missed`→`departed`）。観測は継続するが追跡対象ゼロ。設定ミスとして扱う（正常系では起きない） |
| ROI 内 detection ゼロ（プールが空） | `detections=[]` で `update_tracks` 実行。正常動作 |
| 旧 `track-state.json`（`schema` キー無し） | `load_state` が `([], 1)` にリセット |

## テスト方針

### `tests/test_track_vehicles.py`（unittest 追加）

- `stall_rois_for_camera`: `source` 一致 stall のみ抽出、`image_size` での正規化が正しい、大文字小文字無視、該当無しで空 list。
- `filter_to_rois`: ROI 内の detection を通す / ROI 外を除外 / 複数 ROI の union（どれか1つに入れば通る）/ `rois` 空で空 list / 境界（`rx <= x < rx+rw` の半開区間）。
- `load_state`: `schema` が一致しない state（旧形式・`schema` キー無し）→ `([], 1)`。`schema` 一致 → 既存 `tracks`/`next_id` を採用。
- 既存の `update_tracks` 6テストは不変。

### `tests/throughput-calibration.test.mjs`（node:test 追加・更新）

- `computeThroughputCalibration`: `schema_version !== 2` の track 行（v1 等）を窓 join の対象にしない。
- `sumTrackDepartedInWindow`: `schema_version !== 2` の track 行を合算しない。
- 既存テストの track 行 fixture（`schema_version: 1` または未指定で生成しているもの — `computeThroughputCalibration` 用も `sumTrackDepartedInWindow` 用も）に `schema_version: 2` を付与し、既存アサーションが通ることを確認。

### 回帰

- `npm test`（node:test、現 427 件）全 pass。
- Python unittest（`test_track_vehicles.py` / `test_detect_vehicles.py`）全 pass。
- `update_tracks`・`detect_vehicles.py`・`computeForecast`・D系・E系・ensemble は不変。

## デプロイ

Mac mini は observe-tick の `git pull` で自動反映。新 pip 依存なし、launchd 変更なし。`track-state.json` は③で自己回復するため手動手順ゼロ。修正後の最初の tick から `vehicle-track-history.jsonl` に v2 行が追記され、calibration は v2 データの蓄積に従い `bootstrapping`→`learning` へ進む。

## スコープ外（次フェーズ・ロードマップ）

- **C: `DIST_THRESHOLD` の適正化** — `DIST_THRESHOLD=0.06` は駐車間隔（~0.035 正規化）より大きく、混雑時に隣の駐車車へ誤マッチしうる。ただし適正値には ROI 制限後の正しい追跡データでの「YOLO box 中心のフレーム間ジッター」実測が必要。本フェーズ完了後、再測定してから別 spec で対応。
- per-stall（stall 別）追跡。
- 複数カメラ追跡。
- `detect_vehicles.py` / `update_tracks` / `computeForecast` / forecast・accuracy・ensemble・correction の変更。
- baseline 出力の真値化（G-1 のロードマップ B 案）。

## 完了条件

- `track_vehicles.py` が `detect_image` の検出を real01_line stall ROI union でフィルタしてから `update_tracks` に渡す。
- `stall_rois_for_camera` / `filter_to_rois` が純関数で実装され unittest がある。
- `vehicle-track-history.jsonl` の行が `schema_version: 2` で追記される。
- `load_state` が旧 schema の `track-state.json` を自動リセットし、`save_state` が `schema` を書く。
- `computeThroughputCalibration` / `sumTrackDepartedInWindow` が `schema_version === 2` の track 行のみ使用する。
- `npm test` 全 pass、Python unittest 全 pass。
- `update_tracks` / `detect_vehicles.py` / `computeForecast` / forecast 系は不変。
