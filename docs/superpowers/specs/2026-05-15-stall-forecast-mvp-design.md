# 短期需要予測 MVP (stall ベース) 設計

- 日付: 2026-05-15
- 対象: 乗務地図関係 / 短期需要予測エンジン (Phase C-1)
- 親 PM チケット: `.company/pm/tickets/2026-05-15-short-term-demand-forecast-by-stall.md`
- 関連: `.company/pm/tickets/2026-05-15-pattern-matching-demand-prediction.md` (Phase C-2 で本格化)

## 背景

中間中間報告 (2026-05-15 16:30) で校正後の transit-share と stall 別実観測パターンが揃った。次のステップは「**今後 1-2 時間の各乗り場のタクシー需要を予測してフロント表示**」。

設計の核心はユーザー指摘:
> 分配率っている？各乗り場で動いたタクシーの数見ているんだから T ではなく乗り場ごとに仕分けたい

つまり、便→terminal→stall の分配ではなく、**stall 別の実観測パターンをそのまま予測の基礎にする**。便情報は時間帯ピーク補正としてのみ使う。

## ゴール

1. 過去 jsonl から stall 別の時間帯パターン (baseline) を生成
2. 直近トレンド (60 分) と今日の便量で補正して 24 slot (= 2 時間) の予測を出す
3. observe-tick (5 分毎) で予測を更新、`data/stall-forecast.json` に出力
4. `forecast.html` で 5 分粒度 × stall1-4 × 24 slot を表表示

## 非ゴール

- 便の terminal による stall 分配 (Phase C-2 以降で snapshot 蓄積後に再評価)
- 曜日効果 (DOW 別 baseline)
- 天候別 baseline (雨天/晴天)
- パターンマッチング (類似日抽出) — 別 PM チケット `2026-05-15-pattern-matching-demand-prediction.md`
- A/B 出庫の自動分離
- 予測精度の自動評価ループ

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| `data/taxi-pool-history.jsonl` | read-only、観測ジョブが追記 |
| `data/arrivals.json` | read-only、fetch ジョブが更新 |
| 観測 ROI / stall-rois.json | 不変 |
| transit-share.json (校正後) | 不変 |

### 変更・新規ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/forecast-engine.mjs` | Create | 純関数 `computeBaseline` / `computeForecast` |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾で `computeForecast` 呼び出し、`data/stall-forecast.json` を書き出す |
| `data/stall-forecast.json` | Create (生成物) | 5min × stall1-4 × 24 slot |
| `forecast.html` | Create | 予測表示ページ |
| `js/forecast-app.js` | Create | エントリ |
| `js/forecast-render.js` | Create | テーブル描画 |
| `tests/forecast-engine.test.mjs` | Create | 単体テスト 8-10 件 |

## 予測ロジック

```
予測(stall_n, slot_t) =
  baseline[stall_n, slot_t]    # 過去の stall 別時間帯出庫平均
  × trendFactor                # 直近 60 分の実測 / baseline 同期間期待値
  × flightFactor[slot_t]       # 今日の slot 別便量 / 今日平均
```

3 つの因子を順に説明する。

### 1. baseline[stall_n, slot_t]

- 入力: `data/taxi-pool-history.jsonl` 全期間
- 信頼サブセット: schema=3 ∧ luminance_mean_1 >= 30 ∧ ts 順序正常 ∧ stalls 非 null
- slot キー: `(hour, minute // 5)` で 288 slot (24h × 12 slot/h)
- 各 slot × stall1-4 で `max(0, -diff_occupied_from_prev)` (= 出庫数) の平均
- サンプル数 < 2 の slot: 隣接 ±1 slot から線形補間
- baseline は memoize 可能 (jsonl 末尾追記時のみ更新)

サンプル不足の caveat: 5/15 時点で信頼サブセット ~500 行 / 288 slot ≈ 1.7 サンプル/slot。MVP として動かすが精度は低い。5/31 までに 14 日 × 288 ≒ 4000 行 → 14 サンプル/slot で精度向上。

### 2. trendFactor

```
recent_actual = sum(直近 12 tick の total_outflow)      # 60 分間の実測
recent_expected = sum(baseline[*, slot_t-12 〜 slot_t-1] の全 stall 合計)
trendFactor = clip(recent_actual / recent_expected, 0.3, 3.0)
```

- 「今日は全体的に多め」「今日は雨で boost」を反映
- 直近 12 tick が信頼サブセット外 (夜間等) なら trendFactor = 1.0 (補正なし)
- clip でノイズ・初期値暴走を抑える

### 3. flightFactor[slot_t]

```
flightSum[slot_t] = sum(arrivals.json 内で lobbyExitTime が slot_t 範囲内の便の estimatedTaxiPax)
daily_avg = mean(flightSum[全 24 slot])
flightFactor[slot_t] = clip(flightSum[slot_t] / daily_avg, 0.3, 3.0)
```

- 今日のピーク時間帯を補正に反映 (例: 17:35 に大型便ピーク → flightFactor=2.5)
- terminal は使わない (全 stall 共通の時間帯偏り)
- daily_avg = 0 のフェイルセーフ: flightFactor = 1.0
- estimatedTaxiPax (校正後) は便ベース台数なので、人/台 換算問題は発生しない

### 最終予測

```javascript
const predicted = Math.round(
  baseline[stall_n][slot_t]
  * trendFactor
  * flightFactor[slot_t]
);
```

## 出力 JSON 仕様

`data/stall-forecast.json`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-15T17:30:00+09:00",
  "anchorTick": 970,
  "trendFactor": 0.87,
  "trendWindow": { "actual": 6, "expected": 6.9, "ticks": 12 },
  "baselineSampleCount": 503,
  "slots": [
    {
      "slotStart": "17:30",
      "slotEnd": "17:35",
      "flightFactor": 1.45,
      "stall1": 2,
      "stall2": 1,
      "stall3": 3,
      "stall4": 2,
      "total": 8
    }
    /* ... 24 slot ... */
  ]
}
```

## データフロー

```
[5 min observe-tick]
  └→ scripts/observe-taxi-pool.mjs
       1. 既存処理 (画像取得、stall 解析、jsonl 追記)
       2. 新規: computeBaseline(jsonl_all) → baseline (memoize)
       3. 新規: computeForecast(baseline, jsonl_recent_12, arrivals_json, now) → forecast
       4. data/stall-forecast.json を書き出し
       5. 既存処理 (git add/commit/push)
            ↓
[GitHub Pages]
  └→ forecast.html: data/stall-forecast.json を fetch → テーブル描画
```

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| jsonl 信頼サブセットが極端に少ない (< 100 行) | baseline 全 slot = null、forecast スキップ、stall-forecast.json は前回値のまま |
| 直近 12 tick が夜間 (信頼サブセット外) | trendFactor = 1.0 |
| arrivals.json 読み込み失敗 | flightFactor 全 slot = 1.0 |
| computeForecast 例外 | try/catch、observe-tick 本体は継続、stderr にログ |
| stall-forecast.json 書き込み失敗 | エラーログのみ、本観測 jsonl 追記は継続 |

## フロント (forecast.html)

```
今後 2 時間の予測 (2026-05-15 17:30 時点)
直近トレンド × 0.87 / baseline サンプル 503 行

時刻   stall1 stall2 stall3 stall4 合計  便量×
17:30    2      1      3      2     8    1.45
17:35    1      2      2      1     6    0.92
17:40    3      1      4      3    11    2.10  ★
...

合計が 8 以上の slot に ★、12 以上に ★★ を表示
```

### 構成

- `forecast.html`: シンプル HTML、`<script type="module" src="js/forecast-app.js">`
- `js/forecast-app.js`: `fetch('data/stall-forecast.json')` → render
- `js/forecast-render.js`: テーブル描画 (1 関数のみ)
- CSS は `arrivals.html` 既存スタイル流用

## テスト計画

`tests/forecast-engine.test.mjs` で純関数 `computeBaseline` / `computeForecast` を 8-10 件:

1. computeBaseline: 信頼サブセット 0 行 → 全 slot null
2. computeBaseline: 同じ slot に複数サンプル → 平均が返る
3. computeBaseline: 隣接補間 (slot N=0 で N±1 が >0 → 平均値)
4. computeForecast: baseline 全 0 → 予測全 0
5. computeForecast: trendFactor の計算 (直近 12 tick 実測 / 期待値)
6. computeForecast: recent 不足 (12 行未満) → trendFactor=1.0
7. computeForecast: flightFactor の計算 (slot 内 lobbyExit の合計 / 平均)
8. computeForecast: arrivals null → flightFactor=1.0
9. computeForecast: 出力 JSON スキーマの正しさ
10. computeForecast: clip 範囲 (0.3-3.0) の上下端で正しくクランプされる

既存テスト 310 件はパス維持。

## サンプル不足とその対処

5/15 時点で信頼サブセット ~500 行、288 slot に均すと 1.7 サンプル/slot。MVP の精度限界:
- 各 slot の出庫平均が 1-2 サンプル → 大きいばらつき
- 隣接補間で多少平滑化されるが、ノイズが大きい

**MVP の正当化**:
- 5/31 までに信頼サブセットが 4 倍 (~2000 行) になれば 7 サンプル/slot → 統計的に意味あるレベル
- trendFactor + flightFactor で直近の傾向は補正可能
- 「動く仕組み」を 5/15 から運用することで、5/31 後すぐ Phase C-2 (パターンマッチング) へ移行できる

## 完了条件

- [ ] `npm test` 全件パス (現 310 + 新 8-10 件)
- [ ] `scripts/lib/forecast-engine.mjs` 純関数として実装、副作用なし
- [ ] observe-tick で `data/stall-forecast.json` が 5 分毎に更新される
- [ ] `forecast.html` が GitHub Pages で表示できる
- [ ] 観測 jsonl 追記との衝突なし (git push が継続稼働)
- [ ] サンプル不足を UI 上で明示 (「baseline サンプル 503 行、精度は限定的」)

## Phase C-2 への引き継ぎ

5/31 観測終了後、Phase C-2 で:
- DOW 別 baseline (平日/土日)
- 天候別 baseline (雨天/晴天)
- パターンマッチング: 類似日抽出 + ヒストリカルカーブ重ね表示
- terminal フィールド動的変動を反映した stall 分配 (snapshot から実測)
- A/B 出庫の自動分離

この MVP の forecast-engine 純関数は、入力を増やす形で拡張可能な設計にしておく。
