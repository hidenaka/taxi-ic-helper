# T3需要圧力 方向性補正 設計 (Phase E-2)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / D-4 で `unobservable` だった T3 share 補正の有効化
- 前提 spec: `2026-05-16-terminal-share-correction-design.md` (D-4)、`2026-05-16-t3-pool-observation-design.md` (E-1、実装済)
- 関連: `2026-05-16-coefficient-online-correction-design.md` (D-3)

## 背景

D-4 で transit-share 補正を端末別 (T1/T2/T3) に分離したが、T3 (国際線) は観測4 stall に無く `source: "unobservable"`・`factor: 1.0` 固定とした。E-1 で T3乗り場 (No5TaxiStand の `Real106`/`Real107`) と待機所プールの画像メトリクスを `t3-pool-history.jsonl` に並行収集し始めた。

本フェーズは E-1 の収集データを使い、D-4 の T3 を `unobservable` から「需要圧力ベースの方向性補正 (`directional`)」に格上げする。

### 方向性補正の限界 (明示)

T3乗り場は curb (流動レーン) で、タクシーの滞在は1分未満。5分間隔のスナップショットでは throughput (台数) を数えられない。したがって D-4 の T1/T2 のような `Σ実測台数 ÷ Σ推定台数` の正確な比率補正は T3 には**原理的に成立しない**。

本フェーズが行うのは**弱い経験則**: T3乗り場先頭の「活性度」を相対的に見て、rate を ±20% の範囲で方向性的に nudge するだけ。絶対精度は主張しない。`source: "directional"` で「学習中 (`learning`)」とも「観測外 (`unobservable`)」とも区別する。

## 設計方針

1. **E-1 の既存データを使う。** `t3-pool-history.jsonl` が既に収集している `Real106` の `black_ratio` を活性プロキシに使う (タクシー = 暗色)。新規 ROI 校正・observe ステップ変更・スキーマ変更は**しない**。
2. **自己アンカー。** 外部の「空き baseline」を持たず、観測データ内で全バケット平均を基準に相対化する。
3. **狭い bound。** 粗い経験則なので factor は `[0.8, 1.2]` に clip。
4. **D-4 のコードを壊さない。** `computeShareCorrection` (D-4) と `buildEffectiveTransitShare` (D-4) は変更しない。D-4 の `buildEffectiveTransitShare` は既に `entry.T3.factor` を読んで適用するため、T3 が `directional` factor になれば自動で transit-share の T3 rate に乗る。
5. **fail-safe。** observe-tick の T3 補正ステップは try/catch。失敗しても T3 は D-4 の stub (`factor 1.0`) のまま、本処理は継続。

## アルゴリズム: `computeT3DirectionalCorrection`

`correction-engine.mjs` の新規純関数。シグネチャ: `computeT3DirectionalCorrection(t3PoolRows, transitShare, now)`。

1. 入力 `t3PoolRows` は `t3-pool-history.jsonl` の全行 (各行 `{ts, t3_stand:[{name, black_ratio,...}], pool:[...]}`)。
2. 完了日 (当日より前、`ts.slice(0,10) < ymd(now)`) の行のみ対象。
3. 各行について `t3_stand` 配列から `name === "Real106"` のエントリの `black_ratio` を取り出す (無ければその行はスキップ)。行の時刻 `ts.slice(11,16)` (= "HH:MM") を `pickBucket` で transit-share のバケットに振り分ける。
4. バケット別に `black_ratio` を集計し平均 → `activity[bucketId]`、tick 数 → `n[bucketId]`。
5. `n >= T3_MIN_TICKS` のバケットの `activity` 値の平均 → `overall`。
6. 各バケットの factor:
   - `n[bucketId] < T3_MIN_TICKS` または `overall <= 0` → `{ factor: 1.0, source: "fallback", n, relativeActivity: null }`。
   - それ以外: `relative = activity[bucketId] / overall`、`factor = clip(1 - T3_DIRECTIONAL_GAIN * (relative - 1), T3_FACTOR_MIN, T3_FACTOR_MAX)` → `{ factor, source: "directional", n, relativeActivity }`。
7. transit-share の全バケット id について戻り値を返す (データ無しバケットも `fallback` で埋める)。

方向の意味: あるバケットの先頭活性が相対的に**高い** (滞留タクシー多め = 供給潤沢) → `relative > 1` → `factor < 1` (T3 rate 下げ)。相対的に**低い** (先頭が空きがち = タクシー即消費) → `factor > 1` (T3 rate 上げ)。全バケット平均では中立 (ゼロサム的再配分)。

### 定数 (correction-engine.mjs)

| 定数 | 値 | 意味 |
|---|---|---|
| `T3_MIN_TICKS` | 20 | バケットの観測 tick 数がこれ未満なら fallback |
| `T3_DIRECTIONAL_GAIN` | 0.2 | 相対活性 → factor のゲイン |
| `T3_FACTOR_MIN` | 0.8 | factor 下限 |
| `T3_FACTOR_MAX` | 1.2 | factor 上限 |

## 接続

### `correction-engine.mjs`
- `computeT3DirectionalCorrection` を追加。
- `CORRECTION_SCHEMA_VERSION` を 3 に上げる (coefficient-corrections.json の `share.<bucket>.T3` の意味が `unobservable` 固定から `directional` に変わるため)。
- `computeShareCorrection` / `buildEffectiveTransitShare` は変更しない。

### `observe-taxi-pool.mjs` (Phase D-3 ブロック)
`computeShareCorrection` で `corrections.share` を作った後、`t3-pool-history.jsonl` を読んで `computeT3DirectionalCorrection` を呼び、各バケットの `T3` を差し替える:

```
t3PoolRows = t3-pool-history.jsonl をパース
t3dir = computeT3DirectionalCorrection(t3PoolRows, transitShare, new Date())
for (bucketId of Object.keys(corrections.share)):
    if (t3dir[bucketId]) corrections.share[bucketId].T3 = t3dir[bucketId]
```

`computeShareCorrection` が出す T3 stub (`{factor:1.0, source:"unobservable"}`) を上書きする。このステップは try/catch で囲み、失敗時は stub のまま。

### `js/forecast-render.js`
`renderCorrections` の share テーブルの T3 セル: 現在 `source === "unobservable"` で「観測外」と表示している。`directional` のときは factor 値と「方向性」ラベルを表示する。`unobservable` のときは従来どおり「観測外」。

## データフロー

```
[observe-tick]
  computeShareCorrection → corrections.share (T1/T2 learning, T3 stub)
  t3-pool-history.jsonl → computeT3DirectionalCorrection → T3 directional
  corrections.share[*].T3 を directional で上書き
  → coefficient-corrections.json (schemaVersion 3)
        ↓
[fetch-arrivals] buildEffectiveTransitShare が T3 rate に T3.factor を適用 (D-4 実装済)
        ↓
[forecast.html] 係数補正状態テーブル T3 列に方向性 factor 表示
```

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `t3-pool-history.jsonl` が無い・空 | 全バケット `fallback`、T3 補正は実質無効 (factor 1.0) |
| 完了日の Real106 データが閾値未満 | 当該バケットのみ `fallback` |
| `t3_stand` に Real106 が無い行 | その行はスキップ |
| `black_ratio` が数値でない | その行はスキップ |
| `computeT3DirectionalCorrection` 例外 | observe-tick の try/catch で握る。T3 は D-4 stub のまま |

## テスト方針

`tests/correction-engine.test.mjs` に `computeT3DirectionalCorrection` のテストを追加:
- `t3PoolRows` 0 件 → 全バケット fallback
- 当日データのみ → fallback (完了日なし)
- 全バケット均一活性 → factor ≈ 1.0
- あるバケットの活性が相対的に高い → そのバケット factor < 1、低い → factor > 1
- バケット tick 数 < `T3_MIN_TICKS` → そのバケット fallback
- factor が bound [0.8, 1.2] でクリップされる

完了条件: `npm test` 全件パス (401 → 約407)。

## スコープ外

- T3乗り場の精密 ROI 校正 (`t3-rois.json`) — `Real106` 全体 `black_ratio` で代替
- 待機所プール (Real03/04/108/109) の供給量モデル化
- T3 の台数ベース正確比率補正 (curb 5分サンプリングでは原理的に不可)
- `Real107` の活用 (Real106 のみ使用)
- `taxi-pool-history.jsonl` / forecast / accuracy / ensemble の変更

## 完了条件

- `npm test` 全件パス
- `computeT3DirectionalCorrection` が純関数として実装され、バケット別の `directional` / `fallback` factor を返す
- `observe-taxi-pool.mjs` が `t3-pool-history.jsonl` から T3 補正を計算し `coefficient-corrections.json` の `share.<bucket>.T3` に反映
- `CORRECTION_SCHEMA_VERSION` が 3
- `coefficient-corrections.json` の T3 が `unobservable` 固定でなく `directional` (データ十分時) になる
- `forecast.html` の係数補正テーブル T3 列が方向性 factor を表示
- `computeShareCorrection` / `buildEffectiveTransitShare` (D-4) と E-1 の収集ステップは不変
- データ不足時は T3 factor 1.0 (`fallback`) で現行と同じ挙動
