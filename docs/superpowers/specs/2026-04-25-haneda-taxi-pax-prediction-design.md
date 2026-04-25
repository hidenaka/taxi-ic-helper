# 羽田到着便 タクシー候補数予測 — 設計ドキュメント

- **作成日**: 2026-04-25
- **ステータス**: 設計承認待ち（本人レビュー）
- **対象ユーザー**: 1人（作成者自身、タクシー乗務員、アプリ配車専門）
- **公開方式**: 既存 `arrivals.html`（Public GitHub Pages）への機能追加
- **関連既存設計**:
  - `2026-04-25-haneda-arrivals-design.md`（到着便ビューワー v0.4）

---

## 1. 目的

既存の「推定降客数（機材座席数 × 路線別搭乗率）」をベースに、**降客のうちタクシーを利用する人数の推定値（タクシー候補数）** を出す。乗務員が「いま空港に向かうべきか／どの便のタイミングで入るか」をより精度高く判断するため。

### 重要な前提
> **本予測は「アプリ配車のタクシー客」を対象とする**。流し営業・駅前付け待ちとは需要パターンが異なるため、本予測式の係数はアプリ配車の経験則をベースとする。

### ユースケース（優先順）

1. **A. 便単位のタクシー需要判定**（主用途）
   - 各到着便について「タクシー候補が多い／少ない」を一目で判定
2. **B. 時間帯ピークの把握**（副次）
   - 30分単位のヒートマップでタクシー候補数の山を可視化
3. **C. 終電またぎ便の即時識別**
   - 公共交通到達不可な便を🔴アイコンで即時識別

### スコープ

- 対象空港: 羽田空港（HND）到着便のみ
- 対象ターミナル: T1（JAL系国内）/ T2（ANA系国内）/ T3（国際）
- 対象時間帯: 朝7時〜深夜3時（乗務時間に合わせる）
- 静的マスタ + ODPT運行情報のリアルタイム連携

### 非スコープ

- 出発便、第3ターミナル以外の国際線拠点
- 個別便ごとの目的地推定
- 期待売上（運賃）予測（後フェーズ）
- 流し営業・駅付け待ちの需要予測

---

## 2. 推定モデル

### 2.1 計算式

```
[1] ロビー出口時刻
    lobbyExitTime = estimatedTime + egressMinutes(terminal, isInternational)

[2] ベース・タクシー分担率
    baseRate = transitShare[timeBucket(lobbyExitTime)][terminal]

[3] 各ルートの到達可否判定
    reachable = routes.filter(r =>
        lobbyExitTime + travelMinutes(r) ≤ r.lastArrival(weekday|holiday)
    )
    
    [3-a] ODPT運行情報補正（C案）
        京急/モノレール運休 or 30分以上遅延 → 該当ルートを reachable から除外
    
    reachRate = Σ(reachable[i].weight) / Σ(routes[i].weight)

[4] reachブースト係数
    reachRate ≥ 0.9       → boost = 1.0
    0.5 ≤ x < 0.9          → boost = 1.3
    0.1 ≤ x < 0.5          → boost = 1.8
    x < 0.1（全不可）       → boost = 2.5

[5] 遅延ブースト
    delayMinutes ≥ 60 AND lobbyExitTime ≥ 23:30
        → delayBoost = 1.15
    その他                 → 1.0

[6] 最終推定
    estimatedTaxiPax = round(estimatedPax × baseRate × reachBoost × delayBoost)
    上限制約: ≤ estimatedPax × 0.85
```

### 2.2 ベース分担率テーブル（経験則ベース、ターミナル別）

| Bucket | 時間帯 | T1 | T2 | T3 |
|---|---|---|---|---|
| early | 7-9時 | 0.08 | 0.08 | 0.10 |
| morning | 9-12時 | 0.11 | 0.11 | 0.12 |
| noon | 12-15時 | 0.14 | 0.14 | 0.16 |
| afternoon | 15-17時 | 0.18 | 0.18 | 0.20 |
| peak1 | 17-19時 | 0.24 | 0.24 | 0.22 |
| evening | 19-21:30 | 0.14 | 0.14 | 0.18 |
| peak2 | 21:30-24時 | 0.21 | 0.21 | 0.22 |
| midnight | 24時以降 | 0.05 | 0.05 | 0.22 |

**経験則（本人体感）**:
- 朝7-9時はアプリ配車のタクシー利用が少ない（ビジネス客は電車・バス）
- 17-19時の第1ピーク（夕方の帰宅／商談移動）
- 19-21:30は暇帯
- 21:30以降に第2ピーク（終電前駆け込み・終電後）
- T1/T2は24時以降の便がそもそも存在しない（運用上ない）→ 出現するのは遅延便のみ

### 2.3 ルートマスタ（last-mile-routes.json）

「最寄駅の終電」ではなく「**乗継後の目的地までの実質最終到着時刻**」をマスタ化する。

#### コアルート（タクシー降客が多い方面）
| ID | 方面 | 経路 |
|---|---|---|
| `chiyoda-minato` | 千代田・港（東京・新橋・品川・六本木） | 京急→品川以降JR/メトロ |
| `shinjuku-shibuya` | 新宿・渋谷 | 京急→品川→JR山手線 |
| `yokohama` | 横浜 | 京急本線直通 |

#### 深夜需要ルート（終電が早い、深夜便→確実にタクシー）
| ID | 方面 | 経路 |
|---|---|---|
| `nerima-seibu` | 練馬区（西武池袋線） | 京急→品川→JR→池袋→西武 |
| `nerima-toei-oedo` | 練馬区（都営大江戸線） | 京急→泉岳寺→都営浅草→大門→大江戸線 |
| `itabashi-tobu` | 板橋（東武東上線） | 京急→品川→JR→池袋→東武 |
| `itabashi-mita` | 板橋（都営三田線） | 京急→泉岳寺→都営浅草→三田→三田線 |
| `suginami-chuo` | 杉並（JR中央線） | 京急→品川→JR→新宿→JR中央 |
| `suginami-keio` | 杉並（京王井の頭線） | 京急→品川→JR→渋谷→京王 |

#### リムジンバス系
| ID | 方面 |
|---|---|
| `bus-tokyo-st` | 東京駅 |
| `bus-shinjuku` | 新宿駅 |
| `bus-nerima-musashino` | 練馬・吉祥寺方面 |

各ルートに `weekday_last_arrival` `holiday_last_arrival` を持つ。各ルートには重み（経験則：千代田・港は大、練馬・板橋・杉並は中、横浜は中）を設定し、過去履歴データで校正。

---

## 3. データソース

### 3.1 既存
- ODPT API（到着便スケジュール）
- `aircraft-seats.json`（機材座席数）
- `load-factors.json`（路線別搭乗率）

### 3.2 新規
- 各社公式時刻表（京急電鉄、東京モノレール、東京空港交通）→ 半年〜年1で手動マスタ化
- 国交省「航空旅客動態調査」「空港アクセスのあり方」→ ベース分担率の参考
- ODPT API「TrainInformation」（京急・モノレール運行情報、5分ごと）
- **過去乗務履歴（本人提供のCSVコピー）**→ 全係数のチューニング根拠

### 3.3 過去履歴データの活用方針

過去乗務履歴は以下の校正に使用：
1. ベース分担率（時間帯×ターミナル）の経験則ベース校正
2. ブースト係数（1.0/1.3/1.8/2.5）の調整
3. ルート重みの実測値ベース調整
4. ピーク帯時刻の精密化

**取り込み方法**: ユーザーが Google Sheets からコピーした CSV/JSON を提供。Google Drive 直接認証は使わない。

---

## 4. UI拡張

### 4.1 便リスト（既存下段の拡張）

各便に以下を追加：
- タクシー候補数（推定）
- 公共交通到達アイコン: 🟢全モード可 / 🟡一部不可 / 🔴全不可
- 遅延ブースト発動時のバッジ「遅延+深夜」

```
[拡張イメージ]
20:35 ANA1234 千歳   🟢
B789 / 降客172 / タクシー候補~24
status: 定刻

00:15 JAL789 福岡   🔴+遅延60分
B738 / 降客116 / タクシー候補~33
status: 遅延 [深夜・全公共交通終了]
```

### 4.2 ヒートマップ（既存上段の切替トグル）

「**降客数 / タクシー候補数**」切替：
- 降客数モード = 既存
- タクシー候補数モード = 30分バケットごとの Σ estimatedTaxiPax
- 密度3段階の閾値はタクシー候補専用（70人以上=多い、30-69=普通、<30=少ない、要チューニング）

### 4.3 サマリ拡張（直近3時間）

追加項目：
- 総タクシー候補数
- ピーク帯時刻
- 遅延×深夜の便数（reachRate < 0.1 OR delayBoost発動）

### 4.4 ODPT運行情報バッジ（画面上部）

```
[京急: 通常運転 ✅]   [モノレール: 通常運転 ✅]
↓ 異常時
[京急: 運転見合わせ ⚠️]   [モノレール: 通常運転 ✅]
→ 京急経由ルートが reach 計算から外れる旨の注記
```

### 4.5 既存トピックの統合

既存「大幅遅延 / 深夜便」トピック（30分遅延・23:30固定の単純判定）は廃止し、新しい「タクシー需要急増便」（reachRate < 0.1 OR delayBoost発動）に統合。

### 4.6 設定パネル

不要（YAGNI）。既存のターミナル切替タブで十分。

---

## 5. 実装構成

### 5.1 ファイル構成

```
data/
  transit-share.json          [新規] base rate, ブースト係数, 上限
  last-mile-routes.json       [新規] 主要ルート最終接続時刻
  terminal-egress.json        [新規] T1/T2/T3別ロビー出口所要時間
  rail-status.json            [新規] ODPT運行情報（5分ごと更新）
  arrivals.json               [既存・拡張] taxiEstimatedPax/reachRate/reachTier 追加

scripts/lib/
  pax-estimator.mjs           [既存・無変更]
  taxi-estimator.mjs          [新規] 純関数: タクシー候補推定
  route-reachability.mjs      [新規] 純関数: ロビー出口時刻 vs ルート最終時刻
  arrival-transformer.mjs     [変更] taxi-estimator/route-reachability統合
  odpt-rail-status.mjs        [新規] 京急/モノレール運行情報取得

scripts/
  fetch-arrivals.mjs          [変更] マスタとrail-statusを読み込む
  fetch-rail-status.mjs       [新規] 運行情報フェッチ（5分ごと）

js/
  arrivals-data.js            [変更] taxi候補ヒートマップ集計、トピック再定義
  arrivals-render.js          [変更] 便リスト/ヒートマップ/サマリ拡張
  arrivals-app.js             [変更] ヒートマップ切替トグル、運行バッジ
  arrivals.html               [変更] DOM拡張

tests/
  taxi-estimator.test.mjs     [新規]
  route-reachability.test.mjs [新規]
  arrival-transformer.test.mjs[変更]
  arrivals-data.test.mjs      [変更]
```

### 5.2 純関数の責務

```
taxi-estimator.mjs:
  estimateTaxiPax(flight, transitShare, reachRate, delayBoostApplies) → number

route-reachability.mjs:
  computeReachRate(lobbyExitTime, routes, weekdayHoliday, railStatus) 
    → { reachRate, reachableRoutes, blockedRoutes }
  computeLobbyExitTime(estimatedTime, terminal, isInternational, egressMaster) 
    → "HH:MM"
```

すべて副作用なし。マスタは引数として渡す。

### 5.3 GitHub Actions

```
2 workflows:

(既存・拡張) fetch-arrivals.yml — 5分ごと
  - ODPT 到着便取得
  - transit-share.json / last-mile-routes.json / rail-status.json 読込
  - taxi候補数を含む arrivals.json 出力

(新規) fetch-rail-status.yml — 5分ごと（独立スケジュール）
  - ODPT 京急/モノレール運行情報取得
  - rail-status.json 出力
```

依存関係: rail-status は arrivals より先に更新されることが望ましい。実装上は別workflowで時差起動（スケジュールを 0,5,10... と 1,6,11... 等にずらす）。

### 5.4 ODPT 運行情報 API

候補エンドポイント（実装フェーズ最初のスパイクで実機確認）：
```
GET https://api.odpt.org/api/v4/odpt:TrainInformation
    ?odpt:operator=odpt.Operator:Keikyu
GET https://api.odpt.org/api/v4/odpt:TrainInformation
    ?odpt:operator=odpt.Operator:TokyoMonorail
```

抽出する状態：
- 平常運転 / 運転見合わせ / 運転再開 / 遅延
- 大規模遅延の判定基準は実機データ確認後に決定（暫定30分以上）

### 5.5 テスト戦略

| 種別 | カバレッジ |
|---|---|
| 純関数 | taxi-estimator/route-reachability の代表30件＋エッジケース |
| データ整合性 | transit-share.json/last-mile-routes.json のスキーマ検証 |
| 統合 | arrival-transformer 経由で全フィールド出力確認 |
| 既存 | 既存86件が壊れないこと（必須） |

### 5.6 マスタ更新運用

| ファイル | 更新頻度 | 方法 |
|---|---|---|
| `transit-share.json` | 過去履歴を取り込んだ時 + 経験則変化時 | 手動 |
| `last-mile-routes.json` | 半年〜年1（時刻表改定時） | 手動 |
| `terminal-egress.json` | 空港改装時のみ | 手動 |
| `rail-status.json` | 5分ごと | GitHub Actions自動 |

---

## 6. データマスタ仕様（JSON Schema 概要）

### 6.1 transit-share.json
```json
{
  "_meta": {
    "source": "ユーザー経験則 + 国土交通省 航空旅客動態調査（参考）",
    "scope": "アプリ配車のタクシー客に特化",
    "updated": "2026-04-25"
  },
  "buckets": [
    { "id": "early", "label": "7-9時", "rates": {"T1": 0.08, "T2": 0.08, "T3": 0.10} },
    { "id": "morning", "label": "9-12時", "rates": {"T1": 0.11, "T2": 0.11, "T3": 0.12} },
    { "id": "noon", "label": "12-15時", "rates": {"T1": 0.14, "T2": 0.14, "T3": 0.16} },
    { "id": "afternoon", "label": "15-17時", "rates": {"T1": 0.18, "T2": 0.18, "T3": 0.20} },
    { "id": "peak1", "label": "17-19時", "rates": {"T1": 0.24, "T2": 0.24, "T3": 0.22} },
    { "id": "evening", "label": "19-21:30時", "rates": {"T1": 0.14, "T2": 0.14, "T3": 0.18} },
    { "id": "peak2", "label": "21:30-24時", "rates": {"T1": 0.21, "T2": 0.21, "T3": 0.22} },
    { "id": "midnight", "label": "24時以降", "rates": {"T1": 0.05, "T2": 0.05, "T3": 0.22} }
  ],
  "reachBoost": [
    { "minRate": 0.9, "boost": 1.0 },
    { "minRate": 0.5, "boost": 1.3 },
    { "minRate": 0.1, "boost": 1.8 },
    { "minRate": 0.0, "boost": 2.5 }
  ],
  "delayBoost": {
    "minDelayMinutes": 60,
    "minLobbyExitTime": "23:30",
    "boost": 1.15
  },
  "maxRatio": 0.85
}
```

### 6.2 last-mile-routes.json
```json
{
  "_meta": {
    "source": "京急電鉄 / 東京モノレール / 東京空港交通 公式時刻表",
    "updated": "2026-04-25"
  },
  "routes": [
    {
      "id": "chiyoda-minato",
      "name": "千代田・港（東京・新橋・品川・六本木）",
      "via": ["京急", "JR山手線/メトロ"],
      "weekdayLastArrival": "00:30",
      "holidayLastArrival": "00:25",
      "weight": 0.30
    },
    ...
  ]
}
```

### 6.3 terminal-egress.json
```json
{
  "_meta": {
    "source": "羽田空港旅客ターミナル公表所要時間",
    "updated": "2026-04-25"
  },
  "egress": {
    "T1": { "domestic": 15, "international": 50 },
    "T2": { "domestic": 15, "international": 50 },
    "T3": { "domestic": 15, "international": 50 }
  }
}
```

### 6.4 rail-status.json
```json
{
  "updatedAt": "2026-04-25T14:30:00+09:00",
  "operators": {
    "Keikyu": { "status": "OnTime", "delayMinutes": 0 },
    "TokyoMonorail": { "status": "OnTime", "delayMinutes": 0 }
  }
}
```

---

## 7. リスク・既知の制約

| リスク | 影響 | 対策 |
|---|---|---|
| ODPT運行情報APIの安定性・レイテンシ | C案部分が動かない | スパイクで早期確認、A/B案へフォールバック |
| 過去履歴の質・量 | 校正の信頼性 | 履歴提供後にデータ規模確認、不足ならA/B案で運用開始 |
| 終電時刻の改定見落とし | reachRateの誤判定 | 半年ごとマスタ更新 + ODPT TrainTimetable で自動チェック検討 |
| 遅延便の連鎖（複数便同時遅延） | ピーク予測ズレ | 既存のestimatedTime反映で部分対応 |
| 国際線の入国審査時間ばらつき | egress時間誤差 | T3 egress を 50分（保守値）でスタート、履歴から微調整 |

---

## 8. マイルストーン（参考）

実装プラン詳細は次フェーズ（writing-plans）で作成。本設計でのざっくりした粒度：

1. **M1: データマスタ初期化** — transit-share.json / last-mile-routes.json / terminal-egress.json 作成
2. **M2: 純関数実装＋テスト** — taxi-estimator.mjs / route-reachability.mjs
3. **M3: arrival-transformer統合** — arrivals.json に taxi候補出力
4. **M4: UI拡張** — 便リスト / ヒートマップ切替 / サマリ拡張
5. **M5: ODPT運行情報スパイク** — 京急/モノレール TrainInformation API確認
6. **M6: rail-status統合 + UIバッジ** — fetch-rail-status.yml 追加
7. **M7: 過去履歴での係数校正** — ユーザー提供CSVから transit-share.json 更新
8. **M8: 既存テストの非破壊確認 + 全体動作確認**

---

## 9. 出典

- 国土交通省「空港アクセスのあり方について」資料1（https://www.mlit.go.jp/common/001081640.pdf）
- 国土交通省「航空旅客動態調査を用いた旅客流動分析」（https://www.mlit.go.jp/common/000139841.pdf）
- 京急電鉄 羽田空港第3ターミナル時刻表（https://norikae.keikyu.co.jp/）
- 東京モノレール 時刻表（https://www.tokyo-monorail.co.jp/timetable/）
- 東京空港交通 リムジンバス時刻表（https://www.limousinebus.co.jp/ja/timetable/）
- 公共交通オープンデータセンター ODPT API（https://api.odpt.org/）
- 本人乗務履歴（提供予定 CSV、Google Sheets コピー）
