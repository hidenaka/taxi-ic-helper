import { test } from 'node:test';
import assert from 'node:assert';
import { haversineKm } from '../js/util.js';

test('haversineKm: 東京駅 → 新宿駅 は約 6km', () => {
  const tokyo = { lat: 35.6812, lng: 139.7671 };
  const shinjuku = { lat: 35.6896, lng: 139.7006 };
  const d = haversineKm(tokyo, shinjuku);
  assert.ok(d > 5.5 && d < 6.5, `expected ~6km, got ${d}`);
});

test('haversineKm: 同一点は 0km', () => {
  const p = { lat: 35.0, lng: 139.0 };
  assert.strictEqual(haversineKm(p, p), 0);
});
