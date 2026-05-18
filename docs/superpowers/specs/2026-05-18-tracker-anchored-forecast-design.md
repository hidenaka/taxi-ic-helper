# トラッカー実測アンカー型 予測土台 再設計 — 設計書

> 作成: 2026-05-18

## 目的

タクシー出庫予測（`stall-ensemble.json`）が需要ピーク時に「全スロット0」になる構造的欠陥を解消する。

## 背景・根本原因

予測の土台 baseline は `computeBaseline`（`forecast-engine.mjs`）が `taxi-pool-history.jsonl` の `diff_occupied_from_prev`（占有数の前tick比変化、負の分＝出庫）を時間帯スロットごとに平均して作る。乗り場が満車のとき、出庫しても即座に次のタクシーが埋めるため占有数が動かず `diff=0` になる。実測（2026-05-18 19:27）で乗り場は満車（占有 8/7/8/8）かつ `diff` 全0、一方 F-3 車両トラッカーは直近60分で **69台の出庫を検出**。

`computeForecast` は `予測 = baseline × trendFactor × flightFactor`。トラッカー実測（actual=69）は `trendFactor`（倍率）にしか使われず、baseline が0だと倍率をいくら掛けても0。**正確な throughput 信号（トラッカー）を掴んでいるのに予測の土台に反映できない設計**が欠陥。

満車になるのは需要ピーク時＝予測が最も必要な時間帯であり、影響は大きい。

## 採用アプローチ（B1）

予測のレベル（何台/5分）を **トラッカー実測出庫レートのアンカー**に再設計する。前向き形状は**フライト需要比**で与える。

```
予測総数[i] = 実測出庫レート × (将来便需要[i] / 直近便需要)
```

- **実測出庫レート**: F-3 トラッカーが直近60分窓で検出した出庫合計（`vehicle-track-history.jsonl` の `departed` 窓集計）を 5分スロットあたりに換算。
- **将来便需要[i] / 直近便需要**: `arrivals.json` の `flights[].lobbyExitTime`＋`estimatedTaxiPax` から、将来スロット i の便需要と直近測定窓の便需要を算出し、その比で実測レートを前向きに変調する。
- net-diff baseline は廃止せず、トラッカー未到達（`bootstrapping`）・欠測窓のときの**弱フォールバック**に降格する。

### 不採用案
- **B2（トラッカーレベル × net-diff baseline 形状）**: 形状を net-diff baseline の時間帯カーブから取るが、満車時は baseline が0で形状比が未定義になる。まさに必要な場面で壊れるため却下。
- **C（トラッカーで288スロット日次baseline再構築）**: 最も正統だが、トラッカーデータは現状 2.3日分（3,215行、2026-05-16〜）と薄く、安定した日次パターンを作れない。データ蓄積後の将来課題。

## 設計

### 1. computeForecast のレベル再設計（中核）

`scripts/lib/forecast-engine.mjs` の `computeForecast`。

- 新たに「トラッカーアンカー経路」を設ける。発動条件: `trackTrend` が有効（`learning` 到達・直近窓に十分なトラッカー実測がある）。
- 実測出庫レート `trackRatePerSlot` = `trackTrend.actual` ÷ 測定窓スロット数。
- 便需要: `arrivals.json` から
  - `recentFlightDemand` = 直近測定窓に `lobbyExitTime` が入る便の `estimatedTaxiPax` 合計
  - `futureFlightDemand[i]` = 将来スロット i に `lobbyExitTime` が入る便の `estimatedTaxiPax` 合計（既存 `flightSums` ロジックを流用）
- スロット予測総数:
  - `recentFlightDemand > 0` の場合: `forecastTotal[i] = trackRatePerSlot × clip(futureFlightDemand[i] / (recentFlightDemand / 測定窓スロット数), FLIGHT_FACTOR_MIN, FLIGHT_FACTOR_MAX)`
  - `recentFlightDemand = 0`（直近に便needデータなし）の場合: `forecastTotal[i] = trackRatePerSlot`（横ばい）。深夜帯の逓減は将来課題とし本spec では一定。
- **乗り場別配分**: トラッカーの `departed` は乗り場別に分離できないため、`forecastTotal[i]` を stall1-4 へ配分する。配分比は「直近 tick の各乗り場 `occupied_estimate` の合計に対する比」を用いる。占有データが取得できない場合は均等配分（1/4 ずつ）。
- **フォールバック経路**: トラッカーアンカー経路が発動しない（`trackTrend` 無効）ときは、現行の `baseline × trendFactor × flightFactor` 経路をそのまま使う（後方互換・net-diff baseline は弱フォールバックとして存続）。
- 出力 `trendWindow`（メタ）に、どちらの経路で算出したかを示す `levelSource`（`'track-anchored'` / `'netdiff-fallback'`）を加える。

### 2. ensemble の希釈ガード

`scripts/lib/ensemble-engine.mjs` の `computeEnsemble`。

pattern-match の `historicalCurve` は net-diff 由来のため満車時0のまま。トラッカーアンカー型の forecast（非0）と0の pattern-match を加重平均すると予測が希釈される。

- スロット単位で、pattern-match 側 slot の `total` が 0（構造的に利用不可）のときは、その slot に限り **forecast を 100% 採用**する（既存の `pm === null` 分岐と同じ扱い）。
- pattern-match 側 slot が非0のときは従来どおり加重平均。

### 3. スコープ外（follow-up）

pattern-match（類似日マッチ）自体を net-diff からトラッカー実測ベースへ作り替えるのは**別 spec**。本 spec は computeForecast のトラッカーアンカー化と、ensemble がそれに引きずられないガードまで。

## テスト方針（TDD）

各 Task で失敗テスト→実装→パス→commit。

- `computeForecast` トラッカーアンカー経路: `trackTrend` 有効＋便需要ありで `forecastTotal = trackRatePerSlot × 便需要比` になる。
- フォールバック経路: `trackTrend` 無効時は現行の net-diff 経路の結果と一致（後方互換）。
- 乗り場別配分: 占有比による配分。占有データ欠損時は均等配分。
- `recentFlightDemand = 0` 時は横ばい。
- `computeEnsemble` 希釈ガード: pattern-match slot total=0 のスロットは forecast 100%、非0は加重平均。
- `npm test` 全件 ＋ Python テストで回帰確認。

## 実データ検証

修正後、満車・`diff=0` の実データ（2026-05-18 夕方相当）で予測パイプラインを走らせ、`stall-ensemble.json` 相当が**非0の予測を出す**こと、トラッカー実測（actual≈69/60分）と整合するオーダーであることを確認する。

## 波及・確認事項

- 出力 JSON のスキーマ（slots の stall1-4・total）は不変。`applyThroughputScale` は据え置き。`trendWindow` に `levelSource` を追加（追加のみ）。
- `evaluateAccuracy` / `forecast-log.jsonl` / `computeWeights` は forecast 値の算出方式が変わっても算術はそのまま動く。回帰テストで確認。
- `observe-taxi-pool.mjs` の `computeForecast` 呼び出しは引数不変（`trackTrend` は既に渡している）。トラッカーアンカーに必要な追加入力（直近占有・arrivals）は既存の引数から得る。

## 限界（本 spec 後も残る）

- pattern-match が net-diff のままなので、ensemble は希釈ガードで forecast 100% に倒れる場面が増える（forecast 単独に近づく）。pattern-match のトラッカー化は follow-up。
- トラッカー自体の欠測時はフォールバック経路（net-diff）に戻るため、満車かつトラッカー欠測が重なると依然0になりうる。
- 深夜帯の需要逓減は本 spec では扱わない（便需要0時は横ばい）。

## 成功基準

- トラッカーアンカー経路・フォールバック経路・乗り場別配分・ensemble 希釈ガードのユニットテストがパス。
- `npm test` 全件 ＋ Python テストが回帰なしでパス。
- 実データ検証で、満車・`diff=0` 条件でも `stall-ensemble.json` が非0予測を出す。
