# タクシープール観測 — スキーマ v2 設計

- 日付: 2026-05-11
- 対象: 乗務地図関係 / `scripts/observe-taxi-pool.mjs` 周辺
- フェーズ: Phase A (観測) のスキーマ拡張、Phase B の手前
- 親プロジェクト: `docs/superpowers/specs/2026-05-10-taxi-pool-observation-design.md` の延長

## 背景

Phase A 観測を 48 時間 (118 tick) 動かした時点で、現スキーマには 2 つの問題が判明:

1. **`img.black_ratio` が「夜の暗さ」に支配されている**。時間帯別集計で 0-3 時 ≈ 0.95、5-17 時 ≈ 0.05、19-23 時 ≈ 0.90 と、車両の在不在ではなく画像全体の照度に追従している。
2. **`arrivals_state.total_estimated_taxi_pax` がほぼ定数 (14,600〜14,900)** で時間帯依存性が消えている。これは 24h 合計の予測値を保存していたため。

両方を解決しないと Phase B (予測 vs 実プール乖離) の相関分析が成立しない。

## ゴール

- 「車両が床面にぎっしり並んでいる / ガラガラ」を時間帯と独立に検出できる解析指標 (`edge_density`) を加える
- 「現在 -30 分 〜 +60 分」の便の予測タクシー候補数を時間帯依存の値として保存する
- 既存 118 行の旧スキーマデータは保持する (schema_version 未記載のまま放置、新フィールドは null 扱い)
- 新規 tick から schema_version=2 で記録し、Phase B 分析時に統合可能にする

## 非ゴール

- ROI の自動学習 (背景差分・カメラキャリブレーション)
- 物体検出 ML モデル (YOLO 等) の導入
- Sobel 以外の高度なエッジ検出 (Canny の 2 段階処理は Phase A の見切り後に必要なら別 spec)
- 旧 118 行を再解析して新スキーマに揃える (画像本体が手元になく不可)
- 雨天時の照度・反射補正
- フロント側 (arrivals.html) への新フィールド表示

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| launchd ジョブ (`scripts/observe-tick-local.sh` / `scripts/install-observe-launchd.sh`) | 不変 |
| 既存 jsonl 118 行 | 不変 (schema_version 未記載 = v1 扱い) |
| `arrivals.html` / フロント | 不変 |
| `data/arrivals.json` の生成 (`fetch-arrivals.mjs`) | 不変 |
| `image-pool-analyzer.mjs` の既存 `analyzePoolImage` 戻り値 (sha256 / size_bytes / black_ratio / diff_from_prev) | 不変 (新フィールドが追加されるだけ) |

### 変更・新規ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/image-pool-analyzer.mjs` | Modify | ROI 切り出し + エッジ密度を追加 (返り値に `roi` フィールドを足す) |
| `scripts/lib/roi-config.json` | Create | Real01_line / Real02 の ROI 座標を保持 |
| `scripts/lib/arrivals-window-summary.mjs` | Create | flights[] から「現在 -30 〜 +60 分」を集計する純粋関数 |
| `scripts/observe-taxi-pool.mjs` | Modify | 新解析を呼び、`schema_version: 2` で jsonl 追記 |
| `tests/image-pool-analyzer.test.mjs` | Modify | ROI/エッジ密度のテスト 5 件追加 |
| `tests/arrivals-window-summary.test.mjs` | Create | 時間窓フィルタのテスト 6 件 |
| `docs/research/taxi-pool-observation.md` | Modify | schema_version=2 仕様と Phase A 検証手順を更新 |

## スキーマ v2

### 1 行 jsonl サンプル

```json
{
  "schema_version": 2,
  "ts": "2026-05-11T13:00:00+09:00",
  "tick_seq": 119,
  "img1": {
    "name": "Real01_line",
    "size_bytes": 89647,
    "sha256": "abc1234...",
    "black_ratio": 0.62,
    "diff_from_prev": 0.03,
    "roi": {
      "edge_density": 0.184,
      "roi_black_ratio": 0.412,
      "luminance_mean": 78.4,
      "luminance_std": 41.2,
      "diff_edge_from_prev": 0.012
    }
  },
  "img2": {
    "name": "Real02",
    "size_bytes": 85384,
    "sha256": "def5678...",
    "black_ratio": 0.28,
    "diff_from_prev": 0.01,
    "roi": {
      "edge_density": 0.094,
      "roi_black_ratio": 0.213,
      "luminance_mean": 92.1,
      "luminance_std": 38.7,
      "diff_edge_from_prev": 0.008
    }
  },
  "arrivals_state": {
    "updated_at": "2026-05-11T12:55:30+09:00",
    "total_estimated_taxi_pax": 14981,
    "lag_seconds": 270
  },
  "arrivals_window": {
    "from": "2026-05-11T12:30:00+09:00",
    "to": "2026-05-11T14:00:00+09:00",
    "flight_count": 12,
    "estimated_taxi_pax_sum": 187,
    "estimated_pax_sum": 1820,
    "reach_none_count": 2
  },
  "weather": {
    "code": 1,
    "lightning_active": false
  }
}
```

旧スキーマフィールド (`schema_version` 未記載、`img.black_ratio` / `img.diff_from_prev` / `arrivals_state`) は **そのまま残す**。新フィールド (`schema_version: 2` / `img.roi` / `arrivals_window`) を追加する形。後方互換を維持しつつ Phase B 分析時に統合読み取りができる。

### 各フィールドの意味

- `schema_version: 2`: スキーマ識別子。Phase B 分析で旧/新を分けるためのフラグ
- `img.roi.edge_density`: ROI 内のエッジピクセル比率 (Sobel 勾配 ≥ 50 のピクセル数 / ROI 全ピクセル数)。0.0〜1.0
- `img.roi.roi_black_ratio`: ROI 内の `black_ratio` (画像全体ではなく ROI 限定)
- `img.roi.luminance_mean`: ROI 内のグレースケール輝度平均 (0〜255)
- `img.roi.luminance_std`: ROI 内のグレースケール輝度標準偏差
- `img.roi.diff_edge_from_prev`: 前 tick の `edge_density` との絶対差分 (出庫の動きシグナル)
- `arrivals_window.from` / `to`: 集計窓 (現在 -30 分 〜 +60 分 を ISO 形式の絶対時刻として記録)
- `arrivals_window.flight_count`: 窓内の便数
- `arrivals_window.estimated_taxi_pax_sum`: 窓内の `estimatedTaxiPax` の合計 (null の便は除外)
- `arrivals_window.estimated_pax_sum`: 窓内の `estimatedPax` の合計 (null の便は除外)
- `arrivals_window.reach_none_count`: 窓内で `reachTier === 'none'` の便数

## ROI 仕様

### `scripts/lib/roi-config.json`

```json
{
  "_meta": {
    "source": "ttc.taxi-inf.jp の Real01_line.jpg / Real02.jpg を 2026-05-11 時点で手動切り出し",
    "image_size": [800, 600],
    "note": "カメラアングルが変わった場合は再校正必要。第1待機所は画像中央〜下端に車両が並ぶ。第3-4待機所は中央〜右下"
  },
  "real01_line": {
    "x": 0, "y": 60, "width": 800, "height": 500
  },
  "real02": {
    "x": 200, "y": 80, "width": 600, "height": 460
  }
}
```

座標は実装フェーズで実画像を見て調整する。空・建物・道路標識を除外して、駐車スペース面 + 車体だけ含める形に絞る。

### エッジ密度の計算

```
analyzeROI(jimpImage, roi):
  1. roi (x, y, w, h) を画像範囲にクリップ
  2. crop(x, y, w, h) で ROI を切り出し
  3. greyscale() で輝度マップに
  4. Sobel X カーネル [[-1,0,1],[-2,0,2],[-1,0,1]] を convolute
  5. Sobel Y カーネル [[-1,-2,-1],[0,0,0],[1,2,1]] を convolute
  6. 各ピクセルの勾配大きさ = sqrt(gx^2 + gy^2)
  7. edge_threshold = 50 以上のピクセル数 / total = edge_density
  8. ROI 内の roi_black_ratio (RGB 各値 < 60) を別途計算
  9. ROI 内のグレースケール mean / std を計算
  10. 前 tick の edge_density との絶対差分 = diff_edge_from_prev (prev=null なら null)
```

`analyzePoolImage(buffer, prev, roi)` のシグネチャに `roi` 引数 (3 つ目) を追加する。roi=null を渡せば旧動作 (roi フィールドなし) になる。

## arrivals_window 仕様

### `scripts/lib/arrivals-window-summary.mjs`

```javascript
/**
 * arrivals.json から「now - 30 min 〜 now + 60 min」の便を集計する純粋関数。
 *
 * @param {Object} arrivals - data/arrivals.json の中身
 * @param {Date} now - 現在時刻
 * @returns {{from, to, flight_count, estimated_taxi_pax_sum, estimated_pax_sum, reach_none_count}}
 */
export function summarizeArrivalsWindow(arrivals, now) {
  // 1. from = now - 30 min, to = now + 60 min を Date オブジェクトで計算
  // 2. arrivals.flights[] の各便で:
  //    - timeStr = flight.estimatedTime ?? flight.scheduledTime
  //    - timeStr が "24:30" のような 24+ 表記の場合: 24 = 翌日 0 時として hours = 24, minutes = 30
  //    - flightDate = now の JST 日付 + (hours, minutes)
  //    - hours >= 24 なら flightDate += 1 day && hours -= 24
  //    - from <= flightDate <= to かどうか判定
  // 3. 窓内の便を集計
  //    flight_count = フィルタ後の便数
  //    estimated_taxi_pax_sum = 各 estimatedTaxiPax を合計 (null は除外)
  //    estimated_pax_sum = 各 estimatedPax を合計 (null は除外)
  //    reach_none_count = reachTier === 'none' の件数
  // 4. from/to は ISO 8601 (+09:00) 形式で返す
}
```

純粋関数。`arrivals.flights[]` がない場合は全 0 を返す (null ではなく)。

### 24+ 時刻表記の扱い

ODPT の遅延便で `estimatedTime: "24:30"` のような 24 以上の hours が来る。これは「JST 翌日 00:30」を意味する慣習。`summarizeArrivalsWindow` 内で:

```javascript
if (hours >= 24) {
  flightDate.setDate(flightDate.getDate() + 1);
  hours -= 24;
}
flightDate.setHours(hours, minutes, 0, 0);
```

の形で連続化する。テストで `"24:30"` ケースを明示的に検証。

## データフロー

```
[launchd 15min cron]
  └→ observe-tick-local.sh
       └→ scripts/observe-taxi-pool.mjs
            1. ttc.taxi-inf.jp から 2 画像取得
            2. roi-config.json を読み込み
            3. analyzePoolImage(buf1, prev1, roi.real01_line) で新解析
            4. analyzePoolImage(buf2, prev2, roi.real02)
            5. data/arrivals.json と data/weather.json 読み込み
            6. summarizeArrivalsWindow(arrivals, now) で窓集計
            7. data/taxi-pool-history.jsonl に schema_version=2 で 1 行 append
            8. /tmp に画像保存、git commit & push
```

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| ROI 座標が画像範囲外 | 画像範囲にクリップして警告ログ、解析続行 |
| Sobel 計算で例外 (極端に小さい ROI など) | try/catch で roi フィールドを null、jsonl は schema_version=2 で書く |
| `arrivals.json` の flights[] が空 | arrivals_window 全フィールドが 0 |
| flight.estimatedTime / scheduledTime が両方 null | その便はスキップ |
| `prev` が schema_version=1 (roi フィールドなし) | `prev?.roi?.edge_density` が undefined → `diff_edge_from_prev: null` |
| roi-config.json 読み込み失敗 | console.error、roi=null で解析続行 (画像全体の旧解析のみ実行) |

## テスト計画

### `tests/image-pool-analyzer.test.mjs` への追加 (5 件)

- 全黒 ROI で `edge_density ≈ 0` (一様)
- 市松模様 ROI で `edge_density` 高め (エッジ多い)
- ROI が画像範囲外を指していてもクラッシュせず適切にクリップ
- `roi_black_ratio` が ROI 内だけで計算され、画像全体の `black_ratio` と独立した値
- `prev` 引数経由で `diff_edge_from_prev` が計算される、prev.roi=undefined なら null

### `tests/arrivals-window-summary.test.mjs` (新規 6 件)

- 全便が窓内 → flight_count = 全便数、合計値正確
- 窓外の便はカウントされない
- estimatedTime 優先、なければ scheduledTime
- `"24:30"` などの 24+ 表記が翌日 0:30 として正しく扱える
- estimatedPax / estimatedTaxiPax / reachTier が null の便も合計に正しく寄与しない
- 窓内 0 便 → 全フィールドが 0 (null ではなく)

### 既存テスト

- `npm test` 全件パス継続 (現 294 件、新 5 + 6 = 305 件想定)

### Phase A 検証ステップ (運用検証)

実装プランの最終 Task で、Mac mini に install 後 24 時間動かしてから:

1. `jq '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c` で schema_version=2 が 24 行以上あること
2. 各 tick で `img1.roi.edge_density` が 0.0〜1.0 に収まっていること
3. 深夜帯 (0-3 時) と日中帯 (10-14 時) で `edge_density` の分布が異なること (時間帯非依存にぎっしり/ガラガラを反映していること)
4. `arrivals_window.estimated_taxi_pax_sum` が時間帯ごとに動いている (14,000 で定数化していない)

すべて満たせば Phase B に進む。満たさなければ ROI 座標または edge_threshold を再校正。

## メンテナンス運用

- ROI 座標はカメラアングル変更で陳腐化する可能性あり。90 日履歴でカメラアングル変化点を検出した場合は `roi-config.json` を更新し、`_meta.updated` を書き換える
- edge_threshold (50) は経験値。日中の暗い駐車スペースが「車なし」と判定される、または夜間の照明反射が「車あり」と誤判定される傾向があれば調整候補

## ロールバック

問題発生時の戻し方:

```bash
# 1. observe-taxi-pool.mjs を旧版に戻す
git revert <feat commit hash>

# 2. roi-config.json / arrivals-window-summary.mjs を削除
git rm scripts/lib/roi-config.json scripts/lib/arrivals-window-summary.mjs

# 3. テストも戻す
git revert <test commit hash>
```

jsonl の schema_version=2 行は残るが、Phase B 分析時に `schema_version` フィルタで識別できるので問題なし。

## 完了条件

- [ ] `npm test` 全件パス (305 件以上)
- [ ] Mac mini に新 launchd ジョブが load されている (既存 plist のまま、スクリプトだけ差し替え)
- [ ] 24 時間経過後に jsonl に schema_version=2 が ≈ 96 行 (実稼働率による)
- [ ] `edge_density` が時間帯非依存に車両在不在を反映する分布になっていること
- [ ] `arrivals_window.estimated_taxi_pax_sum` が時間帯ごとに変動していること
- [ ] `docs/research/taxi-pool-observation.md` が schema_version=2 / Phase B 分析手順に更新されていること

## Phase B への引き継ぎ

Phase B 開始時点で:

```python
import pandas as pd
df = pd.read_json('data/taxi-pool-history.jsonl', lines=True)
new = df[df['schema_version'] == 2]  # 新スキーマのみ
# ROI 系の解析: new['img1'].apply(lambda x: x['roi']['edge_density'])
# 窓予測との相関: new['arrivals_window'].apply(lambda x: x['estimated_taxi_pax_sum'])
```

時系列プロット → 相関分析 → 仮説検証 (`docs/research/taxi-pool-observation.md` の H1〜H4 と同じ手順)。
