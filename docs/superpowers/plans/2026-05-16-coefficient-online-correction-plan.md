# 係数オンライン補正 実装プラン (Phase D-3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** D-1 の `forecast-log.jsonl` と `arrivals-snapshots/` を実測 `taxi-pool-history` と突き合わせ、transit-share バケット率 (Stage 1) と forecast レベル (Stage 2) の系統バイアスを補正係数 `coefficient-corrections.json` として継続学習し、fetch-arrivals と ensemble に適用する。

**Architecture:** 純関数 `computeShareCorrection` / `computeLevelCorrection` / `applyLevelCorrection` / `buildEffectiveTransitShare` を `scripts/lib/correction-engine.mjs` に集約。observe-tick の D-1 (accuracy 評価) の後に補正を計算し `data/coefficient-corrections.json` を生成、level 補正を ensemble の forecast 入力に適用。fetch-arrivals は実効 transit-share を構築。`transit-share.json` と forecast 係数定数は不変。fail-safe で本観測 jsonl 追記は継続。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS / GitHub Actions (Pages) / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-coefficient-online-correction-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/correction-engine.mjs` | Create | 純関数: `computeShareCorrection`, `computeLevelCorrection`, `applyLevelCorrection`, `buildEffectiveTransitShare`, `clipFactor` |
| `tests/correction-engine.test.mjs` | Create | 単体テスト 16 件 |
| `data/coefficient-corrections.json` | Create (生成物) | share×8 バケット + level×3 leadBucket |
| `scripts/observe-taxi-pool.mjs` | Modify | D-3 ブロック追加 + ensemble 入力に level 補正適用 |
| `scripts/fetch-arrivals.mjs` | Modify | 実効 transit-share を構築して transformArrivals に渡す |
| `scripts/observe-tick-local.sh` | Modify | git add / checkout 対象に coefficient-corrections.json 追加 |
| `forecast.html` | Modify | 「係数補正状態」セクション + スタイル |
| `js/forecast-render.js` | Modify | `renderCorrections` 追加 |
| `js/forecast-app.js` | Modify | coefficient-corrections.json fetch + render |

実装順序: **純関数 + テスト先行 (TDD) → observe-tick 統合 → fetch-arrivals 統合 → 配線 → フロント表示**。

依存: `correction-engine.mjs` は `ensemble-engine.mjs` (`leadBucketOf`, `LEAD_KEYS`)、`accuracy-evaluator.mjs` (`slotKeyOf`)、`taxi-estimator.mjs` (`pickBucket`)、`route-reachability.mjs` (`hhmmToMinutes`) を import する (いずれも既存・改変なし)。

---

## Task 1: `correction-engine.mjs` の `clipFactor` + `applyLevelCorrection` + `buildEffectiveTransitShare` (TDD)

**Files:**
- Create: `scripts/lib/correction-engine.mjs`
- Create: `tests/correction-engine.test.mjs`

- [ ] **Step 1.1: 失敗テスト 7 件を作成**

`tests/correction-engine.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  clipFactor, applyLevelCorrection, buildEffectiveTransitShare,
} from '../scripts/lib/correction-engine.mjs';

// --- clipFactor ---

test('clipFactor: 範囲内はそのまま', () => {
  assert.equal(clipFactor(1.5, 0.5, 2.0), 1.5);
});

test('clipFactor: 範囲外はクリップ', () => {
  assert.equal(clipFactor(5, 0.5, 2.0), 2.0);
  assert.equal(clipFactor(0.1, 0.5, 2.0), 0.5);
});

test('clipFactor: NaN/非数は 1.0', () => {
  assert.equal(clipFactor(NaN, 0.5, 2.0), 1.0);
  assert.equal(clipFactor('x', 0.5, 2.0), 1.0);
});

// --- applyLevelCorrection ---

function makeForecast(stallsPerSlot) {
  // stallsPerSlot: [[s1,s2,s3,s4], ...] 24 slot 想定だが任意長で可
  return {
    schemaVersion: 1,
    trendFactor: 1.0,
    slots: stallsPerSlot.map((v, i) => ({
      slotStart: `${String(8 + Math.floor((i + 1) / 12)).padStart(2, '0')}:${String(((i + 1) % 12) * 5).padStart(2, '0')}`,
      flightFactor: 1.0,
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}

test('applyLevelCorrection: corrections null → forecast そのまま', () => {
  const fc = makeForecast([[2, 1, 0, 0]]);
  const r = applyLevelCorrection(fc, null);
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].total, 3);
});

test('applyLevelCorrection: factor 1.0 → 値不変・他キー保持', () => {
  const fc = makeForecast([[2, 1, 0, 0]]);
  const corrections = { level: { lead30: { factor: 1.0 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].flightFactor, 1.0);
  assert.equal(r.trendFactor, 1.0);
});

test('applyLevelCorrection: lead30 factor 1.5 → round 乗算・total 再計算', () => {
  const fc = makeForecast([[2, 1, 3, 0]]); // slot0 = lead 5min → lead30
  const corrections = { level: { lead30: { factor: 1.5 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  assert.equal(r.slots[0].stall1, 3); // round(2*1.5)
  assert.equal(r.slots[0].stall3, 5); // round(3*1.5=4.5)
  assert.equal(r.slots[0].total, 3 + 2 + 5 + 0);
});

test('applyLevelCorrection: 入力 forecast を破壊しない', () => {
  const fc = makeForecast([[2, 1, 0, 0]]);
  const corrections = { level: { lead30: { factor: 2.0 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  applyLevelCorrection(fc, corrections);
  assert.equal(fc.slots[0].stall1, 2); // 元は不変
});

// --- buildEffectiveTransitShare ---

function makeTransitShare() {
  return {
    buckets: [
      { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.035, T2: 0.035, T3: 0.040 } },
      { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.060, T2: 0.060, T3: 0.055 } },
    ],
    maxRatio: 0.40,
    fallbackRate: 0.025,
  };
}

test('buildEffectiveTransitShare: corrections null → マスターと同値・別オブジェクト', () => {
  const master = makeTransitShare();
  const eff = buildEffectiveTransitShare(master, null);
  assert.equal(eff.buckets[0].rates.T1, 0.035);
  assert.equal(eff.maxRatio, 0.40);
  assert.notEqual(eff, master);
});

test('buildEffectiveTransitShare: factor 適用 → rates 乗算・maxRatio 不変・マスター非破壊', () => {
  const master = makeTransitShare();
  const corrections = { share: { noon: { factor: 2.0 }, peak1: { factor: 1.0 } } };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.070); // 0.035 * 2.0
  assert.equal(eff.buckets[0].rates.T3, 0.080); // 0.040 * 2.0
  assert.equal(eff.buckets[1].rates.T1, 0.060); // peak1 factor 1.0
  assert.equal(eff.maxRatio, 0.40);
  assert.equal(master.buckets[0].rates.T1, 0.035); // マスター不変
});
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: FAIL (`Cannot find module '../scripts/lib/correction-engine.mjs'`)

- [ ] **Step 1.3: `correction-engine.mjs` の Task 1 部分を実装**

`scripts/lib/correction-engine.mjs` の内容:

```javascript
/**
 * 係数オンライン補正 (Phase D-3)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-coefficient-online-correction-design.md
 *
 * transit-share 率と forecast レベルの系統バイアスを、ログ・観測からの
 * 決定論的ウィンドウ加重平均で補正する純関数群 (副作用なし)。
 */
import { leadBucketOf, LEAD_KEYS } from './ensemble-engine.mjs';
import { slotKeyOf } from './accuracy-evaluator.mjs';
import { pickBucket } from './taxi-estimator.mjs';
import { hhmmToMinutes } from './route-reachability.mjs';

export const CORRECTION_SCHEMA_VERSION = 1;
export const SHARE_WINDOW_DAYS = 7;
export const SHARE_MIN_FLIGHTS = 20;
export const SHARE_FACTOR_MIN = 0.3;
export const SHARE_FACTOR_MAX = 3.0;
export const LEVEL_WINDOW_HOURS = 48;
export const LEVEL_MIN_SAMPLE = 20;
export const LEVEL_FACTOR_MIN = 0.5;
export const LEVEL_FACTOR_MAX = 2.0;
export const SLOTS_PER_HOUR = 12;
export const SLOTS_PER_DAY = 288;

const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];

/**
 * 数値を [min, max] にクリップ。NaN・非有限・非数は 1.0。
 */
export function clipFactor(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 1.0;
  return Math.max(min, Math.min(max, value));
}

/**
 * forecast の各 slot に level 補正係数を掛ける。純関数 (入力非破壊)。
 * slot index i は現在 +（i+1）×5 分先 → leadBucketOf でバケット決定。
 *
 * @param {{slots: Array}|null} forecast  computeForecast の戻り値相当
 * @param {Object|null} corrections       coefficient-corrections.json 相当
 * @returns 補正済み forecast (slots 以外のキーは保持)
 */
export function applyLevelCorrection(forecast, corrections) {
  if (!forecast || !Array.isArray(forecast.slots)) return forecast;
  const level = (corrections && corrections.level) || {};
  const correctedSlots = forecast.slots.map((slot, i) => {
    const bucket = leadBucketOf((i + 1) * 5);
    const entry = level[bucket];
    const factor = (entry && typeof entry.factor === 'number') ? entry.factor : 1.0;
    const out = { ...slot };
    let total = 0;
    for (const name of STALL_NAMES) {
      const v = Math.round((slot[name] || 0) * factor);
      out[name] = v;
      total += v;
    }
    out.total = total;
    return out;
  });
  return { ...forecast, slots: correctedSlots };
}

/**
 * transit-share マスターに share 補正係数を掛けた実効版を返す。
 * 純関数 (マスター非破壊)。rates の各 terminal を factor 倍する。
 *
 * @param {Object} transitShareMaster  data/transit-share.json
 * @param {Object|null} corrections    coefficient-corrections.json 相当
 * @returns 実効 transit-share
 */
export function buildEffectiveTransitShare(transitShareMaster, corrections) {
  const share = (corrections && corrections.share) || {};
  const effective = JSON.parse(JSON.stringify(transitShareMaster));
  if (!Array.isArray(effective.buckets)) return effective;
  for (const b of effective.buckets) {
    const entry = share[b.id];
    const factor = (entry && typeof entry.factor === 'number') ? entry.factor : 1.0;
    if (factor === 1.0 || !b.rates) continue;
    for (const term of Object.keys(b.rates)) {
      b.rates[term] = b.rates[term] * factor;
    }
  }
  return effective;
}
```

- [ ] **Step 1.4: テスト実行 → パス**

Run: `node --test tests/correction-engine.test.mjs`
Expected: PASS (7 件)

- [ ] **Step 1.5: 全テストスイート (回帰確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 378 件パス (371 + 7)、fail 0

- [ ] **Step 1.6: commit**

```bash
git add scripts/lib/correction-engine.mjs tests/correction-engine.test.mjs
git commit -m "feat(correction): add clipFactor + applyLevelCorrection + buildEffectiveTransitShare"
```

---

## Task 2: `computeLevelCorrection` の実装 (TDD)

**Files:**
- Modify: `scripts/lib/correction-engine.mjs`
- Modify: `tests/correction-engine.test.mjs`

- [ ] **Step 2.1: 失敗テスト 5 件を追加**

`tests/correction-engine.test.mjs` の末尾に追加:

```javascript

// --- computeLevelCorrection ---

import { computeLevelCorrection } from '../scripts/lib/correction-engine.mjs';

// 発行時刻 issueH:issueM (JST) から leadMin 分後の予測 slot を作る。
function predSlotJst(issueH, issueM, leadMin, s1, s2, s3, s4) {
  const total = issueH * 60 + issueM + leadMin;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return { slotStart: `${hh}:${mm}`, stall1: s1, stall2: s2, stall3: s3, stall4: s4, total: s1 + s2 + s3 + s4 };
}
function logEntry(ts, fcSlots) {
  return { ts, tickSeq: 1, forecast: fcSlots, patternMatch: [] };
}
// actualMap キー: "YYYY-MM-DD#slotIdx"
function actualKey(dateStr, hh, mm) {
  return `${dateStr}#${hh * 12 + Math.floor(mm / 5)}`;
}
const NOW = new Date('2026-06-01T13:00:00+09:00');

test('computeLevelCorrection: logEntries 0 件 → 全バケット fallback', () => {
  const r = computeLevelCorrection([], new Map(), NOW);
  assert.equal(r.lead30.source, 'fallback');
  assert.equal(r.lead30.factor, 1.0);
  assert.equal(r.lead30.n, 0);
  assert.equal(r.lead120.source, 'fallback');
});

test('computeLevelCorrection: 予測 = 実測 → factor 1.0', () => {
  // 12:00 発行、30 分後 (12:30) に total 4 を予測、実測も 4。MIN_SAMPLE 達成のため 25 件。
  const entries = [];
  for (let i = 0; i < 25; i++) {
    entries.push(logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 1, 1, 1, 1)]));
  }
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [1, 1, 1, 1]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.factor, 1.0);
  assert.equal(r.lead30.source, 'learning');
  assert.equal(r.lead30.n, 25);
});

test('computeLevelCorrection: 予測過小 (実測 > 予測) → factor > 1', () => {
  const entries = [];
  for (let i = 0; i < 25; i++) {
    entries.push(logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 1, 0, 0, 0)]));
  }
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [2, 0, 0, 0]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.factor, 2.0); // 実測50 / 予測25
  assert.equal(r.lead30.source, 'learning');
});

test('computeLevelCorrection: ペア数 < MIN_SAMPLE → fallback', () => {
  const entries = [logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 1, 0, 0, 0)])];
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [3, 0, 0, 0]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.source, 'fallback');
  assert.equal(r.lead30.factor, 1.0);
  assert.equal(r.lead30.n, 1);
});

test('computeLevelCorrection: 実測過小 → factor は下限 0.5 でクリップ', () => {
  const entries = [];
  for (let i = 0; i < 25; i++) {
    entries.push(logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 10, 0, 0, 0)]));
  }
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [1, 0, 0, 0]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.factor, 0.5); // 実測25/予測250 = 0.1 → クリップ 0.5
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: FAIL (`computeLevelCorrection` が未 export)

- [ ] **Step 2.3: `computeLevelCorrection` を実装**

`scripts/lib/correction-engine.mjs` の末尾 (`buildEffectiveTransitShare` の後) に追加:

```javascript

/**
 * Date → "YYYY-MM-DD" (ローカル時刻)。
 */
function ymdOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 1 つの予測 slot 配列を actualMap と突き合わせ、lead bucket 別に
 * 予測合計・実測合計・件数を stats に加算する。
 */
function accumulateLevel(stats, issueDate, predSlots, actualMap) {
  const issueSlotIdx = issueDate.getHours() * SLOTS_PER_HOUR + Math.floor(issueDate.getMinutes() / 5);
  for (const slot of predSlots) {
    const parts = String(slot.slotStart).split(':');
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    if (Number.isNaN(hh) || Number.isNaN(mm)) continue;
    const slotIdx = hh * SLOTS_PER_HOUR + Math.floor(mm / 5);
    // slot が発行時刻より後なら同日、以前なら翌日
    const dateForSlot = new Date(issueDate);
    if (slotIdx <= issueSlotIdx) dateForSlot.setDate(dateForSlot.getDate() + 1);
    const actual = actualMap.get(slotKeyOf(ymdOf(dateForSlot), slotIdx));
    if (!actual) continue;
    let leadSlots = slotIdx - issueSlotIdx;
    if (leadSlots <= 0) leadSlots += SLOTS_PER_DAY;
    const bucket = leadBucketOf(leadSlots * 5);
    const predTotal = typeof slot.total === 'number'
      ? slot.total
      : STALL_NAMES.reduce((s, n) => s + (slot[n] || 0), 0);
    const actualTotal = actual[0] + actual[1] + actual[2] + actual[3];
    const st = stats[bucket];
    st.predSum += predTotal;
    st.actualSum += actualTotal;
    st.n += 1;
  }
}

/**
 * forecast-log の RAW 予測を実測と突き合わせ、lead bucket 別レベル補正係数を計算。
 * 直近 LEVEL_WINDOW_HOURS 以内に発行されたエントリのみ対象。
 *
 * @param {Array} logEntries  forecast-log.jsonl の全行 (各 {ts, forecast})
 * @param {Map} actualMap     buildActualMap の戻り値
 * @param {Date} now
 * @returns {{lead30, lead60, lead120}} 各 {factor, source, n}
 */
export function computeLevelCorrection(logEntries, actualMap, now) {
  const cutoff = now.getTime() - LEVEL_WINDOW_HOURS * 3600 * 1000;
  const stats = {};
  for (const k of LEAD_KEYS) stats[k] = { predSum: 0, actualSum: 0, n: 0 };
  for (const entry of logEntries) {
    if (!entry || typeof entry.ts !== 'string') continue;
    const issueDate = new Date(entry.ts);
    if (Number.isNaN(issueDate.getTime())) continue;
    if (issueDate.getTime() < cutoff) continue;
    if (Array.isArray(entry.forecast)) {
      accumulateLevel(stats, issueDate, entry.forecast, actualMap);
    }
  }
  const out = {};
  for (const k of LEAD_KEYS) {
    const st = stats[k];
    if (st.n < LEVEL_MIN_SAMPLE || st.predSum <= 0) {
      out[k] = { factor: 1.0, source: 'fallback', n: st.n };
    } else {
      const raw = Number((st.actualSum / st.predSum).toFixed(4));
      out[k] = {
        factor: clipFactor(raw, LEVEL_FACTOR_MIN, LEVEL_FACTOR_MAX),
        source: 'learning',
        n: st.n,
      };
    }
  }
  return out;
}
```

- [ ] **Step 2.4: テスト実行 → パス**

Run: `node --test tests/correction-engine.test.mjs`
Expected: PASS (12 件)

- [ ] **Step 2.5: 全テストスイート**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 383 件パス、fail 0

- [ ] **Step 2.6: commit**

```bash
git add scripts/lib/correction-engine.mjs tests/correction-engine.test.mjs
git commit -m "feat(correction): implement computeLevelCorrection (lead-bucket level bias)"
```

---

## Task 3: `computeShareCorrection` の実装 (TDD)

**Files:**
- Modify: `scripts/lib/correction-engine.mjs`
- Modify: `tests/correction-engine.test.mjs`

- [ ] **Step 3.1: 失敗テスト 4 件を追加**

`tests/correction-engine.test.mjs` の末尾に追加:

```javascript

// --- computeShareCorrection ---

import { computeShareCorrection } from '../scripts/lib/correction-engine.mjs';

// transit-share フィクスチャ (noon バケットのみ使用)
const SHARE_TS = {
  buckets: [
    { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.035, T2: 0.035, T3: 0.040 } },
  ],
};
// 1 便 = estimatedTaxiPax, lobbyExitTime 13:00 (noon バケット)
function snapshotRow(ts, flights) {
  return { ts, tick_seq: 1, flights };
}
function flight(fn, taxiPax) {
  return { flightNumber: fn, estimatedTaxiPax: taxiPax, lobbyExitTime: '13:00', terminal: 'T1' };
}
// actualMap: noon バケット (12:00-15:00 = slotIdx 144-179) に outflow を置く
function noonActualMap(dateStr, totalPerSlot) {
  const m = new Map();
  for (let idx = 144; idx < 180; idx++) {
    m.set(`${dateStr}#${idx}`, [totalPerSlot, 0, 0, 0]);
  }
  return m;
}
const SHARE_NOW = new Date('2026-06-03T10:00:00+09:00');

test('computeShareCorrection: snapshotRows 0 件 → 全バケット fallback', () => {
  const r = computeShareCorrection([], new Map(), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.source, 'fallback');
  assert.equal(r.noon.factor, 1.0);
});

test('computeShareCorrection: 完了日の比率 → factor = Σ実測 / Σ推定', () => {
  // 6/2 (完了日): 25 便 × estimatedTaxiPax 4 = Σ推定 100。
  // 実測 noon 36 slot × 5 = Σ実測 180。factor = 180/100 = 1.8。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`F${i}`, 4));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const actualMap = noonActualMap('2026-06-02', 5);
  const r = computeShareCorrection(rows, actualMap, SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.factor, 1.8);
  assert.equal(r.noon.source, 'learning');
  assert.equal(r.noon.flightCount, 25);
});

test('computeShareCorrection: 当日のデータは無視 (完了日のみ)', () => {
  // SHARE_NOW = 6/3。6/3 のスナップショットは未完了日なので使われない。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`F${i}`, 4));
  const rows = [snapshotRow('2026-06-03T13:00:00+09:00', flights)];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-03', 5), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.source, 'fallback');
});

test('computeShareCorrection: 便数 < SHARE_MIN_FLIGHTS → fallback', () => {
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', [flight('F0', 4), flight('F1', 4)])];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-02', 5), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.source, 'fallback');
  assert.equal(r.noon.flightCount, 2);
});
```

- [ ] **Step 3.2: テスト実行 → 失敗確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: FAIL (`computeShareCorrection` が未 export)

- [ ] **Step 3.3: `computeShareCorrection` を実装**

`scripts/lib/correction-engine.mjs` の末尾 (`computeLevelCorrection` の後) に追加:

```javascript

/**
 * "YYYY-MM-DD" → 翌日の "YYYY-MM-DD"。
 */
function nextDayStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return ymdOf(d);
}

/**
 * actualMap から、ある日のあるバケット時間範囲に入る slot の実測 outflow 合計を返す。
 * バケット範囲が 24:00 を超える場合 (midnight バケット等) は翌日の slot を参照する。
 */
function sumActualForBucket(actualMap, dateStr, bucket) {
  const fromMin = hhmmToMinutes(bucket.fromHHMM);
  const toMin = hhmmToMinutes(bucket.toHHMM);
  if (fromMin === null || toMin === null) return 0;
  let sum = 0;
  for (let slotIdx = Math.floor(fromMin / 5); slotIdx < Math.floor(toMin / 5); slotIdx++) {
    let day = dateStr;
    let idx = slotIdx;
    if (idx >= SLOTS_PER_DAY) { day = nextDayStr(dateStr); idx -= SLOTS_PER_DAY; }
    const actual = actualMap.get(slotKeyOf(day, idx));
    if (actual) sum += actual[0] + actual[1] + actual[2] + actual[3];
  }
  return sum;
}

/**
 * transit-share バケット率の補正係数を計算する。
 * 直近 SHARE_WINDOW_DAYS の完了日 (当日を除く) について、バケット別に
 * 「Σ実測outflow ÷ Σ estimatedTaxiPax」の日次比率を求め、直近日ほど重い加重平均をとる。
 *
 * @param {Array} snapshotRows  arrivals-snapshots/*.jsonl の行 (各 {ts, flights})
 * @param {Map} actualMap       buildActualMap の戻り値
 * @param {Object} transitShare data/transit-share.json (バケット定義)
 * @param {Date} now
 * @returns {Object} {<bucketId>: {factor, source, flightCount, dayCount}}
 */
export function computeShareCorrection(snapshotRows, actualMap, transitShare, now) {
  const buckets = (transitShare && Array.isArray(transitShare.buckets)) ? transitShare.buckets : [];

  // 行を日別にグループ化
  const rowsByDay = new Map();
  for (const row of snapshotRows) {
    if (!row || typeof row.ts !== 'string') continue;
    const day = row.ts.slice(0, 10);
    if (!rowsByDay.has(day)) rowsByDay.set(day, []);
    rowsByDay.get(day).push(row);
  }
  // 完了日 (当日より前) を昇順で直近 SHARE_WINDOW_DAYS 個
  const todayStr = ymdOf(now);
  const targetDays = [...rowsByDay.keys()]
    .filter(d => d < todayStr)
    .sort()
    .slice(-SHARE_WINDOW_DAYS);

  const dayRatios = {};
  const flightCounts = {};
  for (const b of buckets) { dayRatios[b.id] = []; flightCounts[b.id] = 0; }

  targetDays.forEach((day, dayIdx) => {
    const weight = dayIdx + 1; // 最古 = 1 .. 最新 = targetDays.length
    const rows = [...(rowsByDay.get(day) || [])].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    // 便ごとに最終スナップショットの flight を採用 (ts 昇順 → 後勝ち)
    const lastFlightByNumber = new Map();
    for (const row of rows) {
      if (!Array.isArray(row.flights)) continue;
      for (const f of row.flights) {
        if (f && f.flightNumber) lastFlightByNumber.set(f.flightNumber, f);
      }
    }
    // バケット別 Σ estimatedTaxiPax / 便数
    const estByBucket = {};
    for (const b of buckets) estByBucket[b.id] = { sum: 0, count: 0 };
    for (const f of lastFlightByNumber.values()) {
      if (typeof f.estimatedTaxiPax !== 'number' || !f.lobbyExitTime) continue;
      const bucket = pickBucket(f.lobbyExitTime, transitShare);
      if (!bucket || !estByBucket[bucket.id]) continue;
      estByBucket[bucket.id].sum += f.estimatedTaxiPax;
      estByBucket[bucket.id].count += 1;
    }
    for (const b of buckets) {
      const est = estByBucket[b.id];
      flightCounts[b.id] += est.count;
      if (est.sum <= 0) continue;
      const actualSum = sumActualForBucket(actualMap, day, b);
      dayRatios[b.id].push({ ratio: actualSum / est.sum, weight });
    }
  });

  const share = {};
  for (const b of buckets) {
    const ratios = dayRatios[b.id];
    const count = flightCounts[b.id];
    if (ratios.length === 0 || count < SHARE_MIN_FLIGHTS) {
      share[b.id] = { factor: 1.0, source: 'fallback', flightCount: count, dayCount: ratios.length };
    } else {
      let wSum = 0;
      let wTotal = 0;
      for (const r of ratios) { wSum += r.ratio * r.weight; wTotal += r.weight; }
      const raw = Number((wSum / wTotal).toFixed(4));
      share[b.id] = {
        factor: clipFactor(raw, SHARE_FACTOR_MIN, SHARE_FACTOR_MAX),
        source: 'learning',
        flightCount: count,
        dayCount: ratios.length,
      };
    }
  }
  return share;
}
```

- [ ] **Step 3.4: テスト実行 → パス**

Run: `node --test tests/correction-engine.test.mjs`
Expected: PASS (16 件)

- [ ] **Step 3.5: 全テストスイート**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 387 件パス、fail 0

- [ ] **Step 3.6: commit**

```bash
git add scripts/lib/correction-engine.mjs tests/correction-engine.test.mjs
git commit -m "feat(correction): implement computeShareCorrection (per-bucket transit-share)"
```

---

## Task 4: `observe-taxi-pool.mjs` に D-3 ブロックを統合

D-1 ブロックの `logEntries` / `actualMap` を外側スコープへ hoist し、D-1 と D-2 の間に D-3 ブロックを挿入。D-2 の `computeEnsemble` 入力を level 補正済み forecast に差し替える。

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 4.1: import 追加**

`import { computeEnsemble } from './lib/ensemble-engine.mjs';` の直後に追加:

```javascript
import {
  computeShareCorrection, computeLevelCorrection, applyLevelCorrection,
  CORRECTION_SCHEMA_VERSION,
} from './lib/correction-engine.mjs';
```

- [ ] **Step 4.2: 定数追加**

`const ENSEMBLE_OUTPUT_PATH = './data/stall-ensemble.json';` の直後に追加:

```javascript
const CORRECTIONS_OUTPUT_PATH = './data/coefficient-corrections.json';
const TRANSIT_SHARE_PATH = './data/transit-share.json';
```

- [ ] **Step 4.3: D-1 ブロックの `logEntries` / `actualMap` を hoist**

変更前:

```javascript
  // Phase D-1: 予測ログ記録 + 精度評価
  let accuracyResult = null;
  try {
```

変更後:

```javascript
  // Phase D-1: 予測ログ記録 + 精度評価
  let accuracyResult = null;
  let logEntries = [];
  let actualMap = new Map();
  try {
```

さらに D-1 ブロック内の変数宣言を外側スコープへの代入に変更する。

変更前:

```javascript
    let logEntries = [];
    if (existsSync(FORECAST_LOG_PATH)) {
```

変更後:

```javascript
    if (existsSync(FORECAST_LOG_PATH)) {
```

変更前:

```javascript
    const actualMap = buildActualMap(accHistory);
```

変更後:

```javascript
    actualMap = buildActualMap(accHistory);
```

- [ ] **Step 4.4: D-3 ブロックを挿入**

D-1 ブロックの閉じ `}` (`console.error(\`[observe] accuracy evaluation failed: ${e.message}\`);` を含む catch の後) と `  // Phase D-2: アンサンブル統合予測` の間に挿入:

```javascript

  // Phase D-3: 係数オンライン補正
  let corrections = null;
  try {
    // 直近 SHARE_WINDOW_DAYS+1 日分の arrivals-snapshot を読む (完了日判定は純関数側)
    const snapshotRows = [];
    for (let back = 0; back <= 7; back++) {
      const d = new Date(Date.now() - back * 86400000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const path = `${SNAPSHOTS_DIR}/arrivals-${dateStr}.jsonl`;
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
        if (!line.trim()) continue;
        try { snapshotRows.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
    }
    const transitShare = JSON.parse(readFileSync(TRANSIT_SHARE_PATH, 'utf8'));
    corrections = {
      schemaVersion: CORRECTION_SCHEMA_VERSION,
      generatedAt: ts,
      share: computeShareCorrection(snapshotRows, actualMap, transitShare, new Date()),
      level: computeLevelCorrection(logEntries, actualMap, new Date()),
    };
    writeFileSync(CORRECTIONS_OUTPUT_PATH, JSON.stringify(corrections, null, 2) + '\n', 'utf8');
    console.log(`[observe] corrections ok: level lead30=${corrections.level.lead30.factor} (${corrections.level.lead30.source})`);
  } catch (e) {
    console.error(`[observe] correction generation failed: ${e.message}`);
  }
```

- [ ] **Step 4.5: D-2 ブロックを level 補正済み forecast に差し替え**

変更前:

```javascript
  // Phase D-2: アンサンブル統合予測
  try {
    const ensemble = computeEnsemble(
      forecastResult,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      accuracyResult,
      new Date()
    );
```

変更後:

```javascript
  // Phase D-2: アンサンブル統合予測 (D-3 level 補正済み forecast を入力)
  try {
    const correctedForecast = applyLevelCorrection(forecastResult, corrections);
    const ensemble = computeEnsemble(
      correctedForecast,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      accuracyResult,
      new Date()
    );
```

- [ ] **Step 4.6: 構文チェック + 単発実行**

```bash
node --check scripts/observe-taxi-pool.mjs && echo "syntax OK"
node scripts/observe-taxi-pool.mjs 2>&1 | grep -E "\[observe\] (forecast|pattern-match|accuracy|corrections|ensemble)"
```

期待: `syntax OK` の後、`[observe] corrections ok: level lead30=...` の行が出る。初回はサンプル不足で `(fallback)`、ファイルが生成される。

- [ ] **Step 4.7: 生成された JSON を確認**

```bash
python3 -c "import json; d=json.load(open('data/coefficient-corrections.json')); print('schemaVersion', d['schemaVersion']); print('share keys', sorted(d['share'].keys())); print('level', d['level'])"
```

期待: `schemaVersion 1`、share に 8 バケット (`afternoon early evening midnight morning noon peak1 peak2`)、level に lead30/60/120。初期は全て factor 1.0 / source fallback。

- [ ] **Step 4.8: 全テスト (回帰確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 387 件パス、fail 0

- [ ] **Step 4.9: commit**

```bash
git add scripts/observe-taxi-pool.mjs data/coefficient-corrections.json
git commit -m "feat(observe): generate coefficient-corrections.json + apply level correction to ensemble"
```

---

## Task 5: `fetch-arrivals.mjs` に share 補正を統合

`transit-share.json` マスターから `buildEffectiveTransitShare` で実効版を構築し、`transformArrivals` に渡す。

**Files:**
- Modify: `scripts/fetch-arrivals.mjs`

- [ ] **Step 5.1: import 追加**

変更前:

```javascript
import { transformArrivals } from './lib/arrival-transformer.mjs';
```

変更後:

```javascript
import { transformArrivals } from './lib/arrival-transformer.mjs';
import { buildEffectiveTransitShare } from './lib/correction-engine.mjs';
```

- [ ] **Step 5.2: 実効 transit-share を構築**

変更前:

```javascript
const transitShareMaster = JSON.parse(readFileSync('./data/transit-share.json', 'utf8'));
```

変更後:

```javascript
const transitShareMaster = JSON.parse(readFileSync('./data/transit-share.json', 'utf8'));
let coefficientCorrections = null;
try {
  coefficientCorrections = JSON.parse(readFileSync('./data/coefficient-corrections.json', 'utf8'));
} catch {
  coefficientCorrections = null; // 欠損・不正時は補正なし (係数 1.0)
}
const effectiveTransitShare = buildEffectiveTransitShare(transitShareMaster, coefficientCorrections);
```

- [ ] **Step 5.3: `transformArrivals` の入力を実効版に差し替え**

変更前:

```javascript
  {
    transitShare: transitShareMaster,
    routes: routesMaster,
```

変更後:

```javascript
  {
    transitShare: effectiveTransitShare,
    routes: routesMaster,
```

- [ ] **Step 5.4: 構文チェック**

```bash
node --check scripts/fetch-arrivals.mjs && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 5.5: 全テスト (回帰確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 387 件パス、fail 0

- [ ] **Step 5.6: commit**

```bash
git add scripts/fetch-arrivals.mjs
git commit -m "feat(arrivals): apply share correction via buildEffectiveTransitShare"
```

---

## Task 6: `observe-tick-local.sh` の配線

`coefficient-corrections.json` を再生成系ファイル群 (checkout / git add 対象) に追加する。

**Files:**
- Modify: `scripts/observe-tick-local.sh`

- [ ] **Step 6.1: 自己回復ブロックの checkout 対象に追加**

変更前:

```bash
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json 2>/dev/null || true
  # 残った staged 変更を unstage
```

変更後:

```bash
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true
  # 残った staged 変更を unstage
```

- [ ] **Step 6.2: pull 前 checkout 対象に追加**

変更前:

```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json 2>/dev/null || true

git pull --rebase --autostash origin main 2>&1 | tail -3
```

変更後:

```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true

git pull --rebase --autostash origin main 2>&1 | tail -3
```

- [ ] **Step 6.3: git add 対象に追加**

変更前:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json 2>/dev/null || true
```

変更後:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true
```

- [ ] **Step 6.4: 構文チェック**

```bash
bash -n scripts/observe-tick-local.sh && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 6.5: commit**

```bash
git add scripts/observe-tick-local.sh
git commit -m "chore(observe): wire coefficient-corrections.json into observe-tick git flow"
```

---

## Task 7: `forecast.html` に「係数補正状態」セクション追加

**Files:**
- Modify: `forecast.html`
- Modify: `js/forecast-render.js`
- Modify: `js/forecast-app.js`

- [ ] **Step 7.1: `forecast.html` にスタイル + セクション追加**

`<style>` 末尾 (既存 `.ensemble-table tr.tier-very-high td { ... }` の後) に追加:

```css
    .correction-section { margin-top: 32px; padding-top: 16px; border-top: 1px solid #222; }
    .correction-section h2 { font-size: 16px; margin: 0 0 8px 0; }
    .correction-section h3 { font-size: 13px; margin: 14px 0 6px 0; color: var(--sub); }
    .correction-meta { color: var(--sub); font-size: 13px; margin-bottom: 12px; }
    .correction-table { border-collapse: collapse; width: 100%; max-width: 520px; }
    .correction-table th, .correction-table td { padding: 5px 10px; border-bottom: 1px solid #222; text-align: right; font-variant-numeric: tabular-nums; }
    .correction-table th { background: #16161c; color: var(--sub); font-weight: 500; font-size: 12px; }
    .correction-table td.label { text-align: left; font-weight: 600; }
    .src-learning { color: var(--accent); }
    .src-fallback { color: var(--sub); }
```

`<main>` 末尾 (既存 `accuracy-section` の `</section>` の後、`</main>` の前) に追加:

```html

    <section class="correction-section" id="correction-section">
      <h2>係数補正状態</h2>
      <div id="correction-meta" class="correction-meta">読み込み中...</div>
      <div id="correction-level-wrap"></div>
      <div id="correction-share-wrap"></div>
    </section>
```

- [ ] **Step 7.2: `js/forecast-render.js` に `renderCorrections` を追加**

ファイル末尾 (`renderEnsemble` 関数の閉じ `}` の後) に追加:

```javascript

// --- Phase D-3: 係数補正状態描画 ---

const SHARE_BUCKET_LABELS = {
  early: '7-9時', morning: '9-12時', noon: '12-15時', afternoon: '15-17時',
  peak1: '17-19時', evening: '19-21:30', peak2: '21:30-24時', midnight: '24時以降',
};
const LEVEL_LABELS = { lead30: '30分先', lead60: '60分先', lead120: '120分先' };

function srcSpan(source) {
  const cls = source === 'learning' ? 'src-learning' : 'src-fallback';
  const label = source === 'learning' ? '学習中' : '様子見';
  return `<span class="${cls}">${label}</span>`;
}

export function renderCorrections(metaEl, levelEl, shareEl, corrections) {
  if (!metaEl || !levelEl || !shareEl || !corrections) return;
  const ts = (corrections.generatedAt || '').slice(0, 16).replace('T', ' ');
  metaEl.innerHTML = `生成時刻 <strong>${ts} JST</strong><br>forecast レベル補正 ＝ ensemble に適用 / transit-share 補正 ＝ 便台数推定に適用`;

  const level = corrections.level || {};
  const levelRows = ['lead30', 'lead60', 'lead120'].map(k => {
    const e = level[k] || { factor: 1.0, source: 'fallback', n: 0 };
    return `<tr>
      <td class="label">${LEVEL_LABELS[k]}</td>
      <td>${Number(e.factor).toFixed(2)}×</td>
      <td>${srcSpan(e.source)}</td>
      <td>${e.n}</td>
    </tr>`;
  }).join('');
  levelEl.innerHTML = `<h3>forecast レベル補正</h3>
    <table class="correction-table">
      <thead><tr><th>lead time</th><th>補正係数</th><th>状態</th><th>n</th></tr></thead>
      <tbody>${levelRows}</tbody>
    </table>`;

  const share = corrections.share || {};
  const shareRows = ['early', 'morning', 'noon', 'afternoon', 'peak1', 'evening', 'peak2', 'midnight']
    .filter(k => share[k])
    .map(k => {
      const e = share[k];
      return `<tr>
        <td class="label">${SHARE_BUCKET_LABELS[k]}</td>
        <td>${Number(e.factor).toFixed(2)}×</td>
        <td>${srcSpan(e.source)}</td>
        <td>${e.flightCount}</td>
      </tr>`;
    }).join('');
  shareEl.innerHTML = `<h3>transit-share バケット補正</h3>
    <table class="correction-table">
      <thead><tr><th>時間帯</th><th>補正係数</th><th>状態</th><th>便数</th></tr></thead>
      <tbody>${shareRows}</tbody>
    </table>`;
}
```

- [ ] **Step 7.3: `js/forecast-app.js` に corrections fetch + render を追加**

変更前:

```javascript
import {
  renderForecastMeta, renderForecastTable,
  renderPatternMeta, renderSimilarDays, renderHistoricalCurve,
  renderAccuracy, renderEnsemble,
} from './forecast-render.js';
```

変更後:

```javascript
import {
  renderForecastMeta, renderForecastTable,
  renderPatternMeta, renderSimilarDays, renderHistoricalCurve,
  renderAccuracy, renderEnsemble, renderCorrections,
} from './forecast-render.js';
```

変更前 (`main` 関数末尾、`予測精度 (Phase D-1)` の try-catch の後、`}` の前):

```javascript
  // 予測精度 (Phase D-1)
  try {
    const res = await fetch('data/forecast-accuracy.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const accuracy = await res.json();
    renderAccuracy(accuracyMetaEl, accuracyTableEl, accuracy);
  } catch (e) {
    accuracyMetaEl.textContent = `精度データの読み込みに失敗: ${e.message}`;
    accuracyTableEl.innerHTML = '';
  }
}
```

変更後:

```javascript
  // 予測精度 (Phase D-1)
  try {
    const res = await fetch('data/forecast-accuracy.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const accuracy = await res.json();
    renderAccuracy(accuracyMetaEl, accuracyTableEl, accuracy);
  } catch (e) {
    accuracyMetaEl.textContent = `精度データの読み込みに失敗: ${e.message}`;
    accuracyTableEl.innerHTML = '';
  }

  // 係数補正状態 (Phase D-3)
  try {
    const res = await fetch('data/coefficient-corrections.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const corrections = await res.json();
    renderCorrections(correctionMetaEl, correctionLevelEl, correctionShareEl, corrections);
  } catch (e) {
    correctionMetaEl.textContent = `補正データの読み込みに失敗: ${e.message}`;
    correctionLevelEl.innerHTML = '';
    correctionShareEl.innerHTML = '';
  }
}
```

さらに `main` 関数冒頭の DOM 取得部に要素参照を追加する。

変更前:

```javascript
  const accuracyMetaEl = document.getElementById('accuracy-meta');
  const accuracyTableEl = document.getElementById('accuracy-table-wrap');
```

変更後:

```javascript
  const accuracyMetaEl = document.getElementById('accuracy-meta');
  const accuracyTableEl = document.getElementById('accuracy-table-wrap');
  const correctionMetaEl = document.getElementById('correction-meta');
  const correctionLevelEl = document.getElementById('correction-level-wrap');
  const correctionShareEl = document.getElementById('correction-share-wrap');
```

- [ ] **Step 7.4: 構文チェック**

```bash
node --check js/forecast-render.js && node --check js/forecast-app.js && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 7.5: 全テスト (回帰なし確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 387 件パス、fail 0

- [ ] **Step 7.6: commit**

```bash
git add forecast.html js/forecast-render.js js/forecast-app.js
git commit -m "feat(correction): add 係数補正状態 section to forecast.html"
```

---

## Task 8: 最終整合 + push

- [ ] **Step 8.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/lib/correction-engine.mjs`
- `tests/correction-engine.test.mjs`
- `data/coefficient-corrections.json`
- `scripts/observe-taxi-pool.mjs`
- `scripts/fetch-arrivals.mjs`
- `scripts/observe-tick-local.sh`
- `forecast.html`
- `js/forecast-render.js`
- `js/forecast-app.js`
- (docs の spec / plan)

スコープ外 (`forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json`) は含まれないこと。

- [ ] **Step 8.2: 全テスト最終パス**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 387 件パス、fail 0。

- [ ] **Step 8.3: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

autostash 適用でコンフリクトが出た場合は **`git reset --hard` で観測データを失わないこと**。再生成系 JSON (`data/stall-*.json` / `data/forecast-accuracy.json` / `data/coefficient-corrections.json`) のみ `git checkout HEAD --` で破棄し、`data/taxi-pool-history.jsonl` の未コミット観測行は working tree に残す (次の observe-tick がコミットする)。

- [ ] **Step 8.4: push (3 回までリトライ)**

```bash
for i in 1 2 3; do
  if git push origin main; then
    echo "[push ok attempt $i]"
    break
  fi
  echo "[retry $i]"
  git pull --rebase --autostash origin main
  sleep 2
done
```

- [ ] **Step 8.5: 本番反映確認 (GitHub Pages 自動デプロイ後 80-90 秒)**

```bash
echo "=== coefficient-corrections.json ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/data/coefficient-corrections.json | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(f'schemaVersion: {d[\"schemaVersion\"]}')
print(f'level: {d[\"level\"]}')
print(f'share buckets: {sorted(d[\"share\"].keys())}')
"
echo "=== forecast.html ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/forecast.html | grep -oE 'correction-section|係数補正状態' | sort -u
```

期待: `coefficient-corrections.json` が取得でき、`forecast.html` に「係数補正状態」「correction-section」がある。

- [ ] **Step 8.6: 完了報告**

最終状態を要約。Mac mini 側は次 tick で git pull → 新ロジック取り込み。`fetch-arrivals` は次の `update-arrivals.yml` 実行で実効 transit-share を使い始める。

---

## 検証コマンド一覧 (チートシート)

```bash
# 個別テスト
node --test tests/correction-engine.test.mjs

# 全テスト
npm test

# observe-tick 単発実行 (forecast + pattern-match + accuracy + corrections + ensemble 生成)
node scripts/observe-taxi-pool.mjs

# 生成 JSON
python3 -c "import json; print(json.dumps(json.load(open('data/coefficient-corrections.json')), indent=2, ensure_ascii=False))"

# 本番
open https://hidenaka.github.io/taxi-ic-helper/forecast.html
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (371 → 387 件)
- [ ] `scripts/lib/correction-engine.mjs` 純関数として実装 (`computeShareCorrection` / `computeLevelCorrection` / `applyLevelCorrection` / `buildEffectiveTransitShare`)
- [ ] observe-tick で `data/coefficient-corrections.json` が 5 分毎に更新される
- [ ] `fetch-arrivals.mjs` が実効 transit-share で `estimatedTaxiPax` を生成
- [ ] observe-tick の ensemble 入力に level 補正が適用される
- [ ] `forecast.html` に「係数補正状態」セクションが表示される
- [ ] `observe-tick-local.sh` の git add / checkout 対象に `coefficient-corrections.json` 追加
- [ ] スコープ外ファイル (`forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json`) は触っていない
- [ ] 観測 jsonl 追記との衝突なし
