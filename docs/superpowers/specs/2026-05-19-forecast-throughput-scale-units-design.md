# 予測パイプラインの throughput スケール単位整合 設計書

> 作成: 2026-05-19

## 目的

予測パイプラインの `throughput` スケール係数 `k`（ネット差分→実台数の補正）が、
トラッカー実測ベース予測に二重適用される問題を解消する。すべての出力ファイルを
実台数単位に揃え、`k` を「ネット差分単位のものにだけ1回」適用する。

## 背景・問題

`observe-taxi-pool.mjs` は `applyThroughputScale(x, k)` で出力 JSON をスケールする。
`applyThroughputScale` は「ネット差分単位 → 実台数」の変換であり、入力がネット差分単位で
あることを前提とする。

しかし `computeForecast` のトラッカーアンカー経路（`trendWindow.levelSource ===
'track-anchored'`）の出力は**すでに実台数単位**（乗り場別実測レート × 便需要比）。
ここに `k` を掛けると二重適用になる。実際の配信データで確認:

- `data/throughput-calibration.json`: `k=5`（track_sum 2277 / netdiff_sum 426 = 5.35 → K_MAX 5.0 で頭打ち）。
- `data/stall-forecast.json`: `levelSource: track-anchored` かつ `throughputScaleK: 5` が同居。
  → トラッカー実測ベース予測が5倍に膨張。第4乗り場の実値「7」が「35」として配信されていた。

さらに統合予測（ensemble）は `computeEnsemble(生の forecast, 生の historicalCurve)` で
**単位の異なるもの**を混ぜてから `applyThroughputScale(ensemble, k)` している。
forecast がトラッカー実測（実台数）・historicalCurve がネット差分単位だと、混合時点で
単位不整合、さらに ensemble 全体に `k` を掛けて forecast 部分を膨張させる。

## 採用アプローチ

**原則: 混ぜる前に各要素を実台数単位へ揃える。`k` は「混ぜる前」「各要素に1回」だけ。**

| 構成要素 | 元の単位 | 適用するスケール |
|---|---|---|
| forecast（track-anchored） | 実台数 | ×1.0（整数化のみ） |
| forecast（netdiff-fallback） | ネット差分 | ×k |
| pattern-match（historicalCurve） | ネット差分 | ×k（従来どおり） |
| ensemble | 実台数化済みの forecast + historicalCurve を混合 | ×1.0（整数化のみ・追加のkなし） |

`applyThroughputScale(obj, 1.0)` は `Math.round(値 × 1)` で**丸めのみ**を行う。
forecast-engine の小数値を整数化する唯一の地点として機能する（係数は1.0なので膨張なし）。

不採用: `applyThroughputScale` に「丸めなしモード」を追加して二重丸めを避ける案 —
丸め誤差は ±0.5台で実用上無視でき、変更範囲が広がるため YAGNI。

## 設計

### 1. 純関数ヘルパ `forecastOutputK`（`throughput-calibration.mjs`）

forecast 結果に適用すべきスケール係数を返す。Fix 1（forecast ファイル書き出し）と
Fix 2（ensemble の forecast 入力）の両方で使うため共通化する。

```javascript
/**
 * forecast 結果に適用すべき throughput スケール係数を返す。
 * トラッカーアンカー経路の予測はすでに実台数単位なので 1.0（k を掛けない）。
 * net-diff フォールバック経路はネット差分単位なので k。
 * @param {object|null} forecastResult computeForecast の戻り値
 * @param {number} calibrationK throughput 校正の k
 * @returns {number}
 */
export function forecastOutputK(forecastResult, calibrationK) {
  const tw = forecastResult && forecastResult.trendWindow;
  return (tw && tw.levelSource === 'track-anchored') ? 1.0 : calibrationK;
}
```

### 2. `observe-taxi-pool.mjs` — forecast ファイル書き出し（Fix 1）

`stall-forecast.json` の書き出しを条件付きスケールにする。

- 変更前: `applyThroughputScale(forecastResult, throughputK)`
- 変更後: `applyThroughputScale(forecastResult, forecastOutputK(forecastResult, throughputK))`

### 3. `observe-taxi-pool.mjs` — ensemble（Fix 2）

ensemble ブロックを「混ぜる前に実台数化」へ組み替える。

- forecast 入力: `applyLevelCorrection` 適用後（level 補正は乗算なので k と可換）、
  `applyThroughputScale(correctedForecast, forecastOutputK(forecastResult, throughputK))`
  で実台数化したものを `computeEnsemble` に渡す。
- historicalCurve 入力: `applyThroughputScale({historicalCurve}, throughputK,
  'historicalCurve')` で実台数化したものを渡す。
- ensemble 出力: `computeEnsemble` の結果を `applyThroughputScale(ensemble, 1.0)` で
  **丸めのみ**して書き出す（追加の k なし）。

pattern-match ファイル（`stall-pattern-match.json`）の書き出しは従来どおり
`applyThroughputScale(patternMatchResult, throughputK, 'historicalCurve')`（常にネット差分単位）。

## これで解決すること

- トラッカー実測ベース予測が `k` 倍されなくなり、第4乗り場の5倍水増しが消える。
- ensemble が単位の揃った要素を混合し、二重スケールしなくなる。
- どの出力ファイルも実台数単位、`k` 適用は各要素ちょうど1回。

## スコープ外

- 精度評価（`stall-forecast-accuracy.json`、`applyThroughputScaleToAccuracy`）。
  `evaluateAccuracy` はネット差分由来の `actualMap` と forecast を比較するため、
  forecast が実台数のとき単位不整合が残る。MAEベースの混合重みは相対比なので
  5倍膨張の原因ではない。予測本体の修正後に別途検討する。
- `buildLogEntry` の予測ログ記録（生の forecastResult を記録。上記精度評価の入力）。
- F-3 トラッカーの停止疑い（track-history が 06:55 で停止）。運用側で別途確認。
- `applyThroughputScale` への「丸めなしモード」追加。

## テスト方針（TDD）

- `forecastOutputK`: track-anchored → 1.0、netdiff-fallback → k、`forecastResult`
  が null / `trendWindow` 欠落 → k（安全側）。`tests/throughput-calibration.test.mjs`。
- `observe-taxi-pool.mjs` はファイル I/O を伴う統合スクリプトで単体テスト対象外。
  `node --check` ＋ `npm test` 全件回帰 ＋ 実データのドライラン検証で守る。

## 実データ検証

実 history で `computeForecast` → `forecastOutputK` → `applyThroughputScale` を通し、
トラッカーアンカー経路のとき `throughputScaleK` が 1、出力 slot 値が `computeForecast`
の生値と一致する（5倍でない）ことを確認する。

## 成功基準

- `forecastOutputK` が track-anchored で 1.0、netdiff で k を返す。
- `stall-forecast.json` がトラッカーアンカー時 `throughputScaleK: 1`。
- `stall-ensemble.json` が二重スケールされない（混合前に各要素を実台数化、後段は丸めのみ）。
- `npm test` 全件回帰パス。
- 実データ検証でトラッカーアンカー予測が5倍されない。
