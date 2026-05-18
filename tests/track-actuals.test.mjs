import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeTrackActuals } from '../scripts/lib/track-actuals.mjs';

// track 行を作る（cameras に departed を持つ v3 形）
function row(ts, departed) {
  return { schema_version: 3, ts, cameras: { real01: { departed } } };
}

test('computeTrackActuals: 直近2時間の departed を15分スロットに集計', () => {
  const now = new Date('2026-05-18T19:00:00+09:00');
  const history = [
    row('2026-05-18T18:02:00+09:00', 3), // 18:00-18:15 スロット
    row('2026-05-18T18:10:00+09:00', 2), // 同上
    row('2026-05-18T18:20:00+09:00', 5), // 18:15-18:30 スロット
    row('2026-05-18T16:30:00+09:00', 9), // 2時間より前 → 除外
  ];
  const r = computeTrackActuals(history, now);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { slotStart: '18:00', slotEnd: '18:15', total: 5 });
  assert.deepEqual(r[1], { slotStart: '18:15', slotEnd: '18:30', total: 5 });
});

test('computeTrackActuals: departed 欠損(null/cameras無し)は0扱い', () => {
  const now = new Date('2026-05-18T19:00:00+09:00');
  const history = [
    row('2026-05-18T18:05:00+09:00', null),
    { schema_version: 3, ts: '2026-05-18T18:08:00+09:00' }, // cameras 無し
    row('2026-05-18T18:12:00+09:00', 4),
  ];
  const r = computeTrackActuals(history, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].total, 4);
});

test('computeTrackActuals: 空配列・未来時刻のみ → 空配列', () => {
  const now = new Date('2026-05-18T19:00:00+09:00');
  assert.deepEqual(computeTrackActuals([], now), []);
  assert.deepEqual(computeTrackActuals(undefined, now), []);
  // 未来時刻の行は除外される
  assert.deepEqual(
    computeTrackActuals([row('2026-05-18T20:00:00+09:00', 5)], now),
    []);
});
