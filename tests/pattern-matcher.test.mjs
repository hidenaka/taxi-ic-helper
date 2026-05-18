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

// --- consec フィルタ (2026-05-15 拡張) ---

function dayEntryConsec(dateStr, dayType, month, consecLength = 1, prevConsecLength = 0, nextConsecLength = 0) {
  return { dateStr, dayType, month, consecLength, prevConsecLength, nextConsecLength, slots: [] };
}

test('selectCandidates strict: consec ±1 内のみマッチ (例: 3 連休 vs 5 連休は除外)', () => {
  const pastDays = [
    // 同 dayType (in_consec_holiday) + 同月 (5) + consec 3 → strict OK (target consec=3 と一致)
    dayEntryConsec('2026-05-01', 'in_consec_holiday', 5, 3),
    dayEntryConsec('2026-05-02', 'in_consec_holiday', 5, 3),
    dayEntryConsec('2026-05-03', 'in_consec_holiday', 5, 3),
    // 同月 + 同 dayType だが consec 5 → consec 差 2 → strict 除外
    dayEntryConsec('2026-05-21', 'in_consec_holiday', 5, 5),
    dayEntryConsec('2026-05-22', 'in_consec_holiday', 5, 5),
  ];
  const r = selectCandidates(pastDays, 'in_consec_holiday', 5, 3);
  assert.equal(r.filterTier, 'strict');
  assert.equal(r.candidates.length, 3);
});

test('selectCandidates strict: consec が引数で渡らない場合は consec フィルタ無効 (後方互換)', () => {
  const pastDays = [
    dayEntryConsec('2026-05-01', 'weekday', 5),
    dayEntryConsec('2026-05-02', 'weekday', 5),
    dayEntryConsec('2026-05-03', 'weekday', 5),
  ];
  const r = selectCandidates(pastDays, 'weekday', 5);
  assert.equal(r.filterTier, 'strict');
  assert.equal(r.candidates.length, 3);
});

test('selectCandidates strict: post_holiday の prevConsec で連休明け判別', () => {
  const pastDays = [
    // 連休明け (前連休 5 日 = GW明け相当) を 5 月内に 3 件 (架空)
    dayEntryConsec('2026-05-07', 'post_holiday', 5, 1, 5, 0),
    dayEntryConsec('2026-05-14', 'post_holiday', 5, 1, 5, 0),
    dayEntryConsec('2026-05-21', 'post_holiday', 5, 1, 5, 0),
    // 土日明け月曜 (前連休 2 日) → consec 差 3 で strict 除外
    dayEntryConsec('2026-05-18', 'post_holiday', 5, 1, 2, 0),
  ];
  // target: post_holiday、5 月、relevantConsec=5 (GW明け)
  const r = selectCandidates(pastDays, 'post_holiday', 5, 5);
  assert.equal(r.filterTier, 'strict');
  assert.equal(r.candidates.length, 3);
});

test('computePatternMatch: today consec 情報が出力 today に含まれる', () => {
  const holidays = loadHolidaysSet({
    holidays: [
      { date: '2026-05-03', name: '憲法' }, { date: '2026-05-04', name: 'みどり' },
      { date: '2026-05-05', name: 'こども' }, { date: '2026-05-06', name: '振休' },
    ],
  });
  // 5/4 = GW 中 (in_consec_holiday, consecLength=5)
  const r = computePatternMatch([], holidays, new Date(2026, 4, 4, 12, 0));
  assert.equal(r.today.dayType, 'in_consec_holiday');
  assert.equal(r.today.consecLength, 5);
  assert.equal(r.today.relevantConsec, 5);
});

test('computePatternMatch: historicalCurve は類似日平均を丸めず小数で保持する (早すぎる四捨五入バグ回帰)', () => {
  // 2026-05 の平日 3 日に 17:35 の信頼行 (luminance 100) を 1 本ずつ。
  // stall1 の出庫 (= -diff_occupied_from_prev) は [1, 0, 0] → 3 日平均 = 1/3。
  // Math.round で 0 に潰れてはいけない。
  const holidays = loadHolidaysSet({ holidays: [] });
  const history = [
    makeRow('2026-05-11T17:35:00+09:00', 100, -1, 0, 0, 0),
    makeRow('2026-05-12T17:35:00+09:00', 100, 0, 0, 0, 0),
    makeRow('2026-05-13T17:35:00+09:00', 100, 0, 0, 0, 0),
  ];
  // 現在 17:30 → forecast slot 0 = 17:35
  const r = computePatternMatch(history, holidays, new Date('2026-05-15T17:30:00+09:00'));
  assert.equal(r.historicalCurve.length, 24);
  assert.equal(r.historicalCurve[0].slotStart, '17:35');
  assert.equal(r.historicalCurve[0].stall1, 1 / 3);
  assert.equal(r.historicalCurve[0].total, 1 / 3);
});
