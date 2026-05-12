# 乗り場別観測 (schema v3) 設計

- 日付: 2026-05-12
- 対象: 乗務地図関係 / `scripts/observe-taxi-pool.mjs` 周辺
- フェーズ: Phase A (観測) のスキーマ拡張、schema v2 の延長
- 親プロジェクト: `docs/superpowers/specs/2026-05-11-observation-schema-v2-design.md`

## 背景

schema v2 で ROI 切り出し + Sobel エッジ密度 + 時間窓予測 (`arrivals_window`) を導入したが、画像全体の指標では「**どの乗り場 (=どのターミナル) で乗客が発生したか**」を識別できない。

ttc.taxi-inf.jp が公開する東京タクシーセンター運営のルール (`https://robert-johniro.website/domestic/`) と現場ユーザーの説明から、画像内に **4 つの乗り場が縦に並ぶ** 構造が判明:

- **第1乗り場** (JAL 2 番ポール、T1 向け): Real01_line.jpg の最右端列の上から 8 台分
- **第2乗り場** (JAL 18 番ポール、T1 向け): 続く 7 台分
- **第3乗り場** (ANA 3 番ポール、T2 向け): 続く 8 台分
- **第4乗り場** (ANA 19 番ポール、T2 向け): Real02.jpg 右上 8 台分

「画像最右端の縦列が観測対象」(= 各乗り場の先頭から並ぶ列)。乗り場ごとに独立した列があり、ショットガンシステム (2025-03-03〜) で「先頭から 1〜2 台が乗り場に呼ばれて消える」イベントが離散的に発生する。

## ゴール

- 4 つの乗り場別に独立した状態 (`occupied_estimate`、`black_ratio`、`edge_density`) を 5 分間隔で記録
- 5 分前との差分 (`diff_occupied_from_prev`) を負の値で出庫イベントとして検出可能にする
- T1 (第1+第2) / T2 (第3+第4) ターミナル別の出庫頻度集計の基礎データを揃える
- Real02 の神奈川車混在エリアは観測対象外であることを明示 (`img2.analysis_disabled: true`)
- 取得頻度を 15 分 → 5 分に上げてイベントの取りこぼしを減らす

## 非ゴール

- ROI の自動学習 (背景差分・カメラキャリブレーション)
- Phase B 分析 (本 spec は観測スキーマの追加のみ)
- フロント (`arrivals.html`) への乗り場別表示
- Real02 の神奈川車エリアの分析
- 入庫 / 出庫の連続追跡 (5 分間隔では net 値のみ取得、入退別個カウント不能)
- 個別車両の追跡 (license plate 認識等)

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| launchd ジョブ (`scripts/observe-tick-local.sh`) | 不変 (StartInterval だけ install スクリプトで変更) |
| 既存 v1 / v2 jsonl 行 | 不変 (schema_version で識別) |
| `arrivals.html` / フロント | 不変 |
| `data/arrivals.json` の生成 (`fetch-arrivals.mjs`) | 不変 |
| `analyzePoolImage` の戻り値 (sha256, size_bytes, black_ratio, diff_from_prev, roi) | 不変 (新フィールドは別関数経由) |

### 変更・新規ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/install-observe-launchd.sh` | Modify | `StartInterval: 900` → `300` (5 分間隔) |
| `scripts/lib/stall-rois.json` | Create | 4 乗り場の帯状 ROI 座標 |
| `scripts/lib/image-pool-analyzer.mjs` | Modify | `analyzeStalls(jimpImagesByName, stallRois, prevStalls)` 純粋関数を追加 |
| `scripts/observe-taxi-pool.mjs` | Modify | `stall-rois.json` を読み、`schema_version: 3` で `stalls` を追加 |
| `tests/image-pool-analyzer.test.mjs` | Modify | `analyzeStalls` の単体テスト 4 件追加 |
| `docs/research/taxi-pool-observation.md` | Modify | スキーマ履歴 + 乗り場別分析手順を追記 |

## スキーマ v3

### 1 行 jsonl サンプル

```json
{
  "schema_version": 3,
  "ts": "2026-05-12T16:41:00+09:00",
  "tick_seq": 130,
  "img1": {
    "name": "Real01_line",
    "sha256": "...",
    "size_bytes": 89911,
    "black_ratio": 0.10,
    "diff_from_prev": 0.01,
    "roi": {
      "edge_density": 0.4,
      "roi_black_ratio": 0.12,
      "luminance_mean": 105.3,
      "luminance_std": 53.4,
      "diff_edge_from_prev": 0.02
    }
  },
  "img2": {
    "name": "Real02",
    "sha256": "...",
    "size_bytes": 87760,
    "black_ratio": 0.21,
    "diff_from_prev": 0.02,
    "roi": { "...": "..." },
    "analysis_disabled": true
  },
  "stalls": {
    "stall1": {
      "source": "img1",
      "capacity": 8,
      "label": "第1乗り場 (JAL 2番ポール T1)",
      "occupied_estimate": 7,
      "black_ratio": 0.78,
      "edge_density": 0.42,
      "luminance_mean": 102.5,
      "diff_occupied_from_prev": -1
    },
    "stall2": {
      "source": "img1",
      "capacity": 7,
      "label": "第2乗り場 (JAL 18番ポール T1)",
      "occupied_estimate": 6,
      "black_ratio": 0.71,
      "edge_density": 0.38,
      "luminance_mean": 110.2,
      "diff_occupied_from_prev": 0
    },
    "stall3": {
      "source": "img1",
      "capacity": 8,
      "label": "第3乗り場 (ANA 3番ポール T2)",
      "occupied_estimate": 5,
      "black_ratio": 0.54,
      "edge_density": 0.31,
      "luminance_mean": 115.0,
      "diff_occupied_from_prev": -2
    },
    "stall4": {
      "source": "img2",
      "capacity": 8,
      "label": "第4乗り場 (ANA 19番ポール T2)",
      "occupied_estimate": 8,
      "black_ratio": 0.83,
      "edge_density": 0.45,
      "luminance_mean": 98.7,
      "diff_occupied_from_prev": 1
    }
  },
  "arrivals_state": { "...": "..." },
  "arrivals_window": { "...": "..." },
  "weather": { "code": 0, "lightning_active": false }
}
```

旧 v1/v2 フィールド (`img.black_ratio` / `arrivals_state.total_estimated_taxi_pax` 等) は **互換性のため保持**。新フィールドは:

- `schema_version: 3`
- `img2.analysis_disabled: true` (Real02 が分析対象外であることを明示)
- `stalls.stall1` 〜 `stalls.stall4` (4 乗り場別データ)

### 各フィールドの意味

- `stalls.stallN.source`: `"img1"` (Real01_line 由来) または `"img2"` (Real02 由来)
- `stalls.stallN.capacity`: 仕様上の収容台数 (stall1=8, stall2=7, stall3=8, stall4=8)
- `stalls.stallN.label`: 人間可読の乗り場名
- `stalls.stallN.occupied_estimate`: 推定占有台数 (`Math.round(black_ratio / NORMALIZATION * capacity)`、0〜capacity でクリップ)
- `stalls.stallN.black_ratio`: ROI 内の黒色比率 (タクシー充足度)
- `stalls.stallN.edge_density`: ROI 内の Sobel エッジ密度 (照度ロバスト)
- `stalls.stallN.luminance_mean`: ROI 内のグレースケール輝度平均 (時間帯判定用)
- `stalls.stallN.diff_occupied_from_prev`: 前 tick (5 分前) との `occupied_estimate` の差 (負=出庫優位、正=入庫優位、null=前 tick が v2 以前)

## ROI 仕様

### `scripts/lib/stall-rois.json`

```json
{
  "_meta": {
    "source": "ttc.taxi-inf.jp の Real01_line.jpg / Real02.jpg を 2026-05-12 時点で手動切り出し。ユーザー指示: 画像最右端の縦列が観測対象、Real01 で上から 8/7/8 台分が第1/2/3乗り場、Real02 右上 8 台が第4乗り場",
    "image_size": [800, 600],
    "calibration_note": "1 台あたり画像内縦約 21px (Real01 内、駐車場領域 500px / 23 台)。カメラ斜め撮影なので奥は小さく、手前は大きく見える可能性あり、実装時に微調整"
  },
  "stalls": {
    "stall1": {
      "source": "real01_line",
      "capacity": 8,
      "label": "第1乗り場 (JAL 2番ポール T1)",
      "roi": { "x": 600, "y": 80, "width": 200, "height": 170 }
    },
    "stall2": {
      "source": "real01_line",
      "capacity": 7,
      "label": "第2乗り場 (JAL 18番ポール T1)",
      "roi": { "x": 600, "y": 250, "width": 200, "height": 150 }
    },
    "stall3": {
      "source": "real01_line",
      "capacity": 8,
      "label": "第3乗り場 (ANA 3番ポール T2)",
      "roi": { "x": 600, "y": 400, "width": 200, "height": 180 }
    },
    "stall4": {
      "source": "real02",
      "capacity": 8,
      "label": "第4乗り場 (ANA 19番ポール T2)",
      "roi": { "x": 400, "y": 0, "width": 400, "height": 250 }
    }
  }
}
```

座標は暫定。実装時に実画像からの crop 結果を目視確認して微調整する。

### `occupied_estimate` の計算

```javascript
const NORMALIZATION = 0.4; // ROI 満杯時の経験則 black_ratio
const raw = black_ratio / NORMALIZATION * capacity;
const occupied_estimate = Math.max(0, Math.min(capacity, Math.round(raw)));
```

- `black_ratio = 0.4` → `capacity` (満杯)
- `black_ratio = 0.2` → `capacity / 2`
- `black_ratio = 0.05` → 約 1 (ガラガラ)

NORMALIZATION は Phase B でデータが揃ったら統計的に再校正する暫定値。

## analyzeStalls 関数

### シグネチャ

```javascript
/**
 * 各乗り場の帯状 ROI を解析して状態を返す純粋関数。
 *
 * @param {{real01_line: Jimp, real02: Jimp}} jimpImagesByName - Jimp で読んだ画像群
 * @param {Object} stallRois - stall-rois.json の中身
 * @param {Object|null} prevStalls - 前 tick の stalls オブジェクト (v3 以前の tick なら null)
 * @returns {{stall1, stall2, stall3, stall4}}
 */
export async function analyzeStalls(jimpImagesByName, stallRois, prevStalls = null)
```

### 動作

各 stallN について:

1. `stallRois.stalls.stallN.source` で画像を選択 (`real01_line` または `real02`)
2. ROI を `clipRoi` で画像範囲にクリップ
3. crop → ROI 内のピクセルで `black_ratio` / `edge_density` / `luminance_mean` を計算 (既存 `analyzeROI` と同じロジック)
4. `occupied_estimate` を上記式で算出
5. `prevStalls?.stallN?.occupied_estimate` があれば `diff_occupied_from_prev = current - prev`、なければ null

純粋関数 (Jimp の I/O 以外副作用なし)。

## データフロー

```
[launchd 5min cron]
  └→ observe-tick-local.sh
       └→ scripts/observe-taxi-pool.mjs
            1. ttc.taxi-inf.jp から 2 画像取得
            2. stall-rois.json 読み込み
            3. Jimp.read(buf1) / Jimp.read(buf2) で画像オブジェクト化
            4. analyzePoolImage(buf1, prev1, roi1) で既存 v2 解析 (img1.roi)
            5. analyzePoolImage(buf2, prev2, roi2) で既存 v2 解析 (img2.roi)
            6. analyzeStalls({real01_line, real02}, stallRois, prev.stalls) で 4 乗り場別解析
            7. summarizeArrivalsWindow + weather 取得
            8. schema_version: 3 で jsonl に append
```

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `stall-rois.json` 読み込み失敗 | `stalls: null` で jsonl 追記、schema_version は 3 のまま |
| stall ROI 座標が画像範囲外 | 既存の `clipRoi` で自動クリップ、warn ログ |
| Real02 が取得失敗 | stall4 だけ null、stall1-3 は正常 |
| 前 tick が v2 以前 (stalls なし) | 全 stall で `diff_occupied_from_prev: null` |
| `analyzeStalls` 例外 | try/catch で stalls=null、jsonl は schema_version=3 で書く |
| 5 分間隔で race condition (Mac mini と MacBook 両方稼働) | MacBook 側は uninstall 済み前提、稀発生時は既存 reset-hard リトライで吸収 |

## テスト計画

### `tests/image-pool-analyzer.test.mjs` への追加 (4 件)

1. 全黒の stall ROI → `occupied_estimate === capacity`、`black_ratio > 0.95`
2. 全白の stall ROI → `occupied_estimate === 0`、`black_ratio < 0.05`
3. prev に同じ画像を渡す → `diff_occupied_from_prev === 0`
4. prev が null → `diff_occupied_from_prev === null`

### 既存テスト

`npm test` は 306 件パスを維持。`analyzePoolImage` の戻り値スキーマは変えないので既存テストは不変。

### Phase A 検証ステップ (実装直後 24 時間)

Mac mini 反映後に以下を確認:

```bash
# v3 行が増えているか
jq -r '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c
# 期待: v1=121, v2=数十, v3=200+ (5 分間隔 × 24h = 288 が理想)

# stall ごとの occupied_estimate 分布
jq -r 'select(.schema_version==3) | "\(.ts) \(.stalls.stall1.occupied_estimate) \(.stalls.stall2.occupied_estimate) \(.stalls.stall3.occupied_estimate) \(.stalls.stall4.occupied_estimate)"' data/taxi-pool-history.jsonl | head -30
# 期待: 各 stall で 0-capacity の範囲で時間帯ごとに変動

# 出庫検出 (diff が負の tick)
jq -r 'select(.schema_version==3 and .stalls.stall1.diff_occupied_from_prev < 0) | "\(.ts) stall1: \(.stalls.stall1.diff_occupied_from_prev)"' data/taxi-pool-history.jsonl | head -20
```

### ROI 座標のキャリブレーション (実装直後の手動目視)

実装後すぐに、jimp で実画像から各 stall ROI を crop して別 jpg として保存し:

```bash
node -e '
import { Jimp } from "jimp";
import { readFileSync } from "node:fs";
const rois = JSON.parse(readFileSync("./scripts/lib/stall-rois.json"));
const img1 = await Jimp.read("/tmp/ttc-real01.jpg");
const img2 = await Jimp.read("/tmp/ttc-real02.jpg");
for (const [name, def] of Object.entries(rois.stalls)) {
  const src = def.source === "real01_line" ? img1 : img2;
  const r = def.roi;
  const cropped = src.clone().crop({ x: r.x, y: r.y, w: r.width, h: r.height });
  await cropped.write(`/tmp/stall-${name}.jpg`);
}
'
```

生成された `/tmp/stall-stall1.jpg` 〜 `stall4.jpg` を目視確認:
- stall1.jpg = 第1乗り場の縦 8 台分が映っているか
- stall2.jpg = 第2乗り場の縦 7 台分か
- stall3.jpg = 第3乗り場の縦 8 台分か
- stall4.jpg = 第4乗り場の横 8 台分 (Real02 右上) か

ズレていれば `stall-rois.json` の x/y/width/height を微調整し、再 crop。これを実装プランの最終 Task に含める。

## メンテナンス運用

- ROI 座標はカメラアングル変更で陳腐化する。90 日履歴で `occupied_estimate` の異常変動を検出したら再校正
- `NORMALIZATION = 0.4` は経験則。Phase B で「実際に満杯の tick」の `black_ratio` 統計を取って中央値で再校正
- 5 分間隔 cron は cron-job.org の設定変更も不要 (launchd だけが観測ジョブを持つ)

## リスクと対応

| リスク | 確度 | 影響 | 対応 |
|---|---|---|---|
| ROI 座標が画像と合っていない | 中 | occupied_estimate がノイズ化 | 実装後の手動目視で確定、Phase B で再校正 |
| NORMALIZATION=0.4 が経験則すぎる | 中 | 満杯/空が極端な値に偏る | Phase B でデータ蓄積後に統計的に再校正 |
| カメラアングル変更で ROI 陳腐化 | 低 | stall データがリセット | 90 日履歴で検出、stall-rois を更新 |
| 5 分間隔で race condition (Mac mini と MacBook 両方稼働) | 低 | jsonl conflict | MacBook の launchd は uninstall 済みなら問題なし |
| 5 分間に複数台出入り発生 | 中 | net 値しか取れない | Phase B で time-of-day prior と組み合わせて補正、または observe 頻度を 2-3 分に上げる選択肢を残す |

## ロールバック

問題発生時の戻し方:

```bash
# 1. observe-taxi-pool.mjs を v2 版に戻す
git revert <feat commit hash>

# 2. stall-rois.json と analyzeStalls を削除
git rm scripts/lib/stall-rois.json

# 3. launchd の StartInterval を 900 に戻す
# install-observe-launchd.sh の修正を revert + Mac mini で uninstall && install
```

jsonl の schema_version=3 行は残るが、Phase B 分析時に `schema_version` フィルタで識別できるので問題なし。

## 完了条件

- [ ] `npm test` 全件パス (現在 306 + 4 = 310 件以上)
- [ ] `scripts/lib/stall-rois.json` が valid JSON
- [ ] ROI 切り出し画像 (stall1〜stall4.jpg) を手動目視確認、ズレていなければ OK
- [ ] Mac mini で 5 分間隔の run-once が成功し、schema_version=3 の jsonl 行が出る
- [ ] 24 時間経過後に v3 行が 200 件以上、各 stall の `occupied_estimate` が時間帯依存に変動する

## Phase B への引き継ぎ

Phase A v3 検証が満たされたら、Phase B 分析セッションで以下を実施:

```python
import pandas as pd
df = pd.read_json('data/taxi-pool-history.jsonl', lines=True)
v3 = df[df['schema_version'] == 3].copy()

# 乗り場別の時系列
v3['stall1_occ'] = v3['stalls'].apply(lambda x: x['stall1']['occupied_estimate'])
v3['stall1_diff'] = v3['stalls'].apply(lambda x: x['stall1']['diff_occupied_from_prev'])
# stall2/3/4 同様

# T1 / T2 の集計
v3['T1_occupied'] = v3['stall1_occ'] + v3['stall2_occ']
v3['T2_occupied'] = v3['stall3_occ'] + v3['stall4_occ']

# 出庫イベント (diff < 0) のヒートマップ
v3['hour'] = v3['ts'].dt.hour
hourly = v3.groupby('hour').agg(
    stall1_outflow=('stall1_diff', lambda s: -s[s < 0].sum()),
    stall2_outflow=('stall2_diff', lambda s: -s[s < 0].sum()),
    stall3_outflow=('stall3_diff', lambda s: -s[s < 0].sum()),
    stall4_outflow=('stall4_diff', lambda s: -s[s < 0].sum())
)
```

仮説:
- **H6**: T1 (stall1+2) の出庫量と arrivals_window の JAL 便由来 estimated_taxi_pax_sum が相関
- **H7**: T2 (stall3+4) の出庫量と arrivals_window の ANA 便由来が相関
- **H8**: stall 別の動きから「便 → 乗り場 → 出庫」のラグ時間を推定

Phase B で H6-H8 を検証し、係数再校正のターゲット (load-factors / transit-share) を Phase C spec として起こす。
