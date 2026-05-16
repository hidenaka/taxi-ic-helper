# 追跡 throughput → forecast 接続 設計 (Phase G-1)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / F-3 の車両追跡 throughput を forecast の outflow 信号に接続する
- 前提 spec: `2026-05-16-vehicle-tracking-design.md` (F-3、実装済)、`2026-05-15-stall-forecast-mvp-design.md` (forecast MVP)、`2026-05-16-forecast-accuracy-tracking-design.md` (D-1)
- 由来: F-3 で `data/vehicle-track-history.jsonl` に60秒毎の `departed` (出庫確定数) が記録されるようになった。本フェーズで、その追跡ベースの正確な throughput を forecast の outflow 信号として接続する。

## 背景

現在の forecast (`scripts/lib/forecast-engine.mjs`) は outflow 信号として **net-diff** を使う。net-diff = stall 占有数の前 tick 差分 `diff_occupied_from_prev` の負分。これは「5分の間に入れ替わった分」を取りこぼすため、真の出庫 throughput を系統的に過小評価する。

F-3 の track `departed` は Real01_line を60秒間隔で全車追跡して得た出庫確定数で、入れ替わりを取りこぼさない正確な throughput。本フェーズはこの track throughput を forecast に接続する。

### 調査で確定した3つの事実

1. **F-3 トラッカーが見るのは stall1+2+3 の合算**。`scripts/lib/stall-rois.json` で stall1/2/3 は `source: real01_line`、stall4 だけ `source: real02`。F-3 は Real01_line 1カメラのみ追跡するため、`departed` は stall を区別しない stall1+2+3 合算の1値。**stall4 は追跡対象外**。
2. **単位の不整合**。`computeForecast` の `trendFactor = trendActual / trendExpected` は分子・分母とも net-diff。track の `departed` をそのまま分子に入れると、分子だけ真値・分母は過小値となり比が壊れる。両者を同単位に揃えるバイアス係数 `k`（= track throughput ÷ net-diff outflow）が必要。
3. **D-1 精度評価の実績も net-diff**。`accuracy-evaluator.mjs` の `buildActualMap` は `diff_occupied_from_prev` の負分を実績 outflow とする。よって forecast 出力の単位を変えると D-1・correction-engine・ensemble まで単位移行が波及する。

## 設計方針

1. **trendFactor の単位合わせだけに `k` を使う。** forecast 出力の単位 (net-diff) は不変。これにより **D-1 精度評価・correction-engine・ensemble・F-1・F-2・F-3 は一切変更しない**。改善点は、`trendFactor` の「直近 outflow 実績信号」が粗い5分 net-diff (ノイズ大) から60秒追跡の正確な throughput に変わること。
2. **`k` は累積比 + bootstrap フォールバック。** track と net-diff を5分窓で突き合わせ、全期間の累積比を `k` とする。バイアスはカメラ幾何 + サンプリング由来でほぼ定常のため時刻別 stratify は不要。データが揃うまでは `k=1.0` (補正なし = 現状挙動) にフォールバック。
3. **fail-safe。** track データの欠損・不足時は net-diff 経路にフォールバックし、forecast は必ず生成される。
4. **純関数 + 既存パターン踏襲。** `k` 算出は純関数モジュールに切り出し node:test でテスト。状態語彙 (`bootstrapping`/`learning`) は D-3 と揃える。

## アーキテクチャ

```
[observe-taxi-pool.mjs  forecast try ブロック]
  1. data/vehicle-track-history.jsonl をロード (無い/空 → 空配列)
  2. computeThroughputCalibration(netDiffHistory, trackHistory)
       → data/throughput-calibration.json に書き出し
  3. trackActual = 直近60分窓の track departed 合算 (カバレッジ不足なら null)
  4. computeForecast(baseline, recent, arrivalsJson, now, trackTrend)
       trackTrend = state==='learning' ∧ trackActual非null → { k, actual: trackActual }
                    それ以外 → null
```

## コンポーネント

### 1. 新モジュール `scripts/lib/throughput-calibration.mjs` (純関数)

`computeThroughputCalibration(netDiffHistory, trackHistory)` → `{ k, state, windowCount, trackSum, netDiffSum }`

**5分窓 join のロジック:**

- `netDiffHistory` の各行のうち**信頼サブセット**のみ採用: `schema_version === 3` ∧ `img1.roi.luminance_mean >= 30` ∧ `stalls` 非 null ∧ `ts` が有効。
- 信頼サブセット行 (ts = `T`) ごとに5分窓 `(T - 5min, T]` を定義。
- その行の **net-diff outflow** = stall1 + stall2 + stall3 の `diff_occupied_from_prev` の負分の絶対値合算 (stall4 は track 対象外なので除外)。
- `trackHistory` のうち `ts` が窓 `(T - 5min, T]` に入る行の `departed` を合算 = その窓の **track departed**。
- 窓内の track 行数が `MIN_TRACK_TICKS_PER_WINDOW` (= 4) **以上**の窓のみ採用 (欠損窓が trackSum を過小評価しないため)。
- 採用窓を全期間で累積: `trackSum += track departed`、`netDiffSum += net-diff outflow`、`windowCount += 1`。

**`k` と `state` の決定:**

- `windowCount >= MIN_WINDOWS_FOR_LEARNING` (= 12、=1時間ぶん) → `state = 'learning'`、`k = clip(trackSum / netDiffSum, K_MIN, K_MAX)`。
- `windowCount < 12` → `state = 'bootstrapping'`、`k = 1.0`。
- `netDiffSum === 0` (採用窓があっても出庫ゼロ) → `k = 1.0` (0除算回避)。
- 定数: `K_MIN = 0.5`、`K_MAX = 5.0` (異常値ガード。理論上 `k >= 1` だが下振れ・外れ値も clip)。

純関数・副作用なし。`trackHistory` が空配列なら `windowCount = 0` → `bootstrapping`、`k = 1.0`。

### 2. `computeForecast` の変更 (`scripts/lib/forecast-engine.mjs`)

シグネチャに第5引数 `trackTrend` を追加 (末尾・後方互換):

```
computeForecast(baseline, recentHistory, arrivalsJson, now, trackTrend = null)
```

`trackTrend` は `{ k: number, actual: number }` または `null`。

trendFactor 算出ブロックの変更 (trendExpected の算出は現状のまま net-diff baseline 合算):

- `recentHistory.length >= TREND_WINDOW_TICKS` ∧ `trackTrend !== null` ∧ `typeof trackTrend.actual === 'number'` ∧ `trendExpected > 0` のとき:
  - `trendActual = trackTrend.actual`
  - `trendFactor = clip(trendActual / (trackTrend.k * trendExpected), TREND_FACTOR_MIN, TREND_FACTOR_MAX)`
  - `trendSource = 'track'`
- それ以外 → 現状の net-diff 経路をそのまま実行 (`trendActual` = recentHistory の `total_outflow` 合算、`trendFactor = clip(trendActual / trendExpected, ...)`)、`trendSource = 'netdiff'`。

戻り値の `trendWindow` に2フィールド追加: `source` (`'track'` | `'netdiff'`)、`k` (track 経路のとき `trackTrend.k`、net-diff 経路のとき `null`)。

### 3. `observe-taxi-pool.mjs` のオーケストレーション

forecast try ブロック (現 L259-284) 内に追加:

- 定数 `TRACK_HISTORY_PATH = './data/vehicle-track-history.jsonl'`、`THROUGHPUT_CALIBRATION_PATH = './data/throughput-calibration.json'` を他の `_PATH` 定数群に追加。
- track history をロード: ファイルが無い/空なら空配列 (fail-safe、`existsSync` ガード、行ごとの `JSON.parse` は try で握る)。
- `computeThroughputCalibration(allHistory, trackHistory)` → 結果に `schema_version: 1` と `generated_at` (JST ISO 文字列、既存 `jstNowIso` 相当のハック) を付けて `THROUGHPUT_CALIBRATION_PATH` に書き出し。
- `trackActual` の算出: `recent` (直近12 net-diff tick) の最古行の `ts` を窓開始、`now` を窓終了とし、track history のうち `ts` がその区間に入る行の `departed` を合算。区間内の track 行数が `MIN_TRACK_TICKS_FOR_TREND` (= 48、60本想定の80%) **以上**なら数値、未満なら `null`。
- `computeForecast` 呼び出し: `calibration.state === 'learning'` ∧ `trackActual !== null` のとき第5引数に `{ k: calibration.k, actual: trackActual }`、それ以外 `null`。
- 上記は forecast try ブロック内に置き、失敗しても従来通り catch で握って本観測に影響させない。

## 出力スキーマ

### `data/throughput-calibration.json` (新規、schema v1、再生成系 JSON)

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-16T13:05:00+09:00",
  "k": 1.32,
  "state": "learning",
  "window_count": 40,
  "track_sum": 132,
  "netdiff_sum": 100
}
```

毎 tick 再生成。`stall-forecast.json` 等と同じ「再生成系 JSON」ファミリ。

### `data/stall-forecast.json` の `trendWindow` 拡張

既存 `trendWindow: { actual, expected, ticks }` に2フィールド追加:

```json
"trendWindow": { "actual": 9, "expected": 7.5, "ticks": 12, "source": "track", "k": 1.32 }
```

`source` が `'track'` のとき `actual` は track departed 合算値、`'netdiff'` のとき従来の net-diff 合算値。

## git 配線

`scripts/observe-tick-local.sh`:

- pull 前の `git checkout HEAD --` 2行 (L42, L50) の再生成系 JSON 群に `data/throughput-calibration.json` を追加。
- `git add` 行 (L75) に `data/throughput-calibration.json` を追加。

`data/throughput-calibration.json` は再生成系のため、autostash/rebase 衝突時は `git checkout HEAD --` で破棄してよい (append-only 観測ファイルとは扱いが異なる)。`.gitattributes` の `merge=union` は append-only ファイル用なので本ファイルには不要。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `vehicle-track-history.jsonl` が無い・空 | track history = 空配列 → `bootstrapping`、`k=1.0`、net-diff 経路 (現状挙動) |
| track 行の JSON parse 失敗 | その行をスキップ、残りで継続 |
| 直近60分窓の track カバレッジ不足 (<48本) | `trackActual = null` → net-diff 経路にフォールバック |
| `netDiffSum === 0` | `k = 1.0` |
| `k` 異常値 | `[K_MIN, K_MAX]` = `[0.5, 5.0]` に clip |
| calibration 算出全体の失敗 | forecast try ブロックの catch で握る。throughput-calibration.json は前回値据え置き、forecast は net-diff 経路で生成 |

## テスト方針

### `tests/throughput-calibration.test.js` (新規、node:test)

`computeThroughputCalibration` の純関数テスト:

- 信頼サブセット行 + 十分な track 行 → 5分窓 join が正しく合算、`k = trackSum / netDiffSum`。
- `windowCount < 12` → `state = 'bootstrapping'`、`k = 1.0`。
- `windowCount >= 12` → `state = 'learning'`、`k` が計算値。
- 窓内 track 行が4本未満 → その窓を不採用 (`windowCount` に数えない)。
- `netDiffSum === 0` → `k = 1.0` (0除算しない)。
- `k` が `K_MAX` 超 → `K_MAX` に clip。
- `trackHistory` 空配列 → `windowCount = 0`、`bootstrapping`。
- 信頼サブセット外の net-diff 行 (schema≠3、暗い、stalls null) は窓に数えない。

### `tests/forecast-engine.test.js` (既存に追加)

`computeForecast` の `trackTrend` 経路:

- `trackTrend` 付き ∧ `recentHistory` 十分 → `trendFactor = clip(actual / (k * expected), ...)`、`trendWindow.source = 'track'`、`trendWindow.k = k`。
- `trackTrend = null` → 従来の net-diff 経路、`trendWindow.source = 'netdiff'`、`trendWindow.k = null`。
- `trackTrend` 付きでも `recentHistory` 不足 → net-diff 経路にフォールバック。
- `trendExpected = 0` のとき track 経路に入らず `trendFactor = 1.0` (現状の不変条件を維持)。

### 回帰

- `npm test` (node:test、現 407 件) → 増。全件パスを確認。
- Python テスト (`track_vehicles.py` / `detect_vehicles.py`) は本フェーズで対象を変更しないため不変。

## スコープ外 (後フェーズ・ロードマップ)

- **B案: baseline 出力の真値化** — forecast `total` を真の出庫台数 (throughput 単位) にする。D-1 `buildActualMap`・correction-engine・ensemble の単位移行を伴うため別 spec。
- 時刻別 (slot 別) の `k` — 2週間のデータ寿命では slot 別サンプルが揃わないため不可。
- stall4 の throughput 補正 — F-3 は Real01_line のみ追跡し stall4 (real02) を見ない。
- 複数カメラ追跡。
- `track_vehicles.py` / `detect_vehicles.py` / `observe-taxi-pool.mjs` の forecast try ブロック以外 / F-1・F-2・D系・E系・ensemble・accuracy の変更。

## 既知の限界 (明記して割り切る)

net-diff の取りこぼしは混雑時 (5分内に2台以上入れ替わる) ほど大きいため、`k` は本来やや throughput 依存。グローバル単一 `k` はこの依存性を平均化して捨てる。2週間のデータ寿命では時刻別 stratify が不可能なため、単一 `k` で割り切る。

## 完了条件

- `scripts/lib/throughput-calibration.mjs` に純関数 `computeThroughputCalibration` が実装され node:test がある。
- `computeForecast` が第5引数 `trackTrend` を受け、track 経路で `trendFactor` を算出、net-diff 経路にフォールバックできる。`trendWindow` に `source` / `k` がある。
- `observe-taxi-pool.mjs` が track history をロードし `data/throughput-calibration.json` を毎 tick 生成、`trackActual` を算出して `computeForecast` に渡す。
- `data/throughput-calibration.json` が schema v1 で生成される。
- `observe-tick-local.sh` の `git checkout HEAD --` / `git add` に `throughput-calibration.json` が含まれる。
- track データが無い/不足のとき net-diff 経路にフォールバックし forecast が生成される。
- `npm test` 全件パス。D-1・correction-engine・ensemble・F-1・F-2・F-3 は不変。
