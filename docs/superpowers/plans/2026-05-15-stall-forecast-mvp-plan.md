# 短期需要予測 MVP (stall ベース) 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stall1-4 別の過去出庫パターン (baseline) × 直近トレンド × 今日の便量 で 5 分粒度 × 24 slot (2 時間先) の予測を生成し、observe-tick で更新、forecast.html で表示する MVP を完成させる。

**Architecture:** 純関数 `computeBaseline` + `computeForecast` を `scripts/lib/forecast-engine.mjs` に集約。observe-tick の末尾で呼び出し、失敗時も本観測 jsonl 追記は継続。フロントは `data/stall-forecast.json` を fetch して表テーブルを描画。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS / GitHub Actions (Pages) / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-15-stall-forecast-mvp-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/forecast-engine.mjs` | Create | 純関数: `computeBaseline(history, options)`, `computeForecast(baseline, recentHistory, arrivalsJson, now, options)` |
| `tests/forecast-engine.test.mjs` | Create | `computeBaseline` / `computeForecast` の単体テスト 10 件 |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾で forecast 生成 → `data/stall-forecast.json` 書き込み (try/catch で本観測に影響しない) |
| `data/stall-forecast.json` | Create (生成物) | 5min × stall1-4 × 24 slot |
| `forecast.html` | Create | 予測表示ページ (GitHub Pages 公開) |
| `js/forecast-app.js` | Create | エントリ (`data/stall-forecast.json` を fetch → render) |
| `js/forecast-render.js` | Create | テーブル描画関数 |
| `arrivals.html` | Modify | ヘッダーに forecast.html へのリンクを追加 (1 行) |

実装順序: **純関数 + テスト先行 (TDD) → observe-tick 統合 → フロント表示**。observe-tick 統合時にはまだ `data/stall-forecast.json` は存在しないので、observe-tick の改修と最初の生成は同時に行う。

---

## Task 1: `forecast-engine.mjs` のスケルトン作成

**Files:**
- Create: `scripts/lib/forecast-engine.mjs`

- [ ] **Step 1.1: 空ファイルとモジュール定数を作成**

`scripts/lib/forecast-engine.mjs` の内容:

```javascript
/**
 * 短期需要予測エンジン (stall ベース MVP)。
 *
 * 設計: docs/superpowers/specs/2026-05-15-stall-forecast-mvp-design.md
 *
 * 純関数のみ (副作用なし)。observe-taxi-pool.mjs から呼ばれる。
 */

export const SLOTS_PER_HOUR = 12; // 5 min slot
export const SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR; // 288
export const FORECAST_SLOT_COUNT = 24; // 2 時間先 = 24 slot
export const NIGHT_LUMINANCE_THRESHOLD = 30; // 信頼サブセット条件
export const TREND_WINDOW_TICKS = 12; // 直近 60 分
export const TREND_FACTOR_MIN = 0.3;
export const TREND_FACTOR_MAX = 3.0;
export const FLIGHT_FACTOR_MIN = 0.3;
export const FLIGHT_FACTOR_MAX = 3.0;
export const FORECAST_SCHEMA_VERSION = 1;

/**
 * (hour, minute) → 0-287 の slot index を返す。
 */
export function slotKey(hour, minute) {
  return hour * SLOTS_PER_HOUR + Math.floor(minute / 5);
}

/**
 * 数値を [min, max] にクリップする。
 */
export function clip(value, min, max) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 1.0;
  return Math.max(min, Math.min(max, value));
}
```

- [ ] **Step 1.2: 構文チェック**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --check scripts/lib/forecast-engine.mjs
```

期待: 何も出力されない (構文 OK)。

- [ ] **Step 1.3: commit**

```bash
git add scripts/lib/forecast-engine.mjs
git commit -m "feat(forecast): add forecast-engine scaffold with constants"
```

---

## Task 2: `computeBaseline` の実装 (TDD)

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs`
- Create: `tests/forecast-engine.test.mjs`

- [ ] **Step 2.1: 失敗テスト 4 件を追加**

`tests/forecast-engine.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  slotKey, clip, computeBaseline, SLOTS_PER_DAY,
} from '../scripts/lib/forecast-engine.mjs';

test('slotKey: 17:30 → 17*12 + 6 = 210', () => {
  assert.equal(slotKey(17, 30), 210);
});

test('slotKey: 0:00 → 0、23:55 → 287', () => {
  assert.equal(slotKey(0, 0), 0);
  assert.equal(slotKey(23, 55), 287);
});

test('clip: 範囲内はそのまま、範囲外はクランプ、NaN は 1.0', () => {
  assert.equal(clip(0.5, 0.3, 3.0), 0.5);
  assert.equal(clip(0.1, 0.3, 3.0), 0.3);
  assert.equal(clip(5.0, 0.3, 3.0), 3.0);
  assert.equal(clip(NaN, 0.3, 3.0), 1.0);
  assert.equal(clip(Infinity, 0.3, 3.0), 1.0);
});

// --- computeBaseline ---

function makeRow(ts, lum, stall1Diff, stall2Diff, stall3Diff, stall4Diff) {
  return {
    schema_version: 3,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: stall1Diff, occupied_estimate: 5, capacity: 8 },
      stall2: { diff_occupied_from_prev: stall2Diff, occupied_estimate: 5, capacity: 7 },
      stall3: { diff_occupied_from_prev: stall3Diff, occupied_estimate: 5, capacity: 8 },
      stall4: { diff_occupied_from_prev: stall4Diff, occupied_estimate: 5, capacity: 8 },
    },
  };
}

test('computeBaseline: 信頼サブセット 0 行 → 全 slot null + sampleCount 0', () => {
  const r = computeBaseline([]);
  assert.equal(r.sampleCount, 0);
  assert.equal(r.slots.length, SLOTS_PER_DAY);
  for (const s of r.slots) {
    for (const stall of ['stall1', 'stall2', 'stall3', 'stall4']) {
      assert.equal(s[stall], null);
    }
  }
});

test('computeBaseline: 同 slot に複数サンプル → 平均が返る (-値だけ集計)', () => {
  // 12:00 に stall1=-2 と stall1=-4 (出庫) を 2 件、他は 0
  const history = [
    makeRow('2026-05-13T12:00:00+09:00', 100, -2, 0, 0, 0),
    makeRow('2026-05-13T12:00:00+09:00', 100, -4, 0, 0, 0),
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(12, 0)];
  // 出庫平均 = (2 + 4) / 2 = 3
  assert.equal(slot.stall1, 3);
  assert.equal(slot.stall2, 0);
  assert.equal(r.sampleCount, 2);
});

test('computeBaseline: 夜間 (luminance<30) は除外', () => {
  const history = [
    makeRow('2026-05-13T03:00:00+09:00', 10, -5, 0, 0, 0), // 夜間 → 除外
    makeRow('2026-05-13T03:00:00+09:00', 100, -1, 0, 0, 0), // 日中 → 採用
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(3, 0)];
  assert.equal(slot.stall1, 1);
  assert.equal(r.sampleCount, 1);
});

test('computeBaseline: 正の diff (入庫) は出庫としてカウントしない', () => {
  const history = [
    makeRow('2026-05-13T12:00:00+09:00', 100, 3, 0, 0, 0), // 入庫
    makeRow('2026-05-13T12:00:00+09:00', 100, -2, 0, 0, 0), // 出庫
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(12, 0)];
  // 出庫平均 = (0 + 2) / 2 = 1
  assert.equal(slot.stall1, 1);
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
node --test tests/forecast-engine.test.mjs 2>&1 | tail -10
```

期待: `computeBaseline is not defined` で失敗。`slotKey` / `clip` 3 件はパス。

- [ ] **Step 2.3: `computeBaseline` を実装**

`scripts/lib/forecast-engine.mjs` の末尾に追加:

```javascript
/**
 * 信頼サブセットの jsonl 行群から stall 別 × 288 slot の出庫平均を返す。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean >= 30
 *                    ∧ stalls 非 null
 *
 * @param {Array} history jsonl 行の配列
 * @returns {{slots: Array, sampleCount: number}}
 *   slots[i] = { stall1, stall2, stall3, stall4 } (各値は null または出庫平均)
 */
export function computeBaseline(history) {
  const sums = Array.from({ length: SLOTS_PER_DAY }, () => ({
    stall1: 0, stall2: 0, stall3: 0, stall4: 0, count: 0,
  }));
  let sampleCount = 0;
  for (const row of history) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const ts = new Date(row.ts);
    if (Number.isNaN(ts.getTime())) continue;
    const slot = slotKey(ts.getHours(), ts.getMinutes());
    const acc = sums[slot];
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const d = row.stalls[name]?.diff_occupied_from_prev;
      if (typeof d !== 'number') continue;
      acc[name] += d < 0 ? -d : 0;
    }
    acc.count += 1;
    sampleCount += 1;
  }
  const slots = sums.map(s => {
    if (s.count === 0) {
      return { stall1: null, stall2: null, stall3: null, stall4: null };
    }
    return {
      stall1: s.stall1 / s.count,
      stall2: s.stall2 / s.count,
      stall3: s.stall3 / s.count,
      stall4: s.stall4 / s.count,
    };
  });
  return { slots, sampleCount };
}
```

- [ ] **Step 2.4: テスト再実行 → 全件パス**

```bash
node --test tests/forecast-engine.test.mjs 2>&1 | tail -10
```

期待: 全 7 件パス (slotKey 2 / clip 1 / computeBaseline 4)。

- [ ] **Step 2.5: 全テストスイート (回帰確認)**

```bash
npm test 2>&1 | tail -8
```

期待: 310 + 7 = 317 件パス。

- [ ] **Step 2.6: commit**

```bash
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git commit -m "feat(forecast): implement computeBaseline (slot × stall average outflow)"
```

---

## Task 3: `computeForecast` の実装 (TDD)

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs`
- Modify: `tests/forecast-engine.test.mjs`

- [ ] **Step 3.1: テスト 6 件追加**

`tests/forecast-engine.test.mjs` の末尾に追加:

```javascript
import { computeForecast, FORECAST_SLOT_COUNT, FORECAST_SCHEMA_VERSION } from '../scripts/lib/forecast-engine.mjs';

function makeBaseline(stallValues) {
  // stallValues: [[stall1, stall2, stall3, stall4], ...] 長さ 288
  const slots = stallValues.map(v => ({ stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3] }));
  return { slots, sampleCount: stallValues.length };
}

function makeArrivals(flights) {
  return { flights };
}

test('computeForecast: baseline 全 0 → 全 slot 予測 0', () => {
  const baseline = { slots: Array(288).fill({ stall1: 0, stall2: 0, stall3: 0, stall4: 0 }), sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.slots.length, FORECAST_SLOT_COUNT);
  assert.equal(r.slots[0].total, 0);
  assert.equal(r.slots[0].stall1, 0);
});

test('computeForecast: baseline=1.0, trendFactor=1, flightFactor=1 → 予測 1', () => {
  // baseline 全 slot で stall1=1.0
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  // 現在 12:00、recent 12 ticks の実測 = 期待値と一致 → trendFactor=1
  // 12:00 から 12:55 までの 12 slot (= -60 分) を埋める
  const recent = Array.from({ length: 12 }, (_, i) => {
    const min = i * 5;
    return {
      ts: new Date(2026, 4, 15, 11, min, 0).toISOString().replace('Z', '+09:00'),
      total_outflow: 1.0, // 実測 = baseline 期待
    };
  });
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  // arrivals 空 → flightFactor=1.0 (全 slot 共通)
  // baseline stall1=1.0, trendFactor≈1.0, flightFactor=1.0 → 予測 1
  assert.equal(r.slots[0].stall1, 1);
  assert.equal(r.slots[0].total, 1);
});

test('computeForecast: trendFactor 計算 (直近実測が期待値の 2 倍)', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  // recent_actual = 24, recent_expected = 12 → trendFactor=2.0
  const recent = Array.from({ length: 12 }, (_, i) => {
    return {
      ts: new Date(2026, 4, 15, 11, i * 5, 0).toISOString().replace('Z', '+09:00'),
      total_outflow: 2.0,
    };
  });
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  // baseline 1.0 × trendFactor 2.0 × flightFactor 1.0 = 2.0 → 2
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.trendFactor, 2);
});

test('computeForecast: recent 不足 (12 行未満) → trendFactor=1.0', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.trendFactor, 1.0);
  assert.equal(r.slots[0].stall1, 1);
});

test('computeForecast: flightFactor 計算 (1 slot に大型便ピーク)', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  // 現在 12:00 → 12:05 slot (= slot index 0 of forecast) に lobbyExit 12:00 の便 1 件 (estimatedTaxiPax=24)
  // 他 23 slot には便なし → 平均 = 24/24 = 1
  // flightFactor[0] = 24 / 1 = 24 → clip 3.0
  const arrivals = makeArrivals([
    { lobbyExitTime: '12:00', estimatedTaxiPax: 24 },
  ]);
  const r = computeForecast(baseline, [], arrivals, new Date('2026-05-15T12:00:00+09:00'));
  // slot 0 (12:00-12:05): baseline 1 × trendFactor 1 × flightFactor 3.0 = 3
  assert.equal(r.slots[0].flightFactor, 3.0);
  assert.equal(r.slots[0].stall1, 3);
});

test('computeForecast: 出力 JSON スキーマ - 必須フィールドが揃う', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 0.5, stall2: 0.5, stall3: 0.5, stall4: 0.5 }));
  const baseline = { slots, sampleCount: 500 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T17:30:00+09:00'));
  assert.equal(r.schemaVersion, FORECAST_SCHEMA_VERSION);
  assert.ok(r.generatedAt);
  assert.equal(typeof r.trendFactor, 'number');
  assert.equal(r.baselineSampleCount, 500);
  assert.equal(r.slots.length, FORECAST_SLOT_COUNT);
  const s = r.slots[0];
  assert.equal(s.slotStart, '17:30');
  assert.equal(s.slotEnd, '17:35');
  assert.equal(typeof s.flightFactor, 'number');
  assert.equal(typeof s.stall1, 'number');
  assert.equal(typeof s.total, 'number');
});
```

- [ ] **Step 3.2: テスト実行 → 失敗確認**

```bash
node --test tests/forecast-engine.test.mjs 2>&1 | tail -10
```

期待: `computeForecast is not defined` で失敗。

- [ ] **Step 3.3: `computeForecast` を実装**

`scripts/lib/forecast-engine.mjs` の末尾に追加:

```javascript
/**
 * 現在時刻から +5min〜+120min (24 slot) の予測を返す。
 *
 * @param {{slots: Array, sampleCount: number}} baseline
 * @param {Array} recentHistory 直近 12 tick の jsonl 行 (古→新の順)、各行に total_outflow があれば使う
 * @param {{flights: Array}|null} arrivalsJson arrivals.json (flights[].lobbyExitTime, .estimatedTaxiPax を使う)
 * @param {Date} now 現在時刻 (JST)
 * @returns 予測オブジェクト
 */
export function computeForecast(baseline, recentHistory, arrivalsJson, now) {
  const nowSlot = slotKey(now.getHours(), now.getMinutes());

  // trendFactor: 直近 12 tick の実測合計 / 同期間 baseline の全 stall 合計
  let trendFactor = 1.0;
  let trendActual = 0;
  let trendExpected = 0;
  if (recentHistory.length >= TREND_WINDOW_TICKS) {
    const window = recentHistory.slice(-TREND_WINDOW_TICKS);
    for (const row of window) {
      if (typeof row.total_outflow === 'number') {
        trendActual += row.total_outflow;
      }
      const ts = new Date(row.ts);
      if (!Number.isNaN(ts.getTime())) {
        const slot = baseline.slots[slotKey(ts.getHours(), ts.getMinutes())];
        if (slot && slot.stall1 !== null) {
          trendExpected += (slot.stall1 + slot.stall2 + slot.stall3 + slot.stall4);
        }
      }
    }
    if (trendExpected > 0) {
      trendFactor = clip(trendActual / trendExpected, TREND_FACTOR_MIN, TREND_FACTOR_MAX);
    }
  }

  // flightFactor: 今日 arrivals.json の slot 別 estimatedTaxiPax 合計 / 今日 24 slot 平均
  // 24 slot = 現在 +5min〜+120min の範囲
  const flightSums = new Array(FORECAST_SLOT_COUNT).fill(0);
  if (arrivalsJson && Array.isArray(arrivalsJson.flights)) {
    for (const f of arrivalsJson.flights) {
      if (!f.lobbyExitTime || typeof f.estimatedTaxiPax !== 'number') continue;
      const [h, m] = f.lobbyExitTime.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) continue;
      const lobbySlot = slotKey(h, m);
      // 現在 slot を 0 とした 24 slot の中に入るか
      // forecast の slot i = nowSlot+1+i (≤ 288 で wrap)
      for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
        const targetSlot = (nowSlot + 1 + i) % SLOTS_PER_DAY;
        if (lobbySlot === targetSlot) {
          flightSums[i] += f.estimatedTaxiPax;
          break;
        }
      }
    }
  }
  const dailyAvg = flightSums.reduce((s, v) => s + v, 0) / FORECAST_SLOT_COUNT;
  const flightFactors = flightSums.map(s => {
    if (dailyAvg <= 0) return 1.0;
    return clip(s / dailyAvg, FLIGHT_FACTOR_MIN, FLIGHT_FACTOR_MAX);
  });

  // forecast 各 slot
  const outSlots = [];
  for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
    const targetSlot = (nowSlot + 1 + i) % SLOTS_PER_DAY;
    const slotStartMin = ((nowSlot + 1 + i) % SLOTS_PER_DAY) * 5;
    const startH = Math.floor(slotStartMin / 60);
    const startM = slotStartMin % 60;
    const endTotal = slotStartMin + 5;
    const endH = Math.floor(endTotal / 60) % 24;
    const endM = endTotal % 60;
    const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const base = baseline.slots[targetSlot] || { stall1: null, stall2: null, stall3: null, stall4: null };
    const f = flightFactors[i];
    const slotOut = { slotStart: fmt(startH, startM), slotEnd: fmt(endH, endM), flightFactor: f };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const b = base[name];
      const val = (b === null || b === undefined) ? 0 : Math.round(b * trendFactor * f);
      slotOut[name] = val;
      total += val;
    }
    slotOut.total = total;
    outSlots.push(slotOut);
  }

  return {
    schemaVersion: FORECAST_SCHEMA_VERSION,
    generatedAt: now.toISOString().replace('Z', '+09:00').replace(/\.\d+/, ''),
    trendFactor,
    trendWindow: { actual: trendActual, expected: trendExpected, ticks: Math.min(recentHistory.length, TREND_WINDOW_TICKS) },
    baselineSampleCount: baseline.sampleCount,
    slots: outSlots,
  };
}
```

- [ ] **Step 3.4: テスト再実行 → 全件パス**

```bash
node --test tests/forecast-engine.test.mjs 2>&1 | tail -15
```

期待: 全 13 件 (Task 2 の 7 件 + Task 3 の 6 件) パス。

- [ ] **Step 3.5: 全テストスイート**

```bash
npm test 2>&1 | tail -8
```

期待: 310 + 13 = 323 件パス。

- [ ] **Step 3.6: commit**

```bash
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git commit -m "feat(forecast): implement computeForecast (trendFactor + flightFactor)"
```

---

## Task 4: `observe-taxi-pool.mjs` に forecast 生成を組み込み

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 4.1: import 文の追加**

`scripts/observe-taxi-pool.mjs` の既存 import 群 (24 行目あたり) の最後に追加:

```javascript
import { computeBaseline, computeForecast } from './lib/forecast-engine.mjs';
```

既存 import 例:
```javascript
import { detectDepartures } from './lib/departure-detector.mjs';
```
の直後に。

- [ ] **Step 4.2: 定数追加**

`SNAPSHOTS_DIR` の定義のすぐ下に追加:

```javascript
const FORECAST_OUTPUT_PATH = './data/stall-forecast.json';
```

- [ ] **Step 4.3: forecast 生成ロジックを `main()` 末尾に追加**

`appendFileSync(HISTORY_PATH, ...)` でメインの jsonl 追記が終わった直後 (snapshot 書き込みより前か後はどちらでも可。`snapshot` ブロックの後ろに置く)、`console.log('[observe] appended ...')` の前に挿入:

```javascript
  // Phase C-1 MVP: stall 短期需要予測の生成
  // 失敗しても本観測には影響させない (try/catch で握る)
  try {
    const allHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const allHistory = [];
    for (const line of allHistoryLines) {
      if (!line.trim()) continue;
      try { allHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const baseline = computeBaseline(allHistory);

    // 直近 12 tick (60 分) の total_outflow 計算用
    const recent = allHistory.slice(-12).map(row => {
      const stalls = row.stalls || {};
      let totalOutflow = 0;
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const d = stalls[name]?.diff_occupied_from_prev;
        if (typeof d === 'number' && d < 0) totalOutflow += -d;
      }
      return { ts: row.ts, total_outflow: totalOutflow };
    });

    const forecast = computeForecast(baseline, recent, arrivalsJson, new Date());
    writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(forecast, null, 2) + '\n', 'utf8');
    console.log(`[observe] forecast ok: trendFactor=${forecast.trendFactor.toFixed(2)} baselineSamples=${forecast.baselineSampleCount}`);
  } catch (e) {
    console.error(`[observe] forecast generation failed: ${e.message}`);
  }
```

- [ ] **Step 4.4: 構文チェック**

```bash
node --check scripts/observe-taxi-pool.mjs
```

期待: 何も出力されない。

- [ ] **Step 4.5: 単発実行で forecast.json が生成されるか確認**

```bash
node scripts/observe-taxi-pool.mjs 2>&1 | tail -10
```

期待: 出力に `[observe] forecast ok: trendFactor=... baselineSamples=...` が含まれる。

- [ ] **Step 4.6: 生成された stall-forecast.json を確認**

```bash
ls -la data/stall-forecast.json
python3 -c "
import json
d = json.load(open('data/stall-forecast.json'))
print(f'schemaVersion: {d[\"schemaVersion\"]}')
print(f'generatedAt: {d[\"generatedAt\"]}')
print(f'trendFactor: {d[\"trendFactor\"]}')
print(f'baselineSampleCount: {d[\"baselineSampleCount\"]}')
print(f'slots: {len(d[\"slots\"])} 個')
print(f'first slot: {d[\"slots\"][0]}')
"
```

期待:
- `slots: 24 個`
- first slot に `slotStart`, `slotEnd`, `flightFactor`, `stall1-4`, `total` が含まれる

- [ ] **Step 4.7: 全テスト (回帰確認)**

```bash
npm test 2>&1 | tail -8
```

期待: 323 件パス。

- [ ] **Step 4.8: commit**

```bash
git add scripts/observe-taxi-pool.mjs data/stall-forecast.json
git commit -m "feat(observe): generate stall-forecast.json each tick"
```

---

## Task 5: `forecast.html` + `js/forecast-app.js` + `js/forecast-render.js`

**Files:**
- Create: `forecast.html`
- Create: `js/forecast-app.js`
- Create: `js/forecast-render.js`
- Modify: `arrivals.html` (ヘッダーに forecast.html へのリンク追加)

- [ ] **Step 5.1: `forecast.html` を作成**

`forecast.html` の内容:

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>羽田タクシー需要予測</title>
  <link rel="stylesheet" href="css/arrivals.css">
  <style>
    .forecast-meta { margin: 1em 0; color: #555; font-size: 0.9em; }
    .forecast-table { border-collapse: collapse; width: 100%; max-width: 720px; }
    .forecast-table th, .forecast-table td { padding: 4px 8px; border: 1px solid #ddd; text-align: right; font-variant-numeric: tabular-nums; }
    .forecast-table th { background: #f4f4f4; }
    .forecast-table td.time { text-align: left; font-weight: bold; }
    .forecast-table tr.tier-high { background: #fee2c4; }
    .forecast-table tr.tier-very-high { background: #fda47e; }
    .star { color: #d33; font-weight: bold; }
  </style>
</head>
<body>
  <header>
    <h1>羽田タクシー需要予測 (MVP)</h1>
    <nav>
      <a href="arrivals.html">← 到着便一覧</a>
    </nav>
  </header>
  <main>
    <div id="forecast-meta" class="forecast-meta">読み込み中...</div>
    <div id="forecast-table-wrap"></div>
  </main>
  <script type="module" src="js/forecast-app.js"></script>
</body>
</html>
```

- [ ] **Step 5.2: `js/forecast-render.js` を作成**

`js/forecast-render.js` の内容:

```javascript
/**
 * data/stall-forecast.json を受け取り、テーブルを描画する。
 */

const TIER_HIGH_THRESHOLD = 8;
const TIER_VERY_HIGH_THRESHOLD = 12;

export function renderForecastMeta(container, forecast) {
  if (!container || !forecast) return;
  const ts = forecast.generatedAt ? forecast.generatedAt.slice(0, 16).replace('T', ' ') : 'n/a';
  const trend = (forecast.trendFactor ?? 1).toFixed(2);
  const samples = forecast.baselineSampleCount ?? 0;
  container.innerHTML =
    `予測時刻 ${ts} JST / 直近トレンド × ${trend} / baseline サンプル ${samples} 行`;
}

export function renderForecastTable(container, forecast) {
  if (!container || !forecast) return;
  const rows = forecast.slots.map(s => {
    let tierClass = '';
    let mark = '';
    if (s.total >= TIER_VERY_HIGH_THRESHOLD) {
      tierClass = 'tier-very-high';
      mark = ' <span class="star">★★</span>';
    } else if (s.total >= TIER_HIGH_THRESHOLD) {
      tierClass = 'tier-high';
      mark = ' <span class="star">★</span>';
    }
    return `<tr class="${tierClass}">
      <td class="time">${s.slotStart}</td>
      <td>${s.stall1}</td>
      <td>${s.stall2}</td>
      <td>${s.stall3}</td>
      <td>${s.stall4}</td>
      <td><strong>${s.total}</strong>${mark}</td>
      <td>${s.flightFactor.toFixed(2)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `<table class="forecast-table">
    <thead><tr>
      <th>時刻</th><th>stall1</th><th>stall2</th><th>stall3</th><th>stall4</th><th>合計</th><th>便量×</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
```

- [ ] **Step 5.3: `js/forecast-app.js` を作成**

`js/forecast-app.js` の内容:

```javascript
import { renderForecastMeta, renderForecastTable } from './forecast-render.js';

async function main() {
  const metaEl = document.getElementById('forecast-meta');
  const tableEl = document.getElementById('forecast-table-wrap');
  try {
    const res = await fetch('data/stall-forecast.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const forecast = await res.json();
    renderForecastMeta(metaEl, forecast);
    renderForecastTable(tableEl, forecast);
  } catch (e) {
    metaEl.textContent = `予測データの読み込みに失敗: ${e.message}`;
    tableEl.innerHTML = '';
  }
}

main();
```

- [ ] **Step 5.4: `arrivals.html` にリンク追加**

`arrivals.html` の `<header>` 内に既存ナビがある場所を探し、`<a href="...">` の中に追加。具体的には `<h1>羽田到着便` などの近くに以下を追加:

```html
<a href="forecast.html">需要予測 →</a>
```

存在しない場合は `<header>` の中、`<h1>` の直後に:

```html
<nav><a href="forecast.html">需要予測 →</a></nav>
```

- [ ] **Step 5.5: ブラウザで forecast.html を確認**

GitHub Pages デプロイ前にローカルで確認:

```bash
# 簡易 HTTP サーバ (Python)
python3 -m http.server 8765 &
sleep 1
open http://localhost:8765/forecast.html
```

期待: テーブルが表示される。24 行 (slot) × 7 列 (時刻 + stall1-4 + 合計 + 便量倍率)。`★` 印が合計の高い slot に出る。

確認後にサーバを止める:
```bash
kill %1 2>/dev/null
```

- [ ] **Step 5.6: commit**

```bash
git add forecast.html js/forecast-app.js js/forecast-render.js arrivals.html
git commit -m "feat(forecast): add forecast.html viewer (stall × 24 slot table)"
```

---

## Task 6: 最終整合 + push

- [ ] **Step 6.1: 全テスト最終パス確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
npm test 2>&1 | tail -8
```

期待: 323 件パス。

- [ ] **Step 6.2: スコープ外ファイルに触っていないか確認**

```bash
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/lib/forecast-engine.mjs`
- `tests/forecast-engine.test.mjs`
- `scripts/observe-taxi-pool.mjs`
- `data/stall-forecast.json`
- `forecast.html`
- `js/forecast-app.js`
- `js/forecast-render.js`
- `arrivals.html`

- [ ] **Step 6.3: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

期待: 観測 tick / weather-update / arrivals-update があれば取り込み、自分の commit は HEAD 側に積み直し。

- [ ] **Step 6.4: 最終 push (3 回までリトライ)**

```bash
for i in 1 2 3; do
  if git push origin main; then
    echo "[push ok attempt $i]"
    break
  fi
  echo "[push retry $i]"
  git pull --rebase --autostash origin main
  sleep 2
done
```

期待: `[push ok attempt 1]` または 2-3 で成功。

- [ ] **Step 6.5: 本番 GitHub Pages 反映確認**

GitHub Pages 自動デプロイ後 (workflow_run で 1-2 分後):

```bash
sleep 90
curl -sf -o /tmp/forecast-prod.json https://hidenaka.github.io/taxi-ic-helper/data/stall-forecast.json
python3 -c "
import json
d = json.load(open('/tmp/forecast-prod.json'))
print(f'本番 forecast: trendFactor={d[\"trendFactor\"]:.2f} baseline n={d[\"baselineSampleCount\"]}')
print(f'first 3 slots: {[(s[\"slotStart\"], s[\"total\"]) for s in d[\"slots\"][:3]]}')
"
echo "---"
curl -sf -o /tmp/forecast-html.txt https://hidenaka.github.io/taxi-ic-helper/forecast.html
grep -c 'forecast-table\|タクシー需要予測' /tmp/forecast-html.txt
```

期待: 本番 JSON の中身が取れる、`forecast.html` に「タクシー需要予測」文字列が存在。

- [ ] **Step 6.6: 完了報告**

最終状態を要約。

---

## 検証コマンド一覧 (チートシート)

```bash
# 純関数テスト単独
node --test tests/forecast-engine.test.mjs

# 全テスト
npm test

# observe-tick の単発実行 (forecast 含む)
node scripts/observe-taxi-pool.mjs

# 生成 JSON 確認
python3 -c "import json; d=json.load(open('data/stall-forecast.json')); print(json.dumps(d, indent=2, ensure_ascii=False)[:1500])"

# ローカルブラウザ表示
python3 -m http.server 8765 &
open http://localhost:8765/forecast.html
# 終了
kill %1

# 本番 (GitHub Pages)
open https://hidenaka.github.io/taxi-ic-helper/forecast.html
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (310 → 323 件)
- [ ] `scripts/lib/forecast-engine.mjs` 純関数として実装、副作用なし
- [ ] observe-tick で `data/stall-forecast.json` が 5 分毎に更新される
- [ ] `forecast.html` が GitHub Pages で表示できる
- [ ] 観測 jsonl 追記との衝突なし (git push が継続稼働)
- [ ] サンプル不足を UI 上で明示 (`baseline サンプル N 行`)
- [ ] スコープ外ファイル (transit-share.json / arrivals.json / fetch-arrivals.mjs / observe-tick-local.sh) は触っていない
