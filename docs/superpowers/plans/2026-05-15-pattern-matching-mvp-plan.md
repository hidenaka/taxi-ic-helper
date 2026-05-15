# パターンマッチング予測 MVP 実装プラン (Phase C-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 過去 jsonl から「今日と似ている過去日」を 6 カテゴリ dayType + 月でプレフィルタしつつ cosine 類似度で上位 5 件抽出、その平均でヒストリカル予測カーブを生成し、forecast.html に類似日カードと予測テーブルを追加表示する。

**Architecture:** 純関数 `getDayType` (calendar-context.mjs) + `computePatternMatch` (pattern-matcher.mjs) を新規追加。observe-tick の末尾で呼び出し、Phase C-1 の forecast 生成と並列で `data/stall-pattern-match.json` を出力。fail-safe で本観測 jsonl 追記は継続。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS / GitHub Actions (Pages) / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-15-pattern-matching-mvp-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `data/japan-holidays.json` | Create | 2026-2027 年の祝日リスト (国民の祝日 + 振替休日) |
| `scripts/lib/calendar-context.mjs` | Create | 純関数: `loadHolidaysSet(json)`, `getDayType(date, holidaysSet)`, `formatYmd(date)` |
| `scripts/lib/pattern-matcher.mjs` | Create | 純関数: `computePatternMatch(historyAll, holidaysSet, now)` |
| `tests/calendar-context.test.mjs` | Create | dayType 判定テスト 6 件 |
| `tests/pattern-matcher.test.mjs` | Create | パターンマッチングテスト 9 件 |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾で `computePatternMatch` 呼び出し、`data/stall-pattern-match.json` 書き込み |
| `data/stall-pattern-match.json` | Create (生成物) | 類似日 + ヒストリカル予測カーブ |
| `forecast.html` | Modify | 「類似日マッチング」セクション追加 |
| `js/forecast-app.js` | Modify | 2 つ目の JSON も fetch、新関数を呼ぶ |
| `js/forecast-render.js` | Modify | `renderPatternMeta`, `renderSimilarDays`, `renderHistoricalCurve` 追加 |

実装順序: **calendar-context (TDD) → pattern-matcher (TDD) → observe-tick 統合 → フロント表示 → 最終 push**。

---

## Task 1: `data/japan-holidays.json` 作成

**Files:**
- Create: `data/japan-holidays.json`

- [ ] **Step 1.1: 2026-2027 年の祝日リストを JSON で作成**

`data/japan-holidays.json` の内容:

```json
{
  "_meta": {
    "source": "内閣府 国民の祝日 (https://www.cao.go.jp/chosei/shukujitsu/gaiyou.html)",
    "scope": "国民の祝日 + 振替休日 (日曜と重なった場合の翌平日)",
    "updated": "2026-05-15",
    "note": "年 1 回 (12 月) に翌年分を追加更新。"
  },
  "holidays": [
    { "date": "2026-01-01", "name": "元日" },
    { "date": "2026-01-12", "name": "成人の日" },
    { "date": "2026-02-11", "name": "建国記念の日" },
    { "date": "2026-02-23", "name": "天皇誕生日" },
    { "date": "2026-03-20", "name": "春分の日" },
    { "date": "2026-04-29", "name": "昭和の日" },
    { "date": "2026-05-03", "name": "憲法記念日" },
    { "date": "2026-05-04", "name": "みどりの日" },
    { "date": "2026-05-05", "name": "こどもの日" },
    { "date": "2026-05-06", "name": "振替休日" },
    { "date": "2026-07-20", "name": "海の日" },
    { "date": "2026-08-11", "name": "山の日" },
    { "date": "2026-09-21", "name": "敬老の日" },
    { "date": "2026-09-22", "name": "国民の休日" },
    { "date": "2026-09-23", "name": "秋分の日" },
    { "date": "2026-10-12", "name": "スポーツの日" },
    { "date": "2026-11-03", "name": "文化の日" },
    { "date": "2026-11-23", "name": "勤労感謝の日" },
    { "date": "2027-01-01", "name": "元日" },
    { "date": "2027-01-11", "name": "成人の日" },
    { "date": "2027-02-11", "name": "建国記念の日" },
    { "date": "2027-02-23", "name": "天皇誕生日" },
    { "date": "2027-03-21", "name": "春分の日" },
    { "date": "2027-03-22", "name": "振替休日" },
    { "date": "2027-04-29", "name": "昭和の日" },
    { "date": "2027-05-03", "name": "憲法記念日" },
    { "date": "2027-05-04", "name": "みどりの日" },
    { "date": "2027-05-05", "name": "こどもの日" },
    { "date": "2027-07-19", "name": "海の日" },
    { "date": "2027-08-11", "name": "山の日" },
    { "date": "2027-09-20", "name": "敬老の日" },
    { "date": "2027-09-23", "name": "秋分の日" },
    { "date": "2027-10-11", "name": "スポーツの日" },
    { "date": "2027-11-03", "name": "文化の日" },
    { "date": "2027-11-23", "name": "勤労感謝の日" }
  ]
}
```

- [ ] **Step 1.2: valid JSON 確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
python3 -c "import json; d=json.load(open('data/japan-holidays.json')); print(f'holidays={len(d[\"holidays\"])}')"
```

期待: `holidays=35` (2026=18件 + 2027=17件)

- [ ] **Step 1.3: commit**

```bash
git add data/japan-holidays.json
git commit -m "feat(forecast): add japan-holidays.json for 2026-2027"
```

---

## Task 2: `calendar-context.mjs` の実装 (TDD)

**Files:**
- Create: `scripts/lib/calendar-context.mjs`
- Create: `tests/calendar-context.test.mjs`

- [ ] **Step 2.1: 失敗テスト 6 件を追加**

`tests/calendar-context.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { loadHolidaysSet, getDayType, formatYmd } from '../scripts/lib/calendar-context.mjs';

// テスト用祝日 set: 2026 GW (5/3 日, 5/4 月, 5/5 火, 5/6 振休水)、 2026-04-28 平日 (火)、 2026-04-29 昭和の日 (水)
const holidays = loadHolidaysSet({
  holidays: [
    { date: '2026-04-29', name: '昭和の日' },
    { date: '2026-05-03', name: '憲法記念日' },
    { date: '2026-05-04', name: 'みどりの日' },
    { date: '2026-05-05', name: 'こどもの日' },
    { date: '2026-05-06', name: '振替休日' },
    { date: '2026-08-11', name: '山の日' },
  ],
});

test('formatYmd: Date → "YYYY-MM-DD"', () => {
  assert.equal(formatYmd(new Date(2026, 4, 15)), '2026-05-15');
  assert.equal(formatYmd(new Date(2026, 0, 1)), '2026-01-01');
});

test('getDayType: 平日火曜 5/12 → weekday', () => {
  assert.equal(getDayType(new Date(2026, 4, 12), holidays), 'weekday');
});

test('getDayType: 土曜 5/16 翌日が平日日曜 (祝日無し) → saturday', () => {
  // 5/17 は日曜単発 (祝日無し)、つまり翌日 = sunday_holiday であって平日ではない
  // 「土曜で翌日が平日」を満たす土曜は祝日無しの月曜が翌週月曜のような構造のみ
  // ここでは「土曜 5/16 翌日 5/17 = 日曜」のケースを「saturday」とする (連休でない単独の土曜)
  assert.equal(getDayType(new Date(2026, 4, 16), holidays), 'saturday');
});

test('getDayType: 日曜単発 5/17 (翌日平日) → sunday_holiday', () => {
  assert.equal(getDayType(new Date(2026, 4, 17), holidays), 'sunday_holiday');
});

test('getDayType: 平日 4/28 火 翌日が祝日 (4/29 昭和の日) → pre_holiday', () => {
  assert.equal(getDayType(new Date(2026, 3, 28), holidays), 'pre_holiday');
});

test('getDayType: 連休中 5/4 月 (前後とも祝日) → in_consec_holiday', () => {
  assert.equal(getDayType(new Date(2026, 4, 4), holidays), 'in_consec_holiday');
});

test('getDayType: 連休最終日 5/6 水 振休 (翌日平日) → last_consec_holiday', () => {
  assert.equal(getDayType(new Date(2026, 4, 6), holidays), 'last_consec_holiday');
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
node --test tests/calendar-context.test.mjs 2>&1 | tail -8
```

期待: `loadHolidaysSet is not defined` 系で失敗。

- [ ] **Step 2.3: `calendar-context.mjs` を実装**

`scripts/lib/calendar-context.mjs` の内容:

```javascript
/**
 * カレンダー文脈 (DOW + 祝日 + 連休) の判定。純関数のみ。
 *
 * dayType 6 カテゴリ:
 *   weekday              平日 (月-金) かつ翌日も平日
 *   saturday             土曜日、連休ではない (前日が平日 / 翌日が平日 or 単発日曜祝日)
 *   sunday_holiday       単独の日曜 or 祝日 (前日が平日、翌日も平日)
 *   pre_holiday          平日 (月-金) で翌日が日曜/祝日
 *   in_consec_holiday    休日 (土日祝) で前日・翌日とも休日
 *   last_consec_holiday  休日で前日が休日、翌日が平日
 */

export function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function loadHolidaysSet(json) {
  const set = new Set();
  if (!json || !Array.isArray(json.holidays)) return set;
  for (const h of json.holidays) {
    if (h && typeof h.date === 'string') set.add(h.date);
  }
  return set;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isHolidayOrSunday(date, holidaysSet) {
  if (date.getDay() === 0) return true;
  return holidaysSet.has(formatYmd(date));
}

export function getDayType(date, holidaysSet) {
  const dow = date.getDay();
  const dateStr = formatYmd(date);
  const isExplicitHoliday = holidaysSet.has(dateStr);
  const isSunday = dow === 0;
  const isHoliday = isExplicitHoliday || isSunday;
  const isSaturday = dow === 6 && !isExplicitHoliday;

  const yesterdayHoliday = isHolidayOrSunday(addDays(date, -1), holidaysSet);
  const tomorrowHoliday = isHolidayOrSunday(addDays(date, 1), holidaysSet);

  if (isHoliday) {
    if (yesterdayHoliday && tomorrowHoliday) return 'in_consec_holiday';
    if (yesterdayHoliday && !tomorrowHoliday) return 'last_consec_holiday';
    if (!yesterdayHoliday && tomorrowHoliday) return 'in_consec_holiday';
    return 'sunday_holiday';
  }
  if (isSaturday) {
    if (tomorrowHoliday) return 'in_consec_holiday';
    return 'saturday';
  }
  if (tomorrowHoliday) return 'pre_holiday';
  return 'weekday';
}
```

- [ ] **Step 2.4: テスト再実行 → 全件パス**

```bash
node --test tests/calendar-context.test.mjs 2>&1 | tail -8
```

期待: 7 件 (formatYmd 1 + getDayType 6) パス。

- [ ] **Step 2.5: 全テストスイート (回帰確認)**

```bash
npm test 2>&1 | tail -8
```

期待: 323 + 7 = 330 件パス。

- [ ] **Step 2.6: commit**

```bash
git add scripts/lib/calendar-context.mjs tests/calendar-context.test.mjs
git commit -m "feat(forecast): add calendar-context (getDayType 6 categories)"
```

---

## Task 3: `pattern-matcher.mjs` の基礎部分 (TDD: cosine + 信頼サブセット集約)

**Files:**
- Create: `scripts/lib/pattern-matcher.mjs`
- Create: `tests/pattern-matcher.test.mjs`

- [ ] **Step 3.1: 失敗テスト 3 件を追加**

`tests/pattern-matcher.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { cosine, aggregateByDate, PATTERN_SCHEMA_VERSION } from '../scripts/lib/pattern-matcher.mjs';

test('cosine: 同一ベクトル → 1.0', () => {
  const v = [1, 2, 3, 4];
  assert.equal(cosine(v, v), 1);
});

test('cosine: 直交ベクトル → 0', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('cosine: ゼロベクトル → 0 (NaN 防止)', () => {
  assert.equal(cosine([0, 0, 0], [1, 1, 1]), 0);
  assert.equal(cosine([1, 1], [0, 0]), 0);
});

// --- aggregateByDate ---

function makeRow(ts, lum, s1d, s2d, s3d, s4d) {
  return {
    schema_version: 3,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: s1d, occupied_estimate: 5, capacity: 8 },
      stall2: { diff_occupied_from_prev: s2d, occupied_estimate: 5, capacity: 7 },
      stall3: { diff_occupied_from_prev: s3d, occupied_estimate: 5, capacity: 8 },
      stall4: { diff_occupied_from_prev: s4d, occupied_estimate: 5, capacity: 8 },
    },
  };
}

test('aggregateByDate: 信頼サブセットを日単位に集約、各日に slots[288][4] を持つ', () => {
  const history = [
    makeRow('2026-05-13T12:00:00+09:00', 100, -2, 0, 0, 0),
    makeRow('2026-05-13T12:05:00+09:00', 100, 0, -1, 0, 0),
    makeRow('2026-05-14T03:00:00+09:00', 10, -5, 0, 0, 0), // 夜間 → 除外
    makeRow('2026-05-14T13:00:00+09:00', 100, 0, 0, -3, 0),
  ];
  const result = aggregateByDate(history);
  assert.equal(result.size, 2); // 5/13, 5/14
  const day13 = result.get('2026-05-13');
  assert.ok(day13);
  assert.equal(day13.slots.length, 288);
  // 12:00 slot (= 144) stall1 = 2
  assert.equal(day13.slots[144][0], 2);
  // 12:05 slot (= 145) stall2 = 1
  assert.equal(day13.slots[145][1], 1);
  // 5/14 夜間 03:00 は除外 → slots[36][0] === 0
  const day14 = result.get('2026-05-14');
  assert.equal(day14.slots[36][0], 0);
  // 13:00 slot (= 156) stall3 = 3
  assert.equal(day14.slots[156][2], 3);
});
```

- [ ] **Step 3.2: テスト実行 → 失敗確認**

```bash
node --test tests/pattern-matcher.test.mjs 2>&1 | tail -8
```

期待: `cosine is not defined` 系で失敗。

- [ ] **Step 3.3: `pattern-matcher.mjs` の基礎部分を実装**

`scripts/lib/pattern-matcher.mjs` の内容:

```javascript
/**
 * パターンマッチング予測エンジン (Phase C-2 MVP)。
 *
 * 設計: docs/superpowers/specs/2026-05-15-pattern-matching-mvp-design.md
 *
 * 純関数のみ。observe-taxi-pool.mjs から呼ばれる。
 */

import { formatYmd, getDayType } from './calendar-context.mjs';

export const SLOTS_PER_HOUR = 12;
export const SLOTS_PER_DAY = 288;
export const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];
export const WINDOW_PAST_SLOTS = 72;       // 過去 6 時間
export const FORECAST_SLOT_COUNT = 24;     // 2 時間先
export const MIN_CANDIDATES = 3;
export const TOP_N_SIMILAR = 5;
export const NIGHT_LUMINANCE_THRESHOLD = 30;
export const PATTERN_SCHEMA_VERSION = 1;

export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 信頼サブセットの jsonl 行群を日単位に集約。
 * 各日について slots[288] (各 slot は [stall1Out, stall2Out, stall3Out, stall4Out] の 4 要素配列) を作る。
 *
 * @returns Map<"YYYY-MM-DD", {date: Date, slots: Array}>
 */
export function aggregateByDate(history) {
  const byDate = new Map();
  for (const row of history) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const ts = new Date(row.ts);
    if (Number.isNaN(ts.getTime())) continue;
    const dateKey = formatYmd(ts);
    const slotIdx = ts.getHours() * SLOTS_PER_HOUR + Math.floor(ts.getMinutes() / 5);
    if (!byDate.has(dateKey)) {
      const slots = Array.from({ length: SLOTS_PER_DAY }, () => [0, 0, 0, 0]);
      byDate.set(dateKey, { date: new Date(ts.getFullYear(), ts.getMonth(), ts.getDate()), slots });
    }
    const day = byDate.get(dateKey);
    for (let i = 0; i < STALLS.length; i++) {
      const d = row.stalls[STALLS[i]]?.diff_occupied_from_prev;
      if (typeof d === 'number' && d < 0) {
        day.slots[slotIdx][i] += -d;
      }
    }
  }
  return byDate;
}
```

- [ ] **Step 3.4: テスト再実行 → パス**

```bash
node --test tests/pattern-matcher.test.mjs 2>&1 | tail -8
```

期待: 4 件 (cosine 3 + aggregateByDate 1) パス。

- [ ] **Step 3.5: commit**

```bash
git add scripts/lib/pattern-matcher.mjs tests/pattern-matcher.test.mjs
git commit -m "feat(forecast): pattern-matcher cosine + aggregateByDate"
```

---

## Task 4: `pattern-matcher` の段階フィルタ + 類似度ランキング (TDD)

**Files:**
- Modify: `scripts/lib/pattern-matcher.mjs`
- Modify: `tests/pattern-matcher.test.mjs`

- [ ] **Step 4.1: 失敗テスト 5 件を追加**

`tests/pattern-matcher.test.mjs` の末尾に追加:

```javascript
import { selectCandidates, computePatternMatch } from '../scripts/lib/pattern-matcher.mjs';
import { loadHolidaysSet } from '../scripts/lib/calendar-context.mjs';

function dayEntry(dateStr, dayType, month, slots) {
  return { dateStr, dayType, month, slots };
}

test('selectCandidates: strict ヒット (3 件以上) → filterTier="strict"', () => {
  const pastDays = [
    dayEntry('2026-05-11', 'weekday', 5, []),
    dayEntry('2026-05-12', 'weekday', 5, []),
    dayEntry('2026-05-13', 'weekday', 5, []),
    dayEntry('2026-04-15', 'weekday', 4, []),
    dayEntry('2026-05-09', 'saturday', 5, []),
  ];
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'strict');
  assert.equal(r.candidates.length, 3);
});

test('selectCandidates: strict <3 → medium ヒット', () => {
  const pastDays = [
    dayEntry('2026-05-11', 'weekday', 5, []),
    dayEntry('2026-05-12', 'weekday', 5, []),
    dayEntry('2026-04-15', 'weekday', 4, []),
    dayEntry('2026-03-15', 'weekday', 3, []),
  ];
  // 5月 weekday は 2 件のみ → strict 失敗
  // medium = 月 ±2 (= 3-7月) かつ weekday: 4 件 → medium ヒット
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'medium');
  assert.equal(r.candidates.length, 4);
});

test('selectCandidates: medium <3 → loose ヒット (平日/土日カテゴリ)', () => {
  const pastDays = [
    dayEntry('2026-01-15', 'weekday', 1, []),
    dayEntry('2026-01-20', 'pre_holiday', 1, []),
    dayEntry('2026-02-20', 'saturday', 2, []),
    dayEntry('2026-02-15', 'sunday_holiday', 2, []),
  ];
  // weekday 5月 → strict 0, medium 0 (1-2月は5月±2の外)、loose で「平日カテゴリ」= weekday/pre_holiday = 2 件
  // 2 件 < MIN_CANDIDATES (3) なので all になる
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'all');
  assert.equal(r.candidates.length, 4);
});

test('selectCandidates: 全候補 ≥3 が loose でヒット', () => {
  const pastDays = [
    dayEntry('2026-04-01', 'weekday', 4, []),
    dayEntry('2026-04-02', 'weekday', 4, []),
    dayEntry('2026-04-03', 'pre_holiday', 4, []),
    dayEntry('2026-01-15', 'weekday', 1, []),
  ];
  // weekday 5月 → strict 0
  // medium = 月 ±2 (3-7月) かつ weekday = 2 件 → medium 失敗 (3未満)
  // loose = 平日カテゴリ = weekday + pre_holiday = 4 件 → loose ヒット
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'loose');
  assert.equal(r.candidates.length, 4);
});

test('computePatternMatch: pastDays 0 件 → similarDays=[], historicalCurve=[]', () => {
  const holidays = loadHolidaysSet({ holidays: [] });
  const r = computePatternMatch([], holidays, new Date('2026-05-15T17:30:00+09:00'));
  assert.equal(r.candidateCount, 0);
  assert.equal(r.similarDays.length, 0);
  assert.equal(r.historicalCurve.length, 0);
});
```

- [ ] **Step 4.2: テスト実行 → 失敗確認**

```bash
node --test tests/pattern-matcher.test.mjs 2>&1 | tail -8
```

期待: `selectCandidates is not defined` 系で失敗。

- [ ] **Step 4.3: `pattern-matcher.mjs` に selectCandidates + computePatternMatch を実装**

`scripts/lib/pattern-matcher.mjs` の末尾に追加:

```javascript
/**
 * 段階プレフィルタで候補日を選ぶ。
 *
 * @param {Array<{dateStr,dayType,month,slots}>} pastDays
 * @param {string} targetDayType
 * @param {number} targetMonth (1-12)
 * @returns {{filterTier: string, candidates: Array}}
 */
export function selectCandidates(pastDays, targetDayType, targetMonth) {
  const strict = pastDays.filter(d => d.dayType === targetDayType && d.month === targetMonth);
  if (strict.length >= MIN_CANDIDATES) return { filterTier: 'strict', candidates: strict };
  const medium = pastDays.filter(d => d.dayType === targetDayType && Math.abs(d.month - targetMonth) <= 2);
  if (medium.length >= MIN_CANDIDATES) return { filterTier: 'medium', candidates: medium };
  const targetIsWeekday = ['weekday', 'pre_holiday'].includes(targetDayType);
  const loose = pastDays.filter(d => {
    const dIsWeekday = ['weekday', 'pre_holiday'].includes(d.dayType);
    return dIsWeekday === targetIsWeekday;
  });
  if (loose.length >= MIN_CANDIDATES) return { filterTier: 'loose', candidates: loose };
  return { filterTier: 'all', candidates: pastDays };
}

function jstNowIsoString(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

function slotIdx(date) {
  return date.getHours() * SLOTS_PER_HOUR + Math.floor(date.getMinutes() / 5);
}

function extractWindowVec(daySlots, startSlot, lengthSlots) {
  const out = [];
  for (let i = 0; i < lengthSlots; i++) {
    const idx = (startSlot + i) % SLOTS_PER_DAY;
    const s = daySlots[idx];
    out.push(s[0], s[1], s[2], s[3]);
  }
  return out;
}

const DOW_LABEL_JA = ['日', '月', '火', '水', '木', '金', '土'];

function makeLabel(dateStr, dayType) {
  // dateStr "2026-05-13" → "5/13 (火・weekday)"
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = DOW_LABEL_JA[date.getDay()];
  return `${m}/${d} (${dow}・${dayType})`;
}

/**
 * パターンマッチング予測のメイン関数。
 *
 * @param {Array} historyAll 全 jsonl 行 (信頼サブセット条件で aggregate 内で filter)
 * @param {Set<string>} holidaysSet
 * @param {Date} now 現在時刻
 * @returns 出力 JSON オブジェクト
 */
export function computePatternMatch(historyAll, holidaysSet, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayDateStr = formatYmd(today);
  const todayDayType = getDayType(today, holidaysSet);
  const todayMonth = today.getMonth() + 1;

  // 1. 日別集約
  const byDate = aggregateByDate(historyAll);

  // 2. 今日とそれ以外に分ける
  const todayEntry = byDate.get(todayDateStr) || null;
  const pastDays = [];
  for (const [dateStr, entry] of byDate.entries()) {
    if (dateStr === todayDateStr) continue;
    pastDays.push({
      dateStr,
      date: entry.date,
      dayType: getDayType(entry.date, holidaysSet),
      month: entry.date.getMonth() + 1,
      slots: entry.slots,
    });
  }

  const baseOut = {
    schemaVersion: PATTERN_SCHEMA_VERSION,
    generatedAt: jstNowIsoString(now),
    today: {
      date: todayDateStr,
      dayType: todayDayType,
      month: todayMonth,
    },
  };

  if (pastDays.length === 0) {
    return {
      ...baseOut,
      today: { ...baseOut.today, filterTier: 'all' },
      candidateCount: 0,
      similarDays: [],
      historicalCurve: [],
    };
  }

  // 3. 候補日選択
  const { filterTier, candidates } = selectCandidates(pastDays, todayDayType, todayMonth);

  // 4. 類似度: 今日の過去 6h ウィンドウ vs 各候補日の同窓
  const nowSlot = slotIdx(now);
  // 過去 6h = nowSlot - 72 .. nowSlot - 1
  const windowStart = (nowSlot - WINDOW_PAST_SLOTS + SLOTS_PER_DAY) % SLOTS_PER_DAY;
  const todayVec = todayEntry
    ? extractWindowVec(todayEntry.slots, windowStart, WINDOW_PAST_SLOTS)
    : new Array(WINDOW_PAST_SLOTS * STALLS.length).fill(0);

  const scored = candidates.map(c => {
    const candVec = extractWindowVec(c.slots, windowStart, WINDOW_PAST_SLOTS);
    return { entry: c, similarity: cosine(todayVec, candVec) };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, TOP_N_SIMILAR);

  const similarDays = top.map(s => ({
    date: s.entry.dateStr,
    dayType: s.entry.dayType,
    month: s.entry.month,
    similarity: Number(s.similarity.toFixed(3)),
    label: makeLabel(s.entry.dateStr, s.entry.dayType),
  }));

  // 5. ヒストリカル予測カーブ: 今日の +5min ~ +120min を類似日で平均
  const forecastStart = (nowSlot + 1) % SLOTS_PER_DAY;
  const historicalCurve = [];
  for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
    const idx = (forecastStart + i) % SLOTS_PER_DAY;
    const stallSums = [0, 0, 0, 0];
    let count = 0;
    for (const s of top) {
      const slot = s.entry.slots[idx];
      stallSums[0] += slot[0];
      stallSums[1] += slot[1];
      stallSums[2] += slot[2];
      stallSums[3] += slot[3];
      count += 1;
    }
    const stall1 = count > 0 ? Math.round(stallSums[0] / count) : 0;
    const stall2 = count > 0 ? Math.round(stallSums[1] / count) : 0;
    const stall3 = count > 0 ? Math.round(stallSums[2] / count) : 0;
    const stall4 = count > 0 ? Math.round(stallSums[3] / count) : 0;
    const slotStartMin = idx * 5;
    const startH = Math.floor(slotStartMin / 60) % 24;
    const startM = slotStartMin % 60;
    const endTotal = slotStartMin + 5;
    const endH = Math.floor(endTotal / 60) % 24;
    const endM = endTotal % 60;
    const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    historicalCurve.push({
      slotStart: fmt(startH, startM),
      slotEnd: fmt(endH, endM),
      stall1, stall2, stall3, stall4,
      total: stall1 + stall2 + stall3 + stall4,
    });
  }

  return {
    ...baseOut,
    today: { ...baseOut.today, filterTier },
    candidateCount: candidates.length,
    similarDays,
    historicalCurve,
  };
}
```

- [ ] **Step 4.4: テスト再実行 → 全件パス**

```bash
node --test tests/pattern-matcher.test.mjs 2>&1 | tail -8
```

期待: 9 件パス (Task 3 の 4 件 + Task 4 の 5 件)。

- [ ] **Step 4.5: 全テストスイート**

```bash
npm test 2>&1 | tail -8
```

期待: 330 + 5 = 335 件パス。

- [ ] **Step 4.6: commit**

```bash
git add scripts/lib/pattern-matcher.mjs tests/pattern-matcher.test.mjs
git commit -m "feat(forecast): pattern-matcher selectCandidates + computePatternMatch"
```

---

## Task 5: `observe-taxi-pool.mjs` に pattern-match 生成を組み込み

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 5.1: import 追加**

既存の `import { computeBaseline, computeForecast } from './lib/forecast-engine.mjs';` の直後に追加:

```javascript
import { computePatternMatch } from './lib/pattern-matcher.mjs';
import { loadHolidaysSet } from './lib/calendar-context.mjs';
```

- [ ] **Step 5.2: 定数追加**

既存の `const FORECAST_OUTPUT_PATH = './data/stall-forecast.json';` の下に追加:

```javascript
const PATTERN_MATCH_OUTPUT_PATH = './data/stall-pattern-match.json';
const HOLIDAYS_PATH = './data/japan-holidays.json';
```

- [ ] **Step 5.3: pattern-match 生成ロジックを追加**

既存の forecast 生成 try/catch ブロックの直後に挿入:

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
    const patternMatch = computePatternMatch(allHistory, holidaysSet, new Date());
    writeFileSync(PATTERN_MATCH_OUTPUT_PATH, JSON.stringify(patternMatch, null, 2) + '\n', 'utf8');
    console.log(`[observe] pattern-match ok: today=${patternMatch.today.dayType} tier=${patternMatch.today.filterTier} similar=${patternMatch.similarDays.length}`);
  } catch (e) {
    console.error(`[observe] pattern-match generation failed: ${e.message}`);
  }
```

- [ ] **Step 5.4: 構文チェック + 単発実行**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --check scripts/observe-taxi-pool.mjs
node scripts/observe-taxi-pool.mjs 2>&1 | tail -10
```

期待: 出力に `[observe] pattern-match ok: today=weekday tier=strict similar=N` が含まれる。

- [ ] **Step 5.5: 生成された JSON を確認**

```bash
python3 -c "
import json
d = json.load(open('data/stall-pattern-match.json'))
print(f'schemaVersion: {d[\"schemaVersion\"]}')
print(f'today: {d[\"today\"]}')
print(f'candidateCount: {d[\"candidateCount\"]}')
print(f'similarDays: {len(d[\"similarDays\"])} 件')
for s in d['similarDays'][:3]:
    print(f'  {s}')
print(f'historicalCurve: {len(d[\"historicalCurve\"])} slot')
print(f'first: {d[\"historicalCurve\"][0]}')
"
```

期待:
- `schemaVersion: 1`
- `today` に dayType / month / filterTier が含まれる
- `similarDays` が 0-5 件
- `historicalCurve` 24 slot

- [ ] **Step 5.6: 全テスト (回帰確認)**

```bash
npm test 2>&1 | tail -8
```

期待: 335 件パス。

- [ ] **Step 5.7: commit**

```bash
git add scripts/observe-taxi-pool.mjs data/stall-pattern-match.json
git commit -m "feat(observe): generate stall-pattern-match.json each tick"
```

---

## Task 6: `forecast.html` + `js/forecast-render.js` + `js/forecast-app.js` に類似日セクション追加

**Files:**
- Modify: `forecast.html`
- Modify: `js/forecast-render.js`
- Modify: `js/forecast-app.js`

- [ ] **Step 6.1: `forecast.html` にセクション + スタイル追加**

`<style>` 末尾 (既存 `.factor-cell` の後) に追加:

```css
.pattern-section { margin-top: 32px; padding-top: 16px; border-top: 1px solid #222; }
.pattern-section h2 { font-size: 16px; margin: 0 0 8px 0; }
.pattern-section h3 { font-size: 14px; margin: 16px 0 8px 0; color: var(--sub); }
.pattern-meta { color: var(--sub); font-size: 13px; margin-bottom: 12px; }
.similar-day-list { list-style: none; padding: 0; margin: 0 0 16px 0; }
.similar-day-item { padding: 6px 8px; border-bottom: 1px solid #222; display: flex; gap: 8px; align-items: center; font-variant-numeric: tabular-nums; }
.similar-day-icon { font-size: 14px; }
.similar-day-label { flex: 1; }
.similar-day-score { color: var(--sub); font-size: 12px; font-variant-numeric: tabular-nums; }
```

`<main>` の `<div id="forecast-table-wrap"></div>` の直後に追加:

```html
    <section class="pattern-section" id="pattern-section">
      <h2>類似日マッチング</h2>
      <div id="pattern-meta" class="pattern-meta">読み込み中...</div>
      <ul id="similar-days" class="similar-day-list"></ul>
      <h3>ヒストリカル予測 (類似日平均)</h3>
      <div id="historical-curve-wrap"></div>
    </section>
```

- [ ] **Step 6.2: `js/forecast-render.js` に 3 関数を追加**

ファイル末尾に追加:

```javascript
const SIM_HIGH_THRESHOLD = 0.7;
const SIM_MID_THRESHOLD = 0.4;

function similarityIcon(sim) {
  if (sim >= SIM_HIGH_THRESHOLD) return '🟢';
  if (sim >= SIM_MID_THRESHOLD) return '🟡';
  return '⚪';
}

export function renderPatternMeta(container, patternMatch) {
  if (!container || !patternMatch) return;
  const t = patternMatch.today || {};
  const tierLabel = { strict: '厳密 (同曜日・同月)', medium: '中 (同曜日・近月)', loose: '緩 (平日/休日)', all: '全候補' }[t.filterTier] || t.filterTier || '?';
  container.innerHTML =
    `今日: <strong>${t.date}</strong> / ${t.dayType} / ${t.month}月 / フィルタ <strong>${tierLabel}</strong> / 候補 ${patternMatch.candidateCount} 日`;
}

export function renderSimilarDays(container, patternMatch) {
  if (!container || !patternMatch) return;
  const items = patternMatch.similarDays || [];
  if (items.length === 0) {
    container.innerHTML = '<li class="similar-day-item">類似日なし (サンプル不足)</li>';
    return;
  }
  container.innerHTML = items.map(s => `
    <li class="similar-day-item">
      <span class="similar-day-icon">${similarityIcon(s.similarity)}</span>
      <span class="similar-day-label">${s.label}</span>
      <span class="similar-day-score">cos ${s.similarity.toFixed(3)}</span>
    </li>
  `).join('');
}

export function renderHistoricalCurve(container, patternMatch) {
  if (!container || !patternMatch) return;
  const slots = patternMatch.historicalCurve || [];
  if (slots.length === 0) {
    container.innerHTML = '<p class="pattern-meta">ヒストリカル予測なし (類似日なし)</p>';
    return;
  }
  const rows = slots.map(s => `<tr>
    <td class="time">${s.slotStart}</td>
    <td>${s.stall1}</td>
    <td>${s.stall2}</td>
    <td>${s.stall3}</td>
    <td>${s.stall4}</td>
    <td class="total-cell">${s.total}</td>
  </tr>`).join('');
  container.innerHTML = `<table class="forecast-table">
    <thead><tr>
      <th>時刻</th><th>stall1</th><th>stall2</th><th>stall3</th><th>stall4</th><th>合計</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
```

- [ ] **Step 6.3: `js/forecast-app.js` に 2 つ目の fetch + render を追加**

`js/forecast-app.js` 全体を以下に置き換え:

```javascript
import { renderForecastMeta, renderForecastTable, renderPatternMeta, renderSimilarDays, renderHistoricalCurve } from './forecast-render.js';

async function main() {
  const metaEl = document.getElementById('forecast-meta');
  const tableEl = document.getElementById('forecast-table-wrap');
  const patternMetaEl = document.getElementById('pattern-meta');
  const similarDaysEl = document.getElementById('similar-days');
  const curveEl = document.getElementById('historical-curve-wrap');

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
npm test 2>&1 | tail -8
```

期待: 335 件パス。

- [ ] **Step 6.6: commit**

```bash
git add forecast.html js/forecast-render.js js/forecast-app.js
git commit -m "feat(forecast): add pattern-match section to forecast.html"
```

---

## Task 7: 最終整合 + push

- [ ] **Step 7.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `data/japan-holidays.json`
- `scripts/lib/calendar-context.mjs`
- `scripts/lib/pattern-matcher.mjs`
- `tests/calendar-context.test.mjs`
- `tests/pattern-matcher.test.mjs`
- `scripts/observe-taxi-pool.mjs`
- `data/stall-pattern-match.json`
- `forecast.html`
- `js/forecast-render.js`
- `js/forecast-app.js`

- [ ] **Step 7.2: 全テスト最終パス**

```bash
npm test 2>&1 | tail -8
```

期待: 335 件パス。

- [ ] **Step 7.3: git pull --rebase --autostash で観測 push と衝突回避**

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

- [ ] **Step 7.5: 本番反映確認 (GitHub Pages 自動デプロイ後 60-90 秒)**

```bash
sleep 90
echo "=== pattern-match.json ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/data/stall-pattern-match.json | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(f'today: {d[\"today\"]}')
print(f'candidateCount: {d[\"candidateCount\"]}')
print(f'similarDays: {len(d[\"similarDays\"])}')
for s in d['similarDays'][:3]:
    print(f'  {s[\"label\"]}: cos={s[\"similarity\"]}')
print(f'historicalCurve: {len(d[\"historicalCurve\"])} slot')
"
echo "=== forecast.html ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/forecast.html | grep -E "<title>|類似日|pattern-section" | head -5
```

期待:
- pattern-match.json が取得できる
- `今日: dayType=weekday filterTier=strict` 等が表示される
- forecast.html に「類似日」「pattern-section」の文字列がある

- [ ] **Step 7.6: 完了報告**

最終状態を要約。

---

## 検証コマンド一覧 (チートシート)

```bash
# 個別テスト
node --test tests/calendar-context.test.mjs
node --test tests/pattern-matcher.test.mjs

# 全テスト
npm test

# observe-tick 単発実行 (forecast + pattern-match 両方生成)
node scripts/observe-taxi-pool.mjs

# 生成 JSON
python3 -c "import json; d=json.load(open('data/stall-pattern-match.json')); print(json.dumps(d, indent=2, ensure_ascii=False)[:1500])"

# 本番
open https://hidenaka.github.io/taxi-ic-helper/forecast.html
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (323 → 335 件)
- [ ] `data/japan-holidays.json` が valid JSON、2 年分の祝日
- [ ] `scripts/lib/calendar-context.mjs` と `scripts/lib/pattern-matcher.mjs` 純関数
- [ ] observe-tick で `data/stall-pattern-match.json` が 5 分毎に更新
- [ ] `forecast.html` に類似日マッチング + ヒストリカル予測テーブルが表示される
- [ ] スコープ外ファイル (transit-share.json / arrivals.json / fetch-arrivals.mjs / forecast-engine.mjs) は触っていない
- [ ] 観測 jsonl 追記との衝突なし
