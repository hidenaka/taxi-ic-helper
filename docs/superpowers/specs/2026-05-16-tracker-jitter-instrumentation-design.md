# トラッカー jitter 計装 設計（C 前半）

- 日付: 2026-05-16
- 対象: 乗務地図関係 / トラッカーのマッチ距離を記録し、`DIST_THRESHOLD` 適正化のためのジッター分布を観測可能にする
- 前提 spec: `2026-05-16-vehicle-tracking-design.md`（F-3）、`2026-05-16-tracker-stall-roi-restriction-design.md`（G-2）、`2026-05-16-multi-camera-tracking-design.md`（G-3）

## 背景

G-2 の根本原因調査で、トラッカーの `DIST_THRESHOLD=0.06`（マッチ許容半径、正規化座標）が駐車車の間隔（stall1: 170px / 8台 ≈ 21px ≈ 0.035 正規化）より大きいことが判明した。閾値が車間隔より大きいと、ある車の YOLO 検出が一時的に欠けたとき、そのトラックが隣の車の検出に誤マッチしうる（identity churn → 偽 `departed`/`arrived`）。これは systematic-debugging で「副次問題 C」として、ROI 制限（G-2）後の正しい追跡データでジッターを実測してから対応する、と先送りされた。

`DIST_THRESHOLD` の適正値は「ジッター上限 < x < 駐車間隔 0.035」。だがジッター（駐車中＝静止しているはずの車の YOLO box 中心がフレーム間でどれだけ動くか）が実測されていないため、下限が決められない。

`update_tracks` はマッチ成立時に距離 `best_d` を計算しているが使い捨てている。`best_d` がそのトラックのフレーム間移動量＝ジッターそのもの。これを記録すれば、トラッカーは60秒×2カメラで毎分稼働しているので、ジッター分布が副産物として自動で蓄積される。

## 設計方針

1. **計装に徹する。** 本タスクは `update_tracks` のマッチ距離を出力に記録するだけ。`DIST_THRESHOLD` の値は変更しない（実測データが要るため後続タスク）。
2. **加算的変更。** `update_tracks` の戻り値と track 行に `matched_dists` フィールドを足すだけ。schema_version は 3 のまま。既存 consumer（G-1 calibration）は新フィールドを無視するので G-1・`track-state.json` は不変。
3. **既存パターン踏襲。** マッチ距離は `detect_vehicles` の x/y 同様に小数4桁丸め。

## ① `update_tracks` の変更

`update_tracks(prev_tracks, detections, next_id, max_missed, dist_threshold)` は現在、各既存トラックについて最近傍検出までの距離 `best_d`（`dist_threshold` 以内）を求めてマッチする。マッチ成立時の `best_d` をリストに集める。

- マッチ成立（`best_i is not None`）した各トラックについて、`best_d` を小数4桁に丸めて `matched_dists` リストに追加する。
- 戻り値に `matched_dists` を追加: `{tracks, next_id, arrived, departed, matched_dists}`。
- `matched_dists` の順序は `prev_tracks` の走査順（分析では順序は問わない）。
- 未マッチのトラック（`missed`／消滅）・新規トラック（`arrived`）は `matched_dists` に寄与しない。
- 既存の戻り値キー（`tracks`/`next_id`/`arrived`/`departed`）と挙動は不変。`matched_dists` は加算のみ。

## ② `main()` / 出力行

`main()` のカメラループで、各カメラの `update_tracks` 戻り値から `matched_dists` を取り出し、per-camera の行オブジェクトに加える。

行（schema_version 3）の各カメラオブジェクトは現在 `{detected, active, arrived, departed}`。これに `matched_dists` を加える:

```json
{
  "schema_version": 3,
  "ts": "2026-05-16T16:01:00+09:00",
  "cameras": {
    "real01_line": { "detected": 4, "active": 6, "arrived": 1, "departed": 1, "matched_dists": [0.011, 0.007, 0.019] },
    "real02":      { "detected": 2, "active": 3, "arrived": 0, "departed": 1, "matched_dists": [0.014, 0.006] }
  }
}
```

駐車プールは数台規模のため、1カメラ1 tick あたり `matched_dists` は数個の float。データ量は無視できる。

## ③ スキーマ: 変更なし（schema_version 3 のまま）

`matched_dists` は加算的フィールド。既存の v3 consumer は G-1 `throughput-calibration.mjs` のみで、`cameras[*].departed` しか読まず `matched_dists` を無視する。よって:

- `schema_version` は 3 のまま（bump 不要）。
- `throughput-calibration.mjs`・`computeForecast`・forecast 系は不変。
- `track-state.json` は不変。
- `observe-tick-local.sh` の git 配線は不変（`vehicle-track-history.jsonl` は既に add 対象）。

## ④ 閾値設定の判定基準（後続タスク・本タスクのスコープ外）

約1日（2カメラ×1440 tick で数千サンプル）蓄積後、別タスクで `matched_dists` 分布を分析して `DIST_THRESHOLD` を決める。判定基準:

- マッチ距離は「真のジッター（静止車の YOLO ノイズ、小さい）」「列内の前進（同一車・残したい）」「隣車への誤マッチ（駐車間隔 ≈0.035 付近に出る）」の混合。分布から主クラスタ（ジッター＋前進）と 0.035 付近のテール（誤マッチ）を見分ける。
- `DIST_THRESHOLD` = 主クラスタ上端の直上、かつ駐車間隔 0.035 未満。
- もし主クラスタ自体が 0.035 を超える（ジッターが駐車間隔より大きい）なら、単一閾値で誤マッチとジッター吸収を両立できない → 貪欲＋距離マッチ方式の見直し（IoU ベース等）が必要、とエスカレーションする。
- 注: `matched_dists` は現 `DIST_THRESHOLD=0.06` で左側打ち切り（0.06 超のフレーム間移動は未マッチ＝churn になり記録されない）。だが検討対象の閾値は ≤0.035 で 0.06 を十分下回るため、この打ち切りは分析に影響しない。

## エラーハンドリング

計装は `update_tracks`（純関数）内のリスト集計のみ。失敗要因はない。`main()` のカメラループは既存の try で囲まれたまま（変更なし）。

## テスト方針

### `tests/test_track_vehicles.py`（unittest 追加）

`update_tracks` の `matched_dists`:
- マッチ成立 → そのトラックの距離が `matched_dists` に入る。
- 同位置マッチ → 距離 ≈ 0。
- 複数トラックがマッチ → 全件の距離が入る。
- 未マッチトラック（`missed` 増加・消滅）・新規トラック（`arrived`）→ `matched_dists` に寄与しない（マッチ数ぶんだけ）。
- 距離は小数4桁に丸められる。
- 既存6テスト（`TestUpdateTracks`）は戻り値にキーが増えるだけで不変（再確認）。

### 回帰

- Python unittest（`test_track_vehicles.py` / `test_detect_vehicles.py`）全 pass。
- `main()` はネットワーク I/O のため計装は構文/import チェック + unittest 回帰で検証。
- `npm test`（node:test）は不変（G-1 系は触らない）。全 pass を確認。

## デプロイ

Mac mini は observe-tick の `git pull` で自動反映。新 pip/npm 依存なし、launchd 変更なし、`track-state.json` 不変（リセット不要）。デプロイ後の最初の tick から `vehicle-track-history.jsonl` の v3 行に `matched_dists` が記録され始める。

## スコープ外（後続）

- `DIST_THRESHOLD` の値変更そのもの（④の判定基準に従う後続タスク、要データ蓄積）。
- `matched_dists` 分析スクリプト（後続タスクで jsonl を ad-hoc に読めば足りる。YAGNI）。
- マッチアルゴリズム（貪欲＋距離）の変更。
- `throughput-calibration.mjs` / `computeForecast` / forecast 系の変更。

## 完了条件

- `update_tracks` がマッチ成立トラックの距離リスト `matched_dists`（小数4桁丸め）を戻り値に含め、unittest がある。
- `main()` が各カメラの `matched_dists` を v3 行のカメラオブジェクトに記録する。
- `schema_version` は 3 のまま。`throughput-calibration.mjs`・`computeForecast`・`track-state.json`・`observe-tick-local.sh` は不変。
- 既存の `update_tracks` の戻り値キー・挙動は不変。
- `npm test` 全 pass、Python unittest 全 pass。
