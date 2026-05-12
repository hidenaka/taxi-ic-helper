# 設計: タクシー乗り場観測ループバックによる transit-share キャリブレーション

- **作成日**: 2026-05-12
- **対象**: 羽田空港到着便 `estimatedTaxiPax` の精度向上
- **配置先プロジェクト**: `乗務地図関係/`
- **方針転換の経緯**: 先行spec `2026-05-12-flight-reservation-pax-estimation-design.md` (ABANDONED) — ANA予約システムがbot拒否設計のため、観測ループバック方式へ転換

---

## 1. 背景・目的

### 現状の推定式

```
estimatedPax = seatCount × loadFactor                      // 飛行機の搭乗者数
estimatedTaxiPax = estimatedPax × transit-share × boosts   // タクシー利用客数
```

`transit-share` は `data/transit-share.json` に**手動メンテナンス**された時間帯×ターミナル別係数。`_meta.note` に「全係数は過去乗務履歴データで順次校正する前提」と既に明記されている。

### 課題

- transit-share の現在値はユーザー経験則 + 公表統計に基づく**静的固定値**
- 時間帯ごと（8区分）×ターミナル別（T1/T2/T3）で計24組
- 実態とのズレが補正されない

### 本施策の狙い

羽田タクシープールのライブカメラ画像（`ttc.taxi-inf.jp/Real01_line.jpg`, `Real02.jpg`）から**個別車両を検出・追跡し、出庫イベント数を観測**することで、実タクシー客数を直接計測。EMA で `transit-share.json` を自動キャリブレーションする。

---

## 2. スコープ

### Phase 1（本spec）

- 1分tickで Real01_line / Real02 を取得
- YOLOv8n で車両検出、ByteTrack で個別車両ID追跡
- 4乗り場（第一・第二=T1、第三・第四=T2）の出庫イベントを集計
- 日次バッチで `transit-share.json` の T1/T2 rates を EMA 更新
- T3 (国際線) は観測対象外、既存値維持

### Phase 1 スコープ外（将来）

- loadFactor 集計補正（路線×時間帯×曜日）
- 神奈川レーン・ハイヤー観測
- 個別便ごとの精度モニタダッシュボード

---

## 3. 前提と制約

### 観測の物理構造（ユーザー業務知識）

- 羽田国内線タクシープールは「P1駐車場（プール待機）→ 4乗り場 → 出庫」の3段階フロー
- 4乗り場: 第一・第二（一般+おもてなし）= T1側 / 第三・第四 = T2側 / 神奈川レーンは別管理
- 「**在庫>客が普通**」: 普段はプールから乗り場への補充が客流入より速い。瞬時の混雑度では客数を弁別できない
- 結論: 個別車両ID追跡で「**front_row から消えるイベント**」を直接カウントするのが唯一信頼できる手段

### カメラ配置

- `Real01_line.jpg`: 上カメラ。第一〜第三乗り場 + 第四乗り場の先頭まで（広角）
- `Real02.jpg`: 下カメラ。第四乗り場の続き + 神奈川レーン（**神奈川は除外**）
- 合算で4乗り場ほぼ全域カバー

### 技術的制約

- 実行環境: launchd（Macローカル運用専用）
- 既存 `observe-taxi-pool.mjs` を拡張（schema v2 → v3 移行）
- ByteTrack は連続フレーム前提のため、観測頻度を 5分tick → **1分tick** に上げる
- ttc.taxi-inf.jp の1分tick = 1440req/日 = 通常ユーザー範囲内

### 倫理ガード

- ttc.taxi-inf.jp の画像は推論直後にメモリ破棄。jsonl には bbox 座標等のメタデータのみ
- User-Agent 明示（既存と同じ）
- fetch 失敗時は jsonl 更新スキップ（サーバ負荷軽減）
- 補正結果は「自社推定パラメータ」であって ttc データ転載ではない

---

## 4. アーキテクチャ

```
[launchd: 毎分実行]
       │
       ▼
[observe-taxi-pool.mjs (拡張)]
   ├─ Real01_line.jpg / Real02.jpg を並列 fetch
   ├─ analyzePoolImage (既存、schema v2互換維持)
   ├─ vehicleDetector.detect(img)          ← 新規: YOLOv8n + onnxruntime-node
   ├─ vehicleTracker.update(...)           ← 新規: ByteTrack 追跡
   ├─ laneRoi.assign(...)                  ← 新規: 各車両を乗り場に割当
   ├─ departureDetector.detect(...)        ← 新規: 出庫イベント検出
   └─ taxi-pool-history.jsonl に schema v3 追記

[launchd: 毎日 JST 02:00]
       │
       ▼
[calibrate-transit-share.mjs] (新規)
   ├─ 過去14日分の jsonl 読み込み
   ├─ 時間帯×ターミナル別に出庫数集計
   ├─ 同期間の arrivals.json から estimatedPax合計集計
   ├─ EMA + 信頼区間ガードで rate 更新
   └─ data/transit-share.json を更新 (T1/T2のみ)

[既存 fetch-arrivals.mjs (15分tick)]
   └─ transit-share.json を読んで estimatedTaxiPax 計算
       → 補正後の値が arrivals.json に反映
```

### 配置先（ファイル一覧）

#### 新規

| ファイル | 責務 |
|---|---|
| `scripts/lib/vehicle-detector.mjs` | YOLOv8n 推論。画像→bbox配列 |
| `scripts/lib/vehicle-tracker.mjs` | ByteTrack 簡略版（IoUベースID追跡）。前tick状態 + 新bbox → 追跡IDつき配列 |
| `scripts/lib/lane-roi.mjs` | bbox中心点を polygon に照合し lane_id 割当 |
| `scripts/lib/departure-detector.mjs` | 前tick/今tick 差分から出庫イベント検出 |
| `scripts/calibrate-transit-share.mjs` | 日次キャリブレーション バッチ |
| `data/lane-roi.json` | 4乗り場×レーンの polygon 座標（手動定義） |
| `models/yolov8n.onnx` | YOLOv8n 事前学習済みモデル（外部DL、git管理外） |
| `models/README.md` | モデル取得手順 |
| `tests/lib/vehicle-detector.test.mjs` | fixture 画像で bbox 検証 |
| `tests/lib/vehicle-tracker.test.mjs` | 2フレーム入力で ID マッチング検証 |
| `tests/lib/lane-roi.test.mjs` | polygon 内外判定検証 |
| `tests/lib/departure-detector.test.mjs` | イベント検出検証 |
| `tests/calibrate-transit-share.test.mjs` | EMA + ガード検証 |
| `tests/fixtures/observation/*.jpg` | 既知bbox付き fixture 画像 |
| `tests/fixtures/observation/history-*.jsonl` | 模擬履歴jsonl |

#### 修正

| ファイル | 修正内容 |
|---|---|
| `scripts/observe-taxi-pool.mjs` | SCHEMA_VERSION 2→3、YOLO/Tracker/ROI/Departure 呼び出し追加 |
| `package.json` | `onnxruntime-node` を依存追加 |
| `.gitignore` | `models/*.onnx` を追加（モデルは git に含めない） |
| `~/Library/LaunchAgents/<plist>` | StartCalendarInterval を 5分→1分に変更（手動 or scripts/install-observe-launchd.sh 経由） |

---

## 5. データフロー

### 1分tickの処理（observe-taxi-pool.mjs）

```
1. fetch Real01_line / Real02 (既存 fetchImage)
2. analyzePoolImage (既存、schema v2互換)
3. vehicleDetector.detect(buf) → bboxes
4. vehicleTracker.update(bboxes, prev_state) → tracked
5. laneRoi.assign(tracked, lane-roi.json) → lane_id付与
6. departureDetector.detect(tracked, prev_tracked) → events
7. taxi-pool-history.jsonl に schema_version=3 で append
```

### 出庫イベント検出ロジック

```
for each tracked_vehicle in current_tick:
    prev_position = previous_tick.find(vehicle.id)
    if prev_position is None:
        continue  # 新規車両、出庫ではない
    
    # 前tickで front_row にいて、今tick で:
    #   a) 完全に消えた (lost_ids に入った)
    #   b) front_row 以外の位置に移動 (出庫=画面外への移動)
    if prev_position.is_front_row and (
        vehicle.id not in current_tick.tracked_ids
        or not vehicle.is_in_any_lane
    ):
        emit_departure_event({
            lane: prev_position.lane_id,
            terminal: lane_to_terminal(prev_position.lane_id),
            timestamp: current_tick.timestamp,
            vehicle_id: vehicle.id
        })
```

### 日次キャリブレーション（calibrate-transit-share.mjs, JST 02:00）

**データソース**: `taxi-pool-history.jsonl` のみ。schema v2 から既に存在する `arrivals_window.estimated_taxi_pax_sum` と `arrivals_window.flight_count` を集計母集団として使う。これにより過去 arrivals.json を git log から復元する必要がない。

```
α = 0.2

for bucket in [early, morning, noon, afternoon, peak1, evening, peak2, midnight]:
    for terminal in [T1, T2]:
        # observed_departures: schema v3 の departures から terminal フィルタで集計
        observed_departures = count(departures, bucket, terminal, past_14days)
        # estimated_pax_sum: schema v2/v3 の arrivals_window.estimated_taxi_pax_sum / 既存transit-share でestimatedPaxを逆算
        # 注: arrivals_window はターミナル別になっていないため、bucket間の tick で T1/T2 合算値しか取れない
        # → bucket全体の estimatedPax合計を逆算後、T1:T2 を既存rates比率で按分する
        estimated_pax_sum = sum_estimatedPax(arrivals_window_history, bucket, past_14days)
        t1_share_prev = previous_rates[bucket][T1]
        t2_share_prev = previous_rates[bucket][T2]
        if terminal == 'T1':
            estimated_pax_terminal = estimated_pax_sum * t1_share_prev / (t1_share_prev + t2_share_prev)
        else:
            estimated_pax_terminal = estimated_pax_sum * t2_share_prev / (t1_share_prev + t2_share_prev)
        sample_count = num_arrival_minutes(bucket, terminal, past_14days)
        
        if sample_count < 50:
            continue  # 統計的に不十分
        
        observed_rate = observed_departures / estimated_pax_sum
        previous_rate = transit_share.buckets[bucket].rates[terminal]
        
        # ±50% ガード
        if abs(observed_rate - previous_rate) / previous_rate > 0.5:
            log_warning(...)
            observed_rate = previous_rate + (observed_rate - previous_rate) * 0.5
        
        new_rate = α × observed_rate + (1-α) × previous_rate
        new_rate = clamp(new_rate, 0.01, 0.95)
        
        transit_share.buckets[bucket].rates[terminal] = new_rate

write transit_share with updated _meta.calibratedAt
git commit & push (既存パターン)
```

---

## 6. データ構造

### `data/lane-roi.json` (新規・手動定義)

```json
{
  "_meta": {
    "image_size": { "real01_line": [1920, 1080], "real02": [1920, 1080] },
    "updated": "2026-05-12",
    "note": "各乗り場のlane領域。polygon は画像座標系。"
  },
  "lanes": [
    {
      "id": "第一-一般",
      "terminal": "T1",
      "camera": "real01_line",
      "polygon": [[120, 340], [180, 340], [200, 480], [110, 480]],
      "front_row_polygon": [[120, 460], [200, 460], [200, 480], [110, 480]]
    },
    {
      "id": "第一-おもてなし",
      "terminal": "T1",
      "camera": "real01_line",
      "polygon": [...],
      "front_row_polygon": [...]
    }
    // ... 第二〜第四を全レーン分定義
  ]
}
```

### `taxi-pool-history.jsonl` schema v3

既存 schema v2 フィールドはすべて維持。以下を追加:

```json
{
  "schema_version": 3,
  "ts": "2026-05-12T15:30:00+09:00",
  "tick_seq": 7842,
  "img1": { /* 既存schema v2と同じ */ },
  "img2": { /* 同上 */ },
  "arrivals_state": { /* 同上 */ },
  "arrivals_window": { /* 同上 */ },
  "weather": { /* 同上 */ },
  "vehicles": {
    "real01_line": [
      { "id": 4521, "bbox": [120, 340, 50, 80], "lane": "第一-一般", "front_row": true, "age": 5 }
    ],
    "real02": [...]
  },
  "departures": [
    { "lane": "第一-一般", "terminal": "T1", "vehicle_id": 4520, "ts": "2026-05-12T15:30:00+09:00" }
  ],
  "lane_state": {
    "第一-一般": { "queue_count": 12, "front_row_occupied": true }
  }
}
```

### `data/transit-share.json` への変更（既存・出力フィールド拡張）

```json
{
  "_meta": {
    "source": "...",
    "updated": "2026-04-25",
    "calibratedAt": "2026-05-26T02:00:00+09:00",  // 新規追加
    "calibrationSampleDays": 14,                   // 新規追加
    "note": "..."
  },
  "buckets": [
    { "id": "early", "label": "...", "fromHHMM": "07:00", "toHHMM": "09:00",
      "rates": { "T1": 0.082, "T2": 0.085, "T3": 0.10 } }
    // ... T1/T2 のみ補正後、T3は既存維持
  ],
  // 他フィールド (reachBoost, delayBoost等) は既存維持
}
```

---

## 7. アルゴリズム詳細

### YOLOv8n 推論

- 事前学習済み COCO モデル（80クラス）から `car` (class_id=2), `truck` (7) のみ抽出
- 入力: 640×640 リサイズ (アスペクト維持 + padding)
- 出力: `[{x_center, y_center, w, h, confidence, class}, ...]`
- confidence 閾値: 0.4
- NMS IoU 閾値: 0.5

### ByteTrack 追跡

簡略版 ByteTrack 実装（フル機能は不要、必要要素のみ）:

```
state: { id -> { bbox, age, last_seen_tick } }

new_bboxes = [今tickの検出結果]
for each new_bbox:
    matched_id = find_match_by_iou(new_bbox, state, iou_threshold=0.3)
    if matched_id:
        state[matched_id].bbox = new_bbox
        state[matched_id].age += 1
        state[matched_id].last_seen_tick = current_tick
    else:
        new_id = generate_new_id()
        state[new_id] = { bbox: new_bbox, age: 1, last_seen_tick: current_tick }

for each id in state:
    if state[id].last_seen_tick < current_tick - LOST_THRESHOLD:
        del state[id]  // 完全に消失（出庫）
```

- LOST_THRESHOLD: 2 tick (2分以内に再出現すれば同一車両とみなす)

### EMA キャリブレーション

- α = 0.2（14日分蓄積で約2-3ヶ月でほぼ収束）
- サンプル要件: 50 ticks未満は補正スキップ
- ドリフトガード: ±50% 超は半分のみ反映 + 警告ログ
- 値範囲: clamp [0.01, 0.95]

---

## 8. エラーハンドリング

### 観測層

| エラー | 挙動 |
|---|---|
| ttc.taxi-inf.jp fetch 失敗 | 既存どおりスキップ、jsonl 更新なし |
| YOLO 推論失敗 | jsonl の vehicles を null、既存 schema v2 フィールドのみ記録 |
| ByteTrack 例外 | 同上 |
| 画像サイズ変動 | lane-roi.json の image_size と一致しなければ警告ログ、ROI割当をスキップ |

### キャリブレーション層

| エラー | 挙動 |
|---|---|
| 過去14日分の jsonl が無い | 警告ログ、補正スキップ（transit-share.json 更新なし）|
| サンプル数<50 | 該当bucket/terminal のみスキップ |
| ドリフト>50% | 半分のみ反映、警告 |
| transit-share.json 書き込み失敗 | エラーログ、ファイル変更なし |

### Phase1 → Phase2 移行時

- schema v3 履歴は Phase2 でそのまま loadFactor 補正用にも使える
- 後方互換: schema_version で v2/v3 を判別、calibration ジョブは v3 ticks のみ採用

---

## 9. テスト戦略

### 単体テスト

| ファイル | 内容 |
|---|---|
| `tests/lib/vehicle-detector.test.mjs` | 固定 fixture 画像で bbox 出力、confidence/class フィルタ |
| `tests/lib/vehicle-tracker.test.mjs` | 2フレーム入力で ID マッチング、新ID付与、IoU 閾値、消失検出 |
| `tests/lib/lane-roi.test.mjs` | polygon 内外判定（境界条件含む）|
| `tests/lib/departure-detector.test.mjs` | 前tick/今tick 構造で各種出庫パターン検証 |
| `tests/calibrate-transit-share.test.mjs` | EMA 更新、サンプル<50 スキップ、±50%ガード、clamp |

### モック統合テスト

- `tests/observe-taxi-pool-integration.test.mjs`: fixture画像 + fixture jsonl で `observe-taxi-pool.mjs` 全体を実行、schema v3 出力検証
- `tests/calibrate-integration.test.mjs`: fixture jsonl (14日分) + fixture arrivals_history で calibration 実行、transit-share.json 差分検証

### 手動検証

- ROI 定義段階: 実画像にbboxとpolygonを重ねて表示するデバッグスクリプト
- Phase1 実装後: 過去2週間 dry-run calibration、補正前後 transit-share.json 差分をユーザーが目視

---

## 10. 完了基準（Phase 1）

- [ ] `scripts/lib/vehicle-detector.mjs` 完成 + 単体テスト PASS
- [ ] `scripts/lib/vehicle-tracker.mjs` (ByteTrack 簡略版) 完成 + 単体テスト PASS
- [ ] `data/lane-roi.json` 手動定義完了（実画像を見ながら）
- [ ] `scripts/lib/lane-roi.mjs` 完成 + 単体テスト PASS
- [ ] `scripts/lib/departure-detector.mjs` 完成 + 単体テスト PASS
- [ ] `scripts/observe-taxi-pool.mjs` schema v3 移行完了 + 統合テスト PASS
- [ ] launchd cron を 5分tick→1分tick に変更
- [ ] 1週間連続稼働、ttc.taxi-inf.jp の遮断なし
- [ ] `scripts/calibrate-transit-share.mjs` 完成 + 単体テスト PASS
- [ ] 14日間蓄積後、初回 calibration 実行、補正値がユーザーの直感と矛盾しない範囲
- [ ] 既存 `arrivals.json` の `estimatedTaxiPax` が補正後の値に変化

---

## 11. Phase 2 への布石（将来）

- loadFactor 集計補正: schema v3 jsonl の departures を路線×時間帯×曜日で集計し、`load-factors.json` を補正
- 個別便ごとの精度モニタダッシュボード（予測 vs 実測）
- 神奈川レーン・ハイヤー観測（カメラ範囲拡大 or 別ソース）
- ByteTrack の本格実装（現在は簡略IoUマッチング）

これらは Phase 1 で蓄積された schema v3 データを使ってPhase2 で実装可能。Phase 1 完了の時点で、追加観測は不要。

---

## 12. 法的・倫理ガード（リバイス版）

| ガード | 適用先 | 内容 |
|---|---|---|
| 画像保存しない | observe-taxi-pool.mjs | 推論直後にメモリ破棄、bbox メタデータのみ jsonl 記録 |
| User-Agent明示 | observe-taxi-pool.mjs（既存維持） | `taxi-ic-helper observation bot (URL)` |
| 頻度1分tick | launchd cron | 1440req/日 = 通常ユーザー範囲 |
| fetch失敗時スキップ | observe-taxi-pool.mjs（既存維持） | サーバ負荷軽減 |
| データ転載なし | calibration出力 | 補正結果は「自社推定パラメータ」のみ |

新たな法的問題は発生しない（既存observation pipelineの拡張）。
