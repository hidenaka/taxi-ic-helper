# baseline 出力の真値化 設計（B案）

- 日付: 2026-05-16
- 対象: 乗務地図関係 / forecast の出力 JSON を真の出庫 throughput 単位にする
- 前提 spec: `2026-05-16-throughput-forecast-connection-design.md`（G-1）、`2026-05-16-tracker-stall-roi-restriction-design.md`（G-2）、`2026-05-16-multi-camera-tracking-design.md`（G-3）

## 背景

G-1 で追跡 throughput を forecast の `trendFactor` に接続したが、forecast の**出力単位は net-diff のまま**にした。net-diff（`diff_occupied_from_prev` の負分）は真の出庫台数を系統的に過小評価する。G-1 calibration の係数 `k` が `true_throughput ≈ k × net-diff` を推定している。

B案は forecast の出力 JSON（`stall-forecast.json` / `stall-ensemble.json`）の数値を真の出庫台数（≈ net-diff × `k`）にする。G-1 spec で「D-1・correction・ensemble の単位移行を伴う」として別 spec に先送りされていた。

### blast-radius 調査結果

forecast の outflow 数値の下流消費者を調べた結果:

- **corrections（D-3 level / transit-share / D-4 / E-2）**: すべて比率ベース（`actualSum / predSum` 等）。forecast を `k` 倍しても分子分母が同じ比なので**単位不変・安全**。
- **accuracy（D-1）**: `evaluateAccuracy` は logged forecast(net-diff) と actual(`buildActualMap`、net-diff) の MAE。forecast 出力だけ `k` 倍して actual を net-diff のままにすると MAE が壊れる。
- **ensemble**: `computeEnsemble` は forecast と pattern-match を加重平均（`fc[name]*w_fc + pm[name]*w_pm`）。forecast 内部を `k` 倍すると pattern-match と単位がズレる。
- **forecast-log.jsonl**: 未スケールの forecast を log。accuracy / level-correction の入力。

結論: 内部パイプラインは net-diff 単位で整合している。これを壊さず、**`k` を「出力 JSON を書き出す瞬間」だけに適用**する。内部全面移行（Option 2）は corrections が元々比率不変で利得がなく、ただの大規模リファクタになるため採らない。

## 設計方針

1. **出力境界スケーリング。** `k` の適用は `stall-forecast.json` と `stall-ensemble.json` を書き出す瞬間のみ。slot の outflow 数値を `k` 倍して書く。
2. **内部は net-diff のまま。** `computeForecast` / `computeBaseline` / `computeEnsemble` のロジック、`forecast-log.jsonl`、`forecast-accuracy.json`、corrections は一切変更しない。これにより accuracy・correction の内部整合が保たれる。
3. **機構先行・データ後追い。** `k` は G-1 calibration の値。`bootstrapping` 中は `k=1.0`（×1.0＝恒等、出力不変）、`learning` 到達後に真値化が効く。
4. **純関数 + 非破壊。** スケール処理は純関数に切り出し、入力オブジェクトを破壊しない（logging には未スケール版を使うため）。

## ① 純関数 `applyThroughputScale(obj, k)`

`scripts/lib/throughput-calibration.mjs` に追加（`k` を扱うモジュールが自然な置き場）。

`applyThroughputScale(obj, k)`:
- `obj` は forecast または ensemble の出力オブジェクト（`{slots: [...], ...}` 形）。
- `k` を有限かつ正の数に正規化（`Number.isFinite(k) && k > 0` でなければ `1.0` を使う）。
- `obj.slots` が配列でなければ、`{...obj, throughputScaleK: <正規化済み k>}` を返す（防御）。
- `obj.slots` が配列なら、各 slot について新オブジェクトを作る:
  - `stall1` / `stall2` / `stall3` / `stall4` を `Math.round(値 × k)` にする（値が数値でなければそのまま）。
  - `total` は**スケール後の stall1-4 の合計**で再計算する（`total` を独立に `k` 倍しない — 丸め誤差で `total ≠ Σstall` になるのを防ぐ）。
  - slot のその他フィールド（`slotStart` / `slotEnd` / `flightFactor` / `leadBucket` 等）はそのままコピー。
- トップレベルのその他フィールド（`schemaVersion` / `generatedAt` / `trendFactor` / `trendWindow` / `baselineSampleCount` / `weights` 等）はそのままコピー。`trendWindow.actual` / `trendWindow.expected` は net-diff 診断値なのでスケールしない。
- トップレベルに `throughputScaleK`（適用した正規化済み `k`）を付与。
- 戻り値は新オブジェクト。入力 `obj` とその `slots` は変更しない。

forecast の slot（`{slotStart, slotEnd, flightFactor, stall1..4, total}`）と ensemble の slot（`{slotStart, leadBucket, stall1..4, total}`）は被スケール部分（`stall1..4`, `total`）が同一構造のため、同一関数で両方扱える。

## ② `observe-taxi-pool.mjs` の配線

- import: `scripts/lib/throughput-calibration.mjs` からの既存 import に `applyThroughputScale` を追加。
- 外側スコープ（`let forecastResult = null;` 等と同じ場所）に `let throughputK = 1.0;` を追加。
- forecast の try ブロック内、`calibration` を算出した後に `throughputK = calibration.k;` をセットする。
- `stall-forecast.json` の書き出し: 現在 `writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(forecastResult, null, 2) + '\n', 'utf8')` を、`forecastResult` の代わりに `applyThroughputScale(forecastResult, throughputK)` を `JSON.stringify` する形に変更。
- `stall-ensemble.json` の書き出し: 現在 `writeFileSync(ENSEMBLE_OUTPUT_PATH, JSON.stringify(ensemble, null, 2) + '\n', 'utf8')` を、`ensemble` の代わりに `applyThroughputScale(ensemble, throughputK)` を `JSON.stringify` する形に変更。
- `forecastResult` / `ensemble` 変数自体は変更しない（`applyThroughputScale` は新オブジェクトを返す）。`buildLogEntry(forecastResult, ...)` は**未スケールの `forecastResult`**（net-diff）を logging する → accuracy / correction が net-diff 整合のまま。これが設計の肝。
- `throughputK` の既定値 `1.0`: forecast ブロックが例外で catch に落ちても `1.0`（恒等スケール）。

## ③ 据え置くもの（意図的に net-diff のまま）

- `forecast-log.jsonl`: 未スケール net-diff。accuracy の突き合わせ相手 actual（`buildActualMap`）も net-diff のため。
- `forecast-accuracy.json`: net-diff 単位の MAE。モデル品質・ensemble 重み計算の内部指標として単位不変に機能する。
  - **既知の非整合**: 真値化後、UI が `stall-forecast.json`（真値）と `forecast-accuracy.json`（net-diff MAE）を並べると単位が異なる。accuracy を真値単位にするには actual 側（`buildActualMap`）の移行が必要で Option 2 の大規模リファクタになる。本タスクではやらない。
- `coefficient-corrections.json` と corrections: 比率ベースで単位不変、不変。
- `stall-pattern-match.json`: スコープ外。
- `computeForecast` / `computeBaseline` / `computeEnsemble` / `accuracy-evaluator.mjs` / `correction-engine.mjs`: 内部ロジック不変。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| forecast ブロックが catch に落ちる | `throughputK` は既定 `1.0` のまま → 出力は恒等スケール（実害なし） |
| `k` が非数値・非正 | `applyThroughputScale` 内で `1.0` 扱い |
| `obj.slots` が配列でない | `throughputScaleK` だけ付けて返す（slot スケールはスキップ） |

`applyThroughputScale` は純関数・副作用なし。各書き出しは既存 try ブロック内のまま。

## テスト方針

### `tests/throughput-calibration.test.mjs`（node:test 追加）

`applyThroughputScale`:
- forecast 形オブジェクト + `k=2` → 各 slot の stall1-4 が ×2 丸め、`total` がスケール後 stall 合計。
- ensemble 形オブジェクト（`slots[].leadBucket` 等）でも同様に動く。
- `k=1` → 数値が変わらない（恒等）。
- 非 slot フィールド（`slotStart` / `flightFactor` / `leadBucket`）とトップレベルフィールド（`schemaVersion` / `trendFactor` / `trendWindow` / `weights`）が保持される。`trendWindow.actual` がスケールされない。
- 入力オブジェクトと入力 `slots` が変更されない（非破壊）。
- 戻り値トップレベルに `throughputScaleK` が付く。
- `total` はスケール後 stall1-4 の合計に等しい（独立スケールでない）。
- `k` が非正・非数値 → `1.0` 扱い（恒等）、`throughputScaleK` は `1`。
- `obj.slots` が配列でない → `throughputScaleK` だけ付与して返す。

### 回帰

- `npm test`（node:test）全 pass。`computeForecast` / `computeEnsemble` / accuracy / correction 系のテストは net-diff のまま不変。
- `observe-taxi-pool.mjs` はネットワーク I/O のため、構文/import チェック + `npm test` 回帰で検証。

## デプロイ

新 pip/npm 依存なし、launchd 変更なし、`track-state.json` 不変。Mac mini は observe-tick の `git pull` で自動反映。`k` が `bootstrapping`（=1.0）の間は出力不変。`learning` 到達後、`stall-forecast.json` / `stall-ensemble.json` の slot outflow が真の出庫台数になり、`throughputScaleK` に適用値（>1）が出る。

## スコープ外（後続・ロードマップ）

- `stall-pattern-match.json` の真値化。
- `forecast-accuracy.json` の真値単位移行（actual 側 `buildActualMap` の移行を伴う Option 2）。
- `computeForecast` / `computeBaseline` / `computeEnsemble` / corrections の内部ロジック変更。
- C 後半（`DIST_THRESHOLD` 値設定）。

## 完了条件

- `applyThroughputScale` が純関数で `scripts/lib/throughput-calibration.mjs` に実装され、node:test がある。
- `observe-taxi-pool.mjs` が `stall-forecast.json` と `stall-ensemble.json` を `applyThroughputScale(..., throughputK)` 経由で書き出す。
- 書き出される両 JSON が `k` 倍された slot outflow と `throughputScaleK` を持つ。
- `forecast-log.jsonl` は未スケール net-diff のまま（`buildLogEntry` は未スケール `forecastResult` を使う）。
- `forecast-accuracy.json` / corrections / `computeForecast` / `computeEnsemble` は不変。
- `npm test` 全 pass。
