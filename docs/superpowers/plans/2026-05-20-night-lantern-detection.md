# 夜時間帯 行灯検出 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 夜時間帯（画像 avg brightness < 50）に slot 占有判定を「行灯（屋根上の赤色点光源）検出」に切り替え、夜の精度を 50-70% → 90%+ に改善する。

**Architecture:** `analyzeROI` に `lantern_pixel_ratio` を新フィールドとして追加。`slotOccupied` のシグネチャを `(features, opts)` 形式に変更し、`opts.isNight=true` なら lantern_pixel_ratio で判定。`slot-occupancy-tick.mjs` で各カメラの brightness から夜判定し、夜なら ROI 高さを縦×2に拡張して analyzeROI に渡す。

**Tech Stack:** Node.js (ESM), Jimp, node:test, taxi-ic-helper repo (main 直 push)

**作業 worktree:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係-wt-perspective` (branch: `feat/front-slot-occupancy`)

**仕様参照:** `docs/superpowers/specs/2026-05-20-night-lantern-detection-design.md`

---

## File Structure

| ファイル | 役割 | 操作 |
|---|---|---|
| `scripts/lib/image-pool-analyzer.mjs` | `analyzeROI` の戻り値に `lantern_pixel_ratio` を追加 | 変更 |
| `scripts/lib/slot-occupancy.mjs` | `slotOccupied` シグネチャ変更 + `expandRoiVertical` + 定数 export | 変更 |
| `scripts/slot-occupancy-tick.mjs` | brightness 計算をヘルパー関数化 + 夜判定 + ROI拡張 + slotOccupied 新呼び出し | 変更 |
| `scripts/lib/stall-slots.json` | `_meta.night_brightness_threshold` と `_meta.night_lantern_ratio` 追加 | 変更 |
| `tests/image-pool-analyzer.test.mjs` | `lantern_pixel_ratio` のテスト追加 | 変更 |
| `tests/slot-occupancy.test.mjs` | `slotOccupied` opts 形式テスト+夜分岐テスト+`expandRoiVertical` テスト | 変更 |

---

## Task 1: analyzeROI に lantern_pixel_ratio を追加

**Files:**
- Modify: `scripts/lib/image-pool-analyzer.mjs`
- Modify: `tests/image-pool-analyzer.test.mjs`

- [ ] **Step 1: 失敗するテストを書く**

`tests/image-pool-analyzer.test.mjs` の末尾に以下を追記:

```javascript
import { analyzeROI } from '../scripts/lib/image-pool-analyzer.mjs';

test('analyzeROI: 全画像が赤い行灯色なら lantern_pixel_ratio が 1.0 に近い', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0xff0000ff }); // R=255 G=0 B=0
  const r = await analyzeROI(img, { x: 0, y: 0, width: 10, height: 10 });
  assert.ok(r.lantern_pixel_ratio >= 0.99, `expected ~1.0, got ${r.lantern_pixel_ratio}`);
});

test('analyzeROI: 真っ黒なら lantern_pixel_ratio が 0', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0x000000ff });
  const r = await analyzeROI(img, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(r.lantern_pixel_ratio, 0);
});

test('analyzeROI: 真っ白 (R=G=B=255) は行灯ではない (G/B が高いため)', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0xffffffff });
  const r = await analyzeROI(img, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(r.lantern_pixel_ratio, 0);
});

test('analyzeROI: 範囲外 ROI で lantern_pixel_ratio=0', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0xff0000ff });
  const r = await analyzeROI(img, { x: 100, y: 100, width: 10, height: 10 });
  assert.equal(r.lantern_pixel_ratio, 0);
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係-wt-perspective"
node --test tests/image-pool-analyzer.test.mjs
```

Expected: FAIL `lantern_pixel_ratio is undefined`

- [ ] **Step 3: 実装**

`scripts/lib/image-pool-analyzer.mjs` の冒頭 `EDGE_THRESHOLD` の下に定数を追加:

```javascript
const LANTERN_R_MIN = 180;   // 赤チャネルの下限 (空車行灯の赤)
const LANTERN_GB_MAX = 120;  // 緑・青チャネルの上限 (白色ライトを除外)
```

`analyzeROI` 内の「1. roi_black_ratio と luminance を 1 ループで集計」を以下に拡張（同じループで lanternCount も集計）:

```javascript
  // 1. roi_black_ratio と luminance と lantern_pixel_ratio を 1 ループで集計
  let blackCount = 0;
  let lanternCount = 0;
  let lumSum = 0;
  const luminances = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const r = roiData[idx];
    const g = roiData[idx + 1];
    const b = roiData[idx + 2];
    if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) blackCount++;
    if (r > LANTERN_R_MIN && g < LANTERN_GB_MAX && b < LANTERN_GB_MAX) lanternCount++;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    luminances[i] = lum;
    lumSum += lum;
  }
```

`luminance_std` 計算の下、return の手前に追加:

```javascript
  const lantern_pixel_ratio = lanternCount / total;
```

clipped が空 (width=0 or height=0) のとき返す early-return オブジェクトに `lantern_pixel_ratio: 0` を追加:

```javascript
  if (clipped.width === 0 || clipped.height === 0) {
    return {
      edge_density: 0,
      roi_black_ratio: 0,
      luminance_mean: 0,
      luminance_std: 0,
      lantern_pixel_ratio: 0
    };
  }
```

最終 return オブジェクトにも追加:

```javascript
  return {
    edge_density,
    roi_black_ratio,
    luminance_mean,
    luminance_std,
    lantern_pixel_ratio
  };
```

- [ ] **Step 4: テストが通ることを確認**

```bash
node --test tests/image-pool-analyzer.test.mjs
```

Expected: 既存テスト全部 PASS + 新規4件 PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/image-pool-analyzer.mjs tests/image-pool-analyzer.test.mjs
git commit -m "feat(slot): analyzeROI に lantern_pixel_ratio を追加 (夜行灯検出の基礎)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: expandRoiVertical 純関数

**Files:**
- Modify: `scripts/lib/slot-occupancy.mjs`
- Modify: `tests/slot-occupancy.test.mjs`

- [ ] **Step 1: 失敗するテストを書く**

`tests/slot-occupancy.test.mjs` の末尾に追記。 import 行に `expandRoiVertical` を追加。

import 行（上部、既存 `slotOccupied, slotsForStall, ...` の隣に追加）:

```javascript
import {
  slotOccupied, slotsForStall, countStallOccupancy, departuresBetween, medianOf3, isFrameAbnormal,
  expandRoiVertical,
} from '../scripts/lib/slot-occupancy.mjs';
```

末尾テスト追加:

```javascript
test('expandRoiVertical: factor=2 で height が 2倍、y が上にシフト', () => {
  const r = expandRoiVertical({ x: 100, y: 100, width: 20, height: 20 }, 2, 800, 600);
  assert.deepEqual(r, { x: 100, y: 90, width: 20, height: 40 });
});

test('expandRoiVertical: 画像上端で y を 0 にクリップ', () => {
  const r = expandRoiVertical({ x: 100, y: 5, width: 20, height: 20 }, 2, 800, 600);
  // y=5, height*2=40 → y-10=-5 になるが画像上端で 0、 height は y+height がはみ出ないよう調整
  assert.equal(r.y, 0);
  assert.equal(r.x, 100);
  assert.equal(r.width, 20);
  // height は max 0 + height (20+5=25 が上限) で 25 にクリップ
  assert.ok(r.height <= 40 && r.height >= 20);
});

test('expandRoiVertical: 画像下端で height を縮める', () => {
  const r = expandRoiVertical({ x: 100, y: 580, width: 20, height: 20 }, 2, 800, 600);
  // y=580, height=20 → 拡張後 y=570, height=40 → y+height=610 が 600 超過 → height=30
  assert.equal(r.y, 570);
  assert.equal(r.height, 30);
});

test('expandRoiVertical: factor=1 は不変', () => {
  const orig = { x: 100, y: 100, width: 20, height: 20 };
  const r = expandRoiVertical(orig, 1, 800, 600);
  assert.deepEqual(r, orig);
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
node --test tests/slot-occupancy.test.mjs
```

Expected: FAIL `expandRoiVertical is not exported`

- [ ] **Step 3: 実装**

`scripts/lib/slot-occupancy.mjs` の末尾に追加:

```javascript
/**
 * ROI の縦方向を factor 倍に拡張する純関数。
 * 中心 (cx, cy_center) は不変、 height のみ factor 倍。 画像範囲外はクリップ。
 * 夜の行灯検出で「車屋根上」を含める ROI を作るために使う。
 *
 * @param {{x:number, y:number, width:number, height:number}} roi 元 ROI
 * @param {number} factor 縦方向倍率 (>=1)
 * @param {number} imgWidth 画像幅
 * @param {number} imgHeight 画像高
 * @returns {{x:number, y:number, width:number, height:number}}
 */
export function expandRoiVertical(roi, factor, imgWidth, imgHeight) {
  if (factor <= 1) return { ...roi };
  const newHeight = roi.height * factor;
  const offset = (newHeight - roi.height) / 2;
  let y = Math.round(roi.y - offset);
  let h = Math.round(newHeight);
  // 上端クリップ
  if (y < 0) {
    h += y; // y が負ぶん height を縮める
    y = 0;
  }
  // 下端クリップ
  if (y + h > imgHeight) {
    h = imgHeight - y;
  }
  if (h < 0) h = 0;
  return { x: roi.x, y, width: roi.width, height: h };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
node --test tests/slot-occupancy.test.mjs
```

Expected: PASS（既存テスト＋新規4件）

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/slot-occupancy.mjs tests/slot-occupancy.test.mjs
git commit -m "feat(slot): expandRoiVertical 純関数を追加 (夜行灯検出用 ROI 拡張)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: slotOccupied を opts 形式に変更 + 夜分岐

**Files:**
- Modify: `scripts/lib/slot-occupancy.mjs`
- Modify: `tests/slot-occupancy.test.mjs`

- [ ] **Step 1: 既存テスト+新規テストを opts 形式に書き換える**

`tests/slot-occupancy.test.mjs` の既存テストを以下に書き換える（行34-41 付近）:

```javascript
test('slotOccupied (昼): edge_density がしきい値以上なら在', () => {
  assert.equal(slotOccupied({ edge_density: 0.20 }, { edgeThreshold: 0.08 }), true);
  assert.equal(slotOccupied({ edge_density: 0.03 }, { edgeThreshold: 0.08 }), false);
});

test('slotOccupied (昼): edge_density 欠落・null は不在', () => {
  assert.equal(slotOccupied({}, { edgeThreshold: 0.08 }), false);
  assert.equal(slotOccupied(null, { edgeThreshold: 0.08 }), false);
});
```

末尾に新規テスト追加:

```javascript
test('slotOccupied (夜): lantern_pixel_ratio が閾値以上なら在', () => {
  assert.equal(
    slotOccupied({ lantern_pixel_ratio: 0.010 }, { isNight: true, nightLanternRatio: 0.005 }),
    true
  );
  assert.equal(
    slotOccupied({ lantern_pixel_ratio: 0.003 }, { isNight: true, nightLanternRatio: 0.005 }),
    false
  );
});

test('slotOccupied (夜): lantern_pixel_ratio 境界 (= ratio) で在', () => {
  assert.equal(
    slotOccupied({ lantern_pixel_ratio: 0.005 }, { isNight: true, nightLanternRatio: 0.005 }),
    true
  );
});

test('slotOccupied (夜): lantern_pixel_ratio 欠落は不在', () => {
  assert.equal(
    slotOccupied({}, { isNight: true, nightLanternRatio: 0.005 }),
    false
  );
});

test('slotOccupied (夜): isNight=true なら edge_density は無視', () => {
  // 高 edge_density でも 行灯がなければ 夜では不在
  assert.equal(
    slotOccupied({ edge_density: 1.0, lantern_pixel_ratio: 0 }, { isNight: true, nightLanternRatio: 0.005 }),
    false
  );
});

test('slotOccupied (昼): isNight 未指定は false 扱いで edge_density 判定', () => {
  assert.equal(
    slotOccupied({ edge_density: 0.20 }, { edgeThreshold: 0.08 }),
    true
  );
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
node --test tests/slot-occupancy.test.mjs
```

Expected: FAIL（既存 `slotOccupied(features, 0.08)` の数値形式が opts に変わったため）

- [ ] **Step 3: slotOccupied のシグネチャを opts 形式に書き換え**

`scripts/lib/slot-occupancy.mjs` の既存 `slotOccupied` 定義 (行3-15 付近) を以下に置き換える:

```javascript
/** 在/不在のエッジ密度しきい値の既定。空きアスファルトは滑らか・車はエッジが多い。 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/** 夜行灯検出: 赤色高輝度 pixel の ROI 面積比のしきい値の既定。 */
export const DEFAULT_NIGHT_LANTERN_RATIO = 0.005;

/** 夜時間帯と判定する画像全体 平均輝度の上限 (これ以下が夜)。 */
export const NIGHT_BRIGHTNESS_THRESHOLD = 50;

/**
 * スロットの画像特徴から在(車あり)/不在を判定する純関数。
 * 昼: edge_density >= edgeThreshold で判定。
 * 夜 (opts.isNight=true): lantern_pixel_ratio >= nightLanternRatio で判定。
 *
 * @param {object} features analyzeROI の戻り値
 * @param {object} opts 判定オプション
 * @param {number} [opts.edgeThreshold] 昼の edge_density しきい値
 * @param {boolean} [opts.isNight] 夜モード
 * @param {number} [opts.nightLanternRatio] 夜の lantern_pixel_ratio しきい値
 * @returns {boolean}
 */
export function slotOccupied(features, opts = {}) {
  if (!features) return false;
  if (opts.isNight) {
    const ratio = features.lantern_pixel_ratio;
    if (typeof ratio !== 'number') return false;
    return ratio >= (opts.nightLanternRatio ?? DEFAULT_NIGHT_LANTERN_RATIO);
  }
  const ed = features.edge_density;
  if (typeof ed !== 'number') return false;
  return ed >= (opts.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD);
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
node --test tests/slot-occupancy.test.mjs
```

Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/slot-occupancy.mjs tests/slot-occupancy.test.mjs
git commit -m "feat(slot): slotOccupied を opts 形式に変更し夜行灯モードを追加

opts.isNight=true なら lantern_pixel_ratio >= nightLanternRatio で判定。
既定値 DEFAULT_NIGHT_LANTERN_RATIO=0.005, NIGHT_BRIGHTNESS_THRESHOLD=50。
既存 (features, edgeThreshold) 数値形式の呼び出しは破壊。tick.mjs で対応。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: stall-slots.json に夜閾値を追加

**Files:**
- Modify: `scripts/lib/stall-slots.json`

- [ ] **Step 1: `_meta` に追加**

`scripts/lib/stall-slots.json` の `_meta` セクションを以下に置き換える:

```json
  "_meta": {
    "image_size": [
      800,
      600
    ],
    "edge_threshold": 0.08,
    "night_brightness_threshold": 50,
    "night_lantern_ratio": 0.005,
    "note": "スロット中心は0-1正規化座標。夜時間帯 (画像 avg brightness < night_brightness_threshold) は行灯検出に切替。"
  },
```

- [ ] **Step 2: JSON が valid か確認**

```bash
node -e 'const d = JSON.parse(require("fs").readFileSync("scripts/lib/stall-slots.json","utf8")); console.log("valid", "night_brightness_threshold:", d._meta.night_brightness_threshold, "night_lantern_ratio:", d._meta.night_lantern_ratio);'
```

Expected: `valid night_brightness_threshold: 50 night_lantern_ratio: 0.005`

- [ ] **Step 3: コミット**

```bash
git add scripts/lib/stall-slots.json
git commit -m "feat(slot): stall-slots.json _meta に夜閾値を追加

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: slot-occupancy-tick.mjs に夜分岐を追加

**Files:**
- Modify: `scripts/slot-occupancy-tick.mjs`

このタスクはテストしにくい（実カメラ依存）。 実装後 npm test で全テスト PASS 確認 + 手動 dry-run 確認。

- [ ] **Step 1: brightness 計算をヘルパー関数化**

`scripts/slot-occupancy-tick.mjs` の `main()` 内の brightness 計算ループを抜き出して、 ファイル先頭近く（既存 `fetchBuffer` 関数の後）に純関数として配置:

```javascript
// 画像全体の平均輝度を 50px 間隔でサンプリングして返す。
// isFrameAbnormal 用と 夜判定 用の両方で再利用。
function avgBrightness(img) {
  const { data } = img.bitmap;
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4 * 50) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}
```

- [ ] **Step 2: import を更新**

`scripts/slot-occupancy-tick.mjs` の import 行を以下に変更:

```javascript
import { slotOccupied, slotsForStall, countStallOccupancy, DEFAULT_EDGE_THRESHOLD, DEFAULT_NIGHT_LANTERN_RATIO, NIGHT_BRIGHTNESS_THRESHOLD, isFrameAbnormal, expandRoiVertical }
  from './lib/slot-occupancy.mjs';
```

- [ ] **Step 3: 既存の brightness ループを置換 + 夜判定を追加**

既存の以下のブロック:

```javascript
  // 画像の平均輝度をチェック。真っ白/真っ黒の壊れフレームは tick 全体を skip して
  // 擬似出庫が計上されるのを防ぐ（直近の正常 occ が次の正常 tick まで保持される）。
  for (const cam of Object.keys(cameras)) {
    const img = cameras[cam];
    const { width, height, data } = img.bitmap;
    let sum = 0;
    let count = 0;
    // 50px ごとにサンプル（高速化）
    for (let i = 0; i < data.length; i += 4 * 50) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      count += 1;
    }
    const avg = count > 0 ? sum / count : 0;
    if (isFrameAbnormal(avg)) {
      console.error(`[slot] abnormal frame for ${cam} (avg=${avg.toFixed(1)}), skip tick`);
      return;
    }
  }
```

を以下に置換:

```javascript
  // カメラごとの brightness を計算し、 異常フレームは tick 全体 skip。
  // 同時に「夜モード」判定を保持する。
  const cameraIsNight = {};
  for (const cam of Object.keys(cameras)) {
    const avg = avgBrightness(cameras[cam]);
    if (isFrameAbnormal(avg)) {
      console.error(`[slot] abnormal frame for ${cam} (avg=${avg.toFixed(1)}), skip tick`);
      return;
    }
    cameraIsNight[cam] = avg < (cfg._meta?.night_brightness_threshold ?? NIGHT_BRIGHTNESS_THRESHOLD);
  }
```

- [ ] **Step 4: stall ループの slotOccupied 呼び出しを opts 形式に変更**

既存ブロック（slot ループ部分）を以下に置換:

```javascript
  for (const name of STALLS) {
    const st = cfg.stalls?.[name];
    if (!st) continue;
    const img = cameras[st.source];
    if (!img) continue;
    const { width, height } = img.bitmap;
    const stallThreshold = (typeof st.edge_threshold === 'number') ? st.edge_threshold : globalThreshold;
    const isNight = cameraIsNight[st.source];
    const nightLanternRatio = cfg._meta?.night_lantern_ratio ?? DEFAULT_NIGHT_LANTERN_RATIO;
    const occupiedById = {};
    for (const slot of slotsForStall(cfg, name)) {
      const baseRoi = slotRoi(slot, width, height);
      // 夜は ROI を縦×2 に拡張して屋根上 (行灯位置) も含める。
      const roi = isNight ? expandRoiVertical(baseRoi, 2, width, height) : baseRoi;
      const feat = await analyzeROI(img, roi);
      occupiedById[slot.id] = slotOccupied(feat, {
        edgeThreshold: stallThreshold,
        isNight,
        nightLanternRatio,
      });
    }
    row.stalls[name] = {
      occ: countStallOccupancy(occupiedById, slotsForStall(cfg, name)),
      slots: occupiedById,
    };
  }
```

注: 既存 `slotRoi(slot, width, height)` がそのまま使える前提（行93 付近）。

- [ ] **Step 5: 全テスト走行**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係-wt-perspective"
npm test 2>&1 | tail -8
```

Expected: 全テスト PASS（夜行灯テスト含む）

- [ ] **Step 6: 手動 dry-run（実カメラ未接続でも syntax error 検出）**

```bash
node -c scripts/slot-occupancy-tick.mjs && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 7: コミット**

```bash
git add scripts/slot-occupancy-tick.mjs
git commit -m "feat(slot): slot-occupancy-tick.mjs に夜行灯モードを追加

カメラごとに avg brightness を計算し brightness < night_brightness_threshold
なら ROI を縦×2 に拡張して slotOccupied を夜モードで呼ぶ。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Mac mini に反映 + 実観測確認

**Files:** なし（運用タスク）

- [ ] **Step 1: feat ブランチを origin/main に push**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係-wt-perspective"
git fetch origin
git rebase origin/main
git push origin feat/front-slot-occupancy:main
```

- [ ] **Step 2: Mac mini で git pull**

```bash
ssh nakanohideaki@mac-mini.local 'cd ~/repos/taxi-ic-helper && git pull 2>&1 | tail -3'
```

Expected: `Fast-forward` or `Already up to date`

- [ ] **Step 3: 観測 tick 1回分のログを確認**

```bash
ssh nakanohideaki@mac-mini.local 'sleep 35 && tail -3 ~/repos/taxi-ic-helper/.local/slot-occupancy-stdout.log'
```

Expected: `[slot] ok: stall1=N stall2=N stall3=N stall4=N stall4_back=N`（夜であれば lantern 検出ベースの新値）

- [ ] **Step 4: history.jsonl の最新 1行を確認**

```bash
ssh nakanohideaki@mac-mini.local 'tail -1 ~/repos/taxi-ic-helper/data/slot-occupancy-history.jsonl | python3 -c "import json,sys; e=json.loads(sys.stdin.read()); print(e[\"ts\"]); [print(f\"  {n}: occ={e[\"stalls\"][n][\"occ\"]}\") for n in e[\"stalls\"]]"'
```

Expected: 各 stall の occ が出力される（夜なら昼より低い値が期待される、ただし行灯検出が動いていれば 0 ではない）

---

## Task 7: 実画像校正

**Files:** なし（実画像で閾値調整）

- [ ] **Step 1: 夜の sample 画像を取得**

```bash
ssh nakanohideaki@mac-mini.local 'ls ~/taxi-image-archive/real01_line/2026-05-20/ | grep -E "^2[0-3]" | tail -10'
```

20-23 時の画像から 3-5 枚 sample。 無ければ 30分待って今夜の data 蓄積後に再実行。

- [ ] **Step 2: replay-sim.mjs を夜行灯対応に拡張**

`/tmp/cam-verify/replay-sim-night.mjs` を新規作成（既存 `scripts/replay-sim.mjs` を参考に、夜分岐を追加した版）:

```javascript
// 夜の sample 画像で行灯検出の lantern_pixel_ratio 分布を可視化。
// 閾値 0.005 が妥当か、実画像での値を見て判断するための replay。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { analyzeROI } from './lib/image-pool-analyzer.mjs';
import { expandRoiVertical } from './lib/slot-occupancy.mjs';

const cfg = JSON.parse(readFileSync('./scripts/lib/stall-slots.json', 'utf8'));
const [archiveRoot, ymd, hmFrom, hmTo] = process.argv.slice(2);
const dir = path.join(archiveRoot, 'real01_line', ymd);
const files = readdirSync(dir).filter(f => f.endsWith('.jpg') && f.slice(0,4) >= hmFrom && f.slice(0,4) <= hmTo).sort();

for (const f of files) {
  const img = await Jimp.read(path.join(dir, f));
  const W = img.bitmap.width, H = img.bitmap.height;
  // brightness
  let bs = 0, bn = 0;
  for (let i = 0; i < img.bitmap.data.length; i += 4*50) {
    bs += (img.bitmap.data[i]+img.bitmap.data[i+1]+img.bitmap.data[i+2])/3;
    bn += 1;
  }
  const br = bs/bn;
  // 各 stall の lantern_pixel_ratio
  console.log(`${f.slice(0,6)} br=${br.toFixed(0)}`);
  for (const name of Object.keys(cfg.stalls)) {
    const st = cfg.stalls[name];
    if (st.source !== 'real01_line') continue;
    const ratios = [];
    for (const slot of st.slots) {
      const cx = slot.cx*W, cy = slot.cy*H, r = slot.r*W;
      const baseRoi = { x: Math.round(cx-r), y: Math.round(cy-r), width: Math.round(r*2), height: Math.round(r*2) };
      const roi = expandRoiVertical(baseRoi, 2, W, H);
      const feat = await analyzeROI(img, roi);
      ratios.push(feat.lantern_pixel_ratio);
    }
    const occ = ratios.filter(r => r >= 0.005).length;
    const max = Math.max(...ratios), min = Math.min(...ratios);
    console.log(`  ${name}: occ=${occ}/${ratios.length} max=${max.toFixed(4)} min=${min.toFixed(4)}`);
  }
}
```

- [ ] **Step 3: Mac mini で replay 実行**

```bash
scp -q /tmp/cam-verify/replay-sim-night.mjs nakanohideaki@mac-mini.local:'~/repos/taxi-ic-helper/scripts/replay-sim-night.mjs'
ssh nakanohideaki@mac-mini.local 'cd ~/repos/taxi-ic-helper && /opt/homebrew/bin/node scripts/replay-sim-night.mjs ~/taxi-image-archive 2026-05-20 2000 2030' 2>&1 | head -30
```

- [ ] **Step 4: 結果を見て閾値判断**

各 stall の `max` と `min` の分布を見て:
- 全 slot の max が 0.005 未満 → `night_lantern_ratio` を 0.003 に下げる必要
- 全 slot の min が 0.005 以上 → 閾値が緩すぎる、 0.010 に上げる必要
- 真値と差が出る stall がある → stall 別 `night_lantern_ratio` を `stall-slots.json` の各 stall に追加

判断結果に応じて、`stall-slots.json` の `_meta.night_lantern_ratio` を調整 or stall 別追加。

- [ ] **Step 5: 調整があれば コミット + Mac mini pull**

```bash
git add scripts/lib/stall-slots.json
git commit -m "tune(slot): night_lantern_ratio を実画像校正で調整

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push origin feat/front-slot-occupancy:main
ssh nakanohideaki@mac-mini.local 'cd ~/repos/taxi-ic-helper && git pull 2>&1 | tail -3'
```

調整不要なら skip。

---

## Plan 完了基準

- 全テスト PASS (`analyzeROI` + `slotOccupied` + `expandRoiVertical` のテスト含む)
- Mac mini で git pull 完了、 30秒 tick で夜行灯モード稼働
- 夜の sample 画像で `lantern_pixel_ratio` 分布を確認、 必要なら閾値調整済み
- `stall-actuals.json` の夜時間帯 出庫数が「全 stall=0」のような明らかな取り逃しなし
- 画像校正で各 stall の真値とのズレが ±15% 以内（成功基準）

## 注意事項

- `slotOccupied` のシグネチャを `(features, opts)` に **破壊的変更**。 既存テストは Task 3 で書き換え。 tick.mjs は Task 5 で書き換え。 他に呼び出し元があればそこも更新（grep で確認: `grep -rn "slotOccupied" scripts/ tests/`）
- ROI 縦拡張で「画像上端」「下端」のクリップが入る。 stall1/2 は遠方 (cy=0.13) なので拡張すると 上端 (y < 0) に近づく → クリップ動作確認必須（Task 2 のテストで境界カバー済）
- 夜の brightness 判定はカメラごと。 real01 と real02 で別々に判定（昼夜の境目で片方だけ夜になることあり）
- `taxi-ic-helper` は **main 直 push** スタイル。 feat ブランチで commit して `git push origin feat/front-slot-occupancy:main` で main を進める（既存運用に合わせる）
- Mac mini で git pull 後の launchd 再 install は **不要**（コード変更のみ、 plist は不変）
