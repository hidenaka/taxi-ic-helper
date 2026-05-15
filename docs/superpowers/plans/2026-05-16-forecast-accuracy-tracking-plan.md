# 予測精度トラッキング基盤 実装プラン (Phase D-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 各 tick の予測 (forecast / pattern-match) を forecast-log.jsonl に時系列保存し、実測 jsonl と突き合わせて lead time 別 MAE を計算、forecast.html に予測精度セクションを追加する。

**Architecture:** 純関数 `buildLogEntry` (forecast-logger.mjs) と `evaluateAccuracy` (accuracy-evaluator.mjs) を新規追加。observe-tick の末尾で forecast/pattern-match 生成の後に呼び出し、forecast-log.jsonl (Mac mini ローカル) に追記 + forecast-accuracy.json (git 管理) を生成。fail-safe で本観測 jsonl 追記は継続。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS / GitHub Actions (Pages) / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-forecast-accuracy-tracking-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/forecast-logger.mjs` | Create | 純関数 `buildLogEntry(forecast, patternMatch, tickSeq, ts)` |
| `scripts/lib/accuracy-evaluator.mjs` | Create | 純関数 `evaluateAccuracy(logEntries, actualByDateSlot, now)` + `buildActualMap(history)` |
| `tests/forecast-logger.test.mjs` | Create | 単体テスト 4 件 |
| `tests/accuracy-evaluator.test.mjs` | Create | 単体テスト 8 件 |
| `data/forecast-log.jsonl` | Create (生成物) | 予測ログ。Mac mini ローカルのみ (.gitignore) |
| `data/forecast-accuracy.json` | Create (生成物) | 集計済み精度。git 管理 |
| `.gitignore` | Modify | `data/forecast-log.jsonl` を追加 |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾で log 追記 + accuracy 評価 |
| `scripts/observe-tick-local.sh` | Modify | git add 対象に forecast-accuracy.json 追加、pull 前 checkout 対象にも追加 |
| `forecast.html` | Modify | 「予測精度」セクション追加 |
| `js/forecast-render.js` | Modify | `renderAccuracy` 追加 |
| `js/forecast-app.js` | Modify | `forecast-accuracy.json` も fetch |

実装順序: **forecast-logger (TDD) → accuracy-evaluator (TDD) → observe-tick 統合 → observe-tick-local.sh 配線 → フロント → 最終 push**。

---

## Task 1: `forecast-logger.mjs` の実装 (TDD)

**Files:**
- Create: `scripts/lib/forecast-logger.mjs`
- Create: `tests/forecast-logger.test.mjs`

- [ ] **Step 1.1: 失敗テスト 4 件を追加**

`tests/forecast-logger.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { buildLogEntry } from '../scripts/lib/forecast-logger.mjs';

function makeForecast(slots) {
  // slots: [[s1,s2,s3,s4], ...]
  return {
    slots: slots.map((v, i) => ({
      slotStart: `${String(8 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}`,
      slotEnd: '',
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}

test('buildLogEntry: forecast / patternMatch 両方空 slot → null (記録しない)', () => {
  const r = buildLogEntry({ slots: [] }, { historicalCurve: [] }, 100, '2026-06-01T17:00:00+09:00');
  assert.equal(r, null);
});

test('buildLogEntry: 正常な forecast/patternMatch → ts/tickSeq/forecast/patternMatch を持つ行', () => {
  const fc = makeForecast([[1, 0, 2, 1], [0, 1, 0, 0]]);
  const pm = { historicalCurve: [
    { slotStart: '08:00', stall1: 2, stall2: 0, stall3: 1, stall4: 1, total: 4 },
    { slotStart: '08:05', stall1: 0, stall2: 0, stall3: 1, stall4: 0, total: 1 },
  ] };
  const r = buildLogEntry(fc, pm, 100, '2026-06-01T17:00:00+09:00');
  assert.equal(r.ts, '2026-06-01T17:00:00+09:00');
  assert.equal(r.tickSeq, 100);
  assert.equal(r.forecast.length, 2);
  assert.equal(r.patternMatch.length, 2);
});

test('buildLogEntry: slot から slotStart/stall1-4/total のみ抽出 (slotEnd 等は捨てる)', () => {
  const fc = makeForecast([[1, 0, 2, 1]]);
  const r = buildLogEntry(fc, { historicalCurve: [] }, 100, '2026-06-01T17:00:00+09:00');
  const s = r.forecast[0];
  assert.deepEqual(Object.keys(s).sort(), ['slotStart', 'stall1', 'stall2', 'stall3', 'stall4', 'total'].sort());
});

test('buildLogEntry: forecast のみ存在し patternMatch 空 → patternMatch は空配列', () => {
  const fc = makeForecast([[1, 0, 2, 1]]);
  const r = buildLogEntry(fc, null, 100, '2026-06-01T17:00:00+09:00');
  assert.equal(r.forecast.length, 1);
  assert.deepEqual(r.patternMatch, []);
});
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --test tests/forecast-logger.test.mjs 2>&1 | tail -6
```

期待: `buildLogEntry is not defined` で失敗。

- [ ] **Step 1.3: `forecast-logger.mjs` を実装**

`scripts/lib/forecast-logger.mjs` の内容:

```javascript
/**
 * 予測ログ生成 (Phase D-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-forecast-accuracy-tracking-design.md
 *
 * 各 tick の forecast / pattern-match の予測スナップショットを
 * forecast-log.jsonl の 1 行に整形する純関数。
 */

function compactSlot(s) {
  return {
    slotStart: s.slotStart,
    stall1: s.stall1,
    stall2: s.stall2,
    stall3: s.stall3,
    stall4: s.stall4,
    total: s.total,
  };
}

/**
 * @param {{slots: Array}|null} forecast      stall-forecast.json 相当
 * @param {{historicalCurve: Array}|null} patternMatch  stall-pattern-match.json 相当
 * @param {number} tickSeq
 * @param {string} ts ISO 文字列 (JST)
 * @returns {{ts, tickSeq, forecast, patternMatch}|null} 両方空なら null
 */
export function buildLogEntry(forecast, patternMatch, tickSeq, ts) {
  const fcSlots = (forecast && Array.isArray(forecast.slots)) ? forecast.slots : [];
  const pmSlots = (patternMatch && Array.isArray(patternMatch.historicalCurve))
    ? patternMatch.historicalCurve : [];
  if (fcSlots.length === 0 && pmSlots.length === 0) return null;
  return {
    ts,
    tickSeq,
    forecast: fcSlots.map(compactSlot),
    patternMatch: pmSlots.map(compactSlot),
  };
}
```

- [ ] **Step 1.4: テスト再実行 → 全件パス**

```bash
node --test tests/forecast-logger.test.mjs 2>&1 | tail -6
```

期待: 4 件パス。

- [ ] **Step 1.5: 全テストスイート (回帰確認)**

```bash
npm test 2>&1 | tail -6
```

期待: 351 + 4 = 355 件パス。

- [ ] **Step 1.6: commit**

```bash
git add scripts/lib/forecast-logger.mjs tests/forecast-logger.test.mjs
git commit -m "feat(accuracy): add forecast-logger (buildLogEntry)"
```

---

## Task 2: `accuracy-evaluator.mjs` の `buildActualMap` (TDD)

**Files:**
- Create: `scripts/lib/accuracy-evaluator.mjs`
- Create: `tests/accuracy-evaluator.test.mjs`

- [ ] **Step 2.1: 失敗テスト 3 件を追加**

`tests/accuracy-evaluator.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { buildActualMap, slotKeyOf } from '../scripts/lib/accuracy-evaluator.mjs';

function makeRow(ts, lum, s1d, s2d, s3d, s4d) {
  return {
    schema_version: 3,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: s1d },
      stall2: { diff_occupied_from_prev: s2d },
      stall3: { diff_occupied_from_prev: s3d },
      stall4: { diff_occupied_from_prev: s4d },
    },
  };
}

test('slotKeyOf: 日付 + slotIdx の合成キー', () => {
  assert.equal(slotKeyOf('2026-06-01', 210), '2026-06-01#210');
});

test('buildActualMap: 信頼サブセットの出庫を date#slotIdx で引ける', () => {
  const history = [
    makeRow('2026-06-01T12:00:00+09:00', 100, -2, 0, -1, 0),
    makeRow('2026-06-01T12:05:00+09:00', 100, 0, -3, 0, 0),
  ];
  const m = buildActualMap(history);
  // 12:00 → slotIdx 144
  assert.deepEqual(m.get('2026-06-01#144'), [2, 0, 1, 0]);
  // 12:05 → slotIdx 145
  assert.deepEqual(m.get('2026-06-01#145'), [0, 3, 0, 0]);
});

test('buildActualMap: 夜間 (luminance<30) は除外', () => {
  const history = [
    makeRow('2026-06-01T03:00:00+09:00', 10, -5, 0, 0, 0),
  ];
  const m = buildActualMap(history);
  assert.equal(m.has('2026-06-01#36'), false);
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
node --test tests/accuracy-evaluator.test.mjs 2>&1 | tail -6
```

期待: `buildActualMap is not defined` で失敗。

- [ ] **Step 2.3: `accuracy-evaluator.mjs` の基礎部分を実装**

`scripts/lib/accuracy-evaluator.mjs` の内容:

```javascript
/**
 * 予測精度評価 (Phase D-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-forecast-accuracy-tracking-design.md
 *
 * forecast-log.jsonl の過去予測と、実測 jsonl を突き合わせて
 * lead time 別 MAE を計算する純関数群。
 */

export const SLOTS_PER_HOUR = 12;
export const SLOTS_PER_DAY = 288;
export const NIGHT_LUMINANCE_THRESHOLD = 30;
export const ACCURACY_SCHEMA_VERSION = 1;

// lead time バケット: [ラベル, 中心分, 許容幅]
export const LEAD_BUCKETS = [
  { key: 'lead30', center: 30, halfWidth: 5 },
  { key: 'lead60', center: 60, halfWidth: 5 },
  { key: 'lead120', center: 120, halfWidth: 5 },
];

export function slotKeyOf(dateStr, slotIdx) {
  return `${dateStr}#${slotIdx}`;
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 信頼サブセットの jsonl 行群から、各 (日付, slotIdx) の出庫実測を Map で返す。
 * 値は [stall1Out, stall2Out, stall3Out, stall4Out]。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean >= 30 ∧ stalls 非 null
 */
export function buildActualMap(history) {
  const map = new Map();
  for (const row of history) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const ts = new Date(row.ts);
    if (Number.isNaN(ts.getTime())) continue;
    const slotIdx = ts.getHours() * SLOTS_PER_HOUR + Math.floor(ts.getMinutes() / 5);
    const key = slotKeyOf(formatYmd(ts), slotIdx);
    const out = [0, 0, 0, 0];
    const names = ['stall1', 'stall2', 'stall3', 'stall4'];
    for (let i = 0; i < 4; i++) {
      const d = row.stalls[names[i]]?.diff_occupied_from_prev;
      if (typeof d === 'number' && d < 0) out[i] = -d;
    }
    map.set(key, out);
  }
  return map;
}
```

- [ ] **Step 2.4: テスト再実行 → パス**

```bash
node --test tests/accuracy-evaluator.test.mjs 2>&1 | tail -6
```

期待: 3 件パス。

- [ ] **Step 2.5: commit**

```bash
git add scripts/lib/accuracy-evaluator.mjs tests/accuracy-evaluator.test.mjs
git commit -m "feat(accuracy): add buildActualMap (trusted subset outflow lookup)"
```

---

## Task 3: `evaluateAccuracy` の実装 (TDD)

**Files:**
- Modify: `scripts/lib/accuracy-evaluator.mjs`
- Modify: `tests/accuracy-evaluator.test.mjs`

- [ ] **Step 3.1: 失敗テスト 5 件を追加**

`tests/accuracy-evaluator.test.mjs` の末尾に追加:

```javascript
import { evaluateAccuracy } from '../scripts/lib/accuracy-evaluator.mjs';

// logEntry を作るヘルパ。発行 ts と、24 slot 分の forecast/patternMatch。
function makeLogEntry(ts, tickSeq, fcSlots, pmSlots) {
  return { ts, tickSeq, forecast: fcSlots, patternMatch: pmSlots };
}
// slot: 発行時刻から leadMin 後の slot を作る
function slotAt(baseDate, leadMin, s1, s2, s3, s4) {
  const d = new Date(baseDate.getTime() + leadMin * 60000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return { slotStart: `${hh}:${mm}`, stall1: s1, stall2: s2, stall3: s3, stall4: s4, total: s1 + s2 + s3 + s4 };
}

test('evaluateAccuracy: logEntries 0 件 → 全バケット n=0', () => {
  const r = evaluateAccuracy([], new Map(), new Date('2026-06-01T19:00:00+09:00'));
  assert.equal(r.recent24h.forecast.lead30.n, 0);
  assert.equal(r.recent24h.forecast.lead30.mae_total, null);
  assert.equal(r.allPeriod.patternMatch.lead60.n, 0);
});

test('evaluateAccuracy: 予測 = 実測 → MAE 0', () => {
  const issue = new Date('2026-06-01T12:00:00+09:00');
  // 30 分後の slot を 1 つだけ予測
  const fcSlot = slotAt(issue, 30, 1, 1, 1, 1);
  const log = [makeLogEntry(issue.toISOString().replace('Z', '+09:00'), 1, [fcSlot], [])];
  // 実測: 12:30 = slotIdx 150
  const actual = new Map([['2026-06-01#150', [1, 1, 1, 1]]]);
  const r = evaluateAccuracy(log, actual, new Date('2026-06-01T13:00:00+09:00'));
  assert.equal(r.allPeriod.forecast.lead30.mae_total, 0);
  assert.equal(r.allPeriod.forecast.lead30.n, 1);
});

test('evaluateAccuracy: 予測ズレ → MAE が絶対誤差', () => {
  const issue = new Date('2026-06-01T12:00:00+09:00');
  const fcSlot = slotAt(issue, 30, 3, 0, 0, 0); // 予測 total 3
  const log = [makeLogEntry(issue.toISOString().replace('Z', '+09:00'), 1, [fcSlot], [])];
  const actual = new Map([['2026-06-01#150', [1, 0, 0, 0]]]); // 実測 total 1
  const r = evaluateAccuracy(log, actual, new Date('2026-06-01T13:00:00+09:00'));
  // |3 - 1| = 2
  assert.equal(r.allPeriod.forecast.lead30.mae_total, 2);
});

test('evaluateAccuracy: 実測なし slot はスキップ (n に数えない)', () => {
  const issue = new Date('2026-06-01T12:00:00+09:00');
  const fcSlot = slotAt(issue, 30, 1, 1, 1, 1);
  const log = [makeLogEntry(issue.toISOString().replace('Z', '+09:00'), 1, [fcSlot], [])];
  const r = evaluateAccuracy(log, new Map(), new Date('2026-06-01T13:00:00+09:00'));
  assert.equal(r.allPeriod.forecast.lead30.n, 0);
});

test('evaluateAccuracy: winner 判定 (forecast の MAE 小 → "forecast")', () => {
  const issue = new Date('2026-06-01T12:00:00+09:00');
  const fcSlot = slotAt(issue, 30, 1, 0, 0, 0); // forecast total 1 (実測と一致)
  const pmSlot = slotAt(issue, 30, 5, 0, 0, 0); // patternMatch total 5 (ズレ大)
  const log = [makeLogEntry(issue.toISOString().replace('Z', '+09:00'), 1, [fcSlot], [pmSlot])];
  const actual = new Map([['2026-06-01#150', [1, 0, 0, 0]]]);
  const r = evaluateAccuracy(log, actual, new Date('2026-06-01T13:00:00+09:00'));
  assert.equal(r.allPeriod.winner.lead30, 'forecast');
});
```

- [ ] **Step 3.2: テスト実行 → 失敗確認**

```bash
node --test tests/accuracy-evaluator.test.mjs 2>&1 | tail -6
```

期待: `evaluateAccuracy is not defined` で失敗。

- [ ] **Step 3.3: `evaluateAccuracy` を実装**

`scripts/lib/accuracy-evaluator.mjs` の末尾に追加:

```javascript
function jstNowIsoString(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

/**
 * slotStart "HH:MM" と発行日 issueDate から、その slot の実測キーを作る。
 * slot 時刻が発行時刻より前 (= 翌日の slot) なら日付を +1 する。
 */
function resolveActualKey(issueDate, slotStart) {
  const [hh, mm] = slotStart.split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const slotIdx = hh * SLOTS_PER_HOUR + Math.floor(mm / 5);
  const issueSlotIdx = issueDate.getHours() * SLOTS_PER_HOUR + Math.floor(issueDate.getMinutes() / 5);
  const dateForSlot = new Date(issueDate);
  // slot が発行時刻より前なら翌日扱い
  if (slotIdx <= issueSlotIdx) {
    dateForSlot.setDate(dateForSlot.getDate() + 1);
  }
  const y = dateForSlot.getFullYear();
  const m = String(dateForSlot.getMonth() + 1).padStart(2, '0');
  const d = String(dateForSlot.getDate()).padStart(2, '0');
  return { key: slotKeyOf(`${y}-${m}-${d}`, slotIdx), slotIdx };
}

function leadBucketOf(leadMinutes) {
  for (const b of LEAD_BUCKETS) {
    if (Math.abs(leadMinutes - b.center) <= b.halfWidth) return b.key;
  }
  return null;
}

function emptyBucketStats() {
  const stats = {};
  for (const b of LEAD_BUCKETS) {
    stats[b.key] = { absSum: 0, absPerStall: [0, 0, 0, 0], n: 0 };
  }
  return stats;
}

function finalizeBucketStats(stats) {
  const out = {};
  for (const b of LEAD_BUCKETS) {
    const s = stats[b.key];
    if (s.n === 0) {
      out[b.key] = { mae_total: null, mae_per_stall: [null, null, null, null], n: 0 };
    } else {
      out[b.key] = {
        mae_total: Number((s.absSum / s.n).toFixed(3)),
        mae_per_stall: s.absPerStall.map(v => Number((v / s.n).toFixed(3))),
        n: s.n,
      };
    }
  }
  return out;
}

/**
 * 1 つの method (forecast / patternMatch) の予測 slot 配列を評価し、stats に加算する。
 */
function accumulate(stats, issueDate, predSlots, actualMap) {
  for (const slot of predSlots) {
    const resolved = resolveActualKey(issueDate, slot.slotStart);
    if (!resolved) continue;
    const actual = actualMap.get(resolved.key);
    if (!actual) continue; // 実測なし (信頼サブセット外 or 未来) → スキップ
    // lead time = slot 時刻 - 発行時刻
    const [hh, mm] = slot.slotStart.split(':').map(Number);
    const slotDate = new Date(issueDate);
    const slotIdx = resolved.slotIdx;
    const issueSlotIdx = issueDate.getHours() * SLOTS_PER_HOUR + Math.floor(issueDate.getMinutes() / 5);
    let leadSlots = slotIdx - issueSlotIdx;
    if (leadSlots <= 0) leadSlots += SLOTS_PER_DAY;
    const leadMinutes = leadSlots * 5;
    const bucket = leadBucketOf(leadMinutes);
    if (!bucket) continue;
    const predStalls = [slot.stall1, slot.stall2, slot.stall3, slot.stall4];
    const predTotal = slot.total;
    const actualTotal = actual[0] + actual[1] + actual[2] + actual[3];
    const s = stats[bucket];
    s.absSum += Math.abs(predTotal - actualTotal);
    for (let i = 0; i < 4; i++) {
      s.absPerStall[i] += Math.abs(predStalls[i] - actual[i]);
    }
    s.n += 1;
  }
}

function evaluatePeriod(logEntries, actualMap) {
  const fcStats = emptyBucketStats();
  const pmStats = emptyBucketStats();
  for (const entry of logEntries) {
    const issueDate = new Date(entry.ts);
    if (Number.isNaN(issueDate.getTime())) continue;
    if (Array.isArray(entry.forecast)) accumulate(fcStats, issueDate, entry.forecast, actualMap);
    if (Array.isArray(entry.patternMatch)) accumulate(pmStats, issueDate, entry.patternMatch, actualMap);
  }
  const forecast = finalizeBucketStats(fcStats);
  const patternMatch = finalizeBucketStats(pmStats);
  const winner = {};
  for (const b of LEAD_BUCKETS) {
    const f = forecast[b.key].mae_total;
    const p = patternMatch[b.key].mae_total;
    if (f === null && p === null) winner[b.key] = 'n/a';
    else if (p === null) winner[b.key] = 'forecast';
    else if (f === null) winner[b.key] = 'patternMatch';
    else winner[b.key] = f <= p ? 'forecast' : 'patternMatch';
  }
  return { forecast, patternMatch, winner };
}

/**
 * 予測精度を評価する。
 *
 * @param {Array} logEntries forecast-log.jsonl の全行
 * @param {Map<string, number[]>} actualMap buildActualMap の戻り値
 * @param {Date} now
 * @returns 精度オブジェクト
 */
export function evaluateAccuracy(logEntries, actualMap, now) {
  const cutoff = now.getTime() - 24 * 3600 * 1000;
  const recentEntries = logEntries.filter(e => {
    const t = new Date(e.ts).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });
  return {
    schemaVersion: ACCURACY_SCHEMA_VERSION,
    generatedAt: jstNowIsoString(now),
    logEntryCount: logEntries.length,
    recent24h: evaluatePeriod(recentEntries, actualMap),
    allPeriod: evaluatePeriod(logEntries, actualMap),
  };
}
```

- [ ] **Step 3.4: テスト再実行 → 全件パス**

```bash
node --test tests/accuracy-evaluator.test.mjs 2>&1 | tail -8
```

期待: 8 件パス (Task 2 の 3 件 + Task 3 の 5 件)。

- [ ] **Step 3.5: 全テストスイート**

```bash
npm test 2>&1 | tail -6
```

期待: 355 + 8 = 363 件パス。

- [ ] **Step 3.6: commit**

```bash
git add scripts/lib/accuracy-evaluator.mjs tests/accuracy-evaluator.test.mjs
git commit -m "feat(accuracy): implement evaluateAccuracy (lead-time MAE + winner)"
```

---

## Task 4: `observe-taxi-pool.mjs` に log 追記 + accuracy 評価を組み込み

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`
- Modify: `.gitignore`

- [ ] **Step 4.1: `.gitignore` に forecast-log.jsonl を追加**

`.gitignore` の末尾に追加:

```
data/forecast-log.jsonl
```

- [ ] **Step 4.2: import 追加**

`scripts/observe-taxi-pool.mjs` の既存 import 群の最後 (`import { loadHolidaysSet } from './lib/calendar-context.mjs';` の直後) に追加:

```javascript
import { buildLogEntry } from './lib/forecast-logger.mjs';
import { buildActualMap, evaluateAccuracy } from './lib/accuracy-evaluator.mjs';
```

- [ ] **Step 4.3: 定数追加**

既存の `const HOLIDAYS_PATH = './data/japan-holidays.json';` の直後に追加:

```javascript
const FORECAST_LOG_PATH = './data/forecast-log.jsonl';
const FORECAST_ACCURACY_PATH = './data/forecast-accuracy.json';
```

- [ ] **Step 4.4: log 追記 + accuracy 評価ロジックを追加**

pattern-match 生成の try/catch ブロック (`[observe] pattern-match ok` を出力するブロック) の直後に挿入。
このブロックは `forecast` 変数と `patternMatch` 変数が両方スコープにある必要がある。
そのため forecast と pattern-match の生成を別 try/catch にしている現状では、両者の結果を
ブロック外の変数に持つ必要がある。以下の手順で行う:

まず forecast 生成ブロックの直前に変数宣言を追加 (forecast 生成 try の前):

```javascript
  let forecastResult = null;
  let patternMatchResult = null;
```

forecast 生成ブロック内の `const forecast = computeForecast(...)` を
`forecastResult = computeForecast(...)` に変更し、後続の参照も `forecastResult` にする。
具体的には forecast 生成ブロックを以下に置き換え:

```javascript
  // Phase C-1 MVP: stall 短期需要予測の生成
  try {
    const allHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const allHistory = [];
    for (const line of allHistoryLines) {
      if (!line.trim()) continue;
      try { allHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const baseline = computeBaseline(allHistory);
    const recent = allHistory.slice(-12).map(r => {
      const stalls = r.stalls || {};
      let totalOutflow = 0;
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const d = stalls[name]?.diff_occupied_from_prev;
        if (typeof d === 'number' && d < 0) totalOutflow += -d;
      }
      return { ts: r.ts, total_outflow: totalOutflow };
    });
    forecastResult = computeForecast(baseline, recent, arrivalsJson, new Date());
    writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(forecastResult, null, 2) + '\n', 'utf8');
    console.log(`[observe] forecast ok: trendFactor=${forecastResult.trendFactor.toFixed(2)} baselineSamples=${forecastResult.baselineSampleCount}`);
  } catch (e) {
    console.error(`[observe] forecast generation failed: ${e.message}`);
  }
```

pattern-match 生成ブロックを以下に置き換え:

```javascript
  // Phase C-2 MVP: パターンマッチング予測の生成
  try {
    const allHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const allHistory = [];
    for (const line of allHistoryLines) {
      if (!line.trim()) continue;
      try { allHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    let holidaysSet;
    try {
      const holidaysJson = JSON.parse(readFileSync(HOLIDAYS_PATH, 'utf8'));
      holidaysSet = loadHolidaysSet(holidaysJson);
    } catch {
      holidaysSet = loadHolidaysSet({ holidays: [] });
    }
    patternMatchResult = computePatternMatch(allHistory, holidaysSet, new Date());
    writeFileSync(PATTERN_MATCH_OUTPUT_PATH, JSON.stringify(patternMatchResult, null, 2) + '\n', 'utf8');
    console.log(`[observe] pattern-match ok: today=${patternMatchResult.today.dayType} tier=${patternMatchResult.today.filterTier} similar=${patternMatchResult.similarDays.length}`);
  } catch (e) {
    console.error(`[observe] pattern-match generation failed: ${e.message}`);
  }
```

pattern-match ブロックの直後に Phase D-1 ブロックを挿入:

```javascript
  // Phase D-1: 予測ログ記録 + 精度評価
  try {
    // 予測ログの追記 (patternMatch は historicalCurve を持つ形)
    const logEntry = buildLogEntry(
      forecastResult,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      tickSeq,
      ts
    );
    if (logEntry) {
      appendFileSync(FORECAST_LOG_PATH, JSON.stringify(logEntry) + '\n', 'utf8');
    }
    // 精度評価
    let logEntries = [];
    if (existsSync(FORECAST_LOG_PATH)) {
      const logLines = readFileSync(FORECAST_LOG_PATH, 'utf8').trim().split('\n');
      for (const line of logLines) {
        if (!line.trim()) continue;
        try { logEntries.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
    }
    const accHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const accHistory = [];
    for (const line of accHistoryLines) {
      if (!line.trim()) continue;
      try { accHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const actualMap = buildActualMap(accHistory);
    const accuracy = evaluateAccuracy(logEntries, actualMap, new Date());
    writeFileSync(FORECAST_ACCURACY_PATH, JSON.stringify(accuracy, null, 2) + '\n', 'utf8');
    console.log(`[observe] accuracy ok: logEntries=${accuracy.logEntryCount} recent24h winner lead30=${accuracy.recent24h.winner.lead30}`);
  } catch (e) {
    console.error(`[observe] accuracy evaluation failed: ${e.message}`);
  }
```

- [ ] **Step 4.5: 構文チェック + 単発実行**

```bash
node --check scripts/observe-taxi-pool.mjs
node scripts/observe-taxi-pool.mjs 2>&1 | tail -8
```

期待: 出力に `[observe] accuracy ok: logEntries=...` が含まれる。初回は logEntries=1 程度。

- [ ] **Step 4.6: 生成された JSON を確認**

```bash
ls -la data/forecast-log.jsonl data/forecast-accuracy.json
python3 -c "
import json
d = json.load(open('data/forecast-accuracy.json'))
print(f'schemaVersion: {d[\"schemaVersion\"]}')
print(f'logEntryCount: {d[\"logEntryCount\"]}')
print(f'recent24h forecast lead30: {d[\"recent24h\"][\"forecast\"][\"lead30\"]}')
print(f'recent24h winner: {d[\"recent24h\"][\"winner\"]}')
"
```

期待:
- `forecast-log.jsonl` が 1 行以上
- `forecast-accuracy.json` に `recent24h` / `allPeriod` / `winner` がある
- 初回は実測がまだ対応しないので n=0 が多い

- [ ] **Step 4.7: 全テスト (回帰確認)**

```bash
npm test 2>&1 | tail -6
```

期待: 363 件パス。

- [ ] **Step 4.8: commit**

```bash
git add .gitignore scripts/observe-taxi-pool.mjs data/forecast-accuracy.json
git commit -m "feat(observe): log forecasts and evaluate accuracy each tick"
```

(`data/forecast-log.jsonl` は .gitignore 済みなので add されない)

---

## Task 5: `observe-tick-local.sh` の配線

**Files:**
- Modify: `scripts/observe-tick-local.sh`

- [ ] **Step 5.1: pull 前の checkout 対象に forecast-accuracy.json を追加**

`scripts/observe-tick-local.sh` の 2 箇所の `git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json` を、両方とも以下に変更:

```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json 2>/dev/null || true
```

(dirty state cleanup ブロック内と、その後の pull 前ブロックの 2 箇所)

- [ ] **Step 5.2: git add 対象に forecast-accuracy.json を追加**

`scripts/observe-tick-local.sh` の以下の行:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json 2>/dev/null || true
```

を以下に変更:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json 2>/dev/null || true
```

- [ ] **Step 5.3: 構文チェック**

```bash
bash -n scripts/observe-tick-local.sh
```

期待: 何も出力されない。

- [ ] **Step 5.4: commit**

```bash
git add scripts/observe-tick-local.sh
git commit -m "chore(observe): wire forecast-accuracy.json into observe-tick git flow"
```

---

## Task 6: `forecast.html` に予測精度セクション追加

**Files:**
- Modify: `forecast.html`
- Modify: `js/forecast-render.js`
- Modify: `js/forecast-app.js`

- [ ] **Step 6.1: `forecast.html` にスタイル + セクション追加**

`<style>` 末尾 (既存 `.similar-day-score` の後) に追加:

```css
.accuracy-section { margin-top: 32px; padding-top: 16px; border-top: 1px solid #222; }
.accuracy-section h2 { font-size: 16px; margin: 0 0 8px 0; }
.accuracy-meta { color: var(--sub); font-size: 13px; margin-bottom: 12px; }
.accuracy-table { border-collapse: collapse; width: 100%; max-width: 520px; }
.accuracy-table th, .accuracy-table td { padding: 6px 10px; border-bottom: 1px solid #222; text-align: right; font-variant-numeric: tabular-nums; }
.accuracy-table th { background: #16161c; color: var(--sub); font-weight: 500; font-size: 12px; }
.accuracy-table td.lead { text-align: left; font-weight: 600; }
.winner-fc { color: var(--accent); }
.winner-pm { color: var(--high); }
```

`<main>` 内の `#pattern-section` セクションの直後に追加:

```html
    <section class="accuracy-section" id="accuracy-section">
      <h2>予測精度 (直近 24 時間)</h2>
      <div id="accuracy-meta" class="accuracy-meta">読み込み中...</div>
      <div id="accuracy-table-wrap"></div>
    </section>
```

- [ ] **Step 6.2: `js/forecast-render.js` に `renderAccuracy` を追加**

ファイル末尾に追加:

```javascript
// --- Phase D-1: 予測精度描画 ---

const LEAD_LABEL = { lead30: '30 分先', lead60: '60 分先', lead120: '120 分先' };

export function renderAccuracy(metaEl, tableEl, accuracy) {
  if (!metaEl || !tableEl || !accuracy) return;
  const r24 = accuracy.recent24h;
  metaEl.innerHTML = `予測時刻 ${(accuracy.generatedAt || '').slice(0, 16).replace('T', ' ')} JST / ログ ${accuracy.logEntryCount} 件`;

  if (!r24) {
    tableEl.innerHTML = '<p class="accuracy-meta">精度データなし</p>';
    return;
  }
  const fmt = (v) => (v === null || v === undefined) ? '—' : `${v.toFixed(2)} 台`;
  const rows = ['lead30', 'lead60', 'lead120'].map(k => {
    const fc = r24.forecast[k] || { mae_total: null, n: 0 };
    const pm = r24.patternMatch[k] || { mae_total: null, n: 0 };
    const w = r24.winner[k];
    let winLabel = '—';
    if (w === 'forecast') winLabel = '<span class="winner-fc">forecast</span>';
    else if (w === 'patternMatch') winLabel = '<span class="winner-pm">pattern</span>';
    return `<tr>
      <td class="lead">${LEAD_LABEL[k]}</td>
      <td>${fmt(fc.mae_total)}</td>
      <td>${fmt(pm.mae_total)}</td>
      <td>${winLabel}</td>
      <td>${fc.n}</td>
    </tr>`;
  }).join('');
  tableEl.innerHTML = `<table class="accuracy-table">
    <thead><tr>
      <th>lead time</th><th>forecast MAE</th><th>pattern MAE</th><th>優勢</th><th>n</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
```

- [ ] **Step 6.3: `js/forecast-app.js` に accuracy fetch + render を追加**

`js/forecast-app.js` 全体を以下に置き換え:

```javascript
import {
  renderForecastMeta, renderForecastTable,
  renderPatternMeta, renderSimilarDays, renderHistoricalCurve,
  renderAccuracy,
} from './forecast-render.js';

async function main() {
  const metaEl = document.getElementById('forecast-meta');
  const tableEl = document.getElementById('forecast-table-wrap');
  const patternMetaEl = document.getElementById('pattern-meta');
  const similarDaysEl = document.getElementById('similar-days');
  const curveEl = document.getElementById('historical-curve-wrap');
  const accuracyMetaEl = document.getElementById('accuracy-meta');
  const accuracyTableEl = document.getElementById('accuracy-table-wrap');

  // 短期予測 (Phase C-1)
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

  // パターンマッチング (Phase C-2)
  try {
    const res = await fetch('data/stall-pattern-match.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const patternMatch = await res.json();
    renderPatternMeta(patternMetaEl, patternMatch);
    renderSimilarDays(similarDaysEl, patternMatch);
    renderHistoricalCurve(curveEl, patternMatch);
  } catch (e) {
    patternMetaEl.textContent = `パターンマッチングデータの読み込みに失敗: ${e.message}`;
    similarDaysEl.innerHTML = '';
    curveEl.innerHTML = '';
  }

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

main();
```

- [ ] **Step 6.4: 構文チェック**

```bash
node --check js/forecast-render.js
node --check js/forecast-app.js
```

期待: 両方とも何も出力されない。

- [ ] **Step 6.5: 全テスト (回帰なし確認)**

```bash
npm test 2>&1 | tail -6
```

期待: 363 件パス。

- [ ] **Step 6.6: commit**

```bash
git add forecast.html js/forecast-render.js js/forecast-app.js
git commit -m "feat(accuracy): add forecast accuracy section to forecast.html"
```

---

## Task 7: 最終整合 + push

- [ ] **Step 7.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/lib/forecast-logger.mjs`
- `scripts/lib/accuracy-evaluator.mjs`
- `tests/forecast-logger.test.mjs`
- `tests/accuracy-evaluator.test.mjs`
- `.gitignore`
- `scripts/observe-taxi-pool.mjs`
- `scripts/observe-tick-local.sh`
- `data/forecast-accuracy.json`
- `forecast.html`
- `js/forecast-render.js`
- `js/forecast-app.js`

`forecast-engine.mjs` / `pattern-matcher.mjs` / `transit-share.json` は含まれないこと。

- [ ] **Step 7.2: 全テスト最終パス**

```bash
npm test 2>&1 | tail -6
```

期待: 363 件パス。

- [ ] **Step 7.3: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

- [ ] **Step 7.4: push (3 回までリトライ)**

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

- [ ] **Step 7.5: 本番反映確認 (GitHub Pages 自動デプロイ後 75-90 秒)**

```bash
sleep 90
echo "=== forecast-accuracy.json ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/data/forecast-accuracy.json | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(f'logEntryCount: {d[\"logEntryCount\"]}')
print(f'recent24h winner: {d[\"recent24h\"][\"winner\"]}')
print(f'allPeriod forecast lead30: {d[\"allPeriod\"][\"forecast\"][\"lead30\"]}')
"
echo "=== forecast.html ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/forecast.html | grep -E "accuracy-section|予測精度" | head -3
```

期待: forecast-accuracy.json が取得でき、forecast.html に「予測精度」「accuracy-section」がある。

- [ ] **Step 7.6: 完了報告**

最終状態を要約。Mac mini 側は次 tick で git pull → 新ロジック取り込み、observe-tick-local.sh の新配線で forecast-accuracy.json も commit されるようになる。

---

## 検証コマンド一覧 (チートシート)

```bash
# 個別テスト
node --test tests/forecast-logger.test.mjs
node --test tests/accuracy-evaluator.test.mjs

# 全テスト
npm test

# observe-tick 単発実行 (forecast + pattern-match + accuracy 生成)
node scripts/observe-taxi-pool.mjs

# 生成 JSON 確認
python3 -c "import json; print(json.dumps(json.load(open('data/forecast-accuracy.json')), indent=2, ensure_ascii=False)[:1200])"

# 本番
open https://hidenaka.github.io/taxi-ic-helper/forecast.html
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (351 → 363 件)
- [ ] `scripts/lib/forecast-logger.mjs` / `accuracy-evaluator.mjs` 純関数として実装
- [ ] observe-tick で `data/forecast-log.jsonl` 追記 + `data/forecast-accuracy.json` 更新
- [ ] `data/forecast-log.jsonl` が `.gitignore` 済み
- [ ] `observe-tick-local.sh` の git add / checkout 対象に forecast-accuracy.json 追加
- [ ] `forecast.html` に予測精度セクションが表示される
- [ ] スコープ外ファイル (forecast-engine.mjs / pattern-matcher.mjs / transit-share.json) は触っていない
- [ ] 観測 jsonl 追記との衝突なし
