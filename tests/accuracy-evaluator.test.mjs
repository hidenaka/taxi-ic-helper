import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { buildActualMap, slotKeyOf } from '../scripts/lib/accuracy-evaluator.mjs';

function makeRow(ts, lum, s1d, s2d, s3d, s4d) {
  return {
    schema_version: 3,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: s1d },
      stall2: { diff_occupied_from_prev: s2d },
      stall3: { diff_occupied_from_prev: s3d },
      stall4: { diff_occupied_from_prev: s4d },
    },
  };
}

test('slotKeyOf: 日付 + slotIdx の合成キー', () => {
  assert.equal(slotKeyOf('2026-06-01', 210), '2026-06-01#210');
});

test('buildActualMap: 信頼サブセットの出庫を date#slotIdx で引ける', () => {
  const history = [
    makeRow('2026-06-01T12:00:00+09:00', 100, -2, 0, -1, 0),
    makeRow('2026-06-01T12:05:00+09:00', 100, 0, -3, 0, 0),
  ];
  const m = buildActualMap(history);
  assert.deepEqual(m.get('2026-06-01#144'), [2, 0, 1, 0]);
  assert.deepEqual(m.get('2026-06-01#145'), [0, 3, 0, 0]);
});

test('buildActualMap: 夜間 (luminance<30) は除外', () => {
  const history = [
    makeRow('2026-06-01T03:00:00+09:00', 10, -5, 0, 0, 0),
  ];
  const m = buildActualMap(history);
  assert.equal(m.has('2026-06-01#36'), false);
});
