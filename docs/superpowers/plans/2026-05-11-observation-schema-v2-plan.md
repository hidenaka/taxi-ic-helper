# タクシープール観測 — スキーマ v2 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase A 観測 jsonl のスキーマを v2 に拡張し、`img.roi.edge_density` (ROI 内 Sobel エッジ密度) と `arrivals_window.estimated_taxi_pax_sum` (現在 -30 〜 +60 分の便集計) を追加することで、時間帯非依存のタクシー在不在シグナルと時間帯依存の予測値ペアを記録する。

**Architecture:** 既存の `analyzePoolImage` 純粋関数に第 3 引数 `roi` を追加して `roi` フィールドを返すよう拡張。新規 `summarizeArrivalsWindow` 純粋関数で時間窓集計を行う。`observe-taxi-pool.mjs` でこの 2 つを呼んで `schema_version: 2` 付きで jsonl に append。既存 v1 行 (118 行) は不変、`schema_version` フィルタで識別。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / `jimp@1.x` (画像解析、Sobel は jimp 標準の `convolute` で実装) / launchd (Mac mini で稼働)

**設計ドキュメント:** `docs/superpowers/specs/2026-05-11-observation-schema-v2-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/roi-config.json` | Create | Real01_line / Real02 の ROI 座標 (800×600 内の矩形) |
| `scripts/lib/image-pool-analyzer.mjs` | Modify | `analyzePoolImage` に第3引数 `roi` を追加、`roi` フィールドを返り値に追加 |
| `scripts/lib/arrivals-window-summary.mjs` | Create | flights[] から「now -30 〜 +60 分」の集計を返す純粋関数 |
| `scripts/observe-taxi-pool.mjs` | Modify | 新解析を呼び、`schema_version: 2` で jsonl 追記 |
| `tests/image-pool-analyzer.test.mjs` | Modify | ROI/エッジ密度のテスト 5 件追加 |
| `tests/arrivals-window-summary.test.mjs` | Create | 時間窓フィルタのテスト 6 件 |
| `docs/research/taxi-pool-observation.md` | Modify | schema_version=2 仕様と Phase A 検証手順を更新 |

実装順序: **ROI config → analyzer 拡張 (TDD) → window 純粋関数 (TDD) → orchestrator 配線 → docs → ローカル動作確認 → push & 観測検証**

---

## Task 1: `roi-config.json` を作成

**Files:**
- Create: `scripts/lib/roi-config.json`

- [ ] **Step 1.1: ROI 座標を確定したファイルを作成**

`scripts/lib/roi-config.json`:

```json
{
  "_meta": {
    "source": "ttc.taxi-inf.jp の Real01_line.jpg / Real02.jpg を 2026-05-11 時点で手動切り出し",
    "image_size": [800, 600],
    "note": "カメラアングルが変わった場合は再校正必要。Real01 は上 80px に空・高架、下 40px に赤帯。Real02 は上は駐車場遠端、下 80px に影+赤帯"
  },
  "real01_line": {
    "x": 0,
    "y": 80,
    "width": 800,
    "height": 480
  },
  "real02": {
    "x": 0,
    "y": 10,
    "width": 800,
    "height": 520
  }
}
```

- [ ] **Step 1.2: JSON valid 確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
python3 -c "import json; print(json.load(open('scripts/lib/roi-config.json'))['real01_line'])"
```

期待: `{'x': 0, 'y': 80, 'width': 800, 'height': 480}` が出力される。

- [ ] **Step 1.3: コミット**

```bash
git add scripts/lib/roi-config.json
git commit -m "feat(observe): add ROI config for image-pool-analyzer"
```

---

## Task 2: `image-pool-analyzer.mjs` に ROI/Sobel/輝度解析を追加 (TDD)

**Files:**
- Modify: `scripts/lib/image-pool-analyzer.mjs`
- Modify: `tests/image-pool-analyzer.test.mjs`

- [ ] **Step 2.1: 失敗するテストを追加**

`tests/image-pool-analyzer.test.mjs` の末尾に以下を追加:

```javascript
// --- ROI 解析 (schema v2) ---

// 10x10 の市松模様 (黒白 5x5 タイル) を作る (エッジ多めの画像)
async function checkerBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0xffffffff });
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      if ((Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0) {
        img.bitmap.data[(y * 10 + x) * 4 + 0] = 0;
        img.bitmap.data[(y * 10 + x) * 4 + 1] = 0;
        img.bitmap.data[(y * 10 + x) * 4 + 2] = 0;
      }
    }
  }
  return await img.getBuffer('image/jpeg');
}

const ROI_FULL = { x: 0, y: 0, width: 10, height: 10 };

test('ROI 解析: 全黒 ROI → edge_density が 0 に近い (一様)', async () => {
  const buf = await blackBuffer();
  const r = await analyzePoolImage(buf, null, ROI_FULL);
  assert.ok(r.roi, 'roi フィールドが存在する');
  assert.ok(r.roi.edge_density < 0.1, `edge_density=${r.roi.edge_density}`);
  assert.ok(r.roi.luminance_mean < 50, `luminance_mean=${r.roi.luminance_mean}`);
  assert.equal(r.roi.diff_edge_from_prev, null, 'prev=null なら diff_edge_from_prev も null');
});

test('ROI 解析: 市松模様 ROI → edge_density が高い', async () => {
  const buf = await checkerBuffer();
  const r = await analyzePoolImage(buf, null, ROI_FULL);
  assert.ok(r.roi.edge_density > 0.15, `edge_density=${r.roi.edge_density}`);
});

test('ROI 解析: ROI が画像範囲外でもクラッシュしない (クリップ)', async () => {
  const buf = await blackBuffer();
  const roi = { x: -50, y: -50, width: 200, height: 200 }; // 画像 10x10 を大きく超える
  const r = await analyzePoolImage(buf, null, roi);
  assert.ok(r.roi, 'roi フィールドが返る');
  assert.ok(typeof r.roi.edge_density === 'number');
});

test('ROI 解析: roi_black_ratio は ROI 内だけで計算される', async () => {
  const buf = await blackBuffer();
  // 全画像 10x10 が全黒なので、ROI 全範囲でも 0.95 以上
  const r = await analyzePoolImage(buf, null, ROI_FULL);
  assert.ok(r.roi.roi_black_ratio > 0.95, `roi_black_ratio=${r.roi.roi_black_ratio}`);
  // 全体の black_ratio も同様に高い
  assert.ok(r.black_ratio > 0.95);
});

test('ROI 解析: prev.roi.edge_density との差分が diff_edge_from_prev', async () => {
  const blackBuf = await blackBuffer();
  const checkerBuf = await checkerBuffer();
  const prev = await analyzePoolImage(blackBuf, null, ROI_FULL);
  const curr = await analyzePoolImage(checkerBuf, prev, ROI_FULL);
  assert.equal(typeof curr.roi.diff_edge_from_prev, 'number');
  assert.ok(curr.roi.diff_edge_from_prev > 0, '黒→市松 で edge_density 差は正の値');
});

test('ROI 解析: roi=null を渡すと既存動作 (roi フィールドなし)', async () => {
  const buf = await blackBuffer();
  const r = await analyzePoolImage(buf, null, null);
  assert.equal(r.roi, undefined, 'roi=null なら roi フィールドは返さない');
  assert.ok(typeof r.black_ratio === 'number', '既存の black_ratio は計算される');
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --test tests/image-pool-analyzer.test.mjs 2>&1 | tail -10
```

期待: 新 6 件のうち少なくとも 5 件が fail (現関数は `roi` を返さないので `r.roi` が undefined)。

- [ ] **Step 2.3: `image-pool-analyzer.mjs` に ROI 解析を実装**

`scripts/lib/image-pool-analyzer.mjs` を以下に置き換える:

```javascript
import { createHash } from 'node:crypto';
import { Jimp } from 'jimp';

const BLACK_THRESHOLD = 60; // RGB 各値が 60 未満なら「黒」扱い (タクシー車体近似)
const EDGE_THRESHOLD = 50;  // Sobel 勾配大きさのしきい値

// 3x3 Sobel カーネル
const SOBEL_X = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
const SOBEL_Y = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];

/**
 * code が seatsMaster に存在するかを検証し、存在すればそのキーを、なければ null を返す。
 * (unrelated helper - moved out for clarity)
 */
function clipRoi(roi, width, height) {
  // ROI 座標を画像範囲にクリップ
  const x = Math.max(0, Math.min(width, roi.x ?? 0));
  const y = Math.max(0, Math.min(height, roi.y ?? 0));
  const w = Math.max(0, Math.min(width - x, roi.width ?? 0));
  const h = Math.max(0, Math.min(height - y, roi.height ?? 0));
  return { x, y, width: w, height: h };
}

async function analyzeROI(jimpImage, roi) {
  const { width, height } = jimpImage.bitmap;
  const clipped = clipRoi(roi, width, height);
  if (clipped.width === 0 || clipped.height === 0) {
    return {
      edge_density: 0,
      roi_black_ratio: 0,
      luminance_mean: 0,
      luminance_std: 0
    };
  }

  // ROI をクローン + crop してから処理 (元画像を破壊しない)
  const roiImg = jimpImage.clone().crop({ x: clipped.x, y: clipped.y, w: clipped.width, h: clipped.height });
  const roiData = roiImg.bitmap.data;
  const total = clipped.width * clipped.height;

  // 1. roi_black_ratio と luminance を 1 ループで集計
  let blackCount = 0;
  let lumSum = 0;
  const luminances = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const r = roiData[idx];
    const g = roiData[idx + 1];
    const b = roiData[idx + 2];
    if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) blackCount++;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    luminances[i] = lum;
    lumSum += lum;
  }
  const luminance_mean = lumSum / total;
  let varSum = 0;
  for (let i = 0; i < total; i++) {
    varSum += (luminances[i] - luminance_mean) ** 2;
  }
  const luminance_std = Math.sqrt(varSum / total);
  const roi_black_ratio = blackCount / total;

  // 2. Sobel エッジ密度
  // luminances を 2D グリッドとして扱い、内側 (w-2)*(h-2) ピクセルで Sobel
  let edgeCount = 0;
  const w = clipped.width;
  const h = clipped.height;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let gx = 0, gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = luminances[(y + dy) * w + (x + dx)];
          gx += v * SOBEL_X[dy + 1][dx + 1];
          gy += v * SOBEL_Y[dy + 1][dx + 1];
        }
      }
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag >= EDGE_THRESHOLD) edgeCount++;
    }
  }
  const inner = Math.max(1, (w - 2) * (h - 2));
  const edge_density = edgeCount / inner;

  return {
    edge_density: Number(edge_density.toFixed(4)),
    roi_black_ratio: Number(roi_black_ratio.toFixed(4)),
    luminance_mean: Number(luminance_mean.toFixed(2)),
    luminance_std: Number(luminance_std.toFixed(2))
  };
}

/**
 * 画像 Buffer を解析してメタデータを返す純粋関数 (画像 I/O 以外は副作用なし)。
 *
 * @param {Buffer} buffer - 解析対象の画像 (JPEG/PNG)
 * @param {{black_ratio: number, roi?: {edge_density: number}}|null} prev - 前 tick の解析結果
 * @param {{x: number, y: number, width: number, height: number}|null} roi - ROI 座標 (null なら ROI 解析スキップ)
 * @returns {Promise<{sha256: string, size_bytes: number, black_ratio: number, diff_from_prev: number|null, roi?: object}>}
 */
export async function analyzePoolImage(buffer, prev = null, roi = null) {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const size_bytes = buffer.length;

  const img = await Jimp.read(buffer);
  const { width, height, data } = img.bitmap;
  const totalPixels = width * height;
  let blackCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) {
      blackCount += 1;
    }
  }
  const black_ratio = totalPixels > 0
    ? Number((blackCount / totalPixels).toFixed(4))
    : 0;

  const diff_from_prev = (prev && typeof prev.black_ratio === 'number')
    ? Number(Math.abs(black_ratio - prev.black_ratio).toFixed(4))
    : null;

  const result = { sha256, size_bytes, black_ratio, diff_from_prev };

  // ROI 解析 (オプショナル、roi=null なら追加しない)
  if (roi) {
    try {
      const roiResult = await analyzeROI(img, roi);
      const prevEdge = prev?.roi?.edge_density;
      const diff_edge_from_prev = (typeof prevEdge === 'number')
        ? Number(Math.abs(roiResult.edge_density - prevEdge).toFixed(4))
        : null;
      result.roi = { ...roiResult, diff_edge_from_prev };
    } catch (e) {
      console.error(`[analyzePoolImage] ROI 解析失敗: ${e.message}`);
      result.roi = null;
    }
  }

  return result;
}
```

- [ ] **Step 2.4: テスト実行 → パス確認**

```bash
node --test tests/image-pool-analyzer.test.mjs 2>&1 | tail -5
```

期待: 既存 5 件 + 新 6 件 = 11 件すべてパス。

- [ ] **Step 2.5: 全テストスイート実行 (回帰確認)**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス (現在 294 件 + 6 件 = 300 件)。

- [ ] **Step 2.6: コミット**

```bash
git add scripts/lib/image-pool-analyzer.mjs tests/image-pool-analyzer.test.mjs
git commit -m "feat(observe): add ROI/Sobel edge density to analyzePoolImage"
```

---

## Task 3: `arrivals-window-summary.mjs` 純粋関数を実装 (TDD)

**Files:**
- Create: `scripts/lib/arrivals-window-summary.mjs`
- Create: `tests/arrivals-window-summary.test.mjs`

- [ ] **Step 3.1: 失敗するテストを作成**

`tests/arrivals-window-summary.test.mjs`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { summarizeArrivalsWindow } from '../scripts/lib/arrivals-window-summary.mjs';

// 共通フィクスチャ
function mkFlight(opts) {
  return {
    flightNumber: opts.flightNumber ?? 'XX000',
    scheduledTime: opts.scheduledTime ?? null,
    estimatedTime: opts.estimatedTime ?? null,
    estimatedPax: opts.estimatedPax ?? null,
    estimatedTaxiPax: opts.estimatedTaxiPax ?? null,
    reachTier: opts.reachTier ?? null
  };
}

// 全てのテストで JST 13:00 を「現在」として使う (窓 = 12:30 〜 14:00)
const NOW = new Date('2026-05-11T13:00:00+09:00');

test('全便が窓内 → 合計値が正確', () => {
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'A1', estimatedTime: '12:45', estimatedPax: 100, estimatedTaxiPax: 15, reachTier: 'high' }),
      mkFlight({ flightNumber: 'A2', estimatedTime: '13:30', estimatedPax: 200, estimatedTaxiPax: 30, reachTier: 'mid' })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 2);
  assert.equal(r.estimated_pax_sum, 300);
  assert.equal(r.estimated_taxi_pax_sum, 45);
  assert.equal(r.reach_none_count, 0);
});

test('窓外の便はカウントされない', () => {
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'IN',  estimatedTime: '13:30', estimatedPax: 100, estimatedTaxiPax: 10 }),
      mkFlight({ flightNumber: 'OUT', estimatedTime: '15:00', estimatedPax: 999, estimatedTaxiPax: 99 })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_pax_sum, 100);
  assert.equal(r.estimated_taxi_pax_sum, 10);
});

test('estimatedTime 優先、なければ scheduledTime', () => {
  const arrivals = {
    flights: [
      // estimatedTime が窓外 (15:00) だが scheduledTime は窓内 (13:30) → estimatedTime を見るので除外
      mkFlight({ flightNumber: 'D1', scheduledTime: '13:30', estimatedTime: '15:00', estimatedPax: 100 }),
      // estimatedTime なし、scheduledTime が窓内 → カウント
      mkFlight({ flightNumber: 'S1', scheduledTime: '12:45', estimatedPax: 50, estimatedTaxiPax: 8 })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_pax_sum, 50);
  assert.equal(r.estimated_taxi_pax_sum, 8);
});

test('"24:30" 表記は翌日 00:30 として扱う (深夜便)', () => {
  // 現在を JST 23:00 として、24:30 (翌日 00:30) は now+60 分以内
  const now = new Date('2026-05-11T23:50:00+09:00');
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'NIGHT', estimatedTime: '24:30', estimatedPax: 150, estimatedTaxiPax: 25 })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, now);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_taxi_pax_sum, 25);
});

test('estimatedPax / estimatedTaxiPax が null の便は合計に寄与しない', () => {
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'N1', estimatedTime: '13:00', estimatedPax: null, estimatedTaxiPax: null, reachTier: 'none' })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_pax_sum, 0);
  assert.equal(r.estimated_taxi_pax_sum, 0);
  assert.equal(r.reach_none_count, 1);
});

test('窓内 0 便 → 全フィールドが 0 (null ではなく)', () => {
  const arrivals = { flights: [] };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 0);
  assert.equal(r.estimated_pax_sum, 0);
  assert.equal(r.estimated_taxi_pax_sum, 0);
  assert.equal(r.reach_none_count, 0);
  // from / to も返ること
  assert.ok(r.from);
  assert.ok(r.to);
});
```

- [ ] **Step 3.2: テスト実行 → 失敗確認**

```bash
node --test tests/arrivals-window-summary.test.mjs 2>&1 | tail -5
```

期待: `Cannot find module ../scripts/lib/arrivals-window-summary.mjs` で全件失敗。

- [ ] **Step 3.3: `arrivals-window-summary.mjs` を実装**

`scripts/lib/arrivals-window-summary.mjs`:

```javascript
/**
 * arrivals.json から「now - 30 min 〜 now + 60 min」の便を集計する純粋関数。
 *
 * @param {{flights: Array}} arrivals - data/arrivals.json の中身
 * @param {Date} now - 現在時刻
 * @returns {{from: string, to: string, flight_count: number, estimated_taxi_pax_sum: number, estimated_pax_sum: number, reach_none_count: number}}
 */
export function summarizeArrivalsWindow(arrivals, now) {
  const WINDOW_PAST_MIN = 30;
  const WINDOW_FUTURE_MIN = 60;
  const from = new Date(now.getTime() - WINDOW_PAST_MIN * 60 * 1000);
  const to = new Date(now.getTime() + WINDOW_FUTURE_MIN * 60 * 1000);

  // now の JST 日付 (year/month/date) を ts 比較の基準に
  const baseYear = now.getFullYear();
  const baseMonth = now.getMonth();
  const baseDate = now.getDate();

  const flights = (arrivals?.flights ?? []).filter(f => {
    const timeStr = f.estimatedTime ?? f.scheduledTime;
    if (!timeStr) return false;
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const flightDate = new Date(baseYear, baseMonth, baseDate);
    if (hours >= 24) {
      flightDate.setDate(flightDate.getDate() + 1);
      hours -= 24;
    }
    flightDate.setHours(hours, minutes, 0, 0);
    return flightDate >= from && flightDate <= to;
  });

  const estimated_pax_sum = flights.reduce((s, f) => s + (f.estimatedPax ?? 0), 0);
  const estimated_taxi_pax_sum = flights.reduce((s, f) => s + (f.estimatedTaxiPax ?? 0), 0);
  const reach_none_count = flights.filter(f => f.reachTier === 'none').length;

  return {
    from: toJstIso(from),
    to: toJstIso(to),
    flight_count: flights.length,
    estimated_taxi_pax_sum,
    estimated_pax_sum,
    reach_none_count
  };
}

function toJstIso(d) {
  // d (Date) を JST 表現の ISO 8601 文字列に変換 (+09:00 suffix)
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}
```

- [ ] **Step 3.4: テスト再実行 → パス確認**

```bash
node --test tests/arrivals-window-summary.test.mjs 2>&1 | tail -5
```

期待: 6 件すべてパス。

- [ ] **Step 3.5: 全テストスイート実行 (回帰確認)**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス (300 + 6 = 306 件)。

- [ ] **Step 3.6: コミット**

```bash
git add scripts/lib/arrivals-window-summary.mjs tests/arrivals-window-summary.test.mjs
git commit -m "feat(observe): add summarizeArrivalsWindow for time-windowed prediction"
```

---

## Task 4: `observe-taxi-pool.mjs` で新解析・新スキーマを統合

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 4.1: orchestrator を更新**

`scripts/observe-taxi-pool.mjs` を以下に置き換える:

```javascript
#!/usr/bin/env node
/**
 * タクシープール観測パイプライン (schema v2) のオーケストレーター。
 * 1. ttc.taxi-inf.jp から画像 2 枚取得
 * 2. analyzePoolImage で各画像のメタデータ + ROI 解析を抽出
 * 3. data/arrivals.json と data/weather.json から状態取得
 * 4. summarizeArrivalsWindow で「現在 -30 〜 +60 分」の便集計
 * 5. data/taxi-pool-history.jsonl の最終行を読み、前 tick メタを取り出して diff 計算
 * 6. 新しい 1 行 (schema_version=2) を append
 * 7. /tmp に画像を保存 (workflow が Artifact upload する想定だが、launchd 運用では未使用)
 *
 * Workflow からは git commit & push の race-safe ロジックで呼ばれる。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { analyzePoolImage } from './lib/image-pool-analyzer.mjs';
import { summarizeArrivalsWindow } from './lib/arrivals-window-summary.mjs';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';
const USER_AGENT = 'taxi-ic-helper observation bot (https://github.com/hidenaka/taxi-ic-helper)';
const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const ROI_CONFIG_PATH = './scripts/lib/roi-config.json';
const TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 2;

function jstNowIso() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readLastTick() {
  if (!existsSync(HISTORY_PATH)) return null;
  const txt = readFileSync(HISTORY_PATH, 'utf8').trim();
  if (!txt) return null;
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      continue;
    }
  }
  return null;
}

function readArrivalsJson() {
  try {
    return JSON.parse(readFileSync('./data/arrivals.json', 'utf8'));
  } catch (e) {
    console.error(`[observe] arrivals.json read failed: ${e.message}`);
    return null;
  }
}

function readArrivalsState(arrivals) {
  if (!arrivals) return null;
  const updatedAt = arrivals.updatedAt ?? null;
  const total = arrivals.stats?.totalEstimatedTaxiPax ?? null;
  let lagSec = null;
  if (updatedAt) {
    lagSec = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000);
  }
  return { updated_at: updatedAt, total_estimated_taxi_pax: total, lag_seconds: lagSec };
}

function readWeather() {
  try {
    const j = JSON.parse(readFileSync('./data/weather.json', 'utf8'));
    return {
      code: j.current?.weatherCode ?? null,
      lightning_active: !!j.current?.lightningActive
    };
  } catch (e) {
    console.error(`[observe] weather.json read failed: ${e.message}`);
    return null;
  }
}

function readRoiConfig() {
  try {
    return JSON.parse(readFileSync(ROI_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[observe] roi-config.json read failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const ts = jstNowIso();

  let buf1, buf2;
  try {
    [buf1, buf2] = await Promise.all([
      fetchImage(REAL01_URL),
      fetchImage(REAL02_URL)
    ]);
  } catch (e) {
    console.error(`[observe] image fetch failed: ${e.message}`);
    if (e.cause) {
      console.error(`[observe] cause: ${e.cause.code ?? ''} ${e.cause.message ?? e.cause}`);
    }
    console.error('[observe] skipping this tick (no jsonl append)');
    process.exit(0);
  }

  const tsSafe = ts.replace(/[:+]/g, '-');
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real01.jpg`, buf1);
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real02.jpg`, buf2);

  const lastTick = readLastTick();
  const prev1 = lastTick?.img1 ?? null;
  const prev2 = lastTick?.img2 ?? null;
  const tickSeq = (lastTick?.tick_seq ?? 0) + 1;

  const roiConfig = readRoiConfig();
  const roi1 = roiConfig?.real01_line ?? null;
  const roi2 = roiConfig?.real02 ?? null;

  let img1, img2;
  try {
    img1 = await analyzePoolImage(buf1, prev1, roi1);
    img2 = await analyzePoolImage(buf2, prev2, roi2);
  } catch (e) {
    console.error(`[observe] image analyze failed: ${e.message}`);
    process.exit(0);
  }

  const arrivalsJson = readArrivalsJson();
  const arrivalsState = readArrivalsState(arrivalsJson);
  const arrivalsWindow = arrivalsJson
    ? summarizeArrivalsWindow(arrivalsJson, new Date())
    : null;
  const weather = readWeather();

  const row = {
    schema_version: SCHEMA_VERSION,
    ts,
    tick_seq: tickSeq,
    img1: { name: 'Real01_line', ...img1 },
    img2: { name: 'Real02', ...img2 },
    arrivals_state: arrivalsState,
    arrivals_window: arrivalsWindow,
    weather
  };

  appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n', 'utf8');
  console.log(`[observe] appended tick_seq=${tickSeq} ts=${ts} (schema_version=${SCHEMA_VERSION})`);
  console.log(`[observe] img1 edge=${img1.roi?.edge_density ?? 'n/a'} black=${img1.black_ratio} lum=${img1.roi?.luminance_mean ?? 'n/a'}`);
  console.log(`[observe] img2 edge=${img2.roi?.edge_density ?? 'n/a'} black=${img2.black_ratio} lum=${img2.roi?.luminance_mean ?? 'n/a'}`);
  if (arrivalsWindow) {
    console.log(`[observe] arrivals_window flights=${arrivalsWindow.flight_count} taxi_pax_sum=${arrivalsWindow.estimated_taxi_pax_sum}`);
  }
}

main().catch(e => {
  console.error(`[observe] unexpected error: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 4.2: 構文チェック**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --check scripts/observe-taxi-pool.mjs
```

期待: 何も出力されない。

- [ ] **Step 4.3: ローカルで run-once 実行 (実 ttc.taxi-inf.jp へアクセス、jsonl に schema v2 で追加)**

```bash
node scripts/observe-taxi-pool.mjs 2>&1 | tail -10
```

期待:
```
[observe] appended tick_seq=119 ts=2026-05-11T... (schema_version=2)
[observe] img1 edge=0.X black=0.X lum=XXX
[observe] img2 edge=0.X black=0.X lum=XXX
[observe] arrivals_window flights=N taxi_pax_sum=M
```

- [ ] **Step 4.4: jsonl の最終行を目視確認**

```bash
tail -1 data/taxi-pool-history.jsonl | python3 -m json.tool
```

期待: `schema_version: 2` / `img1.roi.edge_density` / `arrivals_window.estimated_taxi_pax_sum` の値が揃った 1 行。

- [ ] **Step 4.5: 全テスト実行**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス。

- [ ] **Step 4.6: コミット**

```bash
git add scripts/observe-taxi-pool.mjs
git commit -m "feat(observe): emit schema v2 with ROI analysis and arrivals_window"
```

---

## Task 5: `docs/research/taxi-pool-observation.md` を schema v2 仕様に更新

**Files:**
- Modify: `docs/research/taxi-pool-observation.md`

- [ ] **Step 5.1: スキーマセクションを追記**

`docs/research/taxi-pool-observation.md` の冒頭 (タイトル直下、利用規約セクションの上) に以下を挿入:

```markdown
## スキーマ履歴

- **v1** (2026-05-10 〜 2026-05-11、118 行): `img.black_ratio` / `img.diff_from_prev` / `arrivals_state.total_estimated_taxi_pax`
- **v2** (2026-05-11 〜): `schema_version: 2` フィールドあり。`img.roi.edge_density` / `img.roi.luminance_mean` / `arrivals_window.estimated_taxi_pax_sum` を追加。v1 フィールドは互換のため保持

詳細は `docs/superpowers/specs/2026-05-11-observation-schema-v2-design.md`。

```

- [ ] **Step 5.2: Phase B 分析手順の Python スニペットを v2 向けに拡張**

`### 2. ピボット可能な形式に変換` セクションの Python コードブロックを以下に置き換える (既存ブロックの拡張):

旧:
```python
import pandas as pd
df = pd.read_json('data/taxi-pool-history.jsonl', lines=True)
df['ts'] = pd.to_datetime(df['ts'])
df['hour'] = df['ts'].dt.hour
df['weekday'] = df['ts'].dt.weekday  # 0=月
df['black_ratio_1'] = df['img1'].apply(lambda x: x['black_ratio'])
df['black_ratio_2'] = df['img2'].apply(lambda x: x['black_ratio'])
df['diff_1'] = df['img1'].apply(lambda x: x.get('diff_from_prev'))
df['diff_2'] = df['img2'].apply(lambda x: x.get('diff_from_prev'))
df['est_taxi_pax'] = df['arrivals_state'].apply(
    lambda x: x.get('total_estimated_taxi_pax') if x else None
)
df['weather_code'] = df['weather'].apply(lambda x: x.get('code') if x else None)
```

新:
```python
import pandas as pd
df = pd.read_json('data/taxi-pool-history.jsonl', lines=True)
df['ts'] = pd.to_datetime(df['ts'])
df['hour'] = df['ts'].dt.hour
df['weekday'] = df['ts'].dt.weekday
df['schema'] = df.get('schema_version', pd.Series([None] * len(df))).fillna(1).astype(int)

# v1 互換フィールド (全行で有効)
df['black_ratio_1'] = df['img1'].apply(lambda x: x['black_ratio'])
df['black_ratio_2'] = df['img2'].apply(lambda x: x['black_ratio'])

# v2 専用フィールド (schema_version=2 の行だけ)
def get_nested(x, *keys):
    for k in keys:
        if x is None: return None
        x = x.get(k) if isinstance(x, dict) else None
    return x

df['edge_density_1'] = df['img1'].apply(lambda x: get_nested(x, 'roi', 'edge_density'))
df['edge_density_2'] = df['img2'].apply(lambda x: get_nested(x, 'roi', 'edge_density'))
df['luminance_mean_1'] = df['img1'].apply(lambda x: get_nested(x, 'roi', 'luminance_mean'))
df['window_taxi_pax'] = df['arrivals_window'].apply(lambda x: get_nested(x, 'estimated_taxi_pax_sum'))
df['window_flights'] = df['arrivals_window'].apply(lambda x: get_nested(x, 'flight_count'))

df['weather_code'] = df['weather'].apply(lambda x: get_nested(x, 'code'))

# v2 だけのサブセット
v2 = df[df['schema'] == 2].copy()
print(f"v1 行: {(df['schema'] == 1).sum()}, v2 行: {len(v2)}")
```

- [ ] **Step 5.3: 仮説検証セクションに新仮説 H5 を追加**

`#### H4: 深夜帯 (21:30〜) のラッシュ` の直下に以下を追加:

```markdown
#### H5 (v2 専用): edge_density と window_taxi_pax の相関

ROI エッジ密度 (= 実プールの車両在不在の照度ロバスト指標) と、時間窓予測タクシー
候補数の Pearson 相関を 1 時間バケットごとに計算。負の相関 (= 予測タクシー多い時
にプール空く) が見えれば「予測 vs 実」の有意な乖離が観測されたことになる。

```python
v2_hour = v2.groupby('hour').agg(
    edge1_mean=('edge_density_1', 'mean'),
    edge2_mean=('edge_density_2', 'mean'),
    window_taxi_mean=('window_taxi_pax', 'mean'),
    n=('ts', 'count')
)
print(v2_hour)
corr = v2[['edge_density_1', 'window_taxi_pax']].corr().iloc[0, 1]
print(f"edge_density_1 vs window_taxi_pax Pearson r = {corr:.3f}")
```
```

- [ ] **Step 5.4: Phase A 検証手順を追加**

`## Phase A の進捗チェックポイント` セクションの末尾に以下を追記:

```markdown

### schema_version=2 への移行検証 (実装直後 24 時間)

```bash
# 24 時間経過後に
git pull origin main
jq -r '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c
# 期待: v1=118 (旧)、v2 が 24 行以上 (Mac mini 稼働率による)

# v2 の edge_density 分布
jq -r 'select(.schema_version==2) | "\(.ts) \(.img1.roi.edge_density) \(.img1.roi.luminance_mean)"' data/taxi-pool-history.jsonl | head -30
# 期待: edge_density が 0.0〜1.0 内、夜間も日中もそれぞれの値域に分散

# arrivals_window が時間帯ごとに動いているか
jq -r 'select(.schema_version==2) | "\(.ts) \(.arrivals_window.estimated_taxi_pax_sum)"' data/taxi-pool-history.jsonl | head -30
# 期待: 時間帯で 0 〜 数百の値が変動、14,000 で定数化していない
```
```

- [ ] **Step 5.5: コミット**

```bash
git add docs/research/taxi-pool-observation.md
git commit -m "docs(research): update playbook for schema v2 fields and validation"
```

---

## Task 6: ローカル動作確認 + push + Mac mini への反映

**Files:** 変更なし (運用作業)

- [ ] **Step 6.1: ローカルでテスト全件 + run-once 最終確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
npm test 2>&1 | tail -5
# 期待: 全件パス (306 件以上)

# 直前の launchd 状態確認
./scripts/install-observe-launchd.sh status | head -5
```

- [ ] **Step 6.2: origin の最新を取り込んで push**

```bash
git fetch origin
git pull --rebase --autostash origin main 2>&1 | tail -3
git log --oneline origin/main..HEAD
# 期待: Task 1〜5 の commit が並ぶ
git push origin main 2>&1 | tail -3
```

- [ ] **Step 6.3: Mac mini 側で git pull (ユーザー手動)**

Mac mini にログインして:

```bash
cd ~/repos/taxi-ic-helper  # または Mac mini 上のクローン先
git pull origin main
npm install   # 念のため依存解決 (jimp など追加変更なしなら no-op)
```

- [ ] **Step 6.4: Mac mini で run-once 動作確認 (ユーザー手動)**

```bash
./scripts/install-observe-launchd.sh run-once 2>&1 | tail -10
```

期待: `[observe] appended tick_seq=N ts=2026-05-... (schema_version=2)` と
`[observe] img1 edge=0.X` が出る。jsonl に schema_version=2 で追記され git push 成功。

- [ ] **Step 6.5: 観測継続を MacBook 側から確認**

```bash
# MacBook 側で
sleep 60   # Mac mini の次の launchd tick (15 分以内) を待つ場合は適宜
git pull origin main
tail -1 data/taxi-pool-history.jsonl | jq '{schema: .schema_version, edge1: .img1.roi.edge_density, window: .arrivals_window.estimated_taxi_pax_sum}'
```

期待: `schema: 2 / edge1: 数値 / window: 数値` の 1 行。

- [ ] **Step 6.6: 24 時間後の検証 (Mac mini を 1 日放置してから)**

```bash
git pull origin main
jq -r '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c
# 期待: 1=118 (旧)、2=24 以上 (Mac mini 稼働率 by 8〜24h)

# edge_density と window_taxi_pax の値域確認
python3 << 'EOF'
import json
v2 = [json.loads(l) for l in open('data/taxi-pool-history.jsonl') if '"schema_version": 2' in l]
print(f"v2 件数: {len(v2)}")
edges = [r['img1']['roi']['edge_density'] for r in v2 if r['img1'].get('roi')]
windows = [r['arrivals_window']['estimated_taxi_pax_sum'] for r in v2 if r['arrivals_window']]
print(f"edge_density_1: min={min(edges):.3f} max={max(edges):.3f} mean={sum(edges)/len(edges):.3f}")
print(f"window_taxi_pax_sum: min={min(windows)} max={max(windows)} mean={sum(windows)/len(windows):.1f}")
EOF
```

期待:
- v2 が 24 行以上
- `edge_density_1` の min/max が分離している (例: min=0.05、max=0.30 など)、定数ではない
- `window_taxi_pax_sum` の min/max が分離している (例: min=10、max=300 など)、定数ではない

両方満たせば Phase B 分析セッションに進める根拠データが揃っている。

---

## 検証コマンド一覧 (チートシート)

```bash
# 全テスト
npm test

# 個別テスト
node --test tests/image-pool-analyzer.test.mjs
node --test tests/arrivals-window-summary.test.mjs

# 構文チェック
node --check scripts/lib/image-pool-analyzer.mjs
node --check scripts/lib/arrivals-window-summary.mjs
node --check scripts/observe-taxi-pool.mjs

# JSON valid
python3 -c "import json; json.load(open('scripts/lib/roi-config.json'))"

# 1 tick 実行
node scripts/observe-taxi-pool.mjs

# 最新 jsonl 1 行を pretty
tail -1 data/taxi-pool-history.jsonl | jq .

# schema_version の分布
jq -r '.schema_version // 1' data/taxi-pool-history.jsonl | sort | uniq -c

# launchd ジョブ状態 (Mac mini で)
./scripts/install-observe-launchd.sh status
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (現在 294 + 11 = 305 件以上)
- [ ] `scripts/lib/roi-config.json` が存在し JSON valid
- [ ] `scripts/observe-taxi-pool.mjs` で `node scripts/observe-taxi-pool.mjs` が schema_version=2 で 1 行追記する
- [ ] Mac mini に新コードが pull され、`run-once` で schema_version=2 が追加される
- [ ] 24 時間後に jsonl の v2 行が 24 行以上、`edge_density` と `window_taxi_pax_sum` が時間帯で変動する分布
- [ ] `docs/research/taxi-pool-observation.md` が schema_version=2 仕様と H5 仮説を含む

## Phase B への引き継ぎ

Phase A v2 検証 (Task 6.6) が満たされたら、Phase B 分析セッションを別途立ち上げる。
本プランの完了基準には Phase B は含まない。Phase B では 14 日分蓄積後に
`docs/research/taxi-pool-observation.md` の H1〜H5 を Python で検証し、係数
校正案を Phase C spec として起こす。
