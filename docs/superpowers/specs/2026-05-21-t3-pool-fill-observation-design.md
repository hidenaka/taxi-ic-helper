# T3 待機所 埋まり具合観測 設計書

> 作成: 2026-05-21
> 対象: taxi-ic-helper / 羽田T3 第3待機所のタクシー埋まり具合（供給状態）観測
> 関連: `2026-05-20-t3-slot-occupancy-design.md`（旧 Phase 1・本設計で置き換え/撤去）、
>      `2026-05-16-t3-pool-observation-design.md`（Phase E-1 全体メトリクス収集）

## 目的

羽田T3 第3待機所の **タクシーの埋まり具合（0〜100%）** を前方・後方の2エリアで計測し、日報アプリ到着便 T3 ページに表示するためのデータ JSON を生成する。「後方に溜まって前方が空＝供給待ちで詰まってる」「両方空＝出払って暇」を乗務員が一目で判断できるようにする。

## 背景

### 旧 Phase 1 の白紙化

`2026-05-20-t3-slot-occupancy-design.md`（旧 Phase 1）は「Real106/107 で 9レーン × 先頭2列のマス目を画像解析し出庫数を計測」する設計だったが、**実画像確認で前提が崩れた**:

- Real106 は乗り場最先端の接客地点（1〜2台）で 9レーンは映らない
- Real107 は歩道側の乗客視点でタクシー待機列は画角外
- WEB記事の「第3待機所 9レーン × 先頭2列」は現役乗務員の地上目線ルールで、ttc カメラはそれを正面から映していない

旧 Phase 1 のコード（`t3-slot-occupancy-tick.mjs` 等）は本設計で撤去する（§7）。

### 目的の再確認（本人意向）

- 需要予測（フライト到着・乗客人数カウント）は **やらない**（人数カウントは非現実的）
- 知りたいのは **待機タクシーの埋まり具合**（前方/後方の2エリアで何割埋まってるか）
- 用途は **日報アプリ到着便 T3 ページでの表示**

### ttc カメラのマッピング（実確認）

ttc.taxi-inf.jp `no23.php` のキャプションで確定:

| 画像 | キャプション | 内容（実画像） |
|---|---|---|
| Real109 | 第3待機所の状況**(後方)** | 密集タクシープール（第4から入る側・溜まり場、40〜50台） |
| Real108 | 第3待機所の状況**(前方)** | 乗り場へ出ていく側（空きがち＝捌けてる証拠） |
| Real03 | 第3待機所の状況 | 出口動線 |
| Real04 | 第4待機所の状況 | 200m手前の供給元（あふれ時のみ使用） |

運用ルール: 第3待機所に直接入構不可、必ず第4待機所を経由。

### 実データ分析（t3-pool-history.jsonl 1387行・時間帯別）

`diff_from_prev`（フレーム間変化＝動き、×1000）:

| カメラ | 深夜2-5 | 朝6-9 | 昼11-14 | 夕17-20 |
|---|---|---|---|---|
| Real109（後方） | 21.7 | 34.2 | 33.1 | 32.8 |
| Real108（前方） | 18.4 | 23.4 | 17.8 | 29.0 |
| Real04（第4） | 32.4 | 5.9 | 5.3 | 59.8 |

Real04 は朝昼ほぼ動かず（black_ratio も朝昼 ~0.6%）＝「あふれ時だけ溜まる予備プール」と判明。常時の供給指標には不向きなので本設計では使わない。Real108/109 が常時タクシーが存在し、埋まり具合計測に適する。

## 採用アプローチ

**Real108（前方）と Real109（後方）の2エリアの埋まり具合（0〜100%）を計測する。**

各カメラに駐車エリアを囲む ROI を1個ずつ定義し、その中の占有度指標（black_ratio / edge_density）を空/満で正規化して 0〜1 の `fillRatio` にする。個々のタクシーは識別しない・正確な台数は数えない（密集黒車で誤差が大きいため。本人合意済み）。概算台数は `fillRatio × エリア最大収容数` で粗く併記する。

### なぜ「埋まり具合」か（台数カウント不採用）

- 後方 Real109 は黒いタクシーが重なり合い、YOLO 等の正確な台数カウントは誤差が大きい（T1/T2 で密集黒車取りこぼし実証済み）
- 埋まり具合（エリア占有度）なら密集していても確実に測れる
- 乗務員の「行く価値あるか」判断には埋まり具合で十分

### なぜ ROI を絞るか

既存 `t3-pool-history.jsonl` の black_ratio は画像全体の値で、駐車エリア以外（建物・空・芝生・バス）を含む。特に Real108（前方）は空が画角の多くを占め全体値が薄まる。駐車エリアに ROI を絞れば占有度の弁別力が上がる。ROI は1カメラ1個（旧 Phase 1 の18マスではない）なので校正は軽い。

### 不採用

- **9レーン slot-occupancy（旧 Phase 1）** — カメラに9レーンが映らず前提崩壊
- **YOLO 台数カウント** — 密集黒車の取りこぼし
- **フライト到着連動の需要予測** — 人数カウントは非現実的（本人判断）。将来別フェーズで検討の余地はあるが本設計のスコープ外
- **diff_from_prev（動き）を主指標化** — 「埋まり具合」の時系列変化で動きは読めるため、生 diff を主指標にはしない

## 設計

### 1. ROI 定義（新ファイル `data/t3-pool-rois.json`）

各カメラの駐車エリア矩形（正規化座標）と、空/満の正規化基準値を保持する。

```json
{
  "_meta": { "image_size": [1024, 576], "note": "T3 第3待機所 前方/後方の駐車エリア占有度 ROI。座標と baseline は校正で確定" },
  "schema_version": 1,
  "areas": {
    "front": {
      "camera": "Real108",
      "roi": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
      "metric": "edge_density",
      "empty_baseline": 0.0,
      "full_baseline": 0.0,
      "max_capacity": 0
    },
    "rear": {
      "camera": "Real109",
      "roi": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
      "metric": "edge_density",
      "empty_baseline": 0.0,
      "full_baseline": 0.0,
      "max_capacity": 0
    }
  }
}
```

- `roi`: 駐車エリアを囲む矩形（正規化 0〜1）。校正で確定
- `metric`: `black_ratio` か `edge_density`。空/満サンプルで弁別力の高い方を採用（plan で決定）
- `empty_baseline` / `full_baseline`: 空の時・満杯の時の metric 値。正規化の基準
- `max_capacity`: そのエリアの最大収容台数（概算台数算出用）。校正で目測確定

### 2. 占有度の算出（新規純関数）

`scripts/lib/t3-pool-fill.mjs` に純関数を置く:

| 純関数 | 仕様 |
|---|---|
| `computeFillRatio(metric, emptyBaseline, fullBaseline)` | `(metric - empty) / (full - empty)` を 0〜1 にクランプ。full==empty の異常時は 0 |
| `fillLevel(ratio)` | `ratio < 0.33`→`"空き"`、`< 0.66`→`"半分"`、以上→`"混雑"`（閾値は定数、校正で調整可） |
| `approxCount(ratio, maxCapacity)` | `Math.round(ratio * maxCapacity)` |
| `parseT3PoolRois(json)` | schema_version=1 と areas.front/rear の検証、抽出 |
| `buildT3PoolFillPayload(frontResult, rearResult, now)` | `{schemaVersion, generatedAt, areas:{front, rear}}` 整形。欠損カメラは該当エリアを省略 |

### 3. ROI 占有度の計測

既存 `scripts/lib/image-pool-analyzer.mjs::analyzeROI` を流用。Real108/109 の駐車エリア ROI を渡し、`metric`（black_ratio or edge_density）を得る。新規画像解析ロジックは不要。

### 4. 出力ファイル

#### `data/t3-pool-fill.json`（表示用・上書き）

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-21T12:30:00+09:00",
  "areas": {
    "front": { "camera": "Real108", "fillRatio": 0.15, "level": "空き", "approxCount": 3 },
    "rear":  { "camera": "Real109", "fillRatio": 0.88, "level": "混雑", "approxCount": 44 }
  }
}
```

#### `data/t3-pool-history.jsonl`（既存・後方互換追加）

Phase E-1 で記録中の各カメラエントリに **`roi_fill_ratio` フィールドを追加**（Real108/109 のみ非 null、他カメラは null か省略）。既存 `black_ratio` 等は不変。`computeT3DirectionalCorrection`（Real106 black_ratio を読む）には影響なし。

### 5. 観測スクリプトへの組込み

`scripts/observe-taxi-pool.mjs` の既存 Phase E-1 ステップ（6カメラ取得して t3-pool-history.jsonl 記録）の中で、Real108/109 については ROI 占有度も計測し、`fillRatio` を算出して `t3-pool-fill.json` を書き出す。すべて try/catch で隔離し、既存 Phase E-1・forecast パイプラインに影響させない。`t3-pool-rois.json` が無い/未校正（baseline=0）の場合は fill 計算をスキップ（fillRatio を出さない）。

### 6. 配信

taxi-ic-helper の relay 設定（`relay-taxi-data.yml` 等）の配信ファイルに `data/t3-pool-fill.json` を追加。日報アプリ側がこれを読む（表示は別 spec）。

### 7. 旧 Phase 1（slot-occupancy）コードの撤去

本設計で旧「9レーン slot-occupancy（出庫数）」は不要。撤去する:

| 種別 | 対象 |
|---|---|
| 削除 | `scripts/t3-slot-occupancy-tick.mjs`、`scripts/lib/t3-occupancy-helpers.mjs`、`scripts/lib/t3-stall-slots.json` |
| 削除 | `scripts/calibrate-t3-slots.mjs`（18マス用。新 ROI 校正は別途）|
| 削除 | テスト3本 `tests/t3-stall-slots-parse.test.js`、`tests/t3-occupancy-helpers.test.js`、`tests/observe-t3-actuals.test.js` |
| 削除 | `scripts/observe-taxi-pool.mjs` の T3 actuals 集計ブロック + `computeT3SlotActuals` import + T3 path 定数 |
| 削除 | `scripts/observe-tick-local.sh` の `t3-slot-occupancy-history.jsonl` / `t3-stall-actuals.json` 配線、`.gitattributes` の `t3-slot-occupancy-history.jsonl merge=union` |
| 削除 | `data/t3-slot-occupancy-history.jsonl`、`data/t3-stall-actuals.json` |
| 流用 | `scripts/snapshot-t3-cameras.mjs`（Real108/109 も取得するよう拡張して残す）|
| 本人作業 | Mac mini の launchd `jp.taxi-ic-helper.t3-slot` を停止・アンロード |

### 8. 校正フェーズ

ROI は1個×2カメラだけなので旧 Phase 1 の18マスより遥かに軽い:

1. `node scripts/snapshot-t3-cameras.mjs`（Real108/109 取得対応に拡張）でサンプル取得
2. Real108/109 の駐車エリアを囲む矩形を `t3-pool-rois.json` に記入
3. 空サンプル（前方=ほぼ空）・満サンプル（後方=密集）で `empty_baseline` / `full_baseline` / `max_capacity` を確定
4. `metric` を black_ratio / edge_density で弁別力比較し決定

## データフロー

```
Real108.jpg / Real109.jpg（5分tick・既存 Phase E-1 取得）
    │
    └─ 駐車エリア ROI を analyzeROI → metric（black_ratio or edge_density）
            │
            ├─ t3-pool-history.jsonl に roi_fill_ratio 追記（履歴）
            │
            └─ computeFillRatio で 0〜1 正規化
                  → fillLevel（空き/半分/混雑）+ approxCount
                  → t3-pool-fill.json 書き出し（上書き）
                  → relay で日報アプリへ配信
```

## テスト方針（TDD）

純関数中心。実画像・校正は目視。

### 新規純関数テスト

- `computeFillRatio`: 空→0.0、満→1.0、中間比例、範囲外クランプ、full==empty 異常時 0
- `fillLevel`: 「空き/半分/混雑」の境界値
- `approxCount`: ratio×capacity の四捨五入、両端
- `parseT3PoolRois`: schema 検証・抽出、areas 欠損時の throw
- `buildT3PoolFillPayload`: front/rear 2エリア構造、欠損カメラ時の省略

### 流用（テスト追加なし）

- `analyzeROI`（ROI 占有度計測）既存テスト済み
- observe-taxi-pool.mjs の try/catch 隔離をモックで確認

### 校正・実画像

ROI 矩形・baseline・max_capacity は実画像で目視確定（plan の校正タスク）。

## スコープ外

- 日報アプリ側の T3 ページ表示（別repo `タクシー日報` の別 spec）
- フライト到着連動の需要予測（人数カウント）
- 正確な台数カウント（YOLO 等）
- Real04（第4待機所・あふれ予備）の常時観測
- Real03（出口動線）の動き計測
- 「今行くべき度」のような需給バランス判定指標（表示フェーズで検討）

## 成功基準

1. **コード**: `scripts/lib/t3-pool-fill.mjs`（純関数）・`data/t3-pool-rois.json`（校正後実値）・`observe-taxi-pool.mjs` の fill 計測ブロック追加が main に commit され、Mac mini の次 tick から `data/t3-pool-fill.json` が生成される
2. **テスト**: 新規純関数テストが pass、既存テストが回帰なし
3. **旧コード撤去**: 旧 slot-occupancy 関連ファイル・テスト・配線が削除され、既存テストが回帰なし、launchd 停止手順を本人に渡す
4. **観測の隔離**: fill 計測が例外を投げても Phase E-1（t3-pool-history.jsonl 追記）・既存 forecast が継続することをモックで確認
5. **校正**: Real108/109 の駐車エリア ROI が目視で駐車スペースを覆い、空/満サンプルで `fillRatio` が 0 付近 / 1 付近に出る
6. **実データ検証**: 校正後、`t3-pool-fill.json` の前方/後方 `fillRatio` が時間帯（深夜＝空きがち、混雑時＝後方満杯）と整合
```
