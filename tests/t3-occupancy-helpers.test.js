import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseT3SlotConfig, summarizeT3Occupancy } from '../scripts/lib/t3-occupancy-helpers.mjs';

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
