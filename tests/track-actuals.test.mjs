import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeTrackActuals } from '../scripts/lib/track-actuals.mjs';

// v4 track 行（cameras[*].departedByStall）
function row(ts, departedByStall) {
  return { schema_version: 4, ts, cameras: { real01_line: { departedByStall } } };
}

test('computeTrackActuals: 直近2時間の departed を乗り場別15分スロットに集計', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    row('2026-05-19T18:02:00+09:00', { stall1: 3, stall2: 1 }), // 18:00-18:15
    row('2026-05-19T18:10:00+09:00', { stall1: 2 }),            // 同上
    row('2026-05-19T18:20:00+09:00', { stall3: 5 }),            // 18:15-18:30
    row('2026-05-19T16:30:00+09:00', { stall1: 9 }),            // 2時間より前 → 除外
  ];
  const r = computeTrackActuals(history, now);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { slotStart: '18:00', slotEnd: '18:15', stall1: 5, stall2: 1, stall3: 0, stall4: 0, total: 6 });
  assert.deepEqual(r[1], { slotStart: '18:15', slotEnd: '18:30', stall1: 0, stall2: 0, stall3: 5, stall4: 0, total: 5 });
});

test('computeTrackActuals: v3 行は total のみ寄与し乗り場別には加算しない', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    { schema_version: 3, ts: '2026-05-19T18:05:00+09:00', cameras: { real01_line: { departed: 4 } } },
    row('2026-05-19T18:08:00+09:00', { stall2: 2 }),
  ];
  const r = computeTrackActuals(history, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].stall2, 2);
  assert.equal(r[0].total, 6); // v3の4 + v4の2
});

test('computeTrackActuals: 空配列・未来時刻のみ → 空配列', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  assert.deepEqual(computeTrackActuals([], now), []);
  assert.deepEqual(computeTrackActuals(undefined, now), []);
  assert.deepEqual(computeTrackActuals([row('2026-05-19T20:00:00+09:00', { stall1: 5 })], now), []);
});
