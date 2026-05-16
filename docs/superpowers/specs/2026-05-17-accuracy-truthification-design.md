# forecast-accuracy.json の真値単位移行 設計

- 日付: 2026-05-17
- 対象: 乗務地図関係 / 予測精度 JSON の MAE を真の出庫 throughput 単位にする
- 前提 spec: `2026-05-16-throughput-forecast-connection-design.md`（G-1）、`2026-05-16-baseline-output-truthification-design.md`（G-5）

## 背景

G-5 で `stall-forecast.json` / `stall-ensemble.json` の出力を calibration 係数 `k` で真値化（真の出庫台数）した。だが `forecast-accuracy.json` の MAE は net-diff 単位のまま残った（G-5 spec §③で「既知の非整合」として明記・先送り）。UI が真値化された forecast と net-diff 単位の MAE を並べて表示すると単位が食い違う。本タスクで `forecast-accuracy.json` を真値単位に揃える。

## 設計方針

1. **出力境界スケーリング。** MAE は正の同次関数: `mean(|k·予測 − k·実測|) = k · mean(|予測−実測|)`。したがって **真値 MAE = net-diff MAE × k**。G-5 と同じく、`k` の適用は `forecast-accuracy.json` を書き出す瞬間のみ。
2. **内部は net-diff のまま。** `evaluateAccuracy` / `accuracy-evaluator.mjs` 内部 / `buildActualMap` / `forecast-log.jsonl` は変更しない。これにより `forecast-log.jsonl`(net-diff) と actual(net-diff) の整合が保たれ、log と actual の単位全面移行（Option 2）は不要。
3. **in-memory の accuracy オブジェクトは未スケール。** `observe-taxi-pool.mjs` で `evaluateAccuracy` が返す `accuracyResult` は net-diff のまま `computeEnsemble` に渡す。`computeWeights`（ensemble の重み計算）が net-diff のまま不変になる。スケール版は `forecast-accuracy.json` 書き出し用にのみ生成する。
4. **純関数 + 非破壊。** スケール処理は純関数に切り出す。G-5 の `applyThroughputScale` と同じ throughput-calibration.mjs に置く。

## accuracy オブジェクトの構造（現状）

`evaluateAccuracy` の戻り値 = `forecast-accuracy.json` の内容:

```
{
  schemaVersion, generatedAt, logEntryCount,
  recent24h: { forecast: {...}, patternMatch: {...}, winner: {...} },
  allPeriod: { forecast: {...}, patternMatch: {...}, winner: {...} }
}
```

`recent24h` / `allPeriod` の中の `forecast` と `patternMatch` はそれぞれ lead bucket 別:

```
{ lead30: { mae_total, mae_per_stall: [4 要素], n },
  lead60: { ... }, lead120: { ... } }
```

- `mae_total`: outflow 誤差単位。サンプル無しのとき `null`。
- `mae_per_stall`: 4 要素配列、各 outflow 誤差単位。サンプル無しのとき `[null, null, null, null]`。
- `n`: サンプル数（カウント）。
- `winner`: lead bucket 別の文字列（`'forecast'` / `'patternMatch'` / `'n/a'`）。

## ① 純関数 `applyThroughputScaleToAccuracy(accObj, k)`

`scripts/lib/throughput-calibration.mjs` に追加。

`applyThroughputScaleToAccuracy(accObj, k)`:
- `k` を有限かつ正の数に正規化（`Number.isFinite(k) && k > 0` でなければ `1.0`）。
- `accObj` の新コピーを作る（非破壊）。
- `recent24h` と `allPeriod` のそれぞれについて（存在すれば）、その中の `forecast` と `patternMatch` のそれぞれについて（存在すれば）、各 lead bucket（`forecast`/`patternMatch` オブジェクトの各キー）の bucket オブジェクトを次のようにスケール:
  - `mae_total`: 数値なら `Number((mae_total × k).toFixed(3))`、`null`（や非数値）ならそのまま。
  - `mae_per_stall`: 配列なら各要素について、数値なら `Number((要素 × k).toFixed(3))`、`null`（や非数値）ならそのまま。
  - `n` とその他のフィールドはそのまま保持。
  - `丸めは小数3桁`（`accuracy-evaluator.mjs` の `finalizeBucketStats` が `.toFixed(3)` を使うのに合わせる）。
- `winner` はスケールしない（`forecast` と `patternMatch` を同率 `k` でスケールしても `f <= p` の大小は不変なので、`winner` の判定は変わらない）。
- トップレベルの `schemaVersion` / `generatedAt` / `logEntryCount` は保持。
- トップレベルに `throughputScaleK`（正規化済みの `k`）を付与。
- `recent24h` / `allPeriod` / `forecast` / `patternMatch` / lead bucket / `mae_per_stall` が欠けている・想定型でない場合でも例外を投げず、その部分をスキップして処理を続ける（防御的）。
- 戻り値は新オブジェクト。入力 `accObj` は変更しない。

`patternMatch` の MAE も `forecast` と同じ `k` でスケールする。pattern-match も net-diff 由来の予測のため、その真値 ≈ `k` × net-diff であり、`forecast` と単位が揃う。

## ② `observe-taxi-pool.mjs` の配線

- import: `scripts/lib/throughput-calibration.mjs` からの既存 import（G-5 で `applyThroughputScale` を追加済み）に `applyThroughputScaleToAccuracy` を追加。
- `forecast-accuracy.json` の書き出し: 現在 `accuracyResult` を `JSON.stringify` している箇所を、`applyThroughputScaleToAccuracy(accuracyResult, throughputK)` を `JSON.stringify` する形に変更。
- `throughputK` は G-5 で外側スコープに hoist 済みの変数をそのまま使う（forecast ブロックで `calibration.k` がセットされる。既定値 `1.0`）。
- `accuracyResult` 変数自体は変更しない（`applyThroughputScaleToAccuracy` は新オブジェクトを返す）。後段で `accuracyResult` を `computeEnsemble` に渡す箇所は未スケールの net-diff のまま → `computeWeights` は net-diff のまま不変。

## ③ 据え置くもの（意図的に net-diff のまま）

- `forecast-log.jsonl`・`buildActualMap`・`accuracy-evaluator.mjs` の内部（`evaluateAccuracy`/`evaluatePeriod`/`accumulate`/`finalizeBucketStats`）。
- in-memory の `accuracyResult`（`computeEnsemble` に渡るもの）。
- `computeEnsemble` / `computeWeights` / corrections。
- `stall-pattern-match.json` 本体（別タスク）。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `k` が非数値・非正 | `applyThroughputScaleToAccuracy` 内で `1.0` 扱い |
| `recent24h` / `allPeriod` / `forecast` / `patternMatch` / lead bucket が欠ける・想定外の型 | その部分をスキップし、`throughputScaleK` 付きで返す |
| forecast ブロックが catch に落ちる | `throughputK` は既定 `1.0`（恒等スケール） |

`applyThroughputScaleToAccuracy` は純関数・副作用なし。書き出しは既存 try ブロック内のまま。

## テスト方針

### `tests/throughput-calibration.test.mjs`（node:test 追加）

`applyThroughputScaleToAccuracy`:
- accuracy 形オブジェクト + `k=2` → `recent24h` と `allPeriod` の `forecast`・`patternMatch` 全 lead bucket の `mae_total` と `mae_per_stall` 各要素が ×2（小数3桁丸め）。
- `mae_total` が `null` / `mae_per_stall` に `null` 要素 → `null` のまま。
- `n`・`winner`・`schemaVersion`・`generatedAt`・`logEntryCount` が保持される。
- 入力オブジェクトが変更されない（非破壊）。
- 戻り値トップレベルに `throughputScaleK` が付く。
- `k=1` → MAE 値が変わらない（恒等）。
- `k` が非正・非数値 → `1.0` 扱い（恒等）、`throughputScaleK` は `1`。
- `recent24h` 等の構造が欠けたオブジェクト → 例外なく `throughputScaleK` 付きで返る。

### 回帰

- `npm test`（node:test）全 pass。`evaluateAccuracy` / accuracy-evaluator / ensemble 系のテストは net-diff のまま不変。
- `observe-taxi-pool.mjs` はネットワーク I/O のため、構文/import チェック + `npm test` 回帰で検証。

## デプロイ

新 pip/npm 依存なし、launchd 変更なし。Mac mini は observe-tick の `git pull` で自動反映。`k` が `bootstrapping`（=1.0）の間は MAE 不変。`learning` 到達後、`forecast-accuracy.json` の MAE が真値単位になり、`stall-forecast.json` の真値化された forecast と単位が揃う。`throughputScaleK` に適用値が出る。

## スコープ外（後続）

- `stall-pattern-match.json` 本体の真値化。
- `forecast-log.jsonl` / `buildActualMap` の内部単位移行（本設計では不要）。
- C 後半（`DIST_THRESHOLD` 値設定）。

## 完了条件

- `applyThroughputScaleToAccuracy` が純関数で `scripts/lib/throughput-calibration.mjs` に実装され、node:test がある。
- `observe-taxi-pool.mjs` が `forecast-accuracy.json` を `applyThroughputScaleToAccuracy(accuracyResult, throughputK)` 経由で書き出す。
- 書き出される `forecast-accuracy.json` が `k` 倍された MAE と `throughputScaleK` を持つ。
- in-memory の `accuracyResult`（`computeEnsemble` 入力）は未スケール net-diff のまま。
- `evaluateAccuracy` / `accuracy-evaluator.mjs` / `buildActualMap` / `forecast-log.jsonl` / `computeEnsemble` は不変。
- `npm test` 全 pass。
