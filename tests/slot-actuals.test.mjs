import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeSlotActuals } from '../scripts/lib/slot-actuals.mjs';

function row(ts, occ) {
  return { schema_version: 1, ts, stalls: {
    stall1: { occ: occ[0] }, stall2: { occ: occ[1] },
    stall3: { occ: occ[2] }, stall4: { occ: occ[3] } } };
}

test('computeSlotActuals: 在台数の持続的な減少を15分スロットの出庫に集計', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  // 8台が続いた後 6台に下がって持続 → 平滑化 (median5+持続3) 後も 8→6 の減少が
  // 出庫2として残る。 一瞬の谷ではなく持続した減少だけが計上されることを確認。
  const history = [
    row('2026-05-19T18:01:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:02:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:03:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:04:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:05:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:06:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:07:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:08:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:09:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:10:00+09:00', [6, 0, 0, 0]),
  ];
  const r = computeSlotActuals(history, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].slotStart, '18:00');
  assert.equal(r[0].stall1, 2);
  assert.equal(r[0].total, 2);
});

test('computeSlotActuals: 在台数の増加（列移動の補充）は出庫に数えない', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    row('2026-05-19T18:02:00+09:00', [2, 0, 0, 0]),
    row('2026-05-19T18:05:00+09:00', [2, 0, 0, 0]),
    row('2026-05-19T18:08:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:11:00+09:00', [8, 0, 0, 0]),
  ];
  const r = computeSlotActuals(history, now);
  assert.equal(r.length === 0 || r[0].stall1 === 0, true);
});

test('computeSlotActuals: 空・窓外のみ → 空配列', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  assert.deepEqual(computeSlotActuals([], now), []);
  assert.deepEqual(computeSlotActuals(undefined, now), []);
});

test('computeSlotActuals: stall4_back の occ は stall4 に合算', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  // 先頭2台+後ろ8台=10台が続いた後、 先頭1台+後ろ8台=9台に下がって持続 → 出庫1台。
  function row4(ts, front, back) {
    return { schema_version: 1, ts, stalls: {
      stall1: { occ: 0 }, stall2: { occ: 0 }, stall3: { occ: 0 },
      stall4: { occ: front }, stall4_back: { occ: back },
    } };
  }
  const history = [
    row4('2026-05-19T18:01:00+09:00', 2, 8),
    row4('2026-05-19T18:02:00+09:00', 2, 8),
    row4('2026-05-19T18:03:00+09:00', 2, 8),
    row4('2026-05-19T18:04:00+09:00', 2, 8),
    row4('2026-05-19T18:05:00+09:00', 2, 8),
    row4('2026-05-19T18:06:00+09:00', 1, 8),
    row4('2026-05-19T18:07:00+09:00', 1, 8),
    row4('2026-05-19T18:08:00+09:00', 1, 8),
    row4('2026-05-19T18:09:00+09:00', 1, 8),
    row4('2026-05-19T18:10:00+09:00', 1, 8),
  ];
  const r = computeSlotActuals(history, now);
  // 合計在台数 10 が続いた後 9 に持続的減少 → 18:00-18:15 ビンで stall4=1
  assert.equal(r.length, 1);
  assert.equal(r[0].stall4, 1);
  assert.equal(r[0].total, 1);
});
