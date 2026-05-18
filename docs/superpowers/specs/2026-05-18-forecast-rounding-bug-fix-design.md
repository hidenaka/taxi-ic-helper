# 予測の早すぎる四捨五入バグ修正 — 設計書

> 作成: 2026-05-18 / 前提診断: `docs/research/2026-05-18-forecast-rounding-bug-diagnosis.md`

## 目的

予測の最終出力 `data/stall-ensemble.json` が「ほぼ全部0＋5の倍数の突発スパイク」になる不具合を解消する。原因は予測パイプライン3か所での「早すぎる四捨五入」。小数の出庫レート（実測中央値 0.333 台/5分/乗り場）を整数に丸めてから校正係数 `k`（×5）を掛けるため、小数が 0 に潰れ `0×5=0` のまま戻らない。実測で 166/704 スロット（24%）が本来 1〜2 台なのに 0 化している。

## 採用アプローチ

**案A**: 早すぎる `Math.round` 3か所を除去し、小数のまま予測パイプラインを通す。整数化は書き出し時の `applyThroughputScale`（`round(値×k)`）1回のみに集約する。

### 不採用案

- **案B（`×k` スケールの前倒し）**: `k` は書き出し時に適用する校正定数（G-5 設計）。各エンジンに散らすと log・accuracy が net-diff 単位を保つ不変条件が壊れる。却下。
- **案C（丸め精度を上げる）**: `applyThroughputScale` が唯一必要な整数化であり、中間でフル小数を保持する方が単純かつ正確。中途半端なため却下。

## 変更内容

コード4ファイルに関係するが、**修正は3ファイル、1ファイルは変更なし**。

| ファイル | 関数 | 変更 |
|---|---|---|
| `scripts/lib/forecast-engine.mjs` | `computeForecast`（170行付近） | `const val = ... Math.round(b * trendFactor * f)` → `b * trendFactor * f`。`total` は小数和になる |
| `scripts/lib/pattern-matcher.mjs` | `historicalCurve` 構築（244-247行付近） | `const stallN = count>0 ? Math.round(stallSums[i]/count) : 0` → `count>0 ? stallSums[i]/count : 0`（stall1〜4）。`total = stall1+..+stall4` は小数和になる |
| `scripts/lib/ensemble-engine.mjs` | `computeEnsemble`（100行付近） | `val = Math.round(fc[name]*w_fc + pm[name]*w_pm)` → `val = fc[name]*w_fc + pm[name]*w_pm`。`pm===null` 分岐（98行 `val = fc[name]`）は `fc[name]` が小数化するため自動的に小数通過。`total` は小数和になる |
| `scripts/lib/throughput-calibration.mjs` | `applyThroughputScale` | **変更なし**。最後の `out[name] = Math.round(slot[name] × scale)` と `total = Σ out[name]` がそのまま正しく機能する |

## 修正後の挙動

- **書き出される JSON の型は整数のまま**。`applyThroughputScale` が書き出し時に `round(値×k)` し、`total` をスケール後 stall1〜4 の整数和として再計算するため、出力スキーマは不変。値が正しくなるだけ。
- `forecast.html`・日報アプリの表示側改修は**不要**。
- 校正係数 `k≈5`（learning）が効いている現状、症状の原因だった 166/704 スロットが `0.333 → ×5 → 1.67 → round → 2` で非0に戻る。

## テスト方針（TDD）

1. `tests/forecast-engine.test.mjs` / `tests/pattern-matcher.test.mjs` / `tests/ensemble-engine.test.mjs` の整数出力前提アサーションを小数出力前提に更新する。更新後、現行（未修正）コードに対して**失敗**することを確認する。
2. コード3ファイルを修正し、失敗テストがパスすることを確認する。
3. `npm test`（451件）＋ Python（`tests.test_detect_vehicles` 13件・`tests.test_track_vehicles` 29件）で全回帰を確認する。`throughput-calibration` 系テストは小数入力でも `round(×k)` がそのまま機能する想定だが、回帰で確証する。

各 Task は失敗テスト→実装→パス→commit の TDD サイクルで進める。

## 実データ検証

ユニットテストに加え、修正後に実際の `data/taxi-pool-history.jsonl` から予測パイプライン（`computeForecast` → `computeEnsemble` → `applyThroughputScale`）を再生成し、以下を実証する。

- 0 → 非0 に転じるスロット割合が診断書の 166/704（24%）と整合すること。
- `stall-ensemble.json` 相当の出力が「ほぼ0＋5の倍数スパイク」でなくなること。

## 波及・確認事項

- `evaluateAccuracy` / `forecast-log.jsonl` / `computeWeights` は forecast 値が小数でも算術がそのまま成立する（MAE は実数で計算可、net-diff 単位は維持）。回帰テストで確認する。
- `observe-taxi-pool.mjs` は `computeForecast` → `computeEnsemble` → `applyThroughputScale` の順に raw（未スケール）オブジェクトを受け渡すのみ。小数化しても流れは不変。
- spec/plan の commit に観測データファイル（`taxi-pool-history` / `t3-pool-history` / `vehicle-detection-history` / `vehicle-track-history` / 再生成系 JSON）を混入させない。commit 前に `git diff --cached --name-only` で確認する。

## 限界（修正後も残る）

「占有数の負の差分＝出庫」という観測方式自体の系統的過小評価は残る（同一 tick で出庫＋入庫が相殺されると net-diff 0）。`throughputScaleK` が平均的なズレを補正するが、本修正は「補正が機能する状態に戻す」もの。観測方式そのものの精度向上は別課題。

## 成功基準

- 更新した3エンジンのユニットテストが小数出力前提でパスする。
- `npm test` 451件 ＋ Python 42件が全てパスする（回帰なし）。
- 実データ再生成で 0→非0 転換スロットが診断書の約24%と整合し、出力が「ほぼ0＋5の倍数」でなくなる。
