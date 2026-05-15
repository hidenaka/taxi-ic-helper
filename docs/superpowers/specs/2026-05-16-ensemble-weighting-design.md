# アンサンブル重み自動調整 設計 (Phase D-2)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / forecast と pattern-match の統合予測
- 親 spec: `2026-05-16-forecast-accuracy-tracking-design.md` (Phase D-1、実装済み)
- 関連: `2026-05-15-stall-forecast-mvp-design.md` (C-1), `2026-05-15-pattern-matching-mvp-design.md` (C-2)

## 背景

Phase D-1 で `forecast-accuracy.json` に lead time 別の予測精度 (forecast / pattern-match それぞれの MAE と winner) を継続記録する基盤ができた。

ユーザー要望 (2026-05-16):
> 6/1 以降に予想と動きの整合性を学んで行き成長していく仕組み

D-1 は「記録 + 可視化」。D-2 はその誤差データを使って **2 系統を統合した予測** を作る = 「成長」の本体。誤差が小さい方式に重みが寄っていく。

## ゴール

1. `forecast-accuracy.json` の MAE から lead time 別のアンサンブル重みを自動計算
2. forecast (ルールベース) と pattern-match (類似日) を重み付き平均した統合予測を生成
3. `forecast.html` の最上部に「統合予測」セクションを追加 (メイン予測として)
4. 重みの内訳 (lead time 別 fc%/pm%) を可視化

## 非ゴール

- transit-share / flightFactor 等の係数オンライン補正 (Phase D-3)
- stall 別の独立重み (今回は lead time 別、全 stall 共通)
- 重みの履歴記録・推移グラフ
- 予測方式そのものの追加・変更

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| `forecast-engine.mjs` / `pattern-matcher.mjs` | 不変、2 系統の予測ロジックはそのまま |
| `accuracy-evaluator.mjs` | 不変、D-1 の誤差評価をそのまま使う |
| `data/stall-forecast.json` / `stall-pattern-match.json` / `forecast-accuracy.json` | 不変 |
| 観測パイプライン本体 | 不変、末尾に呼び出し追加のみ |

### 新規・変更ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/ensemble-engine.mjs` | Create | 純関数 `computeWeights(accuracy)` + `computeEnsemble(forecast, patternMatch, accuracy, now)` |
| `data/stall-ensemble.json` | Create (生成物) | 統合予測。git 管理 (Web UI が読む) |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾で computeEnsemble 呼び出し |
| `scripts/observe-tick-local.sh` | Modify | git add / checkout 対象に stall-ensemble.json 追加 |
| `forecast.html` | Modify | 最上部に「統合予測」セクション |
| `js/forecast-render.js` | Modify | `renderEnsemble` 追加 |
| `js/forecast-app.js` | Modify | `stall-ensemble.json` も fetch、最初に描画 |
| `tests/ensemble-engine.test.mjs` | Create | 単体テスト 8 件 |

## 重み計算 (`computeWeights`)

`forecast-accuracy.json` の `recent24h` を使う (直近 24 時間の精度で重みを決める = 適応的)。

定数:
- `MIN_SAMPLE = 20` — lead バケットの n がこれ未満ならフォールバック
- `LAPLACE = 0.5` — MAE 逆数のゼロ除算回避用平滑化

各 lead バケット (`lead30` / `lead60` / `lead120`) について:

```
mae_fc = recent24h.forecast[bucket].mae_total
mae_pm = recent24h.patternMatch[bucket].mae_total
n_fc   = recent24h.forecast[bucket].n
n_pm   = recent24h.patternMatch[bucket].n

if mae_fc == null OR mae_pm == null OR min(n_fc, n_pm) < MIN_SAMPLE:
    w_fc = 0.5, w_pm = 0.5, source = "fallback"
else:
    inv_fc = 1 / (mae_fc + LAPLACE)
    inv_pm = 1 / (mae_pm + LAPLACE)
    w_fc = inv_fc / (inv_fc + inv_pm)
    w_pm = inv_pm / (inv_fc + inv_pm)
    source = "mae"
```

戻り値: `{ lead30: {w_fc, w_pm, source}, lead60: {...}, lead120: {...} }`

`accuracy` が null / `recent24h` 欠落のときは全 lead を fallback (50:50) にする。

## アンサンブル予測 (`computeEnsemble`)

### lead time → バケット対応

forecast の slot は現在 +5min 起点で 24 slot。slot index `i` (0-23) の lead time = `(i+1)×5` 分。

バケット境界 (中心 30/60/120 の中点で区切り):

```
lead ≤ 45 分     → lead30
46〜105 分       → lead60
106 分以上       → lead120
```

### 重み付き平均

forecast の各 slot について、pattern-match の同 slotStart の slot を対応付ける:

```
for each forecast slot:
    bucket = leadBucketOf(slot の lead time)
    { w_fc, w_pm } = weights[bucket]
    pmSlot = patternMatch の slotStart 一致 slot (無ければ null)
    if pmSlot == null:
        # pattern-match 側にデータなし → forecast 100%
        ensemble_stallK = forecast.stallK
    else:
        ensemble_stallK = round(forecast.stallK × w_fc + pmSlot.stallK × w_pm)
    ensemble_total = Σ ensemble_stallK
```

forecast が空 (slots なし) の場合は ensemble も空配列。

## stall-ensemble.json 仕様

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-01T17:00:00+09:00",
  "weights": {
    "lead30":  { "w_fc": 0.62, "w_pm": 0.38, "source": "mae" },
    "lead60":  { "w_fc": 0.45, "w_pm": 0.55, "source": "mae" },
    "lead120": { "w_fc": 0.50, "w_pm": 0.50, "source": "fallback" }
  },
  "slots": [
    {
      "slotStart": "17:05",
      "stall1": 1, "stall2": 0, "stall3": 2, "stall4": 1,
      "total": 4,
      "leadBucket": "lead30"
    }
  ]
}
```

`slots` は 24 要素。weights は常に 3 バケット分。

## データフロー

```
[5 min observe-tick]
  └→ scripts/observe-taxi-pool.mjs
       1〜4. (既存 C-1/C-2/D-1) 観測 → forecast / pattern-match / accuracy
       5. (新 D-2) computeWeights(accuracy) + computeEnsemble(forecast, patternMatch, accuracy, now)
              → data/stall-ensemble.json 書き出し
            ↓
[GitHub Pages]
  └→ forecast.html: stall-ensemble.json を最上部に描画
```

forecast / pattern-match / accuracy は既に observe-tick で生成済み。computeEnsemble は
それらの結果オブジェクト (forecastResult / patternMatchResult) と、生成した accuracy を入力にする。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| accuracy が null / recent24h 欠落 | 全 lead 50:50 fallback |
| forecast が空 (予測なし) | ensemble も空配列、slots: [] |
| pattern-match が空 (類似日なし) | 各 slot で forecast 100% |
| MAE=0 | ラプラス平滑化 (+0.5) でゼロ除算回避 |
| lead バケットの n < MIN_SAMPLE | そのバケットだけ 50:50 fallback |
| computeEnsemble 例外 | try/catch、observe-tick 本体は継続、stall-ensemble.json は前回値のまま |

## フロント表示 (forecast.html 最上部)

既存の `#forecast-meta` の前に新セクションを挿入:

```html
<section class="ensemble-section" id="ensemble-section">
  <h2>統合予測 (今後 2 時間)</h2>
  <div id="ensemble-meta" class="ensemble-meta"></div>
  <div id="ensemble-table-wrap"></div>
</section>
```

### テーブルイメージ

```
統合予測 (今後 2 時間)
重み: 30分先 fc62%/pm38% / 60分先 fc45%/pm55% / 120分先 50:50(様子見)

時刻   stall1 stall2 stall3 stall4 合計
17:05    1      0      2      1     4 ★
17:10    0      1      1      0     2
...
```

- 合計 8 以上で ★、12 以上で ★★ (既存 forecast テーブルと同じ tier 閾値)
- `source=fallback` の lead は重み表示に「(様子見)」を付けてサンプル不足を明示
- 既存の forecast / pattern-match / accuracy セクションはそのまま下に残る (内訳)

## テスト計画

`tests/ensemble-engine.test.mjs` (8 件):

1. computeWeights: accuracy=null → 全 lead 50:50 fallback
2. computeWeights: mae が片方 null → そのバケット fallback
3. computeWeights: n < MIN_SAMPLE → fallback
4. computeWeights: 正常な MAE → 逆数加重 (MAE 小さい方の重みが大)
5. computeWeights: MAE=0 → ラプラス平滑化でゼロ除算しない
6. computeEnsemble: forecast 空 → slots 空配列
7. computeEnsemble: pattern-match 空 → 各 slot forecast 100%
8. computeEnsemble: 正常入力 → 重み付き平均 + leadBucket 付与 + 出力スキーマ

既存テスト (現在 363 件) はパス維持。新規 8 件で 371 件目標。

## 完了条件

- [ ] `npm test` 全件パス (現 363 + 新 8 = 371)
- [ ] `scripts/lib/ensemble-engine.mjs` 純関数として実装、副作用なし
- [ ] observe-tick で `data/stall-ensemble.json` が 5 分毎に更新される
- [ ] `forecast.html` 最上部に「統合予測」セクションが表示される
- [ ] `observe-tick-local.sh` の git add / checkout 対象に stall-ensemble.json 追加
- [ ] スコープ外ファイル (forecast-engine.mjs / pattern-matcher.mjs / accuracy-evaluator.mjs / transit-share.json) は触っていない
- [ ] 観測 jsonl 追記との衝突なし

## Phase D-3 への引き継ぎ

D-2 の重みは「2 系統のどちらを信じるか」。D-3 では各系統の内部係数 (transit-share / flightFactor / pattern-matcher の窓・閾値) を誤差からオンライン補正する。

ensemble-engine の `computeWeights` 純関数は、入力の accuracy に係数別の誤差内訳が増えれば D-3 の係数調整にも転用できる設計。

## 観測 tick の commit に関する注意

`data/stall-ensemble.json` は git 管理 = observe-tick の commit に含める。
`scripts/observe-tick-local.sh` の git add 対象と、pull 前 `git checkout HEAD` 対象 (2 箇所) の
両方に `data/stall-ensemble.json` を追加する。2026-05-15 の衝突対策と同じ扱い。
