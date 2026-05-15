import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  cosine, aggregateByDate, PATTERN_SCHEMA_VERSION,
} from '../scripts/lib/pattern-matcher.mjs';

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
  assert.equal(result.size, 2);
  const day13 = result.get('2026-05-13');
  assert.ok(day13);
  assert.equal(day13.slots.length, 288);
  assert.equal(day13.slots[144][0], 2);
  assert.equal(day13.slots[145][1], 1);
  const day14 = result.get('2026-05-14');
  assert.equal(day14.slots[36][0], 0);
  assert.equal(day14.slots[156][2], 3);
});

// --- selectCandidates ---

import { selectCandidates, computePatternMatch } from '../scripts/lib/pattern-matcher.mjs';
import { loadHolidaysSet } from '../scripts/lib/calendar-context.mjs';

function dayEntry(dateStr, dayType, month, slots = []) {
  return { dateStr, dayType, month, slots };
}

test('selectCandidates: strict ヒット (3 件以上) → filterTier="strict"', () => {
  const pastDays = [
    dayEntry('2026-05-11', 'weekday', 5),
    dayEntry('2026-05-12', 'weekday', 5),
    dayEntry('2026-05-13', 'weekday', 5),
    dayEntry('2026-04-15', 'weekday', 4),
    dayEntry('2026-05-09', 'saturday', 5),
  ];
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'strict');
  assert.equal(r.candidates.length, 3);
});

test('selectCandidates: strict <3 → medium ヒット', () => {
  const pastDays = [
    dayEntry('2026-05-11', 'weekday', 5),
    dayEntry('2026-05-12', 'weekday', 5),
    dayEntry('2026-04-15', 'weekday', 4),
    dayEntry('2026-03-15', 'weekday', 3),
  ];
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'medium');
  assert.equal(r.candidates.length, 4);
});

test('selectCandidates: medium <3 → 平日カテゴリ all 2 件で all', () => {
  const pastDays = [
    dayEntry('2026-01-15', 'weekday', 1),
    dayEntry('2026-01-20', 'pre_holiday', 1),
    dayEntry('2026-02-20', 'saturday', 2),
    dayEntry('2026-02-15', 'sunday_holiday', 2),
  ];
  // weekday 5月 → strict 0, medium 0 (1-2月は5月±2の外), loose は平日カテゴリ 2 件 < 3 → all
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'all');
  assert.equal(r.candidates.length, 4);
});

test('selectCandidates: loose 3+ 件でヒット', () => {
  const pastDays = [
    dayEntry('2026-04-01', 'weekday', 4),
    dayEntry('2026-04-02', 'weekday', 4),
    dayEntry('2026-04-03', 'pre_holiday', 4),
    dayEntry('2026-01-15', 'weekday', 1),
  ];
  // weekday 5月 → strict 0, medium = 月±2 (3-7月) かつ weekday = 2 件 < 3 → 失敗
  // loose = 平日カテゴリ = 4 件 → loose ヒット
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
