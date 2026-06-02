import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { bucketOfDay, buildAdvanceModel, predictAdvance } from '../scripts/lib/advance-forecast.mjs';

test('bucketOfDay: JST時刻を15分インデックス(0..95)に', () => {
  assert.equal(bucketOfDay('2026-05-20T00:00:00+09:00'), 0);
  assert.equal(bucketOfDay('2026-05-20T12:00:00+09:00'), 48);
  assert.equal(bucketOfDay('2026-05-20T12:15:00+09:00'), 49);
  assert.equal(bucketOfDay('2026-05-20T23:45:00+09:00'), 95);
});

test('buildAdvanceModel: 同一時間帯の複数日を乗り場ごとに平均', () => {
  const rows = [
    { ts: '2026-05-20T12:00:00+09:00', stalls: { stall1: 2, stall3: 1 } },
    { ts: '2026-05-21T12:00:00+09:00', stalls: { stall1: 4 } },
    { ts: '2026-05-22T12:00:00+09:00', stalls: { stall1: 6, stall3: 3 } },
  ];
  const m = buildAdvanceModel(rows);
  // stall1 の 12:00 バケット(48) は (2+4+6)/3 = 4
  assert.equal(predictAdvance(m, '2026-06-01T12:00:00+09:00', 'stall1'), 4);
  // stall3 は 12:00 の3行で (1 + 0[欠損=0回] + 3)/3 = 1.333…
  assert.ok(Math.abs(predictAdvance(m, '2026-06-01T12:07:00+09:00', 'stall3') - 4 / 3) < 1e-9);
});

test('predictAdvance: 学習データの無い時間帯は0', () => {
  const m = buildAdvanceModel([{ ts: '2026-05-20T12:00:00+09:00', stalls: { stall1: 3 } }]);
  assert.equal(predictAdvance(m, '2026-06-01T03:00:00+09:00', 'stall1'), 0);
  assert.equal(predictAdvance(m, '2026-06-01T12:00:00+09:00', 'stall9'), 0);
});
