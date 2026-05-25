import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { occLevel, activityLevel } from '../scripts/lib/pool-status.mjs';

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
