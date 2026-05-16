# terminal別 share補正 実装プラン (Phase D-4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** D-3 の transit-share バケット補正を T1/T2 端末別 (stall1+2→T1、stall3+4→T2 の直接マッピング) に分離し、T3 は観測外として補正しない。

**Architecture:** `correction-engine.mjs` の `computeShareCorrection` を端末別出力に改修、`buildEffectiveTransitShare` を端末別適用 (旧 v1 形状も許容) に改修、`coefficient-corrections.json` の `schemaVersion` を 2 に。`forecast-render.js` の係数補正テーブルを端末別表示に。observe-tick / fetch-arrivals は両関数のシグネチャ不変のため変更不要。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS / GitHub Actions (Pages) / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-terminal-share-correction-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/correction-engine.mjs` | Modify | `computeShareCorrection` 端末別化、`sumActualForBucket` に stall 添字引数、`buildEffectiveTransitShare` 端末別適用、`CORRECTION_SCHEMA_VERSION` → 2、`TERMINAL_STALLS` 定数追加 |
| `tests/correction-engine.test.mjs` | Modify | `computeShareCorrection` / `buildEffectiveTransitShare` の share 系テストを端末別に書き直し |
| `js/forecast-render.js` | Modify | `renderCorrections` の share テーブルを T1/T2/T3 別表示に |

実装順序: **`computeShareCorrection` (TDD) → `buildEffectiveTransitShare` (TDD) → フロント表示 → 統合確認 + push**。

`stall1`/`stall2` の outflow は T1、`stall3`/`stall4` は T2 (`scripts/lib/stall-rois.json` のラベル準拠)。`buildActualMap` は `[stall1,stall2,stall3,stall4]` 配列を返すため、添字 `[0,1]` が T1、`[2,3]` が T2。

---

## Task 1: `computeShareCorrection` の端末別化 (TDD)

**Files:**
- Modify: `scripts/lib/correction-engine.mjs`
- Modify: `tests/correction-engine.test.mjs`

- [ ] **Step 1.1: `computeShareCorrection` のテストブロックを端末別に書き直す**

`tests/correction-engine.test.mjs` の `// --- computeShareCorrection ---` から**ファイル末尾まで**を、以下で置き換える:

```javascript
// --- computeShareCorrection (端末別 / Phase D-4) ---

import { computeShareCorrection } from '../scripts/lib/correction-engine.mjs';

// transit-share フィクスチャ (noon バケットのみ使用)
const SHARE_TS = {
  buckets: [
    { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.035, T2: 0.035, T3: 0.040 } },
  ],
};
// 1 便: estimatedTaxiPax + terminal、lobbyExitTime 13:00 (noon バケット)
function flight(fn, taxiPax, terminal) {
  return { flightNumber: fn, estimatedTaxiPax: taxiPax, lobbyExitTime: '13:00', terminal };
}
function snapshotRow(ts, flights) {
  return { ts, tick_seq: 1, flights };
}
// actualMap: noon バケット (slotIdx 144-179) に stall 別 outflow を置く
function noonActualMap(dateStr, s1, s2, s3, s4) {
  const m = new Map();
  for (let idx = 144; idx < 180; idx++) {
    m.set(`${dateStr}#${idx}`, [s1, s2, s3, s4]);
  }
  return m;
}
const SHARE_NOW = new Date('2026-06-03T10:00:00+09:00');

test('computeShareCorrection: snapshotRows 0 件 → T1/T2 fallback・T3 unobservable', () => {
  const r = computeShareCorrection([], new Map(), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.source, 'fallback');
  assert.equal(r.noon.T1.factor, 1.0);
  assert.equal(r.noon.T2.source, 'fallback');
  assert.equal(r.noon.T3.source, 'unobservable');
  assert.equal(r.noon.T3.factor, 1.0);
});

test('computeShareCorrection: T1 便 × stall1+2 outflow → T1 factor 算出', () => {
  // 6/2 完了日: T1 便 25 × estimatedTaxiPax 4 = Σ推定 100。
  // stall1=3 + stall2=2 = 5/slot × 36 slot = Σ実測 180。T1 factor = 1.8。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T1F${i}`, 4, 'T1'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const actualMap = noonActualMap('2026-06-02', 3, 2, 0, 0);
  const r = computeShareCorrection(rows, actualMap, SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.factor, 1.8);
  assert.equal(r.noon.T1.source, 'learning');
  assert.equal(r.noon.T1.flightCount, 25);
  // T2 便なし → T2 fallback
  assert.equal(r.noon.T2.source, 'fallback');
});

test('computeShareCorrection: T2 便 × stall3+4 outflow → T2 factor 算出', () => {
  // T2 便 25 × 4 = Σ推定 100。stall3=4 + stall4=1 = 5/slot × 36 = 180。T2 factor 1.8。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T2F${i}`, 4, 'T2'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const actualMap = noonActualMap('2026-06-02', 0, 0, 4, 1);
  const r = computeShareCorrection(rows, actualMap, SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T2.factor, 1.8);
  assert.equal(r.noon.T2.source, 'learning');
});

test('computeShareCorrection: T1/T2 混在 → 端末別に独立算出', () => {
  // T1: 25 便 × 4 = 100、stall1+2 = 2/slot × 36 = 72 → factor 0.72。
  // T2: 25 便 × 4 = 100、stall3+4 = 6/slot × 36 = 216 → factor 2.16。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T1F${i}`, 4, 'T1'));
  for (let i = 0; i < 25; i++) flights.push(flight(`T2F${i}`, 4, 'T2'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const actualMap = noonActualMap('2026-06-02', 1, 1, 3, 3);
  const r = computeShareCorrection(rows, actualMap, SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.factor, 0.72);
  assert.equal(r.noon.T2.factor, 2.16);
});

test('computeShareCorrection: T3 便は集計除外・常に unobservable', () => {
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T3F${i}`, 4, 'T3'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-02', 3, 2, 0, 0), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T3.source, 'unobservable');
  assert.equal(r.noon.T3.factor, 1.0);
  // T3 便は T1/T2 に数えない
  assert.equal(r.noon.T1.flightCount, 0);
  assert.equal(r.noon.T2.flightCount, 0);
});

test('computeShareCorrection: 端末別の便数不足 → 当該端末のみ fallback', () => {
  // T1 便 2 のみ (< 20) → T1 fallback。T2 便 25 → T2 learning。
  const flights = [flight('T1a', 4, 'T1'), flight('T1b', 4, 'T1')];
  for (let i = 0; i < 25; i++) flights.push(flight(`T2F${i}`, 4, 'T2'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-02', 1, 1, 3, 3), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.source, 'fallback');
  assert.equal(r.noon.T1.flightCount, 2);
  assert.equal(r.noon.T2.source, 'learning');
});

test('computeShareCorrection: 当日のデータは無視 (完了日のみ)', () => {
  // SHARE_NOW = 6/3。6/3 のスナップショットは未完了日。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T1F${i}`, 4, 'T1'));
  const rows = [snapshotRow('2026-06-03T13:00:00+09:00', flights)];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-03', 3, 2, 0, 0), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.source, 'fallback');
});
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: FAIL (旧 `computeShareCorrection` は `r.noon.factor` を返すため `r.noon.T1` が undefined)

- [ ] **Step 1.3: `CORRECTION_SCHEMA_VERSION` を 2 に、`TERMINAL_STALLS` 定数を追加**

`scripts/lib/correction-engine.mjs` の変更前:

```javascript
export const CORRECTION_SCHEMA_VERSION = 1;
```

変更後:

```javascript
export const CORRECTION_SCHEMA_VERSION = 2;
```

`const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];` の直後に追加:

```javascript
// stall 添字 (buildActualMap の [s1,s2,s3,s4] 配列) → 端末。stall-rois.json 準拠。
const TERMINAL_STALLS = { T1: [0, 1], T2: [2, 3] };
```

- [ ] **Step 1.4: `sumActualForBucket` に stall 添字引数を追加**

変更前:

```javascript
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
```

変更後:

```javascript
function sumActualForBucket(actualMap, dateStr, bucket, stallIndices) {
  const fromMin = hhmmToMinutes(bucket.fromHHMM);
  const toMin = hhmmToMinutes(bucket.toHHMM);
  if (fromMin === null || toMin === null) return 0;
  let sum = 0;
  for (let slotIdx = Math.floor(fromMin / 5); slotIdx < Math.floor(toMin / 5); slotIdx++) {
    let day = dateStr;
    let idx = slotIdx;
    if (idx >= SLOTS_PER_DAY) { day = nextDayStr(dateStr); idx -= SLOTS_PER_DAY; }
    const actual = actualMap.get(slotKeyOf(day, idx));
    if (actual) {
      for (const si of stallIndices) sum += actual[si];
    }
  }
  return sum;
}
```

- [ ] **Step 1.5: `computeShareCorrection` を端末別出力に書き直す**

`computeShareCorrection` 関数**全体**を以下で置き換える:

```javascript
/**
 * transit-share バケット率の補正係数を端末別 (T1/T2/T3) に計算する。
 * 直近 SHARE_WINDOW_DAYS の完了日について、バケット×端末別に
 * 「Σ実測outflow ÷ Σ estimatedTaxiPax」の日次比率を求め、直近日ほど重い加重平均をとる。
 *
 * T1 = stall1+stall2 outflow / terminal=="T1" 便。
 * T2 = stall3+stall4 outflow / terminal=="T2" 便。
 * T3 = 観測 stall が無いため常に factor 1.0・source "unobservable"。
 *
 * @param {Array} snapshotRows  arrivals-snapshots/*.jsonl の行 (各 {ts, flights})
 * @param {Map} actualMap       buildActualMap の戻り値
 * @param {Object} transitShare data/transit-share.json (バケット定義)
 * @param {Date} now
 * @returns {Object} {<bucketId>: {T1, T2, T3}} 各端末 {factor, source, flightCount?, dayCount?}
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

  // dayRatios[bucketId][term] = [{ratio, weight}]、flightCounts[bucketId][term] = 件数
  const dayRatios = {};
  const flightCounts = {};
  for (const b of buckets) {
    dayRatios[b.id] = { T1: [], T2: [] };
    flightCounts[b.id] = { T1: 0, T2: 0 };
  }

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
    // バケット×端末別 Σ estimatedTaxiPax / 便数 (T1/T2 のみ。T3・不明は除外)
    const estByBucket = {};
    for (const b of buckets) estByBucket[b.id] = { T1: { sum: 0, count: 0 }, T2: { sum: 0, count: 0 } };
    for (const f of lastFlightByNumber.values()) {
      if (typeof f.estimatedTaxiPax !== 'number' || !f.lobbyExitTime) continue;
      const term = f.terminal;
      if (term !== 'T1' && term !== 'T2') continue;
      const bucket = pickBucket(f.lobbyExitTime, transitShare);
      if (!bucket || !estByBucket[bucket.id]) continue;
      estByBucket[bucket.id][term].sum += f.estimatedTaxiPax;
      estByBucket[bucket.id][term].count += 1;
    }
    for (const b of buckets) {
      for (const term of ['T1', 'T2']) {
        const est = estByBucket[b.id][term];
        flightCounts[b.id][term] += est.count;
        if (est.sum <= 0) continue;
        const actualSum = sumActualForBucket(actualMap, day, b, TERMINAL_STALLS[term]);
        dayRatios[b.id][term].push({ ratio: actualSum / est.sum, weight });
      }
    }
  });

  const share = {};
  for (const b of buckets) {
    share[b.id] = {};
    for (const term of ['T1', 'T2']) {
      const ratios = dayRatios[b.id][term];
      const count = flightCounts[b.id][term];
      if (ratios.length === 0 || count < SHARE_MIN_FLIGHTS) {
        share[b.id][term] = { factor: 1.0, source: 'fallback', flightCount: count, dayCount: ratios.length };
      } else {
        let wSum = 0;
        let wTotal = 0;
        for (const r of ratios) { wSum += r.ratio * r.weight; wTotal += r.weight; }
        const raw = Number((wSum / wTotal).toFixed(4));
        share[b.id][term] = {
          factor: clipFactor(raw, SHARE_FACTOR_MIN, SHARE_FACTOR_MAX),
          source: 'learning',
          flightCount: count,
          dayCount: ratios.length,
        };
      }
    }
    share[b.id].T3 = { factor: 1.0, source: 'unobservable' };
  }
  return share;
}
```

- [ ] **Step 1.6: テスト実行 → パス**

Run: `node --test tests/correction-engine.test.mjs`
Expected: PASS (clipFactor 3 + applyLevelCorrection 4 + buildEffectiveTransitShare 2 + computeLevelCorrection 5 + computeShareCorrection 7 = 21 件)

- [ ] **Step 1.7: 全テストスイート (回帰確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 392 件パス (389 - 旧 computeShare 4 + 新 computeShare 7)、fail 0

- [ ] **Step 1.8: commit**

```bash
git add scripts/lib/correction-engine.mjs tests/correction-engine.test.mjs
git commit -m "feat(correction): terminal-split computeShareCorrection (T1/T2 direct, T3 unobservable)"
```

---

## Task 2: `buildEffectiveTransitShare` の端末別化 (TDD)

**Files:**
- Modify: `scripts/lib/correction-engine.mjs`
- Modify: `tests/correction-engine.test.mjs`

- [ ] **Step 2.1: `buildEffectiveTransitShare` のテストブロックを書き直す**

`tests/correction-engine.test.mjs` の `// --- buildEffectiveTransitShare ---` から (次の `// --- computeLevelCorrection ---` の直前まで) を、以下で置き換える:

```javascript
// --- buildEffectiveTransitShare (端末別 / Phase D-4) ---

function makeTransitShare() {
  return {
    buckets: [
      { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.040, T2: 0.040, T3: 0.040 } },
      { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.060, T2: 0.060, T3: 0.055 } },
    ],
    maxRatio: 0.40,
    fallbackRate: 0.025,
  };
}

test('buildEffectiveTransitShare: corrections null → マスターと同値・別オブジェクト', () => {
  const master = makeTransitShare();
  const eff = buildEffectiveTransitShare(master, null);
  assert.equal(eff.buckets[0].rates.T1, 0.040);
  assert.equal(eff.maxRatio, 0.40);
  assert.notEqual(eff, master);
});

test('buildEffectiveTransitShare: v2 端末別 → rates が端末別に乗算・マスター非破壊', () => {
  const master = makeTransitShare();
  const corrections = {
    schemaVersion: 2,
    share: {
      noon: {
        T1: { factor: 2.0, source: 'learning' },
        T2: { factor: 0.5, source: 'learning' },
        T3: { factor: 1.0, source: 'unobservable' },
      },
    },
  };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.080); // 0.040 * 2.0
  assert.equal(eff.buckets[0].rates.T2, 0.020); // 0.040 * 0.5
  assert.equal(eff.buckets[0].rates.T3, 0.040); // 0.040 * 1.0
  assert.equal(eff.buckets[1].rates.T1, 0.060); // peak1 は補正なし
  assert.equal(eff.maxRatio, 0.40);
  assert.equal(master.buckets[0].rates.T1, 0.040); // マスター不変
});

test('buildEffectiveTransitShare: 旧 v1 一律形状 → 全端末に同じ factor を適用', () => {
  const master = makeTransitShare();
  const corrections = { schemaVersion: 1, share: { noon: { factor: 2.0, source: 'learning' } } };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.080); // 0.040 * 2.0
  assert.equal(eff.buckets[0].rates.T2, 0.080);
  assert.equal(eff.buckets[0].rates.T3, 0.080);
});

test('buildEffectiveTransitShare: factor 未定義端末 → 1.0 (補正なし)', () => {
  const master = makeTransitShare();
  // noon に T1 のみ補正、T2/T3 エントリなし
  const corrections = { schemaVersion: 2, share: { noon: { T1: { factor: 1.5 } } } };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.060); // 0.040 * 1.5
  assert.equal(eff.buckets[0].rates.T2, 0.040); // 補正なし
  assert.equal(eff.buckets[0].rates.T3, 0.040);
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: FAIL (`v2 端末別` テスト: 旧 `buildEffectiveTransitShare` は `entry.factor` しか見ず、`entry.T1.factor` を無視するため rates が変わらない)

- [ ] **Step 2.3: `buildEffectiveTransitShare` を端末別適用に書き直す**

`buildEffectiveTransitShare` 関数**全体**を以下で置き換える:

```javascript
/**
 * transit-share マスターに share 補正係数を掛けた実効版を返す。
 * 純関数 (マスター非破壊)。端末別 (v2: entry.T1/T2/T3.factor) と
 * 旧一律 (v1: entry.factor) の両形状を許容する。
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
    if (!entry || !b.rates) continue;
    for (const term of Object.keys(b.rates)) {
      let factor = 1.0;
      if (entry[term] && typeof entry[term].factor === 'number') {
        factor = entry[term].factor;        // v2: 端末別
      } else if (typeof entry.factor === 'number') {
        factor = entry.factor;              // v1: 一律
      }
      if (factor !== 1.0) b.rates[term] = b.rates[term] * factor;
    }
  }
  return effective;
}
```

- [ ] **Step 2.4: テスト実行 → パス**

Run: `node --test tests/correction-engine.test.mjs`
Expected: PASS (clipFactor 3 + applyLevelCorrection 4 + buildEffectiveTransitShare 4 + computeLevelCorrection 5 + computeShareCorrection 7 = 23 件)

- [ ] **Step 2.5: 全テストスイート**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 394 件パス (392 + buildEffectiveTransitShare 新規 2)、fail 0

- [ ] **Step 2.6: commit**

```bash
git add scripts/lib/correction-engine.mjs tests/correction-engine.test.mjs
git commit -m "feat(correction): terminal-split buildEffectiveTransitShare (v1/v2 shape tolerant)"
```

---

## Task 3: `renderCorrections` の share テーブルを端末別表示に

**Files:**
- Modify: `js/forecast-render.js`

- [ ] **Step 3.1: `renderCorrections` の share テーブル生成部を書き直す**

`js/forecast-render.js` の `renderCorrections` 内、share テーブル生成部を変更する。

変更前:

```javascript
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
```

変更後:

```javascript
  const share = corrections.share || {};
  const shareCell = (entry) => {
    if (!entry) return '—';
    if (entry.source === 'unobservable') return '<span class="src-fallback">観測外</span>';
    return `${Number(entry.factor).toFixed(2)}× ${srcSpan(entry.source)}`;
  };
  const shareRows = ['early', 'morning', 'noon', 'afternoon', 'peak1', 'evening', 'peak2', 'midnight']
    .filter(k => share[k])
    .map(k => {
      const e = share[k];
      return `<tr>
        <td class="label">${SHARE_BUCKET_LABELS[k]}</td>
        <td>${shareCell(e.T1)}</td>
        <td>${shareCell(e.T2)}</td>
        <td>${shareCell(e.T3)}</td>
      </tr>`;
    }).join('');
  shareEl.innerHTML = `<h3>transit-share バケット補正 (端末別)</h3>
    <table class="correction-table">
      <thead><tr><th>時間帯</th><th>T1</th><th>T2</th><th>T3</th></tr></thead>
      <tbody>${shareRows}</tbody>
    </table>`;
```

- [ ] **Step 3.2: 構文チェック**

Run: `node --check js/forecast-render.js && echo "syntax OK"`
Expected: `syntax OK`

- [ ] **Step 3.3: 全テスト (回帰なし確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 394 件パス、fail 0

- [ ] **Step 3.4: commit**

```bash
git add js/forecast-render.js
git commit -m "feat(correction): show terminal-split share factors in forecast.html"
```

---

## Task 4: 最終整合 + push

- [ ] **Step 4.1: observe-tick 単発実行で v2 JSON を確認**

```bash
node scripts/observe-taxi-pool.mjs 2>&1 | grep -E "\[observe\] (corrections|ensemble)"
python3 -c "
import json
d = json.load(open('data/coefficient-corrections.json'))
print('schemaVersion:', d['schemaVersion'])
noon = d['share'].get('noon', {})
print('noon keys:', sorted(noon.keys()))
print('noon.T3:', noon.get('T3'))
"
```

期待: `[observe] corrections ok` が出る。`schemaVersion: 2`、`noon keys: ['T1', 'T2', 'T3']`、`noon.T3` が `{'factor': 1.0, 'source': 'unobservable'}`。

- [ ] **Step 4.2: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/lib/correction-engine.mjs`
- `tests/correction-engine.test.mjs`
- `js/forecast-render.js`
- (docs の spec / plan)

`forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json` / `observe-taxi-pool.mjs` / `fetch-arrivals.mjs` は含まれないこと。

- [ ] **Step 4.3: 全テスト最終パス**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 394 件パス、fail 0。

- [ ] **Step 4.4: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

autostash 適用でコンフリクトが出た場合は **`git reset --hard` を使わないこと**。再生成系 JSON (`data/stall-*.json` / `data/forecast-accuracy.json` / `data/coefficient-corrections.json`) のみ `git checkout HEAD --` で破棄し、`data/taxi-pool-history.jsonl` の未コミット観測行は working tree に残す (次の observe-tick がコミットする)。解決後、`git stash list` に残った autostash を `git stash drop` する。

- [ ] **Step 4.5: push (3 回までリトライ)**

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

- [ ] **Step 4.6: 本番反映確認 (GitHub Pages 自動デプロイ後 80-90 秒)**

```bash
echo "=== coefficient-corrections.json ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/data/coefficient-corrections.json | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(f'schemaVersion: {d[\"schemaVersion\"]}')
noon = d['share'].get('noon', {})
print(f'noon keys: {sorted(noon.keys())}')
"
echo "=== forecast.html ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/forecast.html | grep -oE 'バケット補正 \(端末別\)' | head -1
```

期待: `schemaVersion: 2`、`noon keys: ['T1', 'T2', 'T3']`、`forecast.html` に「バケット補正 (端末別)」がある。

- [ ] **Step 4.7: 完了報告**

最終状態を要約。Mac mini 側は次 tick で git pull → v2 ロジック取り込み。`fetch-arrivals` は次の `update-arrivals.yml` 実行で端末別実効 transit-share を使い始める。

---

## 検証コマンド一覧 (チートシート)

```bash
# 個別テスト
node --test tests/correction-engine.test.mjs

# 全テスト
npm test

# observe-tick 単発実行
node scripts/observe-taxi-pool.mjs

# 生成 JSON
python3 -c "import json; print(json.dumps(json.load(open('data/coefficient-corrections.json')), indent=2, ensure_ascii=False))"

# 本番
open https://hidenaka.github.io/taxi-ic-helper/forecast.html
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (389 → 394 件)
- [ ] `computeShareCorrection` が端末別 (T1/T2/T3) の補正係数を返す
- [ ] `buildEffectiveTransitShare` が端末別に rates を補正、旧 v1 形状も許容
- [ ] `coefficient-corrections.json` の `schemaVersion` が 2、`share[bucket]` が T1/T2/T3 ネスト
- [ ] T3 factor は常に 1.0・`source: "unobservable"`
- [ ] `forecast.html`「係数補正状態」の share テーブルが端末別 (T1/T2/T3 列) 表示
- [ ] スコープ外ファイル (`forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json` / `observe-taxi-pool.mjs` / `fetch-arrivals.mjs`) は不変
- [ ] 観測 jsonl 追記との衝突なし
