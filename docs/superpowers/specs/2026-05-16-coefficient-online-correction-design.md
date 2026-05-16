# 係数オンライン補正 設計 (Phase D-3)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / transit-share 率と forecast レベルの2段補正
- 前提 spec: `2026-05-16-forecast-accuracy-tracking-design.md` (Phase D-1、実装済)、`2026-05-16-ensemble-weighting-design.md` (Phase D-2、実装済)
- 関連: `2026-05-15-stall-forecast-mvp-design.md` (C-1), `2026-05-15-pattern-matching-mvp-design.md` (C-2)

## 背景

Phase D-1 で `forecast-log.jsonl` に予測スナップショット、`forecast-accuracy.json` に lead time 別 MAE を継続記録する基盤ができた。Phase D-2 で forecast と pattern-match を MAE 逆数重みで統合する `stall-ensemble.json` ができた。

しかし D-1/D-2 は「どちらの予測方式を信じるか」を学習するだけで、各方式が持つ**系統バイアス（一貫した過大・過小予測）そのもの**は補正しない。さらに `transit-share.json` の便客→台数変換率は手動校正値であり、`_meta` に「5/31 Phase A 観測終了後、フルサンプルで再校正予定」と明記されている。この再校正を自動化・継続化するのが Phase D-3 である。

## 予測パイプラインの構造（重要）

```
便データ → estimateTaxiPax(transit-share rates) → arrivals.json の estimatedTaxiPax
  → computeForecast の flightFactor[i] = flightSums[i] / dailyAvg（自己正規化）
  → forecast.stallK = round(baseline[slot] × trendFactor × flightFactor[i])
  → computeEnsemble(forecast, patternMatch, accuracy) → stall-ensemble.json
```

`flightFactor` は当該 slot の便量を当日平均で割った**自己正規化された比**である。したがって:

- transit-share 率を**一律**に上下させても `estimatedTaxiPax` の絶対値が分子分母で相殺され、**forecast は変化しない**。一律補正が効くのは `arrivals.html` の台数表示のみ。
- transit-share 率を**バケット間で非一律**に補正すると `flightFactor` の時間的形状が変わり、forecast の時間分布に波及する。
- forecast の予測**レベル（絶対量）**を決めるのは `baseline × trendFactor`。

よって2段補正はそれぞれ別の対象を持つ:

| 段 | 補正対象 | 主効果 | 消費パイプライン |
|---|---|---|---|
| Stage 1 | transit-share バケット率 | `arrivals.html` の台数表示精度、forecast の時間的形状 | `fetch-arrivals.mjs`（Action `update-arrivals.yml`） |
| Stage 2 | forecast 予測レベル | 統合予測（ensemble）のレベル精度 | `observe-tick` 内の ensemble 生成 |

## 設計方針

1. **base config は不変。** `transit-share.json` と `forecast-engine.mjs` の係数定数は一切書き換えない。補正は別ファイル `data/coefficient-corrections.json` に持ち、適用側が乗算する。常に可逆。
2. **補正係数は生成物。** EMA や前回値を持たず、ログ・観測からの**決定論的ウィンドウ加重平均**で毎 tick 再計算する。`stall-forecast.json` 等と同じ「毎 tick 全体再生成」。冪等。
3. **D-1 / D-2 を改変しない。** `forecast-log.jsonl` と `stall-forecast.json` は RAW のまま。D-1 は生モデルの精度を測り続ける。D-3 は `forecast-log.jsonl` を読むだけ、`buildActualMap` を import するだけ（accuracy-evaluator.mjs は不変）。
4. **fail-safe。** Stage 1/2 とも try/catch。失敗しても本観測 jsonl 追記・forecast 生成は継続。`coefficient-corrections.json` 欠損/不正時は補正係数を全 1.0 とし、現行と完全に同一動作。

## アーキテクチャ

```
[observe-tick] 5分毎、D-1 accuracy 評価の後
  1. Stage 1: computeShareCorrection(arrivalsSnapshots, actualMap, now)
  2. Stage 2: computeLevelCorrection(forecastLog, actualMap, now)
  3. → data/coefficient-corrections.json を書き込み（git管理）
  4. correctedForecast = applyLevelCorrection(forecastResult, corrections)
     → computeEnsemble(correctedForecast, patternMatch, accuracy, now)
        ↓
[fetch-arrivals.mjs]（別Action update-arrivals.yml）
  buildEffectiveTransitShare(transitShareMaster, corrections)
  → 実効 transit-share で estimateTaxiPax → arrivals.json
        ↓
[forecast.html]「係数補正状態」セクション
```

`stall-forecast.json`（forecast.html「内訳: ルールベース短期予測」）と `forecast-log.jsonl` は RAW を維持する。Stage 2 補正は `computeEnsemble` の forecast 入力にのみ適用するため、補正は compounding せず、`levelFactor` は常に `ウィンドウ平均(actual / raw)` を直接表す。

## Stage 1: transit-share バケット率補正

### 入力
- `arrivalsSnapshots`: `data/arrivals-snapshots/arrivals-YYYY-MM-DD.jsonl` を observe-tick がパースした行配列（`flightNumber`, `estimatedTaxiPax`, `lobbyExitTime`, `terminal` を含む）。ファイル I/O は observe-tick 側、純関数はパース済みデータを受け取る。
- `actualMap`: `buildActualMap(history)`（accuracy-evaluator.mjs から import）の戻り値 `Map<"YYYY-MM-DD#slotIdx", [s1,s2,s3,s4]>`。Stage 2 と同じものを再利用し、`taxi-pool-history` の二重読み込みを避ける。

### アルゴリズム
1. 直近 `SHARE_WINDOW_DAYS = 7` の**完了日**（＝当日を除く過去日）を対象。利用可能日が 7 未満なら全完了日。
2. 各完了日について:
   - その日の `arrivalsSnapshots` の便ごとに**その日の最終スナップショット行**の `estimatedTaxiPax` と `lobbyExitTime` を採用（`flightNumber` で dedupe）。
   - 便を `lobbyExitTime` で transit-share の `buckets[].fromHHMM/toHHMM` に振り分け、バケット別に `Σ estimatedTaxiPax` を集計。
   - `actualMap` からその日・各バケットの時間範囲に入る slotIdx の `Σ 実測outflow`（4 stall 合計）を集計。
   - バケット別の日次比率 `dayRatio[bucket] = Σ実測outflow / Σ estimatedTaxiPax`（`Σ estimatedTaxiPax <= 0` のバケットはその日スキップ）。
3. バケット別に、複数日の `dayRatio` を**直近日ほど重い線形加重平均**で集約（最古日 weight 1 〜 最新日 weight = 日数）。
4. `shareFactor[bucket]` = 集約値。clip ∈ `[SHARE_FACTOR_MIN=0.3, SHARE_FACTOR_MAX=3.0]`。
5. フォールバック: そのバケットの寄与便総数 `< SHARE_MIN_FLIGHTS = 20`、または有効日数 0 → `shareFactor = 1.0`, `source: "fallback"`。それ以外 `source: "learning"`。

注: バケット率は terminal（T1/T2/T3）別に存在するが、実測 outflow は terminal を区別しないため、`shareFactor` はバケット単位・**3 terminal 一律**に掛ける（手動校正 `_meta` の「旧値 × 0.25」も一律だった方針と一致）。

## Stage 2: forecast レベル補正

### 入力
- `data/forecast-log.jsonl`: D-1 が記録した RAW 予測スナップショット（`ts`, `forecast` slot 配列）。
- `actualMap`: `buildActualMap(history)`（accuracy-evaluator.mjs から import）の戻り値。

### アルゴリズム
1. 直近 `LEVEL_WINDOW_HOURS = 48` 以内に発行された forecast-log エントリを対象。
2. 各エントリの各予測 slot について、D-1 と同じ slotKey ロジックで `actualMap` から実測を引く（実測なし slot はスキップ）。lead time（発行時刻からの分数）を D-1/D-2 と同じ lead bucket（`lead30`=±42分以下 → 30分側 / `lead60` / `lead120`）に振り分け。
3. lead bucket 別に予測合計と実測合計のペアを蓄積し、`levelFactor[leadBucket] = Σ実測total / Σ予測total`。
4. clip ∈ `[LEVEL_FACTOR_MIN=0.5, LEVEL_FACTOR_MAX=2.0]`。
5. フォールバック: lead bucket のペア数 `< LEVEL_MIN_SAMPLE = 20`、または `Σ予測total <= 0` → `levelFactor = 1.0`, `source: "fallback"`。それ以外 `source: "learning"`。

### 適用
`applyLevelCorrection(forecast, corrections)`: forecast の各 slot について lead time から lead bucket を引き、`stallK_corrected = round(stallK × levelFactor[leadBucket])`、`total` を再計算。新しい forecast オブジェクトを返す（純関数、入力非破壊）。observe-tick は補正済み forecast を `computeEnsemble` に渡す。

## data/coefficient-corrections.json スキーマ

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-16T17:05:00+09:00",
  "share": {
    "early":     { "factor": 1.0,  "source": "fallback", "flightCount": 0,  "dayCount": 0 },
    "morning":   { "factor": 0.92, "source": "learning", "flightCount": 64, "dayCount": 7 }
  },
  "level": {
    "lead30":  { "factor": 1.0,  "source": "fallback", "n": 0 },
    "lead60":  { "factor": 1.15, "source": "learning", "n": 38 },
    "lead120": { "factor": 1.0,  "source": "fallback", "n": 12 }
  }
}
```

`share` は transit-share の全 8 バケット id（`early`/`morning`/`noon`/`afternoon`/`peak1`/`evening`/`peak2`/`midnight`）を必ず含む。`level` は `lead30`/`lead60`/`lead120` を必ず含む。

## buildEffectiveTransitShare

`fetch-arrivals.mjs` 用の純関数。`transit-share.json`（マスター）と `coefficient-corrections.json` を入力に、各バケットの `rates.T1/T2/T3` を `shareFactor[bucket.id]` 倍した**実効 transit-share オブジェクト**を返す（マスター非破壊）。`maxRatio`/`reachBoost`/`delayBoost` 等は不変。`coefficient-corrections.json` が無い・不正なら係数 1.0（＝マスターのコピー）を返す。`fetch-arrivals.mjs` は実効 transit-share を `estimateTaxiPax` に渡す（`taxi-estimator.mjs` は不変）。

## ファイル構成

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/correction-engine.mjs` | Create | 純関数: `computeShareCorrection` / `computeLevelCorrection` / `applyLevelCorrection` / `buildEffectiveTransitShare` |
| `tests/correction-engine.test.mjs` | Create | 単体テスト ~12 件 |
| `data/coefficient-corrections.json` | Create（生成物） | share×8 + level×3 |
| `scripts/observe-taxi-pool.mjs` | Modify | Stage1/2 生成 + ensemble 入力に level 補正適用 |
| `scripts/fetch-arrivals.mjs` | Modify | 実効 transit-share を構築して estimateTaxiPax |
| `scripts/observe-tick-local.sh` | Modify | git add / checkout 対象に coefficient-corrections.json 追加 |
| `forecast.html` | Modify | 「係数補正状態」セクション |
| `js/forecast-render.js` | Modify | `renderCorrections` 追加 |
| `js/forecast-app.js` | Modify | coefficient-corrections.json fetch + render |

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| arrivals-snapshots / forecast-log が空・欠損 | 全バケット/leadBucket `source: "fallback"`, factor 1.0 |
| バケット便数 < 20 / ペア数 < 20 | 当該係数のみ fallback |
| `coefficient-corrections.json` 欠損・JSON 不正（fetch-arrivals 側） | `buildEffectiveTransitShare` がマスターのコピーを返す（現行と同一動作） |
| `computeShareCorrection` / `computeLevelCorrection` 例外 | try/catch、observe-tick 本体は継続。corrections 未生成時 ensemble は RAW forecast を使用 |
| factor が clip 範囲外・NaN | clip で `[min, max]` に矯正、NaN は 1.0 |

## テスト方針

`tests/correction-engine.test.mjs`（`node:test` + `node:assert/strict`）:
- `computeShareCorrection`: 完了日 0 件 → 全 fallback / 正常入力 → バケット比率 / 便数不足バケットのみ fallback / clip 上限
- `computeLevelCorrection`: ログ 0 件 → 全 fallback / 予測=実測 → factor 1.0 / 予測過小 → factor > 1 / ペア不足 → fallback / clip 下限
- `applyLevelCorrection`: factor 1.0 → 不変 / factor 1.5 → round 乗算・total 再計算 / 入力非破壊
- `buildEffectiveTransitShare`: corrections 無し → マスターのコピー / factor 適用 → rates 乗算・maxRatio 不変

完了条件: `npm test` 全件パス（371 → ~383 件）。

## スコープ外（D-4 以降）

- terminal（T1/T2/T3）別の share 補正（今回はバケット単位・端末一律）
- `trendFactor` / `baseline` 自体のパラメータ補正
- 補正係数の履歴記録・推移グラフ
- pattern-match のレベル補正（今回は forecast のみ）

## 完了条件

- `npm test` 全件パス（371 → ~383 件）
- `scripts/lib/correction-engine.mjs` 純関数として実装
- observe-tick で `data/coefficient-corrections.json` が 5 分毎に更新される
- `fetch-arrivals.mjs` が実効 transit-share で `estimatedTaxiPax` を生成
- `observe-tick` の ensemble 入力に level 補正が適用される
- `forecast.html` に「係数補正状態」セクションが表示される
- `observe-tick-local.sh` の git add / checkout 対象に coefficient-corrections.json 追加
- スコープ外（不変）: `forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json`
- 観測 jsonl 追記との衝突なし
