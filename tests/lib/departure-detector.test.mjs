import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectDepartures } from '../../scripts/lib/departure-detector.mjs';

test('detectDepartures: 前tickでfront_rowにいた車両が今tickで消えた → 出庫', () => {
  const prev = [
    { id: 100, bbox: [120, 480, 50, 50], lane: '第一-一般', front_row: true },
    { id: 101, bbox: [240, 350, 50, 50], lane: '第二-一般', front_row: false }
  ];
  const current = [
    { id: 101, bbox: [240, 350, 50, 50], lane: '第二-一般', front_row: false }
  ];
  const lost = [{ id: 100 }];
  const ts = '2026-05-12T15:30:00+09:00';
  const events = detectDepartures(prev, current, lost, ts);
  assert.equal(events.length, 1);
  assert.equal(events[0].lane, '第一-一般');
  assert.equal(events[0].vehicle_id, 100);
  assert.equal(events[0].ts, ts);
});

test('detectDepartures: front_row以外で消えた車両は出庫扱いしない', () => {
  const prev = [
    { id: 100, bbox: [240, 350, 50, 50], lane: '第二-一般', front_row: false }
  ];
  const current = [];
  const lost = [{ id: 100 }];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0);
});

test('detectDepartures: front_rowから後ろに動いた車両は出庫扱いしない（同laneに残る）', () => {
  const prev = [{ id: 100, bbox: [120, 480, 50, 50], lane: '第一-一般', front_row: true }];
  const current = [{ id: 100, bbox: [120, 400, 50, 50], lane: '第一-一般', front_row: false }];
  const lost = [];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0); // 後退は通常起きないがガード
});

test('detectDepartures: 複数同時出庫', () => {
  const prev = [
    { id: 100, bbox: [120, 480, 50, 50], lane: '第一-一般', front_row: true },
    { id: 200, bbox: [420, 480, 50, 50], lane: '第三-一般', front_row: true }
  ];
  const current = [];
  const lost = [{ id: 100 }, { id: 200 }];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 2);
});

test('detectDepartures: lane=null の車両は無視', () => {
  const prev = [{ id: 100, bbox: [700, 100, 50, 50], lane: null, front_row: false }];
  const current = [];
  const lost = [{ id: 100 }];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0);
});
