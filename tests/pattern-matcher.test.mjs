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
  // 12:00 slot (= 144) stall1 = 2
  assert.equal(day13.slots[144][0], 2);
  // 12:05 slot (= 145) stall2 = 1
  assert.equal(day13.slots[145][1], 1);
  const day14 = result.get('2026-05-14');
  // 5/14 夜間 03:00 は除外 → slots[36][0] === 0
  assert.equal(day14.slots[36][0], 0);
  // 13:00 slot (= 156) stall3 = 3
  assert.equal(day14.slots[156][2], 3);
});
