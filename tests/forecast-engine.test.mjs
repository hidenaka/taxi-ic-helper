import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  slotKey, clip, computeBaseline, SLOTS_PER_DAY,
} from '../scripts/lib/forecast-engine.mjs';

test('slotKey: 17:30 → 17*12 + 6 = 210', () => {
  assert.equal(slotKey(17, 30), 210);
});

test('slotKey: 0:00 → 0、23:55 → 287', () => {
  assert.equal(slotKey(0, 0), 0);
  assert.equal(slotKey(23, 55), 287);
});

test('clip: 範囲内はそのまま、範囲外はクランプ、NaN は 1.0', () => {
  assert.equal(clip(0.5, 0.3, 3.0), 0.5);
  assert.equal(clip(0.1, 0.3, 3.0), 0.3);
  assert.equal(clip(5.0, 0.3, 3.0), 3.0);
  assert.equal(clip(NaN, 0.3, 3.0), 1.0);
  assert.equal(clip(Infinity, 0.3, 3.0), 1.0);
});

// --- computeBaseline ---

function makeRow(ts, lum, stall1Diff, stall2Diff, stall3Diff, stall4Diff) {
  return {
    schema_version: 3,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: stall1Diff, occupied_estimate: 5, capacity: 8 },
      stall2: { diff_occupied_from_prev: stall2Diff, occupied_estimate: 5, capacity: 7 },
      stall3: { diff_occupied_from_prev: stall3Diff, occupied_estimate: 5, capacity: 8 },
      stall4: { diff_occupied_from_prev: stall4Diff, occupied_estimate: 5, capacity: 8 },
    },
  };
}

test('computeBaseline: 信頼サブセット 0 行 → 全 slot null + sampleCount 0', () => {
  const r = computeBaseline([]);
  assert.equal(r.sampleCount, 0);
  assert.equal(r.slots.length, SLOTS_PER_DAY);
  for (const s of r.slots) {
    for (const stall of ['stall1', 'stall2', 'stall3', 'stall4']) {
      assert.equal(s[stall], null);
    }
  }
});

test('computeBaseline: 同 slot に複数サンプル → 平均が返る (-値だけ集計)', () => {
  const history = [
    makeRow('2026-05-13T12:00:00+09:00', 100, -2, 0, 0, 0),
    makeRow('2026-05-13T12:00:00+09:00', 100, -4, 0, 0, 0),
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(12, 0)];
  assert.equal(slot.stall1, 3);
  assert.equal(slot.stall2, 0);
  assert.equal(r.sampleCount, 2);
});

test('computeBaseline: 夜間 (luminance<30) は除外', () => {
  const history = [
    makeRow('2026-05-13T03:00:00+09:00', 10, -5, 0, 0, 0),
    makeRow('2026-05-13T03:00:00+09:00', 100, -1, 0, 0, 0),
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(3, 0)];
  assert.equal(slot.stall1, 1);
  assert.equal(r.sampleCount, 1);
});

test('computeBaseline: 正の diff (入庫) は出庫としてカウントしない', () => {
  const history = [
    makeRow('2026-05-13T12:00:00+09:00', 100, 3, 0, 0, 0),
    makeRow('2026-05-13T12:00:00+09:00', 100, -2, 0, 0, 0),
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(12, 0)];
  assert.equal(slot.stall1, 1);
});
