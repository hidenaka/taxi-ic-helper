import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { estimatePax } from '../scripts/lib/pax-estimator.mjs';

const seatsMaster = {
  'B789': { name: 'Boeing 787-9', seats: 246 },
  'A359': { name: 'Airbus A350-900', seats: 369 }
};
const factorsMaster = {
  default: 0.70,
  routes: { 'ITM': 0.78, 'OKA': 0.82 }
};

test('機材判明・路線判明で 座席×路線搭乗率', () => {
  const r = estimatePax({ aircraftCode: 'B789', from: 'ITM' }, seatsMaster, factorsMaster);
  assert.equal(r.seatCount, 246);
  assert.equal(r.loadFactor, 0.78);
  assert.equal(r.loadFactorSource, 'route');
  assert.equal(r.estimatedPax, Math.round(246 * 0.78));
});

test('機材判明・路線統計なしで デフォルト搭乗率', () => {
  const r = estimatePax({ aircraftCode: 'B789', from: 'XXX' }, seatsMaster, factorsMaster);
  assert.equal(r.loadFactor, 0.70);
  assert.equal(r.loadFactorSource, 'default');
  assert.equal(r.estimatedPax, Math.round(246 * 0.70));
});

test('機材nullで 全フィールドnull', () => {
  const r = estimatePax({ aircraftCode: null, from: 'ITM' }, seatsMaster, factorsMaster);
  assert.equal(r.seatCount, null);
  assert.equal(r.loadFactor, null);
  assert.equal(r.loadFactorSource, null);
  assert.equal(r.estimatedPax, null);
});

test('機材コードがマスタに存在しない場合も全nullとして扱う', () => {
  const r = estimatePax({ aircraftCode: 'UNKNOWN', from: 'ITM' }, seatsMaster, factorsMaster);
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});
