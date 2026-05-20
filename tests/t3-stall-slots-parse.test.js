import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('t3-stall-slots.json: schema_version=1', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  assert.equal(cfg.schema_version, 1);
});

test('t3-stall-slots.json: _meta thresholds present', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  assert.equal(cfg._meta.night_brightness_threshold, 50);
  assert.equal(cfg._meta.edge_threshold, 0.08);
  assert.equal(cfg._meta.night_lantern_ratio, 0.005);
  assert.deepEqual(cfg._meta.image_size, [800, 600]);
});

test('t3-stall-slots.json: t3_stand has 18 slots (9 lanes × 2 rows)', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const stand = cfg.stalls.t3_stand;
  assert.equal(stand.source, 'real106');
  assert.equal(stand.capacity, 18);
  assert.equal(stand.slots.length, 18);
});

test('t3-stall-slots.json: each slot has lane/category/row tags', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const slots = cfg.stalls.t3_stand.slots;
  for (const s of slots) {
    assert.ok(typeof s.id === 'string', `id missing: ${JSON.stringify(s)}`);
    assert.ok(Number.isInteger(s.lane) && s.lane >= 1 && s.lane <= 9);
    assert.ok(['kanagawa', 'general', 'wagon', 'ecd', 'hire'].includes(s.category));
    assert.ok(s.row === 1 || s.row === 2);
    assert.equal(typeof s.cx, 'number');
    assert.equal(typeof s.cy, 'number');
    assert.equal(typeof s.r, 'number');
  }
});

test('t3-stall-slots.json: 9 unique lanes covered', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const lanes = new Set(cfg.stalls.t3_stand.slots.map(s => s.lane));
  assert.equal(lanes.size, 9);
});

test('t3-stall-slots.json: each lane has row1 and row2', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const byLane = {};
  for (const s of cfg.stalls.t3_stand.slots) {
    byLane[s.lane] = byLane[s.lane] || new Set();
    byLane[s.lane].add(s.row);
  }
  for (let lane = 1; lane <= 9; lane++) {
    assert.deepEqual([...byLane[lane]].sort(), [1, 2], `lane ${lane} missing rows`);
  }
});
