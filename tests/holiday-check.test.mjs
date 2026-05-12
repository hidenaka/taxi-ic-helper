import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHolidaySet, getDayType, toJstYmd } from '../scripts/lib/holiday-check.mjs';

const sample = {
  dates: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-01-12',
    '2026-05-05',
    '2026-12-29', '2026-12-30', '2026-12-31'
  ]
};

test('buildHolidaySet で Set を構築できる', () => {
  const set = buildHolidaySet(sample);
  assert.ok(set instanceof Set);
  assert.equal(set.size, 8);
  assert.ok(set.has('2026-01-12'));
});

test('土日は holiday', () => {
  const set = buildHolidaySet(sample);
  assert.equal(getDayType('2026-05-09T05:00:00+09:00', set), 'holiday');
  assert.equal(getDayType('2026-05-10T05:00:00+09:00', set), 'holiday');
});

test('平日は weekday', () => {
  const set = buildHolidaySet(sample);
  assert.equal(getDayType('2026-05-07T05:00:00+09:00', set), 'weekday');
});

test('CSV由来の祝日は holiday', () => {
  const set = buildHolidaySet(sample);
  assert.equal(getDayType('2026-01-12T05:00:00+09:00', set), 'holiday');
  assert.equal(getDayType('2026-05-05T05:00:00+09:00', set), 'holiday');
});

test('年末年始は holiday', () => {
  const set = buildHolidaySet(sample);
  assert.equal(getDayType('2026-12-30T05:00:00+09:00', set), 'holiday');
  assert.equal(getDayType('2026-01-02T05:00:00+09:00', set), 'holiday');
});

test('holidaySet が null でも土日判定にフォールバック', () => {
  assert.equal(getDayType('2026-05-09T05:00:00+09:00', null), 'holiday');
  assert.equal(getDayType('2026-05-07T05:00:00+09:00', null), 'weekday');
});

test('JST境界: UTC前日の夕方はJSTで翌日扱い', () => {
  const set = buildHolidaySet(sample);
  assert.equal(toJstYmd('2026-01-11T16:00:00Z'), '2026-01-12');
  assert.equal(getDayType('2026-01-11T16:00:00Z', set), 'holiday');
});
