import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseT3SlotConfig, summarizeT3Occupancy, computeT3SlotActuals } from '../scripts/lib/t3-occupancy-helpers.mjs';

test('parseT3SlotConfig: returns slots and meta', () => {
  const cfg = parseT3SlotConfig({
    schema_version: 1,
    _meta: { image_size: [800, 600], edge_threshold: 0.08 },
    stalls: {
      t3_stand: {
        source: 'real106',
        capacity: 18,
        slots: [{ id: 's1', cx: 0.5, cy: 0.5, r: 0.01, lane: 1, category: 'general', row: 1 }],
      },
    },
  });
  assert.equal(cfg.source, 'real106');
  assert.equal(cfg.slots.length, 1);
  assert.equal(cfg.meta.edge_threshold, 0.08);
});

test('parseT3SlotConfig: throws on missing t3_stand', () => {
  assert.throws(() => parseT3SlotConfig({ schema_version: 1, stalls: {} }),
    /t3_stand not found/);
});

test('parseT3SlotConfig: throws on schema_version mismatch', () => {
  assert.throws(() => parseT3SlotConfig({ schema_version: 2, stalls: { t3_stand: { slots: [] } } }),
    /schema_version/);
});

test('summarizeT3Occupancy: counts total, row1, row2', () => {
  const slots = [
    { id: 'lane1-row1', lane: 1, row: 1 },
    { id: 'lane1-row2', lane: 1, row: 2 },
    { id: 'lane2-row1', lane: 2, row: 1 },
    { id: 'lane2-row2', lane: 2, row: 2 },
  ];
  const occupiedById = {
    'lane1-row1': true,
    'lane1-row2': false,
    'lane2-row1': true,
    'lane2-row2': true,
  };
  const result = summarizeT3Occupancy(slots, occupiedById);
  assert.deepEqual(result, { total: 3, row1: 2, row2: 1 });
});

test('summarizeT3Occupancy: empty slots → all zero', () => {
  assert.deepEqual(summarizeT3Occupancy([], {}), { total: 0, row1: 0, row2: 0 });
});

test('summarizeT3Occupancy: missing occupied entries → false', () => {
  const slots = [{ id: 'a', lane: 1, row: 1 }, { id: 'b', lane: 1, row: 2 }];
  const result = summarizeT3Occupancy(slots, { a: true });
  assert.deepEqual(result, { total: 1, row1: 1, row2: 0 });
});

test('computeT3SlotActuals: empty history → empty array', () => {
  assert.deepEqual(computeT3SlotActuals([], new Date('2026-05-20T20:00:00+09:00')), []);
});

test('computeT3SlotActuals: single row → empty (no diff possible)', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
  ];
  assert.deepEqual(computeT3SlotActuals(history, new Date('2026-05-20T20:00:00+09:00')), []);
});

test('computeT3SlotActuals: decrease counted as departure, increase ignored', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
    { ts: '2026-05-20T19:10:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 14 } } },
    { ts: '2026-05-20T19:12:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T19:15:00+09:00'), 120);
  assert.equal(result.length, 1);
  assert.equal(result[0].total, 4);
});

test('computeT3SlotActuals: day/night mode change → diff ignored', () => {
  const history = [
    { ts: '2026-05-20T18:55:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:00:00+09:00', mode: 'night', stalls: { t3_stand: { occ: 5 } } },
    { ts: '2026-05-20T19:05:00+09:00', mode: 'night', stalls: { t3_stand: { occ: 3 } } },
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 120);
  const totals = result.reduce((sum, s) => sum + s.total, 0);
  assert.equal(totals, 2);
});

test('computeT3SlotActuals: outside window excluded', () => {
  const history = [
    { ts: '2026-05-20T10:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T10:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
    { ts: '2026-05-20T19:55:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 10 } } },
    { ts: '2026-05-20T20:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 8 } } },
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T20:30:00+09:00'), 120);
  const totals = result.reduce((sum, s) => sum + s.total, 0);
  assert.equal(totals, 2);
});

test('computeT3SlotActuals: output rows have slotStart/slotEnd/total only', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 120);
  assert.equal(result.length, 1);
  assert.equal(typeof result[0].slotStart, 'string');
  assert.equal(typeof result[0].slotEnd, 'string');
  assert.equal(typeof result[0].total, 'number');
  assert.equal(result[0].stall1, undefined);
});
