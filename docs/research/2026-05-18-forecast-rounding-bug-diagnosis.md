# 予測が「ほぼ0＋5の倍数スパイク」になるバグ — 診断書

> 作成: 2026-05-18 / 調査者: Claude（タクシー日報セッション）
> 次セッションへ: この診断は完了済み。ここから設計→計画→TDD実装を行う。

## 症状

`data/stall-ensemble.json`（予測の最終出力）が、2時間ぶん96個の値のうち **92個が 0**、残りが 5 / 5 / 5 / 15。値がすべて 5 の倍数。日報アプリの予測表が「ほぼ全部ゼロ、たまに突発スパイク」になり、羽田夕方ラッシュの実態と乖離。

## 根本原因（確定）

**「早すぎる四捨五入」**。予測の素の値は小数の出庫レート（後述の実測で中央値 0.333 台/5分/乗り場）。それを **整数に丸めてから throughputScaleK(=5) を掛けている** ため、小数が 0 に潰れ、`0 × 5 = 0` のまま戻らない。0.5 以上だった所だけ生き残り `1→×5→5`, `3→×5→15`。

早すぎる丸めは **3 か所**:

1. **`scripts/lib/forecast-engine.mjs` `computeForecast`**
   `const val = ... Math.round(b * trendFactor * f);`
   ルールベース予測を slot 出力時点で整数に丸めている。

2. **`scripts/lib/pattern-matcher.mjs`（行 244-247 付近）**
   `const stall1 = count > 0 ? Math.round(stallSums[0] / count) : 0;`（stall1〜4）
   類似日マッチングの `historicalCurve` も平均を整数に丸めている。

3. **`scripts/lib/ensemble-engine.mjs` `computeEnsemble`（行 100 付近）**
   `val = Math.round(fc[name] * w_fc + pm[name] * w_pm);`
   統合時にも丸めている。

その後 `scripts/lib/throughput-calibration.mjs` の `applyThroughputScale` が
`out[name] = Math.round(slot[name] * scale)` で `×k` してから丸めるが、入力が既に 0 に潰れた後。

## 証拠（実測）

`computeBaseline` を `data/taxi-pool-history.jsonl`（schema3, sampleCount 773）に適用した結果:

- 非 null のベースライン slot 値: 704 個
- 値の分布: `=0`:407 / `(0,0.1)`:0 / **`[0.1,0.5)`:166** / `[0.5,1)`:92 / `[1,2)`:34 / `>=2`:5
- 非ゼロ値: min 0.167 / 中央 0.333 / 平均 0.553 / max 8.0
- **現行（`round(b)`）では 0 になるが、`round(b×5)` なら非0になる slot: 166 / 704（24%）**

→ 166 スロットが「本来 1〜2 台」なのに 0 と表示されている。「ほぼ0」はプール実態ではなく丸めバグが主因。

## 修正方針

3 か所の `Math.round` を外し、**小数のまま予測パイプラインを通す**。整数化は最後の
`applyThroughputScale` の `round(値 × k)` 1 回だけにする。`0.333 → ×5 → 1.67 → round → 2`。

| ファイル | 変更 |
|---|---|
| `forecast-engine.mjs` | `computeForecast`: `slotOut[name] = b * trendFactor * f`（round 除去）。`total` は小数和 |
| `pattern-matcher.mjs` | `historicalCurve`: `stallN = count>0 ? stallSums[i]/count : 0`（round 除去）。`total` は小数和 |
| `ensemble-engine.mjs` | `computeEnsemble`: `val = (pm===null)? fc[name] : fc[name]*w_fc + pm[name]*w_pm`（round 除去） |
| `throughput-calibration.mjs` | `applyThroughputScale` は変更不要（最後の `round(×k)` がそのまま正しく機能する） |

## 波及・確認事項

- **書き出される JSON の型は変わらず整数**（`applyThroughputScale` が最後に丸めるため）。値が正しくなるだけ。表示側（`forecast.html`・日報アプリ）の改修は不要。
- **テスト更新が必要**: `tests/forecast-engine.test.mjs` / `tests/pattern-matcher.test.mjs` /
  `tests/ensemble-engine.test.mjs` は整数出力を前提にしているはず → 小数前提に更新。
- **精度評価**: `evaluateAccuracy` / `forecast-log.jsonl` / `computeWeights` は forecast 値が小数でも
  算術上そのまま動く（MAE は実数で計算可）。HANDOFF の「accuracy は net-diff 単位据え置き」も
  維持される（小数の net-diff 単位になるだけ）。念のため実装時に回帰確認すること。
- `observe-taxi-pool.mjs` は `computeForecast`→`computeEnsemble`→`applyThroughputScale` の順で
  raw（未スケール）オブジェクトを受け渡している（行 325-326, 442 付近）。小数化しても流れは不変。

## 限界（修正後も残る）

「占有数の負の差分＝出庫」という観測方式自体の系統的過小評価は残る（同一 tick で出庫＋入庫が
相殺されると net-diff 0）。`throughputScaleK` は平均的なズレを補正するが、丸めバグ修正は
「補正が機能する状態に戻す」もの。方式そのものの精度向上は別課題。

## 追補（2026-05-18）— 4つ目の早すぎる丸めを発見

3か所の修正実装後の最終レビューで、**4つ目の早すぎる丸め**が判明した。本診断は
`stall-ensemble.json` のパイプラインを `computeForecast → computeEnsemble → applyThroughputScale`
と捉えていたが、実際の `observe-taxi-pool.mjs`（行 435-437）は
`computeForecast → applyLevelCorrection → computeEnsemble → applyThroughputScale`
であり、間の `applyLevelCorrection`（レベル補正）の段を見落としていた。

`scripts/lib/correction-engine.mjs` の `applyLevelCorrection`（61行）が
`Math.round((slot[name] || 0) * factor)` で forecast を整数化している。`computeForecast` で
小数化した forecast が ensemble に入る前にここで再び潰れる。特に `factor=1.0`
（学習20件未満のブートストラップ既定値）では `round(0.333×1.0)=0` で完全に潰れ、
`stall-ensemble.json` が「ほぼ0」のまま残る。修正は他3か所と同型（`Math.round` 除去）。
`applyLevelCorrection` の出力 `correctedForecast` は `computeEnsemble` にしか渡らないため波及なし。

**教訓**: パイプライン診断は、エンジン関数の呼び出しグラフだけでなく、実呼び出し元
（`observe-taxi-pool.mjs`）の中間段（補正・整形ステップ）まで追うこと。
