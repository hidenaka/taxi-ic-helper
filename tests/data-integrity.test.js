import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';

test('ics.json: すべてのICに id / name / gps が揃っている', () => {
  const { ics } = loadJson('data/ics.json');
  assert.ok(Array.isArray(ics) && ics.length > 0, 'ics must be a non-empty array');
  for (const ic of ics) {
    assert.ok(ic.id, `missing id: ${JSON.stringify(ic)}`);
    assert.ok(ic.name, `missing name: ${ic.id}`);
    assert.ok(ic.gps && typeof ic.gps.lat === 'number' && typeof ic.gps.lng === 'number',
              `missing gps: ${ic.id}`);
  }
});

test('ics.json: id は一意', () => {
  const { ics } = loadJson('data/ics.json');
  const ids = ics.map(x => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids found');
});
