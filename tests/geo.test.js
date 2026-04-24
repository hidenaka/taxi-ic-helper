import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearestICs,
  acceptSample,
  defaultExitIcId,
  createGeoWatcher,
  entryGivesCompanyPayDeduction,
} from '../js/geo.js';

const KASUMI = { lat: 35.6730, lng: 139.7495 };
const ICS = [
  { id: 'a', name: 'A', gps: { lat: 35.6730, lng: 139.7495 } },
  { id: 'b', name: 'B', gps: { lat: 35.7000, lng: 139.7495 } },
  { id: 'c', name: 'C', gps: { lat: 35.7800, lng: 139.7495 } },
  { id: 'no-gps', name: 'X' },
];

test('findNearestICs: 距離昇順で返す', () => {
  const out = findNearestICs(KASUMI, ICS, { n: 3 });
  assert.deepEqual(out.map((r) => r.ic.id), ['a', 'b', 'c']);
  assert.equal(out[0].distKm, 0);
  assert.ok(out[1].distKm < out[2].distKm);
});

test('findNearestICs: n を尊重する', () => {
  const out = findNearestICs(KASUMI, ICS, { n: 2 });
  assert.equal(out.length, 2);
});

test('findNearestICs: gps なしの IC はスキップ', () => {
  const out = findNearestICs(KASUMI, ICS, { n: 10 });
  assert.equal(out.length, 3);
  assert.ok(!out.find((r) => r.ic.id === 'no-gps'));
});

test('findNearestICs: filter 適用', () => {
  const out = findNearestICs(KASUMI, ICS, {
    n: 10, filter: (ic) => ic.id !== 'a',
  });
  assert.deepEqual(out.map((r) => r.ic.id), ['b', 'c']);
});

test('findNearestICs: pos が null なら空', () => {
  assert.deepEqual(findNearestICs(null, ICS), []);
});

test('acceptSample: 閾値内は true', () => {
  assert.equal(acceptSample(50), true);
  assert.equal(acceptSample(100), true);
  assert.equal(acceptSample(0), true);
});

test('acceptSample: 閾値超は false', () => {
  assert.equal(acceptSample(101), false);
  assert.equal(acceptSample(1000), false);
});

test('acceptSample: 不正値は false', () => {
  assert.equal(acceptSample(undefined), false);
  assert.equal(acceptSample(null), false);
  assert.equal(acceptSample(NaN), false);
  assert.equal(acceptSample(Infinity), false);
});

test('acceptSample: カスタム閾値', () => {
  assert.equal(acceptSample(150, 200), true);
  assert.equal(acceptSample(250, 200), false);
});

test('defaultExitIcId: GPS あれば最寄を選ぶ', () => {
  const exits = [
    { id: 'wangan_kanpachi', gps: { lat: 35.5876, lng: 139.7320 } },
    { id: 'kukou_chuou', gps: { lat: 35.5497, lng: 139.7842 } },
  ];
  assert.equal(defaultExitIcId({ lat: 35.59, lng: 139.73 }, exits), 'wangan_kanpachi');
  assert.equal(defaultExitIcId({ lat: 35.55, lng: 139.78 }, exits), 'kukou_chuou');
});

test('defaultExitIcId: GPS なしは fallback', () => {
  const exits = [{ id: 'kukou_chuou', gps: { lat: 35.5497, lng: 139.7842 } }];
  assert.equal(defaultExitIcId(null, exits), 'wangan_kanpachi');
});

test('defaultExitIcId: 候補空は fallback', () => {
  assert.equal(defaultExitIcId({ lat: 35, lng: 139 }, []), 'wangan_kanpachi');
});

test('createGeoWatcher: 良サンプルで update + state measuring', () => {
  const updates = [];
  const states = [];
  const fakeGeo = {
    watchPosition(success) {
      success({ coords: { latitude: 35.7, longitude: 139.7, accuracy: 20 }, timestamp: 1000 });
      success({ coords: { latitude: 35.71, longitude: 139.71, accuracy: 200 }, timestamp: 2000 });
      return 42;
    },
    clearWatch() {},
  };
  const w = createGeoWatcher({
    geolocation: fakeGeo,
    onUpdate: (p) => updates.push(p),
    onState: (s) => states.push(s),
  });
  w.start();
  assert.deepEqual(states, ['measuring']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].accuracy, 20);
  assert.equal(w.getLastPos().accuracy, 20);
});

test('createGeoWatcher: stop で clearWatch + idle', () => {
  let cleared = null;
  const fakeGeo = {
    watchPosition() { return 99; },
    clearWatch(id) { cleared = id; },
  };
  const w = createGeoWatcher({ geolocation: fakeGeo });
  w.start();
  w.stop();
  assert.equal(cleared, 99);
  assert.equal(w.getState(), 'idle');
  assert.equal(w.getLastPos(), null);
});

test('createGeoWatcher: code:1 エラーで denied', () => {
  const fakeGeo = {
    watchPosition(_s, error) { error({ code: 1, message: 'denied' }); return 1; },
    clearWatch() {},
  };
  const w = createGeoWatcher({ geolocation: fakeGeo });
  w.start();
  assert.equal(w.getState(), 'denied');
});

test('createGeoWatcher: 他のエラーは error 状態', () => {
  const fakeGeo = {
    watchPosition(_s, error) { error({ code: 2, message: 'unavailable' }); return 1; },
    clearWatch() {},
  };
  const w = createGeoWatcher({ geolocation: fakeGeo });
  w.start();
  assert.equal(w.getState(), 'error');
});

test('createGeoWatcher: geolocation なしは unsupported', () => {
  const w = createGeoWatcher({ geolocation: null });
  w.start();
  assert.equal(w.getState(), 'unsupported');
});

test('entryGivesCompanyPayDeduction: km>0 のエントリは true', () => {
  const ded = { directions: [
    { id: 'tomei', entries: [{ ic_id: 'yokohama_machida', km: 19.7 }] },
    { id: 'joban', entries: [{ ic_id: 'kashiwa', km: 6.1 }] },
  ]};
  assert.equal(entryGivesCompanyPayDeduction('yokohama_machida', ded), true);
  assert.equal(entryGivesCompanyPayDeduction('kashiwa', ded), true);
});

test('entryGivesCompanyPayDeduction: km=0 は false (8入口/baseline)', () => {
  const ded = { directions: [{ id: 'x', entries: [{ ic_id: 'baseline_ic', km: 0 }] }] };
  assert.equal(entryGivesCompanyPayDeduction('baseline_ic', ded), false);
});

test('entryGivesCompanyPayDeduction: deduction にない IC は false', () => {
  const ded = { directions: [{ id: 'tomei', entries: [{ ic_id: 'a', km: 1 }] }] };
  assert.equal(entryGivesCompanyPayDeduction('not_listed', ded), false);
});

test('entryGivesCompanyPayDeduction: 不正入力は false', () => {
  assert.equal(entryGivesCompanyPayDeduction(null, { directions: [] }), false);
  assert.equal(entryGivesCompanyPayDeduction('a', null), false);
  assert.equal(entryGivesCompanyPayDeduction('a', {}), false);
});

test('createGeoWatcher: start を二重に呼んでも safe', () => {
  let n = 0;
  const fakeGeo = {
    watchPosition() { n++; return n; },
    clearWatch() {},
  };
  const w = createGeoWatcher({ geolocation: fakeGeo });
  w.start();
  w.start();
  assert.equal(n, 1);
});
