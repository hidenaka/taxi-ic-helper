import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { occLevel, activityLevel } from '../scripts/lib/pool-status.mjs';
import { currentOccupancy, fullRefFor, buildPoolStatus } from '../scripts/lib/pool-status.mjs';

test('occLevel: occ/fullRef を 4 段階に写像', () => {
  assert.equal(occLevel(0, 50), 'empty');
  assert.equal(occLevel(10, 50), 'empty');
  assert.equal(occLevel(20, 50), 'normal');
  assert.equal(occLevel(35, 50), 'crowded');
  assert.equal(occLevel(46, 50), 'full');
  assert.equal(occLevel(5, 0), 'empty');
});

test('activityLevel: 比で active/normal/low + arrow', () => {
  assert.deepEqual(activityLevel(38, 28), { ratio: 1.36, level: 'active', arrow: 'up' });
  assert.deepEqual(activityLevel(28, 28), { ratio: 1, level: 'normal', arrow: 'flat' });
  assert.deepEqual(activityLevel(10, 28), { ratio: 0.36, level: 'low', arrow: 'down' });
  assert.deepEqual(activityLevel(5, 0), { ratio: 0, level: 'normal', arrow: 'flat' });
});

function occRow(ts, s1, s2, s3, s4, back) {
  return { ts, mode: 'day', stalls: {
    stall1: { occ: s1 }, stall2: { occ: s2 }, stall3: { occ: s3 },
    stall4: { occ: s4 }, stall4_back: { occ: back } } };
}

test('currentOccupancy: 直近 N tick の中央値を group 別に', () => {
  const base = Date.parse('2026-05-25T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 10, 8, 12, 4, 8));
  const cur = currentOccupancy(rows, new Date(base + 5 * 30000), 5);
  assert.equal(cur.real01, 34);
  assert.equal(cur.real02, 8);
});

test('fullRefFor: group occ の92%ile・下限クランプ', () => {
  const base = Date.parse('2026-05-25T08:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(occRow(new Date(base + i * 60000).toISOString(), i % 16, 0, 0, 0, 0));
  const fr = fullRefFor(rows, 'real01', { days: 7, pct: 0.92, min: 20, now: new Date(base + 50 * 60000) });
  assert.equal(fr, 20);
});

test('buildPoolStatus: スキーマ通りに組み立つ', () => {
  const base = Date.parse('2026-05-25T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 12, 10, 14, 4, 8));
  const st = buildPoolStatus(rows, new Date(base + 20 * 30000));
  assert.ok(['empty', 'normal', 'crowded', 'full'].includes(st.cameras.real01.level));
  assert.equal(st.cameras.real02.occ, 8);
  assert.ok(typeof st.total.occ === 'number');
  assert.ok(['low', 'normal', 'active'].includes(st.activity.level));
  assert.ok(st.generatedAt);
  assert.ok(st.generatedAt.includes('+09:00'), 'generatedAt は JST(+09:00)表記'); // UTCずれ防止
});
