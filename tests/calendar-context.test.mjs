import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { loadHolidaysSet, getDayType, formatYmd } from '../scripts/lib/calendar-context.mjs';

// テスト用祝日 set: 2026 GW (5/3 日, 5/4 月, 5/5 火, 5/6 振休水) と 2026-04-29 昭和の日
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

test('getDayType: 土曜 5/16 → saturday (常に土曜カテゴリ)', () => {
  assert.equal(getDayType(new Date(2026, 4, 16), holidays), 'saturday');
});

test('getDayType: 日曜単発 5/17 (前日土曜、翌日平日) → sunday_holiday', () => {
  // 単独の土日ペアの日曜 = sunday_holiday (祝日ではない普通の日曜)
  assert.equal(getDayType(new Date(2026, 4, 17), holidays), 'sunday_holiday');
});

test('getDayType: 平日 4/28 火 翌日が祝日 (4/29 昭和の日) → pre_holiday', () => {
  assert.equal(getDayType(new Date(2026, 3, 28), holidays), 'pre_holiday');
});

test('getDayType: 連休中 5/4 月 (前後とも祝日、3+日連休) → in_consec_holiday', () => {
  assert.equal(getDayType(new Date(2026, 4, 4), holidays), 'in_consec_holiday');
});

test('getDayType: 連休最終日 5/6 水 振休 (翌日平日) → last_consec_holiday', () => {
  assert.equal(getDayType(new Date(2026, 4, 6), holidays), 'last_consec_holiday');
});

test('getDayType: GW 連休初日 5/3 日 (前日平日 5/2 土・翌日 5/4 祝) → sunday_holiday', () => {
  // 注: 5/2 は土曜なので「平日」ではないが、休日連鎖の判定上「前日は土曜=休日」
  // ただし日曜 5/3 の前日 5/2 (土) は休日扱い → 連休中? 単独?
  // 5/3 = 日曜祝日、5/2 = 土曜、5/4 = 祝日月曜
  // → 前後とも休日 → in_consec_holiday
  assert.equal(getDayType(new Date(2026, 4, 3), holidays), 'in_consec_holiday');
});
