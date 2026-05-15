# 予測精度トラッキング基盤 設計 (Phase D-1)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / 予測精度の継続記録・可視化
- 親 PM チケット: `.company/pm/tickets/2026-05-15-short-term-demand-forecast-by-stall.md` (Phase C-1/C-2 の発展)
- 関連 spec: `2026-05-15-stall-forecast-mvp-design.md` (C-1), `2026-05-15-pattern-matching-mvp-design.md` (C-2)

## 背景

Phase C-1 (短期需要予測) と C-2 (パターンマッチング) で 2 系統の予測を `forecast.html` に出している。だが「その予測がどれくらい当たっているか」は記録されていない。`forecast.json` は毎 tick 上書きされ、過去の予測が消える。

ユーザー要望 (2026-05-16):
> 6/1 以降に予想と動きの整合性を学んで行き成長していく仕組みを作りたい

これを 3 段階に分解する:

| 段階 | 内容 |
|---|---|
| **Phase D-1 (本 spec)** | 予測ログ記録 + 誤差トラッキング + 精度ダッシュボード。モデルは自動更新しない |
| Phase D-2 | forecast ↔ pattern-match のアンサンブル重みを誤差から自動調整 |
| Phase D-3 | transit-share / flightFactor 等の係数をオンライン補正 |

本 spec は **Phase D-1 のみ**。D-2/D-3 は本基盤の上に乗せる。

## ゴール

1. 各 tick の予測 (forecast / pattern-match) をスナップショットとして時系列保存
2. 時間が経って実測が出たら、過去予測と突き合わせて lead time 別 MAE を計算
3. `forecast.html` に「予測精度」セクションを追加して可視化
4. lead time 別に「forecast と pattern-match のどちらが当たっているか」(winner) を出す — Phase D-2 のアンサンブル重みの種

## 非ゴール

- アンサンブル重みの自動調整 (Phase D-2)
- 係数のオンライン補正 (Phase D-3)
- 予測方式の動的切り替え
- RMSE 等の追加メトリック (MVP は MAE のみ)
- ROI v4 (夜間行燈方式) との統合

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| `forecast-engine.mjs` / `pattern-matcher.mjs` | 不変、予測ロジックはそのまま |
| `data/stall-forecast.json` / `data/stall-pattern-match.json` | 不変、別予測として残る |
| 観測パイプライン本体 | 不変、末尾に呼び出し追加のみ |

### 新規・変更ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/forecast-logger.mjs` | Create | 純関数 `buildLogEntry(forecast, patternMatch, tickSeq)` |
| `scripts/lib/accuracy-evaluator.mjs` | Create | 純関数 `evaluateAccuracy(logEntries, actualByDateSlot, now)` |
| `data/forecast-log.jsonl` | Create (生成物) | 予測ログ。Mac mini ローカルのみ (.gitignore) |
| `data/forecast-accuracy.json` | Create (生成物) | 集計済み精度。git 管理 (Web UI が読む) |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾で log 追記 + accuracy 評価 |
| `.gitignore` | Modify | `data/forecast-log.jsonl` を追加 |
| `forecast.html` | Modify | 「予測精度」セクション追加 |
| `js/forecast-app.js` | Modify | `forecast-accuracy.json` も fetch |
| `js/forecast-render.js` | Modify | `renderAccuracy` 追加 |
| `tests/forecast-logger.test.mjs` | Create | 単体テスト 4 件 |
| `tests/accuracy-evaluator.test.mjs` | Create | 単体テスト 8 件 |

## forecast-log.jsonl 仕様

1 tick = 1 行。observe-tick が forecast / pattern-match を生成した直後に追記。

```json
{
  "ts": "2026-06-01T17:00:00+09:00",
  "tickSeq": 1234,
  "forecast": [
    { "slotStart": "17:05", "stall1": 1, "stall2": 0, "stall3": 2, "stall4": 1, "total": 4 }
  ],
  "patternMatch": [
    { "slotStart": "17:05", "stall1": 2, "stall2": 0, "stall3": 1, "stall4": 1, "total": 4 }
  ]
}
```

- `forecast` / `patternMatch` は各 24 slot (現在 +5min〜+120min)
- 1 行 ≈ 1-2 KB、5 分毎 → 1 日 ~0.5 MB、6/1〜月末で ~15 MB
- Mac mini ローカルのみ。消えても `forecast-accuracy.json` に集計済みなので許容
- `slotStart` は "HH:MM"。日付跨ぎ照合は ts の日付 + slotStart で復元

`forecast` が空配列のときは記録しない (予測が出ていない tick)。

## accuracy-evaluator のロジック

### 入力

- `logEntries`: forecast-log.jsonl の全行
- `actualByDateSlot`: 実測。`Map<"YYYY-MM-DD#slotIdx", [stall1Out, stall2Out, stall3Out, stall4Out]>`
  - jsonl の信頼サブセット (schema=3 ∧ luminance>=30 ∧ stalls 非 null) から構築
  - 各 slot の `diff_occupied_from_prev` 負値合計
- `now`: 現在時刻

### 誤差計算

各 logEntry について、その予測 slot の実測値を引く:

```
logEntry.ts の日付 = D、tickSeq から発行時刻
各 slot (slotStart="HH:MM") について:
  slotIdx = HH*12 + MM//5
  実測キー = "D#slotIdx" (slot が翌日に跨ぐ場合は D+1)
  実測 = actualByDateSlot.get(実測キー)  // 無ければ評価スキップ (信頼サブセット外)
  予測 = logEntry.forecast[i] / logEntry.patternMatch[i]

  leadMinutes = (予測 slot 時刻) - (logEntry.ts)   // 5,10,...,120
  lead バケット: 30 (=25-35min), 60 (=55-65min), 120 (=115-125min)

  absError_total = |予測.total - 実測合計|
  absError_stall[k] = |予測.stallK - 実測[k]|
```

### lead time バケット

| バケット | leadMinutes 範囲 |
|---|---|
| `lead30` | 25-35 分 |
| `lead60` | 55-65 分 |
| `lead120` | 115-125 分 |

各バケットで MAE = 全 (logEntry × 該当 slot) の absError 平均。

### 評価期間

2 種類を併算:
- `recent24h`: now から 24 時間以内に発行された予測のみ
- `allPeriod`: 全期間

### winner 判定

各 lead バケットで `forecast.mae_total` と `patternMatch.mae_total` を比較、小さい方を `winner` に。両方 n=0 なら `"n/a"`。

## forecast-accuracy.json 仕様

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-01T19:00:00+09:00",
  "logEntryCount": 288,
  "recent24h": {
    "forecast": {
      "lead30":  { "mae_total": 1.8, "mae_per_stall": [0.5,0.4,0.6,0.3], "n": 280 },
      "lead60":  { "mae_total": 2.3, "mae_per_stall": [0.6,0.5,0.8,0.4], "n": 270 },
      "lead120": { "mae_total": 3.1, "mae_per_stall": [0.8,0.7,1.0,0.6], "n": 250 }
    },
    "patternMatch": { "lead30": {...}, "lead60": {...}, "lead120": {...} },
    "winner": { "lead30": "forecast", "lead60": "patternMatch", "lead120": "forecast" }
  },
  "allPeriod": { "forecast": {...}, "patternMatch": {...}, "winner": {...} }
}
```

`n=0` のバケットは `mae_total: null, n: 0`。

## データフロー

```
[5 min observe-tick]
  └→ scripts/observe-taxi-pool.mjs
       1〜3. (既存) 観測 → jsonl / stall-forecast.json / stall-pattern-match.json
       4. (新) buildLogEntry(forecast, patternMatch, tickSeq)
              → data/forecast-log.jsonl に 1 行 append
       5. (新) forecast-log.jsonl 全行 + jsonl 信頼サブセット読込
              → evaluateAccuracy → data/forecast-accuracy.json 書き出し
            ↓
[GitHub Pages]
  └→ forecast.html: forecast-accuracy.json を fetch → 精度セクション描画
```

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| forecast-log.jsonl が存在しない (初回) | 空配列で開始、accuracy.json は n=0 で出力 |
| forecast が空 (予測なし tick) | log に記録しない |
| 実測が信頼サブセット外 (夜間等) | その slot は誤差評価からスキップ |
| logEntry の予測 slot がまだ未来 (実測なし) | スキップ (次回以降の tick で評価される) |
| buildLogEntry / evaluateAccuracy 例外 | try/catch、observe-tick 本体は継続 |
| forecast-log.jsonl 肥大化 (月 ~15MB) | MVP では許容。Phase D-2 で古いログの間引きを検討 |

## フロント表示 (forecast.html 追加部分)

既存セクションの下に追加:

```html
<section class="accuracy-section" id="accuracy-section">
  <h2>予測精度 (直近 24 時間)</h2>
  <div id="accuracy-meta"></div>
  <div id="accuracy-table-wrap"></div>
</section>
```

### テーブルイメージ

```
予測精度 (直近 24 時間 / ログ 288 件)

lead time   forecast MAE   pattern MAE   優勢
30 分先        1.8 台         2.1 台      forecast
60 分先        2.3 台         2.0 台      pattern
120 分先       3.1 台         2.8 台      pattern
```

MAE 単位は「台 (5 分 slot あたりの絶対誤差)」。優勢列に MAE 小さい方式名。

## テスト計画

### `tests/forecast-logger.test.mjs` (4 件)

1. buildLogEntry: forecast / patternMatch が空配列 → null を返す (記録しない)
2. buildLogEntry: 正常な forecast/patternMatch → ts/tickSeq/forecast/patternMatch を持つ行
3. buildLogEntry: slot から必要フィールド (slotStart, stall1-4, total) のみ抽出
4. buildLogEntry: forecast のみあり patternMatch 空 → patternMatch は空配列で記録

### `tests/accuracy-evaluator.test.mjs` (8 件)

1. logEntries 0 件 → 全バケット n=0
2. 予測 = 実測 → MAE = 0
3. 予測ズレ → MAE が絶対誤差の平均
4. lead time バケット振り分け (30/60/120 分の境界)
5. 実測が無い slot → スキップ (n に数えない)
6. recent24h と allPeriod の切り分け
7. winner 判定 (forecast の方が MAE 小 → "forecast")
8. winner: 両方 n=0 → "n/a"

既存テスト (現在 351 件) はパス維持。新規 12 件で 363 件目標。

## 完了条件

- [ ] `npm test` 全件パス (現 351 + 新 12 = 363)
- [ ] `scripts/lib/forecast-logger.mjs` / `accuracy-evaluator.mjs` 純関数として実装
- [ ] observe-tick で `data/forecast-log.jsonl` 追記 + `data/forecast-accuracy.json` 更新
- [ ] `data/forecast-log.jsonl` が `.gitignore` 済み
- [ ] `forecast.html` に予測精度セクションが表示される
- [ ] 観測 jsonl 追記との衝突なし (生成物は observe-tick の commit に含める)
- [ ] スコープ外ファイル (forecast-engine.mjs / pattern-matcher.mjs / transit-share.json) は触っていない

## Phase D-2 への引き継ぎ

本基盤が `forecast-accuracy.json` の `winner` を出すので、Phase D-2 では:
- lead time 別に winner 方式を重み付き採用 (例: lead30 は forecast、lead60+ は pattern-match)
- または MAE の逆数で連続重み付け
- forecast.html に「アンサンブル予測」行を追加

accuracy-evaluator の純関数は入力を増やす形で D-2 の重み計算に再利用できる設計にしておく。

## 観測 tick の commit に関する注意

`data/forecast-accuracy.json` は git 管理 = observe-tick の commit に含める必要がある。
`scripts/observe-tick-local.sh` の `git add` 対象に追加する:

```
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json
```

`data/forecast-log.jsonl` は `.gitignore` 済みなので add されない。
2026-05-15 の衝突対策 (pull 前に generated files を HEAD に戻す) と同じ扱いで、
forecast-accuracy.json も「pull 前に checkout HEAD で戻す」対象に加える。
