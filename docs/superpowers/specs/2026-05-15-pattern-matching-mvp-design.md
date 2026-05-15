# パターンマッチング予測 MVP 設計 (Phase C-2)

- 日付: 2026-05-15
- 対象: 乗務地図関係 / パターンマッチング需要予測 (Phase C-2)
- 親 PM チケット: `.company/pm/tickets/2026-05-15-pattern-matching-demand-prediction.md`
- 関連 spec: `docs/superpowers/specs/2026-05-15-stall-forecast-mvp-design.md` (Phase C-1、既実装)

## 背景

Phase C-1 (短期需要予測 MVP) は `baseline × trendFactor × flightFactor` のルールベース予測を `forecast.html` に提供している。

ユーザー要望:
> 今回の画像データを撮っている傾向から、曜日と時間とフライト情報あと天候情報とかも加味して将来的に、この車の動きとこのフライト情報とこの天気だったら、今後 1-2 時間はどのようにタクシー客がいるかを乗り場ごとに見せるような形にしてほしい

C-1 はこれの「曜日」「フライト情報」を一部反映済み (flightFactor)。C-2 では「**過去日との類似度マッチング**」を加えて、ヒストリカル予測カーブを併記する。

ユーザー追加要件 (2026-05-15):
> 過去N日に関しては曜日や連休情報とか何月か も考慮しての仕組みにしておいてほしい

つまり類似日を選ぶ時にカレンダー情報 (DOW / 連休 / 月) でプレフィルタする。

## ゴール

1. 過去 jsonl から「今日と似ている過去日」を上位 5 件抽出
2. 類似日の同じ未来時間帯 (現在 +5min〜+120min) の出庫を平均してヒストリカル予測カーブを生成
3. `forecast.html` に「類似日カード + ヒストリカル予測テーブル」セクションを追加
4. observe-tick で 5 分毎に再計算し `data/stall-pattern-match.json` を更新

## 非ゴール

- 自動精度評価 (cross-validation、leave-one-out)
- DTW (Dynamic Time Warping) — cosine 類似度で十分か C-2 で見て、必要なら C-3
- 天候を独立した特徴として扱う (DOW/連休/月で十分な切り分けかをまず見る)
- ROI v4 (行燈方式) との統合 — 夜間データは引き続きスコープ外
- 個別便単位の対応分析 — Phase B 本分析へ

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| Phase C-1 (`forecast-engine.mjs`) | 不変、ルールベース予測は併存 |
| `data/stall-forecast.json` | 不変、別予測として残る |
| 観測パイプライン (`observe-taxi-pool.mjs` の本体ロジック) | 不変、末尾に呼び出し追加のみ |

### 新規・変更ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `data/japan-holidays.json` | Create | 2025-2027 年程度の祝日リスト (年 1 回手動更新) |
| `scripts/lib/calendar-context.mjs` | Create | 純関数 `getDayType(date, holidaysSet)` → 6 カテゴリ + `loadHolidaysSet` |
| `scripts/lib/pattern-matcher.mjs` | Create | 純関数 `computePatternMatch(historyAll, holidays, now)` |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾で `computePatternMatch` 呼び出し |
| `data/stall-pattern-match.json` | Create (生成物) | 類似日 + ヒストリカルカーブ |
| `forecast.html` | Modify | セクション追加 |
| `js/forecast-app.js` | Modify | `pattern-match.json` も fetch |
| `js/forecast-render.js` | Modify | `renderSimilarDays` + `renderHistoricalCurve` 追加 |
| `tests/calendar-context.test.mjs` | Create | dayType 判定テスト 6 件 |
| `tests/pattern-matcher.test.mjs` | Create | パターンマッチングテスト 9 件 |

## カレンダー判定 (6 カテゴリ)

`dayType` は以下のいずれか:

| カテゴリ | 条件 |
|---|---|
| `weekday` | 平日 (月-金) かつ翌日も平日 |
| `saturday` | 土曜日かつ翌日が平日 (= 三連休でない土曜) |
| `sunday_holiday` | 日曜 or 祝日かつ前日が平日 (= 単独の祝日/日曜) |
| `pre_holiday` | 平日 (月-金) で翌日が日曜/祝日 (連休初日) |
| `in_consec_holiday` | 休日 (土日祝) で前日・翌日ともに休日 (連休の中日) |
| `last_consec_holiday` | 休日で前日が休日、翌日が平日 (連休最終日) |

### 祝日リスト (`data/japan-holidays.json`)

```json
{
  "_meta": {
    "source": "内閣府 国民の祝日に関する法律 (https://www.cao.go.jp/chosei/shukujitsu/gaiyou.html)",
    "updated": "2026-05-15",
    "note": "国民の祝日と振替休日を含む。年 1 回 (12 月) に翌年分を追加更新。"
  },
  "holidays": [
    { "date": "2026-01-01", "name": "元日" },
    { "date": "2026-01-12", "name": "成人の日" },
    /* ... 全祝日 ... */
    { "date": "2027-01-01", "name": "元日" }
  ]
}
```

`loadHolidaysSet` で `Set<string>` ("YYYY-MM-DD" 集合) を返す。

## 段階プレフィルタ

```
target = getDayType(today, holidays), targetMonth = today.month
pastDays = (信頼サブセットを日単位に集約した array)

// strict: 同 dayType + 同月
strictCandidates = pastDays.filter(d => d.dayType === target && d.month === targetMonth)
if (strictCandidates.length >= 3) { filterTier = "strict"; candidates = strictCandidates }

else {
  // medium: 同 dayType + 月±2
  mediumCandidates = pastDays.filter(d => d.dayType === target && abs(d.month - targetMonth) <= 2)
  if (mediumCandidates.length >= 3) { filterTier = "medium"; candidates = mediumCandidates }

  else {
    // loose: 平日/土日カテゴリのみマッチ
    const targetIsWeekday = ["weekday", "pre_holiday"].includes(target)
    looseCandidates = pastDays.filter(d => {
      const dIsWeekday = ["weekday", "pre_holiday"].includes(d.dayType)
      return dIsWeekday === targetIsWeekday
    })
    if (looseCandidates.length >= 3) { filterTier = "loose"; candidates = looseCandidates }
    else { filterTier = "all"; candidates = pastDays }
  }
}
```

最低 3 件確保が目的。3 件未満なら最後の段階で全日採用。

## 類似度計算 (cosine、5 分粒度)

### 比較ウィンドウ

「過去 6 時間 × 5 分粒度 × 4 stall」のベクトル。

```
windowSlots = 72   // 6h × 12 slot/h
todayWindowEnd = now (現在時刻)
todayWindowStart = now - 6 hours

todayVec = [
  outflow_per_tick(now -6h, stall1), outflow_per_tick(now -6h, stall2), ..., outflow_per_tick(now -6h, stall4),
  outflow_per_tick(now -5h55, stall1), ..., outflow_per_tick(now -5h55, stall4),
  ...
  outflow_per_tick(now -5min, stall1), ..., outflow_per_tick(now -5min, stall4),
]
// 長さ 72 × 4 = 288
```

各候補日の同窓 (= その日の同じ時刻範囲) も同じ形で抽出。

### cosine 類似度

```javascript
function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

ゼロベクトル (全 stall 完全ゼロ) は 0 返し。

### 上位 5 日抽出

cosine 高い順にソート、上位 5 日を `similarDays` に格納。

## ヒストリカル予測カーブ

```
forecastSlots = 24   // 2h × 12 slot/h
forecastStart = now + 5min
forecastEnd = now + 120min

for each similarDay:
  similarDayCurve = 同窓 (similarDay の同時刻範囲、24 slot × 4 stall)

historicalCurve = mean over similarDays of similarDayCurve
                 // 各 slot × 各 stall の平均
```

出力は `slotStart`, `slotEnd`, `stall1-4`, `total` (合計、四捨五入後の和)。

## 出力 JSON 仕様 (`data/stall-pattern-match.json`)

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-15T17:30:00+09:00",
  "today": {
    "date": "2026-05-15",
    "dayType": "weekday",
    "month": 5,
    "filterTier": "strict"
  },
  "candidateCount": 5,
  "similarDays": [
    { "date": "2026-05-13", "dayType": "weekday", "month": 5, "similarity": 0.872, "label": "5/13 (火・weekday)" },
    { "date": "2026-05-14", "dayType": "weekday", "month": 5, "similarity": 0.821, "label": "5/14 (水・weekday)" }
  ],
  "historicalCurve": [
    { "slotStart": "17:30", "slotEnd": "17:35", "stall1": 1, "stall2": 1, "stall3": 2, "stall4": 1, "total": 5 }
  ]
}
```

## データフロー

```
[5 min observe-tick]
  └→ scripts/observe-taxi-pool.mjs
       1. (既存) 画像 → stall 解析 → jsonl 追記
       2. (既存) computeForecast → stall-forecast.json
       3. (新) loadHolidaysSet → computePatternMatch → stall-pattern-match.json
            ↓
[GitHub Pages]
  └→ forecast.html
      ├ fetch stall-forecast.json → renderForecastTable
      └ fetch stall-pattern-match.json → renderSimilarDays + renderHistoricalCurve
```

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| japan-holidays.json 読み込み失敗 | 空 Set で続行、dayType は日曜判定のみ機能 |
| pastDays 日数 0 (jsonl 全て今日) | similarDays=[], historicalCurve=[], filterTier="all" |
| 過去 6h ウィンドウが今日の jsonl に存在しない (朝早い時間帯) | 取れる範囲で短く類似度を取る (最小 1 hour、12 次元 × 4) |
| 候補日ベクトルが完全ゼロ | similarity=0 でランキングから自然に外れる |
| computePatternMatch 例外 | try/catch、observe-tick 本体は継続、前回値のまま |

## フロント表示 (forecast.html 追加部分)

既存のメタ情報 + 短期予測テーブルの下に追加:

```html
<section id="pattern-match-section">
  <h2>類似日マッチング</h2>
  <div id="pattern-meta"></div>      <!-- 今日 + filterTier + 候補数 -->
  <div id="similar-days"></div>      <!-- 類似日カード上位 5 -->
  <h3>ヒストリカル予測 (類似日平均)</h3>
  <div id="historical-curve"></div>  <!-- 24 slot テーブル -->
</section>
```

### 類似度アイコン

| similarity | アイコン | 意味 |
|---|---|---|
| ≥ 0.7 | 🟢 | 高類似 |
| 0.4-0.7 | 🟡 | 中類似 |
| < 0.4 | ⚪ | 低類似 (参考程度) |

## テスト計画

### `tests/calendar-context.test.mjs` (6 件)

1. 平日 (火曜 5/12) → "weekday"
2. 土曜 (5/16) で翌日日曜 → "saturday"
3. 日曜単発 (5/17) で月曜平日 → "sunday_holiday"
4. 平日 4/28 で翌日は祝日 (5/3 GW 想定の前日) → "pre_holiday"
5. 連休中の祝日 → "in_consec_holiday"
6. 連休最終日 (祝日で翌日平日) → "last_consec_holiday"

### `tests/pattern-matcher.test.mjs` (9 件)

1. pastDays 0 件 → similarDays=[], historicalCurve=[]
2. 同じ日 (todayVec === candVec) → similarity=1.0
3. 直交ベクトル → similarity=0
4. 段階フィルタ strict ヒット (3 件以上)
5. 段階フィルタ medium まで緩和
6. 段階フィルタ loose まで緩和
7. 全候補 < 3 件 → filterTier="all"
8. 上位 5 件抽出 (10 候補から正しく 5 件)
9. 出力 JSON スキーマの全フィールド有無

既存テスト 323 件はパス維持。新規 15 件で 338 件目標。

## サンプル不足の caveat (明示)

5/15 時点で過去 5 日 (5/10-5/15)。dayType 別の候補数:
- weekday: 5/11(月), 5/12(火), 5/13(水), 5/14(木) ≈ 4 日
- saturday: 0 件
- sunday_holiday: 5/10(日) ≈ 1 件

5/15 (木・weekday・5 月) → strict 候補 4 件で十分 (≥3)。

5/31 までに 17 日蓄積後:
- weekday: ~12 日
- saturday: ~2 日
- sunday_holiday: ~3 日

5 月限定では Sat/Sun が少ないが、Phase B 本分析で 6 月以降に拡充。MVP として「動く仕組み」を作る。

## 完了条件

- [ ] `npm test` 全件パス (現 323 + 新 15 = 338)
- [ ] `data/japan-holidays.json` が valid JSON で 2 年分以上の祝日を含む
- [ ] `scripts/lib/calendar-context.mjs` と `scripts/lib/pattern-matcher.mjs` が純関数として実装、副作用なし
- [ ] observe-tick で `data/stall-pattern-match.json` が 5 分毎に更新される
- [ ] `forecast.html` で類似日カードとヒストリカル予測テーブルが表示される
- [ ] スコープ外ファイル (transit-share.json / arrivals.json / fetch-arrivals.mjs / forecast-engine.mjs) は触っていない
- [ ] 観測 jsonl 追記との衝突なし

## Phase C-3 への引き継ぎ

5/31 観測終了後 + 全年データ蓄積で:
- DTW (位相ズレに強い時系列距離) を試す
- 天候別 (晴天/雨天) のセカンダリフィルタ追加
- 「ピーク時刻一致度」を別特徴として加点
- 出力カーブの不確実性 (± 標準偏差) を併表示
- ROI v4 (行燈方式) で夜間データを含めた 24h パターン化

このスペックの純関数は入力を増やす形で拡張可能な設計にしておく。
