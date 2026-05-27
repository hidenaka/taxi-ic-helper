import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { getDayContext } from '../scripts/lib/holiday-context.mjs';

// テスト用祝日: 2026/05/03(憲法)/04(みどり)/05(こども)/06(振替) → 5/3〜5/6 が連休
const HOLIDAYS = [
  { date: '2026-05-03', name: '憲法記念日' },
  { date: '2026-05-04', name: 'みどりの日' },
  { date: '2026-05-05', name: 'こどもの日' },
  { date: '2026-05-06', name: '振替休日' },
  { date: '2026-02-11', name: '建国記念の日' }, // 単独祝日（前後平日）
];

test('getDayContext: 平日（火曜）', () => {
  const ctx = getDayContext(new Date('2026-05-12T12:00:00+09:00'), HOLIDAYS);
  assert.equal(ctx.weekday, 2);
  assert.equal(ctx.dayKind, 'weekday');
  assert.equal(ctx.dayLabel, '火曜平日');
});

test('getDayContext: 土曜（祝日でない）', () => {
  const ctx = getDayContext(new Date('2026-05-09T12:00:00+09:00'), HOLIDAYS);
  assert.equal(ctx.weekday, 6);
  assert.equal(ctx.dayKind, 'weekend');
  assert.equal(ctx.dayLabel, '土曜・週末');
});

test('getDayContext: 単独祝日（建国記念の日・水曜・前後平日）', () => {
  const ctx = getDayContext(new Date('2026-02-11T12:00:00+09:00'), HOLIDAYS);
  assert.equal(ctx.dayKind, 'holiday');
  assert.equal(ctx.dayLabel, '水曜・祝日');
});

test('getDayContext: 連休初日（5/3日曜・憲法記念日）', () => {
  const ctx = getDayContext(new Date('2026-05-03T12:00:00+09:00'), HOLIDAYS);
  assert.equal(ctx.dayKind, 'consecutive-first');
  assert.equal(ctx.dayLabel, '日曜・連休初日');
});

test('getDayContext: 連休中日（5/4月曜・みどりの日）', () => {
  const ctx = getDayContext(new Date('2026-05-04T12:00:00+09:00'), HOLIDAYS);
  assert.equal(ctx.dayKind, 'consecutive-middle');
  assert.equal(ctx.dayLabel, '月曜・連休中日');
});

test('getDayContext: 連休最終日（5/6水曜・振替休日）', () => {
  const ctx = getDayContext(new Date('2026-05-06T12:00:00+09:00'), HOLIDAYS);
  assert.equal(ctx.dayKind, 'consecutive-last');
  assert.equal(ctx.dayLabel, '水曜・連休最終日');
});

test('getDayContext: holidays=null でも weekend/weekday に fallback (クラッシュしない)', () => {
  const ctx = getDayContext(new Date('2026-05-12T12:00:00+09:00'), null);
  assert.equal(ctx.dayKind, 'weekday');
});
