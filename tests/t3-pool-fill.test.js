import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeFillRatio, fillLevel, approxCount, parseT3PoolRois, buildT3PoolFillPayload,
} from '../scripts/lib/t3-pool-fill.mjs';

test('t3-pool-rois.json: file parses with parseT3PoolRois', () => {
  const json = JSON.parse(readFileSync('./data/t3-pool-rois.json', 'utf8'));
  const cfg = parseT3PoolRois(json);
  assert.equal(cfg.front.camera, 'Real108');
  assert.equal(cfg.rear.camera, 'Real109');
  assert.ok(['black_ratio', 'edge_density'].includes(cfg.front.metric));
  assert.ok(['black_ratio', 'edge_density'].includes(cfg.rear.metric));
});

test('computeFillRatio: empty baseline → 0', () => {
  assert.equal(computeFillRatio(0.10, 0.10, 0.50), 0);
});

test('computeFillRatio: full baseline → 1', () => {
  assert.equal(computeFillRatio(0.50, 0.10, 0.50), 1);
});

test('computeFillRatio: midpoint → 0.5', () => {
  assert.ok(Math.abs(computeFillRatio(0.30, 0.10, 0.50) - 0.5) < 1e-9);
});

test('computeFillRatio: below empty clamps to 0', () => {
  assert.equal(computeFillRatio(0.05, 0.10, 0.50), 0);
});

test('computeFillRatio: above full clamps to 1', () => {
  assert.equal(computeFillRatio(0.80, 0.10, 0.50), 1);
});

test('computeFillRatio: full==empty (degenerate) → 0', () => {
  assert.equal(computeFillRatio(0.30, 0.40, 0.40), 0);
});

test('fillLevel: thresholds 0.33 / 0.66', () => {
  assert.equal(fillLevel(0.0), '空き');
  assert.equal(fillLevel(0.32), '空き');
  assert.equal(fillLevel(0.33), '半分');
  assert.equal(fillLevel(0.65), '半分');
  assert.equal(fillLevel(0.66), '混雑');
  assert.equal(fillLevel(1.0), '混雑');
});

test('approxCount: ratio × capacity rounded', () => {
  assert.equal(approxCount(0.0, 50), 0);
  assert.equal(approxCount(0.5, 50), 25);
  assert.equal(approxCount(1.0, 50), 50);
  assert.equal(approxCount(0.87, 50), 44);
});

test('parseT3PoolRois: extracts front/rear', () => {
  const cfg = parseT3PoolRois({
    schema_version: 1,
    areas: {
      front: { camera: 'Real108', roi: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, metric: 'edge_density', empty_baseline: 0.1, full_baseline: 0.5, max_capacity: 20 },
      rear: { camera: 'Real109', roi: { x: 0.0, y: 0.3, width: 0.9, height: 0.6 }, metric: 'edge_density', empty_baseline: 0.2, full_baseline: 0.6, max_capacity: 50 },
    },
  });
  assert.equal(cfg.front.camera, 'Real108');
  assert.equal(cfg.rear.max_capacity, 50);
  assert.equal(cfg.front.metric, 'edge_density');
});

test('parseT3PoolRois: throws on schema mismatch', () => {
  assert.throws(() => parseT3PoolRois({ schema_version: 2, areas: {} }), /schema_version/);
});

test('parseT3PoolRois: throws on missing areas', () => {
  assert.throws(() => parseT3PoolRois({ schema_version: 1 }), /areas/);
});

test('buildT3PoolFillPayload: both areas present', () => {
  const front = { camera: 'Real108', fillRatio: 0.15, level: '空き', approxCount: 3 };
  const rear = { camera: 'Real109', fillRatio: 0.88, level: '混雑', approxCount: 44 };
  const payload = buildT3PoolFillPayload(front, rear, new Date('2026-05-21T12:30:00+09:00'));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(typeof payload.generatedAt, 'string');
  assert.deepEqual(payload.areas.front, front);
  assert.deepEqual(payload.areas.rear, rear);
});

test('buildT3PoolFillPayload: missing camera omitted', () => {
  const rear = { camera: 'Real109', fillRatio: 0.5, level: '半分', approxCount: 25 };
  const payload = buildT3PoolFillPayload(null, rear, new Date('2026-05-21T12:30:00+09:00'));
  assert.equal(payload.areas.front, undefined);
  assert.deepEqual(payload.areas.rear, rear);
});
