# 夜時間帯 行灯検出 設計書

> 作成: 2026-05-20
> 対象: taxi-ic-helper の slot-occupancy 観測（`scripts/slot-occupancy-tick.mjs`）

## 目的

夜時間帯（画像全体の平均輝度 < 50）に、現行の edge_density ベース slot 占有判定を
「行灯（屋根上の赤色点光源）検出」に切り替えて、夜の精度低下を改善する。

## 背景・問題

実画像確認で判明:

- 昼時間帯（avg brightness 100-150）の精度: stall1/2/4 で **~98%**、stall3 後列のみ問題
- 夜時間帯（avg brightness 27、19時以降）の精度: **50-70% に低下**
  - 18:00:07 で stall1 観測 14/14 ✓
  - 19:01:43 で stall1 観測 **9**/14、真値 14 → 精度 64%
- 原因: 夜は車本体が暗くて Sobel エッジが弱く edge_density が低下、固定 threshold（0.08/0.14）では「空き」誤判定が多発

タクシーは夜でも **屋根上の行灯（空車表示）** が赤く光っている。
行灯を点光源として検出すれば 夜の空車待機タクシー数を直接得られる。

## 採用アプローチ

### スコープ

- **夜時間帯限定の補助検出**: 画像全体の avg brightness < 50 のときだけ「行灯検出」を発動
- 昼時間帯（brightness >= 50）は **現行ロジック（edge_density）を不変** で維持
- スコープ外: 昼の行灯検出、 載客中タクシー（行灯消灯）の別カウント、 hue/saturation の高度な色判定

### ROI 戦略

各 slot の ROI を **縦に拡張**（既存中心 cx/cy はそのまま、高さ r×2 → r×4）して、
屋根上の行灯位置まで含める。x 方向は r×2 のまま。

- 校正ゼロ（既存 stall-slots.json の slot 中心を流用）
- 即試作可能
- 拡張で隣接 slot と縦方向が重なる懸念はあるが、行灯は車1台に1個なので
  「同じ行灯を上下2つの slot が検出」しても誤計上は起きにくい
  （隣接 slot の「上」と「下」の行灯はカメラ視点で別位置）

### 判定ロジック

```
夜モード (brightness < NIGHT_BRIGHTNESS_THRESHOLD = 50):
  ROI 拡張: width = r*2, height = r*4 (cy を中心に上下対称に拡張)
  pixel ごとに「赤色高輝度」判定:
    isRedLantern(R, G, B) = (R > 180) && (G < 120) && (B < 120)
  lantern_density = redLanternCount / totalPixels
  slot_occupied = lantern_density >= NIGHT_LANTERN_RATIO (= 0.005 = 0.5%)

昼モード (brightness >= 50):
  従来通り edge_density >= edge_threshold (stall別の 0.08 or 0.14)
```

### 採用しなかった代替案

- **24時間ハイブリッド (edge AND/OR lantern)**: 昼の edge_density は既に十分動いているので
  夜限定で十分。データ量2倍・誤検出リスク増のデメリットが上回る
- **行灯専用 ROI を別途校正**: 全 stall × 全 slot = 約50箇所の手動校正が必要。
  既存 ROI 縦拡張で校正ゼロで開始できる
- **HSV 色空間で hue/saturation 判定**: 変換コスト分の重さに見合わない。
  RGB 絶対値で行灯（R高・G/B低）は十分識別可能

## 設計詳細

### 1. analyzeROI の拡張

`scripts/lib/image-pool-analyzer.mjs` の `analyzeROI` 戻り値に
**`lantern_pixel_ratio`** を追加する:

```javascript
return {
  edge_density,
  roi_black_ratio,
  luminance_mean,
  luminance_std,
  lantern_pixel_ratio, // 新規: 赤色高輝度 pixel の比率 (0.0-1.0)
};
```

`lantern_pixel_ratio` の計算ロジック:

```javascript
let redLanternCount = 0;
for (let i = 0; i < total; i++) {
  const idx = i * 4;
  const r = roiData[idx], g = roiData[idx + 1], b = roiData[idx + 2];
  if (r > 180 && g < 120 && b < 120) redLanternCount++;
}
const lantern_pixel_ratio = redLanternCount / total;
```

定数は `slot-occupancy.mjs` に集約（マジックナンバー回避）:

```javascript
export const LANTERN_R_MIN = 180;
export const LANTERN_GB_MAX = 120;
```

### 2. slotOccupied の dispatch 化

`scripts/lib/slot-occupancy.mjs` の `slotOccupied` を以下に変更:

```javascript
// 既存シグネチャ (互換維持のため両方残す or 移行する)
// slotOccupied(features, edgeThreshold)
//   ↓
// slotOccupied(features, opts)
//   opts = { edgeThreshold, isNight, nightLanternRatio }

export function slotOccupied(features, opts = {}) {
  if (!features) return false;
  if (opts.isNight) {
    if (typeof features.lantern_pixel_ratio !== 'number') return false;
    return features.lantern_pixel_ratio >= (opts.nightLanternRatio ?? DEFAULT_NIGHT_LANTERN_RATIO);
  }
  if (typeof features.edge_density !== 'number') return false;
  return features.edge_density >= (opts.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD);
}

export const DEFAULT_NIGHT_LANTERN_RATIO = 0.005;
export const NIGHT_BRIGHTNESS_THRESHOLD = 50;
```

互換性: 既存テスト（数値を直接渡している箇所）は破壊する。
すべての呼び出し元を `opts` 形式に移行する。

### 3. slot-occupancy-tick.mjs の変更

`scripts/slot-occupancy-tick.mjs` で:

1. 画像 brightness を計算（既存の `isFrameAbnormal` 用ロジックを再利用 / 関数化）
2. 各カメラに対し `isNight = brightness < NIGHT_BRIGHTNESS_THRESHOLD` を判定
3. 夜なら slot ROI の **height** を拡張 (`height = roundedR * 4`、 `y` も上にオフセット)
4. `slotOccupied(feat, { edgeThreshold: stallThreshold, isNight, nightLanternRatio })` で判定

擬似コード:

```javascript
for (const cam of Object.keys(cameras)) {
  const img = cameras[cam];
  const avgBr = avgBrightness(img);
  if (isFrameAbnormal(avgBr)) { skip tick; continue; }
  cameraIsNight[cam] = avgBr < NIGHT_BRIGHTNESS_THRESHOLD;
}

for (const name of STALLS) {
  const st = cfg.stalls[name];
  const img = cameras[st.source];
  const stallThreshold = st.edge_threshold ?? globalThreshold;
  const isNight = cameraIsNight[st.source];
  for (const slot of st.slots) {
    const roi = isNight
      ? expandRoiVertical(slotRoi(slot, W, H), 2)  // 縦×2倍
      : slotRoi(slot, W, H);
    const feat = await analyzeROI(img, roi);
    occupiedById[slot.id] = slotOccupied(feat, {
      edgeThreshold: stallThreshold,
      isNight,
      nightLanternRatio: cfg._meta?.night_lantern_ratio,
    });
  }
}
```

`expandRoiVertical(roi, factor)`: y を上に `roi.height * (factor - 1) / 2` だけずらし、
height を `roi.height * factor` にする純関数。画像範囲外はクリップ。

### 4. stall-slots.json への設定追加

`_meta` に閾値を追加:

```json
{
  "_meta": {
    "image_size": [800, 600],
    "edge_threshold": 0.08,
    "night_brightness_threshold": 50,
    "night_lantern_ratio": 0.005,
    "note": "..."
  }
}
```

既存の `edge_threshold` と同様、 stall 別の `night_lantern_ratio` を持たせる拡張も
可能だが、 初期は global 値のみ。校正後に必要なら stall 別に分岐。

## データフロー

```
カメラ画像 (1tick) ─┬─ avg brightness 計算
                    │   ├─ avg < 5 or > 235 → ABN skip
                    │   ├─ avg < 50 → 夜モード
                    │   └─ avg >= 50 → 昼モード
                    │
                    └─ stall ごとに slot ROI を analyzeROI
                       ├─ 昼: edge_density で slotOccupied
                       └─ 夜: ROI 縦拡張 + lantern_pixel_ratio で slotOccupied
                    ↓
                slot-occupancy-history.jsonl に occ 値を追記
                    ↓
                computeSlotActuals が差分(出庫)を算出（変更なし）
                    ↓
                stall-actuals.json (変更なし)
```

## テスト方針

TDD で純関数中心。

### 純関数テスト（追加）

- `slotOccupied(features, { isNight: true, nightLanternRatio: 0.005 })` の境界テスト
  - `lantern_pixel_ratio: 0.005` → true
  - `lantern_pixel_ratio: 0.004` → false
  - `lantern_pixel_ratio` 欠落 → false
- `slotOccupied(features, { isNight: false, edgeThreshold: 0.08 })` で既存テストが通る
- `expandRoiVertical(roi, 2)` の境界テスト
  - 通常: `{x:100, y:100, width:20, height:20}` → `{x:100, y:90, width:20, height:40}`
  - 画像上端クリップ: y が 0 未満なら 0 に
  - 画像下端クリップ: y+height が画像高超なら height を縮める

### 統合テスト

- 既存の夜画像（19:01:43, brightness=26.9）を fixture として保存
- 夜モードで `lantern_pixel_ratio` が真値（行灯あり slot）と整合するか
- 校正テスト: 各 stall で「行灯あり画像」と「行灯なし画像」を分けて回帰

### 実画像校正

- 今夜 20-23 時の画像 6-10 枚を sample
- 各 sample で目視「行灯のあるタクシー位置」をマーキング
- 観測値（lantern_pixel_ratio）の分布から:
  - `LANTERN_R_MIN` を 180 → 170 or 190 に微調整可能性
  - `NIGHT_LANTERN_RATIO` を 0.005 → 0.003 or 0.008 に微調整可能性
- 必要なら stall 別の `night_lantern_ratio` を `stall-slots.json` の各 stall に追加

## 運用考慮

- **影響範囲**: taxi-ic-helper の観測層のみ。`stall-actuals.json` の出力スキーマは不変
- **既存テストへの破壊**: `slotOccupied` のシグネチャ変更で既存テストが壊れる。
  すべて `opts` 形式に移行する
- **デプロイ**: taxi-ic-helper の main 直 push。 Mac mini が次の tick で git pull → 即反映
- **Roll back**: 万一夜検出で精度が悪化した場合、`NIGHT_BRIGHTNESS_THRESHOLD = 0` にすれば
  夜分岐が走らず昼ロジックに戻る（緊急回避）

## スコープ外

- 昼時間帯の行灯検出（昼は edge_density で十分）
- 載客中タクシー（行灯消灯）の別カウント
- ヘッドライト・テールランプ（赤いライト群）と行灯の区別
  （現状は両方とも「赤色高輝度」として True 判定する。
  実画像で誤検出が問題になれば slot 位置の上下調整 or サイズ調整で対応）
- 雨夜の反射光誤検出（後日 sample 取得で評価）
- 行灯のアニメーション（光が動く・点滅）への対応

## 成功基準

- 夜時間帯の slot occ 観測値の精度が **昼と同等（>= 90%）** に向上
- 19:01:43 のサンプル画像で stall1 観測 9/14 → 12-14/14 に改善
- `stall-actuals.json` の夜時間帯出庫数が「全 stall=0」のような明らかな取り逃しなし
- 校正後、stall1/2/3/4 すべてで真値とのズレが ±15% 以内
