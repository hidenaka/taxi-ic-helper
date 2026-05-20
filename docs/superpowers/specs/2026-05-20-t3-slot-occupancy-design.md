# T3 乗り場 先頭スロット占有方式 設計書（Phase 1）

> 作成: 2026-05-20
> 対象: taxi-ic-helper / T3（第3ターミナル 第5乗り場）のタクシー出庫計測
> 関連: `2026-05-20-front-slot-occupancy-design.md`（T1/T2 同方式）、
>      `2026-05-20-night-lantern-detection-design.md`（夜間 行灯検出）、
>      `2026-05-16-t3-pool-observation-design.md`（Phase E-1 T3 全体メトリクス収集）

## 目的

羽田 T3 第5乗り場（`Real106.jpg`/`Real107.jpg`）から **1tick あたり何台が客を乗せて発車したか** を計測する観測パイプラインを新設する。出力は **9レーン合計の1数値**。T1/T2 で稼働中の slot-occupancy 方式（マス目の在台数 → 減少を出庫として積算、増加は列移動として無視）を T3 用ファイル群として並行構築する。

## 背景・現状

### 既存T3観測

Phase E-1 (`2026-05-16-t3-pool-observation-design.md`) で `Real106/107/03/04/108/109` の **画像全体メトリクス** のみを `data/t3-pool-history.jsonl` に記録中（schema v1）。ROI 精密校正・占有/台数推定・予測接続は「後フェーズ」のまま未着手。本 spec はそのうち **乗り場本体（Real106/107）の出庫計測** を担う。

### T3 第5乗り場の構造（WEB調査 + 現役乗務員確認）

公益財団法人東京タクシーセンター「第3待機所」が乗り場直前位置。WEB調査（`real-taxidriver.com`「羽田空港第3ターミナルタクシー乗場 入構方法・並び方」）と現役乗務員の確認に基づく:

- **9レーン並列構成**（向かって右から）:

  | レーン | 車種 |
  |---|---|
  | 1 | 神奈川車（2024-02-01から運用一時停止・東京車が代行） |
  | 2〜4 | 一般車・UDタクシー（3列） |
  | 5〜6 | ワゴン車（2列） |
  | 7〜8 | ECD（英語認定）車 ＝「おもてなしレーン」（2列） |
  | 9 | ハイヤー（1列） |

- **出庫の動き**: 「最前列2列がいなくなったら、全体が2列ずつ前進していき、自分が最前列になるまで待つ」
- **現役乗務員確認**: **「出庫の単位は1台ずつ、列移動は2列まとめ」** — 客を乗せての発進は1台ずつ。後続2列が前に詰めるのは集団移動

### T1/T2 との重要な相違点

| 項目 | T1/T2 | T3 |
|---|---|---|
| 並列レーン数 | 4 | 9（車種別） |
| 出庫の単位 | 1台ずつ | 1台ずつ（同じ） |
| 列移動の単位 | 1列ずつ | **2列まとめ前進** |
| 計測粒度 | 乗り場別 stall1〜4 | 全体合計1値（Phase 1） |
| プール構造 | 1段 | 2段（第3＝直前／第4＝供給バッファ） |

## 採用アプローチ

T1/T2 で稼働中の slot-occupancy 方式（`2026-05-20-front-slot-occupancy-design.md`）を T3 に水平展開する:

各乗り場の「**先頭領域**」をスロット格子で定義する。各スロットの在/不在を**画像解析**（昼=エッジ密度／夜=赤色行灯）で判定し、毎 tick **在台数 occ** を数える。在台数の時系列で「**減少**」を出庫として積算する（小さな減少＝出庫。大きな増加＝列移動の補充なので出庫に数えない）。

### なぜ T3 でも同方式が成立するか

- 「客を乗せて発進＝1台ずつ」は T1/T2 と同じ。最前列在台数の **減少** は出庫として正しい
- 「2列まとめ前進」で最前列在台数が **大ジャンプで増加** するイベントは、T1/T2 既存 `computeSlotActuals` の **「増加は出庫に加算しない」** ロジックでそのまま吸収される（差分0以上は無視）
- T3 特有のコード追加は不要。共通純関数（`slotOccupied` / `computeSlotActuals` / `analyzeROI`）の再利用で済む

### 不採用

- **YOLO トラッカーをT3へ拡張** — T1/T2 で密集黒車の検出漏れ問題があり slot-occupancy 方式に置き換えた経緯（`2026-05-20-front-slot-occupancy-design.md` 背景）。T3 も密集環境なので同じ問題が再発する
- **画像全体メトリクスを車両数に変換** — `t3-pool-history.jsonl` の `edge_density` から台数を推定する案は、車両/通行人/通路の区別がつかず精度が出ない。Phase E-1 spec で「後フェーズ」とされた所以
- **ホモグラフィ補正の導入** — T1/T2 の slot-occupancy 系もホモグラフィを使っていない（`slot-occupancy-tick.mjs` は `cx, cy, r` を画像座標の正規化値として直接 ROI に変換）。校正コストを増やしてまで導入する必要なし

## 設計

### 1. マス目格子定義（新ファイル `data/t3-stall-slots.json`）

T3 第5乗り場の **最前列2列ぶん** をマス目格子で覆う。9レーンの並列構造を内部メタ（`lane` / `category` タグ）で持ち、出庫数を集計するときは全マス目を合算する。

スキーマ（T1/T2 と同形・schema_version=1）:

```json
{
  "_meta": {
    "image_size": [800, 600],
    "edge_threshold": 0.08,
    "night_brightness_threshold": 50,
    "night_lantern_ratio": 0.005,
    "note": "T3 第5乗り場 9レーン × 先頭2列の格子。座標は校正フェーズで確定"
  },
  "schema_version": 1,
  "stalls": {
    "t3_stand": {
      "source": "real106",
      "label": "T3 第5乗り場（9レーン合計）",
      "capacity": 18,
      "slots": [
        {"id": "lane1-row1", "cx": 0.00, "cy": 0.00, "r": 0.00, "lane": 1, "category": "kanagawa", "row": 1},
        {"id": "lane1-row2", "cx": 0.00, "cy": 0.00, "r": 0.00, "lane": 1, "category": "kanagawa", "row": 2},
        {"id": "lane2-row1", "cx": 0.00, "cy": 0.00, "r": 0.00, "lane": 2, "category": "general", "row": 1},
        "...（9レーン × 2列 = 18マス）"
      ]
    }
  }
}
```

- `source`: Real106 と Real107 のうち全レーンが見やすい方を **校正フェーズで決定**（暫定 `real106`）
- `slots[].lane`: 9レーンのインデックス（1=神奈川 ... 9=ハイヤー）。将来 Phase 2/3 でレーン別を出したくなったらこのタグで集計し直せる
- `slots[].category`: `kanagawa` / `general` / `wagon` / `ecd` / `hire` のいずれか。同じく将来集計用
- `slots[].row`: 1=最前列、2=その後ろ。`row:2` は「2列まとめ前進」の上段＝出庫直前のバッファ
- `capacity`: 9レーン × 2列 = 18（一般車のレーン2-4を例にしているが、レーン1=神奈川/9=ハイヤーは2列ではなく1列の可能性があり、実画像で確定）
- 座標値 `cx, cy, r` は **校正フェーズの実画像で確定**（spec 時点ではプレースホルダー 0.00）

### 2. 在/不在判定（既存純関数を流用）

T1/T2 で稼働中の `scripts/lib/slot-occupancy.mjs` の純関数群をそのまま使う:

| 純関数 | 用途 |
|---|---|
| `slotOccupied(features, opts)` | 1マスが「車あり」か「空き」か判定。`opts.isNight` で昼/夜分岐（昼=`edge_density >= edgeThreshold`、夜=`lantern_pixel_ratio >= nightLanternRatio`） |
| `analyzeROI(image, roi)` | マスの画素からエッジ密度・黒率・輝度・行灯密度を算出 |
| `isFrameAbnormal(brightness)` | 全面暗黒/全面白飛びの異常フレーム検出 → tick 全体 skip |
| `expandRoiVertical(roi, factor)` | 夜モード時に ROI を縦に拡張（屋根上の行灯位置を含める） |
| `slotRoi(slot, w, h)` | `{cx, cy, r}`（正規化）→ `{x, y, width, height}`（ピクセル）変換 |

T3 固有の判定ロジック追加は **なし**。

### 3. 出庫数の集計（既存純関数を流用）

T1/T2 で稼働中の `scripts/lib/slot-actuals.mjs::computeSlotActuals` を流用する（既存実装は `slot-occupancy-history.jsonl` を読んで15分スロット × `total` を集計済み）。

集計粒度:
- 9レーンの全マス目（18個）を flat に占有判定 → 合計 `occ` を 1tick ごとに記録
- 15分スロット単位で出庫数を集計 → `t3-stall-actuals.json` に書き出し
- **レーン別出力は行わない**（Phase 1 のスコープ外。`slots[].lane` タグは将来用）

T3 固有の挙動:
- 「2列まとめ前進」で `occ` が大きく増加するイベントは `computeSlotActuals` の `Math.max(0, diff)` パターン（増加=列移動として無視）でそのまま吸収
- 「大きな減少」（例: `occ` が 18→0）は18台ぶんの出庫として加算される。これは「最前列2列が全部客を乗せて発進」のレアケースを正しく捉える

### 4. 出力ファイル（新規・T3 専用）

#### `data/t3-slot-occupancy-history.jsonl`（観測ログ・append-only）

各 tick で18マスの在/不在と合計在台数を JSON Lines で1行追記。

```json
{
  "schema_version": 1,
  "ts": "2026-05-20T20:18:07+09:00",
  "tick_seq": 1234,
  "t3_stand": {
    "source": "real106",
    "is_night": false,
    "occupancy": {
      "total": 14,
      "row1": 7,
      "row2": 7
    },
    "slots": [
      {"id": "lane1-row1", "occupied": true, "edge_density": 0.13, "lantern_pixel_ratio": null},
      {"id": "lane1-row2", "occupied": false, "edge_density": 0.04, "lantern_pixel_ratio": null},
      "...（18マス）"
    ]
  }
}
```

`is_night` / `lantern_pixel_ratio` は夜モード（行灯検出）で `slotOccupied` に渡す入力。T1/T2 と同じスキーマ形。

#### `data/t3-stall-actuals.json`（15分集計・上書き）

直近2時間ぶんを15分スロットに集計した出庫数。Phase 3 で日報アプリの到着便ページがこの形式を読む想定。

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-20T20:30:00+09:00",
  "slots": [
    {"slotStart": "2026-05-20T18:30:00+09:00", "slotEnd": "2026-05-20T18:45:00+09:00", "total": 23},
    {"slotStart": "2026-05-20T18:45:00+09:00", "slotEnd": "2026-05-20T19:00:00+09:00", "total": 19},
    "...（8スロット = 2時間）"
  ]
}
```

Phase 1 は **`total` 1列のみ**。Phase 3 でレーン別が必要になれば `lane1..lane9` 列を追加する（`t3-slot-occupancy-history.jsonl` の `slots[].lane` タグから集計し直せる）。

### 5. 観測 tick への組込み（共通ファイル最小編集）

`scripts/observe-taxi-pool.mjs` の既存処理の後に、try/catch で隔離した1ブロックを追加:

```javascript
// 既存処理: T1/T2 slot-occupancy → slot-occupancy-history.jsonl 追記
// 既存処理: stall-actuals.json 書き出し
// 既存処理: forecast / pattern-match / ensemble （不変）

// 新規ブロック（T3 slot-occupancy）
try {
  await runT3SlotOccupancyTick({
    tickSeq, ts,
    cfgPath: './scripts/lib/t3-stall-slots.json',
    historyPath: './data/t3-slot-occupancy-history.jsonl',
    actualsPath: './data/t3-stall-actuals.json',
  });
} catch (e) {
  console.error(`[t3-slot] failed, skip: ${e.message}`);
}
```

`runT3SlotOccupancyTick` は新ファイル `scripts/t3-slot-occupancy-tick.mjs` に実装。中身は既存 `slot-occupancy-tick.mjs` をベースに以下を変更:

| 変更点 | 内容 |
|---|---|
| 設定ファイル | `t3-stall-slots.json` |
| 観測カメラ | `real106` / `real107`（`stall-slots.json` の `source` で指定） |
| 出力先 | `t3-slot-occupancy-history.jsonl` |
| 集計関数 | T1/T2 と同じ `computeSlotActuals` を流用、ただし出力は `total` のみ |

**失敗時の挙動**: try/catch で握り、既存 T1/T2 観測・既存 forecast パイプラインは継続。`t3-pool-history.jsonl`（Phase E-1）も別 try/catch ブロックなので相互に独立。

### 6. Mac mini 側の配線（`observe-tick-local.sh` と `.gitattributes`）

- `observe-tick-local.sh`: `git add` 対象に `data/t3-slot-occupancy-history.jsonl` と `data/t3-stall-actuals.json` を追加
- `.gitattributes`: `data/t3-slot-occupancy-history.jsonl merge=union` を追加（append-only 衝突回避、T1/T2 の `slot-occupancy-history.jsonl` と同じ扱い）
- `data/t3-stall-actuals.json` は再生成系なので pull 前 `git checkout HEAD --` の対象に含める（T1/T2 の `stall-actuals.json` と同じ扱い）

### 7. 校正フェーズ

校正は2段階。ホモグラフィ基準4点の指定は不要（slot-occupancy 方式のため）:

| ステップ | 内容 |
|---|---|
| 1. サンプル取得 | Mac mini の observe-tick が次に回るときに Real106/107 の現在画像を `data/calibration/t3/YYYY-MM-DDTHH-MM/real106.jpg` 形式で保存。観測スクリプトに「校正モード」フラグを追加するか、別スクリプト `scripts/snapshot-t3-cameras.mjs` で対応 |
| 2. マス目配置 | 取得画像を見て、9レーン × 2列 = 18マスの `cx, cy, r` を `t3-stall-slots.json` に直接書き込む。校正支援スクリプト `scripts/calibrate-t3-slots.mjs`（新設）が画像上にマスをオーバーレイした注釈画像を出力し、ズレを目視確認しながら調整 |

校正スクリプトは既存 `calibrate-slots.mjs` を T3 用引数で起動できるように汎用化するか、T3 専用の薄いラッパーを作る（plan 段階で詰める）。

実際の `source`（Real106 vs Real107）の選定もこの校正フェーズで実施。両方の画像を並べて「9レーンが全部見える方」を採用。

## データフロー

```
Real106.jpg / Real107.jpg
    │
    ├─ avg brightness 計算
    │   ├─ avg < 5 or > 235 → ABN skip
    │   ├─ avg < 50 → 夜モード（行灯検出）
    │   └─ avg >= 50 → 昼モード（エッジ密度）
    │
    └─ 18マス × analyzeROI → slotOccupied で在/不在判定
                                 │
                                 ↓
                          occ.total を 1tick ごとに
                          t3-slot-occupancy-history.jsonl に追記
                                 │
                                 ↓
                          computeSlotActuals で 15分スロット集計
                                 │
                                 ↓
                          t3-stall-actuals.json に書き出し（上書き）
```

## テスト方針（TDD）

純関数中心。実画像は校正フェーズの目視で担保。

### 既存純関数の流用（テスト追加ゼロでもOK）

| 関数 | 流用箇所 |
|---|---|
| `slotOccupied(features, opts)` | 既存テスト（昼/夜境界）でカバー済み |
| `computeSlotActuals(history, windowMin)` | 既存テスト（減少=出庫／増加=列移動）でカバー済み |
| `analyzeROI(image, roi)` | 既存テスト（エッジ密度・赤行灯）でカバー済み |
| `isFrameAbnormal`, `expandRoiVertical`, `slotRoi` | 既存テスト済み |

### T3 固有で新規追加するテスト

| 純関数 / モジュール | テスト内容 |
|---|---|
| `t3-stall-slots.json` パース | schema_version=1 を読める、`stalls.t3_stand.slots[*]` に `lane`/`category`/`row` タグが乗る |
| `summarizeT3Occupancy(slots)` | 18マスの occupied 配列 → `{total, row1, row2}` 集計（純関数） |
| T3 用 actuals 書き出し純関数 | `t3-slot-occupancy-history.jsonl` の直近2時間ぶんから 8スロット × `total` を生成 |
| `observe-taxi-pool.mjs` の try/catch 挙動 | T3 ブロックが例外を投げても既存 T1/T2 観測・forecast が継続（モックで検証） |

校正・実画像チューニングは TDD 対象外。Mac mini で蓄積後に目視で18マスの位置を調整。

## スコープ外（後 spec で扱う）

- **Phase 2**: 待機所プール — Real04 マス目（グリッド駐車場）/ Real03/108/109 占有率
- **Phase 3**: 予測パイプライン接続 — `computeForecast` に T3 トラッカーアンカー経路を追加 / 日報アプリの到着便ページに T3 グラフ
- レーン別の出庫数（`lane1..lane9`）出力
- 車種別（一般/ワゴン/ECD/ハイヤー/神奈川）の出庫グルーピング
- Real106 vs Real107 の同時併用（最初は1台のみ。校正で良いほうを選ぶ）
- T3 への入庫検出（マス目方式は出庫専用。入庫はプール後方で発生し別問題）
- ホモグラフィ補正の導入
- 校正素材取得スクリプトと校正スクリプトの実装詳細（plan 段階で詰める）

## 既存T1/T2への影響

ゼロ。すべての T3 用ファイルは `t3-` プレフィックスで新設し、既存 `slot-occupancy-tick.mjs` / `stall-rois.json` / `stall-slots.json` は触らない。共通の `observe-taxi-pool.mjs` には try/catch で隔離した T3 tick 呼び出しを1ブロック追加するのみ。失敗時は既存 T1/T2 観測・既存 forecast パイプラインは継続。

## 成功基準

1. **コード**: `scripts/t3-slot-occupancy-tick.mjs`・`scripts/lib/t3-stall-slots.json`（spec時点ではテンプレートのみ、座標は校正後確定）・`observe-taxi-pool.mjs` の T3 ブロック追加が main に commit され、Mac mini の次 tick から `data/t3-slot-occupancy-history.jsonl` への追記が走る
2. **テスト**: 新規追加した純関数（`summarizeT3Occupancy` ほか）の `node:test` が pass、既存 469+テストが回帰なし
3. **観測の隔離**: T3 ブロックが例外を投げても `taxi-pool-history.jsonl` 追記・既存 forecast が継続することをモックテストで確認
4. **校正**: Mac mini で取得した実画像で18マスの位置が「目視で 9レーン × 2列の先頭領域に重なる」ことを `calibrate-t3-slots.mjs` の注釈画像で確認
5. **実データ検証**: 校正後 1日（24時間）の `t3-stall-actuals.json` で、`total` が「観測時間帯の総出庫数の感覚値」と整合（数十〜数百台/時のオーダー、深夜は減少）
