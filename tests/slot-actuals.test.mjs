import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeSlotActuals } from '../scripts/lib/slot-actuals.mjs';

function row(ts, occ) {
  return { schema_version: 1, ts, stalls: {
    stall1: { occ: occ[0] }, stall2: { occ: occ[1] },
    stall3: { occ: occ[2] }, stall4: { occ: occ[3] } } };
}

test('computeSlotActuals: 在台数の減少を15分スロットの出庫に集計', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    row('2026-05-19T18:02:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:05:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:08:00+09:00', [7, 0, 0, 0]),
    row('2026-05-19T18:11:00+09:00', [7, 0, 0, 0]),
    row('2026-05-19T18:14:00+09:00', [6, 0, 0, 0]),
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
  // 先頭2台＋後ろ8台→次tick 先頭1台＋後ろ8台 = 合計10→9 で1台出庫
  const history = [
    { schema_version: 1, ts: '2026-05-19T18:02:00+09:00', stalls: {
      stall1: { occ: 0 }, stall2: { occ: 0 }, stall3: { occ: 0 },
      stall4: { occ: 2 }, stall4_back: { occ: 8 },
    } },
    { schema_version: 1, ts: '2026-05-19T18:05:00+09:00', stalls: {
      stall1: { occ: 0 }, stall2: { occ: 0 }, stall3: { occ: 0 },
      stall4: { occ: 2 }, stall4_back: { occ: 8 },
    } },
    { schema_version: 1, ts: '2026-05-19T18:08:00+09:00', stalls: {
      stall1: { occ: 0 }, stall2: { occ: 0 }, stall3: { occ: 0 },
      stall4: { occ: 1 }, stall4_back: { occ: 8 },
    } },
  ];
  const r = computeSlotActuals(history, now);
  // 中央値平滑後の在台数: 10, 10, 9 → 18:00-18:15 ビンで stall4=1
  assert.equal(r.length, 1);
  assert.equal(r[0].stall4, 1);
  assert.equal(r[0].total, 1);
});
